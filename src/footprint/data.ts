// The footprint's data (src/footprint/types.ts): aggregates over the whole index, read-only and index-only like the
// incident pack, so archived sessions count (ADR 0008). Columns are named, never `*`; counting is SQL GROUP BY, so no
// event list is loaded into JS. Every list is sorted and capped, and every string is masked again on the way out (0007).
import type { Rule } from "../engine/load.ts";
import { mask } from "../normalize/mask.ts";
import { LEVELS, type Level } from "../normalize/types.ts";
import { GENESIS } from "../store/chain.ts";
import type { Db, SqlValue } from "../store/sqlite.ts";
import { TOOL_VERSION } from "../version.ts";
import type {
  AgentNode, ConfigFootprint, ConfigItem, ConfigRead, FindingRow, Footprint, ProjectNode, SecretReach, Seen, SessionNode, SubAgentNode,
} from "./types.ts";

const SESSION_CAP = 200; // sessions listed in the agent tree, across all projects
const FINDING_CAP = 500; // finding rows
const DOMAIN_CAP = 100; // domains
const SECRET_CAP = 200; // secret fingerprints
const TOOL_CAP = 100; // rows in each of the three tool lists

const IN = "IN (SELECT value FROM json_each(?))";
const BLOCKED = "SUM(outcome IS 'blocked')"; // IS, not =: never NULL when every outcome is
const SEEN = `COUNT(*) AS events, COUNT(DISTINCT session_id) AS sessions, ${BLOCKED} AS blocked,
  COUNT(agent_id) AS sub_agent, MIN(ts) AS first_ts, MAX(ts) AS last_ts`;

type SessionRow = SessionNode & { agent: string; project: string };
const rank = (l?: string) => LEVELS.indexOf(l as Level); // -1 without findings
const asc = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Sessions by risk: worst level, then most findings, then most recent. */
type Risk = Pick<SessionNode, "session_id" | "last_ts" | "findings" | "worst">;
export const riskOrder = (a: Risk, b: Risk) =>
  rank(b.worst) - rank(a.worst) || b.findings - a.findings || asc(b.last_ts, a.last_ts) || asc(a.session_id, b.session_id);

/** The first `cap` rows in `order`, and how many were left out. */
export function top<T>(rows: T[], cap: number, order?: (a: T, b: T) => number): [T[], number] {
  const sorted = order ? [...rows].sort(order) : rows;
  return [sorted.slice(0, cap), Math.max(0, rows.length - cap)];
}

const CONFIG_CAP = 500; // distinct configured items listed (agent + kind + name)
// What each collector records in use (docs/logsource.md): Claude Code all four kinds, Codex its MCP calls only
const OBSERVABLE = new Set(["claude_code", "codex:mcp_server"]);
const UNLISTED_CAP = 100; // used-but-not-configured rows listed

type Used = { agent: string; kind: ConfigItem["kind"]; name: string; events: number; sessions: number; last_ts: string };
const key = (x: { agent: string; kind: string; name: string }) => `${x.agent}\0${x.kind}\0${x.name}`;

/** Each configured item with how often transcripts show it in use, and what was used that no config file read now
 * sets up. Skills and plugins count the tool calls attributed to them (`attribution`), not the Skill call itself; a
 * plugin also counts the calls of its own skills (`skill:<plugin>:<name>`), since the transcript names the skill first.
 * ponytail: a plugin's MCP servers (`plugin_<p>_<server>`) are not counted toward it: the split is ambiguous when names
 * hold `_`. Count them if plugins turn out to be used through MCP only. */
export function compareConfig(db: Db, reads: ConfigRead[]): [ConfigFootprint, number] {
  const used = db.prepare(`SELECT agent, kind, name, COUNT(*) AS events, COUNT(DISTINCT session_id) AS sessions, MAX(ts) AS last_ts FROM (
      SELECT agent, 'mcp_server' AS kind, mcp_server AS name, session_id, ts FROM events WHERE mcp_server IS NOT NULL
      UNION ALL SELECT agent, 'hook', COALESCE(command_line, tool_name), session_id, ts FROM events WHERE tool_name LIKE 'hook:%'
      UNION ALL SELECT agent, 'skill', substr(attribution, 7), session_id, ts FROM events WHERE attribution LIKE 'skill:%'
      UNION ALL SELECT agent, 'plugin', CASE WHEN attribution LIKE 'plugin:%' THEN substr(attribution, 8)
        ELSE substr(attribution, 7, instr(substr(attribution, 7), ':') - 1) END, session_id, ts
        FROM events WHERE attribution LIKE 'plugin:%' OR attribution LIKE 'skill:%:%'
    ) GROUP BY agent, kind, name`).all() as unknown as Used[];
  const byKey = new Map(used.map((u) => [key(u), u]));
  const items = reads.flatMap((r) => r.items);
  const configured = new Set(items.map(key));
  const order = (a: { agent: string; kind: string; name: string; events: number }, b: typeof a) =>
    asc(a.agent, b.agent) || asc(a.kind, b.kind) || b.events - a.events || asc(a.name, b.name);
  const merged = new Map<string, { i: ConfigItem; scopes: Set<string>; files: Set<string>; details: Set<string> }>();
  for (const i of items) {
    const m = merged.get(key(i)) ?? { i, scopes: new Set(), files: new Set(), details: new Set() };
    m.scopes.add(i.scope);
    m.files.add(i.source);
    if (i.detail) m.details.add(i.detail);
    merged.set(key(i), m);
  }
  const [listed, cutItems] = top([...merged.values()].map(({ i, scopes, files, details }) => {
    const u = byKey.get(key(i));
    return {
      agent: i.agent, kind: i.kind, name: i.name, ...(details.size ? { detail: [...details].sort(asc).join(", ") } : {}),
      scopes: [...scopes].sort(asc), files: files.size, source: [...files].sort(asc)[0]!,
      events: u?.events ?? 0, sessions: u?.sessions ?? 0, ...(u ? { last_ts: u.last_ts } : {}), observable: OBSERVABLE.has(i.agent) || OBSERVABLE.has(`${i.agent}:${i.kind}`),
    };
  }), CONFIG_CAP, order);
  const [unlisted, cutUnlisted] = top(used.filter((u) => !configured.has(key(u))), UNLISTED_CAP, order);
  const files = reads.reduce((n, r) => n + r.files, 0);
  const skipped = reads.reduce((n, r) => n + r.skipped.length, 0);
  return [{ items: listed, unlisted, files, skipped }, cutItems + cutUnlisted];
}

export function collectFootprint(db: Db, opts: { rules: Rule[]; retentionDays?: number; now?: Date; config?: ConfigRead[] }): Footprint {
  const all = <T>(sql: string, ...p: SqlValue[]) => db.prepare(sql).all(...p) as unknown as T[];
  const one = <T>(sql: string) => all<T>(sql)[0]!;

  // Sessions with their counts; archived = every source file is gone, as the store computes it.
  const blockedBy = new Map(all<{ s: string; n: number }>(`SELECT session_id AS s, COUNT(*) AS n FROM events
    WHERE outcome = 'blocked' GROUP BY session_id`).map((r) => [r.s, r.n]));
  const levelsBy = new Map<string, { n: number; worst?: Level }>();
  for (const r of all<{ s: string; level: Level; n: number }>("SELECT session_id AS s, level, COUNT(*) AS n FROM findings GROUP BY s, level")) {
    const f = levelsBy.get(r.s) ?? { n: 0 };
    f.n += r.n;
    if (rank(r.level) > rank(f.worst)) f.worst = r.level;
    levelsBy.set(r.s, f);
  }
  const sessions = all<SessionRow>(`SELECT session_id, agent, COALESCE(project_path, '-') AS project, first_ts, last_ts,
      event_count AS events, NOT EXISTS (
        SELECT 1 FROM events e JOIN files_indexed f ON f.path = e.source_file WHERE e.session_id = s.session_id AND f.gone_at IS NULL
      ) AS archived FROM sessions s`).map((r): SessionRow => ({
    ...r, archived: Boolean(r.archived), blocked: blockedBy.get(r.session_id) ?? 0,
    findings: levelsBy.get(r.session_id)?.n ?? 0, worst: levelsBy.get(r.session_id)?.worst, sub_agents: [],
  }));

  // The tree: every agent and project with full counts, holding only the SESSION_CAP riskiest sessions.
  const projects = new Map<string, ProjectNode & { agent: string }>();
  for (const s of sessions) {
    const key = `${s.agent}\0${s.project}`;
    const p = projects.get(key) ?? { agent: s.agent, project: s.project, sessions: 0, events: 0, blocked: 0, findings: 0, list: [] };
    p.sessions++;
    p.events += s.events;
    p.blocked += s.blocked;
    p.findings += s.findings;
    if (rank(s.worst) > rank(p.worst)) p.worst = s.worst;
    projects.set(key, p);
  }
  const [kept, omittedSessions] = top(sessions, SESSION_CAP, riskOrder);
  const subs = new Map<string, SubAgentNode[]>();
  for (const r of all<SubAgentNode & { s: string }>(`SELECT session_id AS s, agent_id, COUNT(*) AS events, ${BLOCKED} AS blocked
    FROM events WHERE agent_id IS NOT NULL AND session_id ${IN} GROUP BY s, agent_id ORDER BY events DESC, agent_id`,
  JSON.stringify(kept.map((s) => s.session_id)))) {
    subs.set(r.s, [...(subs.get(r.s) ?? []), { agent_id: r.agent_id, events: r.events, blocked: r.blocked }]);
  }
  for (const { agent, project, ...s } of kept) {
    projects.get(`${agent}\0${project}`)!.list.push({ ...s, sub_agents: subs.get(s.session_id) ?? [] });
  }
  const agents = new Map<string, AgentNode>();
  for (const { agent, ...p } of projects.values()) {
    const a = agents.get(agent) ?? { agent, sessions: 0, events: 0, projects: [] };
    a.sessions += p.sessions;
    a.events += p.events;
    a.projects.push(p);
    agents.set(agent, a);
  }
  for (const a of agents.values()) a.projects.sort((x, y) => y.events - x.events || asc(x.project, y.project));

  // Secrets by fingerprint: only the events that carry one are read.
  const reach = new Map<string, { kinds: Set<string>; sessions: Set<string>; agents: Set<string>; first: string; last: string }>();
  for (const e of all<{ s: string; agent_id: string | null; ts: string; fps: string; kinds: string | null }>(
    "SELECT session_id AS s, agent_id, ts, secret_fps AS fps, secret_kinds AS kinds FROM events WHERE secret_fps IS NOT NULL",
  )) {
    for (const fp of JSON.parse(e.fps) as string[]) {
      const r = reach.get(fp) ?? { kinds: new Set(), sessions: new Set(), agents: new Set(), first: e.ts, last: e.ts };
      for (const k of e.kinds ? (JSON.parse(e.kinds) as string[]) : []) r.kinds.add(k);
      r.sessions.add(e.s);
      if (e.agent_id) r.agents.add(e.agent_id);
      if (e.ts < r.first) r.first = e.ts;
      if (e.ts > r.last) r.last = e.ts;
      reach.set(fp, r);
    }
  }
  const project = new Map(sessions.map((s) => [s.session_id, s.project]));
  const domainsIn = new Map<string, string[]>();
  for (const r of all<{ s: string; domain: string }>(`SELECT DISTINCT session_id AS s, domain FROM events
    WHERE domain IS NOT NULL AND session_id ${IN}`, JSON.stringify([...new Set([...reach.values()].flatMap((r) => [...r.sessions]))]))) {
    domainsIn.set(r.s, [...(domainsIn.get(r.s) ?? []), r.domain]);
  }
  const each = (ids: Set<string>, f: (s: string) => string[]) => [...new Set([...ids].flatMap(f))].sort(asc);
  const [secrets, omittedSecrets] = top([...reach].map(([fingerprint, r]): SecretReach => ({
    fingerprint, kinds: [...r.kinds].sort(asc), sessions: r.sessions.size, sub_agents: r.agents.size,
    projects: each(r.sessions, (s) => [project.get(s) ?? "-"]), domains: each(r.sessions, (s) => domainsIn.get(s) ?? []),
    first_ts: r.first, last_ts: r.last,
  })), SECRET_CAP, (a, b) => b.sessions - a.sessions || asc(a.fingerprint, b.fingerprint));

  // Findings, highest level first, then newest. agent_id is the primary event's (events[0]).
  const loaded = new Map(opts.rules.map((r) => [r.id, r.name ?? r.title]));
  const [findings, omittedFindings] = top(all<FindingRow & { id: string }>(`SELECT f.id, f.level, f.rule_id AS rule, f.ts,
      f.session_id, COALESCE(s.project_path, '-') AS project, json_extract(f.events, '$[0].agent_id') AS agent_id, f.message
    FROM findings f LEFT JOIN sessions s ON s.session_id = f.session_id`), FINDING_CAP,
  (a, b) => rank(b.level) - rank(a.level) || asc(b.ts, a.ts) || asc(a.id, b.id));
  const byLevel = Object.fromEntries(LEVELS.map((l) => [l, 0])) as Record<Level, number>;
  for (const r of all<{ level: Level; n: number }>("SELECT level, COUNT(*) AS n FROM findings GROUP BY level")) byLevel[r.level] = r.n;

  // Tools and domains, most events first.
  const seen = (name: string, where: string, detail = "") =>
    all<Seen>(`SELECT ${name} AS name${detail && `, ${detail} AS detail`}, ${SEEN} FROM events WHERE ${where}
      GROUP BY name${detail && ", detail"} ORDER BY events DESC, name${detail && ", detail"}`);
  const [mcp, cutMcp] = top(seen("mcp_server", "mcp_server IS NOT NULL"), TOOL_CAP);
  const [hooks, cutHooks] = top(seen("COALESCE(command_line, tool_name)", "tool_name LIKE 'hook:%'", "tool_name"), TOOL_CAP);
  const [attributions, cutAttr] = top(seen("attribution", "attribution IS NOT NULL"), TOOL_CAP);
  const [configured, cutConfig] = opts.config ? compareConfig(db, opts.config) : [undefined, 0];
  const [domains, omittedDomains] = top(seen("domain", "domain IS NOT NULL"), DOMAIN_CAP);

  const findingsByDay = new Map(all<{ day: string; n: number }>("SELECT substr(ts, 1, 10) AS day, COUNT(*) AS n FROM findings GROUP BY day")
    .map((r) => [r.day, r.n]));
  const activity = all<{ day: string; events: number; blocked: number }>(`SELECT substr(ts, 1, 10) AS day, COUNT(*) AS events,
    ${BLOCKED} AS blocked FROM events GROUP BY day ORDER BY day DESC LIMIT 365`).reverse()
    .map((r) => ({ ...r, findings: findingsByDay.get(r.day) ?? 0 }));

  const totals = one<{ events: number; sub: number; blocked: number; first_ts: string | null; last_ts: string | null }>(
    `SELECT COUNT(*) AS events, COUNT(agent_id) AS sub, ${BLOCKED} AS blocked, MIN(ts) AS first_ts, MAX(ts) AS last_ts FROM events`);
  const files = one<{ indexed: number; gone: number }>("SELECT COUNT(*) AS indexed, COUNT(gone_at) AS gone FROM files_indexed");
  // null on an index from before the chain, opened read-only so never upgraded (as the incident pack does)
  const chained = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chain'").get();
  const chain = chained ? one<{ entries: number; head: string | null }>(`SELECT COUNT(*) AS entries,
    (SELECT hash FROM chain ORDER BY seq DESC LIMIT 1) AS head FROM chain`) : null;
  const count = (sql: string) => all<{ name: string; count: number }>(sql);

  const out: Footprint = {
    generated_at: (opts.now ?? new Date()).toISOString(),
    tool_version: TOOL_VERSION,
    trust: {
      chain: chain && { entries: chain.entries, head: chain.head ?? GENESIS },
      files,
      archived_sessions: sessions.filter((s) => s.archived).length,
      retention_days: opts.retentionDays,
      first_ts: totals.first_ts ?? undefined,
      last_ts: totals.last_ts ?? undefined,
    },
    totals: {
      agents: agents.size,
      projects: new Set(sessions.map((s) => s.project)).size,
      sessions: sessions.length,
      events: totals.events,
      sub_agent_events: totals.sub,
      blocked: totals.blocked ?? 0,
      secrets: reach.size,
      findings: byLevel,
    },
    activity,
    agents: [...agents.values()].sort((a, b) => b.events - a.events || asc(a.agent, b.agent)),
    tools: { mcp_servers: mcp, hooks, attributions },
    domains,
    secrets,
    modes: all(`SELECT COALESCE(permission_mode, '-') AS mode, COUNT(*) AS events, COUNT(DISTINCT session_id) AS sessions,
      COUNT(agent_id) AS sub_agent FROM events GROUP BY mode ORDER BY events DESC, mode`),
    blocked: {
      kinds: count(`SELECT COALESCE(denial_kind, 'unspecified') AS name, COUNT(*) AS count FROM events WHERE outcome = 'blocked'
        GROUP BY name ORDER BY count DESC, name`),
      categories: count(`SELECT denial_category AS name, COUNT(*) AS count FROM events WHERE outcome = 'blocked'
        AND denial_category IS NOT NULL GROUP BY name ORDER BY count DESC, name`),
    },
    findings: findings.map(({ id, ...f }) => ({ ...f, rule: loaded.get(f.rule) ?? f.rule })),
    ...(configured ? { configured } : {}),
    omitted: {
      sessions: omittedSessions, findings: omittedFindings, domains: omittedDomains, secrets: omittedSecrets,
      tools: cutMcp + cutHooks + cutAttr + cutConfig, // configured-versus-used rows count as tools
    },
  };
  // Plain objects out (Node rows have a null prototype), SQL NULLs dropped as absent optionals (chain keeps its null),
  // and every string masked again.
  return JSON.parse(JSON.stringify(out, (k, v: unknown) => (v === null && k !== "chain" ? undefined : typeof v === "string" ? mask(v) : v)));
}

// The scan pipeline (ADR 0006, 0008): discover -> parse -> index -> evaluate -> findings. It evaluates per
// session, never per file: a session is its main transcript plus its sub-agent files (and set-aside copies), and
// event_count correlations must see all of them at once (ADR 0004). Zero network, nothing raw is persisted.
import { createHash } from "node:crypto";
import { COLLECTORS, type Collector } from "./collectors/index.ts";
import { evaluate, type Match } from "./engine/evaluate.ts";
import { coldStartCutoff, FIRST_SEEN_FIELDS, firstSeenOf, setFirstSeen, type FirstSeen } from "./engine/first-seen.ts";
import { snapshotConfig } from "./footprint/snapshot.ts";
import { type Rejection, type Rule } from "./engine/load.ts";
import { loadSources, ruleSources } from "./cli/rules.ts";
import { mask } from "./normalize/mask.ts";
import { toStored } from "./normalize/stored.ts";
import { LEVELS, type Finding, type Level, type ParsedFile, type RawEvent } from "./normalize/types.ts";
import type { BlockedBreakdown, ReportRule, ScanReport } from "./outputs/report.ts";
import { findingId, openReadOnly, openStore, type Store } from "./store/index.ts";
import { indexFiles } from "./store/indexer.ts";
import { applyIgnore, loadIgnore, type Ignore } from "./suppress.ts";

/** Claude Code parser version; each collector carries its own (src/collectors/index.ts). Bump it there. */
export const PARSER_VERSION = COLLECTORS.claude_code!.parserVersion;
import { DEFAULT_RULES_DIR, TOOL_VERSION } from "./version.ts";
export { DEFAULT_RULES_DIR, TOOL_VERSION } from "./version.ts";

export type ScanOptions = {
  agent?: string; // a key of COLLECTORS, or "all" (every collector, each at its default root); default claude_code
  root?: string; // the agent's data dir (Claude: config dir or its projects dir); default per collector; not with "all"
  dbPath?: string;
  rulesDir?: string;
  extraRules?: string[]; // loaded on top of rulesDir; a missing dir or a reused id/name is a UsageError
  since?: string; // ISO date or time: sessions that ended before it are left out
  project?: string; // substring of the session's project path
  level?: Level; // findings below it are left out
  ignore?: string; // --ignore file; else ~/.retrohound/ignore.yml (suppress.ts: a repo's own file is never implicit)
  noIndex?: boolean; // parse and evaluate everything, write nothing
  onRejected?: (rejected: Rejection[]) => void; // called once with the rules the loader refused, so callers need not load them again
};

type Sess = { id: string; agent: string; project_path?: string; last_ts: string; events: number; archived: boolean };
type Job = { c: Collector; paths: string[] };
const BLOCKED_FIELDS = ["session_id", "agent_id", "attribution", "denial_kind", "denial_category"] as const;
type BlockedRow = Partial<Record<(typeof BLOCKED_FIELDS)[number] | "project_path", string | null>>; // DB rows carry null
type View = {
  sessions: Sess[];
  findings: Finding[];
  stats: (ids: string[]) => { blocked: number; subagent: number };
  blocked: () => BlockedRow[]; // every blocked event; buildReport keeps the kept sessions'
  files: ScanReport["scan"]["files"];
  lines: Lines;
};

type Lines = NonNullable<ScanReport["scan"]["lines"]>;
const noLines = (): Lines => ({ malformed: 0, unknown_types: {} });
function tally(acc: Lines, stats: ParsedFile["stats"]): void {
  acc.malformed += stats.malformed;
  for (const [type, k] of Object.entries(stats.unknown_types)) acc.unknown_types[type] = (acc.unknown_types[type] ?? 0) + k;
}

function groupPaths(c: Collector, paths: string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const p of paths) groups.set(c.groupKey(p), [...(groups.get(c.groupKey(p)) ?? []), p]);
  return groups;
}

function loadRuleSet(dir: string, extras: string[] = []): { rules: Rule[]; hash: string; rejected: Rejection[] } {
  const sources = ruleSources(dir, extras);
  const hash = createHash("sha256").update(sources.map((s) => `${s.name}\0${s.text}\0`).join("")).digest("hex");
  return { ...loadSources(sources), hash };
}

function toFinding(m: Match<RawEvent>): Finding {
  const events = m.events.map(toStored);
  return {
    id: findingId(m.rule.id, events.map((e) => e.id)),
    rule_id: mask(m.rule.id),
    level: m.rule.level,
    ts: events[0]!.ts,
    session_id: events[0]!.session_id,
    message: mask(m.rule.title.replace(/\s+/g, " ").trim()),
    events,
  };
}

type Sessions = Map<string, Map<string, RawEvent>>;

/** Parses every file of the given groups into sessions, copies deduped by id. */
async function collect(groups: string[][], parse: (p: string) => Promise<RawEvent[] | null>): Promise<Sessions> {
  const bySession: Sessions = new Map();
  for (const paths of groups) {
    for (const path of paths) {
      for (const e of (await parse(path)) ?? []) {
        const events = bySession.get(e.session_id) ?? new Map<string, RawEvent>();
        if (!events.has(e.id)) events.set(e.id, e); // paths sort the original before its copies
        bySession.set(e.session_id, events);
      }
    }
  }
  return bySession;
}

/** Runs `fn` with the first-seen pre-pass in place when a rule reads it (ADR 0016), and clears it after. */
function withFirstSeen<T>(rules: Rule[], prepass: () => FirstSeen, fn: () => T): T {
  const needed = rules.some((r) => r.kind === "detection" && FIRST_SEEN_FIELDS.some((f) => r.fields.includes(f)));
  setFirstSeen(needed ? prepass() : undefined);
  try {
    return fn();
  } finally {
    setFirstSeen();
  }
}

const safeParse = (c: Collector, cache?: Map<string, RawEvent[]>, lines?: Lines) => async (path: string): Promise<RawEvent[] | null> => {
  try {
    const cached = cache?.get(path);
    if (cached) return cached;
    const { events, stats } = await c.parseFile(path);
    if (lines) tally(lines, stats);
    return events;
  } catch {
    return null; // an unreadable file is the indexer's `failed`; the rest of its session still evaluates
  }
};

function summarize(events: RawEvent[]): Sess {
  const first = events.find((e) => e.project_path);
  return {
    id: events[0]!.session_id,
    agent: events[0]!.agent,
    project_path: first?.project_path,
    last_ts: events.reduce((m, e) => (e.ts > m ? e.ts : m), ""),
    events: events.length,
    archived: false,
  };
}

async function scanMemory(jobs: Job[], rules: Rule[]): Promise<View> {
  let failed = 0;
  const lines = noLines();
  const all = new Map<string, RawEvent[]>();
  for (const { c, paths } of jobs) {
    const parse = safeParse(c, undefined, lines);
    const counted = async (p: string) => (await parse(p)) ?? (failed++, null);
    for (const [id, events] of await collect([...groupPaths(c, paths).values()], counted)) all.set(id, [...events.values()]);
  }
  // Every agent is parsed before any evaluates: first-seen compares across all of them.
  const findings = withFirstSeen(rules, () => firstSeenOf([...all.values()].flat()), () =>
    [...all.values()].flatMap((events) => evaluate(rules, events).map(toFinding)));
  const stats = (ids: string[]) => {
    const events = ids.flatMap((id) => all.get(id) ?? []);
    return { blocked: events.filter((e) => e.outcome === "blocked").length, subagent: events.filter((e) => e.agent_id).length };
  };
  const total = jobs.reduce((n, j) => n + j.paths.length, 0);
  const blocked = () => [...all.values()].flat().filter((e) => e.outcome === "blocked");
  return { sessions: [...all.values()].map(summarize), findings, stats, blocked, files: { indexed: total - failed, skipped: 0, gone: 0, failed }, lines };
}

/** Blocked rows from the index. The store has no query for them (it is not ours to change): a read-only handle on the
 * same file, as `query` uses; blocked events are few. */
function indexedBlocked(dbPath?: string): BlockedRow[] {
  const db = openReadOnly(dbPath);
  try {
    return db.prepare(`SELECT ${BLOCKED_FIELDS.join(", ")} FROM events WHERE outcome = 'blocked'`).all() as BlockedRow[];
  } finally {
    db.close();
  }
}

async function scanIndexed(jobs: Job[], store: Store, rules: Rule[], hash: string, dbPath?: string): Promise<View> {
  const started = new Date().toISOString();
  // Once, before any agent runs: each agent's untouched files need the same answer (the run is recorded at the end).
  const full = store.lastRuleRun()?.rule_set_hash !== hash;
  const lines = noLines(); // only files the indexer parses this run; re-reads for evaluation are not counted twice
  const files = { indexed: 0, skipped: 0, gone: 0, failed: 0 };
  const dirty: { c: Collector; sessions: Sessions }[] = [];
  for (const { c, paths } of jobs) {
    const { index, sessions } = await indexAgent(c, store, paths, full, lines);
    dirty.push({ c, sessions });
    files.indexed += index.indexed;
    files.skipped += index.skipped;
    files.gone += index.gone;
    files.failed += index.failed.length;
  }
  // Every agent is indexed before any evaluates, so the first-seen query sees all of this scan's events (ADR 0016).
  withFirstSeen(rules, () => store.firstSeen(coldStartCutoff(store.listSessions().map((s) => s.first_ts))), () => {
    for (const { c, sessions } of dirty) evaluateAgent(c, store, rules, sessions, full);
  });
  const events = store.listSessions().reduce((n, s) => n + s.event_count, 0);
  store.recordRuleRun({ rule_set_hash: hash, started_at: started, finished_at: new Date().toISOString(), events, findings: store.listFindings().length });
  snapshotConfig(store); // what the agents' config files set up now, for the footprint's "changed since last scan"
  const agents = new Set(jobs.map((j) => j.c.agent as string)); // one DB holds every agent
  return {
    sessions: store.listSessions().filter((s) => agents.has(s.agent))
      .map((s) => ({ id: s.session_id, agent: s.agent, project_path: s.project_path ?? undefined, last_ts: s.last_ts, events: s.event_count, archived: s.archived })),
    findings: store.listFindings(),
    stats: (ids) => store.eventStats(ids),
    blocked: () => indexedBlocked(dbPath),
    files,
    lines,
  };
}

/** Indexes one agent's files and parses the sessions to re-evaluate: those with a touched file, or all on `full`. */
async function indexAgent(c: Collector, store: Store, paths: string[], full: boolean, lines: Lines) {
  const touched = new Set<string>();
  const cache = new Map<string, RawEvent[]>();
  const parse = async (path: string) => {
    touched.add(path); // before parsing: a file that fails keeps its session dirty until it parses
    const parsed = await c.parseFile(path);
    tally(lines, parsed.stats);
    cache.set(path, parsed.events);
    return parsed;
  };
  const index = await indexFiles(store, paths, parse, c.parserVersion);
  const dirty = [...groupPaths(c, paths).values()].filter((g) => full || g.some((p) => touched.has(p)));
  const sessions = await collect(dirty, safeParse(c, cache));
  cache.clear();
  return { index, sessions };
}

function evaluateAgent(c: Collector, store: Store, rules: Rule[], sessions: Sessions, full: boolean): void {
  const findings = [...sessions.values()].flatMap((events) => evaluate(rules, [...events.values()]).map(toFinding));
  store.replaceFindings([...sessions.keys()], findings);
  if (full) {
    // Sessions whose transcripts are gone can only be re-read from masked rows (0006, 0008): keep their old evidence.
    for (const s of store.listSessions().filter((s) => s.agent === c.agent && s.archived)) {
      store.insertFindings(evaluate(rules, store.sessionEvents(s.session_id)).map((m) => toFinding(m as Match<RawEvent>)));
    }
  }
}

export const reportRule = (r: Rule): ReportRule => ({
  id: r.id, name: r.name, title: r.title, author: r.author, description: r.description, level: r.level, tags: r.tags, lane: r.lane,
  falsepositives: r.falsepositives.length ? r.falsepositives : undefined,
});

export async function runScan(opts: ScanOptions = {}): Promise<ScanReport> {
  const started_at = new Date().toISOString();
  const all = opts.agent === "all";
  const one = COLLECTORS[opts.agent ?? "claude_code"];
  if (!all && !one) throw new Error(`unknown agent '${opts.agent}'`);
  if (all && opts.root) throw new Error("--root cannot be used with --agent all: each agent is read from its own default root");
  const collectors = all ? Object.values(COLLECTORS) : [one!];
  const roots = collectors.map((c) => opts.root ?? c.defaultRoot());
  const { rules, hash, rejected } = loadRuleSet(opts.rulesDir ?? DEFAULT_RULES_DIR, opts.extraRules);
  opts.onRejected?.(rejected);
  const ignore = loadIgnore(rules, { file: opts.ignore }); // before any work: a bad file is a usage error
  const jobs = collectors.map((c, i) => ({ c, paths: c.discover(roots[i]!) }));
  const root = roots.join(", ");
  const agents = all ? collectors.map((c) => c.agent as string) : undefined;
  if (opts.noIndex) return buildReport(opts, await scanMemory(jobs, rules), rules, root, started_at, ignore, agents);
  const store = openStore(opts.dbPath);
  try {
    return buildReport(opts, await scanIndexed(jobs, store, rules, hash, opts.dbPath), rules, root, started_at, ignore, agents); // view.stats needs the store open
  } finally {
    store.close(); // Windows keeps the file locked otherwise
  }
}

/** Per-agent counts after the filters, so a multi-agent report says where findings came from. */
function perAgent(agents: string[], kept: Sess[], findings: Finding[]): NonNullable<ScanReport["scan"]["agents"]> {
  return Object.fromEntries(agents.map((a) => {
    const mine = kept.filter((s) => s.agent === a);
    const ids = new Set(mine.map((s) => s.id));
    return [a, { sessions: mine.length, events: mine.reduce((n, s) => n + s.events, 0), findings: findings.filter((f) => ids.has(f.session_id)).length }];
  }));
}

const byCount = (a: [string, number], b: [string, number]) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

/** Blocked events by the agent's own decision: kind (main vs sub-agent), category, attribution, top projects. */
function blockedBreakdown(rows: BlockedRow[]): BlockedBreakdown | undefined {
  if (!rows.length) return undefined;
  const kind = (r: BlockedRow) => r.denial_kind ?? "unspecified";
  const tally = (key: (r: BlockedRow) => string | null | undefined) => {
    const counts = new Map<string, number>();
    for (const r of rows) {
      const k = key(r);
      if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return [...counts].sort(byCount);
  };
  const kinds = tally(kind).map(([k, n]) => {
    const sub = rows.filter((r) => kind(r) === k && r.agent_id).length;
    return [k, { main: n - sub, sub_agent: sub }] as const;
  });
  const categories = tally((r) => r.denial_category);
  const attributions = tally((r) => r.attribution);
  return {
    kinds: Object.fromEntries(kinds),
    ...(categories.length ? { categories: Object.fromEntries(categories) } : {}),
    ...(attributions.length ? { attributions: Object.fromEntries(attributions) } : {}),
    top_projects: tally((r) => r.project_path ?? "-").slice(0, 5).map(([project_path, blocked]) => ({ project_path, blocked })),
  };
}

function buildReport(opts: ScanOptions, view: View, rules: Rule[], root: string, started_at: string, ignore: Ignore, agents?: string[]): ScanReport {
  const project = opts.project?.toLowerCase();
  const kept = view.sessions.filter(
    (s) => (!opts.since || s.last_ts >= opts.since) && (!project || (s.project_path ?? "").toLowerCase().includes(project)),
  );
  const ids = new Set(kept.map((s) => s.id));
  const min = opts.level ? LEVELS.indexOf(opts.level) : 0;
  const { kept: findings, suppressed } = applyIgnore(view.findings.filter((f) => ids.has(f.session_id) && LEVELS.indexOf(f.level) >= min), ignore);
  const fired = new Set(findings.map((f) => f.rule_id));
  const { blocked, subagent } = view.stats([...ids]);
  const projectOf = new Map(kept.map((s) => [s.id, s.project_path])); // the session's project, not a sub-folder cwd
  const rows = blocked ? view.blocked().filter((r) => ids.has(r.session_id ?? "")) : [];
  const breakdown = blockedBreakdown(rows.map((r) => ({ ...r, project_path: projectOf.get(r.session_id ?? "") })));
  return {
    schema: "retrohound.scan/0.1",
    tool: { name: "retrohound", version: TOOL_VERSION },
    scan: {
      started_at,
      finished_at: new Date().toISOString(),
      sessions: kept.length,
      events: kept.reduce((n, s) => n + s.events, 0),
      blocked,
      ...(breakdown ? { blocked_breakdown: breakdown } : {}), // only when something was blocked: other JSON is unchanged
      subagent_events: subagent,
      files: view.files,
      lines: view.lines,
      archived_sessions: kept.filter((s) => s.archived).map((s) => mask(s.id)),
      root: mask(root),
      ...(suppressed ? { suppressed } : {}),
      ...(agents ? { agents: perAgent(agents, kept, findings) } : {}), // only with --agent all: single-agent JSON is unchanged
    },
    rules: rules.filter((r) => fired.has(mask(r.id))).map(reportRule),
    findings,
  };
}

// The incident pack's data (docs/incident.md): everything the index holds about one or more sessions, as one document.
// Read-only and index-only, so archived sessions work (ADR 0008). Columns are named, never `*`, and every list is
// sorted, so the same index gives the same bytes. Strings are masked again here (0007).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { anonymizer } from "../cli/wrapped.ts";
import type { Rule } from "../engine/load.ts";
import { mask } from "../normalize/mask.ts";
import type { Db, Row } from "../store/sqlite.ts";
import { TOOL_VERSION } from "../version.ts";

export type Selection = { kind: "session" | "finding"; id: string; sessions: string[] };
export type PackEvent = {
  id: string; session_id: string; ts: string; seq: number; agent_id?: string; parent_tool_use_id?: string;
  category: string; tool_name?: string; command_line?: string; target_path?: string; url?: string; outcome?: string;
  denial_kind?: string; denial_category?: string; attribution?: string; secret_kinds?: string[]; secret_fps?: string[];
  source_file: string;
};
type Session = { session_id: string; agent: string; project_path?: string; first_ts: string; last_ts: string; event_count: number; archived: boolean };
type PackFinding = { id: string; rule_id: string; rule_name?: string; level: string; ts: string; session_id: string; message: string; event_ids: string[] };
export type Pack = ReturnType<typeof buildPack>;

const IN = "IN (SELECT value FROM json_each(?))";
const PATHS = new Set(["project_path", "command_line", "target_path", "url", "source_file", "path"]); // what --anonymize rewrites
const LISTS = new Set(["secret_kinds", "secret_fps"]);
const OUTCOMES = ["success", "error", "blocked", "unknown"] as const;
const sha256 = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");

/** A row as a plain object: nulls dropped, JSON lists parsed, strings masked, path-like fields through `fix`. */
function clean<T>(row: Row, fix: (s: string) => string): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === null) continue;
    if (typeof v !== "string") out[k] = Number(v);
    else if (LISTS.has(k)) out[k] = (JSON.parse(v) as string[]).map(mask).sort();
    else out[k] = PATHS.has(k) ? fix(mask(v)) : mask(v);
  }
  return out as T;
}

const outcomes = (es: PackEvent[]) => Object.fromEntries(OUTCOMES.map((o) => [o, es.filter((e) => e.outcome === o).length])) as Record<(typeof OUTCOMES)[number], number>;
const tally = (es: PackEvent[]) => ({ events: es.length, first_ts: es[0]?.ts, last_ts: es.at(-1)?.ts, outcomes: outcomes(es) });

export function buildPack(db: Db, sel: Selection, rules: Rule[], anonymize: boolean) {
  const ids = JSON.stringify(sel.sessions);
  const files = db.prepare(`SELECT path, sha256, first_seen, last_seen, gone_at FROM files_indexed
    WHERE path IN (SELECT source_file FROM events WHERE session_id ${IN}) ORDER BY path`).all(ids);
  // archived: every source file of the session is gone, as the store computes it
  const sessionRows = db.prepare(`SELECT session_id, agent, project_path, first_ts, last_ts, event_count, NOT EXISTS (
      SELECT 1 FROM events e JOIN files_indexed f ON f.path = e.source_file WHERE e.session_id = s.session_id AND f.gone_at IS NULL
    ) AS archived FROM sessions s WHERE session_id ${IN} ORDER BY first_ts, session_id`).all(ids);
  const projects = sessionRows.flatMap((s) => (typeof s.project_path === "string" ? [s.project_path] : []));
  const fix = anonymize ? anonymizer(files.map((f) => ({ raw_ref: { file: String(f.path), line: 0 } })), projects) : (s: string) => s;

  const sessions = sessionRows.map((r) => ({ ...clean<Session>(r, fix), archived: Boolean(r.archived) }));
  const timeline = db.prepare(`SELECT id, session_id, ts, seq, agent_id, parent_tool_use_id, category, tool_name, command_line,
      target_path, url, outcome, denial_kind, denial_category, attribution, secret_kinds, secret_fps, source_file
    FROM events WHERE session_id ${IN} ORDER BY ts, seq, id`).all(ids).map((r) => clean<PackEvent>(r, fix));

  const loaded = new Map(rules.map((r) => [r.id, r]));
  const findings = db.prepare(`SELECT id, rule_id, level, ts, session_id, message, events FROM findings
    WHERE session_id ${IN} ORDER BY ts, id`).all(ids).map((r): PackFinding => {
    const f = clean<Omit<PackFinding, "event_ids">>({ ...r, events: null }, fix);
    const rule = loaded.get(f.rule_id);
    const event_ids = (JSON.parse(String(r.events)) as { id: string }[]).map((e) => mask(e.id)); // [0] = primary event
    return { ...f, rule_name: rule?.name ?? rule?.title, event_ids };
  });
  const rulesUsed = [...new Set(findings.map((f) => f.rule_id))].sort().map((id) => {
    const r = loaded.get(id);
    return r ? { id, name: r.name, title: r.title, level: r.level, file_sha256: sha256(readFileSync(r.path)) } : { id, loaded: false };
  });

  const secrets = new Map<string, { kinds: Set<string>; sessions: Set<string>; events: string[] }>();
  for (const e of timeline) for (const fp of e.secret_fps ?? []) {
    const s = secrets.get(fp) ?? { kinds: new Set(), sessions: new Set(), events: [] };
    e.secret_kinds?.forEach((k) => s.kinds.add(k));
    s.sessions.add(e.session_id);
    s.events.push(e.id);
    secrets.set(fp, s);
  }

  return {
    schema: "retrohound.incident/0.1",
    tool: { name: "retrohound", version: TOOL_VERSION },
    selected: { kind: sel.kind, id: sel.id },
    anonymized: anonymize,
    rule_set_hash: (db.prepare("SELECT rule_set_hash FROM rule_runs ORDER BY id DESC LIMIT 1").get()?.rule_set_hash as string | undefined) ?? null,
    rules: rulesUsed,
    sessions,
    counts: {
      events: timeline.length,
      sub_agent_events: timeline.filter((e) => e.agent_id).length,
      findings: findings.length,
      outcomes: outcomes(timeline),
    },
    rotate: [...secrets].sort(([a], [b]) => (a < b ? -1 : 1)).map(([fingerprint, s]) => ({
      fingerprint, kinds: [...s.kinds].sort(), sessions: s.sessions.size, event_ids: s.events,
    })),
    findings,
    sub_agents: sessions.map((s) => {
      const es = timeline.filter((e) => e.session_id === s.session_id);
      const agents = [...new Set(es.flatMap((e) => (e.agent_id ? [e.agent_id] : [])))].sort();
      return {
        session_id: s.session_id,
        main: tally(es.filter((e) => !e.agent_id)),
        sub_agents: agents.map((agent_id) => {
          const mine = es.filter((e) => e.agent_id === agent_id);
          return { agent_id, parent_tool_use_id: mine.find((e) => e.parent_tool_use_id)?.parent_tool_use_id, ...tally(mine) };
        }),
      };
    }),
    provenance: files.map((r) => {
      const f = clean<{ path: string; sha256: string; first_seen: string; last_seen: string; gone_at?: string }>(r, fix);
      return { path: f.path, sha256: f.sha256, first_seen: f.first_seen, last_seen: f.last_seen, gone_at: f.gone_at ?? null };
    }),
    timeline,
  };
}

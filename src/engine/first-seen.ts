// `first_seen_project` and `first_seen_global` (ADR 0016). The scan computes them in a pre-pass over every event it can
// see, the index or the in-memory events, before it evaluates; nothing is stored. Rules read the result through
// BOOLEANS in modifiers.ts. `rules test` runs it over each test file; without one (the live hook) both are false.
type Row = Record<string, unknown>;

/** Event ids that are the earliest (ts, id) carrier of a value: per (project_path, kind, value), and per (kind, value). */
export type FirstSeen = { project: Set<string>; global: Set<string> };

export const FIRST_SEEN_FIELDS = ["first_seen_project", "first_seen_global"];
export const COLD_START_MS = 14 * 86_400_000;

const none = (): FirstSeen => ({ project: new Set(), global: new Set() });
let current = none();

/** The scan's pre-pass result; no argument clears it, so nothing outlives a scan. */
export function setFirstSeen(fs: FirstSeen = none()): void {
  current = fs;
}

export const firstSeen = (scope: keyof FirstSeen, ev: Row): boolean => current[scope].has(ev.id as string);

/** True when the parseable timestamps span the cold-start window, earliest to latest. */
export function spansColdStart(tss: Iterable<string>): boolean {
  let min = Infinity;
  let max = -Infinity;
  for (const ts of tss) {
    const t = Date.parse(ts); // NaN fails both comparisons: a bad ts is skipped
    if (t < min) min = t;
    if (t > max) max = t;
  }
  return max - min >= COLD_START_MS;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** The (kind, value) pairs an event carries. The SQL in Store.firstSeen must use the same keys. */
function keys(ev: Row): string[] {
  const out: string[] = [];
  const domain = str(ev.domain);
  if (domain) out.push(`domain\0${domain.toLowerCase()}`);
  if (str(ev.mcp_server)) out.push(`mcp\0${ev.mcp_server}`);
  if (str(ev.tool_name).startsWith("hook:") && str(ev.command_line)) out.push(`hook\0${ev.command_line}`);
  const a = str(ev.attribution);
  if (a.startsWith("skill:") || a.startsWith("plugin:")) out.push(`skill\0${a}`);
  return out;
}

const before = (a: Row, b: Row): boolean => str(a.ts) < str(b.ts) || (a.ts === b.ts && str(a.id) < str(b.id));

/** The pre-pass over in-memory events (`--no-index`): all false until they span the cold-start window. */
export function firstSeenOf(events: Row[]): FirstSeen {
  if (!spansColdStart(events.map((e) => str(e.ts)))) return none();
  const project = new Map<string, Row>();
  const global = new Map<string, Row>();
  const keep = (m: Map<string, Row>, key: string, ev: Row) => {
    const old = m.get(key);
    if (!old || before(ev, old)) m.set(key, ev);
  };
  for (const ev of events) {
    for (const k of keys(ev)) {
      keep(global, k, ev);
      keep(project, `${str(ev.project_path)}\0${k}`, ev);
    }
  }
  const ids = (m: Map<string, Row>) => new Set([...m.values()].map((e) => e.id as string));
  return { project: ids(project), global: ids(global) };
}

// Sigma correlations per ADR 0004: event_count, temporal_ordered and temporal with a sliding window. `seq` only orders
// events within one transcript stream, so a group with agent_id is one stream; a session-scope group (no agent_id in
// group-by) spans streams and is ordered by ts instead: see parseGroupBy and rerank.
import type { Rule, RuleMeta } from "./load.ts";
import { isDerived, resolveField, RuleError, type Row } from "./modifiers.ts";

export type CorrelationRule = RuleMeta & {
  kind: "correlation";
  type: "event_count" | "temporal" | "temporal_ordered";
  refs: string[]; // as written in `rules:`
  rules: Rule[]; // refs, resolved; same order
  groupBy: string[];
  timespanMs: number;
  maxEventsBetween?: number;
  count?: (n: number) => boolean; // event_count's condition
  generate: boolean; // true = referenced rules also emit on their own
};

/** One firing of a rule, with `at` the event it completed on. A detection's firing shares this object across rules. */
export type Occurrence = { at: Row; events: Row[]; seq: number; t: number };

export function occurrence(ev: Row, events: Row[] = [ev]): Occurrence {
  return { at: ev, events, seq: Number(ev.seq), t: Date.parse(String(ev.ts)) };
}

/** Contract order: (session_id, agent_id, seq), with a null or missing agent_id first. */
export function compareEvents(a: Row, b: Row): number {
  const x = a.session_id as string;
  const y = b.session_id as string;
  if (x !== y) return x < y ? -1 : 1;
  const p = (a.agent_id ?? "") as string;
  const q = (b.agent_id ?? "") as string;
  if (p !== q) return p < q ? -1 : 1;
  return (a.seq as number) - (b.seq as number);
}

const UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const TYPES = new Set(["event_count", "temporal", "temporal_ordered"]);
const KEYS = new Set(["type", "rules", "group-by", "timespan", "condition", "generate"]);
const COUNT_TESTS: Record<string, (n: number, v: number) => boolean> = {
  gt: (n, v) => n > v,
  gte: (n, v) => n >= v,
  lt: (n, v) => n < v,
  lte: (n, v) => n <= v,
  eq: (n, v) => n === v,
  neq: (n, v) => n !== v,
};

const stringList = (x: unknown): string[] | null => {
  const list = typeof x === "string" ? [x] : x;
  return Array.isArray(list) && list.length > 0 && list.every((s) => typeof s === "string") ? list : null;
};

function parseCount(condition: unknown): (n: number) => boolean {
  const entries = typeof condition === "object" && condition !== null ? Object.entries(condition) : [];
  if (entries.length === 0) throw new RuleError("bad-correlation", "event_count needs a condition such as { gte: 5 }");
  const tests = entries.map(([op, v]) => {
    if (op === "field") throw new RuleError("unsupported-correlation-type", "condition.field belongs to value_count");
    const test = Object.hasOwn(COUNT_TESTS, op) ? COUNT_TESTS[op] : undefined;
    if (!test || typeof v !== "number") throw new RuleError("bad-correlation", `bad condition ${op}: ${String(v)}`);
    return (n: number) => test(n, v);
  });
  return (n) => tests.every((t) => t(n));
}

// A group without agent_id spans streams, where `seq` is not comparable: runCorrelation then orders by ts (rerank).
function parseGroupBy(raw: unknown): string[] {
  const list = stringList(raw);
  if (!list) throw new RuleError("bad-correlation", "group-by is required");
  const fields = list.map(resolveField);
  if (fields.some(isDerived)) throw new RuleError("bad-correlation", "a computed field cannot be a group-by key");
  if (!fields.includes("session_id")) throw new RuleError("unsupported-group-by", "group-by must include session_id: a group never spans sessions");
  return fields;
}

/** Validates a correlation document. Its references are resolved later by linkCorrelations. */
export function parseCorrelation(doc: Record<string, unknown>, meta: RuleMeta): CorrelationRule {
  const c = doc.correlation;
  if (typeof c !== "object" || c === null || Array.isArray(c)) throw new RuleError("bad-correlation", "correlation must be a map");
  if ("logsource" in doc || "detection" in doc) throw new RuleError("mixed-document", "a document is a detection or a correlation, not both");
  const block = c as Record<string, unknown>;
  if ("aliases" in block) throw new RuleError("aliases-unsupported", "correlation aliases are not supported");
  const type = block.type;
  if (typeof type !== "string" || !TYPES.has(type)) throw new RuleError("unsupported-correlation-type", `correlation type '${String(type)}' is not supported`);
  const extra = Object.keys(block).find((k) => !KEYS.has(k));
  if (extra) throw new RuleError("bad-correlation", `unknown correlation key '${extra}'`);

  const refs = stringList(block.rules);
  if (!refs) throw new RuleError("bad-correlation", "rules must name at least one rule");
  const span = /^([1-9]\d*)([smhd])$/.exec(String(block.timespan));
  if (!span) throw new RuleError("bad-correlation", `bad timespan '${String(block.timespan)}'`);

  // A partial temporal condition ("2 of these 3 rules") would need another algorithm: only "all of them" passes.
  if (type !== "event_count" && block.condition != null) {
    const { gte, ...rest } = block.condition as Record<string, unknown>;
    if (gte !== refs.length || Object.keys(rest).length > 0) throw new RuleError("bad-correlation", `${type} supports only condition { gte: ${refs.length} }`);
  }

  const max = (doc["x-retrohound"] as Record<string, unknown> | undefined)?.max_events_between;
  if (max !== undefined && !(Number.isInteger(max) && (max as number) >= 0)) throw new RuleError("bad-x-retrohound", "max_events_between must be a non-negative integer");
  const groupBy = parseGroupBy(block["group-by"]);
  if (max !== undefined && !groupBy.includes("agent_id")) {
    throw new RuleError("max-events-needs-agent-id", "max_events_between needs agent_id in group-by: seq is not comparable across streams");
  }
  const generate = block.generate ?? doc.generate ?? false;
  if (typeof generate !== "boolean") throw new RuleError("bad-correlation", "generate must be true or false");

  return {
    ...meta,
    kind: "correlation",
    type: type as CorrelationRule["type"],
    refs,
    rules: [],
    groupBy,
    timespanMs: Number(span[1]) * UNITS[span[2]!]!,
    maxEventsBetween: max as number | undefined,
    count: type === "event_count" ? parseCount(block.condition) : undefined,
    generate,
  };
}

function inCycle(start: CorrelationRule): boolean {
  const seen = new Set<Rule>();
  const walk = (r: Rule): boolean => {
    if (r === start) return true;
    if (r.kind !== "correlation" || seen.has(r)) return false;
    seen.add(r);
    return r.rules.some(walk);
  };
  return start.rules.some(walk);
}

/**
 * Resolves references by name or id, drops what cannot run and marks silenced rules. `onError` receives each dropped
 * correlation. A correlation that leans on a dropped one goes too: its result would be silently empty.
 */
export function linkCorrelations(rules: Rule[], index: Map<string, Rule>, onError: (rule: CorrelationRule, e: RuleError) => void): Rule[] {
  const pending = new Set<CorrelationRule>();
  const good = new Set<Rule>();
  for (const rule of rules) {
    if (rule.kind === "detection") {
      good.add(rule);
      continue;
    }
    const missing = rule.refs.find((ref) => !index.has(ref));
    if (missing !== undefined) onError(rule, new RuleError("unresolved-reference", `no loaded rule has the name or id '${missing}'`));
    else {
      rule.rules = rule.refs.map((ref) => index.get(ref)!);
      pending.add(rule);
    }
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const rule of pending) {
      if (rule.rules.every((r) => good.has(r))) {
        good.add(rule);
        pending.delete(rule);
        changed = true;
      }
    }
  }
  for (const rule of pending) {
    if (inCycle(rule)) onError(rule, new RuleError("correlation-cycle", "this correlation references itself through its rules"));
    else onError(rule, new RuleError("unresolved-reference", "this correlation references a rule that was rejected"));
  }
  const kept = rules.filter((r) => good.has(r));
  const generating = new Set<Rule>();
  const referenced = new Set<Rule>();
  for (const rule of kept) {
    if (rule.kind !== "correlation") continue;
    for (const ref of rule.rules) {
      referenced.add(ref);
      if (rule.generate) generating.add(ref);
    }
  }
  for (const rule of kept) rule.silenced = referenced.has(rule) && !generating.has(rule);
  return kept;
}

// Both limits are inclusive. `ts` may step back a little, so distance is absolute. A bad `ts` never fits (NaN).
function inWindow(rule: CorrelationRule, a: Occurrence, b: Occurrence): boolean {
  if (!(Math.abs(b.t - a.t) <= rule.timespanMs)) return false;
  return rule.maxEventsBetween === undefined || Math.abs(b.seq - a.seq) <= rule.maxEventsBetween;
}

function pastWindow(rule: CorrelationRule, a: Occurrence, b: Occurrence): boolean {
  return b.t - a.t > rule.timespanMs || (rule.maxEventsBetween !== undefined && b.seq - a.seq > rule.maxEventsBetween);
}

function lowerBound(list: Occurrence[], seq: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]!.seq < seq) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** One occurrence out of several: every contributing event once, in contract order, completing on the latest. */
function merge(parts: Occurrence[]): Occurrence {
  const events = [...new Set(parts.flatMap((p) => p.events))].sort(compareEvents);
  return occurrence(parts.reduce((a, b) => (b.seq >= a.seq ? b : a)).at, events);
}

// The first window, anchored on each occurrence and grown as far as it fits, whose size meets the condition. Using the
// full window keeps `lt`, `eq` and `neq` honest: a window still growing has no final count yet.
// shortcut: event_count yields one finding per window, in practice one per session per rule, so a hook rule such as
// control_plane_hook_repo_script cannot report per command; upgrade in v0.2 (emit one finding per contributing event or a per-key sub-group).
function eventCount(rule: CorrelationRule, steps: Occurrence[][]): Occurrence[] {
  const list = [...new Set(steps.flat())].sort((a, b) => a.seq - b.seq);
  let end = 0;
  for (let start = 0; start < list.length; start++) {
    end = Math.max(end, start);
    while (end + 1 < list.length && inWindow(rule, list[start]!, list[end + 1]!)) end++;
    if (rule.count!(end - start + 1)) return [merge(list.slice(start, end + 1))];
  }
  return [];
}

// Earliest fit at every step, which leaves the most room for the next one. `seq` is compared, never array position, so
// one event can fill consecutive steps and two events of one transcript line keep either order.
function temporalOrdered(rule: CorrelationRule, steps: Occurrence[][]): Occurrence[] {
  const out: Occurrence[] = [];
  for (const first of steps[0]!) {
    const chain = [first];
    for (const step of steps.slice(1)) {
      const prev = chain[chain.length - 1]!;
      let found: Occurrence | undefined;
      for (let i = lowerBound(step, prev.seq); i < step.length && !found; i++) {
        const o = step[i]!;
        if (pastWindow(rule, first, o)) break;
        if (inWindow(rule, first, o)) found = o;
      }
      if (!found) break;
      chain.push(found);
    }
    if (chain.length === steps.length) out.push(merge(chain));
  }
  return out;
}

// Any order: a sliding window that holds every rule, reported once per occurrence of the first rule.
function temporal(rule: CorrelationRule, steps: Occurrence[][]): Occurrence[] {
  const entries = steps.flatMap((list, step) => list.map((o) => ({ o, step }))).sort((a, b) => a.o.seq - b.o.seq);
  const latest = steps.map(() => -1); // per rule, its last entry so far
  const out: Occurrence[] = [];
  let from = 0;
  let done = 0;
  entries.forEach(({ o, step }, to) => {
    latest[step] = to;
    while (from < to && !inWindow(rule, entries[from]!.o, o)) from++;
    if (latest.some((i) => i < from)) return;
    for (done = Math.max(done, from); done <= to; done++) {
      const first = entries[done]!;
      if (first.step === 0) out.push(merge([first.o, ...latest.slice(1).map((i) => entries[i]!.o)]));
    }
  });
  return out;
}

// Across streams `seq` means nothing: replace it with each event's rank in (ts, agent_id, seq) order, a total order that
// stays deterministic on equal ts. A bad ts sorts first. Occurrences of one event share a rank.
function rerank(steps: Occurrence[][]): Occurrence[][] {
  const evs = [...new Set(steps.flat().map((o) => o.at))];
  const key = (e: Row) => (Number.isNaN(Date.parse(String(e.ts))) ? -Infinity : Date.parse(String(e.ts)));
  evs.sort((a, b) => (key(a) === key(b) ? 0 : key(a) < key(b) ? -1 : 1) || compareEvents(a, b));
  const rank = new Map(evs.map((e, i) => [e, i]));
  return steps.map((list) => list.map((o) => ({ ...o, seq: rank.get(o.at)! })));
}

const RUN = { event_count: eventCount, temporal_ordered: temporalOrdered, temporal };

/** Fires one correlation over the occurrences of the rules it references, which must already be in `hits`. */
export function runCorrelation(rule: CorrelationRule, hits: Map<Rule, Occurrence[]>): Occurrence[] {
  const groups = new Map<string, Occurrence[][]>();
  rule.rules.forEach((ref, step) => {
    for (const occ of hits.get(ref)!) {
      const key = JSON.stringify(rule.groupBy.map((f) => occ.at[f] ?? null)); // null and missing are one group
      let steps = groups.get(key);
      if (!steps) groups.set(key, (steps = rule.rules.map(() => [])));
      steps[step]!.push(occ);
    }
  });
  const run = RUN[rule.type];
  const found: Occurrence[] = [];
  const session = !rule.groupBy.includes("agent_id");
  for (let steps of groups.values()) {
    if (session) steps = rerank(steps);
    for (const list of steps) list.sort((a, b) => a.seq - b.seq);
    if (rule.type === "event_count" || steps.every((list) => list.length > 0)) found.push(...run(rule, steps));
  }
  found.sort((a, b) => compareEvents(a.events[0]!, b.events[0]!));
  if (rule.type !== "event_count") return found;
  const sessions = new Set<unknown>(); // one finding per session, even when several of its streams qualify
  return found.filter((o) => {
    const session = o.events[0]!.session_id;
    if (sessions.has(session)) return false;
    sessions.add(session);
    return true;
  });
}

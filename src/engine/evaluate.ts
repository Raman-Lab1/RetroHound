// Runs compiled rules over events. Generic on purpose: ADR 0006 feeds it raw parser events and DB rows alike, so it
// reads fields by name and knows nothing of the store, the collector or masking.
import { compareEvents, occurrence, runCorrelation, type CorrelationRule, type Occurrence } from "./correlate.ts";
import type { DetectionRule, Rule } from "./load.ts";
import { resetFieldCache, type Row } from "./modifiers.ts";

/** `events` are in contract order, (session_id, agent_id, seq), without repeats. `events[0]` is the primary event. */
export type Match<E> = { rule: Rule; events: E[] };

/** Every rule the given ones need, references before the rules that use them. */
function executionOrder(rules: Rule[]): Rule[] {
  const seen = new Set<Rule>();
  const visit = (rule: Rule) => {
    if (seen.has(rule)) return;
    if (rule.kind === "correlation") rule.rules.forEach(visit);
    seen.add(rule);
  };
  rules.forEach(visit);
  return [...seen];
}

/** Rules that can fire on a category, in load order, so an event only meets the rules of its own category. */
function bucketByCategory(rules: DetectionRule[]): Map<string, DetectionRule[]> {
  const buckets = new Map<string, DetectionRule[]>();
  for (const rule of rules) {
    if (rule.category && !buckets.has(rule.category)) {
      buckets.set(rule.category, rules.filter((r) => !r.category || r.category === rule.category));
    }
  }
  return buckets;
}

function contractOrder<E extends object>(events: readonly E[]): readonly E[] {
  for (let i = 1; i < events.length; i++) {
    if (compareEvents(events[i - 1] as Row, events[i] as Row) > 0) return [...events].sort((a, b) => compareEvents(a as Row, b as Row));
  }
  return events;
}

export function evaluate<E extends object>(rules: Rule[], events: readonly E[]): Match<E>[] {
  const order = executionOrder(rules);
  const detections = order.filter((r) => r.kind === "detection");
  const correlations = order.filter((r): r is CorrelationRule => r.kind === "correlation");
  const buckets = bucketByCategory(detections);
  const uncategorised = detections.filter((r) => !r.category);
  const hits = new Map<Rule, Occurrence[]>(detections.map((r) => [r, []]));

  for (const event of contractOrder(events)) {
    const ev = event as Row;
    let occ: Occurrence | null = null; // shared, so a correlation can tell one event from two
    for (const rule of buckets.get(ev.category as string) ?? uncategorised) {
      if (rule.service !== undefined && ev.agent !== rule.service) continue;
      if (rule.matches(ev)) hits.get(rule)!.push((occ ??= occurrence(ev)));
    }
  }
  resetFieldCache();

  for (const rule of correlations) hits.set(rule, runCorrelation(rule, hits));
  return rules
    .filter((rule) => !rule.silenced)
    .flatMap((rule) => hits.get(rule)!.map((o) => ({ rule, events: [...o.events] as E[] })));
}

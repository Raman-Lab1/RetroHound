// Hand-written rules and events for the engine tests. Everything is defanged: example.invalid, 192.0.2.x.
import type { RawEvent } from "../../src/normalize/types.ts";
import { evaluate } from "../../src/engine/evaluate.ts";
import { loadRules, type Rejection, type Rule } from "../../src/engine/load.ts";

let nextSeq = 0;

export function event(over: Partial<RawEvent> = {}): RawEvent {
  const seq = over.seq ?? ++nextSeq;
  return {
    id: `e${seq}`,
    schema_version: "0.1",
    agent: "claude_code",
    session_id: "s1",
    ts: "2026-01-01T00:00:00.000Z",
    seq,
    category: "tool_call",
    raw_ref: { file: "a.jsonl", line: seq },
    ...over,
  };
}

/** A one-document rule around `detection`, indented into place. Header lines override the defaults. */
export function ruleYaml(detection: string, logsource = "product: ai_coding_agent", header = ""): string {
  const body = detection.split("\n").map((l) => `    ${l}`).join("\n");
  return `title: Test rule\n${header}logsource: { ${logsource.replaceAll("\n", ", ")} }\ndetection:\n${body}\n`;
}

export function load(...texts: string[]): { rules: Rule[]; rejected: Rejection[] } {
  return loadRules(texts.map((text, i) => ({ path: `rule${i}.yml`, text })));
}

/** The one rule these documents define; fails loudly when it was rejected. */
export function compile(text: string): Rule {
  const { rules, rejected } = load(text);
  if (rejected.length > 0) throw new Error(`rejected: ${JSON.stringify(rejected)}`);
  return rules[0]!;
}

export function fires(rule: Rule, ev: RawEvent): boolean {
  return evaluate([rule], [ev]).length > 0;
}

/** Does a single `field: value` selection fire on the event? */
export function item(key: string, value: string, ev: RawEvent): boolean {
  return fires(compile(ruleYaml(`selection:\n    ${key}: ${value}\ncondition: selection`)), ev);
}

/** The reason a document was rejected for. Fails loudly when it loaded. */
export function reason(text: string): string {
  const { rules, rejected } = load(text);
  if (rules.length > 0 || rejected.length !== 1) throw new Error(`expected one rejection, got ${JSON.stringify({ rules: rules.length, rejected })}`);
  return rejected[0]!.reason;
}

/** The rejection reason of a single `field: value` selection. */
export function itemReason(key: string, value: string): string {
  return reason(ruleYaml(`selection:\n    ${key}: ${value}\ncondition: selection`));
}

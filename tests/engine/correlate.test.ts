import { describe, expect, test } from "bun:test";
import type { RawEvent } from "../../src/normalize/types.ts";
import { evaluate } from "../../src/engine/evaluate.ts";
import type { CorrelationRule } from "../../src/engine/correlate.ts";
import { event, load, reason, ruleYaml } from "./helpers.ts";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

function base(name: string, selection: string, category?: string): string {
  const logsource = category ? `product: ai_coding_agent, category: ${category}` : undefined;
  return ruleYaml(`selection: ${selection}\ncondition: selection`, logsource, `name: ${name}\n`);
}

function correlation(name: string, type: string, rules: string[], extra = "", top = ""): string {
  return `title: ${name}
name: ${name}
correlation:
    type: ${type}
    rules: [${rules.join(", ")}]
    group-by: [session_id, agent_id]
    timespan: 10m
${extra.split("\n").filter(Boolean).map((l) => `    ${l}`).join("\n")}
${top}
`;
}

const SECRET_READ = base("secret_read", "{ command_line|contains: .env }");
const EGRESS = base("egress", "{ command_line|contains: curl }");
const BLOCKED = base("blocked", "{ target_path|endswith: /.env, outcome: blocked }", "file_access");
const SUCCESS = base("success", "{ target_path|endswith: /.env, outcome: success }", "file_access");

const read = (seq: number, over: Partial<RawEvent> = {}) => event({ seq, ts: at(seq), command_line: "cat .env", ...over });
const send = (seq: number, over: Partial<RawEvent> = {}) => event({ seq, ts: at(seq), command_line: "curl https://example.invalid", ...over });
const hit = (seq: number, over: Partial<RawEvent> = {}) => event({ seq, ts: at(seq), command_line: "hit", ...over });
const seqs = (m: { events: RawEvent[] }) => m.events.map((e) => e.seq);

function run(docs: string[], events: RawEvent[]) {
  const { rules, rejected } = load(docs.join("---\n"));
  expect(rejected).toEqual([]);
  return evaluate(rules, events);
}

const star2 = (extra = "", top = "x-retrohound: { lane: hunt, max_events_between: 20 }") => [SECRET_READ, EGRESS, correlation("star2", "temporal_ordered", ["secret_read", "egress"], extra, top)];
const star2Matches = (events: RawEvent[], extra?: string, top?: string) => run(star2(extra, top), events).filter((m) => m.rule.name === "star2");

describe("temporal_ordered: the ★2 shape", () => {
  test("a secret read then egress fires, pointing at both events, primary first", () => {
    const matches = star2Matches([read(1), send(2)]);
    expect(matches.length).toBe(1);
    expect(seqs(matches[0]!)).toEqual([1, 2]);
  });
  test("egress then read does not fire", () => {
    expect(star2Matches([send(1), read(2)])).toEqual([]);
  });
  test("one event can satisfy both steps, and appears once", () => {
    const both = event({ seq: 5, ts: at(5), command_line: "cat .env; curl https://example.invalid" });
    const matches = star2Matches([both]);
    expect(matches.length).toBe(1);
    expect(matches[0]!.events).toEqual([both]);
  });
  test("two events of one line keep either order: ordering is by seq, non-strict", () => {
    expect(star2Matches([send(5), read(5)]).length).toBe(1);
  });
  test("one finding per first-step event, the egress may be shared", () => {
    const matches = star2Matches([read(1), read(2), send(3), send(4)]);
    expect(matches.map(seqs)).toEqual([[1, 3], [2, 3]]);
  });
  test("max_events_between is an inclusive seq delta", () => {
    expect(star2Matches([read(1), send(21)]).length).toBe(1);
    expect(star2Matches([read(1), send(22)])).toEqual([]);
  });
  test("timespan is inclusive and slides with each first step", () => {
    const top = "";
    expect(star2Matches([read(1), send(601)], "", top).length).toBe(1);
    expect(star2Matches([read(1), send(602)], "", top)).toEqual([]);
    expect(star2Matches([read(1), read(100), send(650)], "", top).map(seqs)).toEqual([[100, 650]]);
  });
  test("both limits must hold", () => {
    expect(star2Matches([read(1, { ts: at(0) }), send(2, { ts: at(601) })])).toEqual([]); // seq close, time far
    expect(star2Matches([read(1), send(30)])).toEqual([]); // time close, seq far
  });
  test("an unparseable ts never correlates", () => {
    expect(star2Matches([read(1, { ts: "not a date" }), send(2)])).toEqual([]);
  });
  test("three steps: order of rules:, the window covers the whole chain", () => {
    const third = base("third", "{ command_line|contains: rm }");
    const docs = [SECRET_READ, EGRESS, third, correlation("chain", "temporal_ordered", ["secret_read", "egress", "third"], "", "x-retrohound: { max_events_between: 5 }")];
    const rm = (seq: number) => event({ seq, ts: at(seq), command_line: "rm x" });
    const only = (events: RawEvent[]) => run(docs, events).filter((m) => m.rule.name === "chain");
    expect(only([read(1), send(2), rm(3)]).map(seqs)).toEqual([[1, 2, 3]]);
    expect(only([read(1), rm(2), send(3)])).toEqual([]);
    expect(only([read(1), send(2), rm(7)])).toEqual([]);
    expect(only([read(1), send(2), rm(6)]).length).toBe(1);
  });
});

describe("temporal_ordered: the N7 shape", () => {
  const n7 = [BLOCKED, SUCCESS, correlation("n7", "temporal_ordered", ["blocked", "success"], "generate: true")];
  const access = (seq: number, outcome: "blocked" | "success", target_path = "/w/.env") => event({ seq, ts: at(seq), category: "file_access", target_path, outcome });
  const only = (events: RawEvent[]) => run(n7, events).filter((m) => m.rule.name === "n7");
  test("blocked then success fires", () => {
    expect(only([access(1, "blocked"), access(2, "success")]).map(seqs)).toEqual([[1, 2]]);
  });
  test("success then blocked, or blocked alone, does not", () => {
    expect(only([access(1, "success"), access(2, "blocked")])).toEqual([]);
    expect(only([access(1, "blocked")])).toEqual([]);
  });
  test("each blocked attempt reports once", () => {
    expect(only([access(1, "blocked"), access(2, "blocked"), access(3, "success")]).length).toBe(2);
  });
});

describe("x-retrohound.differ_by", () => {
  const ANY_BLOCKED = base("any_blocked", "{ outcome: blocked }");
  const ANY_SUCCESS = base("any_success", "{ outcome: success }");
  const docs = [ANY_BLOCKED, ANY_SUCCESS, correlation("other", "temporal_ordered", ["any_blocked", "any_success"], "", "x-retrohound: { differ_by: [category] }")];
  const call = (seq: number, category: RawEvent["category"], outcome: "blocked" | "success") => event({ seq, ts: at(seq), category, outcome });
  const only = (events: RawEvent[]) => run(docs, events).filter((m) => m.rule.name === "other");
  test("a later step must differ from the first in the field; the earliest that does is taken", () => {
    expect(only([call(1, "file_access", "blocked"), call(2, "file_access", "success")])).toEqual([]);
    expect(only([call(1, "file_access", "blocked"), call(2, "file_access", "success"), call(3, "mcp", "success")]).map(seqs)).toEqual([[1, 3]]);
  });
  test("only on temporal_ordered, only a list of stored fields", () => {
    expect(reason(correlation("c", "temporal", ["h"], "", "x-retrohound: { differ_by: [category] }"))).toBe("bad-x-retrohound");
    expect(reason(correlation("c", "temporal_ordered", ["h"], "", "x-retrohound: { differ_by: 3 }"))).toBe("bad-x-retrohound");
    expect(reason(correlation("c", "temporal_ordered", ["h"], "", "x-retrohound: { differ_by: [download_executed] }"))).toBe("bad-x-retrohound");
    expect(reason(`x-retrohound: { differ_by: [category] }\n${base("d", "{ outcome: blocked }")}`)).toBe("bad-x-retrohound");
  });
});

describe("streams", () => {
  test("a parent read and a child's egress do not correlate", () => {
    expect(star2Matches([read(1), send(2, { agent_id: "child" })])).toEqual([]);
  });
  test("a child's read and the parent's egress do not correlate", () => {
    expect(star2Matches([read(1, { agent_id: "child" }), send(2)])).toEqual([]);
  });
  test("two children do not correlate", () => {
    expect(star2Matches([read(1, { agent_id: "a" }), send(2, { agent_id: "b" })])).toEqual([]);
  });
  test("each stream correlates on its own", () => {
    const matches = star2Matches([read(1, { agent_id: "a" }), send(2, { agent_id: "a" }), read(1), send(2)]);
    expect(matches.map((m) => m.events[0]!.agent_id)).toEqual([undefined, "a"]);
  });
  test("streams report in contract order: main first, then agent ids", () => {
    const pair = (agent_id?: string) => [read(1, { agent_id }), send(2, { agent_id })];
    const matches = star2Matches([...pair("z"), ...pair("a"), ...pair()]);
    expect(matches.map((m) => m.events[0]!.agent_id)).toEqual([undefined, "a", "z"]);
  });
  test("sessions do not correlate", () => {
    expect(star2Matches([read(1, { session_id: "s1" }), send(2, { session_id: "s2" })])).toEqual([]);
  });
  test("undefined and null agent_id are one stream: parser events and DB rows behave alike", () => {
    const row = { ...send(2), agent_id: null } as never;
    expect(star2Matches([read(1), row]).length).toBe(1);
  });
  test("an agent_id spelled null is not the null group", () => {
    expect(star2Matches([read(1), send(2, { agent_id: "null" })])).toEqual([]);
  });
  test("group keys cannot run together", () => {
    expect(star2Matches([read(1, { session_id: "a", agent_id: "b,c" }), send(2, { session_id: "a,b", agent_id: "c" })])).toEqual([]);
  });
  test("input in any order gives contract order, and the input is left alone", () => {
    const input = [send(2), read(1, { agent_id: "z" }), read(1)];
    const before = [...input];
    expect(star2Matches(input).map(seqs)).toEqual([[1, 2]]);
    expect(input).toEqual(before);
  });
});

describe("event_count", () => {
  const counted = (condition: string, top = "") => [base("h", "{ command_line: hit }"), correlation("many", "event_count", ["h"], `condition: ${condition}`, top)];
  const only = (condition: string, events: RawEvent[], top?: string) => run(counted(condition, top), events).filter((m) => m.rule.name === "many");
  test("gte fires on the window that reaches it, pointing at the whole window", () => {
    expect(only("{ gte: 3 }", [hit(1), hit(2)])).toEqual([]);
    expect(only("{ gte: 3 }", [hit(1), hit(2), hit(3)]).map(seqs)).toEqual([[1, 2, 3]]);
    expect(only("{ gte: 3 }", [hit(1), hit(2), hit(3), hit(4)]).map(seqs)).toEqual([[1, 2, 3, 4]]);
  });
  test("the window slides: it is not cut into fixed buckets", () => {
    expect(only("{ gte: 3 }", [hit(1), hit(595), hit(605), hit(610)]).map(seqs)).toEqual([[595, 605, 610]]);
  });
  test("window edges are inclusive", () => {
    expect(only("{ gte: 2 }", [hit(1), hit(601)]).length).toBe(1);
    expect(only("{ gte: 2 }", [hit(1), hit(602)])).toEqual([]);
  });
  test("max_events_between applies", () => {
    expect(only("{ gte: 2 }", [hit(1), hit(4)], "x-retrohound: { max_events_between: 2 }")).toEqual([]);
    expect(only("{ gte: 2 }", [hit(1), hit(3)], "x-retrohound: { max_events_between: 2 }").length).toBe(1);
  });
  test("every operator, two keys are a range", () => {
    const three = [hit(1), hit(2), hit(3)];
    expect(only("{ gt: 2 }", three).length).toBe(1);
    expect(only("{ gt: 3 }", three)).toEqual([]);
    expect(only("{ lt: 4 }", three).length).toBe(1);
    expect(only("{ lte: 3 }", three).length).toBe(1);
    expect(only("{ eq: 3 }", three).length).toBe(1);
    expect(only("{ eq: 4 }", three)).toEqual([]);
    expect(only("{ neq: 3 }", [hit(1), hit(2), hit(3)]).map(seqs)).toEqual([[2, 3]]);
    expect(only("{ gte: 2, lte: 2 }", three).map(seqs)).toEqual([[2, 3]]);
  });
  test("at most one finding per session per rule, across its streams and windows", () => {
    const events = [hit(1), hit(2), hit(1000), hit(1001), hit(1, { agent_id: "a" }), hit(2, { agent_id: "a" })];
    const matches = only("{ gte: 2 }", events);
    expect(matches.length).toBe(1);
    expect(matches[0]!.events[0]!.agent_id).toBeUndefined();
    expect(seqs(matches[0]!)).toEqual([1, 2]);
  });
  test("each session gets its own finding", () => {
    expect(only("{ gte: 2 }", [hit(1), hit(2), hit(1, { session_id: "s2" }), hit(2, { session_id: "s2" })]).length).toBe(2);
  });
  test("streams count apart", () => {
    expect(only("{ gte: 2 }", [hit(1), hit(2, { agent_id: "a" })])).toEqual([]);
  });
  test("an event matched by two referenced rules counts once, in any group-by", () => {
    for (const groupBy of ["[session_id, agent_id]", "[session_id]", "[project_path]"]) {
      const many = correlation("many", "event_count", ["x", "y"], "condition: { gte: 2 }").replace("[session_id, agent_id]", groupBy);
      const docs = [base("x", "{ command_line: hit }"), base("y", "{ command_line|contains: hit }"), many];
      const p = { project_path: "/p" };
      expect(run(docs, [hit(1, p)]).filter((m) => m.rule.name === "many")).toEqual([]);
      expect(run(docs, [hit(1, p), hit(2, p)]).filter((m) => m.rule.name === "many").map(seqs)).toEqual([[1, 2]]);
    }
  });
  test("extra group-by keys split further", () => {
    const yaml = correlation("many", "event_count", ["h"], "condition: { gte: 2 }").replace("[session_id, agent_id]", "[session_id, agent_id, tool_name]");
    const docs = [base("h", "{ command_line: hit }"), yaml];
    expect(run(docs, [hit(1, { tool_name: "Bash" }), hit(2, { tool_name: "Read" })]).filter((m) => m.rule.name === "many")).toEqual([]);
  });
});

describe("temporal", () => {
  const docs = [SECRET_READ, EGRESS, correlation("any_order", "temporal", ["secret_read", "egress"], "", "x-retrohound: { max_events_between: 20 }")];
  const only = (events: RawEvent[]) => run(docs, events).filter((m) => m.rule.name === "any_order");
  test("fires in either order, events in contract order", () => {
    expect(only([read(1), send(2)]).map(seqs)).toEqual([[1, 2]]);
    expect(only([send(1), read(2)]).map(seqs)).toEqual([[1, 2]]);
  });
  test("needs every rule, within the window", () => {
    expect(only([read(1)])).toEqual([]);
    expect(only([read(1), send(30)])).toEqual([]);
    expect(only([read(1), send(21)]).length).toBe(1);
  });
  test("one event can satisfy both", () => {
    expect(only([event({ seq: 1, ts: at(1), command_line: "cat .env; curl x" })]).map(seqs)).toEqual([[1]]);
  });
  test("one finding per occurrence of the first rule", () => {
    expect(only([read(1), read(2), send(3)]).map(seqs)).toEqual([[1, 3], [2, 3]]);
    expect(only([send(1), read(2), read(3)]).map(seqs)).toEqual([[1, 2], [1, 3]]);
    expect(only([read(1), send(2), read(3)]).map(seqs)).toEqual([[1, 2], [2, 3]]);
  });
  test("a first-rule event that left the window before the other rule came is not reported", () => {
    expect(only([read(1), read(50), send(60)]).map(seqs)).toEqual([[50, 60]]);
  });
  test("three rules must all sit inside one window", () => {
    const third = base("third", "{ command_line|contains: rm }");
    const three = [SECRET_READ, EGRESS, third, correlation("t", "temporal", ["secret_read", "egress", "third"], "", "x-retrohound: { max_events_between: 10 }")];
    const rm = (seq: number) => event({ seq, ts: at(seq), command_line: "rm x" });
    const t = (events: RawEvent[]) => run(three, events).filter((m) => m.rule.name === "t");
    expect(t([send(1), read(5), rm(11)]).map(seqs)).toEqual([[1, 5, 11]]);
    expect(t([send(1), read(5), rm(12)])).toEqual([]);
  });
  test("streams stay apart", () => {
    expect(only([read(1), send(2, { agent_id: "child" })])).toEqual([]);
  });
});

describe("generate", () => {
  const names = (docs: string[], events: RawEvent[]) => run(docs, events).map((m) => m.rule.name);
  const events = [read(1), send(2)];
  test("default false silences referenced rules, the correlation still fires", () => {
    expect(names(star2(), events)).toEqual(["star2"]);
  });
  test("generate: true keeps them", () => {
    expect(names(star2("generate: true"), events).sort()).toEqual(["egress", "secret_read", "star2"]);
    expect(names(star2("", "generate: true"), events).sort()).toEqual(["egress", "secret_read", "star2"]);
  });
  test("a silenced rule does not alert when the correlation does not fire", () => {
    expect(names(star2(), [read(1)])).toEqual([]);
  });
  test("a rule no correlation references is untouched", () => {
    expect(names([...star2(), base("other", "{ command_line|contains: cat }")], [read(1)])).toEqual(["other"]);
  });
  test("silenced is exported for `rules list`, and one generating referrer lifts it", () => {
    const { rules } = load(star2().join("---\n"));
    expect(rules.filter((r) => r.silenced).map((r) => r.name).sort()).toEqual(["egress", "secret_read"]);
    const both = [...star2(), correlation("second", "temporal", ["secret_read"], "generate: true")];
    const result = load(both.join("---\n"));
    expect(result.rules.filter((r) => r.silenced).map((r) => r.name)).toEqual(["egress"]);
  });
  test("a correlation that was rejected silences nothing", () => {
    const { rules } = load([SECRET_READ, correlation("broken", "event_count", ["secret_read", "missing"], "condition: { gte: 1 }")].join("---\n"));
    expect(rules.map((r) => r.silenced)).toEqual([false]);
  });
});

describe("references", () => {
  test("by name, by id, across files, in any file order", () => {
    const withId = ruleYaml(`selection: { command_line: hit }\ncondition: selection`, undefined, "id: 00000000-0000-4000-8000-000000000009\n");
    const { rules, rejected } = load(correlation("c", "event_count", ["00000000-0000-4000-8000-000000000009"], "condition: { gte: 1 }"), withId);
    expect(rejected).toEqual([]);
    expect((rules.find((r) => r.kind === "correlation") as CorrelationRule).rules[0]!.kind).toBe("detection");
    expect(evaluate(rules, [hit(1)]).map((m) => m.rule.name)).toEqual(["c"]);
  });
  test("a single rule name may be a plain string", () => {
    const docs = [base("h", "{ command_line: hit }"), correlation("c", "event_count", ["h"], "condition: { gte: 1 }").replace("[h]", "h")];
    expect(run(docs, [hit(1)]).length).toBe(1);
  });
  test("a title is not a reference", () => {
    const { rejected } = load(`${ruleYaml(`selection: { command_line: hit }\ncondition: selection`)}---\n${correlation("c", "event_count", ["'Test rule'"], "condition: { gte: 1 }")}`);
    expect(rejected[0]!.reason).toBe("unresolved-reference");
  });
  test("an unresolved reference rejects only the correlation", () => {
    const { rules, rejected } = load([SECRET_READ, correlation("c", "temporal", ["secret_read", "missing"])].join("---\n"));
    expect(rules.map((r) => r.name)).toEqual(["secret_read"]);
    expect(rejected).toMatchObject([{ doc: 1, title: "c", reason: "unresolved-reference" }]);
  });
  test("a reference to a rejected rule is unresolved", () => {
    const bad = ruleYaml(`selection: { nope: x }\ncondition: selection`, undefined, "name: bad\n");
    const { rejected } = load([bad, correlation("c", "temporal", ["bad"])].join("---\n"));
    expect(rejected.map((r) => r.reason).sort()).toEqual(["unknown-field", "unresolved-reference"]);
  });
  test("a cycle rejects its members and whatever leans on them", () => {
    const docs = [correlation("a", "temporal", ["b"]), correlation("b", "temporal", ["a"]), correlation("c", "temporal", ["a"])];
    const { rules, rejected } = load(docs.join("---\n"));
    expect(rules).toEqual([]);
    expect(Object.fromEntries(rejected.map((r) => [r.title, r.reason]))).toEqual({ a: "correlation-cycle", b: "correlation-cycle", c: "unresolved-reference" });
  });
  test("a self-reference is a cycle", () => {
    expect(reason(correlation("a", "temporal", ["a"]))).toBe("correlation-cycle");
  });
  test("a correlation can reference a correlation", () => {
    const docs = [SECRET_READ, EGRESS, base("third", "{ command_line|contains: rm }"), correlation("first", "temporal_ordered", ["secret_read", "egress"]), correlation("second", "temporal_ordered", ["first", "third"])];
    const matches = run(docs, [read(1), send(2), event({ seq: 3, ts: at(3), command_line: "rm x" })]);
    expect(matches.map((m) => m.rule.name)).toEqual(["second"]);
    expect(seqs(matches[0]!)).toEqual([1, 2, 3]);
  });
  test("evaluate runs what a rule needs even when given that rule alone", () => {
    const { rules } = load(star2().join("---\n"));
    expect(evaluate(rules.filter((r) => r.name === "star2"), [read(1), send(2)]).map((m) => m.rule.name)).toEqual(["star2"]);
  });
});

describe("correlation rejections", () => {
  const swap = (text: string, from: string, to: string) => text.replace(from, to);
  const good = correlation("c", "event_count", ["h"], "condition: { gte: 1 }");
  test.each(["value_count", "value_sum", "value_avg", "value_percentile", "nonsense"])("type %s", (type) => {
    expect(reason(swap(good, "event_count", type))).toBe("unsupported-correlation-type");
  });
  test("value_count's condition shape", () => {
    expect(reason(swap(good, "{ gte: 1 }", "{ field: domain, gte: 1 }"))).toBe("unsupported-correlation-type");
  });
  test("aliases", () => {
    expect(reason(correlation("c", "temporal", ["h"], "aliases: { x: { h: session_id } }"))).toBe("aliases-unsupported");
  });
  test("group-by must stay inside one stream, on known fields", () => {
    expect(reason(swap(good, "[session_id, agent_id]", "[agent_id]"))).toBe("unsupported-group-by");
    expect(reason(swap(good, "[session_id, agent_id]", "[agent_id, nope, session_id]"))).toBe("unknown-field");
    expect(reason(swap(good, "    group-by: [session_id, agent_id]\n", ""))).toBe("bad-correlation");
  });
  test("project-scoped group-by: allowed with a short timespan, no agent_id, no session_id needed", () => {
    expect(load(base("h", "{ command_line: hit }"), swap(good, "[session_id, agent_id]", "[project_path]")).rejected).toEqual([]);
    expect(reason(swap(good, "[session_id, agent_id]", "[project_path, agent_id]"))).toBe("unsupported-group-by");
    expect(reason(swap(good, "[session_id, agent_id]", "[project_path]").replace("10m", "2h"))).toBe("project-group-timespan");
    expect(reason(swap(good, "[session_id, agent_id]", "[tool_name]"))).toBe("unsupported-group-by");
  });
  test("a project-scoped group joins sessions of one project, in ts order, and skips events with no project", () => {
    const top = "x-retrohound: { differ_by: [session_id] }";
    const docs = [SECRET_READ, EGRESS, correlation("proj", "temporal_ordered", ["secret_read", "egress"], "", top).replace("[session_id, agent_id]", "[project_path]")];
    const fire = (r: Partial<RawEvent>, s: Partial<RawEvent>) => run(docs, [read(1, r), send(2, s)]).filter((m) => m.rule.name === "proj").length;
    expect(fire({ session_id: "a", project_path: "/p" }, { session_id: "b", project_path: "/p" })).toBe(1);
    expect(fire({ session_id: "a", project_path: "/p" }, { session_id: "a", project_path: "/p" })).toBe(0); // differ_by
    expect(fire({ session_id: "a", project_path: "/p" }, { session_id: "b", project_path: "/q" })).toBe(0);
    expect(fire({ session_id: "a", project_path: undefined }, { session_id: "b", project_path: undefined })).toBe(0);
  });
  test("timespan", () => {
    for (const bad of ["5", "5w", "5M", "0m", "m", "-5m"]) expect(reason(swap(good, "timespan: 10m", `timespan: ${bad}`))).toBe("bad-correlation");
    expect(reason(swap(good, "    timespan: 10m\n", ""))).toBe("bad-correlation");
  });
  test("event_count conditions", () => {
    expect(reason(swap(good, "    condition: { gte: 1 }\n", ""))).toBe("bad-correlation");
    expect(reason(swap(good, "{ gte: 1 }", "{ gte: many }"))).toBe("bad-correlation");
    expect(reason(swap(good, "{ gte: 1 }", "{ about: 1 }"))).toBe("bad-correlation");
    expect(reason(swap(good, "{ gte: 1 }", "{ toString: 1 }"))).toBe("bad-correlation");
    expect(reason(swap(good, "{ gte: 1 }", "{}"))).toBe("bad-correlation");
  });
  test("a partial temporal condition is refused, the implied one is fine", () => {
    expect(reason(correlation("c", "temporal", ["h", "k"], "condition: { gte: 1 }"))).toBe("bad-correlation");
    expect(load(SECRET_READ, correlation("c", "temporal", ["secret_read"], "condition: { gte: 1 }")).rejected).toEqual([]);
  });
  test("rules, generate and unknown keys", () => {
    expect(reason(swap(good, "rules: [h]", "rules: []"))).toBe("bad-correlation");
    expect(reason(swap(good, "rules: [h]", "rules: [1]"))).toBe("bad-correlation");
    expect(reason(correlation("c", "temporal", ["h"], "generate: maybe"))).toBe("bad-correlation");
    expect(reason(correlation("c", "temporal", ["h"], "window: sliding"))).toBe("bad-correlation");
  });
  test("max_events_between", () => {
    expect(reason(correlation("c", "temporal", ["h"], "", "x-retrohound: { max_events_between: -1 }"))).toBe("bad-x-retrohound");
    expect(reason(correlation("c", "temporal", ["h"], "", "x-retrohound: { max_events_between: 1.5 }"))).toBe("bad-x-retrohound");
    expect(reason(correlation("c", "temporal", ["h"], "", "x-retrohound: { max_event_between: 5 }"))).toBe("bad-x-retrohound");
  });
  test("mixed and malformed documents", () => {
    expect(reason(`logsource: { product: ai_coding_agent }\n${good}`)).toBe("mixed-document");
    expect(reason("title: c\ncorrelation: nope\n")).toBe("bad-correlation");
  });
});

describe("session scope: group-by without agent_id spans streams, ordered by ts", () => {
  const session = (doc: string) => doc.replace("[session_id, agent_id]", "[session_id]");
  const scoped = () => star2("", "x-retrohound: { lane: hunt }").map(session);
  const matches = (events: RawEvent[]) => run(scoped(), events).filter((m) => m.rule.name === "star2");

  test("a main-agent read and a sub-agent egress fire", () => {
    const m = matches([read(1), send(2, { agent_id: "child" })]);
    expect(m.length).toBe(1);
    expect(m[0]!.events.map((e) => e.agent_id)).toEqual([undefined, "child"]);
  });
  test("the same pair does not fire with agent_id in group-by", () => {
    expect(star2Matches([read(1), send(2, { agent_id: "child" })])).toEqual([]);
  });
  test("order is by ts, not seq", () => {
    expect(matches([read(50), send(1, { agent_id: "child", ts: at(10) })])).toEqual([]);
    expect(matches([read(50, { ts: at(10) }), send(1, { agent_id: "child", ts: at(20) })]).length).toBe(1);
  });
  test("sessions stay apart", () => {
    expect(matches([read(1, { session_id: "a" }), send(2, { session_id: "b", agent_id: "c" })])).toEqual([]);
  });
  test("equal ts is ordered by (agent_id, seq), whatever the input order", () => {
    const a = read(1, { ts: at(5), agent_id: "a" });
    const b = send(1, { ts: at(5), agent_id: "b" });
    const c = read(1, { ts: at(5), agent_id: "c" });
    expect(matches([b, a]).length).toBe(1); // a sorts before b
    expect(matches([a, b]).length).toBe(1);
    expect(matches([c, b])).toEqual([]); // c sorts after b
  });
  test("timespan still applies", () => {
    expect(matches([read(1), send(2000, { agent_id: "child" })])).toEqual([]);
  });
  test("max_events_between is rejected without agent_id in group-by", () => {
    const doc = correlation("c", "temporal_ordered", ["h"], "", "x-retrohound: { max_events_between: 5 }");
    expect(reason(session(doc))).toBe("max-events-needs-agent-id");
  });
  test("event_count over a session still yields one finding", () => {
    const docs = [base("h", "{ command_line: hit }"), session(correlation("n", "event_count", ["h"], "condition: { gte: 2 }"))];
    const m = run(docs, [hit(1), hit(2, { agent_id: "a" }), hit(3, { agent_id: "b" })]).filter((x) => x.rule.name === "n");
    expect(m.length).toBe(1);
    expect(m[0]!.events.length).toBe(3);
  });
});

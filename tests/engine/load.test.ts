import { describe, expect, test } from "bun:test";
import { CATEGORIES } from "../../src/normalize/types.ts";
import { evaluate } from "../../src/engine/evaluate.ts";
import { compile, event, fires, load, reason, ruleYaml } from "./helpers.ts";

const SEL = "selection: { command_line: x }\ncondition: selection";
const valid = (title = "Good") => `title: ${title}\nlogsource: { product: ai_coding_agent }\ndetection:\n    selection: { command_line: x }\n    condition: selection\n`;

describe("rule metadata", () => {
  test("reads the Sigma fields and x-retrohound", () => {
    const rule = compile(`title: Read Of Credential File
id: 00000000-0000-4000-8000-000000000001
name: aca_secret_file_read
status: experimental
description: A coding agent read a file that commonly holds credentials.
level: high
tags: [attack.credential_access, owasp_agentic.t1]
falsepositives: [debugging]
x-retrohound: { lane: enforce }
logsource: { product: ai_coding_agent, service: claude_code, category: file_access }
detection:
    selection: { target_path|endswith: /.env }
    condition: selection
`);
    expect(rule).toMatchObject({
      kind: "detection", id: "00000000-0000-4000-8000-000000000001", name: "aca_secret_file_read", title: "Read Of Credential File",
      status: "experimental", level: "high", lane: "enforce", tags: ["attack.credential_access", "owasp_agentic.t1"],
      falsepositives: ["debugging"], category: "file_access", service: "claude_code", path: "rule0.yml", silenced: false,
    });
    expect(rule.kind === "detection" && rule.fields).toEqual(["target_path"]);
  });
  test("defaults: hunt lane, medium level, id falls back to name then title", () => {
    expect(compile(valid())).toMatchObject({ lane: "hunt", level: "medium", id: "Good", tags: [], falsepositives: [] });
    expect(compile(`name: n1\n${valid()}`).id).toBe("n1");
  });
  test("fields lists canonical names, through aliases and fieldref", () => {
    const rule = compile(ruleYaml(`selection:\n    CommandLine: x\n    target_path|fieldref: project_path\ncondition: selection`));
    expect(rule.kind === "detection" && rule.fields).toEqual(["command_line", "target_path", "project_path"]);
  });
});

describe("logsource", () => {
  test.each([...CATEGORIES])("category %s selects only its events", (category) => {
    const rule = compile(ruleYaml(SEL, `product: ai_coding_agent, category: ${category}`));
    const other = CATEGORIES.find((c) => c !== category)!;
    expect(fires(rule, event({ category, command_line: "x" }))).toBe(true);
    expect(fires(rule, event({ category: other, command_line: "x" }))).toBe(false);
  });
  test("no category means every category, also next to categorised rules", () => {
    const { rules } = load(ruleYaml(SEL), ruleYaml(SEL, "product: ai_coding_agent, category: file_access"));
    for (const category of CATEGORIES) expect(evaluate(rules, [event({ category, command_line: "x" })]).length).toBe(category === "file_access" ? 2 : 1);
  });
  test("service selects by agent", () => {
    const rule = compile(ruleYaml(SEL, "product: ai_coding_agent, service: codex"));
    expect(fires(rule, event({ agent: "codex", command_line: "x" }))).toBe(true);
    expect(fires(rule, event({ agent: "claude_code", command_line: "x" }))).toBe(false);
  });
  test("rejections", () => {
    expect(reason(ruleYaml(SEL, "product: windows"))).toBe("unknown-product");
    expect(reason(ruleYaml(SEL, "category: file_event"))).toBe("unknown-product");
    expect(reason(ruleYaml(SEL, "product: ai_coding_agent, category: file_change"))).toBe("unknown-category");
    expect(reason(ruleYaml(SEL, "product: ai_coding_agent, category: network"))).toBe("unknown-category");
    expect(reason(ruleYaml(SEL, "product: ai_coding_agent, service: windows"))).toBe("unknown-service");
    expect(reason(`title: x\ndetection:\n    a: { command_line: x }\n    condition: a\n`)).toBe("missing-logsource");
  });
});

describe("unknown fields are rejected, never silently false", () => {
  const unknown = ["command", "CommandLine2", "commandline", "Image", "constructor", "__proto__", "toString"];
  test.each(unknown)("%s", (field) => {
    const yaml = (key: string) => ruleYaml(`selection: { '${key}': x }\ncondition: selection`);
    // The same rule on a real field loads and can fire; on the unknown field it must not load at all.
    expect(fires(compile(yaml("command_line")), event({ command_line: "x" }))).toBe(true);
    expect(reason(yaml(field))).toBe("unknown-field");
    expect(reason(yaml(`${field}|contains`))).toBe("unknown-field");
  });
  test("under exists and inside a list of maps", () => {
    expect(reason(ruleYaml(`selection: { nope|exists: true }\ncondition: selection`))).toBe("unknown-field");
    expect(reason(ruleYaml(`selection:\n    - command_line: x\n    - nope: y\ncondition: selection`))).toBe("unknown-field");
  });
  test("in an unused selection too", () => {
    expect(reason(ruleYaml(`selection: { command_line: x }\nunused: { nope: y }\ncondition: selection`))).toBe("unknown-field");
  });
  test("field names are case-sensitive", () => {
    expect(reason(ruleYaml(`selection: { Command_Line: x }\ncondition: selection`))).toBe("unknown-field");
  });
});

describe("rejections", () => {
  test("keyword lists", () => {
    expect(reason(ruleYaml(`keywords:\n    - curl\n    - wget\ncondition: keywords`))).toBe("keyword-list");
    expect(reason(ruleYaml(`keywords: curl\ncondition: keywords`))).toBe("keyword-list");
    expect(reason(ruleYaml(`selection:\n    - command_line: x\n    - wget\ncondition: selection`))).toBe("keyword-list");
    expect(reason(ruleYaml(`keywords:\n    '|all': [a, b]\ncondition: keywords`))).toBe("keyword-list");
  });
  test("empty selections", () => {
    expect(reason(ruleYaml(`selection: {}\ncondition: selection`))).toBe("bad-selection");
    expect(reason(ruleYaml(`selection: []\ncondition: selection`))).toBe("bad-selection");
  });
  test("a broken shape of rule", () => {
    expect(reason("- a\n- b\n")).toBe("not-a-rule");
    expect(reason("logsource: { product: ai_coding_agent }\ndetection: { a: { command_line: x }, condition: a }\n")).toBe("missing-title");
    expect(reason("title: x\nlogsource: { product: ai_coding_agent }\n")).toBe("missing-detection");
    expect(reason(ruleYaml(`selection: { command_line: x }`))).toBe("missing-condition");
    expect(reason(ruleYaml(`selection: { command_line: x }\ncondition: 5`))).toBe("missing-condition");
    expect(reason(ruleYaml(`selection: { command_line: x }\ncondition: []`))).toBe("missing-condition");
    expect(reason(ruleYaml(`${SEL}\ntimeframe: 5m`))).toBe("obsolete-timeframe");
  });
  test("other document kinds", () => {
    expect(reason(`action: global\n${valid()}`)).toBe("unsupported-document");
    expect(reason(`title: f\nlogsource: { product: ai_coding_agent }\nfilter: { rules: [a], selection: { url: x }, condition: selection }\n`)).toBe("unsupported-document");
  });
  test("bad metadata", () => {
    expect(reason(`level: severe\n${valid()}`)).toBe("bad-metadata");
    expect(reason(`tags: attack.t1\n${valid()}`)).toBe("bad-metadata");
    expect(reason(`status: 5\n${valid()}`)).toBe("bad-metadata");
  });
  test("x-retrohound is strict: a typo must not change what a rule means", () => {
    expect(reason(`x-retrohound: { lane: nope }\n${valid()}`)).toBe("bad-x-retrohound");
    expect(reason(`x-retrohound: { laen: hunt }\n${valid()}`)).toBe("bad-x-retrohound");
    expect(reason(`x-retrohound: [hunt]\n${valid()}`)).toBe("bad-x-retrohound");
    expect(reason(`x-retrohound: { max_events_between: 20 }\n${valid()}`)).toBe("bad-x-retrohound");
  });
  test("other custom top-level keys are legal Sigma", () => {
    expect(compile(`x-other: 1\n${valid()}`).title).toBe("Good");
  });
  test("YAML errors and duplicate keys", () => {
    expect(reason("title: [unclosed\n")).toBe("yaml-parse");
    expect(reason(`title: a\n${valid()}`)).toBe("yaml-parse");
  });
  test("an alias bomb is an error, not a hang", () => {
    const bomb = `a: &a [x, x]\nb: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]\nc: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]\nd: &d [*c, *c, *c, *c, *c, *c, *c, *c, *c, *c]\n`;
    expect(reason(bomb)).toBe("invalid-rule");
  });
  test("a duplicate id or name", () => {
    const a = `id: same\n${valid("A")}`;
    const b = `id: same\n${valid("B")}`;
    const result = load(a, b);
    expect(result.rules.map((r) => r.title)).toEqual(["A"]);
    expect(result.rejected[0]).toMatchObject({ path: "rule1.yml", reason: "duplicate-id", title: "B" });
    expect(load(`name: n\n${valid("A")}`, `id: n\n${valid("B")}`).rejected[0]!.reason).toBe("duplicate-id");
  });
  test("a rule without id or name does not collide on its title", () => {
    expect(load(valid(), valid()).rules.length).toBe(2);
  });
});

describe("one bad rule does not sink the rest", () => {
  test("multi-document file: reports the document and keeps the others", () => {
    const text = `${valid("First")}---\n${ruleYaml(`selection: { nope: x }\ncondition: selection`, undefined, "name: bad\n")}---\n${valid("Third")}`;
    const { rules, rejected } = load(text);
    expect(rules.map((r) => r.title)).toEqual(["First", "Third"]);
    expect(rejected).toEqual([{ path: "rule0.yml", doc: 1, title: "Test rule", reason: "unknown-field", message: "unknown field 'nope'" }]);
  });
  test("a YAML error in one document", () => {
    const { rules, rejected } = load(`${valid("First")}---\ntitle: [unclosed\n---\n${valid("Third")}`);
    expect(rules.map((r) => r.title)).toContain("First");
    expect(rejected.map((r) => r.reason)).toContain("yaml-parse");
  });
  test("across files", () => {
    const { rules, rejected } = load("title: [unclosed\n", valid());
    expect(rules.length).toBe(1);
    expect(rejected[0]).toMatchObject({ path: "rule0.yml", reason: "yaml-parse" });
  });
  test("empty files and a trailing --- are not rules and not errors", () => {
    expect(load("", "# only a comment\n", `${valid()}---\n`)).toMatchObject({ rules: [{ title: "Good" }], rejected: [] });
  });
  test("CRLF rule files load", () => {
    expect(compile(valid().replaceAll("\n", "\r\n")).title).toBe("Good");
  });
});

describe("evaluate", () => {
  test("does not touch the input and returns the same objects", () => {
    const ev = event({ command_line: "x" });
    const copy = structuredClone(ev);
    const [match] = evaluate([compile(ruleYaml(SEL))], [ev]);
    expect(match!.events[0]).toBe(ev);
    expect(ev).toEqual(copy);
  });
  test("reads any plain object, not only a RawEvent", () => {
    expect(evaluate([compile(ruleYaml(SEL))], [{ command_line: "x" }]).length).toBe(1);
  });
  test("a field cache does not leak between evaluations of a reused object", () => {
    const rule = compile(ruleYaml(SEL));
    const ev = event({ command_line: "x" });
    expect(fires(rule, ev)).toBe(true);
    ev.command_line = "y";
    expect(fires(rule, ev)).toBe(false);
  });
  test("two rules on one field see the same event", () => {
    const { rules } = load(ruleYaml(SEL), ruleYaml(`selection: { command_line|contains: X }\ncondition: selection`));
    expect(evaluate(rules, [event({ command_line: "x" }), event({ command_line: "y" })]).length).toBe(2);
  });
});

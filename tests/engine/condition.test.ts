import { describe, expect, test } from "bun:test";
import { compile, event, fires, reason, ruleYaml } from "./helpers.ts";

// Selections a, b, c read one letter each from command_line, so an event's text says which of them are true.
const SELECTIONS = `sel_a: { command_line|contains: a }
sel_b: { command_line|contains: b }
sel_c: { command_line|contains: c }
_hidden: { command_line|contains: h }`;

function truth(condition: string, command_line: string): boolean {
  return fires(compile(ruleYaml(`${SELECTIONS}\ncondition: ${condition}`)), event({ command_line }));
}

const rejected = (condition: string) => reason(ruleYaml(`${SELECTIONS}\ncondition: "${condition}"`));

describe("condition grammar", () => {
  test("a selection name", () => {
    expect(truth("sel_a", "a")).toBe(true);
    expect(truth("sel_a", "x")).toBe(false);
  });
  test("and", () => {
    expect(truth("sel_a and sel_b", "ab")).toBe(true);
    expect(truth("sel_a and sel_b", "a")).toBe(false);
  });
  test("or", () => {
    expect(truth("sel_a or sel_b", "b")).toBe(true);
    expect(truth("sel_a or sel_b", "x")).toBe(false);
  });
  test("not, also repeated", () => {
    expect(truth("not sel_a", "x")).toBe(true);
    expect(truth("not sel_a", "a")).toBe(false);
    expect(truth("not not sel_a", "a")).toBe(true);
  });
  test("and binds tighter than or", () => {
    expect(truth("sel_a or sel_b and sel_c", "a")).toBe(true);
    expect(truth("sel_a and sel_b or sel_c", "c")).toBe(true);
  });
  test("not binds tighter than and", () => {
    expect(truth("not sel_a and sel_b", "b")).toBe(true);
    expect(truth("not sel_a and sel_b", "x")).toBe(false);
  });
  test("parentheses override precedence", () => {
    expect(truth("(sel_a or sel_b) and sel_c", "a")).toBe(false);
    expect(truth("(sel_a or sel_b) and sel_c", "ac")).toBe(true);
    expect(truth("not (sel_a or sel_b)", "b")).toBe(false);
  });
  test("1 of pattern", () => {
    expect(truth("1 of sel_*", "b")).toBe(true);
    expect(truth("1 of sel_*", "x")).toBe(false);
  });
  test("all of pattern", () => {
    expect(truth("all of sel_*", "abc")).toBe(true);
    expect(truth("all of sel_*", "ab")).toBe(false);
  });
  test("any of is a synonym of 1 of", () => {
    expect(truth("any of sel_*", "b")).toBe(true);
  });
  test("1 of them skips _ ids", () => {
    expect(truth("1 of them", "c")).toBe(true);
    expect(truth("1 of them", "h")).toBe(false);
  });
  test("all of them skips _ ids", () => {
    expect(truth("all of them", "abc")).toBe(true);
  });
  test("a pattern that does not start with _ skips _ ids", () => {
    expect(rejected("1 of *hidden")).toBe("condition-no-selection");
  });
  test("a _ pattern and a direct name still reach them", () => {
    expect(truth("1 of _hid*", "h")).toBe(true);
    expect(truth("_hidden", "h")).toBe(true);
  });
  test("a pattern matches whole names, with * anywhere", () => {
    expect(truth("1 of *_a", "a")).toBe(true);
    expect(truth("1 of s*l_b", "b")).toBe(true);
    expect(truth("1 of *el_*", "c")).toBe(true);
  });
  test("x of composes with the operators", () => {
    expect(truth("1 of sel_* and not sel_c", "ac")).toBe(false);
    expect(truth("not 1 of sel_*", "x")).toBe(true);
    expect(truth("(all of sel_*) or _hidden", "h")).toBe(true);
  });
  test("keywords are whole words", () => {
    const yaml = ruleYaml(`notepad: { command_line: x }\nand-more: { command_line: y }\nor_z: { command_line: z }\ncondition: notepad or and-more or or_z`);
    expect(fires(compile(yaml), event({ command_line: "z" }))).toBe(true);
  });
  test("a selection may be called 1, any or all", () => {
    const yaml = ruleYaml(`1: { command_line: x }\nall: { command_line: y }\ncondition: 1 or all`);
    expect(fires(compile(yaml), event({ command_line: "y" }))).toBe(true);
  });
  test("a condition list is OR", () => {
    const yaml = ruleYaml(`${SELECTIONS}\ncondition:\n    - sel_a\n    - sel_b and sel_c`);
    expect(fires(compile(yaml), event({ command_line: "bc" }))).toBe(true);
    expect(fires(compile(yaml), event({ command_line: "b" }))).toBe(false);
  });
});

describe("selections", () => {
  test("a map is AND", () => {
    const rule = compile(ruleYaml(`selection:\n    tool_name: Bash\n    command_line|contains: curl\ncondition: selection`));
    expect(fires(rule, event({ tool_name: "Bash", command_line: "curl x" }))).toBe(true);
    expect(fires(rule, event({ tool_name: "Read", command_line: "curl x" }))).toBe(false);
  });
  test("a list of maps is OR", () => {
    const rule = compile(ruleYaml(`selection:\n    - tool_name: Bash\n    - command_line|contains: curl\ncondition: selection`));
    expect(fires(rule, event({ tool_name: "Bash" }))).toBe(true);
    expect(fires(rule, event({ command_line: "curl" }))).toBe(true);
    expect(fires(rule, event({ tool_name: "Read" }))).toBe(false);
  });
});

describe("condition rejections", () => {
  test("a pattern that matches no selection", () => {
    expect(rejected("1 of nothing_*")).toBe("condition-no-selection");
    expect(rejected("all of nothing_*")).toBe("condition-no-selection");
  });
  test("them with only _ selections", () => {
    expect(reason(ruleYaml(`_a: { command_line: x }\ncondition: 1 of them`))).toBe("condition-no-selection");
  });
  test("an unknown selection", () => {
    expect(rejected("sel_a and sel_z")).toBe("condition-unknown-selection");
    expect(rejected("toString")).toBe("condition-unknown-selection");
  });
  test("| aggregation names the fix", () => {
    expect(rejected("sel_a | count() by tool_name > 5")).toBe("condition-aggregation");
  });
  test.each([
    "sel_a and", "and sel_a", "sel_a sel_b", "(sel_a", "sel_a)", "()", "not", "1 of", "of them", "them", "sel_*",
    "2 of sel_*", "1 of (sel_a)", "1 of and", "sel_a near sel_b", "sel_a & sel_b", "sel_a AND sel_b",
  ])("bad syntax: %s", (condition) => {
    expect(["condition-syntax", "condition-unknown-selection"]).toContain(rejected(condition));
  });
});

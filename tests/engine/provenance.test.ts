// instruction_named_package (ADR 0017). Defanged: placeholder package names only.
import { describe, expect, test } from "bun:test";
import { evaluate } from "../../src/engine/evaluate.ts";
import { installed } from "../../src/engine/provenance.ts";
import { compile, event, reason, ruleYaml } from "./helpers.ts";

const REQ = "x-retrohound: { requires: [instruction_provenance] }\n";
const rule = compile(ruleYaml("selection: { instruction_named_package: true }\ncondition: selection", "product: ai_coding_agent", REQ));
const fired = (evs: ReturnType<typeof event>[]) => evaluate([rule], evs).map((m) => m.events[0]!.id);
const instr = (content: string, over = {}) => event({ category: "instruction_load", content, ...over });
const run = (command_line: string, over = {}) => event({ category: "process_creation", command_line, ...over });

describe("installed", () => {
  test("names without versions, flags or extras; lower-cased", () => {
    expect(installed("npm install -D Example-Pkg@1.2 @scope/pkg@^2 && pip install -q 'pkg-b[x]==1.0' pkg-c>=2")).toEqual(
      ["example-pkg", "@scope/pkg", "pkg-b", "pkg-c"]);
  });
  test("a bare install and a manifest path name nothing", () => {
    expect(installed("npm install")).toEqual([]);
    expect(installed("pip install -r requirements.txt ./local")).toEqual(["requirements.txt"]); // a file name is a harmless extra
  });
});

describe("instruction_named_package", () => {
  test("fires on the install of a package an earlier instruction named, not on another", () => {
    const evs = [instr("Run `npm install example-pkg`."), run("npm install other-pkg", { id: "other" }), run("npm i example-pkg@3", { id: "hit" })];
    expect(fired(evs)).toEqual(["hit"]);
  });
  test("the link is the name, not the time: an instruction alone, or an unrelated install, never fires", () => {
    expect(fired([instr("Run `npm install example-pkg`."), run("ls")])).toEqual([]);
    expect(fired([instr("Be terse."), run("npm install example-pkg")])).toEqual([]);
  });
  test("an install before the instruction, or in another session, does not fire", () => {
    expect(fired([run("npm install example-pkg"), instr("Run `npm install example-pkg`.")])).toEqual([]);
    expect(fired([instr("Run `npm install example-pkg`.", { session_id: "s2" }), run("npm install example-pkg")])).toEqual([]);
  });
  test("a skill body and the `name` package form name a package", () => {
    const skill = event({ category: "tool_call", tool_name: "Skill", content: "Use the `example-lib` library for dates." });
    expect(fired([skill, run("pip install example-lib", { id: "hit" })])).toEqual(["hit"]);
  });
  test("without instruction text (index or live hook) it stays false, and it never leaks across calls", () => {
    expect(fired([instr(""), run("npm install example-pkg")])).toEqual([]);
    expect(fired([run("npm install example-pkg")])).toEqual([]);
  });
  test("reading it needs requires: [instruction_provenance], and never with lane enforce", () => {
    const sel = "selection: { instruction_named_package: true }\ncondition: selection";
    expect(reason(ruleYaml(sel))).toBe("provenance-not-required");
    expect(reason(ruleYaml(sel, "product: ai_coding_agent", "x-retrohound: { requires: [instruction_provenance], lane: enforce }\n"))).toBe("provenance-enforce");
  });
});

// A long contains/startswith/endswith list compiles to one regex per kind. It must agree with one rule per value
// (a single value never merges), for every kind of text and field.
import { describe, expect, test } from "bun:test";
import type { RawEvent } from "../../src/normalize/types.ts";
import { compile, event, fires, ruleYaml } from "./helpers.ts";

const q = (s: string) => `'${s.replaceAll("'", "''")}'`;
const rule = (key: string, vals: string[]) => compile(ruleYaml(`selection:\n    ${key}: [${vals.map(q).join(", ")}]\ncondition: selection`));

// regex metacharacters, a wildcard (stays on the old path), an empty value, mixed case, non-BMP and a dotted capital I
const VALS = ["A.B", "x*y", "(a|b)", "[z]", "q+", "c\\d", "^s$", "{1}", "Ünï", "İx", "\u{1F600}!", "wild*card", "Ab?"];
const TEXTS = [
  "a.b", "axb", "xx(a|b)xx", "[Z]", "qqq", "c\\d", "^S$", "{1}", "ÜNÏ", "i̇x", "\u{1F600}!", "a\nb", "WILDcard", "abc", "ab?", "", "zzz",
  "İx", "prefix a.b", "a.b suffix",
];

describe("long OR-lists equal one rule per value", () => {
  for (const mod of ["contains", "startswith", "endswith"]) {
    for (const withEmpty of [false, true]) {
      test(`${mod}${withEmpty ? " with an empty value" : ""}`, () => {
        const vals = withEmpty ? [...VALS, ""] : VALS;
        const many = rule(`command_line|${mod}`, vals);
        const singles = vals.map((v) => rule(`command_line|${mod}`, [v]));
        for (const t of TEXTS) {
          const ev = event({ command_line: t });
          expect(fires(many, ev)).toBe(singles.some((r) => fires(r, ev)));
        }
      });
    }
  }
  test("a short list (under the merge size) and exact lists keep working", () => {
    expect(fires(rule("command_line|contains", ["a.b", "zz"]), event({ command_line: "xA.Bx" }))).toBe(true);
    expect(fires(rule("command_line", ["a.b", "zz", "q", "r", "s"]), event({ command_line: "S" }))).toBe(true);
  });
  test("|cased stays case-sensitive", () => {
    const r = rule("command_line|contains|cased", ["Abc", "d", "e", "f", "g"]);
    expect(fires(r, event({ command_line: "xAbcx" }))).toBe(true);
    expect(fires(r, event({ command_line: "xabcx" }))).toBe(false);
  });
  test("missing, null and non-string fields do not match; list fields match any element", () => {
    const r = rule("command_line|contains", ["a", "b", "c", "d", "e"]);
    expect(fires(r, event())).toBe(false);
    expect(fires(r, { ...event(), command_line: null } as unknown as RawEvent)).toBe(false);
    expect(fires(r, { ...event(), command_line: 7 } as unknown as RawEvent)).toBe(false);
    const lr = rule("secret_kinds|contains", ["aws", "gcp", "azure", "ssh", "npm"]);
    expect(fires(lr, event({ secret_kinds: ["x", "NPM_token"] }))).toBe(true);
    expect(fires(lr, event({ secret_kinds: ["x", "y"] }))).toBe(false);
  });
  test("|all still needs every value", () => {
    const r = compile(ruleYaml("selection:\n    command_line|contains|all: ['a', 'b', 'c', 'd']\ncondition: selection"));
    expect(fires(r, event({ command_line: "dcba" }))).toBe(true);
    expect(fires(r, event({ command_line: "dcb" }))).toBe(false);
  });
  test("a huge literal list is not subject to the re size cap", () => {
    const r = rule("command_line|contains", ["needle", "b", "c", "d"]);
    expect(fires(r, event({ command_line: "x".repeat(20000) + "NEEDLE" }))).toBe(true);
  });
});

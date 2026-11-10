// docs/owasp-asi.md must list, per ASI row, exactly the rules carrying that owasp_agentic.asiNN tag.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { loadRuleDir } from "../src/cli/rules.ts";

test("docs/owasp-asi.md lists exactly the rules per ASI tag", () => {
  const doc = new Map<string, string[]>();
  for (const m of readFileSync("docs/owasp-asi.md", "utf8").matchAll(/^\| ASI(\d\d) \|[^|]*\|([^|]*)\|$/gm))
    doc.set(`asi${m[1]}`, [...m[2]!.matchAll(/`([^`]+)`/g)].map((x) => x[1]!).sort());
  const tagged = new Map<string, string[]>();
  for (const r of loadRuleDir("rules/ai_coding_agent").rules)
    for (const t of r.tags) {
      const id = /^owasp_agentic\.(asi\d\d)$/.exec(t)?.[1];
      if (id) tagged.set(id, [...(tagged.get(id) ?? []), r.name!]);
    }
  expect([...doc.keys()].sort()).toEqual(Array.from({ length: 10 }, (_, i) => `asi${String(i + 1).padStart(2, "0")}`));
  for (const [id, names] of doc) expect({ id, rules: names }).toEqual({ id, rules: (tagged.get(id) ?? []).sort() });
  for (const id of tagged.keys()) expect(doc.has(id)).toBe(true);
});

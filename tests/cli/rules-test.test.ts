// `retrohound rules test` over temp rule dirs: a passing set and failing ones.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../src/cli/main.ts";

const base = mkdtempSync(join(tmpdir(), "rh-rt-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const RULE = `title: Hit
name: hit
level: high
logsource: { product: ai_coding_agent, category: process_creation }
detection:
    selection: { command_line|contains: hitcmd }
    condition: selection
`;
const POS = `{"category":"process_creation","command_line":"hitcmd 1"}\n`;
const NEG = `{"category":"process_creation","command_line":"ok"}\n`;

function setup(name: string, files: { pos?: string; neg?: string; rule?: string }) {
  const root = mkdtempSync(join(base, `${name}-`));
  mkdirSync(join(root, "rules"));
  mkdirSync(join(root, "tests", "hit"), { recursive: true });
  writeFileSync(join(root, "rules", "hit.yml"), files.rule ?? RULE);
  if (files.pos !== undefined) writeFileSync(join(root, "tests", "hit", "positive.jsonl"), files.pos);
  if (files.neg !== undefined) writeFileSync(join(root, "tests", "hit", "negative.jsonl"), files.neg);
  return join(root, "rules");
}

async function test_(rules: string, ...extra: string[]) {
  let out = "";
  const io = { out: (s: string) => (out += s), err: () => {}, isTTY: false, env: {} };
  return { code: await main(["rules", "test", rules, ...extra], io), out };
}

describe("rules test", () => {
  test("passing set: exit 0, one ok line (tests dir defaults to <dir>/../tests)", async () => {
    const r = await test_(setup("pass", { pos: POS, neg: NEG }));
    expect(r.code).toBe(0);
    expect(r.out).toContain("ok   hit");
  });

  test("missing negative file, silent positive and a firing negative each fail", async () => {
    let r = await test_(setup("noneg", { pos: POS }));
    expect([r.code, r.out]).toEqual([1, expect.stringContaining("missing")]);
    r = await test_(setup("badpos", { pos: NEG, neg: NEG }));
    expect([r.code, r.out]).toEqual([1, expect.stringContaining("positive line 1 did not fire")]);
    r = await test_(setup("badneg", { pos: POS, neg: POS }));
    expect([r.code, r.out]).toEqual([1, expect.stringContaining("fired on the negative file")]);
  });

  test("a rule with two .* in a re pattern fails; a rejected rule fails", async () => {
    const two = RULE.replace("command_line|contains: hitcmd", "command_line|re: 'a.*b.*c'");
    let r = await test_(setup("re", { pos: `{"category":"process_creation","command_line":"axbxc"}\n`, neg: NEG, rule: two }));
    expect([r.code, r.out]).toEqual([1, expect.stringContaining("more than one")]);
    r = await test_(setup("rej", { pos: POS, neg: NEG, rule: RULE.replace("ai_coding_agent", "nope") }));
    expect(r.code).toBe(1);
    expect(r.out).toContain("rejected");
  });

  test("--tests overrides the tests dir", async () => {
    const rules = setup("flag", {});
    const other = join(base, "other-tests", "hit");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "positive.jsonl"), POS);
    writeFileSync(join(other, "negative.jsonl"), NEG);
    expect((await test_(rules, "--tests", join(base, "other-tests"))).code).toBe(0);
  });
});

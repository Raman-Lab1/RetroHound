import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { discover } from "../../src/collectors/claude-code/discover.ts";

const root = mkdtempSync(join(tmpdir(), "rh-discover-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const WANTED = [
  "projects/-Users-x/aaaa.jsonl",
  "projects/-Users-x/aaaa.jsonl.superseded-1760000000",
  "projects/-Users-x/aaaa.orphaned-1760000000-ab.jsonl",
  "projects/-Users-x/aaaa/subagents/agent-a1.jsonl",
  "projects/-Users-x/agent-legacy.jsonl",
  "projects/C--Users-x-y/bbbb.jsonl",
];
const IGNORED = [
  "projects/-Users-x/aaaa/subagents/agent-a1.meta.json",
  "projects/-Users-x/aaaa/tool-results/out.txt",
  "projects/-Users-x/memory/MEMORY.md",
  "projects/stray.jsonl",
];
for (const f of [...WANTED, ...IGNORED]) {
  mkdirSync(dirname(join(root, f)), { recursive: true });
  writeFileSync(join(root, f), "");
}

describe("discover", () => {
  const rel = (paths: string[], base: string) => paths.map((p) => p.slice(base.replaceAll("\\", "/").length + 1));

  test("finds every transcript shape, sorted, and nothing else", () => {
    expect(rel(discover(root), root)).toEqual([...WANTED].sort());
  });
  test("accepts the projects dir itself", () => {
    expect(discover(join(root, "projects"))).toEqual(discover(root));
  });
  test("slash style of the root does not change the result", () => {
    expect(discover(root.replaceAll("\\", "/"))).toEqual(discover(root));
    expect(discover(`${root}/`)).toEqual(discover(root));
    expect(discover(root).every((p) => !p.includes("\\"))).toBe(true);
  });
  test("a missing root gives an empty list", () => {
    expect(discover(join(root, "nope"))).toEqual([]);
  });
});

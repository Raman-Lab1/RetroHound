import { afterAll, beforeAll, expect, test, setDefaultTimeout } from "bun:test";
// These tests start real processes, which take ~2 s each on slow, security-scanned Windows machines; 5 s is too tight.
setDefaultTimeout(60_000);
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CASES } from "./store-check.ts";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "retrohound-store-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const scratch = (name: string) => {
  const path = join(dir, name);
  mkdirSync(path, { recursive: true });
  return path;
};

test.each(CASES.map(([name, run], i) => [name, run, i] as const))("Bun: %s", async (_name, run, i) => {
  await run(scratch(`bun-${i}`));
});

// Running a .ts file under node needs type stripping on by default: Node >= 22.18. The 22.13 floor is covered by the
// bundle in tests/smoke.test.ts.
const [nodeMajor = 0, nodeMinor = 0] = (spawnSync("node", ["--version"]).stdout?.toString() ?? "").trim().slice(1).split(".").map(Number);
const stripsTypes = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 18);
test.skipIf(!stripsTypes)("Node: every case, in a real node process", () => {
  // Node strips the types itself, so this runs the real store, not a copy. Requires `node` >= 22.18 on PATH.
  const url = pathToFileURL(join(import.meta.dir, "store-check.ts")).href;
  const script = `
    import { mkdirSync } from "node:fs";
    import { join } from "node:path";
    if (process.versions.bun) throw new Error("not node");
    const { CASES } = await import(${JSON.stringify(url)});
    for (const [i, [name, run]] of CASES.entries()) {
      const dir = join(${JSON.stringify(dir)}, "node-" + i);
      mkdirSync(dir, { recursive: true });
      try { await run(dir); } catch (err) { console.error("FAILED: " + name); throw err; }
    }
    console.log("ok " + CASES.length + " on node " + process.versions.node);`;
  const r = spawnSync("node", ["--no-warnings", "--input-type=module", "-e", script], { encoding: "utf8" });
  expect(r.error).toBeUndefined();
  expect(r.stderr).toBe("");
  expect(r.status).toBe(0);
  expect(r.stdout).toStartWith(`ok ${CASES.length} on node `);
});

import { afterAll, beforeAll, expect, test, setDefaultTimeout } from "bun:test";
// These tests start real processes, which take ~2 s each on slow, security-scanned Windows machines; 5 s is too tight.
setDefaultTimeout(60_000);
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { check } from "./sqlite-check.ts";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "retrohound-sqlite-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("adapter on Bun", () => {
  expect(process.versions.bun).toBeString();
  check(join(dir, "bun.db"));
});

// Running a .ts file under node needs type stripping on by default: Node >= 22.18. The 22.13 floor is covered by the
// bundle in tests/smoke.test.ts.
const [nodeMajor = 0, nodeMinor = 0] = (spawnSync("node", ["--version"]).stdout?.toString() ?? "").trim().slice(1).split(".").map(Number);
const stripsTypes = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 18);
test.skipIf(!stripsTypes)("adapter on Node, in a real node process", () => {
  // Node strips the types itself, so this runs the real adapter, not a copy. Requires `node` >= 22.18 on PATH.
  const url = pathToFileURL(join(import.meta.dir, "sqlite-check.ts")).href;
  const script = `
    if (process.versions.bun) throw new Error("not node");
    const { check } = await import(${JSON.stringify(url)});
    check(${JSON.stringify(join(dir, "node.db"))});
    console.log("ok " + process.versions.node);`;
  const r = spawnSync("node", ["--no-warnings", "--input-type=module", "-e", script], { encoding: "utf8" });
  expect(r.error).toBeUndefined();
  expect(r.stderr).toBe("");
  expect(r.status).toBe(0);
  expect(r.stdout).toStartWith("ok ");
});

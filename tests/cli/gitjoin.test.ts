// git-secrets over an index built by a real scan and throwaway local repos. Placeholder keys only.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IO } from "../../src/cli/io.ts";
import { main } from "../../src/cli/main.ts";
import { scanHistory } from "../../src/gitjoin.ts";
import { secretFingerprints } from "../../src/normalize/mask.ts";

const KEY = "AK" + "IA" + "EXAMPLE0".repeat(2); // matches aws_access_key; split so the source never holds it whole
const base = mkdtempSync(join(tmpdir(), "rh-gj-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const db = join(base, "index.db");
const leaky = join(base, "leaky");
const clean = join(base, "clean");

const repo = (dir: string, content: string) => {
  mkdirSync(dir);
  const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { stdio: "ignore" });
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "config.env"), content);
  git("add", ".");
  git("commit", "-q", "-m", "add config");
};
const session = (sid: string, cwd: string) =>
  JSON.stringify({
    type: "assistant", uuid: `u-${sid}`, sessionId: sid, timestamp: "2026-11-07T10:00:00.000Z", cwd,
    message: { content: [{ type: "tool_use", id: `t-${sid}`, name: "Bash", input: { command: `aws configure set aws_access_key_id ${KEY}` } }] },
  }) + "\n";

let out = "";
const io: IO = { out: (s) => (out += s), err: (s) => (out += s), isTTY: false, env: {} };
const run = (...argv: string[]) => ((out = ""), main(argv, io));

beforeAll(async () => {
  repo(leaky, `AWS_ACCESS_KEY_ID=${KEY}\n`);
  repo(clean, "AWS_REGION=us-east-1\n");
  const proj = join(base, "claude", "projects", "p");
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, "aaaa1111.jsonl"), session("aaaa1111", leaky));
  writeFileSync(join(proj, "bbbb2222.jsonl"), session("bbbb2222", clean));
  writeFileSync(join(proj, "cccc3333.jsonl"), session("cccc3333", join(base, "not-a-repo")));
  expect(await run("scan", "--root", join(base, "claude"), "--db", db, "--no-report")).toBe(0);
});

test("a secret the agent saw and that is committed: exit 1, commit and session named, value never printed", async () => {
  expect(await run("git-secrets", "--db", db, "--format", "json")).toBe(1);
  expect(out).not.toContain(KEY);
  const r = JSON.parse(out);
  expect(r.hits).toHaveLength(1);
  expect(r.hits[0]).toMatchObject({ kinds: ["aws_access_key"], file: "config.env", sessions: ["aaaa1111", "bbbb2222", "cccc3333"] });
  expect(r.hits[0].commit).toMatch(/^[0-9a-f]{12}$/);
  expect(r.projects_scanned).toBe(2);
  expect(r.projects_skipped).toEqual([join(base, "not-a-repo")]);
  expect(await run("git-secrets", "--db", db)).toBe(1);
  expect(out).toContain("1 commit(s) hold a secret the agent saw");
  expect(out).not.toContain(KEY);
});

test("a project whose history lacks the secret exits 0; bad input exits 2", async () => {
  expect(await run("git-secrets", "--db", db, "--project", "clean")).toBe(0);
  expect(out).toContain("0 commit(s)");
  expect(await run("git-secrets", "--db", db, "--format", "xml")).toBe(2);
  expect(await run("git-secrets", "--db", join(base, "missing.db"))).toBe(2);
});

test("no git on PATH: every project is skipped, no hang", async () => {
  const path = process.env.PATH;
  process.env.PATH = mkdtempSync(join(base, "empty-path-"));
  try {
    expect(await run("git-secrets", "--db", db, "--format", "json")).toBe(0);
  } finally {
    process.env.PATH = path;
  }
  expect(JSON.parse(out)).toMatchObject({ hits: [], projects_scanned: 0, projects_skipped: [clean, leaky, join(base, "not-a-repo")] });
}, 5000);

test("the repo's own config does not change what git log prints", async () => {
  const dir = join(base, "configured");
  repo(dir, `AWS_ACCESS_KEY_ID=${KEY}\n`);
  for (const [k, v] of [["format.pretty", "oneline"], ["diff.noprefix", "true"], ["log.showSignature", "true"]])
    execFileSync("git", ["-C", dir, "config", k!, v!]);
  const hits: string[][] = [];
  expect(await scanHistory(dir, new Set(secretFingerprints(KEY)), (_fp, commit, file, date) => hits.push([commit, file, date]))).toBe(true);
  expect(hits).toHaveLength(1);
  expect(hits[0]![0]).toMatch(/^[0-9a-f]{12}$/);
  expect(hits[0]![1]).toBe("config.env");
  expect(hits[0]![2]).toMatch(/^\d{4}-\d\d-\d\dT/);
});

test("a submodule's diff.external or textconv never runs, whatever diff.submodule says", async () => {
  const sub = join(base, "sub-src");
  repo(sub, "A=1\n");
  const outer = join(base, "with-sub");
  repo(outer, `AWS_ACCESS_KEY_ID=${KEY}\n`);
  // The submodule's clone gets no user.name/email from repo(), and CI runners have no global identity.
  const id = ["-c", "user.name=Test", "-c", "user.email=test@example.invalid"];
  const git = (dir: string, ...a: string[]) => execFileSync("git", ["-C", dir, "-c", "protocol.file.allow=always", ...id, ...a], { stdio: "ignore" });
  git(outer, "submodule", "add", "-q", sub, "sm");
  git(outer, "commit", "-q", "-m", "add sm");
  const sm = join(outer, "sm");
  writeFileSync(join(sm, ".gitattributes"), "* diff=evil\n");
  writeFileSync(join(sm, "b.txt"), "B=2\n");
  git(sm, "add", ".");
  git(sm, "commit", "-q", "-m", "bump");
  git(outer, "commit", "-q", "-am", "bump sm");
  const marker = join(base, "submodule-marker");
  const script = join(base, "marker.sh");
  writeFileSync(script, `#!/bin/sh\necho ran >> '${marker}'\n`, { mode: 0o755 });
  git(outer, "config", "diff.submodule", "diff");
  git(sm, "config", "diff.external", script);
  git(sm, "config", "diff.evil.textconv", script);
  const files: string[] = [];
  expect(await scanHistory(outer, new Set(secretFingerprints(KEY)), (_fp, _c, file) => files.push(file))).toBe(true);
  expect(files).toEqual(["config.env"]);
  expect(existsSync(marker)).toBe(false);
});

// preflight on a hostile checkout: symlinked parent directories stay inside the repo, and a workspace glob cannot
// hang the expansion. Defanged inputs only (192.0.2.x, example.invalid).
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { collectRepo, globMatch } from "../src/collectors/repo/collect.ts";

const dirs: string[] = [];
const tmp = () => (dirs.push(realpathSync(mkdtempSync(join(tmpdir(), "rh-sec-")))), dirs[dirs.length - 1]!);
afterEach(() => void dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const put = (root: string, files: Record<string, string>) => {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
};
const link = (target: string, path: string) => {
  try {
    symlinkSync(target, path);
    return true;
  } catch {
    return false; // no symlink privilege on this machine
  }
};

test("a symlinked .claude or walk root pointing outside the repo is skipped, not read", () => {
  const outside = tmp();
  put(outside, {
    ".claude/settings.json": JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: "curl -s http://192.0.2.1/x # OUTSIDE" }] }] } }),
    ".claude/agents/a.md": "outside agent",
    "skills/x/SKILL.md": "outside skill",
  });
  const repo = tmp();
  if (!link(join(outside, ".claude"), join(repo, ".claude"))) return;
  const r = collectRepo(repo);
  expect(r.events).toEqual([]);
  expect(r.skipped).toContainEqual({ path: ".claude/settings.json", reason: "symlink outside the directory" });
  expect(r.skipped).toContainEqual({ path: ".claude/agents", reason: "symlink outside the directory" });

  const repo2 = tmp();
  mkdirSync(join(repo2, ".claude"));
  link(join(outside, "skills"), join(repo2, ".claude", "skills"));
  expect(collectRepo(repo2)).toMatchObject({ events: [], skipped: [{ path: ".claude/skills", reason: "symlink outside the directory" }] });
});

test("a symlinked directory that stays inside the repo is still read", () => {
  const repo = tmp();
  put(repo, { "real/.claude/agents/a.md": "inside agent" });
  if (!link(join(repo, "real", ".claude"), join(repo, ".claude"))) return;
  expect(collectRepo(repo).events.map((e) => e.raw_ref.file)).toEqual([".claude/agents/a.md"]);
});

test("globMatch: `*` is the only wildcard, everything else is literal", () => {
  for (const [p, s] of [["*", "x"], ["*", ""], ["pkg-*", "pkg-a"], ["a*b*c", "aXbYc"], ["*.d", "a.b.d"], ["a?b", "a?b"], ["**", "x"]])
    expect(globMatch(p!, s!)).toBe(true);
  for (const [p, s] of [["pkg-*", "pkg"], ["a*b", "ab-"], ["a?b", "axb"], ["a.b", "aXb"], ["", "x"], ["x", ""]])
    expect(globMatch(p!, s!)).toBe(false);
});

test("a backtracking workspace glob against a long directory name finishes at once", () => {
  const repo = tmp();
  const glob = "pkgs/" + "*a".repeat(5) + "*b";
  put(repo, { "package.json": JSON.stringify({ workspaces: [glob] }), [`pkgs/${"a".repeat(120)}/x`]: "" });
  const t = performance.now();
  expect(collectRepo(repo).events.map((e) => e.raw_ref.file)).toEqual(["package.json"]);
  expect(performance.now() - t).toBeLessThan(1000);
});

test("the GitHub Action runs npm outside the checkout, so the reviewed repo's .npmrc is never read", () => {
  const action = parse(readFileSync(join(import.meta.dir, "..", "action.yml"), "utf8")) as { runs: { steps: { run?: string }[] } };
  const run = action.runs.steps.find((s) => s.run)!.run!;
  const ws = tmp(), temp = tmp(), bin = tmp();
  put(ws, { ".npmrc": "node-options=--require=./x.cjs\nregistry=http://192.0.2.1/\n" });
  const log = join(temp, "calls.log");
  for (const name of ["npm", "npx", "node"]) writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $PWD $*" >> '${log}'\n`, { mode: 0o755 });
  writeFileSync(join(temp, "step.sh"), run);
  const env = { PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: temp, GITHUB_OUTPUT: join(temp, "out"), RH_COMMAND: "preflight", RH_FAIL_ON: "high", RH_ARGS: ".", RH_OUTPUT: "" };
  expect(spawnSync("bash", [join(temp, "step.sh")], { cwd: ws, env }).status).toBe(0);
  const calls = readFileSync(log, "utf8").trim().split("\n");
  expect(calls).toHaveLength(2);
  expect(calls[0]).toStartWith(`npm ${temp} install --prefix ${temp}/retrohound `);
  expect(calls[1]).toBe(`node ${ws} ${temp}/retrohound/node_modules/retrohound/dist/cli.mjs preflight --fail-on high .`);
});

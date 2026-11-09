// --extra-rules: a user's own rule pack on top of the shipped rules. Temp dirs only; defanged data (example.invalid).
import { afterAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hookRun } from "../../src/cli/hook.ts";
import type { IO } from "../../src/cli/io.ts";
import { main } from "../../src/cli/main.ts";
import { checkPaths, install, realSafetyEnv, status, type SafetyEnv } from "../../src/hooks/install.ts";
import { loadEnforceRules, runHook } from "../../src/hooks/run.ts";

setDefaultTimeout(60_000);
const base = mkdtempSync(join(tmpdir(), "rh-extra-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const rule = (name: string, match: string, extra = "") => `title: ${name} rule
name: ${name}
author: Pack Author
level: high
tags: [attack.t1552.001]
logsource: { product: ai_coding_agent }
detection:
    selection: { command_line|contains: ${match} }
    condition: selection
${extra}`;
const ENFORCE = "x-retrohound: { lane: enforce }\n";
const put = (path: string, text: string) => (mkdirSync(dirname(path), { recursive: true }), writeFileSync(path, text));
const cmd = (command: string) => ({ tool_name: "Bash", tool_input: { command } });
const pay = (command: string) => JSON.stringify({ session_id: "s1", cwd: "/home/x/acme", hook_event_name: "PreToolUse", tool_use_id: "toolu_1", ...cmd(command) });

let dir: string, mainDir: string, pack: string, out: string, err: string, io: IO;
const run = (...argv: string[]) => main(argv, io);
const scanArgs = () => ["scan", "--root", join(dir, "claude"), "--no-index", "--format", "json", "--rules", mainDir];

beforeEach(() => {
  dir = mkdtempSync(join(base, "case-"));
  out = err = "";
  io = { out: (s) => (out += s), err: (s) => (err += s), isTTY: false, env: {} };
  mainDir = join(dir, "rules");
  pack = join(dir, "pack", "rules");
  put(join(mainDir, "hit.yml"), rule("hit", "hitcmd"));
  put(join(pack, "pack.yml"), rule("pack_hit", "packcmd", ENFORCE));
  put(join(dir, "pack", "tests", "pack_hit", "positive.jsonl"), JSON.stringify({ category: "process_creation", command_line: "packcmd https://example.invalid/x" }) + "\n");
  put(join(dir, "pack", "tests", "pack_hit", "negative.jsonl"), JSON.stringify({ category: "process_creation", command_line: "ls" }) + "\n");
  const line = (n: number, command: string) => ({
    type: "assistant", uuid: `u-${n}`, sessionId: "abcdef123456", timestamp: "2026-11-07T10:00:00.000Z", cwd: "/home/x/acme",
    message: { content: [{ type: "tool_use", id: `t${n}`, name: "Bash", input: { command } }] },
  });
  put(join(dir, "claude", "projects", "-home-x-acme", "abcdef123456.jsonl"), [line(1, "hitcmd"), line(2, "packcmd")].map((l) => JSON.stringify(l)).join("\n") + "\n");
});

describe("scan and rules", () => {
  test("an extra rule fires alongside the main rules, with its own author", async () => {
    expect(await run(...scanArgs(), "--extra-rules", pack)).toBe(0);
    const rep = JSON.parse(out);
    expect(rep.rules.map((r: { name: string }) => r.name).sort()).toEqual(["hit", "pack_hit"]);
    expect(rep.rules.find((r: { name: string }) => r.name === "pack_hit").author).toBe("Pack Author");
  });
  test("without --extra-rules nothing changes", async () => {
    expect(await run(...scanArgs())).toBe(0);
    expect(JSON.parse(out).rules.map((r: { name: string }) => r.name)).toEqual(["hit"]);
  });
  test("rules list and show see the extra rule and its file", async () => {
    expect(await run("rules", "list", "--rules", mainDir, "--extra-rules", pack)).toBe(0);
    expect(out).toContain("2 rules, 0 rejected");
    expect(out).toContain("pack_hit");
    out = "";
    expect(await run("rules", "show", "pack_hit", "--rules", mainDir, "--extra-rules", pack)).toBe(0);
    expect(out).toContain(`file: ${join(pack, "pack.yml")}`);
  });
  test("rules test runs the extra rule's tests from next to its own dir", async () => {
    const empty = join(dir, "none");
    mkdirSync(empty);
    expect(await run("rules", "test", empty, "--extra-rules", pack)).toBe(0);
    expect(out).toContain("ok   pack_hit");
    expect(out).toContain("1/1 rules pass");
  });
  test("an id or name reused across dirs is a usage error naming both files", async () => {
    put(join(pack, "dup.yml"), rule("hit", "other"));
    expect(await run(...scanArgs(), "--extra-rules", pack)).toBe(2);
    expect(err).toContain(join(pack, "dup.yml"));
    expect(err).toContain(join(mainDir, "hit.yml"));
  });
  test("a missing extra dir is a usage error (a missing main dir stays an empty set)", async () => {
    expect(await run(...scanArgs(), "--extra-rules", join(dir, "nope"))).toBe(2);
    expect(err).toContain("not a directory");
    expect(await run("rules", "list", "--rules", join(dir, "nope2"))).toBe(0);
  });
});

describe("hook", () => {
  const hio = () => {
    const o: string[] = [], e: string[] = [];
    return { o, e, io: { out: (s: string) => o.push(s), err: (s: string) => e.push(s), isTTY: false, env: {} } as IO };
  };
  const decision = (s: string[]) => JSON.parse(s.join("")).hookSpecificOutput;

  test("hook run denies on an extra enforce rule; a missing extra dir is reported and the rest still decides", async () => {
    const t = hio();
    const f = { mode: "block", rules: mainDir, extraRules: [join(dir, "gone"), pack], cache: join(dir, "c.json"), log: join(dir, "log.jsonl") };
    expect(await hookRun(f, t.io, async () => pay("packcmd"))).toBe(0);
    expect(decision(t.o)).toMatchObject({ permissionDecision: "deny", permissionDecisionReason: "RetroHound: pack_hit (T1552.001)" });
    expect(t.e.join("")).toContain("is not a directory; deciding without it");
  });
  test("the parse cache is keyed on the extra dirs' files too", async () => {
    const cp = join(dir, "cache.json");
    const rule1 = () => runHook(pay("packcmd"), "block", loadEnforceRules(mainDir, cp, [pack]), join(dir, "log")).rule;
    await Bun.sleep(1100); // a rule file under a second old is never cached
    expect(rule1()).toBe("pack_hit");
    expect(existsSync(cp)).toBe(true);
    expect(rule1()).toBe("pack_hit"); // warm
    put(join(pack, "pack.yml"), rule("pack_hit", "packcmX", ENFORCE)); // same size
    expect(rule1()).toBeUndefined();
    expect(loadEnforceRules(mainDir, cp).map((r) => r.name)).toEqual([]); // no extras: a different key, no stale extra rule
  });
  test("hook install refuses a missing extra dir before writing", async () => {
    const p = join(dir, "settings.json");
    expect(await run("hook", "install", "--settings", p, "--extra-rules", join(dir, "nope"))).toBe(2);
    expect(existsSync(p)).toBe(false);
  });

  // Simulated filesystem for the path check (as in install.test.ts): path -> [uid, mode, isDir].
  const ME = 1000;
  const world = (over: Record<string, [number, number, boolean?]> = {}): SafetyEnv => {
    const fs: Record<string, [number, number, boolean?]> = {
      "/": [0, 0o755, true], "/opt": [ME, 0o755, true], "/opt/node": [ME, 0o755], "/opt/cli.mjs": [ME, 0o644], "/opt/pack": [ME, 0o755, true], "/work": [ME, 0o755, true], ...over,
    };
    return { platform: "linux", uid: ME, tmp: "/tmp", home: "/home/me", programDirs: [], cwd: "/work", stat: (p) => (fs[p] ? { uid: fs[p][0], mode: fs[p][1], isDir: !!fs[p][2] } : undefined) };
  };
  const opts = (path: string, safety: SafetyEnv, allowUnsafePath = false) =>
    ({ path, mode: "block" as const, command: "/opt/node", entry: "/opt/cli.mjs", extraRules: ["/opt/pack"], safety, allowUnsafePath });

  test("install writes the extra dir into the hook; a world-writable one needs --allow-unsafe-path; status shows it", async () => {
    const p = join(dir, "s.json");
    install(opts(p, world()));
    expect(status(p, [], world())).toMatchObject({ installed: true, extraRules: ["/opt/pack"], unsafe: [] });
    const open = world({ "/opt/pack": [ME, 0o777, true] });
    expect(() => install(opts(join(dir, "s2.json"), open))).toThrow(/\/opt\/pack: group- or world-writable/);
    expect(existsSync(join(dir, "s2.json"))).toBe(false);
    install(opts(join(dir, "s2.json"), open, true));
    expect(status(join(dir, "s2.json"), [], open).unsafe?.[0]?.path).toBe("/opt/pack");
    expect(await run("hook", "status", "--settings", p)).toBe(0);
    expect(out).toContain("extra rules: /opt/pack");
  });
  test("a rule file others can write inside an extra dir is flagged", () => {
    const d = join(dir, "real");
    put(join(d, "a.yml"), rule("x", "y"));
    const env = { ...world({ [d]: [ME, 0o755, true], [join(d, "a.yml")]: [ME, 0o666] }), real: (x: string) => x };
    expect(checkPaths("/opt/node", "/opt/cli.mjs", env, [d]).find((f) => f.path === join(d, "a.yml"))?.reason).toContain("world-writable");
  });
  // A real dir holding a real symlink x.yml; `real` maps the dir to /opt/pack and the link to `target` in the fake world.
  const linked = (target: string, over: Record<string, [number, number, boolean?]>) => {
    const d = join(dir, "linked");
    mkdirSync(d);
    symlinkSync(join(dir, "nowhere.yml"), join(d, "x.yml"));
    const env: SafetyEnv = { ...world(over), tmp: "/nonexistent-tmp", real: (x) => (x === d ? "/opt/pack" : x === join(d, "x.yml") ? target : x) };
    return { path: join(dir, "s.json"), mode: "block" as const, command: "/opt/node", entry: "/opt/cli.mjs", extraRules: [d], safety: env };
  };
  test("a symlinked rule file whose target sits in a world-writable dir is refused unless --allow-unsafe-path", () => {
    const o = linked("/shared/x.yml", { "/shared": [0, 0o777, true], "/shared/x.yml": [ME, 0o644] });
    expect(() => install(o)).toThrow(/\/shared: group- or world-writable/);
    expect(existsSync(o.path)).toBe(false);
    expect(install({ ...o, allowUnsafePath: true }).warnings.join()).toContain("/shared");
    expect(status(o.path, [], o.safety).unsafe?.map((f) => f.path)).toEqual(["/shared"]);
  });
  test("a symlinked rule file whose target sits in a safe user-owned dir is allowed", () => {
    const o = linked("/home/me/rules/x.yml", { "/home": [0, 0o755, true], "/home/me": [ME, 0o755, true], "/home/me/rules": [ME, 0o755, true], "/home/me/rules/x.yml": [ME, 0o644] });
    expect(install(o).status).toBe("installed");
    expect(status(o.path, [], o.safety).unsafe).toEqual([]);
  });
  test("a dangling symlink in an extra dir is refused", () => {
    const o = linked(join(dir, "linked", "x.yml"), {}); // unresolvable: real() hands the path back, stat finds nothing
    expect(() => install(o)).toThrow(/x\.yml: cannot be inspected/);
    expect(existsSync(o.path)).toBe(false);
    const findings = checkPaths("/opt/node", "/opt/cli.mjs", realSafetyEnv(), [join(dir, "linked")]); // real fs, too
    expect(findings.find((f) => f.path.endsWith("x.yml"))?.reason).toBe("cannot be inspected");
  });
});

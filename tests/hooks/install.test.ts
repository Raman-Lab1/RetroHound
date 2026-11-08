// Installer: every test edits a temp settings file; none touches the real ~/.claude.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readdirSync, readFileSync, rmSync, mkdtempSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { registerHook } from "../../src/cli/hook.ts";
import type { IO } from "../../src/cli/io.ts";
import { checkPaths, install, isOurs, settingsPath, status, uninstall, type InstallOpts, type SafetyEnv } from "../../src/hooks/install.ts";

setDefaultTimeout(60_000);
const dir = mkdtempSync(join(tmpdir(), "rh-inst-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
const file = (content?: string) => {
  const p = join(dir, `s${++n}.json`);
  if (content !== undefined) writeFileSync(p, content);
  return p;
};
// Simulated filesystem for the path check: path -> [uid, mode, isDir]. Default: all of /opt owned by uid 1000, mode 755.
type Fake = Record<string, [number, number, boolean?]>;
const ME = 1000;
const world = (over: Fake = {}, extra: Partial<SafetyEnv> = {}): SafetyEnv => {
  const fs: Fake = {
    "/": [0, 0o755, true], "/opt": [ME, 0o755, true], "/opt/retrohound": [ME, 0o755, true], "/opt/node": [ME, 0o755],
    "/opt/retrohound/cli.mjs": [ME, 0o644], "/work": [ME, 0o755, true], "/tmp": [0, 0o1777, true], "/tmp/x": [ME, 0o755, true], "/tmp/x/cli.mjs": [ME, 0o644], ...over,
  };
  return { platform: "linux", uid: ME, tmp: "/tmp", home: "/home/me", programDirs: [], cwd: "/work", stat: (p) => (fs[p] ? { uid: fs[p][0], mode: fs[p][1], isDir: !!fs[p][2] } : undefined), ...extra };
};
const opts = (path: string, extra: Partial<InstallOpts> = {}): InstallOpts => ({ path, mode: "block", command: "/opt/node", entry: "/opt/retrohound/cli.mjs", safety: world(), ...extra });
const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const backups = (p: string) => readdirSync(dir).filter((f) => f.startsWith(`s${p.match(/s(\d+)\.json/)![1]}.json.retrohound-bak-`));

const USER = `{
  "permissions": {"allow": ["Bash(ls)"], "deny": ["Read(./.env)"], "defaultMode": "default"},
  "env": {"A": "1"},
  "hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "other"}]}], "Stop": []},
  "model": "x"
}`;

describe("install", () => {
  test("adds one exec-form handler, timeout in seconds, other keys and hooks untouched", () => {
    const p = file(USER);
    const r = install(opts(p));
    expect(r.status).toBe("installed");
    const s = read(p), o = JSON.parse(USER);
    expect(s.permissions).toEqual(o.permissions);
    expect(s.env).toEqual(o.env);
    expect(s.model).toBe("x");
    expect(s.hooks.Stop).toEqual([]);
    expect(s.hooks.PreToolUse[0]).toEqual(o.hooks.PreToolUse[0]);
    expect(s.hooks.PreToolUse[1]).toEqual({
      matcher: "*", hooks: [{ type: "command", command: "/opt/node", args: ["/opt/retrohound/cli.mjs", "hook", "run", "--mode", "block"], timeout: 5 }],
    });
    expect(JSON.stringify(s.permissions)).toBe(JSON.stringify(o.permissions));
  });
  test("backup holds the original bytes; idempotent re-run makes no new backup or write", () => {
    const p = file(USER);
    const r = install(opts(p));
    expect(readFileSync(r.backup!, "utf8")).toBe(USER);
    if (process.platform !== "win32") expect(statSync(r.backup!).mode & 0o077).toBe(0);
    const before = readFileSync(p, "utf8");
    expect(install(opts(p)).status).toBe("unchanged");
    expect(readFileSync(p, "utf8")).toBe(before);
    expect(backups(p).length).toBe(1);
  });
  test("a different mode updates the same handler in place", () => {
    const p = file(USER);
    install(opts(p));
    expect(install(opts(p, { mode: "confirm" })).status).toBe("updated");
    const h = read(p).hooks.PreToolUse.flatMap((g: any) => g.hooks).filter(isOurs);
    expect(h.length).toBe(1);
    expect(h[0].args.at(-1)).toBe("confirm");
  });
  test("--fail-closed sets onFailure block and warns", () => {
    const p = file("{}");
    const r = install(opts(p, { failClosed: true }));
    expect(read(p).hooks.PreToolUse[0].hooks[0].onFailure).toBe("block");
    expect(r.warnings.join()).toContain("BLOCKS");
  });
  test("creates a missing file; dry-run writes nothing", () => {
    const p = file();
    expect(install(opts(p, { dryRun: true })).diff).toContain("retrohound");
    expect(() => readFileSync(p)).toThrow();
    install(opts(p));
    expect(read(p).hooks.PreToolUse.length).toBe(1);
  });
  test("refuses invalid JSON and leaves it byte for byte", () => {
    const bad = '{ "permissions": { "allow": [], }, // comment\n}';
    const p = file(bad);
    expect(() => install(opts(p))).toThrow(/strict JSON/);
    expect(readFileSync(p, "utf8")).toBe(bad);
    expect(backups(p).length).toBe(0);
  });
  test("verification failure restores the original", () => {
    const p = file(USER);
    const tamper = (path: string) => writeFileSync(path, JSON.stringify({ ...read(path), permissions: { allow: ["*"] } }));
    expect(() => install(opts(p, { afterWrite: tamper }))).toThrow(/permissions.*restored/);
    expect(readFileSync(p, "utf8")).toBe(USER);
  });
});

describe("uninstall and status", () => {
  test("uninstall removes only ours and gives back the pre-install data", () => {
    const p = file(USER);
    install(opts(p));
    expect(status(p, []).installed).toBe(true);
    expect(uninstall(opts(p)).status).toBe("removed");
    expect(read(p)).toEqual(JSON.parse(USER));
    expect(JSON.stringify(read(p).permissions)).toBe(JSON.stringify(JSON.parse(USER).permissions));
    expect(uninstall(opts(p)).status).toBe("absent");
  });
  test("install then uninstall on an empty object leaves {}", () => {
    const p = file("{}");
    install(opts(p));
    uninstall(opts(p));
    expect(read(p)).toEqual({});
  });
  test("uninstall never touches someone else's hook that merely looks similar", () => {
    const other = { hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "node", args: ["x.js", "hook", "run"] }] }] } };
    const p = file(JSON.stringify(other));
    expect(uninstall(opts(p)).status).toBe("absent");
    expect(read(p)).toEqual(other);
  });
  test("status reports mode and allowManagedHooksOnly", () => {
    const p = file(USER);
    install(opts(p, { mode: "confirm" }));
    expect(status(p, [])).toMatchObject({ installed: true, mode: "confirm", managedHooksOnly: false });
    const managed = file(JSON.stringify({ allowManagedHooksOnly: true }));
    expect(status(p, [managed]).managedHooksOnly).toBe(true);
  });
});

describe("path safety", () => {
  const bad = (over: Fake, extra: Partial<SafetyEnv> = {}, o: Partial<InstallOpts> = {}) => checkPaths(o.command ?? "/opt/node", o.entry ?? "/opt/retrohound/cli.mjs", world(over, extra));
  test("owned by us or root, 755/644: safe; stops at the first safe root-owned dir", () => {
    expect(bad({})).toEqual([]);
    expect(bad({ "/opt": [0, 0o755, true], "/": [ME, 0o777, true] })).toEqual([]); // "/" is above the root-owned /opt: not checked
  });
  test("other owner, group-writable and world-writable are each named with the path", () => {
    expect(bad({ "/opt/retrohound/cli.mjs": [2000, 0o644] })[0]).toMatchObject({ path: "/opt/retrohound/cli.mjs", reason: expect.stringContaining("owned by uid 2000") });
    expect(bad({ "/opt/node": [ME, 0o775] })[0]!.reason).toContain("group- or world-writable");
    expect(bad({ "/opt/retrohound": [ME, 0o777, true] })[0]!.path).toBe("/opt/retrohound");
  });
  test("a parent dir that is writable by others is found above the file", () => {
    expect(bad({ "/opt": [ME, 0o775, true] }).map((f) => f.path)).toEqual(["/opt", "/opt"]); // once per file (runtime and entry)
  });
  test("sticky world-writable dir is accepted, but not owned by someone else", () => {
    expect(bad({ "/opt": [ME, 0o1777, true] })).toEqual([]);
    expect(bad({ "/opt": [2000, 0o1777, true] })[0]!.reason).toContain("owned by uid 2000");
  });
  test("entry in the temp dir, a missing file and a world-writable cwd are refused", () => {
    expect(checkPaths("/opt/node", "/tmp/x/cli.mjs", world())[0]!.reason).toContain("temp directory");
    expect(bad({}, {}, { entry: "/opt/nope.mjs" })[0]!.reason).toContain("does not exist");
    expect(bad({ "/work": [ME, 0o777, true] })[0]!.reason).toContain("world-writable");
  });
  test("Windows: profile and Program Files pass, temp and elsewhere do not (only that is checked)", () => {
    const f = { "C:\\Users\\me\\a\\bun.exe": [0, 0], "C:\\Users\\me\\a\\cli.mjs": [0, 0], "C:\\Users\\me\\AppData\\Local\\Temp\\x\\cli.mjs": [0, 0], "D:\\tools\\cli.mjs": [0, 0], "C:\\Program Files\\nodejs\\node.exe": [0, 0] } as Fake;
    const win = { platform: "win32" as const, uid: undefined, home: "C:\\USERS\\ME", tmp: "C:\\Users\\me\\AppData\\Local\\Temp", programDirs: ["C:\\Program Files"] };
    const run = (cmd: string, entry: string) => checkPaths(cmd, entry, world(f, win));
    expect(run("C:\\Program Files\\nodejs\\node.exe", "C:\\Users\\me\\a\\cli.mjs")).toEqual([]); // case-insensitive vs home
    expect(run("C:\\Users\\me\\a\\bun.exe", "C:\\Users\\me\\AppData\\Local\\Temp\\x\\cli.mjs")[0]!.reason).toContain("temp directory");
    expect(run("C:\\Users\\me\\a\\bun.exe", "D:\\tools\\cli.mjs")[0]!.reason).toContain("profile or a Program Files");
  });
  test("install refuses with nothing written; --allow-unsafe-path warns and status records it and keeps checking", () => {
    const p = file(USER);
    const unsafe = world({ "/opt/retrohound/cli.mjs": [ME, 0o666] });
    expect(() => install(opts(p, { safety: unsafe }))).toThrow(/cli\.mjs.*group- or world-writable/);
    expect(readFileSync(p, "utf8")).toBe(USER);
    expect(backups(p).length).toBe(0);
    const r = install(opts(p, { safety: unsafe, allowUnsafePath: true }));
    expect(r.warnings.join()).toContain("--allow-unsafe-path");
    const s = status(p, [], unsafe);
    expect(s).toMatchObject({ installed: true, allowUnsafePath: true });
    expect(s.unsafe?.length).toBe(1);
  });
  test("status shows a later chmod", () => {
    const p = file("{}");
    install(opts(p));
    expect(status(p, [], world()).unsafe).toEqual([]);
    expect(status(p, [], world({ "/opt/node": [ME, 0o777] })).unsafe?.[0]?.path).toBe("/opt/node");
  });
  test("real filesystem under a temp dir: the temp-dir rule refuses", () => {
    const entry = join(dir, "cli.mjs");
    writeFileSync(entry, "");
    expect(() => install({ path: file(), mode: "log", command: process.execPath, entry })).toThrow(/temp directory/);
  });
});

test("CLI: install/status/uninstall against --settings only", async () => {
  const p = file(USER);
  const out: string[] = [];
  const io = { out: (s: string) => out.push(s), err: () => {}, isTTY: false, env: {} } as IO;
  // --allow-unsafe-path: the runner's own bun/entry paths vary by machine and CI image
  for (const argv of [["install", "--mode", "block", "--allow-unsafe-path", "--settings", p], ["status", "--settings", p], ["uninstall", "--settings", p]]) {
    const prog = new Command().exitOverride();
    registerHook(prog, async (fn) => void (await fn()), io);
    await prog.parseAsync(["hook", ...argv], { from: "user" });
  }
  const text = out.join("");
  expect(text).toContain("installed (mode block)");
  expect(text).toContain("removed");
  expect(read(p)).toEqual(JSON.parse(USER));
});

describe("--agent codex and antigravity (JSON hook files, command-string handlers)", () => {
  const CODEX = `{"description": "mine", "hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "python3 ~/.codex/hooks/p.py", "timeout": 30}]}], "Stop": []}}`;
  const AGY = `{"safety-gate": {"enabled": false, "PreToolUse": [{"matcher": "run_command", "hooks": [{"command": "./scripts/safety-check.sh"}]}]}, "hooks": {"x": 1}}`;
  const cmd = (agent: string, mode = "block") => `/opt/node /opt/retrohound/cli.mjs hook run --agent ${agent} --mode ${mode}`;

  test("codex: one command-string handler under hooks.PreToolUse; status; uninstall gives back the same data", () => {
    const p = file(CODEX);
    expect(install(opts(p, { agent: "codex" })).status).toBe("installed");
    const s = read(p);
    expect(s.description).toBe("mine");
    expect(s.hooks.PreToolUse[0]).toEqual(JSON.parse(CODEX).hooks.PreToolUse[0]);
    expect(s.hooks.PreToolUse[1]).toEqual({ matcher: "*", hooks: [{ type: "command", command: cmd("codex"), timeout: 5 }] });
    expect(isOurs(s.hooks.PreToolUse[1].hooks[0])).toBe(true);
    expect(isOurs(s.hooks.PreToolUse[0].hooks[0])).toBe(false);
    expect(install(opts(p, { agent: "codex" })).status).toBe("unchanged");
    expect(install(opts(p, { agent: "codex", mode: "log" })).status).toBe("updated");
    expect(status(p, [], world(), "codex")).toMatchObject({ installed: true, mode: "log", managedHooksOnly: false, unsafe: [] });
    expect(uninstall(opts(p, { agent: "codex" })).status).toBe("removed");
    expect(read(p)).toEqual(JSON.parse(CODEX));
  });
  test("codex: confirm and --fail-closed are refused, a path that needs quoting too; nothing written", () => {
    const p = file(CODEX);
    expect(() => install(opts(p, { agent: "codex", mode: "confirm" }))).toThrow(/does not support ask/);
    expect(() => install(opts(p, { agent: "codex", failClosed: true }))).toThrow(/fail-closed/);
    const spaced = world({ "/opt/my dir": [ME, 0o755, true], "/opt/my dir/cli.mjs": [ME, 0o644] });
    expect(() => install(opts(p, { agent: "codex", entry: "/opt/my dir/cli.mjs", safety: spaced }))).toThrow(/shell quoting/);
    expect(() => install(opts(p, { agent: "codex", entry: "/opt/retrohound/cli.mjs;x" }))).toThrow();
    expect(readFileSync(p, "utf8")).toBe(CODEX);
    expect(backups(p)).toEqual([]);
  });
  test("antigravity: our own top-level `retrohound` group; other groups untouched; confirm allowed; uninstall restores", () => {
    const p = file(AGY);
    expect(install(opts(p, { agent: "antigravity", mode: "confirm" })).status).toBe("installed");
    const s = read(p), o = JSON.parse(AGY);
    expect(s["safety-gate"]).toEqual(o["safety-gate"]);
    expect(s.hooks).toEqual(o.hooks);
    expect(s.retrohound).toEqual({ PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: cmd("antigravity", "confirm"), timeout: 5 }] }] });
    expect(status(p, [], world(), "antigravity")).toMatchObject({ installed: true, mode: "confirm" });
    expect(status(p, [], world(), "codex").installed).toBe(false); // the codex root is `hooks`, which holds nothing of ours
    expect(uninstall(opts(p, { agent: "antigravity" })).status).toBe("removed");
    expect(read(p)).toEqual(o);
  });
  test("antigravity: a change to another hook group after the write is caught and the original restored", () => {
    const p = file(AGY);
    const tamper = (q: string) => writeFileSync(q, JSON.stringify({ ...read(q), "safety-gate": { enabled: true } }));
    expect(() => install(opts(p, { agent: "antigravity", afterWrite: tamper }))).toThrow(/key 'safety-gate' changed; original restored/);
    expect(readFileSync(p, "utf8")).toBe(AGY);
  });
  test("default paths per agent; no local scope outside Claude Code", () => {
    const norm = (s: string) => s.replace(/\\/g, "/");
    expect(norm(settingsPath("user", "/w", {}, "codex"))).toEndWith("/.codex/hooks.json");
    expect(norm(settingsPath("project", "/w", {}, "codex"))).toBe("/w/.codex/hooks.json");
    expect(norm(settingsPath("user", "/w", {}, "antigravity"))).toEndWith("/.gemini/config/hooks.json");
    expect(norm(settingsPath("project", "/w", {}, "antigravity"))).toBe("/w/.agents/hooks.json");
    expect(() => settingsPath("local", "/w", {}, "codex")).toThrow(/no local scope/);
  });
  test("CLI: --agent antigravity install/status/uninstall against --settings only", async () => {
    const p = file(AGY);
    const out: string[] = [];
    const io = { out: (s: string) => out.push(s), err: () => {}, isTTY: false, env: {} } as IO;
    for (const argv of [["install", "--agent", "antigravity", "--mode", "block", "--allow-unsafe-path", "--settings", p], ["status", "--agent", "antigravity", "--settings", p],
      ["uninstall", "--agent", "antigravity", "--settings", p]]) {
      const prog = new Command().exitOverride();
      registerHook(prog, async (fn) => void (await fn()), io);
      await prog.parseAsync(["hook", ...argv], { from: "user" });
    }
    const text = out.join("");
    expect(text).toContain("Antigravity CLI");
    expect(text).toContain("installed (mode block)");
    expect(text).toContain("removed");
    expect(read(p)).toEqual(JSON.parse(AGY));
  });
});

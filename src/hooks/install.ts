// `hook install|uninstall|status` (ADR 0009, R3 install algorithm). Writing a settings file is code execution, so:
// strict JSON or abort, touch only our marked handler, back up, re-check the hash, write atomically, verify that every
// other key (permissions byte for byte) is unchanged, else restore. Formatting: a changed file is rewritten with
// 2-space indent; a no-op never rewrites. Uninstall drops groups/arrays/`hooks` that become empty, so install then
// uninstall of a file that had no hooks gives back the same data (a file that did not exist ends up as `{}`).
// Codex (~/.codex/hooks.json) and Antigravity CLI (~/.gemini/config/hooks.json) files are JSON too: same algorithm.
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, existsSync, fsyncSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeSync, chmodSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Agent } from "./agents.ts";
import type { Mode } from "./run.ts";

export type Scope = "user" | "project" | "local";
// Codex and Antigravity hook handlers take one shell command string; no args array is documented for either.
export type Handler = { type: "command"; command: string; args?: string[]; timeout: number; onFailure?: "block" };
type Json = Record<string, any>;
export type InstallOpts = {
  path: string; mode: Mode; command: string; entry: string; failClosed?: boolean; dryRun?: boolean; agent?: Agent;
  extraRules?: string[]; // absolute dirs, passed to `hook run --extra-rules`; path-checked like the entry
  allowUnsafePath?: boolean; safety?: SafetyEnv; // safety: test seam for the path check
  now?: Date; afterWrite?: (path: string) => void; // afterWrite: test seam, runs between write and verify
};

// --- Path safety (ADR 0009): the handler runs `command entry ...` on every tool call, so whoever can replace either
// file, or a directory above it, gets code execution in every session. Checked before install writes anything.
export type FsInfo = { uid: number; mode: number; isDir: boolean };
export type SafetyEnv = {
  platform: NodeJS.Platform; uid?: number; stat: (p: string) => FsInfo | undefined; real?: (p: string) => string;
  tmp: string; home: string; programDirs: string[]; cwd: string;
};
export type Finding = { path: string; reason: string };
export class UnsafePathError extends Error {}
const UNSAFE_FLAG = "--allow-unsafe-path";
const EXTRA_FLAG = "--extra-rules";

const realpath = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};
export const realSafetyEnv = (): SafetyEnv => ({
  platform: process.platform, uid: process.getuid?.(), real: realpath, tmp: realpath(tmpdir()), home: realpath(homedir()), cwd: process.cwd(),
  programDirs: [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.ProgramW6432].filter((d): d is string => !!d),
  stat: (p) => {
    try {
      const s = statSync(p);
      return { uid: s.uid, mode: s.mode, isDir: s.isDirectory() };
    } catch {
      return undefined;
    }
  },
});

const writable = (s: FsInfo) => (s.mode & 0o022) !== 0 && !(s.isDir && (s.mode & 0o1000) !== 0); // sticky dir: others cannot rename our entries
const why = (s: FsInfo, uid?: number): string | undefined =>
  s.uid !== uid && s.uid !== 0 ? `owned by uid ${s.uid}, not by you (uid ${uid}) or root`
  : writable(s) ? `group- or world-writable (mode ${(s.mode & 0o7777).toString(8)})` : undefined;

/** POSIX: the path and every parent up to the first safe root-owned directory (that one included) must be ours or root's and not group/world-writable. */
function posixProblems(p: string, env: SafetyEnv): Finding[] {
  const out: Finding[] = [];
  for (let cur = (env.real ?? ((x) => x))(p); ; ) {
    const s = env.stat(cur);
    const bad = s ? why(s, env.uid) : "cannot be inspected";
    if (bad) out.push({ path: cur, reason: bad });
    const up = dirname(cur);
    if (up === cur || !s || (!bad && s.isDir && s.uid === 0)) return out;
    cur = up;
  }
}

const norm = (p: string, plat: NodeJS.Platform) => (plat === "win32" ? p.replace(/\\/g, "/").toLowerCase() : p).replace(/\/+$/, "");
const under = (p: string, dir: string, plat: NodeJS.Platform) => { const a = norm(p, plat), b = norm(dir, plat); return a === b || a.startsWith(b + "/"); };

/**
 * Empty = safe. Windows: fs mode bits do not express ACLs, so only "exists, not under the temp dir, under the user profile
 * or a Program Files dir" is checked; NOT checked: owner, ACLs, whether Users/Everyone can write the file or its parents.
 */
export function checkPaths(command: string, entry: string, env: SafetyEnv = realSafetyEnv(), ruleDirs: string[] = []): Finding[] {
  const out: Finding[] = [];
  const win = env.platform === "win32";
  for (const p of [command, entry, ...ruleDirs]) {
    const r = (env.real ?? ((x) => x))(p);
    if (!env.stat(r)) out.push({ path: p, reason: "does not exist or cannot be inspected" });
    else if (under(r, env.tmp, env.platform)) out.push({ path: r, reason: `is inside the temp directory (${env.tmp}), which other users or processes can write` });
    else if (!win) out.push(...posixProblems(p, env));
    else if (![env.home, ...env.programDirs].some((d) => under(r, d, "win32"))) out.push({ path: r, reason: "is not under your user profile or a Program Files directory" });
  }
  // An extra rules dir: a file or subdir others can write lets them add or change a blocking rule.
  if (!win) for (const d of ruleDirs) for (const n of entries(d)) {
    const s = env.stat(join(d, n));
    const bad = s && why(s, env.uid);
    if (bad) out.push({ path: join(d, n), reason: bad });
  }
  const cwd = env.stat(env.cwd);
  if (!win && cwd && (cwd.mode & 0o002) !== 0 && (cwd.mode & 0o1000) === 0) out.push({ path: env.cwd, reason: "current directory (the repo checkout) is world-writable" });
  return out;
}

const entries = (d: string): string[] => {
  try {
    return readdirSync(d, { recursive: true }) as string[];
  } catch {
    return []; // the dir itself is reported above
  }
};

const describe = (f: Finding[]) => f.map((x) => `${x.path}: ${x.reason}`).join("; ");
export type Outcome = { status: "installed" | "updated" | "unchanged" | "removed" | "absent"; path: string; backup?: string; warnings: string[]; diff: string };

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function settingsPath(scope: Scope, cwd = process.cwd(), env = process.env, agent: Agent = "claude_code"): string {
  // Codex: learn.chatgpt.com/docs/hooks. Antigravity CLI: antigravity.google/docs/hooks. Neither has a `local` file.
  if (agent !== "claude_code" && scope === "local") throw new Error(`${agent} has no local scope; use --scope user or project`);
  if (agent === "codex") return scope === "user" ? join(homedir(), ".codex", "hooks.json") : join(cwd, ".codex", "hooks.json");
  if (agent === "antigravity") return scope === "user" ? join(homedir(), ".gemini", "config", "hooks.json") : join(cwd, ".agents", "hooks.json");
  if (scope === "user") return join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "settings.json");
  return join(cwd, ".claude", scope === "project" ? "settings.json" : "settings.local.json");
}

/** Where the PreToolUse groups live: Claude/Codex `hooks`; Antigravity's file is named groups, ours is `retrohound`. */
const rootOf = (agent: Agent = "claude_code") => (agent === "antigravity" ? "retrohound" : "hooks");

/** Exec form as is; a command string (which we write unquoted) split on whitespace. */
function partsOf(h: any): { command: string; args: string[] } | undefined {
  if (Array.isArray(h.args)) return typeof h.command === "string" ? { command: h.command, args: h.args } : undefined;
  if (h.args !== undefined || typeof h.command !== "string") return undefined;
  const [command = "", ...args] = h.command.trim().split(/\s+/);
  return { command, args };
}

/** The marker: args hold `hook run` right after a retrohound entry (command or first arg), exec form or command string. */
export function isOurs(h: any): boolean {
  const p = h && h.type === "command" ? partsOf(h) : undefined;
  if (!p) return false;
  const i = p.args.findIndex((a: unknown, k: number) => a === "hook" && p.args[k + 1] === "run");
  const owner = i > 0 ? p.args[i - 1] : i === 0 ? p.command : "";
  return typeof owner === "string" && /retrohound|(^|[\\/])(cli\.mjs|bin\.ts|entry\.ts)$/i.test(owner);
}

// Codex runs the string with `$SHELL -lc` or `cmd.exe /C` (codex-rs hooks command_runner); Antigravity's shell is not
// documented. Paths made of these characters need no quoting in any of them.
const PLAIN = /^[\w.:/\\@+-]+$/;

export function handlerFor(o: Pick<InstallOpts, "mode" | "command" | "entry" | "failClosed" | "allowUnsafePath" | "agent" | "extraRules">): Handler {
  const extra = (o.extraRules ?? []).flatMap((d) => [EXTRA_FLAG, d]);
  const args = [o.entry, "hook", "run", ...(o.agent && o.agent !== "claude_code" ? ["--agent", o.agent] : []), "--mode", o.mode, ...extra, ...(o.allowUnsafePath ? [UNSAFE_FLAG] : [])]; // flag is inert at run time; `status` reads it
  if (!o.agent || o.agent === "claude_code") return { type: "command", command: o.command, args, timeout: 5, ...(o.failClosed ? { onFailure: "block" as const } : {}) };
  if (o.failClosed) throw new Error(`--fail-closed is not available for ${o.agent}: its hook docs define no fail-closed setting`);
  if (o.agent === "codex" && o.mode === "confirm") throw new Error("codex does not support ask (Codex runs the tool when a hook answers ask); use --mode log or block");
  const bad = [o.command, o.entry, ...(o.extraRules ?? [])].filter((p) => !PLAIN.test(p));
  if (bad.length) throw new UnsafePathError(`refusing to install: ${bad.join(", ")} would need shell quoting in a ${o.agent} hook command. Nothing was written. Install from a path without spaces or special characters.`);
  return { type: "command", command: [o.command, ...args].join(" "), timeout: 5 };
}

function readSettings(path: string): { text: string | undefined; obj: Json } {
  if (!existsSync(path)) return { text: undefined, obj: {} };
  const text = readFileSync(path, "utf8");
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    throw new Error(`${path} is not strict JSON (${(e as Error).message}); refusing to touch it`);
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error(`${path} is not a JSON object; refusing to touch it`);
  return { text, obj: obj as Json };
}

function groupsOf(obj: Json, root = "hooks"): any[] {
  const g = obj[root]?.PreToolUse;
  return Array.isArray(g) ? g : [];
}

const oursIn = (obj: Json, root?: string) => groupsOf(obj, root).flatMap((g) => (Array.isArray(g?.hooks) ? g.hooks : [])).filter(isOurs);

function withInstalled(orig: Json, h: Handler, root = "hooks"): Json {
  const obj = structuredClone(orig);
  const found = oursIn(obj, root);
  if (!found.length) {
    obj[root] = { ...obj[root], PreToolUse: [...groupsOf(obj, root), { matcher: "*", hooks: [h] }] };
    return obj;
  }
  const [first, ...extra] = found; // update in place; duplicates of ours are dropped
  for (const k of Object.keys(first)) delete first[k];
  Object.assign(first, h);
  return extra.length ? removeOurs(obj, root, extra) : obj;
}

function removeOurs(obj: Json, root = "hooks", only?: any[]): Json {
  const keep = (x: any) => !(isOurs(x) && (!only || only.includes(x)));
  const groups = groupsOf(obj, root).map((g) => (Array.isArray(g?.hooks) ? { ...g, hooks: g.hooks.filter(keep) } : g)).filter((g) => !Array.isArray(g.hooks) || g.hooks.length);
  if (!obj[root]) return obj;
  if (groups.length) obj[root].PreToolUse = groups;
  else delete obj[root].PreToolUse;
  if (!Object.keys(obj[root]).length) delete obj[root];
  return obj;
}

function atomicWrite(path: string, data: string, mode: number): void {
  const tmp = join(dirname(path), `.${basename(path)}.rh-${process.pid}.tmp`);
  const fd = openSync(tmp, "w", mode);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/** Every non-`hooks` key equal to the original; `permissions` compared as serialized text. */
function verify(path: string, orig: Json, root = "hooks"): void {
  const now = JSON.parse(readFileSync(path, "utf8")) as Json;
  const keys = new Set([...Object.keys(orig), ...Object.keys(now)]);
  for (const k of keys) if (k !== root && !same(orig[k], now[k])) throw new Error(`verification failed: key '${k}' changed`);
  if (JSON.stringify(orig.permissions) !== JSON.stringify(now.permissions)) throw new Error("verification failed: permissions changed");
  if (oursIn(now, root).length > 1) throw new Error("verification failed: more than one RetroHound handler");
}

function change(o: InstallOpts, build: (orig: Json) => Json, countOurs: number): Outcome {
  const path = existsSync(o.path) ? realpathSync(o.path) : o.path;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { text, obj: orig } = readSettings(path);
    const next = build(orig);
    const warnings: string[] = [];
    if (same(next, orig) && text !== undefined) return { status: countOurs ? "unchanged" : "absent", path, warnings, diff: "" };
    const root = rootOf(o.agent);
    const diff = `${root}.PreToolUse: ${JSON.stringify(groupsOf(orig, root))}\n  -> ${JSON.stringify(groupsOf(next, root))}`;
    if (o.dryRun) return { status: countOurs ? "updated" : "installed", path, warnings, diff };
    const mode = text === undefined ? 0o600 : statSync(path).mode & 0o777;
    const stamp = (o.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
    const backup = text === undefined ? undefined : `${path}.retrohound-bak-${stamp}`;
    if (backup) {
      copyFileSync(path, backup);
      chmodSync(backup, 0o600);
    }
    // Claude Code writes settings.local.json itself: if the file moved since we read it, start over.
    if (text === undefined ? existsSync(path) : sha(readFileSync(path)) !== sha(text)) {
      if (backup) rmSync(backup, { force: true });
      continue;
    }
    atomicWrite(path, JSON.stringify(next, null, 2) + "\n", mode);
    try {
      o.afterWrite?.(path);
      verify(path, orig, root);
    } catch (e) {
      if (text === undefined) rmSync(path, { force: true });
      else atomicWrite(path, text, mode);
      throw new Error(`${(e as Error).message}; original restored`);
    }
    return { status: countOurs ? "updated" : "installed", path, backup, warnings, diff };
  }
  throw new Error(`${path} keeps changing; giving up without writing`);
}

export function install(o: InstallOpts): Outcome {
  const h = handlerFor(o);
  const bad = checkPaths(o.command, o.entry, o.safety, o.extraRules);
  if (bad.length && !o.allowUnsafePath) throw new UnsafePathError(`refusing to install, the hook would run files others may be able to modify: ${describe(bad)}. Nothing was written. Fix the permissions or install from a user-owned path; ${UNSAFE_FLAG} overrides this check.`);
  const root = rootOf(o.agent);
  const out = change(o, (orig) => withInstalled(orig, h, root), oursIn(readSettings(o.path).obj, root).length);
  if (bad.length) out.warnings.push(`${UNSAFE_FLAG}: installed despite unsafe paths (${describe(bad)}); \`hook status\` keeps reporting this`);
  if (o.failClosed) out.warnings.push("--fail-closed: if retrohound is missing or crashes, Claude Code BLOCKS every tool call until you run `retrohound hook uninstall`");
  return out;
}

export function uninstall(o: InstallOpts): Outcome {
  if (!existsSync(o.path)) return { status: "absent", path: o.path, warnings: [], diff: "" };
  const root = rootOf(o.agent);
  const had = oursIn(readSettings(o.path).obj, root).length;
  const out = change(o, (orig) => removeOurs(structuredClone(orig), root), had);
  return { ...out, status: had ? "removed" : "absent" };
}

const MANAGED = ["C:\\Program Files\\ClaudeCode\\managed-settings.json", "/Library/Application Support/ClaudeCode/managed-settings.json", "/etc/claude-code/managed-settings.json"];

export type Status = { installed: boolean; mode?: string; failClosed?: boolean; managedHooksOnly: boolean; path: string; allowUnsafePath?: boolean; unsafe?: Finding[]; extraRules?: string[] };

/** `unsafe` re-runs the path check on the paths recorded in the handler, so a later chmod or file swap shows up. */
export function status(path: string, managedPaths: string[] = MANAGED, safety?: SafetyEnv, agent: Agent = "claude_code"): Status {
  const { obj } = readSettings(path);
  const h = oursIn(obj, rootOf(agent))[0];
  const p = h ? partsOf(h)! : undefined;
  const m = p ? p.args.indexOf("--mode") : -1;
  const managedHooksOnly = agent === "claude_code" && [path, ...managedPaths].some((p) => {
    try {
      return existsSync(p) && JSON.parse(readFileSync(p, "utf8")).allowManagedHooksOnly === true;
    } catch {
      return false;
    }
  });
  const extraRules = p?.args.flatMap((a, i) => (a === EXTRA_FLAG && p.args[i + 1] ? [p.args[i + 1]!] : []));
  const unsafe = p ? checkPaths(p.command, (p.args[0] === "hook" ? undefined : p.args[0]) ?? p.command, safety, extraRules) : undefined; // entry is the command itself when args start at `hook`
  return { installed: !!h, mode: m >= 0 ? p!.args[m + 1] : undefined, failClosed: h?.onFailure === "block", managedHooksOnly, path, allowUnsafePath: p?.args.includes(UNSAFE_FLAG), unsafe, extraRules };
}

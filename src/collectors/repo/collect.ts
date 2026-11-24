// Repo agent-surface collector (`preflight`): reads a few known files of a cloned repo as TEXT and maps
// them to the RawEvents the existing rules match. Nothing is executed, imported or fetched, nothing is written, and
// the walk is bounded: fixed locations only, node_modules/.git skipped, a size cap, no symlink out of the directory.
// Workspace package.json files (npm/yarn/bun `workspaces`, pnpm-workspace.yaml `packages`) are read the same way.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { Category, RawEvent } from "../../normalize/types.ts";
import { openCommands } from "./open-commands.ts";

export const MAX_FILE_BYTES = 1_048_576;
export const MAX_PACKAGES = 500; // workspace package.json files per repo
export const MAX_WORKSPACE_DIRS = 5000; // directories a workspace glob (`**`) may list; a deep tree is reported, not walked
export const OVERSIZE_BYTES = 100_000; // an instruction, config or hook-script file past this is a signal (real ones are a few KB); the read cap is MAX_FILE_BYTES
export const OVERSIZE_TOOL = "preflight:oversized"; // marker event for files_oversized_agent_file
export const MAX_FILES = 400; // per directory walk; a bomb of agent files is reported as skipped, not read
export const SESSION_ID = "preflight";
const SKIP_DIRS = new Set(["node_modules", ".git"]);

export type Skipped = { path: string; reason: string };
export type Collected = { events: RawEvent[]; scanned: number; skipped: Skipped[] };

/** file -> category: instruction text is loaded into context; config files are what a write rule would see. */
const FILES: [string, Category][] = [
  ["CLAUDE.md", "instruction_load"], ["AGENTS.md", "instruction_load"], ["GEMINI.md", "instruction_load"], [".cursorrules", "instruction_load"],
  [".claude/settings.json", "file_event"], [".claude/settings.local.json", "file_event"], [".mcp.json", "file_event"],
  [".vscode/tasks.json", "file_event"], [".vscode/settings.json", "file_event"], ["package.json", "file_event"],
  [".gemini/settings.json", "file_event"], [".cursor/mcp.json", "file_event"], [".vscode/mcp.json", "file_event"],
  [".codex/config.toml", "file_event"], [".codex/hooks.json", "file_event"], [".envrc", "file_event"],
  [".devcontainer/devcontainer.json", "file_event"], ["devcontainer.json", "file_event"], [".github/copilot-instructions.md", "instruction_load"],
];
const DIRS: [string, RegExp, Category][] = [
  [".claude/agents", /\.md$/i, "instruction_load"], [".claude/commands", /\.md$/i, "instruction_load"],
  [".claude/skills", /(?:^|\/)SKILL\.md$/i, "instruction_load"], [".cursor/rules", /\.mdc?$/i, "instruction_load"],
  [".github/instructions", /\.instructions\.md$/i, "instruction_load"],
  [".claude/hooks", /^[^/]+$/, "file_event"], [".husky", /^[^/]+$/, "file_event"], // top-level hook files only: husky v9's own shim lives under .husky/_
];
/** Settings files whose `hooks` block is read as `hook:<Event>` commands (Gemini and Codex use Claude's shape). */
const HOOK_FILES = /(?:^|\/)(?:\.claude\/settings(?:\.local)?\.json|\.gemini\/settings\.json|\.codex\/hooks\.json)$/;
const NESTED_NAMES = new Set(["CLAUDE.md", "AGENTS.md"]);
export const MAX_NESTED_DEPTH = 4; // directory levels below the root searched for CLAUDE.md / AGENTS.md
export const MAX_NESTED = 50; // nested instruction files read per repo

export const fwd = (p: string) => p.replaceAll("\\", "/");
export const inside = (root: string, p: string) => p === root || p.startsWith(root + "/");

/** One glob segment against one name, `*` the only wildcard. No regex: the repo writes both sides, and a backtracking
 * regex built from `*a*a*a…b` hangs on a long name; this backtracks only to the last `*`, so at most O(len × len). */
export function globMatch(pat: string, name: string): boolean {
  let p = 0, i = 0, star = -1, from = 0;
  while (i < name.length) {
    if (pat[p] === "*") (star = p++), (from = i);
    else if (p < pat.length && pat[p] === name[i]) p++, i++;
    else if (star >= 0) (p = star + 1), (i = ++from);
    else return false;
  }
  while (pat[p] === "*") p++;
  return p === pat.length;
}

function event(rel: string, abs: string, category: Category, n: number, ts: string): RawEvent {
  const id = createHash("sha256").update(`${SESSION_ID}\0${rel}\0${n}`).digest("hex").slice(0, 32);
  return { id, schema_version: "0.1", agent: "claude_code", session_id: SESSION_ID, ts, seq: n, category, target_path: abs, raw_ref: { file: rel, line: 1 } };
}

/** Declared workspace globs: package.json `workspaces` (array or `{packages}`) and pnpm-workspace.yaml `packages`. */
function workspaceGlobs(root: string): string[] {
  const read = (rel: string, parseText: (t: string) => unknown) => {
    try {
      const full = join(root, rel);
      return statSync(full).size > MAX_FILE_BYTES ? undefined : parseText(readFileSync(full, "utf8"));
    } catch {
      return undefined; // absent or not parseable: no workspaces from this file
    }
  };
  const ws = (read("package.json", JSON.parse) as { workspaces?: unknown } | undefined)?.workspaces;
  const pnpm = (read("pnpm-workspace.yaml", parse) as { packages?: unknown } | undefined)?.packages;
  const all = [ws, (ws as { packages?: unknown } | undefined)?.packages, pnpm].flatMap((v) => (Array.isArray(v) ? v : []));
  return all.filter((g): g is string => typeof g === "string" && !g.startsWith("!"));
}

/** Hook commands of a settings.json become `hook:<Event>` process_creation events, as the live parser emits them; exec-form args are joined on. */
export function hookCommands(text: string): [string, string][] {
  try {
    const hooks = (JSON.parse(text) as { hooks?: Record<string, unknown> }).hooks ?? {};
    return Object.entries(hooks).flatMap(([name, groups]) =>
      (Array.isArray(groups) ? groups : []).flatMap((g: { hooks?: { command?: unknown; args?: unknown }[] }) =>
        (g?.hooks ?? []).flatMap((h) => {
          if (typeof h?.command !== "string") return [];
          const args = Array.isArray(h.args) ? h.args.filter((a): a is string => typeof a === "string") : [];
          return [[name, [h.command, ...args].join(" ")] as [string, string]];
        })));
  } catch {
    return []; // not JSON: the file_event still carries the text
  }
}

export function collectRepo(dir: string, now = new Date()): Collected {
  const root = fwd(realpathSync(dir));
  const ts = now.toISOString();
  const out: Collected = { events: [], scanned: 0, skipped: [] };
  const skip = (rel: string, reason: string) => void out.skipped.push({ path: rel, reason });

  const add = (rel: string, category: Category) => {
    const full = join(root, rel);
    let st;
    try {
      // the real path, not only the last component: a symlinked `.claude` or `.vscode` must not lead out either
      if (!inside(root, fwd(realpathSync(full)))) return skip(rel, "symlink outside the directory");
      st = statSync(full);
    } catch {
      return; // absent: the normal case for most of these paths
    }
    if (!st.isFile()) return;
    // package.json (lockfile-sized in monorepos) is not an instruction/config file for this signal
    if (st.size > OVERSIZE_BYTES && !rel.endsWith("package.json")) {
      out.events.push({ ...event(rel, "", "file_event", out.events.length, ts), target_path: undefined, tool_name: OVERSIZE_TOOL, command_line: `${st.size} bytes, over ${OVERSIZE_BYTES}` });
    }
    if (st.size > MAX_FILE_BYTES) return skip(rel, `larger than ${MAX_FILE_BYTES} bytes`);
    let text: string;
    try {
      text = readFileSync(full, "utf8");
    } catch {
      return skip(rel, "unreadable");
    }
    out.scanned++;
    const abs = fwd(full);
    const n = out.events.length;
    out.events.push({ ...event(rel, abs, category, n, ts), content: text, ...(category === "file_event" ? { tool_name: "Write" } : {}) });
    if (HOOK_FILES.test(rel)) {
      for (const [name, cmd] of hookCommands(text)) {
        out.events.push({ ...event(rel, abs, "process_creation", out.events.length, ts), tool_name: `hook:${name}`, command_line: cmd });
        out.events.push({ ...event(rel, abs, "process_creation", out.events.length, ts), tool_name: `open:hook:${name}`, command_line: cmd });
      }
    }
    for (const [kind, cmd] of openCommands(rel, text)) {
      out.events.push({ ...event(rel, abs, "process_creation", out.events.length, ts), tool_name: `open:${kind}`, command_line: cmd });
    }
  };

  const walk = (rel: string, keep: RegExp, category: Category, seen = { n: 0 }) => {
    let entries;
    try {
      // readdir follows a symlinked walk root (`.claude/skills -> /`), so check where it really is first
      if (!inside(root, fwd(realpathSync(join(root, rel))))) return skip(rel, "symlink outside the directory");
      entries = readdirSync(join(root, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const e of entries) {
      const child = `${rel}/${e.name}`;
      if (SKIP_DIRS.has(e.name)) continue;
      if (e.isDirectory()) walk(child, keep, category, seen); // a symlinked directory is not isDirectory(): never descended
      else if (keep.test(child.slice(rel.length + 1))) {
        if (++seen.n > MAX_FILES) return skip(child, "too many files");
        add(child, category);
      }
    }
  };

  // CLAUDE.md / AGENTS.md below the root (a package's own instructions): bounded by depth, count and directories listed.
  // A symlinked directory is not isDirectory(), so this never leaves the root either.
  const nested = { files: 0, dirs: 0 };
  const findNested = (rel: string, depth: number): void => {
    if (depth > MAX_NESTED_DEPTH || ++nested.dirs > MAX_WORKSPACE_DIRS) return;
    let entries;
    try {
      entries = readdirSync(join(root, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory() && !SKIP_DIRS.has(e.name)) findNested(child, depth + 1);
      else if (rel && e.isFile() && NESTED_NAMES.has(e.name) && ++nested.files <= MAX_NESTED) add(child, "instruction_load");
    }
  };

  // Each glob segment is matched against real directory entries: `*`, `**` and literal names only, no `..`, and a
  // symlinked directory is not isDirectory(), so the expansion never leaves the root.
  const packages = new Set<string>();
  let listed = 0;
  const expand = (rel: string, segs: string[]): void => {
    if (packages.size > MAX_PACKAGES || listed > MAX_WORKSPACE_DIRS) return;
    if (!segs.length) return void (rel && lstatSync(join(root, rel, "package.json"), { throwIfNoEntry: false }) && packages.add(`${rel}/package.json`));
    const [seg, ...rest] = segs as [string, ...string[]];
    if (seg === "**") expand(rel, rest);
    let entries;
    if (++listed > MAX_WORKSPACE_DIRS) return;
    try {
      entries = readdirSync(join(root, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name)) continue;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (seg === "**") expand(child, segs);
      else if (globMatch(seg, e.name)) expand(child, rest);
    }
  };
  for (const glob of workspaceGlobs(root)) {
    const segs = fwd(glob).replace(/\/package\.json$/, "").split("/").filter((s) => s && s !== ".");
    if (!segs.includes("..")) expand("", segs);
  }

  for (const [rel, cat] of FILES) add(rel, cat);
  for (const rel of [...packages].slice(0, MAX_PACKAGES)) add(rel, "file_event");
  if (packages.size > MAX_PACKAGES) skip("workspaces", `more than ${MAX_PACKAGES} packages, only the first ${MAX_PACKAGES} read`);
  else if (listed > MAX_WORKSPACE_DIRS) skip("workspaces", `glob lists more than ${MAX_WORKSPACE_DIRS} directories, stopped there`);
  for (const [rel, keep, cat] of DIRS) walk(rel, keep, cat);
  findNested("", 0);
  if (nested.files > MAX_NESTED) skip("nested", `more than ${MAX_NESTED} nested CLAUDE.md/AGENTS.md, only the first ${MAX_NESTED} read`);
  return out;
}

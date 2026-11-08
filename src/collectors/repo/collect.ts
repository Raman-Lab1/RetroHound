// Repo agent-surface collector (`preflight`): reads a few known files of a cloned repo as TEXT and maps
// them to the RawEvents the existing rules match. Nothing is executed, imported or fetched, nothing is written, and
// the walk is bounded: fixed locations only, node_modules/.git skipped, a size cap, no symlink out of the directory.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Category, RawEvent } from "../../normalize/types.ts";

export const MAX_FILE_BYTES = 1_048_576;
const MAX_FILES = 400; // per directory walk; a bomb of agent files is reported as skipped, not read
export const SESSION_ID = "preflight";
const SKIP_DIRS = new Set(["node_modules", ".git"]);

export type Skipped = { path: string; reason: string };
export type Collected = { events: RawEvent[]; scanned: number; skipped: Skipped[] };

/** file -> category: instruction text is loaded into context; config files are what a write rule would see. */
const FILES: [string, Category][] = [
  ["CLAUDE.md", "instruction_load"], ["AGENTS.md", "instruction_load"], ["GEMINI.md", "instruction_load"], [".cursorrules", "instruction_load"],
  [".claude/settings.json", "file_event"], [".claude/settings.local.json", "file_event"], [".mcp.json", "file_event"],
  [".vscode/tasks.json", "file_event"], [".vscode/settings.json", "file_event"], ["package.json", "file_event"],
];
const DIRS: [string, RegExp][] = [
  [".claude/agents", /\.md$/i], [".claude/commands", /\.md$/i], [".claude/skills", /(?:^|\/)SKILL\.md$/i], [".cursor/rules", /\.mdc?$/i],
];

const fwd = (p: string) => p.replaceAll("\\", "/");
const inside = (root: string, p: string) => p === root || p.startsWith(root + "/");

function event(rel: string, abs: string, category: Category, n: number, ts: string): RawEvent {
  const id = createHash("sha256").update(`${SESSION_ID}\0${rel}\0${n}`).digest("hex").slice(0, 32);
  return { id, schema_version: "0.1", agent: "claude_code", session_id: SESSION_ID, ts, seq: n, category, target_path: abs, raw_ref: { file: rel, line: 1 } };
}

/** Hook commands of a settings.json become `hook:<Event>` process_creation events, as the live parser emits them. */
function hookCommands(text: string): [string, string][] {
  try {
    const hooks = (JSON.parse(text) as { hooks?: Record<string, unknown> }).hooks ?? {};
    return Object.entries(hooks).flatMap(([name, groups]) =>
      (Array.isArray(groups) ? groups : []).flatMap((g: { hooks?: { command?: unknown }[] }) =>
        (g?.hooks ?? []).flatMap((h) => (typeof h?.command === "string" ? [[name, h.command] as [string, string]] : []))));
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
      st = lstatSync(full);
      if (st.isSymbolicLink()) {
        if (!inside(root, fwd(realpathSync(full)))) return skip(rel, "symlink outside the directory");
        st = statSync(full);
      }
    } catch {
      return; // absent: the normal case for most of these paths
    }
    if (!st.isFile()) return;
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
    if (rel.endsWith(".claude/settings.json") || rel.endsWith(".claude/settings.local.json")) {
      for (const [name, cmd] of hookCommands(text)) {
        out.events.push({ ...event(rel, abs, "process_creation", out.events.length, ts), tool_name: `hook:${name}`, command_line: cmd });
      }
    }
  };

  const walk = (rel: string, keep: RegExp, seen = { n: 0 }) => {
    let entries;
    try {
      entries = readdirSync(join(root, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const e of entries) {
      const child = `${rel}/${e.name}`;
      if (SKIP_DIRS.has(e.name)) continue;
      if (e.isDirectory()) walk(child, keep, seen); // a symlinked directory is not isDirectory(): never descended
      else if (keep.test(child.slice(rel.length + 1))) {
        if (++seen.n > MAX_FILES) return skip(child, "too many files");
        add(child, "instruction_load");
      }
    }
  };

  for (const [rel, cat] of FILES) add(rel, cat);
  for (const [rel, keep] of DIRS) walk(rel, keep);
  return out;
}

// Finds Claude Code transcripts (ADR 0005). Read-only; the result depends only on what is on disk.
import { existsSync, readdirSync, type Dirent } from "node:fs";
import { join, resolve } from "node:path";
import { normalizeSlashes } from "../../normalize/paths.ts";

const TRANSCRIPT = /\.jsonl(?:\.superseded-.*)?$/; // also matches *.orphaned-*.jsonl and legacy agent-*.jsonl

function list(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // missing or unreadable: nothing to scan here
  }
}

/** Transcript paths under `root`, sorted, with forward slashes on Windows. `root` is the Claude config dir
 * (`~/.claude`) or its `projects` dir directly. A missing root gives []. */
export function discover(root: string): string[] {
  const base = resolve(root);
  const projects = existsSync(join(base, "projects")) ? join(base, "projects") : base;
  const found: string[] = [];
  for (const project of list(projects).filter((e) => e.isDirectory())) {
    const dir = join(projects, project.name);
    for (const entry of list(dir)) {
      if (entry.isFile() && TRANSCRIPT.test(entry.name)) found.push(join(dir, entry.name));
      if (!entry.isDirectory()) continue;
      const subagents = join(dir, entry.name, "subagents");
      for (const sub of list(subagents)) {
        if (sub.isFile() && sub.name.endsWith(".jsonl")) found.push(join(subagents, sub.name));
      }
    }
  }
  return found.map(normalizeSlashes).sort();
}

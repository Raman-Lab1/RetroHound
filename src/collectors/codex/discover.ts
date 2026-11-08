// Finds Codex rollouts (docs/formats/codex.md). Read-only.
import { readdirSync, readFileSync, type Dirent } from "node:fs";
import { join, resolve } from "node:path";
import { normalizeSlashes } from "../../normalize/paths.ts";

const ROLLOUT = /^rollout-.*\.jsonl(?:\.zst)?$/;
const THREAD = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/i;

function list(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // missing or unreadable
  }
}

function walk(dir: string, out: string[]): void {
  for (const e of list(dir)) {
    if (e.isDirectory()) walk(join(dir, e.name), out);
    else if (e.isFile() && ROLLOUT.test(e.name)) out.push(join(dir, e.name));
  }
}

/** Thread ids Codex Desktop imported from Claude Code sessions. Those rollouts repeat what the Claude
 * collector already reads, so they are skipped. Marker: `imported_thread_id` in `external_agent_session_imports.json`
 * (field names from Codex's own files; not yet seen in a real history, so unverified). */
function importedThreads(base: string): Set<string> {
  try {
    const ledger = JSON.parse(readFileSync(join(base, "external_agent_session_imports.json"), "utf8"));
    const ids = (Array.isArray(ledger?.records) ? ledger.records : []).map((r: any) => r?.imported_thread_id);
    return new Set(ids.filter((id: unknown): id is string => typeof id === "string").map((id: string) => id.toLowerCase()));
  } catch {
    return new Set(); // no ledger, or not JSON: nothing is known to be imported
  }
}

/** Rollout paths under `$CODEX_HOME`: sessions/** and archived_sessions/**, plain and .zst, sorted, forward slashes. */
export function discover(root: string): string[] {
  const base = resolve(root);
  const found: string[] = [];
  for (const dir of ["sessions", "archived_sessions"]) walk(join(base, dir), found);
  const imported = importedThreads(base);
  const keep = found.filter((p) => !imported.has(THREAD.exec(p)?.[1]?.toLowerCase() ?? ""));
  return keep.map(normalizeSlashes).sort();
}

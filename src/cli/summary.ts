// ADR 0008 summary lines for `scan`: history window, sessions that outlived their transcripts, retention warning.
// Reads only `cleanupPeriodDays` from Claude's settings and `sessionId` from history.jsonl; never prompt text, never writes.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openReadOnly } from "../store/index.ts";

export function retentionDays(root: string): number {
  try {
    const days = (JSON.parse(readFileSync(join(root, "settings.json"), "utf8")) as { cleanupPeriodDays?: unknown }).cleanupPeriodDays;
    return typeof days === "number" && days > 0 ? days : 30;
  } catch {
    return 30; // missing or unreadable settings: Claude Code's default
  }
}

/** history.jsonl sessions that no indexed session matches: deleted before RetroHound saw them. Undefined without both files. */
function untracked(root: string, dbPath: string | undefined): number | undefined {
  const file = join(root, "history.jsonl");
  if (!dbPath || !existsSync(file)) return undefined; // no index named: nothing to compare against
  const ids = new Set<string>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    try {
      const id = (JSON.parse(line) as { sessionId?: unknown }).sessionId;
      if (typeof id === "string") ids.add(id);
    } catch {
      // blank or malformed line
    }
  }
  try {
    const db = openReadOnly(dbPath);
    try {
      const known = new Set(db.prepare("SELECT session_id FROM sessions").all().map((r) => String(r.session_id)));
      return [...ids].filter((id) => !known.has(id)).length;
    } finally {
      db.close();
    }
  } catch {
    return undefined; // --no-index: nothing to compare against
  }
}

export function summaryLines(root: string, dbPath: string | undefined, archived: number): string[] {
  const days = retentionDays(root);
  const missing = untracked(root, dbPath);
  return [
    `  History window: ${days} days (cleanupPeriodDays from Claude Code settings, default 30)`,
    ...(missing === undefined ? [] : [`  ${missing} sessions in history.jsonl have no transcript (deleted before RetroHound indexed them)`]),
    `  ${archived} sessions preserved in the index after Claude Code deleted them`,
    ...(days <= 30
      ? [
          `  Warning: Claude Code deletes transcripts after ${days} days. To keep them longer, set "cleanupPeriodDays": 3650 in ~/.claude/settings.json (RetroHound never edits it).`,
          "  Caveat: fix secret-exposure findings first, because longer retention keeps plaintext secrets longer.",
        ]
      : []),
  ];
}

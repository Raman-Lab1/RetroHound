// Config snapshots: every indexed scan stores what the agents' config files set up (name, scope, source and a hash of
// the masked entry; src/store/schema.ts migration 4), so the footprint can show what is new or changed since the scan
// before. Read with the same readers as the footprint's "Configured versus used"; nothing unmasked is stored.
import { homedir } from "node:os";
import type { Store } from "../store/index.ts";
import type { Db } from "../store/sqlite.ts";
import { readAntigravityConfig } from "./config-antigravity.ts";
import { readClaudeConfig } from "./config-claude.ts";
import { readCodexConfig } from "./config-codex.ts";
import type { ConfigRead, ConfigSnapshotDiff } from "./types.ts";

const READERS = [readClaudeConfig, readCodexConfig, readAntigravityConfig];

/** Every agent's config. home: HOME, else the OS home; projects: most recently used first, the readers cap them. */
export const readConfigs = (env: Record<string, string | undefined>, projects: string[]): ConfigRead[] =>
  READERS.map((read) => read({ home: env.HOME || homedir(), projects, env }));

/** Stores this scan's snapshot; call right after store.recordRuleRun. */
export function snapshotConfig(store: Store, env: Record<string, string | undefined> = process.env): void {
  const projects = [...new Set(store.listSessions().filter((s) => s.project_path !== null)
    .sort((a, b) => (a.last_ts < b.last_ts ? 1 : a.last_ts > b.last_ts ? -1 : 0)).map((s) => s.project_path!))];
  store.recordConfigSnapshot(readConfigs(env, projects).flatMap((r) => r.items));
}

const CAP = 200; // rows per list
const COLS = "DISTINCT agent, kind, name, scope, source";
const SAME = "p.agent = c.agent AND p.kind = c.kind AND p.name = c.name";

/** The latest snapshot against the one before: names it has that the previous lacks (and the reverse), and entries at
 * the same agent, kind, name, scope and source whose hash differs. undefined on an index from before snapshots. */
export function snapshotDiff(db: Db): [ConfigSnapshotDiff | undefined, number] {
  const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'config_snapshots'").get();
  if (!has) return [undefined, 0];
  const ids = db.prepare("SELECT id FROM rule_runs WHERE config_items IS NOT NULL ORDER BY id DESC LIMIT 2").all().map((r) => Number(r.id));
  if (ids.length < 2) return [{ compared: false, new: [], changed: [], removed: [] }, 0];
  type Row = ConfigSnapshotDiff["new"][number];
  let cut = 0;
  const rows = (sql: string, ...ids: number[]) => {
    const all = db.prepare(`${sql} ORDER BY agent, kind, name, scope, source`).all(...ids) as unknown as Row[];
    cut += Math.max(0, all.length - CAP);
    return all.slice(0, CAP).map((r) => ({ ...r }));
  };
  const prev = (and: string) => `EXISTS (SELECT 1 FROM config_snapshots p WHERE p.scan_id = ? AND ${SAME}${and})`;
  const absent = `SELECT ${COLS} FROM config_snapshots c WHERE scan_id = ? AND NOT ${prev("")}`;
  // one entry can be set up twice in one file (a hook command under two events): changed only when no twin matches
  const entry = " AND p.scope = c.scope AND p.source = c.source";
  const [latest, previous] = ids as [number, number];
  const diff = {
    compared: true,
    new: rows(absent, latest, previous),
    changed: rows(`SELECT ${COLS} FROM config_snapshots c WHERE scan_id = ? AND ${prev(entry)} AND NOT ${prev(`${entry} AND p.hash = c.hash`)}`,
      latest, previous, previous),
    removed: rows(absent, previous, latest),
  };
  return [diff, cut];
}

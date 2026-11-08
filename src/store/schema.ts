// The index schema (ADR 0002). Versioning is PRAGMA user_version plus this ordered list: a released entry
// never changes, so a schema change is a new entry at the end.
import type { Db } from "./sqlite.ts";

export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE events (
    id TEXT PRIMARY KEY, -- hash(file, line uuid ?? line_no, sub_index), stable across rewrites (0008)
    source_file TEXT NOT NULL, -- files_indexed.path; raw_file is what the parser reported
    schema_version TEXT NOT NULL,
    agent TEXT NOT NULL,
    agent_version TEXT,
    session_id TEXT NOT NULL,
    parent_session_id TEXT,
    agent_id TEXT,
    parent_tool_use_id TEXT,
    project_path TEXT,
    ts TEXT NOT NULL,
    seq INTEGER NOT NULL, -- line order per file, so not unique per session
    category TEXT NOT NULL,
    tool_name TEXT,
    command_line TEXT,
    target_path TEXT,
    url TEXT,
    domain TEXT,
    mcp_server TEXT,
    mcp_tool TEXT,
    outcome TEXT,
    permission_mode TEXT,
    prompt_source TEXT,
    entrypoint TEXT,
    attribution TEXT,
    denial_kind TEXT,
    denial_category TEXT,
    secret_kinds TEXT, -- JSON array; NULL when absent, never '[]'
    result_secret_kinds TEXT,
    secret_fps TEXT,
    text_excerpt TEXT,
    raw_file TEXT NOT NULL,
    raw_line INTEGER NOT NULL
  );
  CREATE INDEX events_session_seq ON events (session_id, seq);
  CREATE INDEX events_category ON events (category);
  CREATE INDEX events_ts ON events (ts);
  CREATE INDEX events_target_path ON events (target_path);
  CREATE INDEX events_domain ON events (domain);
  CREATE INDEX events_source_file ON events (source_file);

  CREATE TABLE sessions (
    session_id TEXT PRIMARY KEY,
    agent TEXT NOT NULL,
    project_path TEXT,
    first_ts TEXT NOT NULL,
    last_ts TEXT NOT NULL,
    event_count INTEGER NOT NULL
  );

  CREATE TABLE files_indexed (
    path TEXT PRIMARY KEY,
    size INTEGER NOT NULL,
    mtime REAL NOT NULL, -- stat mtimeMs, fractional on some filesystems
    parser_version TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    gone_at TEXT
  );

  CREATE TABLE findings (
    id TEXT PRIMARY KEY, -- sha256(rule_id + sorted event ids) (0014)
    rule_id TEXT NOT NULL,
    level TEXT NOT NULL,
    ts TEXT NOT NULL,
    session_id TEXT NOT NULL,
    message TEXT NOT NULL,
    events TEXT NOT NULL -- JSON array of masked AgentEvents: evidence that outlives a rebuild of the events table
  );

  CREATE TABLE rule_runs (
    id INTEGER PRIMARY KEY,
    rule_set_hash TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT NOT NULL,
    events INTEGER NOT NULL,
    findings INTEGER NOT NULL
  );
  `,
  // 2: drop the events indexes no src/ query uses (they were ~70% of insert cost, docs/perf.md). Kept: events_session_seq
  // (sessionEvents, refreshSessions, eventStats, the archived check) and events_source_file (fileSessions, deleteEvents).
  // Dropped: category, ts, target_path, domain. `retrohound query` filters on those still work, as scans.
  `
  DROP INDEX IF EXISTS events_category;
  DROP INDEX IF EXISTS events_ts;
  DROP INDEX IF EXISTS events_target_path;
  DROP INDEX IF EXISTS events_domain;
  `,
];

/** Applies the entries `db` has not had yet, each in its own transaction. Refuses a DB newer than `migrations`. */
export function migrate(db: Db, migrations: readonly string[] = MIGRATIONS): void {
  const version = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  if (version > migrations.length) {
    throw new Error(`index schema version ${version} is newer than this RetroHound supports (${migrations.length})`);
  }
  for (const [i, sql] of migrations.entries()) {
    if (i < version) continue;
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

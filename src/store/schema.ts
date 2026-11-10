// The index schema (ADR 0002). Versioning is PRAGMA user_version plus this ordered list: a released entry
// never changes, so a schema change is a new entry at the end. An entry is SQL, or a function when SQL can't do it.
import { createChain } from "./chain.ts";
import type { Db } from "./sqlite.ts";

export type Migration = string | ((db: Db) => void);

export const MIGRATIONS: readonly Migration[] = [
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
  // 3: the hash chain (ADR 0015), seeded from the rows already present; sha256 needs JS, hence a function.
  createChain,
  // 4: what the agents' config files set up at each indexed scan (src/footprint/snapshot.ts), the last 10 scans kept.
  // Not chained, like `sessions`: it is re-read from the config files on every scan. `hash` is entryHash of the masked
  // entry, never the value. rule_runs.config_items is NULL for a scan that took no snapshot (every scan before this).
  `
  CREATE TABLE config_snapshots (
    scan_id INTEGER NOT NULL, -- rule_runs.id
    agent TEXT NOT NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    scope TEXT NOT NULL,
    source TEXT NOT NULL,
    hash TEXT NOT NULL
  );
  CREATE INDEX config_snapshots_scan ON config_snapshots (scan_id);
  ALTER TABLE rule_runs ADD COLUMN config_items INTEGER;
  `,
];

/** Applies the entries `db` has not had yet, each in its own transaction. Refuses a DB newer than `migrations`, and
 * another program's database (tables but no version): `--db` pointed at the wrong file must not get our schema. */
export function migrate(db: Db, migrations: readonly Migration[] = MIGRATIONS): void {
  const version = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  if (version > migrations.length) {
    throw new Error(`index schema version ${version} is newer than this RetroHound supports (${migrations.length})`);
  }
  if (version === 0 && db.prepare("SELECT 1 FROM sqlite_master LIMIT 1").get()) {
    throw new Error("this database is not a RetroHound index (it has tables but no index version); left unchanged");
  }
  for (const [i, sql] of migrations.entries()) {
    if (i < version) continue;
    db.exec("BEGIN");
    try {
      if (typeof sql === "string") db.exec(sql);
      else sql(db);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

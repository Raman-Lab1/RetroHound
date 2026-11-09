// The index: masked events, sessions, files and findings (ADR 0002, 0006, 0008). Raw events enter only through
// toStored, so nothing here can write a match-only field. File paths are masked like any other string column (0007).
import { createHash } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mask } from "../normalize/mask.ts";
import { LIST_FIELDS, OPTIONAL_STRINGS, toStored } from "../normalize/stored.ts";
import type { AgentEvent, Finding, RawEvent } from "../normalize/types.ts";
import { chainWriter } from "./chain.ts";
import { migrate } from "./schema.ts";
import { open, type Db, type Row, type SqlValue } from "./sqlite.ts";

export type FileRecord = { path: string; size: number; mtime: number; parser_version: string; sha256: string };
export type FileRow = FileRecord & { first_seen: string; last_seen: string; gone_at: string | null };
export type SessionRow = {
  session_id: string;
  agent: string;
  project_path: string | null;
  first_ts: string;
  last_ts: string;
  event_count: number;
  archived: boolean; // every source file is gone (0008)
};
export type RuleRun = { rule_set_hash: string; started_at: string; finished_at: string; events: number; findings: number };

const EVENT_COLUMNS = [
  "source_file",
  ...["id", "schema_version", "agent", "session_id", "ts", "seq", "category"],
  ...OPTIONAL_STRINGS,
  ...LIST_FIELDS,
  ...["raw_file", "raw_line"],
];
// A set-aside copy (.superseded-*, .orphaned-*) repeats the original's event ids (0008) and may be older: it must not
// move the pointer to itself or lose a known outcome (a tool_use cut off before its result reads "unknown").
const SET_ASIDE = `(excluded.source_file <> events.source_file
  AND (excluded.source_file LIKE '%.superseded-%' OR excluded.source_file LIKE '%.orphaned-%'))`;
const KNOWN = "(events.outcome IS NOT NULL AND events.outcome <> 'unknown')";
const keepOld = (c: string) => `CASE WHEN ${SET_ASIDE} THEN events.${c} ELSE excluded.${c} END`;
const SETS = [
  ...EVENT_COLUMNS.filter((c) => c !== "id" && c !== "outcome").map((c) => [c, keepOld(c)]),
  ["outcome", `CASE WHEN ${KNOWN} AND (${SET_ASIDE} OR excluded.outcome IS NULL OR excluded.outcome = 'unknown')
    THEN events.outcome ELSE excluded.outcome END`],
] as const;
// The WHERE turns a re-upsert that changes nothing into a no-op that returns no row, so it adds no chain entry (0015).
const UPSERT_EVENT = `INSERT INTO events (${EVENT_COLUMNS.join(", ")}) VALUES (${EVENT_COLUMNS.map(() => "?").join(", ")})
  ON CONFLICT(id) DO UPDATE SET ${SETS.map(([c, v]) => `${c} = ${v}`).join(", ")}
  WHERE (${SETS.map(([c]) => `events.${c}`).join(", ")}) IS NOT (${SETS.map(([, v]) => v).join(", ")}) RETURNING *`;

const SESSION_SELECT = `SELECT s.*, NOT EXISTS (
    SELECT 1 FROM events e JOIN files_indexed f ON f.path = e.source_file
    WHERE e.session_id = s.session_id AND f.gone_at IS NULL
  ) AS archived FROM sessions s`;

const now = () => new Date().toISOString();
const plain = <T>(row: Row) => ({ ...row }) as unknown as T; // Node rows have a null prototype

function eventParams(sourceFile: string, e: AgentEvent): SqlValue[] {
  return [
    sourceFile,
    ...[e.id, e.schema_version, e.agent, e.session_id, e.ts, e.seq, e.category],
    ...OPTIONAL_STRINGS.map((key) => e[key] ?? null),
    ...LIST_FIELDS.map((key) => (e[key] ? JSON.stringify(e[key]) : null)),
    ...[e.raw_ref.file, e.raw_ref.line],
  ];
}

function rowToEvent(row: Row): AgentEvent {
  const event: AgentEvent = {
    id: row.id as string,
    schema_version: row.schema_version as AgentEvent["schema_version"],
    agent: row.agent as AgentEvent["agent"],
    session_id: row.session_id as string,
    ts: row.ts as string,
    seq: Number(row.seq),
    category: row.category as AgentEvent["category"],
    raw_ref: { file: row.raw_file as string, line: Number(row.raw_line) },
  };
  const fields = event as Record<string, unknown>; // absent, not null: rules re-evaluate these rows (0006)
  for (const key of OPTIONAL_STRINGS) if (row[key] !== null) fields[key] = row[key];
  for (const key of LIST_FIELDS) if (row[key] !== null) fields[key] = JSON.parse(row[key] as string);
  return event;
}

function rowToSession(row: Row): SessionRow {
  return { ...plain<SessionRow>(row), archived: Boolean(row.archived) };
}

function rowToFinding(row: Row): Finding {
  return { ...plain<Finding>(row), events: JSON.parse(row.events as string) as AgentEvent[] };
}

export function defaultDbPath(): string {
  return join(homedir(), ".retrohound", "index.db");
}

/** sha256(rule_id + sorted event ids) (0014): stable across rescans because event ids are. */
export function findingId(ruleId: string, eventIds: string[]): string {
  return createHash("sha256").update(ruleId + [...eventIds].sort().join("")).digest("hex");
}

// Directory 0700 and file 0600, since the DB is long-lived masked evidence (0008). The file is created before SQLite
// sees it, so it never exists wider than 0600. Only the default directory is tightened after the fact: a --db path may
// sit in a directory that is not ours. On Windows chmod only toggles the read-only bit, so these calls protect nothing
// there, and the catch covers filesystems that refuse chmod: neither is a reason to stop a scan.
function createPrivate(path: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  closeSync(openSync(path, "a", 0o600));
  try {
    if (path === defaultDbPath()) chmodSync(dir, 0o700);
    chmodSync(path, 0o600);
  } catch {
    // see above
  }
}

/** Read-only handle for `retrohound query`: writes throw, and so does a missing DB. */
export function openReadOnly(path: string = defaultDbPath()): Db {
  return open(path, { readonly: true });
}

export type Store = ReturnType<typeof openStore>;

/** Opens the index, creating and migrating it as needed. Always `close()`, or Windows keeps the file locked. */
export function openStore(path: string = defaultDbPath()) {
  createPrivate(path);
  const db = open(path);
  try {
    // WAL + NORMAL: a commit no longer waits for a disk sync (about 40% off a cold scan of 1,000 sessions). A power cut
    // can lose the last commits but not corrupt the file, and the index is rebuilt from transcripts (0008).
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL");
    migrate(db);
  } catch (err) {
    db.close();
    throw err;
  }

  // Every write to files_indexed, events and findings returns its rows to `chain` (ADR 0015).
  const chain = chainWriter(db);
  const q = {
    getFile: db.prepare("SELECT * FROM files_indexed WHERE path = ?"),
    listFiles: db.prepare("SELECT * FROM files_indexed ORDER BY path"),
    upsertFile: db.prepare(`INSERT INTO files_indexed
        (path, size, mtime, parser_version, sha256, first_seen, last_seen, gone_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime,
        parser_version = excluded.parser_version, sha256 = excluded.sha256, last_seen = excluded.last_seen, gone_at = NULL
      RETURNING *`),
    // last_seen is not chained, so the touch and the (chained) return of a gone file are separate statements.
    touchFile: db.prepare("UPDATE files_indexed SET last_seen = ? WHERE path = ?"),
    unGone: db.prepare("UPDATE files_indexed SET gone_at = NULL WHERE path = ? AND gone_at IS NOT NULL RETURNING *"),
    markGone: db.prepare("UPDATE files_indexed SET gone_at = ? WHERE path = ? AND gone_at IS NULL RETURNING *"),
    upsertEvent: db.prepare(UPSERT_EVENT),
    deleteEvents: db.prepare("DELETE FROM events WHERE source_file = ? RETURNING *"),
    dropEmptySession: db.prepare(`DELETE FROM sessions
      WHERE session_id = ? AND NOT EXISTS (SELECT 1 FROM events WHERE session_id = ?)`),
    refreshSession: db.prepare(`INSERT INTO sessions (session_id, agent, project_path, first_ts, last_ts, event_count)
      SELECT session_id, min(agent),
        (SELECT p.project_path FROM events p WHERE p.session_id = e.session_id AND p.project_path IS NOT NULL
          ORDER BY p.ts, p.seq LIMIT 1),
        min(ts), max(ts), count(*)
      FROM events e WHERE session_id = ? GROUP BY session_id
      ON CONFLICT(session_id) DO UPDATE SET agent = excluded.agent, project_path = excluded.project_path,
        first_ts = excluded.first_ts, last_ts = excluded.last_ts, event_count = excluded.event_count`),
    sessionEvents: db.prepare("SELECT * FROM events WHERE session_id = ? ORDER BY ts, seq, id"),
    getSession: db.prepare(`${SESSION_SELECT} WHERE s.session_id = ?`),
    listSessions: db.prepare(`${SESSION_SELECT} ORDER BY s.first_ts, s.session_id`),
    // A repeat refreshes the rule's wording but keeps the stored events: a re-evaluation from DB rows may no longer
    // have the excerpt that the first one, on raw text, recorded (0006).
    insertFinding: db.prepare(`INSERT INTO findings (id, rule_id, level, ts, session_id, message, events)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET level = excluded.level, message = excluded.message
      WHERE (findings.level, findings.message) IS NOT (excluded.level, excluded.message) RETURNING *`),
    deleteFindings: db.prepare("DELETE FROM findings WHERE session_id = ? RETURNING *"),
    eventStats: db.prepare(`SELECT coalesce(sum(outcome = 'blocked'), 0) AS blocked,
        coalesce(sum(agent_id IS NOT NULL), 0) AS subagent FROM events
      WHERE (? IS NULL OR session_id IN (SELECT value FROM json_each(?)))`), // plain ? twice: Node 22.13 can't bind ?NNN
    listFindings: db.prepare("SELECT * FROM findings WHERE (? IS NULL OR session_id = ?) ORDER BY ts, id"),
    insertRuleRun: db.prepare(`INSERT INTO rule_runs (rule_set_hash, started_at, finished_at, events, findings)
      VALUES (?, ?, ?, ?, ?)`),
    lastRuleRun: db.prepare(`SELECT rule_set_hash, started_at, finished_at, events, findings
      FROM rule_runs ORDER BY id DESC LIMIT 1`),
  };

  function refreshSessions(ids: Iterable<string>): void {
    for (const id of ids) {
      q.dropEmptySession.run(id, id);
      q.refreshSession.run(id);
    }
  }

  function getFile(path: string): FileRow | undefined {
    const row = q.getFile.get(mask(path));
    return row && plain<FileRow>(row);
  }

  /** Runs synchronous `fn` in one transaction. Not reentrant, and `fn` must not await. */
  function transaction<T>(fn: () => T): T {
    db.exec("BEGIN");
    chain.reset();
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (err) {
      db.exec("ROLLBACK");
      chain.reset();
      throw err;
    }
  }

  function writeFindings(findings: Finding[]): void {
    for (const f of findings) {
      const events = JSON.stringify(f.events.map(toStored));
      const rows = q.insertFinding.all(mask(f.id), mask(f.rule_id), f.level, mask(f.ts), mask(f.session_id), mask(f.message), events);
      chain.append("findings", "write", rows);
    }
  }

  return {
    transaction,
    getFile,

    listFiles: (): FileRow[] => q.listFiles.all().map((row) => plain<FileRow>(row)),

    /** True when `path` has never been indexed, or its size, mtime or parser version differ from the record. */
    shouldIndex(path: string, size: number, mtime: number, parser_version: string): boolean {
      const row = getFile(path);
      return !row || row.size !== size || row.mtime !== mtime || row.parser_version !== parser_version;
    },

    /** Records an indexed file, keeping first_seen and clearing gone_at. */
    upsertFile(file: FileRecord): void {
      const time = now();
      chain.append("files_indexed", "write", q.upsertFile.all(mask(file.path), file.size, file.mtime, file.parser_version, file.sha256, time, time));
    },

    /** Records that an unchanged file is still on disk. */
    touchFile(path: string): void {
      q.touchFile.run(now(), mask(path));
      chain.append("files_indexed", "write", q.unGone.all(mask(path)));
    },

    /** Records that a file vanished, and returns false if it already had. Its events stay (0008). */
    markGone(path: string): boolean {
      const rows = q.markGone.all(now(), mask(path));
      chain.append("files_indexed", "write", rows);
      return rows.length > 0;
    },

    /** Masks and upserts by event id, so an event missing from a rewritten file survives. Call inside a transaction. */
    upsertEvents(sourcePath: string, events: RawEvent[], refresh = true): string[] {
      const sourceFile = mask(sourcePath);
      const sessions = new Set<string>();
      for (const raw of events) {
        const event = toStored(raw);
        chain.append("events", "write", q.upsertEvent.all(...eventParams(sourceFile, event)));
        sessions.add(event.session_id);
      }
      if (refresh) refreshSessions(sessions);
      return [...sessions];
    },

    /** For a parser_version rebuild of a file still on disk, the one case events are deleted. Call inside a transaction.
     * With `refresh` false the caller owes a `refreshSessions` of the returned ids (the indexer batches it per run). */
    deleteEvents(sourcePath: string, refresh = true): string[] {
      const rows = q.deleteEvents.all(mask(sourcePath));
      chain.append("events", "delete", rows);
      const sessions = [...new Set(rows.map((row) => row.session_id as string))];
      if (refresh) refreshSessions(sessions);
      return sessions;
    },

    /** Recomputes the session rows for `ids` from their events; once per session per run, not once per file. */
    refreshSessions,

    sessionEvents: (sessionId: string): AgentEvent[] => q.sessionEvents.all(sessionId).map(rowToEvent),

    getSession(sessionId: string): SessionRow | undefined {
      const row = q.getSession.get(sessionId);
      return row && rowToSession(row);
    },

    listSessions: (): SessionRow[] => q.listSessions.all().map(rowToSession),

    /** Masks and stores findings in one transaction. Events go through toStored: a RawEvent type-checks as AgentEvent. */
    insertFindings(findings: Finding[]): void {
      transaction(() => writeFindings(findings));
    },

    /** Swaps the stored findings of `sessionIds` for `findings`, atomically: a re-evaluation from raw text is the
     * authority for its sessions, so a rule that no longer fires must not linger. */
    replaceFindings(sessionIds: string[], findings: Finding[]): void {
      transaction(() => {
        for (const id of sessionIds) chain.append("findings", "delete", q.deleteFindings.all(mask(id)));
        writeFindings(findings);
      });
    },

    /** Event counts for the given sessions (all when omitted): blocked outcomes and sub-agent events. */
    eventStats(sessionIds?: string[]): { blocked: number; subagent: number } {
      const ids = sessionIds ? JSON.stringify(sessionIds) : null;
      const row = q.eventStats.get(ids, ids);
      return { blocked: Number(row?.blocked ?? 0), subagent: Number(row?.subagent ?? 0) };
    },

    listFindings(sessionId?: string): Finding[] {
      const id = sessionId ?? null;
      return q.listFindings.all(id, id).map(rowToFinding);
    },

    recordRuleRun(run: RuleRun): void {
      q.insertRuleRun.run(run.rule_set_hash, run.started_at, run.finished_at, run.events, run.findings);
    },

    lastRuleRun(): RuleRun | undefined {
      const row = q.lastRuleRun.get();
      return row && plain<RuleRun>(row);
    },

    close: () => db.close(),
  };
}

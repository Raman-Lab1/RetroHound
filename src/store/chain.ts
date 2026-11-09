// The hash chain over every write to the evidence tables (ADR 0015). Each entry links to the one before it:
// hash = sha256(prev + JSON [table, row_id, op, row_hash]), row_hash = sha256 of the row's JSON after the write (the
// deleted row for a delete). Store write paths append through `chainWriter`; `verifyChain` recomputes all of it.
import { createHash } from "node:crypto";
import type { Db, Row } from "./sqlite.ts";

export const GENESIS = "0".repeat(64); // `prev` of the first entry, and the head of an empty chain
/** The chained tables and their key column, in seed and verify order. `sessions` is derived from events, not chained. */
const KEYS = { files_indexed: "path", events: "id", findings: "id" } as const;
type Table = keyof typeof KEYS;
type Op = "seed" | "write" | "delete";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
/** Columns in table order; `last_seen` is left out: every scan rewrites it for every file (ADR 0015). */
const rowHash = (row: Row) => sha(JSON.stringify({ ...row, last_seen: undefined }));
const link = (prev: string, table: string, rowId: string, op: string, rowHash: string) =>
  sha(prev + JSON.stringify([table, rowId, op, rowHash]));

/** Appends entries for rows returned by a write (`RETURNING *`). `reset` at every BEGIN and ROLLBACK: the cached head
 * is only good inside the transaction that read it. */
export function chainWriter(db: Db) {
  const last = db.prepare("SELECT hash FROM chain ORDER BY seq DESC LIMIT 1");
  const insert = db.prepare("INSERT INTO chain (tbl, row_id, op, row_hash, prev, hash) VALUES (?, ?, ?, ?, ?, ?)");
  let head: string | undefined;
  return {
    reset: () => void (head = undefined),
    append(table: Table, op: Op, rows: Row[]): void {
      for (const row of rows) {
        const prev = (head ??= (last.get()?.hash as string | undefined) ?? GENESIS);
        const id = row[KEYS[table]] as string;
        const h = rowHash(row);
        head = link(prev, table, id, op, h);
        insert.run(table, id, op, h, prev, head);
      }
    },
  };
}

/** Migration 3: the chain table, seeded from the rows already there. History before this point is not attested. */
export function createChain(db: Db): void {
  db.exec(`CREATE TABLE chain (seq INTEGER PRIMARY KEY, tbl TEXT NOT NULL, row_id TEXT NOT NULL, op TEXT NOT NULL,
    row_hash TEXT NOT NULL, prev TEXT NOT NULL, hash TEXT NOT NULL)`);
  const chain = chainWriter(db);
  for (const [table, key] of Object.entries(KEYS)) chain.append(table as Table, "seed", db.prepare(`SELECT * FROM ${table} ORDER BY ${key}`).all());
}

export type Verdict = { ok: true; entries: number; head: string } | { ok: false; problem: string };

/** Walks the chain, then checks every row against its latest entry. Reports the first problem. `head`, when given,
 * must be one of the chain's hashes: a head recorded elsewhere catches a chain that was cut back or rebuilt. */
export function verifyChain(db: Db, head?: string): Verdict {
  db.exec("BEGIN"); // one read snapshot: a scan committing mid-verify must not read as tampering
  try {
    return check(db, head);
  } finally {
    db.exec("COMMIT");
  }
}

function check(db: Db, head?: string): Verdict {
  const fail =(problem: string): Verdict => ({ ok: false, problem });
  let prev = GENESIS;
  let seen = head === GENESIS;
  const latest = new Map<string, Row>();
  // ponytail: whole chain and tables in memory (about 200 B per row); stream them if indexes reach millions of rows
  const entries = db.prepare("SELECT * FROM chain ORDER BY seq").all();
  for (const e of entries) {
    if (e.prev !== prev) return fail(`chain entry ${e.seq}: prev is not the hash of the entry before it (an entry was removed or reordered)`);
    if (link(prev, e.tbl as string, e.row_id as string, e.op as string, e.row_hash as string) !== e.hash) {
      return fail(`chain entry ${e.seq}: hash does not match its contents (the entry was edited)`);
    }
    prev = e.hash as string;
    if (prev === head) seen = true;
    latest.set(`${e.tbl} ${e.row_id}`, e);
  }
  for (const [table, key] of Object.entries(KEYS)) {
    for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY ${key}`).all()) {
      const e = latest.get(`${table} ${row[key]}`);
      latest.delete(`${table} ${row[key]}`);
      if (!e || e.op === "delete") return fail(`${table} row ${row[key]}: no chain entry (written outside RetroHound)`);
      if (rowHash(row) !== e.row_hash) return fail(`${table} row ${row[key]}: does not match chain entry ${e.seq} (edited outside RetroHound)`);
    }
  }
  for (const e of latest.values()) {
    if (e.op !== "delete") return fail(`chain entry ${e.seq}: ${e.tbl} row ${e.row_id} is missing (deleted outside RetroHound)`);
  }
  if (head !== undefined && !seen) return fail(`head ${head} is not in the chain (it was cut back or rebuilt)`);
  return { ok: true, entries: entries.length, head: prev };
}

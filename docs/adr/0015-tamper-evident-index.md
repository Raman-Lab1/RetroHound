# 0015. Tamper-evident index: a hash chain over every evidence write, checked by `verify`

- Status: Accepted
- Date: 2026-11-09
- Related: 0002, 0008, 0014

## Context
The index is the record of what coding agents did, and it outlives the transcripts (0008). To serve as evidence it has
to show whether it was changed after RetroHound wrote it. The file belongs to the user and anything running as the
user can open it with `sqlite3`; `query` being read-only (0002) only keeps RetroHound's own SQL from writing.

## Options considered
1. **Sign rows or the file with a key.** A key on the same machine is readable by whatever can write the database, and
   key management does not fit a local tool with no network. Rejected for now.
2. **SQLite triggers.** SQLite has no sha256, and a JS function registered on the connection works differently on
   `bun:sqlite` and `node:sqlite`. Rejected.
3. **An append-only `chain` table written by the store's own write paths, and a `verify` command.** Chosen.

## Decision
- Migration 3 adds `chain(seq, tbl, row_id, op, row_hash, prev, hash)`. Every insert, update and delete of
  `files_indexed`, `events` and `findings` appends one entry in the same transaction as the write:
  - `row_hash` = sha256 of `JSON.stringify` of the row after the write, columns in table order (`SELECT *`). For a delete
    it is the deleted row;
  - `hash` = sha256(`prev` + `JSON.stringify([tbl, row_id, op, row_hash])`), with `prev` the previous entry's `hash`
    (64 zeros for the first entry). `op` is `seed`, `write` or `delete`.
- Writes use `RETURNING *`, so the hash covers what SQLite stored, after the event upsert's keep-old rules (0008). An
  upsert that changes nothing does not update (`DO UPDATE ... WHERE (old columns) IS NOT (new)`) and appends nothing.
  Re-parsing a grown transcript therefore chains only what changed: new lines, or an outcome that went from `unknown`
  to `success`. A parser-version rebuild chains a delete and a write for each event.
- Not chained: `files_indexed.last_seen`, which every scan rewrites for every file (chaining it would add one entry per
  file per scan), so it is left out of the row hash; `sessions`, which is recomputed from events; `rule_runs`, which
  is bookkeeping.
- Upgrading: migration 3 seeds the chain from the rows already there (`files_indexed` by path, then `events` and
  `findings` by id) as `seed` entries; the same rows give the same head. **History before the upgrade is attested
  only from that point:** a seed entry records what the index held at upgrade, not that it was never changed before.
- `retrohound verify [--db <path>] [--head <hash>]` opens the index read-only in one read transaction. It recomputes every
  link, then checks each current row against its latest entry, then looks for entries whose row is gone. It reports
  the first problem (an edited, removed or reordered entry; a row with no entry; a row that does not match its entry;
  a missing row) and exits 1. Otherwise it prints `ok: N entries, head <hash>` and exits 0. `--head` also requires a
  head recorded earlier to appear in the chain. `scan` output is unchanged: the head comes from `verify` only.

## Threat model
- **Detected:** any change to a chained row by something that does not also rewrite the chain to match: a `sqlite3`
  edit, another tool, a partial restore. Edited, removed or reordered chain entries are detected as well.
- **Not prevented:** anyone who can write the database can rebuild the whole chain from the current rows; the code
  is public and short. A chain that verifies only shows the file is consistent with itself. The guarantee comes from
  `--head`: keep the head printed by `verify` somewhere the attacker cannot write (a ticket, a SIEM, a signed commit,
  the SOC). A later `verify --head <recorded>` fails if the chain was rebuilt, cut back, or rolled back to a copy
  taken before that head was recorded. It cannot detect changes made before the head was recorded.
- **Out of scope:** what happened before RetroHound read a transcript (an edit to the transcript itself is indexed
  as what the file said); `last_seen`; the whole file being deleted. `purge` deletes everything by design, and a
  recorded head with no database proves only that a database existed.

## Consequences
- Cold scans cost more: on the redacted fixtures (4,650 events) 213 to 252 ms in-process on Bun, and 383 to about
  445 ms on Node. On 300 synthetic sessions (30,300 events, Bun) 1.19 to 1.52 s. Warm scans are unchanged (28-29 ms),
  since an unchanged file appends nothing. Most of the extra time is `RETURNING *` and hashing.
- The chain is append-only and never pruned. Each entry is about 300 bytes, and there is one entry per changed row.
- A later migration that adds or changes columns of a chained table changes every row's JSON. It must append fresh
  `seed` entries for those rows in the same migration, or `verify` fails on every row.
- `verify` holds the chain and the tables in memory, about 200 bytes per row.

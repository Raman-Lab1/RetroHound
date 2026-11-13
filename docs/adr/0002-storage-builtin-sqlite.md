# 0002. Storage: built-in SQLite behind a small adapter

- Status: Accepted
- Date: 2026-11-07
- Related: 0001, 0006 (what is stored), 0008 (retention), 0014 (finding ids)

## Context
`scan` keeps an index at `~/.retrohound/index.db` (`--db` overrides it): events, sessions, indexed files, findings
and rule runs, updated incrementally, deleted by `purge`. Installing must not run install scripts. `node:sqlite`
(Node ≥ 22.13) and `bun:sqlite` are built into the two runtimes; better-sqlite3 needs a native build step that
current package managers block by default.

## Options considered
1. **better-sqlite3.** Install scripts and a per-Node ABI. Rejected.
2. **sql.js / WebAssembly SQLite.** No install script, but about 1 MB more, slower, and in-memory unless persistence
   is hand-rolled. Rejected: both runtimes already ship SQLite.
3. **`bun:sqlite` on Bun, `node:sqlite` on Node, chosen at run time by one small adapter.**

## Decision
Option 3. `src/store/sqlite.ts` imports whichever module exists and exposes `open(path, { readonly })`,
`prepare(sql)` and `exec(sql)`. All store code uses positional `?` parameters, prepared statements, explicit
`BEGIN`/`COMMIT` around batches, and no integers above 2^53.

Schema (`src/store/schema.ts`), beyond the basic tables:
- `files_indexed` keeps a content hash, `first_seen`, `last_seen` and `gone_at`, so events survive the agent
  deleting the transcript (0008);
- `rule_runs.rule_set_hash` says when findings must be re-evaluated (0006); `rule_runs.scope` (migration 5, a JSON list
  of `agent:root`) ties each run to the scopes it evaluated;
- an event `id` is a hash of the canonical path, the line's `uuid` (or its text plus a repeat number) and a sub-index,
  so a rewritten or set-aside copy of a file upserts onto the same rows (0008);
- `events` stores the normalized, masked fields only, never raw text (0006, 0007);
- `findings.id` is a hash of the rule id and the sorted event ids (0014).

Schema versioning is `PRAGMA user_version` plus an ordered list of SQL migrations, with no framework.
`retrohound query` opens the database read-only, so user SQL cannot change the index. On macOS and Linux the file is
mode 0600 in a 0700 directory, because it holds masked evidence for a long time.

## Consequences
- No native dependencies and no install scripts.
- Store tests must pass under both runtimes: `bun test`, plus the bundled CLI under Node in CI.
- Inserts are the slowest step of a cold scan (docs/perf.md), so every file is written in one transaction and
  sessions are re-aggregated once per run.
- SARIF and ECS/OCSF exports are pure transforms of the scan report (0014) and need no extra columns.

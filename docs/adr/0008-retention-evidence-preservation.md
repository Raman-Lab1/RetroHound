# 0008. Retention: the index outlives the agent's transcript cleanup

- Status: Accepted
- Date: 2026-11-07
- Related: 0002, 0006, 0007

## Context
Claude Code deletes transcripts, `subagents/` and `tool-results/` older than `cleanupPeriodDays` (default 30). On one
real history, 159 of 163 sessions older than the cutoff were already gone. `history.jsonl` (prompt metadata with
`sessionId`) is not swept, so it shows which sessions once existed. Large transcripts can also be trimmed in place.
Evidence of what an agent did disappears unless something keeps it.

## Options considered
- Copy raw transcripts aside. Duplicates plaintext secrets (0006, 0007). Rejected.
- Only ask users to raise `cleanupPeriodDays`. Useful, but longer plaintext retention is an exposure in itself.
- **The SQLite index is the archive: masked events and findings are never deleted because a source file went away.**
  Chosen.

## Decision
- **Append-only:** indexing never deletes events because a source file disappeared; it sets `files_indexed.gone_at`.
  RetroHound never modifies or deletes transcripts.
- `files_indexed` records each file's SHA-256 (recomputed when size or mtime change), `first_seen` and `last_seen`.
- Changed files are re-parsed whole and upserted by event id (0002). Set-aside copies (`.superseded-*`,
  `.orphaned-*`) map onto the original's events, so a trimmed rewrite cannot drop indexed events. Only a parser
  version change rebuilds events, and only for files still on disk.
- `scan` indexes by default, so preservation is on by default; `--no-index` and `purge` remain.
- The scan summary prints the history window (`cleanupPeriodDays`, default 30), the number of `history.jsonl`
  sessions with no transcript, and the number of sessions kept in the index after the agent deleted them.
  `src/cli/summary.ts` reads only `cleanupPeriodDays` and the session ids; prompt text is never read.
- When `cleanupPeriodDays` is 30 or less, `scan` suggests `"cleanupPeriodDays": 3650`, with the caveat to deal with
  secret findings first. RetroHound never edits the agent's settings.
- `show` and `query` work the same on archived sessions; outputs mark them `archived`.

## Consequences
- The index grows without bound: tens of MB per year at observed volumes. `purge` covers it; a pruning option can
  come later if needed.
- Archived sessions keep masked fields only, so new raw-text rules cannot run on them (0006 reports this).
- The database is long-lived masked evidence: file mode 0600 in a 0700 directory on macOS and Linux (0002).

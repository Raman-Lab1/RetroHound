# Performance and false-positive review

Targets: a warm scan of 1,000 sessions in under 5 s, and rule evaluation at 50k events/s or more.

## Method

- Machines: the synthetic rows below were measured on an Apple M5 (arm64), macOS 27.2, Bun 1.4.4, two runs, not
  idle (other work ran alongside). The real-transcript row, the cost-per-rule table and the "What made it faster"
  figures were measured earlier on a Windows 10 machine, Bun 1.4.4. Wall times swing 2x to 10x between runs of the
  same code when other work runs alongside, so CPU time and before/after ratios are more reliable than single wall
  times.
- `tests/perf.test.ts` synthesizes N defanged sessions (about 100 events each, 1.3 KB payloads, `example.invalid`) in a
  temp dir and measures parse, evaluate, cold scan and warm scan, all in-process. `bun test` runs it at 5 sessions as a
  smoke test; `PERF=1 bun test tests/perf.test.ts` runs 1,000 (`PERF_SESSIONS=n`; `PERF_KEEP=1` keeps the dir for
  profiling) and asserts both targets.
- Real-transcript figures below come from an earlier, larger fixture set (56 files, 75 MB, 9,928 events, long heredoc
  command lines), since replaced by `fixtures/redacted/` (12 files, 14 MB, free text replaced by placeholders). Numbers
  measured on the new set are lower and do not compare one to one. Those figures are historical: they cannot be
  re-run like for like.

## Results (1,000 synthetic sessions, 101,000 events)

Synthetic rows: 75 rules loaded (58 files: 60 shipped rules plus 15 helper rules that only feed correlations).

| Measure | Result | Target |
|---|---|---|
| Warm scan | 0.14 s | < 5 s: met |
| Evaluate, synthetic sessions | 154.6k-155.6k events/s | 50k: met |
| Evaluate, real transcripts (historical: 48 rules, old fixture set, Windows) | 18.6k-19.8k events/s | 50k: not met (see below) |
| Cold scan | 6.0-6.1 s (16.6k-16.8k events/s) | none set |

The warm scan compares file size and mtime against the index and reads findings back from SQLite. The evaluate rate on
real transcripts is lower because their long heredoc command lines make the bounded-window `re` rules expensive.

## What made it faster

1. Sessions are re-aggregated once per run, in the final transaction with the file records, instead of once per file
   (a session with N sub-agent files was recomputed N+1 times). A crash before that transaction leaves the files
   unrecorded, so the next run re-parses them (an idempotent upsert) and repairs the sessions. `indexFiles` CPU time:
   4.6 s to 3.6 s.
2. `journal_mode=WAL`, `synchronous=NORMAL`: a commit no longer waits for a disk sync. Power loss can drop the last
   commits but not corrupt the file, and the index is derived data. 1,000 sessions: 35 s to 22 s wall.
3. OR-lists of 4 or more plain literals on one field compile to one escaped alternation per match kind (`contains`,
   `startswith`, `endswith`). `network_paste_filedrop_command` alone went from 65-72 ms to 11 ms.
4. The four `events` indexes no query uses were dropped (migration 2), and `sha256` comes from the parse read instead
   of a second read of every file. Cold scan: about -17%.

## Cost per rule (historical: real transcripts, old fixture set, best of 3, top 8)

| ms | Category | Rule | Why |
|---|---|---|---|
| 66-73 | process_creation | exec_decode_to_shell | bounded-window `re` on long command lines |
| 54-60 | process_creation | exec_docker_privileged | same |
| 49-55 | process_creation | exec_lolbin_download | `re` plus lists |
| 42-45 | process_creation | files_persistence_command | `re` on command lines |
| 38-40 | process_creation | exec_pipe_download_to_shell | `re` |
| 34-40 | file_event | control_plane_llm_endpoint_override | `re` on written content |
| 34-40 | process_creation | control_plane_agent_config_risky_shell_write | `re` |
| 34-37 | process_creation | control_plane_agent_config_shell_write | `re` |

The engine itself runs simple rules at about 200k events/s, so the cost is in the rules' regexes, not the evaluator.

## Live hook (`hook run`)

Target (ADR 0009): under 50 ms p95 in-process per call. `bun scripts/build.mjs`, then
`PERF=1 bun test tests/perf.test.ts -t "hook run"`: 200 fresh processes per runtime, each timed from a preload to exit
(the runtime's own start-up excluded), warm rule cache, the shipped rules, a payload that is denied. Apple M5, macOS,
Node 26.5, Bun 1.4.4, one run each, other work running. In-process ms, p50 / p95 / p99:

| Runtime and entry | Before | After |
|---|---|---|
| `node dist/cli.mjs` (shipped) | 20.7 / 24.7 / 26.2 | 18.8 / 19.5 / 23.9 |
| `bun dist/cli.mjs` | 28.0 / 30.1 / 31.1 | 26.2 / 27.8 / 29.3 |
| `bun src/cli/bin.ts` (dev) | 97.6 / 107.5 / 109.9 | 67.9 / 74.3 / 76.7 |

What changed: `hook run` goes from `bin.ts`/`entry.ts` straight to `hookMain` (node:util `parseArgs`) through a
dynamic import, so commander, `scan.ts`, the store and the other commands are not loaded (from source) or not
initialised (in the bundle, where Bun wraps dynamically imported modules in lazy initialisers). Stdin is read with one
synchronous read instead of a stream (about 2 ms under Node in isolation).

Where the shipped hook's ~19 ms goes now (one warm call, timestamps patched into a copy of the bundle): about 9 ms
before the bundle's first line runs (compiling the 290 KB file and loading every `node:` builtin it imports, which Bun
hoists to the top of the file, including ones only other commands use: zlib, readline, child_process), 1.5 ms
initialising the hook's modules, 4.3 ms loading the enforce rules from the cache (directory listing, stats, compile),
4 ms deciding (event mapping, masking and the rules' regexes, all cold). An experimental split build (Bun
`splitting: true`, not the single file ADR 0010 ships) saved about 2 ms p50 more.

## Known limits and next steps

- `re` cost on long strings. A literal prefilter (a substring every match must contain) would cut it; extracting one
  from an arbitrary regex safely is not done yet, so rule authors can add a `contains` selection instead.
- Cold scan is bound by SQLite inserts (33 bound columns, two indexes). Batching several files per transaction is the
  next lever.
- `event_count` gives one finding per window, in practice one per session per rule, so
  `control_plane_hook_repo_script` cannot report per command (see the `shortcut:` comment in `src/engine/correlate.ts`).

## False-positive review (historical: one real developer history, 38 rules)

Not re-run on the current rule set. A read-only scan of one developer's `~/.claude/projects` (temp DB, deleted
afterwards): 9 sessions, 3,272 events, 41 findings from 8 of the 38 rules shipped at that time. The sessions were
mostly work on RetroHound itself, so the history is self-referential. Counts only:

| Rule | Level | Hits | Sessions | Verdict |
|---|---|---|---|---|
| control_plane_hook_repo_script | medium | 19 | 4 | Noisy: the user's own hook fired on every sub-agent start (an ignore entry silences it) |
| control_plane_agent_config_write | medium | 7 | 2 | Likely true positive: user-requested agent config edits |
| exec_package_install_new | informational | 5 | 1 | Expected: installs the user asked for |
| files_mcp_server_added | medium | 3 | 2 | Likely true positive: user-requested MCP config |
| secrets_literal_in_tool_input | high | 3 | 1 | Needs tuning: one hit was a tool call with no path or command |
| control_plane_agent_config_risky_write | high | 2 | 1 | Likely true positive: a user-requested hook |
| exec_pipe_download_to_shell | high | 1 | 1 | False positive: a written rule file quoting the pattern |
| control_plane_llm_endpoint_override | high | 1 | 1 | False positive: a rule file whose text mentions the pattern |

The last two match text inside written file content, not an executed command or a live config file. One history
says little about others: low counts do not show that the remaining rules are quiet elsewhere.

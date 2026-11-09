# Changelog

All notable changes to this project are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- `incident <session|finding>`: one folder to hand over (incident.json, an offline index.html and a sha256 manifest)
  with the timeline, the sub-agent tree, blocked versus succeeded calls, secrets to rotate and where the evidence came
  from (source-file sha256, first and last seen). Works on sessions whose transcripts are gone; `--anonymize` hides paths.
  `incident.json` records the index's chain head (`index_head`), so the pack can be checked against the index later.
- `--extra-rules <dir>` (repeatable) for `scan`, `rules` and `hook`: your own rules on top of the shipped set.
- `preflight` reads each workspace package's package.json in a monorepo (root `workspaces` or pnpm-workspace.yaml).
- Tamper-evident index: every write to events, findings and indexed files is chained by sha256 (ADR 0015).
  `verify` checks the chain and prints its head; `verify --head <hash>` fails if a head recorded elsewhere is gone,
  and lists what was added since it. Existing indexes start their chain on the next scan.
- Blocked-call breakdown in `scan` (table and `scan.blocked_breakdown` in JSON): calls the agent's own guard blocked,
  by denial kind (main conversation vs sub-agent), category, skill/MCP/plugin attribution and project.
- Rules `blocked_then_other_tool_secret_read` (a blocked secret-file read, then the same done with another kind of
  tool) and `blocked_then_subagent_same_call` (a call blocked in the main conversation, then made by a sub-agent).

### Changed
- `scan`, `show` and `wrapped` refuse a `--db` that is another program's SQLite database instead of adding
  RetroHound's tables to it.
- `hook run` is faster: the rule set is cached by file stat and the CLI skips loading other commands (p95 33 -> 21.5 ms).

## [0.1.0]

First public release.

- `scan` for Claude Code, Codex CLI and Antigravity CLI transcripts (`--agent`), including sub-agents and calls the
  agent blocked; masked, append-only SQLite index that keeps sessions after the agent deletes them.
- 46 Sigma v2.1 rules on a proposed `ai_coding_agent` logsource, plus 6 helper rules for correlations, each with
  positive and negative tests (`rules test`).
- `show`, `query`, `wrapped` (HTML report or SVG card), `purge`, `rules list|show|test`.
- Output as table, JSON, SARIF 2.1.0, and ECS or OCSF NDJSON.
- `preflight`: check a cloned repo's agent surface before opening it with an agent.
- `hook`: optional live PreToolUse guard (log, confirm or block) running only `enforce`-lane rules; fails open, checks
  its install path.
- `mcp`: read-only MCP server over the index.
- Ignore file for known-benign findings. Zero network calls, secrets masked everywhere.

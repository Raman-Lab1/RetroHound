# Changelog

All notable changes to this project are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- `rules convert -t <backend> --pipeline ecs|ocsf [rules...]`: converts rules to SIEM queries over the `ndjson-ecs` /
  `ndjson-ocsf` exports with a sigma-cli already on your PATH (nothing is installed or downloaded; without it, exit 2).
  The pySigma pipelines ship in `integrations/pysigma/`; fields an export lacks and derived fields fail the rule.
- `scan` writes a footprint report by default: `index.footprint.html` next to the index (named after it), one offline page (no scripts,
  nothing fetched) with everything the index holds about the agents on this machine: trust in the data, activity,
  agent/project/session/sub-agent tree, MCP servers, hooks, skills and plugins, domains, secrets to rotate,
  permission modes, blocked calls and findings. `--report <file>` moves it, `--no-report` skips it; `--no-index` and
  machine formats never write it, and it may not overwrite the index. `purge` deletes it with the index.
- Footprint report: configured versus used. The agents' config files (MCP servers, hooks, skills, plugins; user,
  project, local and managed scopes) are read for names and hook commands only, and set against what transcripts show
  was used: never-used items are flagged, and used items that no config file sets up now are listed.
- Config snapshots: every indexed scan stores what the agents' config files set up (name, scope, file and a sha256 of
  the masked entry, never a value; the last 10 scans kept, outside the hash chain). The footprint report shows what is
  new, changed and removed since the scan before. Index schema version 4; the first scan upgrades it.
- Codex collector (`codex/v4`): MCP tool calls are indexed as `mcp` events (`mcp__<server>__<tool>`, `mcp_server`,
  `mcp_tool`, arguments, result, outcome), so MCP rules fire on Codex and the footprint shows which Codex MCP servers
  were used. Codex rollouts are re-read once.
- Codex collector (`codex/v5`): file edits made with `apply_patch` are indexed as `file_event`s, one per changed file,
  with the content written, so the file rules (agent config writes, MCP servers added, secrets written) fire on
  Codex edits, not only on its shell commands.
- `scan --format attack-layer`: a MITRE ATT&CK Navigator layer (format 4.5) of the techniques this scan's findings map
  to, scored by finding count, with the rules behind each technique in its comment.
- Footprint: a configured Claude Code plugin also counts the calls on its own MCP servers (`plugin_<plugin>_<server>`),
  each call once next to its attributed calls and its skills' calls.

### Changed
- Agent-config rules (`files_mcp_server_added`, `control_plane_agent_config_*`) also cover Codex (`.codex/config.toml`
  `[mcp_servers]`, `[hooks]` and `base_url`, `.codex/hooks.json`) and Antigravity (`.gemini/config/mcp_config.json`,
  `hooks.json`, project `.agents/`) config files.

### Fixed
- `incident` and `wrapped` pages: no whole-page mask pass after escaping, which could swallow markup after a short
  `token=` value. Every value was already masked.

## [0.2.0] - 2026-11-09

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

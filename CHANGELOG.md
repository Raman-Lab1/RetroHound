# Changelog

All notable changes to this project are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

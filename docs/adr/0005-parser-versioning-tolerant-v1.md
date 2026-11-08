# 0005. Parsing: one tolerant parser per agent, versioned for re-indexing

- Status: Accepted
- Date: 2026-11-07
- Related: 0002 (`files_indexed`), 0004 (stream identity), 0006

## Context
Agent transcript formats are undocumented and change often. Across Claude Code 2.1.202 to 2.1.319 (67k lines of real
history) the envelope stayed stable (uuid chain, `message.content[]`, `tool_use.id` paired with
`tool_result.tool_use_id`, `toolUseResult`) and every change was additive: no malformed lines, two unknown line
types. `version` is per line, `cwd` can change within a session, and the encoded project directory name is lossy.
Sub-agents write `<sessionId>/subagents/agent-<agentId>.jsonl` with the parent's `sessionId`. Codex CLI and
Antigravity CLI have their own formats (docs/formats/).

## Options considered
- One parser per agent version, chosen by a detector. Dozens of near-identical files for additive changes. Rejected.
- **One tolerant parser per agent, with a parser version that forces a re-index when the mapping changes.** Chosen.

## Decision
- One collector per agent under `src/collectors/` (`claude-code`, `codex`, `antigravity`, plus `repo` for
  `preflight`). Each switches on the line type, uses optional access throughout, skips known metadata lines (and
  `api-request-blob`, which duplicates tool calls), and counts lines it cannot use. A bad line is counted and shown in
  the scan summary, never fatal.
- Each collector declares a `parserVersion` (for example `claude-code/v2`). `files_indexed` stores it, and a change
  re-indexes the affected files.
- **Events:** one per tool call; prompt and assistant text; @-mentioned files as `file_access`; loaded instruction
  files as `instruction_load`; hook runs as `process_creation` with `tool_name: hook:<Event>` and the hook command as
  `command_line`; permission-mode lines as `config_change`. The outcome comes from the denial fields, then `is_error`.
  Results arrive on later lines, so a file's events are buffered and their outcomes filled in at the end.
- **Identity:** `session_id` is the agent's own session id, so it joins with hook payloads. Sub-agent events carry
  `agent_id`, main-file events none; `seq` is the line order within a file. The spawn link is stored as
  `parent_tool_use_id` (the parent's `Agent` call, from `meta.json` or `toolUseResult.agentId`).
- The mapping from one tool call to one event is a single exported function (`mapToolUse`), reused by the live hook
  (0009) and the Codex collector, so a rule sees the same fields whatever the source.
- Field-by-field notes per agent: `docs/formats/claude-code.md`, `codex.md`, `antigravity.md`.

## Consequences
- Golden files in `tests/collectors/golden/` pin the output on redacted real transcripts; a deliberate mapping change
  updates them and bumps the parser version.
- Hook events make a repository-planted hook visible even when the agent itself called no tool.
- Older formats (inline sidechains, flat `agent-*.jsonl` files) are not parsed. Support would be added when a real
  sample is available.

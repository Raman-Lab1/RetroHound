# GitHub Copilot CLI session format (not yet observed)

Looked at 2026-11-23 on a macOS machine with Copilot CLI installed and used. **No session transcript exists to
inspect**, so there is no parser and no collector (CLAUDE.md: inspect real transcripts before writing any parser).
This page records what was seen locally, and separately what third parties report, so the collector can be built
the day a real sample is available.

## Observed locally

```
~/.copilot/config.json                managed file, JSON with `//` comment header; one key (`firstLaunchAt`). User settings live in settings.json (absent)
~/.copilot/session-state/<uuid>/      4 session directories, all EMPTY (0 files)
~/.copilot/logs/process-<ms>-<pid>.log  plain text runtime logs, one per process start (10 files, 1 to 20 KB)
~/.copilot/ide/<uuid>.lock            IDE bridge lock file
~/.copilot/installed-plugins/         empty
```

- The empty session directories are not an error in the product: the directory is created at session start and the
  session record is not written to disk here. Likely causes (unconfirmed): sessions ended before any event was
  flushed, or the CLI version in use keeps the record in its account-side store only.
- The logs are `<ISO-8601 timestamp> [LEVEL] [component] message` lines: runtime start-up, managed-settings policy
  resolution, MCP client connect and, in some files, session attach (`SDK session attached: sha256:...`; seen in only
  one of the files checked, so version-specific). They carry no tool calls,
  commands or prompts, so they are not a source of events. They may contain the GitHub account login
  (not reproduced in the files checked) and home paths: never read them into the index. A start-up warning line
  shows the CLI itself makes network calls; RetroHound does not.
- Nothing in `config.json` or the logs states the CLI version.

## Reported by third parties (unverified here)

Sources: community tools that read the files (tokscale, ccusage, coding_agent_session_search, agent-sessions) and
the github/copilot-cli feature request asking GitHub to document `events.jsonl` as an integration API. There is no
official schema, so every field name below is version dependent.

- Layout since CLI 1.0.11: `~/.copilot/session-state/<session-uuid>/events.jsonl` plus `workspace.yaml` (flat YAML
  session metadata). Older layout: `~/.copilot/session-state/<uuid>.jsonl`.
- Line: JSON object `{type, data, timestamp?}`.
- Reported types: `session.start` (version, cwd, model), `session.shutdown` (per-model token and request totals),
  `session.model_change`, `session.mode_changed`, `session.plan_changed`, `session.compaction_start/complete`,
  `session.task_complete`, `session.truncation`. Tool-call, user-message and permission event names are not
  confirmed by any source read, so they are not listed.

## Privacy and product notes

- Copilot CLI syncs sessions to the user's GitHub account by default. The local file is therefore not the only copy,
  and a session's content has already left the machine before RetroHound reads it. RetroHound itself makes no
  network call and does not use that store.
- Home paths and, where present, the account login and `sha256:` session handles in the logs are identifying: mask or skip.

## What to capture before building the collector

One real `events.jsonl` (and `workspace.yaml`) from a session that ran a shell command, a file edit, a web fetch and
an MCP tool, and one with a denied permission. Fields to confirm: tool-call and tool-result event types, how the
shell command and cwd are carried, session id and model fields, timestamp presence per line, whether permission
requests and denials are persisted, and the CLI version. Then add `src/collectors/copilot/` (parserVersion
`copilot/v1`, agent `copilot_cli`) following the codex collector.

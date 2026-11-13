# Codex CLI rollout format (observed)

Observed 2026-11-07 on a Windows 10 machine: 3 rollouts (1 root thread for the worktree setup, 1 root thread
for a scripted test task, 1 sub-agent thread), 278 lines, 0 malformed. A later look added 1 guardian thread and a
second turn in the root thread (370 lines): npm installs and `npx` runs, so package-install rules have real input. `cli_version` 0.167.0, `originator`
`codex-tui`, `source` `vscode`. Approval policy `on-request`, sandbox `workspace-write` with `network_access: false`.
No `.jsonl.zst` yet (Codex compresses rollouts older than 7 days, R2 finding 2), no archived sessions.

This is an undocumented internal resume format. Everything below is what was seen, not a contract. Values are
placeholders; no prompt text, command output or file contents are reproduced. Older versions differ.

## Layout on disk

```
$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<YYYY-MM-DDThh-mm-ss>-<thread-uuid>.jsonl   one file per thread, sub-agents too
$CODEX_HOME/sessions/.../*.jsonl.zst                                              same, zstd, after 7 days (R2)
$CODEX_HOME/archived_sessions/...                                                 `codex archive` (R2)
$CODEX_HOME/session_index.jsonl, state_5.sqlite (threads, thread_spawn_edges)     indexes; do not depend on them (R2)
```
`$CODEX_HOME` defaults to `~/.codex`.

## Line envelope

Every line: `{ "timestamp": ISO-8601, "type": <line type>, "ordinal": <int, 0-based, per file>, "payload": {...} }`.

| Line type | Count | Use |
|---|---|---|
| `response_item` | 146 | model I/O: `message`, `reasoning`, `custom_tool_call(_output)`, `function_call(_output)`, `additional_tools`, `agent_message` |
| `event_msg` | 85 | `item_completed` (the structured actions, below), `task_started`, `task_complete`, `turn_aborted`, `token_count`, `thread_settings_applied` |
| `token_usage_record` | 23 | ignore |
| `world_state` | 14 | `{full, state}`; ignore |
| `session_meta` | 4 | thread header (a sub-agent file has two: its own, then the parent's, see below) |
| `turn_context` | 4 | per turn: `cwd`, `model`, `approval_policy`, `sandbox_policy`, `permission_profile`, `turn_id` |
| `inter_agent_communication_metadata` | 2 | `{trigger_turn}` around sub-agent messages |

## Thread header (`session_meta.payload`)

`id` (thread uuid, also in the file name), `session_id`, `timestamp`, `cwd` (native path, here `C:\...`),
`cli_version`, `originator`, `source`, `git` (branch/commit), `model_provider`, `history_mode`, `base_instructions`
(large system text: skip), `creator_user_id`/`creator_account_id` (account ids: never store unmasked).

Sub-agent thread, extra keys: `source: {subagent: {thread_spawn: {parent_thread_id, depth, agent_path,
agent_nickname}}}`, `parent_thread_id`, `forked_from_id`, `agent_path` (e.g. `/root/<task_name>`), `agent_nickname`,
`multi_agent_version`, **`subagent_history_start_ordinal`**.

**Forked history:** a sub-agent spawned with `fork_turns: "all"` starts its file with a copy of the parent's history
(here ordinals 0–57 of 86, including the parent's `session_meta`, tool calls and a `turn_aborted`). Lines with
`ordinal < subagent_history_start_ordinal` are copies and must be skipped, or every parent action is counted twice.

## Actions: use `event_msg` / `item_completed`, not the tool-call text

0.167 runs tools in "code mode": the model emits a `custom_tool_call` named `exec` whose `input` is a JavaScript
snippet calling `tools.exec_command({cmd, workdir, sandbox_permissions})`, `tools.web__run({open: [...]})`, etc. That
text is not a stable structure. The structured record of what ran is `event_msg.payload.item` with
`type: "item_completed"`:

| `item.type` | Count (main thread) | Fields seen | RetroHound event |
|---|---|---|---|
| `CommandExecution` | 11 | `command` (argv: on Windows `[pwsh.exe, -Command, <script>]`), `cwd` (**`file:///C:/...` URI**), `parsed_cmd[]` (`{type: unknown|read|listFiles|search, cmd}`), `exit_code` (int; `-1` when the process could not start), `status` (`completed`, `failed`), `aggregated_output` (truncated, R2), `duration {secs, nanos}`, `source` (`unified_exec_startup`), `process_id` (absent on spawn failure) | `process_creation`; `command_line` from `parsed_cmd[].cmd` (else the last argv element); `outcome` success/error |
| `FileChange` | 15 in 48 rollouts (later look, macOS) | `changes` (object: absolute native path -> `{type: add, content}` or `{type: update, unified_diff, move_path}`; `move_path` always null so far), `status` (`completed`), `stdout`, `stderr` | `file_event`, one per changed path |
| `McpToolCall` | 11 in 48 rollouts (later look) | `server`, `tool`, `arguments` (object), `status` (`completed`, `failed`), `result {content[] {type: text, text}, isError}`, `duration {secs, nanos}` | `mcp` (or `web_request` with a URL argument) |
| `Extension` (`kind: web.search`) | 1 | `query`, `action {type: openPage, url}` (or a search), `results[] {domain, title, ref_id, snippet}` | `web_request` (`url`, `domain`) |
| `SubAgentActivity` | 2 | `kind` (`started`, `completed`), `agent_thread_id`, `agent_path`, `model`, `reasoning_effort` | links parent and child thread |
| `UserMessage` | 1 | `content[] {type: text, text}` | `user_prompt` (`text_excerpt` masked) |
| `AgentMessage` | 10 | `content`, `phase` | `assistant_text` (match-only) |
| `Reasoning` | 14 | `raw_content`, `summary_text` | skip |

Other tool calls seen as `function_call`: `wait` (`{cell_id, yield_time_ms, max_tokens}`, polling a running exec
cell: skip) and `spawn_agent` (`{task_name, fork_turns, message}`; **`message` is an opaque encrypted blob**, so the
sub-agent's instructions cannot be read from the parent; the child's own `UserMessage`/history holds them).

## What is not in the rollout

- **Approvals and denials.** 0 approval records in 278 lines. The TUI's "You approved codex to run …" lines and the
  approval mode chosen per command are not persisted. The model's request for escalation is visible
  only inside the `exec` script text (`sandbox_permissions: "require_escalated"`). A denied command that never ran
  leaves no trace. `outcome: blocked` for Codex needs the hook (R2), not the transcript.
- **File writes as structured items (first run).** That run wrote files through shell commands (`Set-Content`,
  `New-Item`) and had no file-change item. The later look found 15 `FileChange` items (the `apply_patch` tool): 26
  paths, 10 `add` and 16 `update`. Shell writes stay shell commands.
- **Skill and hook runs.** Not recorded. The only skill markers are `response_item` messages with
  `content_item_metadata.provenance.type` `skills` / `content_item_kinds` `host_skills.instructions`: the list of skills
  offered to the model at session start, not a skill being used. Hook markers are `provenance {type: harness, hook}`,
  `hook: false` on all 21 seen; no hook event type exists in 48 rollouts.
- **Interrupts:** `event_msg` `turn_aborted {type, turn_id, root_turn_id, reason: "interrupted", started_at}` marks a
  turn that was stopped. No `item_started` is persisted (0 in 522 lines): a command that never finished has no item at
  all. What links a call to its turn is position: calls follow the turn's `task_started`/`turn_context` (`turn_id`).
  The only `turn_aborted` seen so far is the one Codex writes into a forked sub-agent's copied parent history (right
  after the parent's unanswered `spawn_agent` call, before `subagent_history_start_ordinal`), so it is skipped with the
  copy; no user interrupt has been recorded yet.
- **Exec cells:** a `custom_tool_call` `exec` (`call_id`) is answered by `custom_tool_call_output` whose text starts
  `Script completed` / `Script failed`, or `Script running with cell ID <id>` when the cell yielded while still
  running. The model then polls with `function_call` `wait {cell_id, yield_time_ms, max_tokens}`; its
  `function_call_output` starts the same way. 6 cells yielded in the main thread; every one was later reported
  completed. `SubAgentActivity` item ids equal the `spawn_agent` `call_id`; `CommandExecution` item ids do not match
  any call id (a cell can run several commands).

## Guardian (auto-review) threads

With `approvals_reviewer: auto_review`, Codex writes a separate rollout per reviewed action: `session_meta.source`
`{subagent: {other: "guardian"}}`, model `codex-auto-review`, `turn_context.approval_policy: never`,
`task_started.turn_attribution.turn_trigger: guardian_review` with `parent_turn_id` (the reviewed turn). Its input is
the parent history plus the planned action (one large user message); its result is the last assistant message and
`task_complete.last_agent_message`, a JSON object `{risk_level, user_authorization, outcome, rationale}` (seen:
`low`, `high`, `allow`). An `outcome` other than `allow` is the only persisted record of Codex refusing an action, so
it maps to `outcome: blocked` for the reviewed call. These threads are not user sessions: attribute them to the
parent turn, never count them as sessions.

## Secrets

The rollout stores raw values: the test placeholder secret appears 12 times in the main thread (tool input, command,
output), although the TUI displayed it as `[REDACTED_SECRET]`. Masking at collection is needed exactly as for Claude
Code (ADR 0006, 0007).

## Open questions (need more runs)

- `FileChange` `status` other than `completed`, a `delete` change and a set `move_path`; `.jsonl.zst` files (after 7 days).
- Whether a denied escalation writes anything when the user picks "No" in the approval prompt (this run had none).
- The Codex Desktop "legacy" imports of Claude Code sessions must be skipped to avoid double counting.

## Collector mapping (`codex/v5`, src/collectors/codex)

Checked on the 4 local rollouts: 522 lines, 0 malformed, 0 crashes, 2 root sessions (sub-agent and guardian threads
grouped under their root). Counts only; no real text is reproduced here or in the tests. v2 on the same files: the same
62 events by category and outcome as v1 (no interrupt outside a forked copy, so no blocked event).

- **Session and agent:** `session_id` = `session_meta.session_id` (a sub-agent's and a guardian's equals its parent's
  thread id, observed at depth 1; deeper nesting is unverified). Sub-agent events get `agent_id` = `agent_path` (else
  thread id). `groupKey` = `codex:<root id>` from the first line, else the uuid in the file name.
- **Forked history:** lines with `ordinal < subagent_history_start_ordinal` are skipped; only the first `session_meta`
  of a file is used.
- **Guardian:** not a session. A verdict `outcome` other than `allow` gives one event on the parent session:
  `tool_call`, `tool_name: guardian_review`, `outcome: blocked`, `denial_kind` = outcome, `denial_category` = risk level,
  `text` = rationale, `tool_input` carries `parent_turn_id`. Gap: which call of that turn was judged is not recorded.
- **Items:** `CommandExecution` -> `process_creation`, `tool_name` PowerShell (pwsh/powershell), `cmd`, else Bash;
  `command_line` = the script after `-Command`/`-c`/`-lc`/`/c`, else argv joined; outcome from `status` and `exit_code`;
  `aggregated_output` -> `tool_response`. `Extension` web.search -> `web_request` as `WebFetch` (openPage url) or
  `tool_call` `WebSearch`. `McpToolCall` (v4) -> `tool_name` `mcp__<server>__<tool>` (the name Codex hooks use), `mcp_server` and
  `mcp_tool` taken as given (not split from the name), `tool_input` = `arguments`, `tool_response` = the result text;
  `mcp`, or `web_request` when an argument is a URL (as for Claude Code); outcome `error` when `status` is `failed` or
  `result.isError`, `success` when `completed`, else `unknown`. Seen: 7 completed / not error, 4 failed / `isError`.
  `FileChange` (v5) -> one `file_event` per changed path (an empty path is skipped), `tool_name` `apply_patch`,
  `target_path` the path, or `move_path` when set (where the content lands), slashes normalised and a relative path
  resolved against the turn's cwd; `tool_input` = the raw change plus `path`; `content` = the whole file for `add`, the
  diff's added lines for `update` (`+` lines from the first `@@`; real diffs start there, a `---`/`+++` header before it
  is skipped), none for `delete`, so the file rules see what was written. A secret on a removed line or in a deleted
  file's text is still flagged through `tool_input`. Outcome `success` for `completed`, `error` for `failed`, else
  `unknown`. Delete and move are unseen (no sample). Checked: a synthetic add of `.mcp.json` with `mcpServers` fires `files_mcp_server_added` and
  `control_plane_agent_config_write`; the 26 real paths fire nothing.
  `UserMessage` -> `user_prompt` (`prompt_source` typed, or system in a sub-agent).
  `AgentMessage` -> `assistant_message`. `SubAgentActivity` `started` -> `tool_call` `Agent`. Reasoning, `completed`
  sub-agent items and other `response_item` lines produce nothing.
- **Interrupts (v2):** follows Claude's interrupted tool_result (`outcome: blocked`, `denial_kind: interrupted`). In
  flight = a `custom_tool_call`/`function_call` (not `wait`) with no output yet, or an exec cell whose last answer was
  `Script running with cell ID <id>`. On `turn_aborted`, each in-flight call of that `turn_id` (all, if the abort has
  none) gives one `tool_call` event: `tool_name` = the call name (`exec`, `spawn_agent`, ...), `tool_input` = its raw
  `input`/`arguments`, `ts` and `raw_ref` = the call line, `outcome: blocked`, `denial_kind` = the abort `reason`
  (`interrupted`). A pre-paginated shell call already has an event: it is marked instead, not duplicated. Nothing in
  flight -> nothing added. Which commands inside an interrupted cell had started is not recorded.
- **`parsed_cmd` `read` (decision, v2): no extra `file_access` event.** A shell read (`cat .env`, `Get-Content .env`)
  stays one `process_creation` event, as for Claude's Bash. `secrets_read_secret_file` (enforce lane) is the Read-tool
  rule on purpose; shell readers are `secrets_read_secret_file_shell` (hunt lane, benign on real history). A synthetic
  `file_access` would move every shell read into the enforce rule and report one action twice. Also, `parsed_cmd`
  entries seen carry only `{type, cmd}` (no `path`), so the path would have to be re-parsed from the command.
- **Pre-paginated rollouts** (`history_mode` not `paginated`): shell `function_call` (`shell`, `exec_command`, ...) is
  read with `outcome: unknown`. Untested on real data.
- **Compressed files:** `.jsonl.zst` is read with `node:zlib` `zstdDecompressSync` (present in Bun 1.4.4 and Node 24).
  Without it `parseFile` throws "needs Node >= 22.15 to read .jsonl.zst", which the scan reports as a failed file. Ids use
  the path without `.zst`.
- **Legacy Claude imports:** `discover` skips rollouts whose uuid is an `imported_thread_id` in
  `external_agent_session_imports.json` (field names from R2; no such ledger on the local machine, so unverified).

## Configuration surface (`src/footprint/config-codex.ts`, footprint "configured versus used")

Checked 2026-11-10 on macOS (Codex Desktop + CLI) by key names and table headers only, against the
[config reference](https://learn.chatgpt.com/docs/config-file/config-reference), [hooks](https://learn.chatgpt.com/docs/hooks)
and [skills](https://learn.chatgpt.com/docs/build-skills) docs. `$CODEX_HOME` defaults to `~/.codex`.

| What | Location (scope) | Key path | Item `name` | Seen here |
|---|---|---|---|---|
| MCP server | `$CODEX_HOME/config.toml` (user), `<project>/.codex/config.toml` (project, trusted projects only) | `[mcp_servers.<name>]`; `command` = stdio, `url` = streamable HTTP; `enabled = false` drops it | `<name>` | both |
| Hook | `$CODEX_HOME/hooks.json` (user), `<project>/.codex/hooks.json` (project) | `hooks.<Event>[].hooks[].command`, the Claude Code shape | the command (masked), `detail` `hook:<Event>` | project only |
| Hook (inline) | the same `config.toml` files | `[[hooks.<Event>]]` / `[[hooks.<Event>.hooks]]` `command = '...'` | as above | docs only |
| Plugin | `$CODEX_HOME/config.toml` (user) | `[plugins."<plugin>@<marketplace>"]`, `enabled` | `<plugin>` (Claude Code's indexed `plugin:<x>` has no `@`) | yes |
| Skill | `$HOME/.agents/skills/<dir>/SKILL.md`, `$CODEX_HOME/skills/<dir>/SKILL.md` (user), `<project>/.agents/skills/<dir>/SKILL.md` (project) | frontmatter `name` | `name`, else `<dir>` | project only |

Not read: env, args, headers, URLs, tokens (only key names decide the transport); plugin-bundled hooks, MCP servers and
skills (`plugins/cache/<marketplace>/<plugin>/<version>/`: config does not say which version is active); managed
`requirements.toml`; `/etc/codex/skills`; `.agents/skills` in parent folders up to the repo root; project trust
(`projects.<path>.trust_level`), so an untrusted project's files are listed too. TOML is a line scan, not a parser:
inline tables, dotted keys outside a header and multi-line hook commands are not read (the last are reported skipped).

**Join with the index.** MCP servers: checked. Since `codex/v4` the rollout's `McpToolCall.server` fills `mcp_server`,
and locally it matched 1 of 4 configured servers by name; one more server in use is a built-in no config file sets up.
Names with `-` or `.` (2 of the 4 configured) were never seen in a rollout, so whether Codex keeps them as written there
is unchecked; if it does not, those servers read "never seen used".
**Live hook versus rollout.** The hook (`retrohound hook`, src/hooks/agents.ts) turns Codex's `apply_patch` into the
same `file_event`s as the rollout: `patchChanges` reads the `*** Add/Update/Delete File:` headers (and `*** Move to:`)
from any string in `tool_input` and hands them to the rollout's FileChange mapping, so file rules decide live in
`hook --mode log|block` as well as on `scan`. A patch with no file header stays one `tool_call`. The live
`tool_input` shape for `apply_patch` has not been seen yet (R2), which is why any string field is searched.
Hooks, skills and plugins: checked, not recorded in rollouts (see "What is not in the rollout"), so the collector fills
no `attribution` or `hook:` event for Codex and the page says their use is not recorded.

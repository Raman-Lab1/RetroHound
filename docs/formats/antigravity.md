# Antigravity CLI (`agy`) transcript format (observed)

Observed 2026-11-07 on a Windows 10 machine: 2 conversations from one scripted test task (1 root, 1 sub-agent),
`transcript_full.jsonl` 44 + 6 lines, 0 malformed, every step `status: DONE`. Antigravity CLI is Google's consumer
successor to Gemini CLI. The older Antigravity IDE store (`~/.gemini/antigravity/conversations/*.pb`,
protobuf) is a different product and is not covered here.

This is an undocumented internal log. Everything below is what was seen, not a contract. Values are placeholders; no
prompt text, file contents or command output are reproduced.

## Layout on disk

```
~/.gemini/antigravity-cli/brain/<conversation-uuid>/.system_generated/
  logs/transcript_full.jsonl        one line per step, with tool calls and tool results   <- parse this
  logs/transcript.jsonl             same steps, results trimmed (44 lines here too)
  logs/chunks/transcript{,_full}/NNNNNNNN.jsonl   chunked copies of the above
  steps/<step_index>/output.txt     full output of a command or tool step (only for steps with output)
  messages/<uuid>.json, read.json   inter-agent messages {id, sender, recipient, priority, timestamp, ...}
  messages/undelivered/             directory (not readable as a file)
  subagents/<child-conversation-uuid>.json   {conversationId, subagentDescriptor {typeName, role}, state, spawnStepIndex, workspaceUris[]}
~/.gemini/antigravity-cli/annotations/<conversation-uuid>.pbtxt   protobuf text: conversation title only
~/.gemini/antigravity-cli/conversation_summaries.db   SQLite index, one row per conversation: workspace (below)
~/.gemini/antigravity-cli/history.jsonl   one line per typed prompt {display, timestamp, workspace, conversationId?}
~/.gemini/antigravity-cli/{settings.json, cli.log, conversations/*.db, ...}   not needed
```

### Which workspace a conversation ran in (checked 2026-11-07, shapes only)

| Source | Shape | Seen |
|---|---|---|
| `conversation_summaries.db` table `conversation_summaries` | `conversation_id`, `workspace_uris` (JSON list of `file:///` URIs, `""` when unknown), `parent_conversation_id`, `nesting_depth`, `project_id`, `title`, `preview`, ... | 7 rows; both brain conversations (root and sub-agent) have a workspace, equal to the link file's; 2 rows (no brain dir) empty |
| `brain/<parent>/.system_generated/subagents/<child>.json` | `workspaceUris[]` | the child's own; nothing for a root without sub-agents |
| `history.jsonl` | `workspace` (native path), `conversationId` | 2 lines; the prompt that creates a conversation has no `conversationId` |
| `cli.log` | `workspaceDirs=[...]` once per CLI start, conversation ids on other lines | not tied to a conversation by structure: not used |
| `annotations/*.pbtxt` | `title:` only | no workspace |
| USER_INPUT `<ADDITIONAL_METADATA>` | a local timestamp only | no workspace |

A sub-agent is its own conversation directory. The parent links to it through `subagents/<child>.json`
(`spawnStepIndex` = the parent step that created it); the child's first step is a `SYSTEM_MESSAGE` from the parent's
conversation id. There is no copied parent history in the child (unlike Codex).

## Step line

Keys: `step_index` (int, per conversation), `source` (`USER_EXPLICIT`, `MODEL`, `SYSTEM`), `type`, `status`
(`DONE` only, so far), `created_at` (ISO-8601 UTC, second precision), plus by type:

| `type` | Count (root) | Extra keys | RetroHound event |
|---|---|---|---|
| `USER_INPUT` | 2 | `content` (`<USER_REQUEST>…</USER_REQUEST>` plus `<ADDITIONAL_METADATA>`) | `user_prompt` |
| `PLANNER_RESPONSE` | 22 | `tool_calls[] {name, args}`, `thinking`, `content` (assistant text), token counts | one event per tool call |
| `GENERIC` | 19 | `content`: the tool result as text, starting `Created At: … / Completed At: …` | result of the preceding call |
| `SYSTEM_MESSAGE` | 1 | `content` (inter-agent message notice) | skip |

The result of a tool call is the next `GENERIC` step. Command results contain `Command exited with code N.`; the full
output is in `steps/<step_index>/output.txt`.

## Tool calls seen

| `name` | `args` keys | RetroHound event |
|---|---|---|
| `run_command` | `CommandLine`, `WaitMsBeforeAsync`, `toolSummary` | `process_creation` (`command_line`); outcome from `exited with code N` |
| `read_file` | `Path` (forward-slash Windows path) | `file_access` (`target_path`), like Claude's Read, so the secret-read rules apply |
| `write_file` | `Path`, `Content`, `Overwrite` | `file_event` write (`content` match-only) |
| `edit_file` | `Path`, `Target`, `Replacement` | `file_event` edit (`content` = Replacement, match-only) |
| `search_web` | `query` | `web_request` (a URL as query counts as `url`) |
| `invoke_subagent` | `Model`, `Prompt`, `Role`, `TypeName` | `tool_call` (sub-agent spawn), link via `subagents/` |
| `ask_question` | `questions[] {question, options[], is_multi_select}` | the agent's own approval question; the answer is in the result (`A1: <option>`) |

## Approvals, denials, interrupts

- The test asked the agent to request approval before a delete; it did so with `ask_question`, and the answer was
  recorded (`A1: Approve` in this run). This is agent-level, not the CLI's own permission gate.
- A tool call that never ran leaves a **gap**: step 5's `run_command` has no result step, step 6 is absent, and the
  next step is a new `USER_INPUT`. Whether the CLI's own permission prompt writes anything on rejection is not known
  yet; the gap is the only trace seen. Treat an unmatched call as `outcome: unknown`, not blocked.

## Secrets

Raw values are stored: the test placeholder secret appears 7 times (write args, read result, user prompt). Mask at
collection (ADR 0006, 0007).

## Collector decisions (`src/collectors/antigravity`, parser `antigravity/v3`)

- Parses `transcript_full.jsonl` only. Calls become events in step order; assistant `content` is an
  `assistant_message`. `tool_name` stays Antigravity's own (`run_command`, ...), not Claude's (`Bash`).
- Pairing: each `GENERIC` result goes to the oldest unpaired call; a new `PLANNER_RESPONSE` or `USER_INPUT` drops any
  call still waiting, which keeps `outcome: unknown`. `run_command` outcome is from `Command exited with code N`
  (0 success, else error; no code, e.g. an async command, stays `unknown`). Other tools: `success` once a result exists.
- `ask_question`: `tool_input` has the question, `tool_response` the answer. A `Deny` answer is NOT mapped to
  `blocked`/`denial_kind`: it is a model-authored dialog, not the CLI's permission gate, and which action it guards
  is not recorded.
- Unknown tool names stay a generic `tool_call` and are counted in `stats.unknown_types` as `tool:<name>` (seen in
  the real data: `send_message`). Unknown step types are counted under their `type`; `SYSTEM_MESSAGE` is skipped.
- Sub-agents: `session_id` = root conversation id, `agent_id` = the child conversation id. The child-to-parent map is
  built from `subagents/<child>.json` under the same `brain/` (memoized per process). `groupKey` = brain dir + root id.
- `project_path` (v2), first found of: (1) `conversation_summaries.db` `workspace_uris[0]` for the conversation id
  (opened read-only through `src/store/sqlite.ts`; a missing, locked or reshaped db is skipped); (2) the sub-agent link
  file's `workspaceUris[0]` (a root takes its first child's); (3) `history.jsonl` `workspace` for that
  `conversationId`. File URIs are decoded, slashes normalized. A conversation in none of them has no `project_path`;
  it is never guessed from the paths that file tools touched. v1 had only (2), so a root without sub-agents had none.
- Event id = sha256(file, step_index, sub-index). No `parent_tool_use_id` (calls have no ids).

## Open questions

- Behaviour when the CLI's permission prompt is rejected, MCP tool calls, browser tool steps, `status` values other
  than `DONE`, and how long `brain/` directories are kept.

## Configuration surface (`src/footprint/config-antigravity.ts`, footprint "configured versus used")

Checked 2026-11-10 on macOS by key names only, against the [MCP](https://antigravity.google/docs/mcp),
[hooks](https://antigravity.google/docs/hooks) and [skills](https://antigravity.google/docs/skills) docs.

| What | Location (scope) | Key path | Item `name` | Seen here |
|---|---|---|---|---|
| MCP server | `~/.gemini/config/mcp_config.json` (user), `<project>/.agents/mcp_config.json` (project), `~/.gemini/config/plugins/<p>/mcp_config.json` (plugin) | `mcpServers.<name>`; `command` = stdio, `serverUrl`/`url` = HTTP; `disabled: true` drops it | `<name>` | user file exists, empty (0 bytes): read as nothing configured |
| Hook | `~/.gemini/config/hooks.json` (user), `<project>/.agents/hooks.json` (project) | `<group>.<Event>[]`: `PreToolUse`/`PostToolUse` entries `{matcher, hooks[].command}`, other events handlers `{command}` directly; `<group>.enabled: false` drops the group | the command (masked), `detail` `hook:<Event>` | docs only |
| Plugin | `~/.gemini/config/plugins/<folder>/` (user) | folder name | `<folder>` | docs only |
| Skill | `~/.gemini/config/skills/`, `~/.gemini/skills/`, `~/.gemini/antigravity-cli/skills/` (user), `<project>/.agents/skills/`, `<project>/.agent/skills/` (project), `<plugin>/skills/` (plugin); each `<dir>/SKILL.md` | frontmatter `name`, defaults to the folder | `name`, else `<dir>` | `~/.gemini/skills` (symlinked folders, skipped as outside the directory), project |

Not read: env, args, headers, URLs; `~/.gemini/antigravity-cli/settings.json` (the hooks doc says it is not loaded for
hooks); built-in skills (`antigravity-cli/builtin/skills`); a plugin's own hooks file (path not documented);
`.agents/skills` in parent folders.

**Join with the index: unverified.** The collector (`antigravity/v3`) fills no `mcp_server`, `attribution` or
`hook:` event, and the local index holds no Antigravity sessions. Per the MCP doc an eager tool is called as
`mcp_<server>_<tool>` and a lazy one through `call_mcp_tool {ServerName, ToolName}`: either way `<server>` is the
`mcpServers` key, which is the item name.

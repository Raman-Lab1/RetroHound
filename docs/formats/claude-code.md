# Claude Code transcript format (observed)

Observed 2026-11-07 from `fixtures/raw/` (copies of `~/.claude/projects/**`): 8 main sessions,
48 subagent transcripts, 56 `.jsonl` files, 24,498 lines, 0 malformed lines.
Claude Code versions seen (`version` field): 2.1.293, 2.1.295, 2.1.296, 2.1.299, 2.1.316, 2.1.317, 2.1.318.
Models seen (`message.model`): claude-opus-5-5, claude-opus-4-8, claude-sonnet-5-5, claude-haiku-5-5, `<synthetic>` (locally generated error/refusal messages).

Full-history scan (186 files / 67,434 lines, RetroHound project excluded) additionally saw versions
2.1.202, 2.1.219, 2.1.255, 2.1.284, 2.1.290–2.1.292, 2.1.294, 2.1.300, 2.1.311–2.1.314 (range 2026-07-09 → 2026-11-06),
and two line types absent from fixtures: `bridge-session` (15) and `continued-in` (1). No malformed lines.

This is an undocumented internal format. Everything below is what was seen, not a contract.
Values below are placeholders; no prompt text or file contents are reproduced.

## Layout on disk

```
~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl                 main transcript
~/.claude/projects/<encoded-cwd>/<sessionId>/subagents/agent-<agentId>.jsonl
~/.claude/projects/<encoded-cwd>/<sessionId>/subagents/agent-<agentId>.meta.json   {agentType,isBuiltIn,description,toolUseId,spawnDepth,requestShape,finished,...}
~/.claude/projects/<encoded-cwd>/<sessionId>/subagents/agent-<agentId>.prefix.json {v,by,outlines,state}
~/.claude/projects/<encoded-cwd>/<sessionId>/tool-results/*.jpg|png  large/binary MCP tool outputs
~/.claude/projects/<encoded-cwd>/<sessionId>/custom-title.json    {customTitle}
```

`<encoded-cwd>` = cwd with `/` (and `_`, `.`) replaced by `-`, e.g. `-Users-<user>-Desktop-<project>`.
Lossy: use the per-line `cwd` field for the real path.

## Line types (counts in fixtures)

| type | count | notes |
|---|---|---|
| attachment | 9414 | context injected into a turn; `attachment.type` below |
| assistant | 5839 | one content block per line; several lines share `message.id` |
| user | 3627 | prompts (string content) and tool results (array content) |
| api-request | 1058 | request metadata (`querySource`, `shapeHash`, `params`, `requestDigest`) |
| last-prompt | 667 | `{leafUuid, lastPrompt}` |
| atis-latch | 654 | internal |
| api-request-blob | 575 | **copies** of message blocks sent to the API, incl. `tool_use` - do not count as tool calls |
| mode / permission-mode | 540 / 435 | `{mode}` / `{permissionMode}` |
| ai-title / custom-title / agent-name | 500 / 115 / 114 | session titles |
| queue-operation | 286 | `{operation, content?, reason?}` queued user input |
| system | 249 | `subtype`: stop_hook_summary, turn_duration, away_summary, informational, compact_boundary, agents_killed, local_command, model_refusal_fallback |
| session-owner | 130 | `{accountUuid, organizationUuid}` - identifiers, mask/drop in fixtures |
| file-history-snapshot / file-history-delta | 111 / 59 | edit-undo backups (`trackingPath`, `backup`) |
| tools-used | 43 | `{tools}` |
| api-request-shape | 33 | |
| pr-link | 28 | `{prNumber, prUrl, prRepository}` |
| cost-state | 12 | totals, `modelUsage` |
| frame-link, artifact-comment-monitor, artifact-autoreact-ledger | 5, 2, 2 | desktop-app features |

Only `assistant`, `user`, `attachment`, `system` carry the common envelope:
`parentUuid, isSidechain, uuid, timestamp (ISO-8601 Z), userType, entrypoint (cli|claude-desktop), cwd, sessionId, version, gitBranch`,
optionally `agentId`, `slug`, `session_id` (duplicate of sessionId). Other types carry at most `sessionId` (+ `timestamp` sometimes).

## Tool calls

An `assistant` line whose single block is `tool_use`:

```json
{"type":"assistant","uuid":"<uuid>","parentUuid":"<uuid>","isSidechain":false,
 "sessionId":"<uuid>","cwd":"/Users/<user>/Desktop/<project>","gitBranch":"main",
 "version":"2.1.299","timestamp":"2026-10-14T11:15:34.113Z","requestId":"req_…",
 "wireToolInputs":{"toolu_…":{"command":"<cmd>","description":"<text>"}},
 "wireIngestContext":{"toolu_…":{"cwd":"<path>"}},
 "message":{"id":"msg_…","model":"claude-opus-5-5","role":"assistant","stop_reason":"tool_use",
   "content":[{"type":"tool_use","id":"toolu_…","name":"Bash","input":{"command":"<cmd>","description":"<text>"}}],
   "usage":{…}}}
```

`wireToolInputs` duplicates the input keyed by tool-use id. Tool-use ids were unique across all files (0 duplicates).
MCP-attributed calls also carry `attributionMcpServer` / `attributionMcpTool`; skills `attributionSkill`; plugins `attributionPlugin`.

Tool `input` keys seen:

| tool (count) | input keys |
|---|---|
| Bash (2597) | `command`, `description`, `timeout`, `run_in_background` |
| Write (271) | `file_path`, `content` |
| Read (95) | `file_path`, `offset`, `limit`, `allow_large` |
| Edit (75) | `file_path`, `old_string`, `new_string`, `replace_all` |
| WebFetch (19) | `url`, `prompt` |
| WebSearch (8) | `query`, `mode` |
| Agent (54) | `description`, `subagent_type`, `prompt`, `name`, `run_in_background`, `isolation`, `model`, `effort` |
| SendMessage (76), Skill (50), ToolSearch (35), SubagentHandback (29), TaskStop, Monitor, AskUserQuestion, Artifact, ListAgents | various |
| `mcp__<server>__<tool>` (≈300) | server-specific; e.g. `mcp__Claude_Browser__browser_batch {actions,…}`, `mcp__claude-in-chrome__navigate {url,tabId}` |

Not seen in fixtures but handled: MultiEdit (`edits[].new_string`), NotebookEdit (`notebook_path`, `new_source`), Grep/Glob.
MCP servers seen: Claude_Browser, claude-in-chrome, ccd_turn, ccd_view, claude_ai_Claude_Docs, claude-flow, code-review-graph.

## Tool results

A `user` line with array content containing `tool_result`:

```json
{"type":"user","sourceToolAssistantUUID":"<uuid of tool_use line>",
 "permissionDecision":{"decision":"accept|reject","source":"config|user_permanent|user_temporary",
                       "reasonType":"classifier|mode|rule|other|subcommandResults|safetyCheck|null",
                       "reasonCode":"classifier:auto-mode","classifierCategory":"credential_materialization"},
 "toolDenialKind":"automode-blocked|permission-rule|user-rejected|interrupted",
 "toolUseResult":{"stdout":"…","stderr":"…","interrupted":false,"isImage":false,"noOutputExpected":false},
 "message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_…","is_error":false,"content":"<str or [blocks]>"}]}}
```

- Join to the call by `tool_use_id`. `permissionDecision.decision == "reject"` or `toolDenialKind` present ⇒ the call was **blocked** (did not run). Seen: 27 subcommandResults rejects, 7 auto-mode classifier rejects (categories `credential_materialization`, `irreversible_local_destruction`, `unauthorized_persistence`), 1 `safetyCheck` (`circuitBreaker: dangerousRemoval`), 1 user-rejected.
- `is_error`: `true` / `false` / absent.
- `toolUseResult` shape depends on tool: Bash `{stdout,stderr,interrupted,isImage,noOutputExpected,returnCodeInterpretation?,backgroundTaskId?,bashEditDiff?}`;
  Write/Edit `{filePath,content|oldString/newString,originalFile,structuredPatch,userModified}`; Read `{type,file}`; Agent `{agentId,status,outputFile,…}`.
  **Results contain raw file contents and command output** (secrets possible) - never store unmasked.

## User prompts

`user` line with `message.content` as a string (356) or `[{type:"text"}|{type:"image"}]`. `promptSource`: typed | sdk | system; `isMeta`, `isCompactSummary` flag synthetic ones.

## Attachments (`attachment.type`)

hook_success (5061: `{hookEvent,hookName,command,stdout,stderr,exitCode,durationMs,toolUseID}`), total_tokens_reminder, deferred_tools_record,
environment, prompt_snapshot, hook_additional_context, queued_command, edited_text_file (`{filename,snippet}`), deferred_tools_delta,
mcp_instructions_delta, skill_listing, **instructions** (`{files,changed?,reason?}` - CLAUDE.md etc. loaded; read by `files_instruction_concealment` and `files_invisible_unicode_instruction`),
model, agent_listing_delta, credential_org, date, session_context, remote_session_change, auto_mode, command_permissions,
silent_turn_reminder, **file** (24: user `@`-mentioned file, `{filename,displayPath,content}` - file content enters context),
team_context, skill_mention, compact_file_reference, task_status, thinking_drop, invoked_skills, hook_cancelled.

## Sub-agents / sidechains

- Subagent transcripts live in `<sessionId>/subagents/agent-<agentId>.jsonl`; every line has `isSidechain: true`, `agentId`, and the **parent's** `sessionId`.
- Parent links to child via the `Agent` tool_use id = `meta.json.toolUseId`; the parent's tool result has `toolUseResult.agentId`.
- Main transcripts can also contain `agentId` lines (in-process teammates), and some non-envelope lines lack `isSidechain`.
- Subagent tool calls appear **only** in the subagent file (not duplicated in the parent), so scanning all files does not double count — except `api-request-blob` copies, which must be skipped.

## Parsing guidance

- Stream line by line; treat each line independently; unknown `type` ⇒ count and skip.
- Tool calls: `type=="assistant"` → `message.content[]` blocks with `type=="tool_use"`. Ignore `api-request-blob`.
- Order within a stream = file order; `timestamp` is on every envelope line.
- Session identity = `sessionId` + `agentId` (subagent) — each file is read as one ordered stream.

## Windows shape

Observed 2026-11-07 from `~/.claude/projects/C--Users-<user>-RetroHound/` on Windows 10 (7 files, ~1,750 lines, keys and
types only; values not read, not copied to fixtures). The envelope and line types match macOS. Differences:

- Project dir: `C--Users-x-y` (`:` and `\` each become `-`).
- `cwd` is `C:\Users\x\y` on every envelope line. `file_path` on Read/Write/Edit and `instructions` file paths are
  `C:\...` too; no `C:/...` or `/c/...` forms seen in tool arguments.
- A `PowerShell` tool sits beside `Bash`, with input keys `command`, `description`, `timeout`. `Bash` is still the common
  one (161 vs 2).
- Transcripts are LF on disk. CRLF in a Windows checkout of the committed fixtures (`fixtures/redacted/`, earlier
  `fixtures/masked/`) comes from `core.autocrlf`.
- Attachment type seen only here: `hook_system_message` (`content`, `hookName`, `hookEvent`, `toolUseID`).
- Denial category seen only here: `untrusted_code_integration`.

## Further observations (fixtures and Windows)

- `classifierCategory` sits inside `permissionDecision`, not on the line. Only 3 of 7 auto-mode blocks in the fixtures
  carry one.
- `toolDenialKind` covers all 35 rejects, plus `user-rejected` and `interrupted`, which have no `permissionDecision`.
  `is_error` is true on all of them.
- `permissionMode` appears only on `permission-mode` lines and on `user` prompt lines, never on `assistant` lines, so
  the current mode has to be carried forward. Team agents have it in `meta.json`.
- `promptSource` appears only on `user` prompt lines (140), never on tool results.
- The first line of a main file usually has no `timestamp` (`last-prompt`, `mode`), so a `permission-mode` line can come
  before any timestamp. `sessionId` is missing only on `file-history-*` lines.
- `isMeta` user lines are not human input. Those with `sourceToolUseID` (42, all `Skill`) hold the skill body.
- `attachment.file.content` is `{type:"text",file:{filePath,content,numLines,startLine,totalLines}}`.
- `attachment.instructions.files[]` is `{path,type,content}`, `type` in `User`, `Project`, `AutoMem`.
- `hook_success.content` is not the same as `stdout`. `exitCode` was 0 on all 5,288 seen.
- `hook_cancelled` has the same `command`/`hookEvent` as `hook_success`, plus `timedOut`, `timeoutMs`; no stdout.
- `queued_command.prompt` came only from harness or peer agents (`origin.kind` `task-notification`, `coordinator`, `peer`),
  never a human, so it is not a `user_prompt`.
- Browser MCP servers nest URLs: `actions[].input.url` on `browser_batch` (44 of 59 MCP calls with a URL).
- `Monitor` also has an `input.command`, a shell command (1 seen), so it maps to `process_creation` like `Bash`.
- `toolUseResult.persistedOutputPath` is an absolute path on the recording machine. The file sits in
  `<sessionId>/tool-results/`, and the `tool_result` holds only a preview. One `WebFetch` preview spilled without that key.
- All 20 team agents with no `meta.json.toolUseId` are linked by `toolUseResult.agentId` in the main file
  (`status: teammate_spawned`). Only `Agent` results carry that key.
- Attribution fields overlap on a line: `Skill+Plugin` (134), `Skill+McpServer` (6), all three (3).
- JSON leaves U+2028/U+2029 raw, and `node:readline` treats them as line ends, so readers must split on `\n` only.

## How `src/collectors/claude-code/v1.ts` maps this

- `outcome`: `blocked` when `toolDenialKind` is set or the decision is `reject`, then `error` on `is_error`, then
  `success`. `denial_kind` tells Claude Code blocks (`automode-blocked`, `permission-rule`) from `user-rejected` and
  `interrupted`. `unknown` means no result in the file.
- `permission_mode`, `project_path`, `agent_version`, `entrypoint`, `ts` carry forward. Lines before the first timestamp
  take the first timestamp in the file, or the file mtime.
- `target_path` and `project_path` use forward slashes for Windows paths, so rules and fieldrefs see one shape.
- `target_path` has `.` and `..` resolved lexically; a root absorbs extra `..`. A path that climbs above `~`, or is anchored
  on a variable, and a relative path with no cwd, stay as written. Symlinks are not resolved.
- `id` hashes the transcript path with any `.jsonl.superseded-*` or `.orphaned-*.jsonl` suffix stripped, so a copy's
  lines upsert onto the original; `raw_ref` names the file read. Lines with a `uuid` use it. The rest use their text
  and which repeat they are, because line numbers differ between copies and `permission-mode` lines repeat exactly.
- `attribution` takes skill, then MCP, then plugin. `mcp_server` still names the server on MCP calls.
- `hook_*` attachments with a `command` map to `process_creation`; `outcome` is `success` only for `hook_success` with exit 0.
- Skill bodies go to the Skill event's `content`. A spill file replaces the preview in `tool_response` (32 MB limit).
- PowerShell here-strings (`@'...'@`) and `<<<` here-strings stay in `command_line`. A POSIX heredoc body moves to `content` only
  when `cat`/`tee`, `git commit|tag` or `gh pr|issue|release` stores it and nothing on its header line pipes it on; a body
  that a shell, interpreter, ssh, sudo or script may execute stays in `command_line` (parser `claude-code/v2`). So does a
  body whose header line ends in `\` (the next line may pipe it on) or whose `<<` may sit in quotes or a comment (`#`,
  `'`, or an odd number of `"` before it, not counting `"$(`).
- There is no `legacy.ts`: inline sidechains and flat `agent-*.jsonl` parse with the same code, and no real legacy sample
  has shown a difference.

## Configuration surface (read by `src/footprint/config-claude.ts`)

Checked 2026-11-10 against this machine (key names and structure only, no values) and the docs at code.claude.com:
`settings`, `mcp`, `managed-mcp`, `managed-settings`, `hooks`, `skills`, `plugins-reference`, `claude-directory`.
`<cfg>` is `CLAUDE_CONFIG_DIR`, else `~/.claude`; `<managed>` is `/Library/Application Support/ClaudeCode` (macOS),
`/etc/claude-code` (Linux, WSL), `C:\Program Files\ClaudeCode` (Windows).

| Where | Scope | Key path | Kind |
|---|---|---|---|
| `~/.claude.json` (`<cfg>/.claude.json` when `CLAUDE_CONFIG_DIR` is set) | user | `mcpServers.<name>` | mcp_server |
| same file | local | `projects["<abs project path>"].mcpServers.<name>` | mcp_server |
| `<project>/.mcp.json` | project | `mcpServers.<name>` | mcp_server |
| `<cfg>/settings.json`, `<project>/.claude/settings.json`, `<project>/.claude/settings.local.json` | user, project, local | `hooks.<Event>[].hooks[].command`; `enabledPlugins["<plugin>@<marketplace>"]: true` | hook, plugin |
| `<managed>/managed-settings.json`, then `<managed>/managed-settings.d/*.json` (alphabetical) | managed | as settings, plus `managedMcpServers.<name>` | hook, plugin, mcp_server |
| `<managed>/managed-mcp.json` | managed | `mcpServers.<name>` | mcp_server |
| `<cfg>/skills/<dir>/SKILL.md`, `<project>/.claude/skills/<dir>/SKILL.md`, `<managed>/.claude/skills/<dir>/SKILL.md` | user, project, managed | frontmatter `name`, else `<dir>` | skill |
| `<cfg>/plugins/installed_plugins.json` | - | `plugins["<plugin>@<marketplace>"][] {scope, projectPath?, installPath, lastUpdated, version}` | where an enabled plugin lives |
| `<installPath>/.claude-plugin/plugin.json` (`name`, `hooks`, `mcpServers`), `hooks/hooks.json`, `.mcp.json`, `skills/<dir>/SKILL.md` | plugin | `hooks`/`mcpServers`: a `./file.json`, an inline object, or an array of either | hook, mcp_server, skill |

MCP entries carry `type` (`stdio`, `http`, `sse`, `ws`; seen here: `stdio`), `command`, `args`, `env`, `url`, `headers`,
`oauth`. Only the name and `type` are read. `~/.claude.json` also holds `oauthAccount` and other account state: never read out.

Name mapping to the index (verified against the index unless marked):

- `mcp_server` = the configured name with every character outside `A-Za-z0-9_-` made `_` (`Claude Browser` ->
  `Claude_Browser`, `claude.ai Claude Docs` -> `claude_ai_Claude_Docs`: the attribution keeps the raw name). Plugin
  servers are `plugin_<plugin>_<server>`, normalised the same way (docs; none called here).
- Hooks: `command_line` is the `command` string as written, masked: `$CLAUDE_PROJECT_DIR` stays unexpanded (72 of 113
  project hooks matched). Plugin hook commands keep `${CLAUDE_PLUGIN_ROOT}` as written: unverified, no plugin hook
  event is in the index. Exec-form `args`, `http` and `mcp_tool` hooks are not read.
- Skills: `skill:<name>` for user and project skills; `skill:<plugin>:<name>` for plugin skills (seen). A frontmatter
  `name` that is not a valid skill name (spaces, capitals) falls back to the directory name (seen in the skill listing).
- Plugins: `plugin:<plugin>`, the part of the `enabledPlugins` key before `@` (seen). Components are namespaced under
  `plugin.json`'s `name` (docs).

Not read: claude.ai connectors, built-in servers (`claude-in-chrome`) and desktop-app servers (`ccd_*`), which no file
configures; bundled skills (`skill:claude-api`); synced skills (`<cfg>/skills/synced/`, named `anthropic-skills:<name>`)
and synced plugins; nested `<subdir>/.claude/skills`; the plugin.json `skills` key and `.mcpb` bundles; MDM plists,
the registry and server-managed settings; MCP approval state (`enabledMcpjsonServers`, `disabledMcpServers`).
Installs at other versions than the most recently updated one, and plugins outside `<cfg>/plugins/`, are not read.

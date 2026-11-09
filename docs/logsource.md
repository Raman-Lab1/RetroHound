# Logsource: `ai_coding_agent`

```yaml
logsource:
  product: ai_coding_agent
  category: process_creation   # optional, see below
  service: claude_code         # optional; claude_code | codex | antigravity | gemini_cli | cursor (matches AgentEvent.agent)
```

Proposed name, not yet accepted by SigmaHQ (ADR 0003). Events come from `claude_code`, `codex` and `antigravity`. An unknown product,
category or service rejects the rule at load, with the reason (`retrohound rules list`).

One event has exactly one category. A rule with no `category` runs on every event: it is the slowest kind, so give
rules a category where you can (see CONTRIBUTING-RULES.md).

## Categories

Source of truth: `CATEGORIES` in `src/normalize/types.ts`; the mapping is in `src/collectors/claude-code/v1.ts`.

| category | Produced by (Claude Code) |
|---|---|
| `process_creation` | Shell tools (Bash, PowerShell, Monitor with a command). Hook runs from `hook_*` attachments, with `tool_name: hook:<Event>`. A URL in the command also fills `url` and `domain`. |
| `file_access` | `Read`; an `@`-mentioned file attachment (`tool_name: @file`). |
| `file_event` | Write, Edit, MultiEdit, NotebookEdit. Includes writes to config files. |
| `web_request` | `WebFetch`; an MCP call whose input carries a URL (browser MCP servers nest it in `actions[].input.url`). |
| `mcp` | An MCP call with no URL. `mcp_server` and `mcp_tool` are set. |
| `instruction_load` | Instruction files Claude Code loaded (CLAUDE.md and similar, the `instructions` attachment). |
| `config_change` | Config-state lines Claude Code writes, today `permission-mode`. |
| `tool_call` | Any other tool (Agent, Skill, Grep, Glob, ToolSearch, ...). The generic fallback. |
| `user_prompt` | A typed or SDK prompt. Not tool results, not harness-queued commands. |
| `assistant_message` | Assistant text. |

## Fields

### Stored fields (`AgentEvent`)

Visible to rules at scan time and when re-evaluated from the index. Every string is masked (ADR 0007). List fields are
absent, not `[]`, when empty, so `|exists` is true only when something was found.

| field | meaning |
|---|---|
| `id`, `schema_version`, `raw_ref` | Identity and a pointer (file, line) to the transcript. Raw text is not stored. |
| `agent`, `agent_version` | `claude_code`, `codex` or `antigravity`; the agent's version where its log has one (Codex `cli_version`; Antigravity none). |
| `session_id` | Session id. Sub-agent events carry their parent's session id. |
| `parent_session_id` | Unset for Claude Code. |
| `agent_id` | Set on sub-agent events, absent on the main conversation. |
| `parent_tool_use_id` | The parent's Agent tool call that spawned the sub-agent. |
| `project_path` | The line's working directory, forward slashes. |
| `ts`, `seq` | ISO-8601 time; line order within one transcript file. `seq` is numeric (`gt`, `gte`, `lt`, `lte`). |
| `category` | See above. |
| `tool_name` | `Bash`, `Edit`, `WebFetch`, `mcp__x__y`, `hook:<Event>`, ... |
| `command_line` | Shell command. A POSIX heredoc body moves to `content` only when `cat`/`tee`, `git commit\|tag` or `gh pr\|issue\|release` stores it and nothing pipes it on; a body any other command may execute (shells, interpreters, ssh, sudo, scripts) stays. Here-strings (`<<<`) and PowerShell here-strings stay. |
| `target_path` | File path, absolute when resolvable, `.`/`..` resolved lexically, forward slashes. Shell events have none. |
| `url`, `domain` | Request URL and its host. |
| `mcp_server`, `mcp_tool` | MCP call parts. |
| `outcome` | `success`, `error`, `blocked`, `unknown` (no result in the file). `blocked` includes user-rejected and interrupted. |
| `denial_kind` | `automode-blocked`, `permission-rule` (Claude Code blocked it), `user-rejected`, `interrupted`. |
| `denial_category` | Claude Code's classifier category, when it gave one (for example `credential_materialization`). |
| `permission_mode`, `prompt_source`, `entrypoint` | Carried-forward mode; `typed`/`sdk`/`system`; `cli`/`claude-desktop`. |
| `attribution` | `skill:<x>`, `mcp:<server>` or `plugin:<x>`. |
| `secret_kinds` | Names of secret patterns found in tool input or content. Never values. |
| `result_secret_kinds` | Same, in the tool output. |
| `secret_fps` | First 16 hex of sha256 of each strong secret, to group "rotate these". |
| `text_excerpt` | Masked, at most 500 chars. |

### Match-only fields (ADR 0006)

`content`, `tool_input`, `tool_response`, `text`. Raw text, in memory only. They never reach the index or any output.

| field | holds |
|---|---|
| `content` | Write/Edit body, stored heredoc body, instruction / `@`-file / Skill text, hook stdout. |
| `tool_input` | `JSON.stringify` of the raw tool input, all tools including MCP. |
| `tool_response` | The paired tool result text, attached to the tool call event. |
| `text` | Full prompt or assistant text. |

When rules can see them: only while a transcript is parsed (a first scan, or a changed file or rule set). Re-evaluation
from the index, and sessions whose transcript Claude Code deleted, see masked stored fields only, so a rule that needs
a match-only field cannot run there. Avoid `tool_response` and `tool_input` without a category or path filter: they are
large and slow.

### Aliases

Read-only, for Sigma habits. They resolve to the canonical name at load.

| alias | field |
|---|---|
| `CommandLine` | `command_line` |
| `TargetFilename` | `target_path` |
| `CurrentDirectory` | `project_path` |

Any other unknown field name is a load error, not a silent non-match.

### Derived fields

Computed by the engine from stored fields, never stored, so they work the same for `scan`, DB rows and the live hook.
None can be a correlation `group-by` key.

`target_outside_project` (boolean, `true`/`false` only, no modifiers): true when `target_path` and `project_path`
are both set and the target is provably not under the project root (`/proj-evil` is outside `/proj`). Shell events have
no `target_path`, so it is false for them.

`command_line_unquoted` (string, every modifier `command_line` takes): `command_line` with shell quoting removed: `'`
and `"` dropped, and a backslash before a word character dropped. `c"u"rl`, `'cu'rl` and `c\url` all read `curl`.
Separators inside quotes are kept (`bash -c "curl … | sh"` runs the quoted text). Absent when `command_line` is.
Windows paths lose their backslashes too (`C:\Users` reads `C:Users`): match those on `command_line`.

`download_executed` (boolean, `true`/`false` only, no modifiers): true when one `command_line` downloads to a local
file and a later command in the same line runs that same file. False without `command_line`. The line is split into
commands at `;` `|` `&` `&&` `||` newlines `(` `)` and backticks outside quotes (a `(` right after a word, as in
`open(`, is a call in an interpreter body, not a subshell) (`git commit -m "a; bash x"` is one
command); quote characters are dropped from words, so `"$P"` quoting does not hide it. The quoted code of a shell's
`-c` or of `eval` is split as if unquoted, so a `bash -c "…"` wrapper does not hide it either.

- Downloads: `curl -o P`, `-oP`, a cluster ending in `o` (`-fsSLo P`), `--output P`/`--output=P`; `curl -O URL`,
  `--remote-name` (the file is the URL path's last segment), both under `--output-dir D` when given; `wget -O P`/`-OP`/`-qO P`, `--output-document(=| )P`;
  `wget URL` without `-O` (last segment); `iwr`/`Invoke-WebRequest`/`irm` (and `curl`/`wget` as PowerShell aliases)
  `-OutFile P`; `certutil -urlcache -f URL P`; and a downloader's `> P` redirect. `-o -` / `-O -` (stdout) is not a file.
- Runs, after the download: `[sudo|doas|env|nohup|exec|eval|timeout [DURATION]|nice|stdbuf|xargs … [flags]] [X=1] [/path/](sh|bash|zsh|dash|ksh|fish)
  [-flags] P`, `sh < P`, `source P`, `. P`, `python[0-9.]*|perl|ruby|node|php [-flags] P` (first operand only; a code flag, case-sensitive, means no file:
  python `-c`/`-m`, perl `-e`/`-E`, ruby `-e`, node `-e`/`-p`, php `-r`),
  `pwsh|powershell [-ep X] [-File] P`, `& P`, and P run directly as a command (`./i.sh`, `/tmp/i.sh`, after
  `chmod +x`).
- Paths compare after removing quotes and a leading `./` (or `.\`), with `\` read as `/`: a bare basename download
  (`curl -O`, `wget URL`) matches `./name` and `name`.
- Known gaps: variables are compared as text, never expanded (`f=/tmp/i.sh; curl -o $f …; bash /tmp/i.sh` is
  missed; `curl -o $f …; bash $f` matches); `cd` is
  not tracked (`curl -o /tmp/i.sh …; cd /tmp; ./i.sh`); `wget -P DIR`, `tee P`, abbreviated PowerShell parameters
  (`-OutF`), `Start-Process`/`cmd /c`/`start`, and paths with spaces; case is not folded on Windows paths; a bare
  name run (`a.exe`) counts, as on Windows, so `wget …/jq && jq` would too. Long options other than `--output`,
  `--output-document` and `--remote-name` are read as taking no value.

## Correlation

Supported types: `event_count`, `temporal_ordered`, `temporal` (ADR 0004). `generate` defaults to false: a rule that
only a non-generating correlation references emits nothing alone (`rules list` marks it silenced).

- `group-by` must contain `session_id`. `agent_id` is optional (ADR 0004 amendment).
  - `[session_id]`: one group across the main conversation and all sub-agents, ordered by `ts`, then `(agent_id, seq)`
    on a tie. Use it when a main-agent read and a sub-agent send should join.
  - `[session_id, agent_id]`: one group per transcript stream, in `seq` order.
- `x-retrohound.max_events_between: N` (seq distance) needs `agent_id` in `group-by`; otherwise the rule is rejected
  (`max-events-needs-agent-id`). `timespan` works either way. With both set, both must hold.
- `x-retrohound.differ_by: [field, ...]` (`temporal_ordered` only, stored fields): each later step's event must differ
  from the first step's in every listed field (null and missing are one value), so "blocked, then done with another
  kind of tool" is `differ_by: [category]`. A Sigma backend without it matches the same tool too.
- `event_count`: at most one finding per session per rule. `temporal_ordered`: order of `rules:`, non-strict, so one
  event can satisfy consecutive steps; one finding per first-step event.
- A missing or bad `ts` sorts first and never fits a window, so clock skew between streams can hide a match.
- `aliases` and the `value_*` types are rejected.

## Matching rules

Map = AND, list = OR. A plain value matches the whole field, case-insensitive, with `*` and `?` globs. Modifiers:
`contains`, `startswith`, `endswith`, `all`, `re`, `cased`, `exists`, `gt`/`gte`/`lt`/`lte`, `fieldref`. Anything else,
keyword lists, `timeframe` and `|` aggregation reject the rule.

`re` limits:

- Flags are `|re|i`, `|re|m`, `|re|s`. Case-sensitive and unanchored by default. No lookarounds, backreferences, POSIX
  classes, or `\u{...}`.
- **8 KiB cap:** `re` tests only the first 8,192 characters of a field. A match after that is missed.
- **One-`.*` guard:** `retrohound rules test` fails a rule whose `re` pattern has more than one unescaped `.*` or
  `.+`, because `.*a.*b` is cubic in V8 (about 1 s per KiB). Use bounded classes such as `[^;&|]{0,200}`.

## Agents other than Claude Code

The same fields and categories are filled from each agent's own log (`docs/formats/codex.md`,
`docs/formats/antigravity.md`). What differs for rule authors:

| | Codex CLI | Antigravity CLI |
|---|---|---|
| `tool_name` | `Bash`, `PowerShell` or `cmd` (by the shell that ran), `WebFetch`, `WebSearch`, `Agent`, `guardian_review` | its own names: `run_command`, `read_file`, `write_file`, `edit_file`, `search_web`, `invoke_subagent`, `ask_question` |
| `process_creation` | every shell command, `command_line` = the script passed to the shell | `run_command` |
| `file_access` / `file_event` | none yet: Codex 0.167 reads and writes files through shell commands, so only the shell branches of file rules fire | `read_file` → `file_access`; `write_file`, `edit_file` → `file_event` |
| `outcome: blocked` | an auto-review (guardian) verdict other than `allow` | never (the CLI's approvals are not logged) |
| sub-agents | `agent_id` = the agent path, `session_id` = the root thread | `agent_id` = the child conversation, `session_id` = the root conversation |

Rules keyed on Claude-only shapes do not fire on these agents: hook events (`tool_name: hook:*`), `Skill`,
`instruction_load`, `config_change` / `permission_mode`, and the `mcp` category. Filter a rule to one agent with
`logsource.service`.


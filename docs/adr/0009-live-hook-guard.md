# 0009. Live guard: a PreToolUse hook with a JSON decision, failing open

- Status: Accepted, amended 2026-11-07 (Codex CLI and Antigravity CLI targets)
- Date: 2026-11-07
- Related: 0001, 0005 (shared tool-call mapping), 0008

## Context
Reading history after the fact cannot stop anything. Claude Code's `PreToolUse` hook sees `tool_name`, `tool_input`
and `tool_use_id` before a tool runs. Exit 0 with `hookSpecificOutput.permissionDecision: deny|ask` blocks the call or
forces a prompt; exit 2 blocks but cannot ask; exit 1 does not block. Hooks fail open unless `onFailure: "block"` is
set, and `timeout` is in seconds. Writing an agent's settings file is code execution, so the installer itself must be
careful: attackers abuse exactly this file.

## Options considered
- Exit code 2. No `ask`, so no confirm mode. Rejected.
- `permissionDecision: allow` or `updatedInput`. Would weaken permissions or rewrite what the agent meant. Never.
- A `ConfigChange` veto only. Guards settings, not tool calls. Not the mechanism.
- **`PreToolUse`, matcher `"*"`, exit 0 with a JSON decision.** Chosen.

## Decision
- `retrohound hook install` adds one handler: `PreToolUse`, matcher `"*"` (MCP tools included), exec form (absolute
  runtime path as `command`, `[entry, "hook", "run", "--mode", <mode>]` as `args`), `timeout: 5`.
- Modes: `log` records what it would do and prints nothing; `confirm` returns `ask`; `block` returns `deny` with
  `permissionDecisionReason: "RetroHound: <rule> (<ATT&CK id>)"`. Never `allow`, never `updatedInput`.
- Only `lane: enforce` single-event rules decide; hunt-lane rules and correlations never block. Hook-run events
  themselves only report, since there is no tool call to deny.
- Fail open by default, including on any internal error. `--fail-closed` sets `onFailure: "block"`, with a warning.
- Scope: user settings by default; `--scope project|local` only when asked.
- **Installer:** strict JSON parse or abort; find its own entry by marker and update it; no-op if unchanged; a
  timestamped backup with the file's mode (0600 for a new file); re-check the file before writing; write a temp file,
  fsync, rename; verify that nothing outside its own entry changed, else restore. `uninstall` removes only its entry.
- **Install path safety:** the hook runs on every tool call, so its runtime and entry file must not be writable by
  others (README, "Hook install safety"). `hook status` re-checks the installed paths every time.
- The hook maps its payload with the same tool-call function as the collector (0005), and keeps a parsed-rule cache
  next to its log so a call does not re-parse YAML.

## Codex CLI and Antigravity CLI
Both read Claude-style `PreToolUse` hooks from JSON files, so `hook install --agent codex|antigravity` uses the same
installer and path checks. Set up from the vendors' documentation, tested on temporary files, not yet in live sessions:
- **Codex:** `~/.codex/hooks.json` (or `<repo>/.codex/hooks.json`). `deny` uses the same JSON shape. `ask` is parsed
  but not supported and makes the hook fail while the tool still runs, so `--mode confirm` is refused. A new or
  changed hook runs only after the user trusts it in `/hooks`. `command` is one string run by the user's shell, so
  install refuses paths with spaces or shell metacharacters.
- **Antigravity CLI:** `~/.gemini/config/hooks.json` (or `<repo>/.agents/hooks.json`), as a named group
  `retrohound`, output `{decision: deny|ask, reason}`. The documentation calls `decision` required; RetroHound
  prints nothing when it has no decision rather than printing `allow`, so this needs a live check before anyone relies
  on it (README).

## Consequences
- The installed entry path becomes a target, because it runs on every tool call; hence the path checks.
- Under a managed `allowManagedHooksOnly` policy the hook does not run.
- Correlation rules need session state and are not evaluated in the hook.

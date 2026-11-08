# 0003. Rule format: a Sigma v2.1 subset on an `ai_coding_agent` logsource

- Status: Accepted
- Date: 2026-11-07
- Related: 0004 (correlation), 0006 (match-only fields), 0007 (secrets), 0014 (exports)

## Context
Detection engineers already write Sigma, and Sigma tooling (pySigma backends) can carry rules into a SIEM. Sigma v2.1
allows custom top-level keys. There is no TypeScript Sigma matcher, so RetroHound needs its own small one. Two
standard category names mean something else in Sigma: `file_change` is a Sysmon creation-time change, and `network`
means connections and DNS. Other projects use Sigma for agents too, under `product: ai_agent` or `product: claude`.

## Options considered
- **Format:** an own DSL (loses Sigma tooling and familiarity) or full Sigma (half its modifiers mean nothing here).
  Chosen: **a Sigma v2.1 subset plus one vendor key, rejecting everything unsupported.**
- **Product:** `claude` is vendor-specific and breaks multi-agent rules. Chosen: **`ai_coding_agent`**, because
  the fields are coding-agent fields (working directory, git branch, shell command, paths). `ai_agent` remains a
  possible upstream name.

## Decision
- **File:** Sigma v2.1 YAML plus `x-retrohound: { lane: hunt|enforce, ... }`. The lane decides whether the live hook
  (0009) may act on a rule; `hunt` rules only report.
- **Logsource:** `product: ai_coding_agent`, optional `service` (`claude_code`, `codex`, `antigravity`), and a
  `category`. A rule without a category sees every event. One event has one category:

  | category | events |
  |---|---|
  | `process_creation` | shell commands, hook runs (`tool_name: hook:<Event>`) |
  | `file_access` | reads, @-mentioned files |
  | `file_event` | writes and edits, including writes to config files |
  | `web_request` | web fetches and MCP calls carrying a URL |
  | `config_change` | config-state lines the agent writes (permission mode) |
  | `mcp`, `instruction_load`, `tool_call`, `user_prompt`, `assistant_message` | as named |

  Shell commands that contain a URL also fill `url` and `domain` on their `process_creation` event.
- **Fields:** snake_case names from `docs/logsource.md`, plus read-only aliases `CommandLine`, `TargetFilename` and
  `CurrentDirectory`. An unknown field is a load error. Match-only fields (0006) and derived fields are documented
  there too.
- **Semantics:** a map is AND, a list is OR; a plain value matches the whole field, case-insensitively, with `*` and
  `?` globs and `\` escapes; `null` means missing and `''` empty. The full condition grammar is supported (`and`,
  `or`, `not`, parentheses, `1 of` and `all of` over `x*` or `them`).
- **Modifiers:** `contains`, `startswith`, `endswith`, `all`, `re` (with `i`, `m`, `s`; no lookarounds or
  backreferences), `cased`, `exists`, `gt`/`gte`/`lt`/`lte`, `fieldref`, `windash`. **Anything else** (other
  modifiers, keyword lists, placeholders, `value_*` correlations, an unknown product or category) **rejects the rule
  with a named reason**; `retrohound rules list` shows it. A rule is never half-evaluated.
- **Metadata:** `id`, `title`, `status`, `level`, `tags` (`attack.*`, `owasp_agentic.*`), `falsepositives`, the lane,
  and positive and negative tests in `rules/tests/<rule>/`.
- **Suppression:** an ignore file (`~/.retrohound/ignore.yml` or `--ignore`) hides findings by rule and exact field
  values. A repository's own ignore file is never read implicitly, because a malicious clone could hide itself.

## Consequences
- Rules stay portable: the vendor key and lanes are dropped when a rule is shared upstream, and ECS/OCSF field names
  are applied by the exporters (0014), so rules keep snake_case.
- Rejection by name keeps the engine small and honest, at the cost of some Sigma rules not loading unchanged.
- Renaming the product later is one line per rule plus a load-time alias.

# Writing rules

Rules are Sigma v2.1 YAML on the `ai_coding_agent` logsource. Fields, categories and limits: [docs/logsource.md](docs/logsource.md).
Start from [docs/rule-template.yml](docs/rule-template.yml). Contributed rules are licensed under the [Detection Rule License 1.1](rules/LICENSE).

## Layout

```
rules/ai_coding_agent/<category>/<prefix>_<what>.yml
rules/tests/<name>/positive.jsonl
rules/tests/<name>/negative.jsonl
```

- `<category>` is the logsource category. Rules with no `logsource.category` (they run on every event) live in `any/`;
  correlations live in `correlation/`; the folder is only for humans, the loader reads `logsource`.
- `name` is the file stem and the test directory name. Prefixes in use: `exec_`, `files_`, `secrets_`, `control_plane_`,
  `network_`, `blocked_`.
- A file may hold several documents separated by `---` (helpers plus a correlation). Each needs its own `name`.
  A helper that should not alert alone is silenced by being referenced only by non-generating correlations, and at
  least one of them must be in the helper's own file.

## Required metadata

`name`, `id` (a UUID, unique), `title`, `status`, `description`, `level`
(`informational|low|medium|high|critical`), `tags` (`attack.*`, `owasp_agentic.*`), `falsepositives`,
`x-retrohound.lane` (`hunt` or `enforce`), `logsource`, `detection`. The loader only requires `title` and a valid
logsource; `rules test` requires a `name`, and the project requires the rest.

Unsupported Sigma features reject the rule with a named reason. Check with `retrohound rules list`; a rejected rule is
listed with its reason and never evaluated.

## Tests

Every non-silenced rule needs `rules/tests/<name>/positive.jsonl` and `negative.jsonl`. One JSON object per line, a
partial event; missing contract fields are filled in (category defaults to `tool_call`, agent `claude_code`).

- Detection rule, positive: **every line must fire the rule on its own.**
- Correlation, positive: the file is one session and the rule must fire on it.
- Negative: non-empty, and the rule must not fire on the file. Put near-misses here (the safe form, the benign look-alike).
- Include match-only fields (`content`, `tool_input`, ...) in the line if the rule reads them.
- `first_seen_*` are computed over the file, and stay false unless its `ts` values span 14 days: give such a file an
  old baseline line, for example `"ts":"2025-12-10T00:00:00.000Z"` (lines default to 2026-01-01, one second apart).
  Positive lines inside the 14-day cold start (the baseline) are not required to fire; at least one later line is.

```
{"category":"process_creation","tool_name":"Bash","command_line":"git push --force origin main"}
```

Run `retrohound rules test` (default `rules/ai_coding_agent`, or `retrohound rules test <dir> --tests <dir>`). It also
fails on any rejected rule and on any `re` with more than one unescaped `.*` or `.+`.

## Licence

Rules are licensed under the Detection Rule License (DRL) 1.1 ([rules/LICENSE](rules/LICENSE)). Put your name in the
rule's `author` field; it is the credit DRL keeps when the rule is shared.

## Data in tests and rules

Defanged only: `example.invalid`, `192.0.2.x`, placeholder keys (obvious fakes, such as the AWS documentation example key).
No real hostnames, usernames, project names or secrets. Real transcripts are never committed.

## Performance

From [docs/perf.md](docs/perf.md): the engine is fast, the cost is in rules.

- **Give every rule a category.** A rule with none runs on every event; the slowest bundled rules were all category-less.
  If a rule needs two categories, write one rule per category.
- **Prefer `contains`, `startswith`, `endswith` over `re`.** Use `re` only when you need structure, and keep it bounded:
  `[^;&|]{0,200}`, not `.*`. One `.*` or `.+` at most (enforced). A bounded pattern (no `*`, `+`, `{n,}`) sees the
  whole field; an unbounded one only 8 KiB windows over the first 256 KiB plus the last 8 KiB (docs/logsource.md).
- Avoid long `contains` lists on one field; and avoid `tool_response` / `tool_input` / `content` without a category.
- Check the effect: `PERF=1 bun test tests/perf.test.ts` runs 1,000 synthetic sessions. Measured on a Windows laptop,
  evaluation was 25k-43k events/s against a 50k target, so every extra slow rule matters.

## False positives

State them in `falsepositives`. Agents do many benign things the user asked for; say which. If your own hooks or
config trigger a rule, say so in the description rather than weakening the rule.

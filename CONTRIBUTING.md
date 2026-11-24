# Contributing

Writing a detection rule: [CONTRIBUTING-RULES.md](CONTRIBUTING-RULES.md). Everything else is below.

## Build and test

```sh
brew install oven-sh/bun/bun   # or see https://bun.sh; Node >= 22.13 is needed for the built CLI
bun install
bun run check                  # tsc --noEmit + bun test; expect 0 fail
bun run build                  # dist/cli.mjs
```

Rules for a change: tests with it, `bun run check` green, no network calls from the product, secrets masked
everywhere, and test data defanged (`example.invalid`, `192.0.2.x`, placeholder keys). `fixtures/redacted/` comes from
`scripts/redact-fixture.ts`; never commit real transcripts (`fixtures/raw/` is gitignored, and
`bun scripts/check-staged.ts` refuses it).

## Good first contributions

- **A rule** for something agents do that RetroHound misses: [CONTRIBUTING-RULES.md](CONTRIBUTING-RULES.md) walks
  through one, tests included. Issues labelled `good first issue` and `rules` are a good start.
- **A false-positive fix**: a filter plus a negative test in `rules/tests/<rule>/negative.jsonl`.
- **A parser** for another agent's history (Gemini CLI, Cursor): read a few real transcripts first and write down the
  format in `docs/formats/<agent>.md` before writing code, as the existing collectors did.

## Donating a sample transcript

Parsers and rules get better with real formats, but a transcript holds your prompts, code and secrets. Open an issue
first and say what the sample would show. Then send a reduced copy, never the raw file:

- Keep only the events that matter (the tool call, its result, the lines around it) and drop everything else.
- Defang it: `example.invalid` hosts, `192.0.2.x` addresses, placeholder keys, no real prompts or repo content.
- For Claude Code, `bun scripts/redact-fixture.ts <in.jsonl> <out>` does a first pass; read the result line by line
  before you share it.

## Pull requests

Small and focused, with tests, `bun run check` green, and a line in `CHANGELOG.md` for anything users notice. CI runs
on Ubuntu and macOS arm64 under Node 22.13 and 24. Questions go to Discussions; security issues and `enforce`-rule
bypasses go through [SECURITY.md](SECURITY.md), never a public issue. Everyone follows the
[code of conduct](CODE_OF_CONDUCT.md).

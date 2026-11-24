# 0001. Runtime: develop on Bun, ship a Node ≥ 22.13 bundle

- Status: Accepted
- Date: 2026-11-07
- Related: 0002 (SQLite adapter), 0010 (packaging)

## Context
Users must be able to run `npx retrohound scan` on a fresh macOS or Linux machine with no setup. Machines that run
Claude Code or Codex have Node and npm, but usually not Bun. Bun is the faster toolchain for development: its test
runner, bundler and TypeScript support need no extra dependencies. Measured on 104 MB of real transcripts, Bun parses
about 850 MB/s and Node about 460 MB/s; both are far inside the warm-scan target (docs/perf.md). One
`bun build --target=node` bundle runs under both runtimes.

## Options considered
1. **Bun only** (`bunx`, or a bin shim that needs Bun). Fails on a machine without Bun. Rejected.
2. **Node only** (tsc plus a Node test runner). Gives up the fast toolchain for no user benefit.
3. **Develop and test on Bun, ship one Node-compatible bundle.** Bun users get the same CLI (`bunx retrohound`).

## Decision
Option 3.
- Development and tests: Bun 1.4.4, `bun test`, TypeScript strict, `tsc --noEmit`.
- Shipped: `dist/cli.mjs` from `bun build --target=node` (`scripts/build.mjs`), `engines.node: ">=22.13"`.
- `src/` uses only what both runtimes share: `node:*` modules and web APIs. No `Bun.*` in `src/` except the SQLite
  adapter (0002); `tests/guards.test.ts` enforces this, and that `src/` makes no network calls.

## Consequences
- Tests run on Bun while users run Node, so CI also runs the built bundle under Node 22.13 and 24 on Ubuntu and
  macOS arm64, and fails if it prints anything on stderr (`.github/workflows/ci.yml`).
- Node parses about 2x and inserts about 3x slower than Bun. That is within the targets; if a large history ever
  exceeds them, the fix belongs in the hot loop, not in a runtime switch.
- The live hook (0009) pays Node's start-up time on every tool call; the parsed-rule cache keeps the rest small.
- Amendment 2026-11-13: compressed Codex logs (`.jsonl.zst`) need `zstdDecompressSync` from `node:zlib`, which arrived
  in Node 22.15. On 22.13 and 22.14 the scan reports those files as failed and reads everything else
  (`docs/formats/codex.md`).

# 0011. No terminal UI library; plain, colour-aware output

- Status: Accepted
- Date: 2026-11-07
- Related: 0001, 0010

## Context
Every command (`scan`, `show`, `query`, `rules`, `wrapped`) is useful as printed output: a table, a timeline, JSON or
an HTML file. An interactive explorer built on Ink would add React and about 540 KB to the bundle, and Ink needs a
stub for its optional `react-devtools-core` import before Bun can bundle it.

## Options considered
- Ink now. A React dependency tree for a feature no command needs. Rejected.
- Other TUI libraries. Not evaluated, for the same reason.
- **No TUI library: plain output through `picocolors`, colour only on a TTY, `NO_COLOR` respected.** Chosen.

## Decision
- No TUI dependency. `show <session>` prints a timeline; `query` prints a table or JSON.
- If an interactive explorer is added later, it reads the same index data `show` reads, and Ink's devtools import
  is aliased to an empty stub when bundling.

## Consequences
- The bundle stays small, with no React in the dependency tree.
- Output stays scriptable and readable in CI logs and pipes.

# 0010. Packaging: one `dist/cli.mjs` on npm through trusted publishing

- Status: Accepted
- Date: 2026-11-07
- Related: 0001, 0002

## Context
`npx retrohound scan` must work on a fresh machine with only Node. The supply chain must stay small: few
dependencies, a committed lockfile, provenance, and no install scripts. `bun build --target=node` produces one file
with dependencies inlined. Standalone `bun build --compile` binaries are 89–115 MB each (41–55 MB gzipped).

## Options considered
- (a) **A Node-compatible JavaScript bundle on npm.** Small, no runtime dependencies, no install scripts. Chosen.
- (b) A Bun-only package. Fails on machines without Bun. Rejected.
- (c) Per-platform binaries as npm optional dependencies. About 100x bigger, seven packages per release, and breaks
  with `--omit=optional`. Rejected.
- (d) A native SQLite dependency. Needs install scripts. Rejected (0002).
- (e) GitHub Release binaries and a Homebrew formula. Possible later, built in CI only.

## Decision
- One npm package. `bin` points at `dist/cli.mjs`, built by `scripts/build.mjs` (`bun build`, Node target, minified,
  entry `src/cli/entry.ts`). Third-party code (`yaml`, `picocolors`, `commander`) is inlined, so the package has no
  runtime dependencies.
- `files` ships the bundle, its third-party licence notices (`dist/THIRD_PARTY_LICENSES`), `NOTICE`, the rules and
  their tests; npm adds the README and `LICENSE`. No install scripts. `engines.node` per 0001. The lockfile is
  committed.
- Publishing happens only from `.github/workflows/release.yml` on a `v*` tag, with npm trusted publishing (OIDC,
  automatic provenance). The workflow type-checks, runs the tests and checks that the tag matches `package.json`
  first.

## Consequences
- The bundled rules ship as plain YAML inside the package. No third-party rule corpus is bundled.
- Users on an older Node get npm's engine warning and a clear start-up error; there is no binary fallback.
- Standalone binaries (with checksums and attestations) and a Homebrew formula remain possible future work, built in
  CI only. Unsigned macOS binaries would need notarization to avoid quarantine prompts.

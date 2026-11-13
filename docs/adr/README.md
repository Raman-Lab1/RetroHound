# Architecture decision records

Each record states the context, the options considered, the decision and its consequences. All are accepted and
describe the code as it is; amendments are dated inside the record.

| ADR | Topic | Decision |
|---|---|---|
| [0001](0001-runtime-bun-dev-node-ship.md) | Runtime | Develop and test on Bun; ship one Node ≥ 22.13 bundle; no `Bun.*` in `src/` outside the SQLite adapter. |
| [0002](0002-storage-builtin-sqlite.md) | Storage | Built-in SQLite (`node:sqlite` / `bun:sqlite`) behind a small adapter; append-only index; read-only `query`. |
| [0003](0003-rule-format-sigma-subset.md) | Rule format | A Sigma v2.1 subset on an `ai_coding_agent` logsource; unsupported features reject the rule by name. |
| [0004](0004-correlation-event-count-temporal-ordered.md) | Correlation | `event_count`, `temporal_ordered`, `temporal`, scoped to a session or one agent stream. |
| [0005](0005-parser-versioning-tolerant-v1.md) | Parsing | One tolerant parser per agent, with a parser version that triggers re-indexing. |
| [0006](0006-raw-text-match-at-collection.md) | Raw text | Rules match raw text in memory while parsing; only masked fields are stored. |
| [0007](0007-secret-detection-and-masking.md) | Secrets | One pattern table drives masking, detection and fingerprints. |
| [0008](0008-retention-evidence-preservation.md) | Retention | The index keeps masked evidence after the agent deletes its transcripts. |
| [0009](0009-live-hook-guard.md) | Live guard | `PreToolUse` hook, JSON decision, enforce-lane rules only, fails open; careful installer. |
| [0010](0010-packaging-npm-bundle.md) | Packaging | One `dist/cli.mjs` on npm, no runtime dependencies, published with provenance. |
| [0011](0011-no-tui-library.md) | Terminal UI | No TUI library; plain, colour-aware output. |
| [0014](0014-output-schema-scan-json.md) | Output | One `retrohound.scan/0.1` JSON document; SARIF and ECS/OCSF NDJSON are transforms of it. |
| [0015](0015-tamper-evident-index.md) | Integrity | A hash chain over every write to events, findings and indexed files; `verify --head` checks it against a recorded head. |
| [0016](0016-first-seen-fields.md) | First seen | `first_seen_project` / `first_seen_global`: derived booleans from a scan pre-pass, never stored; rules declare `requires: [first_seen]`, hunt lane only. |

Numbers 0012 and 0013 are not published.

Licensing is stated in [LICENSE](../../LICENSE) (code, Apache-2.0) and [rules/LICENSE](../../rules/LICENSE)
(detection rules, DRL 1.1).

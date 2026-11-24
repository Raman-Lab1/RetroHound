# 0014. Output schema: one `retrohound.scan/0.1` JSON document; SARIF and NDJSON are transforms of it

- Status: Accepted
- Date: 2026-11-07
- Related: 0002, 0003, 0007

## Context
`scan` needs a documented machine-readable output, and SIEM users want SARIF and NDJSON in ECS or OCSF shape. SARIF
needs rule ids, descriptions, a message per result, a location and a fingerprint. ECS 9.1 added `gen_ai.*` fields;
the scanned agent must not go in ECS `agent.*`, which describes the shipper. OCSF has no agent event class, so
findings map to Detection Finding (class 2004).

## Options considered
- Exporters reading the database directly: three code paths coupled to the schema. Rejected.
- NDJSON as the native format: awkward for one human-run report, and rule metadata repeats on every line. Rejected.
- **One JSON document that holds everything SARIF, ECS and OCSF need; each exporter is a function from that
  document to a string.** Chosen.

## Decision
- `scan --format json` prints one document:
  `{ schema: "retrohound.scan/0.1", tool: {name, version}, scan: {...}, rules: [...], findings: [...] }`.
  - `rules[]`: the rules that fired, with their Sigma fields verbatim (`id`, `name`, `title`, `description`,
    `level`, `tags`, `lane`, and optional `falsepositives`, `references`, `author`).
  - `findings[]`: `id`, `rule_id`, `level`, `ts`, `session_id`, a one-line masked `message`, and `events` (full
    masked events; the first is the triggering event, the rest are a correlation's related events).
- `finding.id` is a hash of the rule id and the sorted event ids, stable across rescans because event ids are (0002).
  It is the SARIF fingerprint and the ECS/OCSF uid.
- All five Sigma levels are kept as strings. One table maps a level to the SARIF level and `security-severity`, the
  OCSF `severity_id` and the ECS risk score (`src/outputs/sarif.ts`, shared by `ndjson.ts`).
- Every string passes the output-side mask (0007); match-only fields (0006) never appear.
- **Exporters:** `--format sarif` (SARIF 2.1.0; the triggering event's `raw_ref` is the location with a project-dir
  base id, other events are related locations, and the home path is not emitted); `--format ndjson-ecs` and
  `--format ndjson-ocsf` (one line per finding). ECS is pinned to 9.1.0, the first version with `gen_ai.*`.
- The schema is documented in `docs/output-schema.md`; a breaking change bumps the `schema` string.

## Consequences
- No export needs the database or a transcript re-read.
- Findings embed their events, so the JSON is larger than a summary; that is fine for a local report.
- SARIF over transcript files does not fit GitHub code scanning (the paths are not repository files), so SARIF from
  `scan` is for local use and CI artifacts.
- Amendment 2026-11-13: `references` is not emitted in `rules[]` (the report rule type has no such field); the list
  above is what Sigma allows, not what the document holds. `docs/output-schema.md` lists the emitted fields.

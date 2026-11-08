# 0007. Secret detection and masking: one pattern table for both

- Status: Accepted
- Date: 2026-11-07
- Related: 0006 (raw text stays in memory), 0008 (evidence)

## Context
Secrets must never leave memory unmasked: not in the index, any output, logs, fixtures or test snapshots. On real
transcripts the most valuable single finding was a secret typed straight into a tool call (a full API key in
several shell commands, bearer tokens inside a sub-agent). Detecting secrets and masking them are the same problem;
two separate pattern lists would drift apart.

## Options considered
- Separate lists for detection (rule regexes) and masking (code). They drift. Rejected.
- Generic entropy-based detection. Noisy on hashes and UUIDs in coding transcripts. Not adopted.
- **One named pattern table in `src/normalize/mask.ts` drives masking and detection; rules consume its output.**
  Chosen.

## Decision
- **Patterns:**
  - *strong* (detected and masked): private-key blocks, AWS `AKIA`/`ASIA`, GitHub `gh[pousr]_` and `github_pat_`,
    GitLab `glpat-`, Slack `xox*` tokens and webhook URLs, Stripe keys, `sk-` style API keys, JWTs, `Bearer` tokens;
  - *mask-only* (too noisy to alert on): `*KEY|TOKEN|SECRET|PASSWORD|AUTH*=<value>` assignments (skipping `$VAR`
    and `<placeholder>`), and credentials in URLs.
  - A match keeps a short type prefix, then `…[masked]`.
- **API:** `mask(s)` and `secretKinds(s)` (pattern names only, never values). `mask` is idempotent.
- **Stored fields** (names and hashes only, safe to keep and re-evaluate):
  - `secret_kinds`, from the raw tool input and written content (0006);
  - `result_secret_kinds`, from the raw tool result;
  - `secret_fps`: the first 16 hex characters of the SHA-256 of each strong match. Strong tokens have enough entropy
    that the hash cannot be brute-forced; mask-only values get no fingerprint. One key typed five times becomes one
    entry in the "rotate these secrets" list that `scan` prints.
- **Rule:** `secrets_literal_in_tool_input` is an ordinary Sigma rule (`level: high`, enforce lane): any
  `secret_kinds`, or `result_secret_kinds` on a secret-file read only, so reading ordinary files that mention a key
  does not alert.
- **Masking points:** every string column on write, every finding excerpt, and again in every output writer (table,
  JSON, SARIF, NDJSON, `wrapped`).
- RetroHound never rewrites transcripts. Redacting them in place would destroy the evidence (0008).

## Consequences
- One place to add a token type; detection and masking cannot drift.
- Tests use defanged placeholder tokens per pattern (no real keys), a negative set (UUIDs, git SHAs, `$TOKEN`,
  `<your-key>`), and a check that no strong pattern appears in any snapshot or fixture.
- Unnamed high-entropy strings in free text are a known gap.
- Private IP addresses are not masked; `wrapped --anonymize` hides names for sharing.

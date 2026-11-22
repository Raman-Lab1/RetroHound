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
  - `secret_fps`: one `kind/fp` per strong secret (see the 2026-11-22 amendment). Mask-only values get no
    fingerprint. One key typed five times becomes one entry in the "rotate these secrets" list that `scan` prints.
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
- Unnamed high-entropy strings in free text are a known gap by default. `scan --mask-entropy` (opt-in, 0.3.2) masks
  any unnamed run of 32+ word characters that mixes upper case, lower case and digits at 4.5+ bits of Shannon entropy
  per character, and adds the kind `high_entropy` (no fingerprint), so `secrets_literal_in_tool_input` fires on it.
  Hex hashes and UUIDs never qualify; long random-looking identifiers and base64 blobs can, which is why it is off by
  default and meant for hunting, not the hook. Turning it on or off re-parses every transcript still on disk.
- Private IP addresses are not masked; `wrapped --anonymize` hides names for sharing.

## Amendment 2026-11-22: keyed fingerprints with their kind (0.3.2)
- **Why:** a plain SHA-256 let anyone holding an index or incident pack confirm a guessed low-entropy value (a weak
  `Bearer` token, a short password in a key-shaped slot), and the same secret had the same fingerprint on every
  machine, so packs from different people could be linked. The rotate lists also gave each fingerprint every kind
  seen on its event, not the kind of that secret.
- **Fingerprint:** the first 16 hex of HMAC-SHA256 of the token under a per-install key. The key is 32 random bytes
  in `~/.retrohound/fp.key`, made on the first secret seen (directory 0700, file 0600, created whole so a racing hook
  never reads a short key). A symlink, a non-regular file or a file that is not 32 bytes is refused, not replaced.
- **Stored as `kind/fp`**, kind being the first strong pattern that matched (table order, most specific first, so
  `Bearer sk-...` is `sk_key`). Not `kind:fp`: the mask reads `aws_access_key:<hex>` as an assignment.
- **Consequences:** fingerprints stay stable on one machine, so rescans and `git-secrets` still join. They do not
  match across machines or with an index from before 0.3.2; the parser versions were bumped so transcripts still on
  disk are re-fingerprinted. An archived session keeps its old bare fingerprint, which readers show with the event's
  kinds. Deleting the key changes every new fingerprint: rebuild the index (`retrohound purge`, then `scan`).

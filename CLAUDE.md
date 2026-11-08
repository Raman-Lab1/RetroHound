# RetroHound: notes for coding agents

Read `CONTRIBUTING.md` first. Design decisions: `docs/adr/`. Event fields: `docs/logsource.md`.

- Inspect real transcripts before writing any parser; document the format in `docs/formats/<agent>.md`.
- The product makes **zero network calls**. Secrets are masked everywhere. `fixtures/raw/` is never committed.
- Changes stay small (about 400 changed lines at most), with tests. `bun test` and `bunx tsc --noEmit` must pass.
- No downloads of detection-rule corpora, PoCs or payload samples; read their docs online instead. Test data is
  defanged: `example.invalid`, `192.0.2.x`, placeholder keys.
- Rules: Sigma v2.1 on the `ai_coding_agent` logsource (`docs/logsource.md`), each with positive and negative tests.

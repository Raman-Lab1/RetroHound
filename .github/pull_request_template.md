## What and why

<!-- One or two sentences. Link the issue if there is one. -->

## Checklist

- [ ] `bun run check` passes (tsc + tests)
- [ ] New or changed rules have positive and negative tests in `rules/tests/<rule>/` (`retrohound rules test`)
- [ ] Test data is defanged: `example.invalid`, `192.0.2.x`, placeholder keys; no real transcripts
- [ ] No network calls added to `src/`
- [ ] User-facing change noted in `CHANGELOG.md`

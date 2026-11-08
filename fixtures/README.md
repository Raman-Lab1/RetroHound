# Fixtures

- `raw/` — the author's real Claude Code transcripts. **Gitignored, never committed.**
- `redacted/` — 12 transcripts (7 main sessions, 5 sub-agents with their `.meta.json`), 14 MB, produced by
  `bun scripts/redact-fixture.ts fixtures/raw <out>` plus one `--drop <word>` per personal name the redactor cannot infer
  (those words stay out of the repo), then copied as a subset. Kept: JSON structure, line types, tool names, ids,
  timestamps, command shape. Usernames, projects, hosts, git remote owners, emails, public IPs, uuids (sessions,
  lines) and agent ids are pseudonymised consistently, file names included (`user1`, `proj3`, `192.0.2.x`,
  `0000002a-0000-4000-8000-000000000000`); web domains become `siteN.example` with their subdomain shape (`api.site7.example`),
  except the hosts the rules match on and a few infrastructure ones (`ALLOW` in the script); teammate names become
  `mateN` in every field (`amate3-<id>`, `mate3@session-…`), generic roles kept (`ROLES`); account and organisation uuids are zeroed; secrets masked; free text
  replaced by `[redacted text: <size>]`: prompts, replies, tool output, file bodies, any other string with
  whitespace, path segments with spaces, heredoc bodies, and quoted messages and comments in commands. Parsing the
  full redacted tree gives the same event counts per category as the raw one.
- The subset is the smallest set of files found that still covers every shape seen in the 56 raw files (107 features:
  line, attachment and system types, tool names incl. MCP/WebFetch/Monitor, blocked calls by denial kind, heredocs,
  compaction, spills, team agents, sub-agent parent links). The goldens' files (`proj10` main, `proj18` planner
  sub-agent) are always in it.
- Before committing new fixtures: read the output, run a leak check (names, emails, hosts, home paths, prose), and
  `bun scripts/check-staged.ts`.

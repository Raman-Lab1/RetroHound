# 0006. Match raw text at collection time; store only masked fields

- Status: Accepted, updated 2026-11-07
- Date: 2026-11-07
- Related: 0002, 0003, 0005, 0007, 0008

## Context
The index must never become a second copy of the secrets in a transcript: nothing raw is stored, only masked fields
and a pointer (`raw_ref`: file and line) back to the source. Several detections still need full raw text:
- invisible Unicode and concealment phrases in instruction files, skill bodies and fetched content;
- secrets in any tool input (MCP included), in written file content, in hook output, and in the result of a
  secret-file read.

## Options considered
1. Store raw text, opt-in or always. The database becomes a second secret store. Rejected.
2. Match only the stored, masked and truncated fields. The rules above miss, and masking changes what rules see.
   Rejected.
3. Re-read the raw JSONL on every scan. Breaks once the agent deletes old transcripts (0008). Rejected.
4. **Evaluate rules while parsing, on in-memory events that carry extra match-only fields; persist masked fields and
   findings only.** Chosen.

## Decision
- Four **match-only** fields exist only in memory and are never written to the database or any output
  (`docs/logsource.md`):
  - `content`: written or edited file bodies, heredoc bodies of data writes, instruction, @-file and skill text, hook
    output;
  - `tool_input`: the JSON of the raw tool input (every tool, MCP included);
  - `tool_response`: the paired tool result text;
  - `text`: full prompt and assistant text.
- Stored columns hold the normalized fields with every string masked (0007), plus a short masked `text_excerpt`.
- **One evaluator, two event sources:** the parser (with match-only fields) and database rows (without).
- **Per session:** `src/scan.ts` groups a session's files (main transcript, `subagents/*`, set-aside copies), parses
  them and evaluates their events together, de-duplicated by event id, so "one finding per session per rule" (0004)
  holds. A session is re-evaluated when one of its files changed, or every session when the rule-set hash differs
  from the last run; other sessions' findings are read back from the database. Memory holds one session's events.
- Sessions whose files are gone (0008) are re-evaluated from masked rows only, on a rule-set change, and only add
  findings.

## Consequences
- Secrets never leave process memory, and the warm scan reads findings straight from the database.
- `tool_response` exposes file contents to rules: a rule that matches it without a category or path filter is slow
  and noisy, so bundled rules always scope it (for example, to secret-file reads).
- New rules over archived sessions see masked fields only. That is the price of keeping evidence after deletion
  (0008); it is reported, not hidden.

# 0016. First-seen fields: `first_seen_project` and `first_seen_global`, derived at scan time

- Status: Accepted
- Date: 2026-11-11 (owner go)
- Related: 0003, 0004, 0006, 0009, 0015

## Context
"An agent used something it never used before" is a useful hunt: a new domain in a project, a new MCP server, a new
hook command, a new skill or plugin. The answer depends on history, not on the event, so no single-event Sigma rule
can express it today. Sigma v2.1 has no first-seen correlation type (its types are `event_count`, `value_count`,
`temporal`, `temporal_ordered` and the value aggregations), so any choice is a vendor extension. The index is
tamper-evident (0015): a new event column changes every row's JSON and forces a chain re-seed.

## Options considered
1. **Event columns, filled at index time.** Rules read them like stored fields. Adding columns to `events` changes
   every row hash, so the migration must re-seed the chain (0015), and the value of an old row would change whenever
   an older transcript turns up. Rejected.
2. **Behaviour drift by agent version.** "New since this agent version" would catch changed defaults. 57 indexed
   sessions carry no version. Rejected.
3. **A first-seen correlation type.** Not in Sigma 2.1; a backend would reject the rule. Rejected.
4. **Two derived booleans, computed by a pre-pass before evaluation, never stored.** Chosen. A plain field is the most
   portable form: a backend without it can map the field or drop the rule, and pySigma keeps unknown top-level keys such
   as `x-retrohound` in `custom_attributes`.

## Decision
- `first_seen_project` and `first_seen_global` are derived booleans beside `download_executed`: `true`/`false` only,
  no modifiers, never a correlation `group-by` key.
- An event is first-seen when it is the earliest `(ts, id)` event carrying a value of one of these kinds:
  domain (`domain`, case-folded), MCP server (`mcp_server`), hook command (`command_line` of a `tool_name` starting
  `hook:`), skill or plugin (`attribution` starting `skill:` or `plugin:`). `first_seen_project` keys on
  `(project_path, kind, value)`, `first_seen_global` on `(kind, value)`. An event carrying several kinds is first-seen
  when it is first for any of them.
- Indexed scans: every agent is indexed first, then one grouped query over `events` (`row_number()` per key, ordered by
  `ts, id`) gives the ids, then every agent is evaluated. `--no-index`: the same computation over the in-memory events.
  The ids sit in a module-level set that the scan clears when it ends.
- Cold start: both are false until the data (the index, or the in-memory events) spans 14 days from earliest to
  latest `ts`.
- A detection that reads either field must declare `x-retrohound.requires: [first_seen]` (`first-seen-not-required`
  otherwise), and such a rule must be lane `hunt` (`first-seen-enforce`). `requires` takes known values only.
- The live hook has no index: it loads enforce-lane rules only, so it never runs one of these rules. Elsewhere without a
  pre-pass (`rules test`) both fields are false.

## Consequences
- The hash chain, the schema and the stored events are unchanged: no migration, no re-seed.
- Findings are as of the scan that evaluated the session. A transcript older than everything indexed, found later,
  does not re-evaluate untouched sessions; a rule-set change (a full re-evaluation) does. Sessions evaluated during
  the cold start keep no first-seen findings until then.
- Values compare as stored: indexed values are masked (0007), in-memory values are not, so two hook commands that
  differ only in a masked secret are one value in the index and two with `--no-index`.
- With any rule reading the fields, every indexed scan runs the query, warm scans included. Indexed scans hold every
  agent's dirty sessions in memory at once, instead of one agent's.
- `rules test` cannot make these fields true: a positive test for such a rule needs the pre-pass over its test file.

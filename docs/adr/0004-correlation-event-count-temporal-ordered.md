# 0004. Correlation: `event_count`, `temporal_ordered` and `temporal`, scoped to a session

- Status: Accepted, amended 2026-11-07
- Date: 2026-11-07
- Related: 0003, 0005 (stream identity), 0006 (evaluation per session)

## Context
Some behaviour only shows as a sequence: a secret read followed by egress, a blocked read retried until it succeeds,
many deletions in a row. Sigma v2.1 defines correlation rules but leaves the window model open, so a cap on the number
of events between steps is a legitimate vendor extension. In real transcripts a sub-agent's file is its own ordered
stream, and the same event can satisfy two steps (`cat .env; curl ...` in one command).

## Options considered
- A custom correlation DSL or SQL windows. Rejected: not Sigma.
- All seven v2.1 correlation types. Rejected for now: no rule needs `value_*`; such rules are rejected by name (0003).
- **`event_count`, `temporal_ordered` and `temporal`.** Chosen; `temporal` costs a few lines once ordering exists.

## Decision
- `group-by` must contain `session_id`. With `agent_id` as well, each transcript stream (the main conversation or one
  sub-agent) is its own group, ordered by `seq`. Without `agent_id`, a group spans the main and sub-agent streams,
  ordered by `ts`, then `(agent_id, seq)` on a tie, so "the main agent reads a secret, a sub-agent sends it out" is
  visible. `aliases` are not supported.
- Windows slide. `timespan` bounds a window in time; the optional `x-retrohound.max_events_between: N` bounds the
  `seq` distance and needs `agent_id` in `group-by` (it is meaningless across streams and is rejected otherwise). If
  both are set, both must hold.
- `temporal_ordered` follows the order of `rules:`. Ordering is non-strict, so one event can satisfy consecutive
  steps. One finding per first-step event, pointing at every contributing event.
- `event_count` gives at most one finding per session per rule: the first window that meets its condition.
- `generate` follows Sigma (default `false`, which silences referenced rules). A rule that also alerts on its own sets
  `generate: true`. `rules list` marks rules that are silent because only a non-generating correlation uses them.
- References resolve by `name` or `id` across the loaded set; an unresolved reference or a cycle is a load error.

Examples in `rules/ai_coding_agent/correlation/`: `secrets_read_then_egress` (read, then a category-less egress base
rule), `blocked_retry_secret_read` (a blocked read followed by a successful one) and `exec_mass_delete`.

## Consequences
- "A key sent to its own API" is a normal pattern that Sigma cannot tell from exfiltration, because it would need the
  secret's name compared with the destination host. `secrets_read_then_egress` therefore stays `level: high` in the
  hunt lane and documents this false-positive class.
- `seq` counts every event in a stream, messages included, so event-gap limits are tuned on fixtures, not guessed.
- A missing or malformed `ts` sorts first and never fits a time window, so clock skew between streams can hide a
  cross-stream match.

# 0017. Instruction provenance: `instruction_named_package`, derived per session before evaluation

- Status: Accepted
- Date: 2026-11-23
- Related: 0004, 0006, 0007, 0016

## Context
"An instruction file names a package, then the agent installs it" separates a planted instruction from an ordinary
install. Correlations join on equal field values (ADR 0004), and the two events share no field: the instruction event
carries the text in `content`, the install carries the name inside `command_line`. Time cannot be the link either:
instruction files load at every session start, so "instruction then install" would match every session.

## Options considered
1. **A correlation option that matches a later event's field against a list on an earlier one.** A vendor extension to
   the Sigma correlation block, and every backend would reject it. Rejected.
2. **A derived list field on `instruction_load` events.** The match needs a set lookup across events, which no
   modifier does. Rejected.
3. **A derived boolean on the install event, computed by a pre-pass over the session's events.** Chosen. It is the
   shape of ADR 0016: a plain field a backend can map or drop, and `correlate.ts` is untouched, so every correlation
   test passes unchanged.

## Decision
- `instruction_named_package` is a derived boolean beside `first_seen_*`: `true`/`false` only, no modifiers, never a
  `group-by` key. It is true on an event whose `command_line` installs a package that an instruction text loaded
  earlier in the same `session_id` names. Sub-agents share the session.
- Instruction text is the `content` of a `category: instruction_load` event, a `Skill` call or an `@file` read.
- A package is named by an install command in that text (`npm install|i|add`, `pnpm add|install|i`, `yarn add`,
  `bun add`, `pip|pip3 install`, `uv add`, `cargo add`, `go get`, `gem install`), or by a backticked name followed by
  `package`, `library`, `module` or `dependency`. Names compare lower-cased, without `@version`, `==`/`>=` pins or
  `[extras]`; flags are skipped. The install side uses the same extraction on `command_line`.
- `evaluate` runs the pre-pass over the events it is given, in contract order, only when a loaded detection reads the
  field, and clears it afterwards. The result lives in a module-level `WeakSet` of event objects. Nothing is stored.
- A detection that reads the field must declare `x-retrohound.requires: [instruction_provenance]`
  (`provenance-not-required` otherwise), and must be lane `hunt` (`provenance-enforce`).
- Shipped as `control_plane_instruction_named_package_install`, an `event_count` `gte: 1` correlation over a silenced
  helper detection. A correlation, not a bare detection, because `rules test` evaluates a detection's positive lines
  one at a time and the link needs the instruction line beside the install.

## Consequences
- Masking: the instruction text is match-only (ADR 0006) and the name set never leaves memory. A finding carries only
  the install event, masked as always (ADR 0007).
- The index stores no `content`, and the live hook sees one call. A re-evaluation from the index and the hook never see
  the instruction text, so the field is false there and the rule runs only while a transcript is parsed (a first scan,
  or a changed file or rule set).
- Ceilings: only the install verbs above are read, so a package named in prose without backticks, or installed by
  another tool, is missed. A flag that takes a value (`--registry URL`) adds that value to the set, which can only
  cause an extra match in a session whose text already holds that value next to an install.
- A project whose CLAUDE.md lists its dependencies fires on their ordinary install; the level is `low`.

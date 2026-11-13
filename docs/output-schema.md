# Output schema: `retrohound.scan/0.1`

`retrohound scan --format json` prints one JSON document (`toJson` in `src/outputs/json.ts`). Source of truth for the
types: `src/outputs/report.ts`, `src/normalize/types.ts` (ADR 0014).

```ts
type ScanReport = {
  schema: "retrohound.scan/0.1";
  tool: { name: string; version: string };
  scan: {
    started_at: string; finished_at: string;       // ISO-8601
    sessions: number; events: number;
    blocked: number;                               // events with outcome "blocked" (includes interrupted, see denial_kind)
    blocked_breakdown?: {                          // only when blocked > 0 (added to 0.1, additive); counts, most first
      kinds: Record<string, { main: number; sub_agent: number }>; // denial_kind; "unspecified" when the agent gave none
      categories?: Record<string, number>;         // denial_category: Claude Code's classifier, Codex's risk level
      attributions?: Record<string, number>;       // skill:<x> | mcp:<server> | plugin:<x> the blocked call ran under
      top_projects: { project_path: string; blocked: number }[]; // the session's project, at most 5; "-" when none
    };
    subagent_events: number;                       // events that carry agent_id
    files: { indexed: number; skipped: number; gone: number; failed: number };
    suppressed?: number;                           // findings hidden by an ignore file; omitted when 0; still in the index
    lines?: { malformed: number; unknown_types: Record<string, number> }; // lines skipped in files parsed this run;
                                                   // unchanged files are not re-read, so a warm run reports 0
    archived_sessions: string[];                   // transcripts Claude Code deleted, still in the index (ADR 0008)
    root: string;                                  // where transcripts were looked for, masked; --agent all: every
                                                   // agent's default root, joined with ", "
    agents?: Record<string, { sessions: number; events: number; findings: number }>;
                                                   // --agent all only: per-agent counts after --since/--project/--level
                                                   // and the ignore file; absent for a single-agent scan. Each finding's
                                                   // agent is also in its events[].agent
  };
  rules: ReportRule[];                             // only rules that fired
  findings: Finding[];
};

type ReportRule = {
  id: string; name?: string; title: string; author?: string; description?: string;   // author: DRL 1.1 credit
  level: "informational" | "low" | "medium" | "high" | "critical";
  tags: string[]; lane: "hunt" | "enforce"; falsepositives?: string[];
};

type Finding = {
  id: string;            // sha256(rule_id + sorted event ids)
  rule_id: string; level: Level; ts: string; session_id: string;
  message: string;       // masked, one line
  events: AgentEvent[];  // events[0] is the primary event, the rest are related events of a correlation
};

type AgentEvent = {
  id: string; schema_version: "0.1"; agent: "claude_code" | "codex" | "antigravity" | "gemini_cli" | "cursor"; agent_version?: string;
  session_id: string; parent_session_id?: string;
  agent_id?: string;               // set = sub-agent event; absent = main conversation
  parent_tool_use_id?: string; project_path?: string; ts: string; seq: number;
  category: "tool_call" | "process_creation" | "file_access" | "file_event" | "web_request" | "mcp"
          | "instruction_load" | "config_change" | "user_prompt" | "assistant_message";
  tool_name?: string; command_line?: string; target_path?: string; url?: string; domain?: string;
  mcp_server?: string; mcp_tool?: string; outcome?: "success" | "error" | "blocked" | "unknown";
  permission_mode?: string; prompt_source?: string; entrypoint?: string; attribution?: string;
  denial_kind?: string; denial_category?: string;
  secret_kinds?: string[];         // pattern names found in tool input/content, never values
  result_secret_kinds?: string[];  // pattern names found in tool output
  secret_fps?: string[];           // first 16 hex of sha256 of each strong secret: use to group "rotate these"
  text_excerpt?: string;           // masked, at most 500 chars
  raw_ref: { file: string; line: number };  // pointer to the transcript line; raw text is never output
};
```

## Guarantees

- Every string is run through the secret mask again on output (ADR 0007).
- The match-only fields `content`, `tool_input`, `tool_response` and `text` never appear (ADR 0006), even if a caller
  left them on an event object.
- Event list fields (`secret_kinds`, `result_secret_kinds`, `secret_fps`) are absent, not `[]`, when empty. Document
  lists (`scan.archived_sessions`, `rules`, `findings`) are always present and can be `[]`.
- The scan makes no network calls.

## Stability

Fields may be added to `0.1` documents. Removing or renaming a field, or changing a meaning or type, bumps `schema`
(for example to `retrohound.scan/0.2`). Consumers should check `schema` first and ignore unknown fields.

## SARIF

`retrohound scan --format sarif` (`src/outputs/sarif.ts`) is a pure function over the document above. SARIF 2.1.0, one run,
`automationDetails.id` = `retrohound/hunt/`.

| Document | SARIF |
|---|---|
| `rules[]` | `tool.driver.rules[]`: `id`, `name`, `shortDescription` (title), `fullDescription` (description or title), `help.text` (includes `falsepositives`), `defaultConfiguration.level`, `properties.tags` (`security` + Sigma tags, max 10), `properties["security-severity"]` and `properties.author` (when the rule has one, DRL 1.1 credit) |
| `findings[]` | `results[]`: `ruleId`, `ruleIndex`, `level`, `message.text` |
| `events[0].raw_ref` | `locations[0]`: `uri` relative to the agent's transcript root, `uriBaseId` per agent (below), `region.startLine` = line, `startColumn` 1 |
| `events[1..]` | `relatedLocations[]` with a one-line message, same `uri` and `uriBaseId` rules |
| `finding.id` | `partialFingerprints`: `primaryLocationLineHash` = `<first 16 hex>:1`, `retrohound/v1` = full id |
| session / agent | `properties`: `session_id`, `agent`, `agent_id` and `scope` (`main` or `sub-agent`), `event_ids` |

| `agent` | `uriBaseId` | `uri` starts at |
|---|---|---|
| `claude_code` | `CLAUDE_PROJECTS` | the path after `~/.claude/projects/`: `<encoded-project>/<session>.jsonl` |
| `codex` | `CODEX_HOME` | `sessions/YYYY/MM/DD/rollout-*.jsonl[.zst]` or `archived_sessions/...` |
| `antigravity` | `ANTIGRAVITY_HOME` | `brain/<conversation-id>/.system_generated/...` |
| other agent, or a path without that agent's folder name | `TRANSCRIPTS` | the last two path segments |

Each `uri` segment is percent-encoded (a space becomes `%20`), so the `uri` is always a relative reference.

| Sigma level | SARIF level | security-severity |
|---|---|---|
| informational | note | omitted |
| low | note | 2.0 |
| medium | warning | 5.5 |
| high, critical | error | 8.0, 9.5 |

Example (shortened): `{"ruleId":"r1","ruleIndex":0,"level":"error","message":{"text":"..."},"locations":[{"physicalLocation":{"artifactLocation":{"uri":"-home-u-acme/aaaa.jsonl","uriBaseId":"CLAUDE_PROJECTS"},"region":{"startLine":7,"startColumn":1,"endLine":7}}}],"partialFingerprints":{"primaryLocationLineHash":"9b1e000000000000:1"}}`

That is a Claude Code result. A Codex result has `"artifactLocation":{"uri":"sessions/2026/09/14/rollout-aaaa.jsonl","uriBaseId":"CODEX_HOME"}`,
an Antigravity one `"artifactLocation":{"uri":"brain/<conversation-id>/.system_generated/logs/transcript_full.jsonl","uriBaseId":"ANTIGRAVITY_HOME"}`.

Known limits:
- Transcripts are not files in a repository. GitHub code scanning may drop or reject results with such URIs (untested).
  Use the output for local viewers and CI artifacts. SARIF for repo files (`preflight`) is not built yet: `preflight`
  outputs only `table` and `json`.
- `originalUriBaseIds` is omitted on purpose: it would publish the home directory. The encoded project directory still
  contains the user name, and SARIF has no `--anonymize` step yet (`wrapped` and `incident` do).
- `primaryLocationLineHash` uses the CodeQL-like `<hex>:1` shape in case GitHub checks it; not verified.
- A finding whose rule is missing from `rules[]` gets a stub rule so `ruleIndex` always resolves.
- No limit handling (GitHub keeps the top 5,000 results by severity, 10 MB gzipped).

## NDJSON (ECS, OCSF)

`retrohound scan --format ndjson-ecs|ndjson-ocsf` (`src/outputs/ndjson.ts`): one JSON object per finding, `\n` after every
line, empty report = empty output. Raw event lines are not exported. Every string is masked and match-only fields are
stripped before output. For ECS the primary event's attributes are copied into the alert line so it can be pivoted on its own.

### ECS 9.1.0

| Source | ECS field |
|---|---|
| `finding.id` / level | `event.id`, `event.severity`, `event.risk_score` (1/0, 2/21, 3/47, 4/73, 5/99); `event.kind: alert`, `event.dataset: retrohound.finding` |
| rule | `rule.id`, `rule.uuid`, `rule.name`, `rule.description`, `rule.ruleset: retrohound` |
| Sigma tags | `attack.tNNNN[.NNN]` to `threat.technique.id` / `.subtechnique.id`; other `attack.*` to `threat.tactic.name`; the rest to `tags[]` |
| primary event | `@timestamp`, `event.category/type/action/outcome/sequence`, `process.command_line`, `file.*`, `url.*`, `destination.domain`, `log.file.path`; `message` is the finding's message, not the event's excerpt |
| agent | `gen_ai.agent.name`, `gen_ai.agent.id` (sub-agent id), `gen_ai.provider.name` (`anthropic`, `openai` for Codex, `gcp.gemini` for Antigravity), `gen_ai.tool.name`; copies in `retrohound.{session_id,agent_id,parent_session_id,agent_version,project_path,outcome,raw_ref.line,mcp}` |
| finding | `retrohound.finding.{id,event_ids}` |

Absolute paths: unlike SARIF, which writes `uri` relative to the agent's transcript root, NDJSON keeps paths as the
index holds them. ECS `log.file.path` and OCSF `unmapped.retrohound.raw_ref.file` are the transcript's absolute path,
and ECS `process.working_directory` and `retrohound.project_path` (OCSF `unmapped.retrohound.project_path`) are the
session's working directory, so they carry the home path and the user name (`/Users/<name>/...`). `file.path` and
commands carry them too when the agent touched files under the home. Strip or rewrite these fields in the SIEM pipeline
if the user name must not be indexed.

### OCSF 1.9.0

Detection Finding (`class_uid` 2004, `type_uid` 200401, `activity_id` 1, `status_id` 1, `is_alert`). `time` is epoch
milliseconds. `severity_id` is the Sigma level 1 to 5. `finding_info` carries `uid`, `title`, `desc`, `analytic`
(rule id, `type_id` 1), `attacks[]`, `related_events[]`, `first_seen_time`, `last_seen_time`; `evidences[]` has one
entry per event (process, file, url, plus `ai_agent` and `api` below). `metadata.uid` = finding id,
`metadata.correlation_uid` = session id. The rest of the agent context is in `unmapped.retrohound` (`session_id`,
`agent`, `agent_id`, `parent_session_id`, `project_path`, `raw_ref`, `rule_author`, `other_tags`).

AI context per event, in `evidences[]` (OCSF 1.9.0 added `ai_agent` to the `evidences` object):

| Event field | OCSF |
|---|---|
| `agent` | `evidences[].ai_agent.name` |
| `agent_version` | `evidences[].ai_agent.version` (absent when the transcript has none) |
| `session_id` | `evidences[].ai_agent.instance_uid` |
| (constant) | `evidences[].ai_agent.type_id` 1 (Native: the agents are first-party, no third-party framework) |
| `mcp_server`, `mcp_tool` | `evidences[].api.service.name`, `evidences[].api.operation` (MCP calls only) |

Not filled: `ai_agent.ai_model` (no event field carries the model; it needs a collector change first),
`ai_agent.uid` (the agents have no stable agent id), and the non-MCP tool name (no schema-valid place on a finding).

The `ai_operation` profile is **not** declared in `metadata.profiles`. It was added in OCSF 1.8.0 (`ai_model`,
`message_context`), 1.9.0 added `ai_agent` and `delegation` to it and applied it to the system, network, application
and IAM classes, but no released version applies it to the Findings category: Detection Finding 1.9.0 lists Cloud,
Container, Data Classification, Date/Time, Host, Incident, Linux Users, macOS Users, OSINT, Record Integrity and
Security Control, and the base `finding` class on the schema's `main` branch still lists only `incident`. Declaring it
would put `ai_model`/`message_context` on a class that has no such attributes. `OCSF_VERSION` stays 1.9.0, the first
version with `evidences[].ai_agent`. Sources, checked 2026-11-11:
<https://github.com/ocsf/ocsf-schema/blob/main/CHANGELOG.md>, <https://schema.ocsf.io/1.9.0/profiles/ai_operation>,
<https://schema.ocsf.io/1.9.0/classes/detection_finding>, <https://schema.ocsf.io/1.9.0/objects/evidences>,
<https://schema.ocsf.io/1.9.0/objects/ai_agent>, <https://github.com/ocsf/ocsf-schema/blob/main/events/findings/finding.json>.

Example (shortened): `{"class_uid":2004,"type_uid":200401,"time":1789380160500,"severity_id":4,"finding_info":{"uid":"9b1e...","analytic":{"uid":"r1","type_id":1}},"evidences":[{"ai_agent":{"name":"claude_code","instance_uid":"aaaaaaaa-1111","type_id":1},"api":{"operation":"fetch","service":{"name":"docs"}}}],"unmapped":{"retrohound":{"agent_id":"agentxyz99"}}}`

Known limits:
- `ecs.version` is pinned to 9.1.0, the first with `gen_ai.*`, which is beta; `retrohound.*` copies survive renames.
- Sub-agent lineage (`agent_id`, `parent_session_id`) stays in `unmapped`. No OCSF extension is registered.
- An evidence with only `ai_agent` (a non-MCP tool call with no command, path or URL) misses 1.9.0's `evidences`
  at-least-one constraint, which does not count `ai_agent` yet (the unreleased changelog adds it).
- Per-event classes are not emitted, only findings.

## ATT&CK Navigator layer

`retrohound scan --format attack-layer` (`src/outputs/attack.ts`): one JSON layer, layer format 4.5 (`versions.layer`
4.5, `navigator` 4.9.0, no `attack`, so the Navigator uses its current ATT&CK), `domain` `enterprise-attack`. One
`techniques[]` entry per technique the findings' rules are tagged with (`attack.t1552.001` -> `T1552.001`; a rule
tagged with a sub-technique scores only the sub-technique, not also its parent). A parent tagged by other rules keeps
its own entry and score; `layout.showAggregateScores` with `aggregateFunction` `sum` makes the Navigator show it with
its sub-techniques added. `score` = findings, `comment` = each rule (name, else title, else id; counted per rule id)
with its count (`secrets_read_secret_file (3), ...`). No `tactic`, so an entry shows under every tactic of its
technique. `gradient` runs from 0 to the highest score; `layout.expandedSubtechniques` `annotated` opens scored
sub-techniques. `description` names the tool version, the scan time, the findings and the sessions scanned (after
`--since`/`--project`), and how many findings came from rules with no technique tag (those are not in the layer). A
technique id the Navigator's current ATT&CK no longer has is not shown there. Masked like `json`; no session ids,
paths or event data.

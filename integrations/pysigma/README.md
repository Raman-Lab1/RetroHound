# pySigma pipelines for `ai_coding_agent`

Two [pySigma processing pipelines](https://sigmahq-pysigma.readthedocs.io/en/latest/guides/processing_pipelines.html)
that turn RetroHound rules into SIEM queries over RetroHound's own exports:

| file | for data exported with | field names |
|---|---|---|
| `ecs.yml` | `retrohound scan --format ndjson-ecs` | ECS 9.1 (`process.command_line`, `file.path`, `gen_ai.*`, `retrohound.*`) |
| `ocsf.yml` | `retrohound scan --format ndjson-ocsf` | OCSF Detection Finding (`evidences.process.cmd_line`, ...) |

Both apply only to `logsource.product: ai_coding_agent`.

```sh
retrohound rules convert -t splunk --pipeline ecs                      # the shipped rules
retrohound rules convert -t lucene --pipeline ocsf -s my-rules/        # -s: skip what cannot convert
sigma convert -t splunk -p integrations/pysigma/ecs.yml rules/ai_coding_agent   # by hand
```

`rules convert` runs the `sigma` (sigma-cli) on your PATH; RetroHound installs nothing and downloads nothing. Without
it: `pipx install sigma-cli`, then `sigma plugin install <backend>`.

## What does not convert

A converted rule matches the exported **findings**, not every agent event: the NDJSON exports hold one line per
finding (with its events), so the queries are for alerting on, and re-hunting in, what RetroHound already found.

- **Derived fields** (`target_outside_project`, `command_line_unquoted`, `download_executed`, `first_seen_*`): the
  engine computes them and no export has them. A rule that uses one fails with a `detection_item_failure`.
- **Fields an export lacks**: listed under `retrohound_*_unmapped` in each file, with a `detection_item_failure`
  rather than an invented name. Among them the match-only fields (`content`, `tool_input`, `tool_response`, `text`),
  which never leave memory, and `denial_kind`, `attribution`, `secret_kinds` and the other fields neither export carries.
  OCSF also lacks `tool_name`, `mcp_*`, `outcome`, `seq` and the event `ts`.
- **Correlations** convert only on backends that support Sigma correlations; `x-retrohound` options are ignored.
- **Logsource category**: ECS adds `event.category` / `event.type`, which cannot tell `instruction_load` from
  `file_access` nor `config_change` from `file_event`; `user_prompt` and `assistant_message` rules fail. OCSF has no
  per-event category, so category is not applied there. `logsource.service` is not applied in either.

Pipeline schema checked against the pySigma docs (processing pipelines guide, transformations and conditions reference,
2026-11): `field_name_mapping`, `add_condition`, `detection_item_failure`, `rule_failure`, `logsource` rule conditions
and `include_fields` (`mode: re`) field name conditions. `tests/cli/convert.test.ts` checks every logsource field is
mapped or listed here, and that each mapped name holds the event's value in the export.

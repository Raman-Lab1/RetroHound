# Integrations

Ready-made configuration for SIEMs, DFIR, CI and package managers. RetroHound itself stays offline: these files only
read its output or run it. `tests/integrations.test.ts` checks they parse, that Wazuh covers every level, and that
every pinned version equals `package.json`'s. None of them is published yet; each section ends with what that takes.

## Feeding a SIEM

Wazuh and Splunk read the `ndjson-ecs` format (`docs/output-schema.md`): one finding per line, `@timestamp` first,
`event.severity` 1 to 5 for the Sigma level, `event.id` a stable finding id. Append a scan to a file on a schedule,
as the user whose transcripts it reads:

```sh
sudo install -d -o "$USER" /var/log/retrohound    # once
retrohound scan --agent all --since 2d --format ndjson-ecs >> /var/log/retrohound/findings.ndjson   # e.g. daily, cron or launchd
```

Each run prints every finding from sessions active in the window, so a session that spans two runs is sent twice.
Deduplicate on `event.id` in the SIEM.

## Wazuh

`integrations/wazuh/`: `localfile.xml` (agent side) reads the file with `log_format json`; `local_rules.xml`
(manager side) matches `event.module: retrohound` with Wazuh's built-in JSON decoder (no custom decoder needed) and
maps the level:

| Finding level | `event.severity` | Rule | Wazuh level |
|---|---|---|---|
| informational | 1 | 100801 | 3 |
| low | 2 | 100802 | 5 |
| medium | 3 | 100803 | 8 |
| high | 4 | 100804 | 12 |
| critical | 5 | 100805 | 14 |

100800 is the level 0 grouping rule. Descriptions carry `rule.name` and `message`; every other field is in the alert's
`data.*`.

Install: add `localfile.xml` inside `<ossec_config>` in the agent's `ossec.conf` and restart the agent; append
`local_rules.xml` to `/var/ossec/etc/rules/local_rules.xml` on the manager and `systemctl restart wazuh-manager`.
Test offline first: run `/var/ossec/bin/wazuh-logtest` on the manager and paste one line of the file; it should show
the json decoder and one of rules 100801 to 100805.

Verified against: [JSON decoder](https://documentation.wazuh.com/current/user-manual/ruleset/decoders/json-decoder.html),
[localfile](https://documentation.wazuh.com/current/user-manual/reference/ossec-conf/localfile.html),
[rules syntax](https://documentation.wazuh.com/current/user-manual/ruleset/ruleset-xml-syntax/rules.html),
[custom rules](https://documentation.wazuh.com/current/user-manual/ruleset/rules/custom.html) (ids 100000 to 120000),
[rule levels](https://documentation.wazuh.com/current/user-manual/ruleset/rules/rules-classification.html),
[wazuh-logtest](https://documentation.wazuh.com/current/user-manual/reference/tools/wazuh-logtest.html).
Not yet run against a live manager.

To publish: nothing to publish; run it through `wazuh-logtest` once and adjust the ids if they clash.

## Splunk

`integrations/splunk/`: `props.conf` defines sourcetype `retrohound:ecs` (one event per line, timestamp from
`@timestamp`, JSON fields at search time); `inputs.conf` monitors the file into index `retrohound`.

Install: `inputs.conf` on the forwarder that reads the file; `props.conf` on the indexer or heavy forwarder that
parses it and on the search head; create the index. `TIME_FORMAT` is not set because Claude Code and Codex times have
milliseconds and Antigravity's do not; Splunk's automatic ISO-8601 recognition reads both.

Verified against: [props.conf](https://help.splunk.com/en/splunk-enterprise/administer/admin-manual/10.6/configuration-file-reference/10.6.0-configuration-file-reference/props.conf),
[inputs.conf](https://help.splunk.com/en/splunk-enterprise/administer/admin-manual/10.6/configuration-file-reference/10.6.0-configuration-file-reference/inputs.conf).
Not yet run against a live instance.

To publish: optional, package the two files as a Splunk app (`default/props.conf`, `default/inputs.conf` disabled by
default, `app.conf`) and submit it to Splunkbase.

## Velociraptor

`integrations/velociraptor/Custom.RetroHound.Scan.yaml`: a CLIENT artifact. It fetches RetroHound's npm tarball as a
Velociraptor tool, unpacks it into a temporary directory, globs every user's `.claude`, `.codex` and
`.gemini/antigravity-cli` (Linux, macOS, Windows; editable `AgentRoots` table), runs
`node cli.mjs scan --agent <agent> --root <dir> --no-index --format ndjson-ecs` for each and returns one row per
finding (time, rule, severity 1 to 5, message, session, project, command line, file, URL, techniques, transcript).
`--no-index` means nothing is written on the endpoint. The endpoint needs Node 22.13 or later (`NodePath`).

Install: Artifacts, Add an artifact, paste the YAML. In Tools, set the `RetroHound` tool's hash, or upload the
tarball and serve it locally. Collecting needs the `EXECVE` permission.

Verified against: [artifacts](https://docs.velociraptor.app/docs/artifacts/),
[tools](https://docs.velociraptor.app/docs/artifacts/tools/),
[parameters](https://docs.velociraptor.app/docs/artifacts/parameters/),
[FetchBinary](https://docs.velociraptor.app/artifact_references/pages/generic.utils.fetchbinary/),
[unzip](https://docs.velociraptor.app/vql_reference/popular/unzip/) (`type="tgz"`),
[execve](https://docs.velociraptor.app/vql_reference/popular/execve/),
[tempdir](https://docs.velociraptor.app/vql_reference/popular/tempdir/),
[glob](https://docs.velociraptor.app/vql_reference/popular/glob/),
[path_join](https://docs.velociraptor.app/vql_reference/basic/path_join/). Not yet run on a live server.

To publish: add `expected_hash` (SHA-256 of the published tarball) to the tool, test on a lab client, then optionally
submit it to the Velociraptor artifact exchange.

## GitHub Action

`action.yml` (repository root): a composite action. It installs Node 24 (`actions/setup-node`, which also changes
`node` for later steps of the job) and runs `npx --yes retrohound@0.3.0` with:

| Input | Default | Meaning |
|---|---|---|
| `command` | `preflight` | `preflight` (the checked-out repo's agent surface) or `scan` (always `--no-index`) |
| `fail-on` | `high` | fail the step on a finding at or above this level; empty never fails on findings |
| `args` | | extra arguments, split on spaces (`--format json`, a directory, `--root dir`) |
| `output` | | write the report to this file instead of the log |

Output `exit-code`: 0 ok, 1 findings at or above `fail-on`, 2 bad input, 3 runtime failure. The CI side downloads the
package from npm; RetroHound makes no network calls itself.

```yaml
- uses: actions/checkout@v5
- uses: Raman-Lab1/RetroHound@v0.3.0
  with:
    command: preflight
```

SARIF: `scan` has `--format sarif`; `preflight` has only table and json for now. Transcripts are not files in the
repo, so code scanning may drop such results (see the SARIF limits in `docs/output-schema.md`); an uploaded artifact
always works:

```yaml
- id: rh
  uses: Raman-Lab1/RetroHound@v0.3.0
  with:
    command: scan
    args: --root transcripts --format sarif
    output: retrohound.sarif
- if: always()
  uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: retrohound.sarif
    category: retrohound
```

Verified against: [metadata syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax),
[Marketplace](https://docs.github.com/en/actions/how-tos/create-and-publish-actions/publish-in-github-marketplace).

To publish: the repo must be public with one `action.yml` at the root (this one); accept the Marketplace Developer
Agreement, use 2FA, check the name `RetroHound` is free, then draft a release with "Publish this Action to the GitHub
Marketplace" ticked and a `v0.3.0` tag. Bump the pinned version with each npm release (the test enforces it).

## Homebrew

`integrations/homebrew/retrohound.rb`: a formula for an own tap. It installs the npm tarball with
`std_npm_args` (install scripts ignored; RetroHound has none) under `depends_on "node"`, links `bin`, and its test
checks `--version`, that the bundled rules load, and that `preflight` runs on an empty directory.

Verified against: [Language-specific formulae, Node](https://docs.brew.sh/Language-Specific-Formulae),
[taps](https://docs.brew.sh/How-to-Create-and-Maintain-a-Tap).

To publish: create a public `homebrew-tap` repository, copy the file to `Formula/retrohound.rb`, replace the
placeholder `sha256` with `curl -sL <url> | shasum -a 256` of the published tarball, run
`brew install --build-from-source ./Formula/retrohound.rb && brew test retrohound && brew audit --strict retrohound`,
and push. Users run `brew install raman-lab1/tap/retrohound`. Update `url` and `sha256` with each release.

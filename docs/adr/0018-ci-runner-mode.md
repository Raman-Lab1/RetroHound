# 0018. CI-runner mode: scan the runner's transcripts after the agent step, optionally guard it with the hook

- Status: Proposed (for 0.4; deferred from 0.3.2 on 2026-11-22)
- Date: 2026-11-25
- Related: 0007, 0008, 0009, 0014, 0016, 0017

## Context
Coding agents now run inside CI: a GitHub Action that reviews pull requests, answers issues or fixes a failing build
with Claude Code, Codex or Antigravity CLI. The text the agent works on (a PR description, a diff, an issue comment)
is written by whoever opened it. The "Comment-and-Control" class, public since April 2026, is that text steering the
agent into reading a secret (an environment dump, a token file) and posting it back as a comment or review, where
anyone can read it. No network egress rule sees that: the post goes to the GitHub API the job needs anyway.

What exists today:
- `action.yml` (docs/integrations.md) is a composite action that installs a pinned `retrohound@<version>` from npm
  into `$RUNNER_TEMP` and runs `preflight` (the checked-out repo's agent surface) or `scan --no-index` with
  `--fail-on`, `--format` and an `output` file.
- `injection_untrusted_then_secret_comment` (hunt lane, `medium`) is the Comment-and-Control shape as a
  `temporal_ordered` correlation: untrusted content in, a secret harvest, then `gh issue|pr comment`, `gh pr review`,
  a posting `gh api` call or `gh release create|edit` with notes, within 30 minutes in one session. Its siblings
  `injection_untrusted_then_secret_egress`, `_pipe_to_shell`, `_download_run` and `_package_install` share step one.
- The live hook (ADR 0009) is log-first, decides only with enforce-lane single-event rules, and fails open.

None of this is wired for a runner. The transcripts are written where the runner user's home is, and an ephemeral
runner deletes them when the job ends, so a later job or a scheduled scan never sees them.

## Where the transcripts are on a runner
From the collectors' default roots (`src/collectors/*/`) and docs/formats/*.md:

| Agent | Root | Transcripts |
|---|---|---|
| Claude Code | `$CLAUDE_CONFIG_DIR`, else `$HOME/.claude` | `projects/<encoded-cwd>/<sessionId>.jsonl`, sub-agents under `<sessionId>/subagents/` |
| Codex CLI | `$CODEX_HOME`, else `$HOME/.codex` | `sessions/YYYY/MM/DD/rollout-*.jsonl` (`.zst` after 7 days) |
| Antigravity CLI | `$HOME/.gemini/antigravity-cli` | `brain/<conv>/.system_generated/logs/transcript_full.jsonl` |

`$HOME` is the runner user's home (on GitHub-hosted Linux runners, `/home/runner`). What is not known yet:
- whether a given agent action sets `CLAUDE_CONFIG_DIR` or `CODEX_HOME` to a temporary directory of its own;
- whether a headless run (`claude -p`, `codex exec`, an SDK call) writes a transcript at all with that action's
  settings, and under which `entrypoint` / `prompt_source`;
- where a Docker container action writes: inside the container `HOME` is `/github/home`, which GitHub mounts from
  the runner's temp directory, but an agent may run in a container with its own `HOME`.

So the first validation is one real agent-action run in a test repository, with a harmless prompt, listing what was
written under the runner's home and temp directories. It has not been done. Until then the paths above are the
collectors' defaults, not observations from a runner.

## Options considered
1. **A network proxy on the runner** that inspects what the agent sends. RetroHound makes no network calls; the
   comment goes to an API host that must stay reachable, so the proxy would have to read and judge comment bodies.
   A different product. Rejected.
2. **An LLM judge** over the agent's actions. A network call, non-deterministic, and open to the same injected text it
   is meant to judge. Rejected.
3. **Upload the raw transcripts** as a job artifact and scan them elsewhere. Raw transcripts hold unmasked secrets and
   the attacker's text; on a public repository artifacts are readable by anyone with read access. Rejected: only
   RetroHound's masked output leaves the runner.
4. **Scan in a separate job.** The runner, and the transcripts with it, are gone by then unless they are uploaded
   (option 3). Rejected.
5. **Preflight only**, before the agent step. Still useful (a planted `.claude/settings.json` or `.mcp.json` in the
   PR), but it cannot see what the agent did. Kept as a separate step, not the answer.
6. **A post-step scan in the same job, plus an optional hook in block mode installed before the agent step.** Chosen.

## Decision
### 1. Post-step scan (the default)
- The scan runs in the same job as the agent, after the agent step, with `if: always()`, so it also runs when the
  agent step fails or is cancelled by a timeout. It reads the runner's default roots: `--agent all`, or one agent with
  `--root` when the agent action moved its config directory (the scan step then gets the same environment variable).
- It runs `scan --no-index` as the action already does: nothing is written on the runner except the report.
- Output is SARIF (`--format sarif`) or ECS/OCSF NDJSON (ADR 0014), written to `output` and uploaded with
  `actions/upload-artifact` under `if: always()`. The report is masked like every other output (ADR 0007). SARIF upload
  to code scanning stays optional: transcripts are not repo files and code scanning may drop such results
  (docs/output-schema.md).
- `--fail-on` decides the job. The CI recommendation is `fail-on: medium`, because the injection correlations are
  `medium`; the action's default stays `high` for `preflight`.
- On a self-hosted runner that keeps `$HOME` between jobs, the scan would report earlier jobs' sessions again. The
  documented fix is a per-job config directory (`CLAUDE_CONFIG_DIR` / `CODEX_HOME` under `$RUNNER_TEMP`) for the agent
  step and the scan; `--since` is the fallback.

Shape of the workflow (versions illustrative; pin actions by SHA in real use):

```yaml
- uses: actions/checkout@v5
- uses: Raman-Lab1/RetroHound@v0.4.0          # preflight of the checked-out PR, before the agent sees it
- uses: some-org/agent-action@v1              # the coding agent
- if: always()
  uses: Raman-Lab1/RetroHound@v0.4.0
  with:
    command: scan
    args: --agent all --format sarif
    fail-on: medium
    output: retrohound.sarif
- if: always()
  uses: actions/upload-artifact@v4
  with:
    name: retrohound
    path: retrohound.sarif
```

### 2. Live hook in block mode (opt-in)
- Before the agent step, `hook install --mode block` writes RetroHound's `PreToolUse` entry into the runner user's
  agent settings (ADR 0009 installer, unchanged). For 0.4 this is a new `command` value on the action; the hook runs
  the copy the action installed under `$RUNNER_TEMP` with the Node that `setup-node` put on the runner, and
  `hook status` must report that both pass the path check.
- Block, not log: on a runner nobody reads the trial log during the run, and nobody is there to answer `confirm`.
  Only enforce-lane single-event rules decide, as on a laptop; the correlations, including the Comment-and-Control
  one, never block. The useful block is the harvest step: `secrets_env_dump`, `secrets_read_secret_file`,
  `secrets_literal_in_tool_input`, `secrets_credential_store_access` are enforce-lane today.
- **Fail-closed is acceptable here.** On a laptop `--fail-closed` can lock the user out of their own agent; on a
  disposable runner the worst case is a failed job. For Claude Code the CI recommendation is `--fail-closed`. What it
  covers is unchanged (ADR 0009, amendment of 2026-11-13): a missing runtime or entry file, a crash before `hookRun`
  starts, or a timeout blocks every tool call; an internal error (bad payload, rules that do not load) still exits 0
  with no decision and one stderr line that the agent, not the job log, receives. The post-step scan is the backstop
  for what the hook let through, and runs whatever the hook did.
- Codex has no fail-closed setting and runs a new hook only after it is trusted in `/hooks`; whether `codex exec`
  on a runner runs an untrusted hook at all is unknown, so the Codex hook in CI is unsupported until tested.
  Antigravity CLI's hook still needs its live check (ADR 0009).

### 3. Rules
- No new rules in this ADR, and no CI rule pack for now. The scan already evaluates every lane; the CI-relevant rules
  are the `injection_untrusted_then_*` correlations, the secret egress rules (`secrets_read_then_egress*`,
  `network_new_domain_after_secret_read`), `github_post_via_gh` as their step three, and the enforce-lane secret
  rules. `--level` and `--fail-on` are enough to cut noise; a pack or a lane filter is revisited after the first real
  run shows what fires.
- A known gap: an agent action usually puts the issue or PR text into the prompt itself rather than fetching it with
  `gh issue view`. Then `untrusted_content_received` never matches and the correlations miss the attack, even though
  the secret harvest and the post are in the transcript. Closing it (for example treating a CI session's first prompt
  as untrusted content) needs the transcript of a real run first.

### Constraints that stay
- RetroHound makes zero network calls; the runner fetches the npm package, the product does not. No telemetry.
- Secrets are masked in every output, the uploaded report included. Raw transcripts never leave the runner.
- The action pins the npm package by exact version (enforced by `tests/integrations.test.ts`), and installs it from
  `$RUNNER_TEMP` so the reviewed repo's `.npmrc` is not read.
- `args` takes no untrusted text (action.yml): never interpolate PR or issue fields into it.

## Consequences
- The job fails on what the agent did, after it did it. A secret posted in a comment is already public when the scan
  fails the job; the value is knowing, rotating the key and deleting the comment quickly. Only the hook can stop the
  harvest, and only for single-event enforce rules.
- Least-privilege job settings (a read-only `GITHUB_TOKEN`, no repository secrets in the agent step's environment,
  no `pull_request_target` with a checkout of the PR head) remain the first control. RetroHound reports; it does not
  replace them.
- Paths are the collectors' defaults until a real run confirms them; docs/integrations.md will say so.
- A fail-closed hook that cannot start fails the agent step, and so the job. That is visible and intended.

## Open questions for the owner
1. Run the validation: one agent-action run (Claude Code first) in a test repository, recording where transcripts and
   settings land and whether the hook ran. Which action and which repository?
2. Should the hook be a `command` value on the existing action, or a second action in the same repository?
3. Recommend `fail-on: medium` for CI in the docs only, or make the action's default depend on `command`?
4. Should `hook run` also append internal errors to the hook log, so the post-step can fail the job when the hook
   was not deciding?
5. Is the prompt-borne untrusted content gap worth a derived field (in the manner of ADR 0016/0017), once a real CI
   transcript shows how the prompt is recorded?

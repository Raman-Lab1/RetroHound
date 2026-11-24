# Security policy

## Reporting

Report vulnerabilities privately through GitHub: **Security → Report a vulnerability**
([new advisory](https://github.com/Raman-Lab1/RetroHound/security/advisories/new)). Private reporting is enabled on
this repository. Please do not open a public issue. You should get a first reply within 7 days.

In scope:

- **Bypasses of `enforce`-lane rules**: a command the live hook should deny but lets through (quoting, encoding,
  a wrapper, a different tool). These are reported privately because the hook guards real sessions.
- Anything that makes RetroHound leak what it should mask: secrets in the index, outputs or logs.
- A network call from the product, which must make none.
- `hook install` writing somewhere unsafe, or the hook failing closed when it should fail open.

A `hunt`-lane rule that misses something, or fires on something benign, is a normal issue: use the
"False positive" or "New rule" templates.

## Advisories

We publish a GitHub security advisory for every confirmed `enforce`-lane bypass or masking leak, and request a CVE
when users on a released version are exposed.

## Supported versions

Only the latest release gets fixes while the project is at 0.x.

## Threat model and limits

RetroHound runs as the same user as the agent it watches. An agent that is compromised, or told to, can delete or
rewrite the transcripts and the RetroHound index, because both are files that user owns.

RetroHound can detect that, not prevent it. Every write to the index goes into a hash chain: `retrohound verify`
checks it and prints the head, and `verify --head <hash>` fails if an earlier head is no longer in the chain. The rules
`files_transcript_tamper_command` (a shell command deleting or overwriting transcripts or agent history),
`control_plane_transcript_retention_lowered` (agent settings that keep transcripts under 10 days, or not at all) and
`control_plane_hook_self_removal` (the agent running `retrohound hook uninstall`) flag the usual ways. The live hook
also has a built-in guard, `retrohound_hook_tamper`, that no ignore entry can silence: an agent file write into
`~/.retrohound` or the rules directories, or a shell command that names one of them together with a write command
(`>`, `rm`, `mv`, `cp`, `sed -i`, an interpreter and the like), is denied in block mode, asked about in confirm mode
and logged in log mode. It matches literal text only, so a write through a variable, a script file or a relative path
gets past it. For tamper resistance, keep the `verify` head somewhere the agent cannot write, or forward findings
to a SIEM (`scan --format ndjson-ecs`, [docs/integrations.md](docs/integrations.md)) as they happen.

The live hook is opt-in. It installs in log mode by default, and enforce mode (`--mode block` or `confirm`) is a
separate choice. It fails open: if the hook errors, the tool call goes ahead. It sees only what the agent passes to
it, so a child agent started with different settings can skip a user-scope hook (see the README).

## Reports and test data

Never attach a real transcript, `.env` or key. Reduce it to the one event that matters and defang it:
`example.invalid` hosts, `192.0.2.x` addresses, placeholder keys.

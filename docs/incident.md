# Incident packs

`retrohound incident <id>` writes one folder you can hand to an incident responder or your SOC:

```sh
retrohound incident 1111aaaa                 # a session id prefix
retrohound incident 507134cd --out ./case-42 # a finding id prefix (from `scan --format json`)
retrohound incident 1111aaaa --anonymize     # project names, user name and project dirs, hosts and git owner/repo hashed
```

`<id>` is an unambiguous prefix of a session id or a finding id. A finding selects the session(s) its events belong
to. A prefix matching more than one id is a usage error (exit 2) that lists the matches.

| file | holds |
|---|---|
| `incident.json` | `schema: retrohound.incident/0.1`: tool version, the rules behind the findings (id, name, level, sha256 of the rule file) the index's last `rule_set_hash` and `index_head` (the index's hash-chain head when the pack was written: `retrohound verify --head <index_head>` later shows the index still holds what the pack came from, and lists what was added since), the sessions (with `archived`), counts by outcome (blocked, success, error, unknown), the rotate list (secret kind and fingerprint, never a value), findings (rule, level, event ids, primary first), the sub-agent tree (main and each sub-agent with the tool call that spawned it), evidence provenance per transcript file (path, sha256, first seen, last seen, gone at) and the masked timeline. |
| `index.html` | The same data, readable in a browser. One self-contained file: no scripts, links, fonts or images, and a Content-Security-Policy that blocks loading anything. |
| `manifest.json` | The sha256 of `incident.json` and `index.html`. |

- **Index only.** The pack reads the index read-only and never the transcripts, so it works the same for sessions
  whose transcripts the agent already deleted (ADR 0008).
- **Masked.** Every string is masked again on the way out (ADR 0007). Secrets appear as kind and fingerprint only.
  Paths are as the index holds them; `--anonymize` hashes project names, the user name and project dirs in paths and
  commands, as `wrapped --anonymize` does.
- **New folder only.** `--out` (default `./retrohound-incident-<first 8 chars of the id>`) must not exist or be empty:
  a pack never overwrites or mixes with other files, so the manifest describes the whole folder. Files are written
  0600 in a 0700 folder.
- **Reproducible.** No generation time, every list sorted: the same index gives byte-identical files. A later scan
  changes `last_seen`, so a pack is tied to the index state it was built from.

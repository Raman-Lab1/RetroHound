# Security policy

## Reporting

Report vulnerabilities privately through GitHub: **Security → Report a vulnerability**
([new advisory](https://github.com/Raman-Lab1/RetroHound/security/advisories/new)). Please do not open a public issue.
You should get a first reply within 7 days.

In scope:

- **Bypasses of `enforce`-lane rules**: a command the live hook should deny but lets through (quoting, encoding,
  a wrapper, a different tool). These are reported privately because the hook guards real sessions.
- Anything that makes RetroHound leak what it should mask: secrets in the index, outputs or logs.
- A network call from the product, which must make none.
- `hook install` writing somewhere unsafe, or the hook failing closed when it should fail open.

A `hunt`-lane rule that misses something, or fires on something benign, is a normal issue: use the
"False positive" or "New rule" templates.

## Supported versions

Only the latest release gets fixes while the project is at 0.x.

## Reports and test data

Never attach a real transcript, `.env` or key. Reduce it to the one event that matters and defang it:
`example.invalid` hosts, `192.0.2.x` addresses, placeholder keys.

// Pre-commit check: fails when a staged file holds a secret (mask.ts detector) or lives under fixtures/raw/.
// Prints file + kind, never the value. Install (changes your git config, so it is yours to run):
//   printf '#!/bin/sh\nexec bun scripts/check-staged.ts\n' > .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
import { spawnSync } from "node:child_process";
import { secretKinds } from "../src/normalize/mask.ts";

const git = (args: string[]) => spawnSync("git", args, { encoding: "buffer", maxBuffer: 1 << 28 });

/** Problems in the staged (index) version of the files; empty when clean. */
export function checkStaged(): string[] {
  const names = git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]).stdout.toString("utf8").split("\0").filter(Boolean);
  const problems: string[] = [];
  for (const f of names) {
    if (/^fixtures\/raw\//.test(f)) { problems.push(`${f}: fixtures/raw is never committed`); continue; }
    const body = git(["show", `:${f}`]).stdout;
    if (body.includes(0)) continue; // binary
    const kinds = secretKinds(body.toString("utf8"));
    if (kinds.length) problems.push(`${f}: secret (${kinds.join(", ")})`);
  }
  return problems;
}

if (import.meta.main) {
  const problems = checkStaged();
  for (const p of problems) console.error(`check-staged: ${p}`);
  process.exit(problems.length ? 1 : 0);
}

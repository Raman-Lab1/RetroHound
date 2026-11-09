#!/usr/bin/env node
// Bundle entry (ADR 0010): bin.ts with a Node shebang. The default rules dir resolves next to dist/ (see version.ts).
const argv = process.argv.slice(2);
// `hook run` runs on every tool call: skip loading commander and every other command (`--help` still goes to commander).
process.exitCode = argv[0] === "hook" && argv[1] === "run" && !argv.some((a) => a === "--help" || a === "-h")
  ? await (await import("./hook.ts")).hookMain(argv.slice(2))
  : await (await import("./main.ts")).main(argv);

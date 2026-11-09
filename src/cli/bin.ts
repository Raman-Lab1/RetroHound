#!/usr/bin/env bun
const argv = process.argv.slice(2);
// `hook run` runs on every tool call: skip loading commander and every other command (`--help` still goes to commander).
process.exitCode = argv[0] === "hook" && argv[1] === "run" && !argv.some((a) => a === "--help" || a === "-h")
  ? await (await import("./hook.ts")).hookMain(argv.slice(2))
  : await (await import("./main.ts")).main(argv);

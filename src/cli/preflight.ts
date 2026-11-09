// `retrohound preflight [dir]`: scan a cloned repo's agent surface before opening it with a coding agent.
import { statSync } from "node:fs";
import { LEVELS, type Level } from "../normalize/types.ts";
import { maskDeep, toJson } from "../outputs/json.ts";
import { failsOn, preflightTable, runPreflight } from "../preflight.ts";
import { DEFAULT_RULES_DIR } from "../scan.ts";
import { EXTRA_HELP, repeat } from "./rules.ts";
import { oneOf, UsageError, type IO, type Registrar } from "./io.ts";

type Flags = { rules: string; extraRules?: string[]; format: string; failOn?: string; ignore?: string };

function preflightCommand(dir: string, f: Flags, io: IO): number {
  const format = oneOf("format", f.format, ["table", "json"] as const);
  const failOn = f.failOn ? oneOf<Level>("level", f.failOn, LEVELS) : undefined;
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new UsageError(`not a directory: ${dir}`);
  const result = runPreflight(dir, { rulesDir: f.rules, extraRules: f.extraRules, ignore: f.ignore });
  if (result.rejected.length) io.err(`${result.rejected.length} rules rejected, see \`retrohound rules list\`\n`);
  if (format === "json") io.out(JSON.stringify(maskDeep({ ...JSON.parse(toJson(result.report)), preflight: { skipped: result.skipped } }), null, 2) + "\n");
  else io.out(preflightTable(result));
  return failsOn(result.report, failOn) ? 1 : 0;
}

export const registerPreflight: Registrar = (program, run, io) => {
  program.command("preflight [dir]").description("Scan a cloned repo's agent surface (.claude, .mcp.json, CLAUDE.md, tasks, npm scripts) before opening it with a coding agent")
    .option("--rules <dir>", "rules directory", DEFAULT_RULES_DIR)
    .option("--extra-rules <dir>", EXTRA_HELP, repeat)
    .option("--format <format>", "table or json", "table")
    .option("--fail-on <level>", "exit 1 when any finding is at or above this level")
    .option("--ignore <file>", "ignore file (default ~/.retrohound/ignore.yml; a repo's own file is only read when passed here)")
    .action((dir: string | undefined, f: Flags) => run(() => preflightCommand(dir ?? ".", f, io)));
};

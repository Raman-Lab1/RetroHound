// `retrohound preflight [dir]`: scan a cloned repo's agent surface before opening it with a coding agent.
import { statSync } from "node:fs";
import { AGENTS } from "../hooks/agents.ts";
import { scopesFor, settingsPath, status, type Finding as PathFinding } from "../hooks/install.ts";
import { mask } from "../normalize/mask.ts";
import { LEVELS, type Level } from "../normalize/types.ts";
import { maskDeep, toJson } from "../outputs/json.ts";
import { failsOn, preflightTable, runPreflight } from "../preflight.ts";
import { DEFAULT_RULES_DIR } from "../scan.ts";
import { EXTRA_HELP, repeat } from "./rules.ts";
import { oneOf, UsageError, type IO, type Registrar } from "./io.ts";

/** Installed RetroHound hooks (yours, and this repo's project/local files) that run a path others can modify: `hook status`'s check. */
function unsafeHooks(dir: string, env: IO["env"]): { path: string; unsafe: PathFinding[] }[] {
  return AGENTS.flatMap((agent) => scopesFor(agent).flatMap((scope) => {
    const path = settingsPath(scope, dir, env, agent);
    try {
      const unsafe = status(path, [], undefined, agent, DEFAULT_RULES_DIR).unsafe ?? [];
      return unsafe.length ? [{ path, unsafe }] : [];
    } catch {
      return []; // not strict JSON: nothing to check here, the config rules look at the file
    }
  }));
}

type Flags = { rules: string; extraRules?: string[]; format: string; failOn?: string; ignore?: string };

function preflightCommand(dir: string, f: Flags, io: IO): number {
  const format = oneOf("format", f.format, ["table", "json"] as const);
  const failOn = f.failOn ? oneOf<Level>("level", f.failOn, LEVELS) : undefined;
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new UsageError(`not a directory: ${dir}`);
  const result = runPreflight(dir, { rulesDir: f.rules, extraRules: f.extraRules, ignore: f.ignore });
  if (result.rejected.length) io.err(`${result.rejected.length} rules rejected, see \`retrohound rules list\`\n`);
  const unsafe_hooks = unsafeHooks(dir, io.env);
  if (format === "json") io.out(JSON.stringify(maskDeep({ ...JSON.parse(toJson(result.report)), preflight: { skipped: result.skipped, unsafe_hooks } }), null, 2) + "\n");
  else io.out(preflightTable(result));
  for (const h of unsafe_hooks) io.err(mask(`WARNING: the RetroHound hook in ${h.path} runs files others may be able to modify:\n${h.unsafe.map((x) => `  ${x.path}: ${x.reason}`).join("\n")}\n  Fix the permissions, or run \`hook uninstall\`.\n`));
  return failsOn(result.report, failOn, unsafe_hooks.length) ? 1 : 0;
}

export const registerPreflight: Registrar = (program, run, io) => {
  program.command("preflight [dir]").description("Scan a cloned repo's agent surface (.claude, .mcp.json, CLAUDE.md, tasks, npm scripts) before opening it with a coding agent; in a monorepo it also reads each workspace package's package.json (root `workspaces` or pnpm-workspace.yaml, up to 500)")
    .option("--rules <dir>", "rules directory", DEFAULT_RULES_DIR)
    .option("--extra-rules <dir>", EXTRA_HELP, repeat)
    .option("--format <format>", "table or json", "table")
    .option("--fail-on <level>", "exit 1 when any finding is at or above this level; an unsafe RetroHound hook warning counts as high")
    .option("--ignore <file>", "ignore file (default ~/.retrohound/ignore.yml; a repo's own file is only read when passed here)")
    .action((dir: string | undefined, f: Flags) => run(() => preflightCommand(dir ?? ".", f, io)));
};

// `retrohound hook run|install|uninstall|status` (ADR 0009). `run` must never fail the tool call: exit 0 always
// (exit 2 would BLOCK it), any error becomes one stderr line and no decision.
import { DEFAULT_RULES_DIR } from "../version.ts";
import { defaultLogPath, loadEnforceRules, MODES, runHook, type Mode } from "../hooks/run.ts";
import { loadIgnore } from "../suppress.ts";
import { AGENTS, type Agent } from "../hooks/agents.ts";
import { mask } from "../normalize/mask.ts";
import { install, settingsPath, status, uninstall, UnsafePathError, type InstallOpts, type Scope } from "../hooks/install.ts";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { EXTRA_HELP, loadRuleDir, repeat } from "./rules.ts";
import { oneOf, UsageError, type IO, type Registrar } from "./io.ts";

type ManageFlags = { agent?: string; mode?: string; scope: string; settings?: string; failClosed?: boolean; dryRun?: boolean; allowUnsafePath?: boolean; extraRules?: string[] };

function target(f: ManageFlags): { agent: Agent; path: string } {
  const agent = oneOf("agent", f.agent ?? "claude_code", AGENTS);
  const scope = oneOf<Scope>("scope", f.scope, agent === "claude_code" ? ["user", "project", "local"] : ["user", "project"]);
  return { agent, path: f.settings ? resolve(f.settings) : settingsPath(scope, undefined, undefined, agent) };
}

const CHECK: Record<Agent, string> = {
  claude_code: "Check it with /hooks inside Claude Code.",
  codex: "Open /hooks in Codex and trust the hook: Codex does not run a new or changed hook until you review it.",
  antigravity: "Check it with /hooks in Antigravity CLI, then try a harmless command.",
};

function manageOpts(f: ManageFlags): InstallOpts {
  const mode = oneOf("mode", f.mode ?? "log", MODES);
  const extraRules = (f.extraRules ?? []).map((d) => resolve(d));
  if (extraRules.length) loadRuleDir(DEFAULT_RULES_DIR, extraRules); // missing dir or reused id: usage error before anything is written
  return { ...target(f), mode, command: process.execPath, entry: resolve(process.argv[1] ?? ""), failClosed: f.failClosed, dryRun: f.dryRun, allowUnsafePath: f.allowUnsafePath, extraRules };
}

function manage(fn: typeof install, f: ManageFlags, io: IO): number {
  let r;
  try {
    r = fn(manageOpts(f));
  } catch (e) {
    if (e instanceof UnsafePathError) throw new UsageError(e.message); // exit 2
    throw e;
  }
  io.out(mask(`${r.status}: ${r.path}\n${r.diff ? `  ${r.diff}\n` : ""}${r.backup ? `  backup: ${r.backup}\n` : ""}`));
  r.warnings.forEach((w) => io.err(mask(`warning: ${w}\n`)));
  if (r.status === "installed" || r.status === "updated") io.out(`${CHECK[(f.agent ?? "claude_code") as Agent]}\n`);
  return 0;
}

function showStatus(f: ManageFlags, io: IO): number {
  const { agent, path } = target(f);
  const s = status(path, undefined, undefined, agent);
  io.out(mask(`${s.installed ? `installed (mode ${s.mode ?? "?"}${s.failClosed ? ", fail-closed" : ""})` : "not installed"}: ${s.path}\n`));
  if (s.extraRules?.length) io.out(mask(`extra rules: ${s.extraRules.join(", ")}\n`));
  if (s.allowUnsafePath) io.out("installed with --allow-unsafe-path: the path safety check was overridden.\n");
  if (s.unsafe?.length) io.out(mask(`WARNING: the installed hook runs files that no longer pass the path check:\n${s.unsafe.map((x) => `  ${x.path}: ${x.reason}`).join("\n")}\n  Fix the permissions, or run \`hook uninstall\`.\n`));
  else if (s.installed) io.out("installed paths pass the safety check.\n");
  if (s.managedHooksOnly) io.out("allowManagedHooksOnly is set: user, project and local hooks do not run, so this hook is inactive.\n");
  return 0;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

type RunFlags = { agent?: string; mode?: string; rules?: string; extraRules?: string[]; log?: string; cache?: string; ignore?: string };

export async function hookRun(f: RunFlags, io: IO, stdin: () => Promise<string> = readStdin): Promise<number> {
  try {
    const mode = (f.mode ?? "log") as Mode;
    if (!MODES.includes(mode)) throw new Error(`unknown mode '${f.mode}'`);
    const agent = (f.agent ?? "claude_code") as Agent;
    if (!AGENTS.includes(agent)) throw new Error(`unknown agent '${f.agent}'`);
    const text = await stdin();
    const dir = f.rules ?? DEFAULT_RULES_DIR;
    const extras = f.extraRules ?? [];
    // A missing extra dir must not switch off the shipped rules: say so and decide with the rules that do load.
    for (const d of extras) if (!statSync(d, { throwIfNoEntry: false })?.isDirectory()) io.err(mask(`retrohound hook: --extra-rules ${d} is not a directory; deciding without it`) + "\n");
    const rules = loadEnforceRules(dir, f.cache, extras);
    // Only the home file (or --ignore): a repo's own file must not switch off enforcement for that repo.
    const ignore = loadIgnore(rules, { file: f.ignore, skipUnknownRules: true });
    const res = runHook(text, mode, rules, f.log ?? defaultLogPath(), ignore, agent);
    if (res.output) io.out(res.output);
  } catch (e) {
    io.err(mask(`retrohound hook: ${(e as Error).message}; no decision (fail open)`).split("\n")[0] + "\n");
  }
  return 0;
}

export const registerHook: Registrar = (program, run, io) => {
  const hook = program.command("hook").description("PreToolUse hook for Claude Code, Codex and Antigravity CLI: run, install, uninstall, status");
  hook.command("run").description("Read a PreToolUse payload on stdin and print a permission decision (used by the agent)")
    .option("--agent <agent>", AGENTS.join(" | "), "claude_code")
    .option("--mode <mode>", "log | confirm | block", "log")
    .option("--rules <dir>", "rules directory")
    .option("--extra-rules <dir>", EXTRA_HELP, repeat)
    .option("--log <path>", "trial log file for --mode log")
    .option("--cache <path>", "parsed-rule cache file (default: next to the trial log)")
    .option("--ignore <file>", "ignore file (default ~/.retrohound/ignore.yml)")
    .allowUnknownOption().allowExcessArguments()
    .action((f: RunFlags) => run(() => hookRun(f, io)));
  const scoped = (c: ReturnType<typeof hook.command>) =>
    c.option("--agent <agent>", AGENTS.join(" | "), "claude_code")
      .option("--scope <scope>", "user | project | local (local: Claude Code only)", "user").option("--settings <path>", "settings or hooks.json file to edit (overrides --scope)");
  scoped(hook.command("install").description("Add the PreToolUse hook to the agent's settings or hooks.json file (backs it up first)"))
    .option("--mode <mode>", "log | confirm | block (codex: no confirm)", "log")
    .option("--fail-closed", "block every tool call if the hook itself fails (Claude Code only)")
    .option("--dry-run", "show the change, write nothing")
    .option("--extra-rules <dir>", "more rules for the live hook, on top of the shipped ones (repeatable; stored as an absolute path)", repeat)
    .option("--allow-unsafe-path", "install even if the runtime, entry file or an extra rules dir (or a parent dir) is writable by others; warns and shows in status")
    .action((f: ManageFlags) => run(() => manage(install, f, io)));
  scoped(hook.command("uninstall").description("Remove only RetroHound's hook from a settings file"))
    .option("--dry-run", "show the change, write nothing")
    .action((f: ManageFlags) => run(() => manage(uninstall, f, io)));
  scoped(hook.command("status").description("Show whether the hook is installed, its mode, and whether managed settings disable it"))
    .action((f: ManageFlags) => run(() => showStatus(f, io)));
};

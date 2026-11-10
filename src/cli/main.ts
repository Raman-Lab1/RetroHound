// RetroHound CLI. `main` returns the exit code so tests run in-process: 0 ok, 1 findings at or above
// --fail-on (or purge refused), 2 bad input, 3 runtime failure.
import { existsSync, rmSync, statSync } from "node:fs";
import { Command, CommanderError } from "commander";
import { COLLECTORS } from "../collectors/index.ts";
import { runScan, type ScanOptions } from "../scan.ts";
import { DEFAULT_RULES_DIR, TOOL_VERSION } from "../version.ts";
import { LEVELS, type Level } from "../normalize/types.ts";
import { toAttackLayer } from "../outputs/attack.ts";
import { toJson } from "../outputs/json.ts";
import { toNdjson } from "../outputs/ndjson.ts";
import { toSarif } from "../outputs/sarif.ts";
import { toTable } from "../outputs/table.ts";
import { defaultDbPath } from "../store/index.ts";
import { oneOf, parseSince, processIO, UsageError, useColor, type IO } from "./io.ts";
import { registerGitSecrets } from "./gitjoin.ts";
import { registerHook } from "./hook.ts";
import { registerIncident } from "./incident.ts";
import { registerVerify } from "./verify.ts";
import { registerMcp } from "./mcp.ts";
import { registerPreflight } from "./preflight.ts";
import { registerQuery } from "./query.ts";
import { registerShow } from "./show.ts";
import { registerWrapped } from "./wrapped.ts";
import { EXTRA_HELP, listRules, repeat, showRule } from "./rules.ts";
import { testRules } from "./rules-test.ts";
import { registerConvert } from "./convert.ts";
import { retentionDays, summaryLines } from "./summary.ts";
import { defaultReportPath, writeFootprint } from "./footprint.ts";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

type ScanFlags = {
  since?: string; agent: string; project?: string; rules: string; extraRules?: string[]; level?: string; format: string;
  index: boolean; failOn?: string; db?: string; root?: string; ignore?: string;
  report?: string | false; // undefined: next to the index; false: --no-report
};

const AGENTS = Object.keys(COLLECTORS);
const DB_FILES = ["", "-wal", "-shm", "-journal"]; // the index and SQLite's side files
const FORMATS = ["table", "json", "sarif", "ndjson-ecs", "ndjson-ocsf", "attack-layer"] as const;

async function scanCommand(f: ScanFlags, io: IO): Promise<number> {
  const agent = oneOf("agent", f.agent, [...AGENTS, "all"]);
  if (agent === "all" && f.root) throw new UsageError("--root cannot be used with --agent all: each agent is read from its own default root");
  const format = oneOf("format", f.format, FORMATS);
  const level = f.level ? oneOf<Level>("level", f.level, LEVELS) : undefined;
  const failOn = f.failOn ? oneOf<Level>("level", f.failOn, LEVELS) : undefined;
  if (typeof f.report === "string") {
    if (!f.index || format !== "table") throw new UsageError("--report needs the index and the table format: it is built from the index after the scan");
    const db = resolve(f.db ?? defaultDbPath());
    if (DB_FILES.some((s) => resolve(f.report as string) === db + s)) throw new UsageError("--report would overwrite the index");
  }
  const opts: ScanOptions = {
    agent, root: f.root, dbPath: f.db, rulesDir: f.rules, extraRules: f.extraRules, project: f.project, level, noIndex: !f.index,
    since: f.since ? parseSince(f.since) : undefined, ignore: f.ignore,
  };
  let rejected = 0;
  const report = await runScan({ ...opts, onRejected: (r) => (rejected = r.length) });
  if (rejected) io.err(`${rejected} rules rejected, see \`retrohound rules list\`\n`);
  if (format === "json") io.out(toJson(report) + "\n");
  else if (format === "sarif") io.out(toSarif(report) + "\n");
  else if (format === "ndjson-ecs") io.out(toNdjson(report, "ecs")); // ends with its own newline
  else if (format === "ndjson-ocsf") io.out(toNdjson(report, "ocsf"));
  else if (format === "attack-layer") io.out(toAttackLayer(report) + "\n");
  else {
    const root = f.root ?? join(homedir(), ".claude");
    // the retention summary reads Claude Code's own settings, so it only applies to that agent
    const summary = agent === "claude_code" ? summaryLines(root, f.index ? f.db : undefined, report.scan.archived_sessions.length) : [];
    if (f.index && f.report !== false) {
      const dbPath = f.db ?? defaultDbPath();
      const claude = agent === "claude_code" ? root : join(homedir(), ".claude");
      try {
        const url = writeFootprint({
          dbPath, out: f.report || defaultReportPath(dbPath), rulesDir: f.rules, extraRules: f.extraRules,
          retentionDays: existsSync(claude) ? retentionDays(claude) : undefined, env: io.env,
        });
        summary.push(`  Footprint report (everything in the index): ${url}`);
      } catch (e) {
        io.err(`retrohound: footprint report not written: ${(e as Error).message}\n`); // the scan itself succeeded
      }
    }
    io.out(toTable(report, { color: useColor(io) }) + summary.join("\n") + "\n");
  }
  const min = failOn ? LEVELS.indexOf(failOn) : undefined;
  return min !== undefined && report.findings.some((x) => LEVELS.indexOf(x.level) >= min) ? 1 : 0;
}

function purgeCommand(f: { db?: string; yes?: boolean }, io: IO): number {
  const path = f.db ?? defaultDbPath();
  if (!existsSync(path)) return io.out(`Nothing to delete: ${path} does not exist.\n`), 0;
  const page = defaultReportPath(path); // built from the index, so it goes with it; a --report elsewhere is the user's
  if (!f.yes) {
    io.out(`Would delete the index ${path} (${statSync(path).size} bytes)${existsSync(page) ? ` and its footprint report ${page}` : ""}.\n`);
    io.out("It may hold the only copy of evidence Claude Code has since deleted. Re-run with --yes to delete it.\n");
    return 1;
  }
  for (const suffix of DB_FILES) rmSync(path + suffix, { force: true });
  io.out(`Deleted ${path}\n`);
  if (existsSync(page)) rmSync(page), io.out(`Deleted ${page}\n`);
  return 0;
}

export function buildProgram(io: IO, setCode: (n: number) => void): Command {
  const program = new Command("retrohound").version(TOOL_VERSION).description("Find what your AI coding agents did that you would not want repeated.");
  program.exitOverride().configureOutput({ writeOut: io.out, writeErr: io.err });
  const run = async (fn: () => number | Promise<number>) => setCode(await fn());

  program.command("scan").description("Scan Claude Code, Codex CLI and Antigravity CLI transcripts, index them, and report findings")
    .option("--since <when>", "only sessions active since: 30d, 12h or a date")
    .option("--agent <agent>", `agent to scan (${AGENTS.join(" | ")} | all)`, "claude_code")
    .option("--project <path>", "only sessions whose project path contains this")
    .option("--rules <dir>", "rules directory", DEFAULT_RULES_DIR)
    .option("--extra-rules <dir>", EXTRA_HELP, repeat)
    .option("--level <level>", `hide findings below this level (${LEVELS.join("|")})`)
    .option("--format <format>", "table, json, sarif, ndjson-ecs, ndjson-ocsf or attack-layer (ATT&CK Navigator)", "table")
    .option("--no-index", "evaluate in memory, write nothing")
    .option("--report <file>", "where to write the offline footprint report (default: report.html next to the index)")
    .option("--no-report", "do not write the footprint report")
    .option("--fail-on <level>", "exit 1 when any finding is at or above this level")
    .option("--db <path>", "index database", defaultDbPath())
    .option("--root <dir>", "Claude config dir or its projects dir (default ~/.claude)")
    .option("--ignore <file>", "ignore file (default ~/.retrohound/ignore.yml; a repo's own file is only read when passed here)")
    .action((f: ScanFlags) => run(() => scanCommand(f, io)));

  const rules = program.command("rules").description("Inspect the loaded detection rules");
  rules.command("list").description("List rules and any that were rejected, with the reason")
    .option("--rules <dir>", "rules directory", DEFAULT_RULES_DIR)
    .option("--extra-rules <dir>", EXTRA_HELP, repeat)
    .action((f: { rules: string; extraRules?: string[] }) => run(() => listRules(f.rules, io, f.extraRules)));
  rules.command("show <rule>").description("Show one rule by name or id: metadata and its YAML")
    .option("--rules <dir>", "rules directory", DEFAULT_RULES_DIR)
    .option("--extra-rules <dir>", EXTRA_HELP, repeat)
    .action((rule: string, f: { rules: string; extraRules?: string[] }) => run(() => showRule(f.rules, rule, io, f.extraRules)));

  rules.command("test [dir]").description("Check every rule has positive/negative tests that pass (for CI and your own rules)")
    .option("--tests <dir>", "tests directory (default: <rules dir>/../tests, per rules dir)")
    .option("--extra-rules <dir>", EXTRA_HELP, repeat)
    .action((dir: string | undefined, f: { tests?: string; extraRules?: string[] }) => run(() => testRules(dir ?? DEFAULT_RULES_DIR, f.tests, io, f.extraRules)));
  registerConvert(rules, run, io);

  program.command("purge").description("Delete the local index database (it may be the only copy of deleted evidence)")
    .option("--db <path>", "index database", defaultDbPath())
    .option("--yes", "actually delete; without it purge only says what it would delete")
    .action((f: { db?: string; yes?: boolean }) => run(() => purgeCommand(f, io)));

  registerQuery(program, run, io);
  registerShow(program, run, io);
  registerIncident(program, run, io);
  registerVerify(program, run, io);
  registerWrapped(program, run, io);
  registerPreflight(program, run, io);
  registerMcp(program, run, io);
  registerHook(program, run, io);
  registerGitSecrets(program, run, io);
  return program;
}

export async function main(argv: string[], io: IO = processIO()): Promise<number> {
  let code = 0;
  const program = buildProgram(io, (n) => (code = n));
  try {
    await program.parseAsync(argv, { from: "user" });
    return code;
  } catch (e) {
    if (e instanceof CommanderError) return e.exitCode === 0 ? 0 : 2; // commander already printed its message
    if (e instanceof UsageError) return io.err(`retrohound: ${e.message}\n`), 2;
    io.err(`retrohound: ${(e as Error).message}\n`);
    return 3;
  }
}

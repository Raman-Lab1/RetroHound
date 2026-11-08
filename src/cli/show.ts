// `retrohound show <session-id>`: the masked timeline of one session, findings marked at their primary event.
// Works on archived sessions identically: it reads only the index (ADR 0008).
import { existsSync } from "node:fs";
import pc from "picocolors";
import { mask } from "../normalize/mask.ts";
import type { AgentEvent, Finding } from "../normalize/types.ts";
import { DEFAULT_RULES_DIR } from "../scan.ts";
import { defaultDbPath, openStore } from "../store/index.ts";
import { UsageError, useColor, type IO, type Registrar } from "./io.ts";
import { loadRuleDir } from "./rules.ts";

const detail = (e: AgentEvent) => (e.command_line ?? e.url ?? e.target_path ?? e.text_excerpt ?? "").replace(/\s+/g, " ").slice(0, 100);
const agentOf = (e: AgentEvent) => (e.agent_id ? `sub:${e.agent_id.slice(0, 8)}` : "main");

function eventLine(e: AgentEvent, marks: Finding[], names: Map<string, string>, c: ReturnType<typeof pc.createColors>): string {
  const cols = [e.ts.slice(11, 19), agentOf(e).padEnd(12), e.category.padEnd(16), (e.tool_name ?? "-").padEnd(10), detail(e), e.outcome ?? ""];
  const flag = marks.map((f) => c.bold(c.red(`  <== ${f.level.toUpperCase()} ${names.get(f.rule_id) ?? f.rule_id}`))).join("");
  return `  ${cols.join(" ").trimEnd()}${flag}`;
}

function showSession(prefix: string, dbPath: string, rulesDir: string, io: IO): number {
  if (!existsSync(dbPath)) throw new UsageError(`no index at ${dbPath}, run \`retrohound scan\` first`); // openStore would create it
  const store = openStore(dbPath);
  try {
    const hits = store.listSessions().filter((s) => s.session_id.startsWith(prefix));
    if (hits.length === 0) throw new UsageError(`no session starts with '${prefix}'`);
    if (hits.length > 1) {
      io.err(`'${prefix}' is ambiguous, it matches ${hits.length} sessions:\n${hits.map((s) => `  ${s.session_id}  ${s.first_ts}  ${s.project_path ?? "-"}`).join("\n")}\n`);
      return 2;
    }
    const s = hits[0]!;
    const c = pc.createColors(useColor(io));
    const findings = store.listFindings(s.session_id);
    const marks = (e: AgentEvent) => findings.filter((f) => f.events[0]?.id === e.id);
    // Findings store the rule id (a uuid); show the name when the rule is still loaded.
    const names = new Map(loadRuleDir(rulesDir).rules.map((r) => [r.id, r.name ?? r.title]));
    const head = `  Session ${s.session_id}${s.archived ? "  [archived: transcript deleted by Claude Code, kept by the index]" : ""}\n  ${s.project_path ?? "-"}  ${s.first_ts} .. ${s.last_ts}  ${s.event_count} events, ${findings.length} findings\n`;
    io.out(mask(head + store.sessionEvents(s.session_id).map((e) => eventLine(e, marks(e), names, c)).join("\n") + "\n"));
    return 0;
  } finally {
    store.close();
  }
}

export const registerShow: Registrar = (program, run, io) => {
  program.command("show <session-id>").description("Timeline of one session with findings highlighted (an unambiguous id prefix works)")
    .option("--db <path>", "index database", defaultDbPath())
    .option("--rules <dir>", "rules directory, for rule names", DEFAULT_RULES_DIR)
    .action((id: string, f: { db: string; rules: string }) => run(() => showSession(id, f.db, f.rules, io)));
};

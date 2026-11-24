// `retrohound show <session-id>`: the masked timeline of one session, findings marked at their primary event.
// Works on archived sessions identically: it reads only the index (ADR 0008).
import { existsSync } from "node:fs";
import pc from "picocolors";
import { mask } from "../normalize/mask.ts";
import { term } from "../outputs/table.ts";
import type { AgentEvent, Finding } from "../normalize/types.ts";
import { DEFAULT_RULES_DIR } from "../scan.ts";
import { defaultDbPath, openReadOnly, rowToEvent, rowToFinding, rowToSession, SESSION_SELECT } from "../store/index.ts";
import { UsageError, useColor, type IO, type Registrar } from "./io.ts";
import { EXTRA_HELP, loadRuleDir, repeat } from "./rules.ts";

const detail = (e: AgentEvent) => term((e.command_line ?? e.url ?? e.target_path ?? e.text_excerpt ?? "").replace(/\s+/g, " ").slice(0, 100));
const AGENT_NAMES: Record<string, string> = { claude_code: "Claude Code", codex: "Codex", antigravity: "Antigravity" };
const agentOf = (e: AgentEvent) => (e.agent_id ? `sub:${term(e.agent_id.slice(0, 8))}` : "main");

function eventLine(e: AgentEvent, marks: Finding[], names: Map<string, string>, c: ReturnType<typeof pc.createColors>): string {
  // Transcript text is shown with control characters as \xNN, so it cannot drive the terminal.
  const cols = [term(e.ts.slice(11, 19)), agentOf(e).padEnd(12), term(e.category).padEnd(16), term(e.tool_name ?? "-").padEnd(10), detail(e), term(e.outcome ?? "")];
  const flag = marks.map((f) => c.bold(c.red(`  <== ${f.level.toUpperCase()} ${names.get(f.rule_id) ?? f.rule_id}`))).join("");
  return `  ${cols.join(" ").trimEnd()}${flag}`;
}

function showSession(prefix: string, dbPath: string, rulesDir: string, io: IO, extras: string[] = []): number {
  if (!existsSync(dbPath)) throw new UsageError(`no index at ${dbPath}, run \`retrohound scan\` first`);
  const db = openReadOnly(dbPath); // show never writes, so it also reads an evidence copy on read-only media
  try {
    const hits = db.prepare(`${SESSION_SELECT} WHERE substr(s.session_id, 1, length(?)) = ? ORDER BY s.first_ts, s.session_id`)
      .all(prefix, prefix).map(rowToSession);
    if (hits.length === 0) throw new UsageError(`no session starts with '${prefix}'`);
    if (hits.length > 1) {
      io.err(`'${prefix}' is ambiguous, it matches ${hits.length} sessions:\n${hits.map((s) => term(`  ${s.session_id}  ${s.first_ts}  ${s.project_path ?? "-"}`)).join("\n")}\n`);
      return 2;
    }
    const s = hits[0]!;
    const c = pc.createColors(useColor(io));
    const findings = db.prepare("SELECT * FROM findings WHERE session_id = ? ORDER BY ts, id").all(s.session_id).map(rowToFinding);
    const events = db.prepare("SELECT * FROM events WHERE session_id = ? ORDER BY ts, seq, id").all(s.session_id).map(rowToEvent);
    const marks = (e: AgentEvent) => findings.filter((f) => f.events[0]?.id === e.id);
    // Findings store the rule id (a uuid); show the name when the rule is still loaded.
    const names = new Map(loadRuleDir(rulesDir, extras).rules.map((r) => [r.id, r.name ?? r.title]));
    const head = `  Session ${term(s.session_id)}${s.archived ? `  [archived: transcript deleted by ${AGENT_NAMES[s.agent] ?? "the agent"}, kept by the index]` : ""}\n  ${term(s.project_path ?? "-")}  ${term(s.first_ts)} .. ${term(s.last_ts)}  ${s.event_count} events, ${findings.length} findings\n`;
    io.out(mask(head + events.map((e) => eventLine(e, marks(e), names, c)).join("\n") + "\n"));
    return 0;
  } finally {
    db.close();
  }
}

export const registerShow: Registrar = (program, run, io) => {
  program.command("show <session-id>").description("Timeline of one session with findings highlighted (an unambiguous id prefix works)")
    .option("--db <path>", "index database", defaultDbPath())
    .option("--rules <dir>", "rules directory, for rule names", DEFAULT_RULES_DIR)
    .option("--extra-rules <dir>", EXTRA_HELP, repeat)
    .action((id: string, f: { db: string; rules: string; extraRules?: string[] }) => run(() => showSession(id, f.db, f.rules, io, f.extraRules)));
};

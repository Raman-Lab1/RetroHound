// Human table for `scan` (ADR 0008). Never prints values: secrets appear only as fingerprints.
import pc from "picocolors";
import { LEVELS, type AgentEvent, type Finding, type Level } from "../normalize/types.ts";
import { mask } from "../normalize/mask.ts";
import type { ScanReport } from "./report.ts";

type Colors = ReturnType<typeof pc.createColors>;
/** A transcript- or repo-controlled value made safe for a terminal or CI log: C0/C1 controls (ESC, BEL, CR, LF, ...)
 * shown as \\xNN, so no CSI/OSC sequence runs and no `::workflow-command` line starts. Output only: rules see raw values. */
export const term = (s: string) => s.replace(/[\x00-\x1f\x7f-\x9f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
const short = (id: string) => term(id.slice(0, 8));
const agentOf = (e?: AgentEvent) => (e?.agent_id ? `sub-agent ${short(e.agent_id)}` : "main");
const rank = (l: Level) => LEVELS.indexOf(l);
const LABEL: Record<Level, string> = { informational: "INFO", low: "LOW", medium: "MED", high: "HIGH", critical: "CRIT" };
const paint = (c: Colors, l: Level, s: string) =>
  ({ informational: c.dim, low: c.blue, medium: c.yellow, high: c.red, critical: (x: string) => c.bold(c.red(x)) })[l](s);

/** Lines the parser skipped this run (unknown line types are reported, not fatal). Silent when none. */
function skippedLines(lines: ScanReport["scan"]["lines"]): string[] {
  const types = Object.entries(lines?.unknown_types ?? {}).sort((a, b) => b[1] - a[1]);
  const unknown = types.reduce((k, [, v]) => k + v, 0);
  if (!lines || (!lines.malformed && !unknown)) return [];
  const top = types.slice(0, 5).map(([t, v]) => `${term(t)} ${v}`).join(", ") + (types.length > 5 ? ", …" : "");
  return [`  skipped lines: ${lines.malformed} malformed · ${unknown} of unknown type${unknown ? ` (${top})` : ""}`];
}

/** What the agent's own guard blocked, under the blocked count. Silent when nothing was blocked. */
function blockedLines(b: ScanReport["scan"]["blocked_breakdown"]): string[] {
  if (!b) return [];
  const top = (m: Record<string, number>) => {
    const all = Object.entries(m);
    return all.slice(0, 5).map(([k, v]) => `${term(k)} ${v}`).join(" · ") + (all.length > 5 ? " · …" : "");
  };
  const kinds = Object.entries(b.kinds).map(([k, { main, sub_agent }]) => `${term(k)} ${main + sub_agent}${sub_agent ? ` (${sub_agent} sub-agent)` : ""}`);
  return [
    `    by kind: ${kinds.join(" · ")}`,
    ...(b.categories ? [`    by category: ${top(b.categories)}`] : []),
    ...(b.attributions ? [`    by attribution: ${top(b.attributions)}`] : []),
    `    top projects: ${b.top_projects.slice(0, 3).map((p) => `${term(p.project_path)} ${p.blocked}`).join(" · ")}`,
  ];
}

function findingLines(report: ScanReport, c: Colors): string[] {
  const rules = new Map(report.rules.map((r) => [r.id, r]));
  const byRule = new Map<string, Finding[]>();
  for (const f of report.findings) byRule.get(f.rule_id)?.push(f) ?? byRule.set(f.rule_id, [f]);
  const groups = [...byRule.values()].sort((a, b) => rank(b[0]!.level) - rank(a[0]!.level));
  const nameOf = (f: Finding) => term(rules.get(f.rule_id)?.name ?? f.rule_id);
  const width = Math.max(28, ...groups.map((fs) => nameOf(fs[0]!).length + 2));
  return groups.map((fs) => {
    const f = fs[0]!;
    const rule = rules.get(f.rule_id);
    const sessions = new Set(fs.map((x) => x.session_id)).size;
    const ids = [...new Set(fs.map((x) => agentOf(x.events[0])))];
    const subs = ids.filter((a) => a !== "main").length;
    const agents = ids.length <= 2 ? ids.join("+") : `${ids.includes("main") ? "main+" : ""}${subs} sub-agents`;
    const where = sessions > 1
      ? `${sessions} sessions`
      : `${short(f.session_id)}  ${term(f.ts.slice(0, 10))}  ${term(f.events[0]?.project_path ?? "-")}  ${term(rule?.tags[0] ?? "")}`;
    return `  ${paint(c, f.level, LABEL[f.level].padEnd(4))}  ${nameOf(f).padEnd(width)}${where}  [${agents}]`;
  });
}

/** Secrets worth rotating, one line per fingerprint. */
function rotateLines(report: ScanReport): string[] {
  const seen = new Map<string, { kinds: Set<string>; sessions: Set<string> }>();
  for (const f of report.findings) for (const e of f.events) for (const fp of e.secret_fps ?? []) {
    const s = seen.get(fp) ?? { kinds: new Set(), sessions: new Set() };
    (e.secret_kinds ?? []).forEach((k) => s.kinds.add(k));
    s.sessions.add(e.session_id);
    seen.set(fp, s);
  }
  if (!seen.size) return [];
  const rows = [...seen].map(([fp, s]) => `    ${fp}  ${[...s.kinds].join(",") || "secret"}  ${s.sessions.size} session(s)`);
  return ["", "  Rotate these secrets (fingerprints, not values):", ...rows, ""];
}

export function toTable(report: ScanReport, opts: { color: boolean }): string {
  const { scan } = report;
  if (scan.sessions === 0) return mask(`No ${scan.agents ? "agent" : "Claude Code"} sessions found at ${term(scan.root)}\n`);
  const c = pc.createColors(opts.color);
  const n = (x: number) => x.toLocaleString("en-US");
  const secs = ((Date.parse(scan.finished_at) - Date.parse(scan.started_at)) / 1000).toFixed(1);
  const pct = scan.events ? Math.round((scan.subagent_events / scan.events) * 100) : 0;
  const counts = LEVELS.slice().reverse()
    .map((l) => [l, report.findings.filter((f) => f.level === l).length] as const).filter(([, k]) => k)
    .map(([l, k]) => paint(c, l, `${k} ${l}`));
  const first = report.findings[0];
  const lines = [
    `  Indexed ${n(scan.sessions)} sessions · ${n(scan.events)} events in ${secs}s`,
    ...Object.entries(scan.agents ?? {}).map(([a, k]) => `    ${a.padEnd(12)} ${n(k.sessions)} sessions · ${n(k.events)} events · ${n(k.findings)} findings`),
    `  ${scan.blocked} blocked · ${pct}% of events from sub-agents · ${scan.archived_sessions.length} archived sessions`,
    ...blockedLines(scan.blocked_breakdown),
    ...skippedLines(scan.lines),
    ...(scan.suppressed ? [`  ${scan.suppressed} findings suppressed by your ignore file`] : []),
    ...findingLines(report, c),
    ...rotateLines(report),
    "  " + "─".repeat(45),
    `  ${counts.join(" · ") || "no findings"}${first ? `   →  retrohound show ${short(first.session_id)}` : ""}`,
  ];
  return mask(lines.join("\n") + "\n");
}

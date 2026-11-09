// `retrohound preflight`: a cloned repo's agent surface through the existing rules, in memory (no index, no network).
import { collectRepo, SESSION_ID, type Skipped } from "./collectors/repo/collect.ts";
import { evaluate, type Match } from "./engine/evaluate.ts";
import { loadRuleDir } from "./cli/rules.ts";
import type { Rejection } from "./engine/load.ts";
import { mask } from "./normalize/mask.ts";
import { toStored } from "./normalize/stored.ts";
import { LEVELS, type Finding, type Level, type RawEvent } from "./normalize/types.ts";
import type { ScanReport } from "./outputs/report.ts";
import { reportRule } from "./scan.ts";
import { DEFAULT_RULES_DIR, TOOL_VERSION } from "./version.ts";
import { findingId } from "./store/index.ts";
import { applyIgnore, loadIgnore } from "./suppress.ts";

export type PreflightResult = { report: ScanReport; skipped: Skipped[]; rejected: Rejection[] };

function toFinding(m: Match<RawEvent>): Finding {
  const events = m.events.map(toStored);
  return {
    id: findingId(m.rule.id, events.map((e) => e.id)),
    rule_id: mask(m.rule.id),
    level: m.rule.level,
    ts: events[0]!.ts,
    session_id: SESSION_ID,
    message: mask(m.rule.title.replace(/\s+/g, " ").trim()),
    events,
  };
}

export function runPreflight(dir: string, opts: { rulesDir?: string; extraRules?: string[]; ignore?: string } = {}): PreflightResult {
  const started_at = new Date().toISOString();
  const { rules, rejected } = loadRuleDir(opts.rulesDir ?? DEFAULT_RULES_DIR, opts.extraRules);
  const { events, scanned, skipped } = collectRepo(dir);
  const { kept: findings, suppressed } = applyIgnore(evaluate(rules, events).map((m) => toFinding(m as Match<RawEvent>)), loadIgnore(rules, { file: opts.ignore }));
  const fired = new Set(findings.map((f) => f.rule_id));
  const report: ScanReport = {
    schema: "retrohound.scan/0.1",
    tool: { name: "retrohound", version: TOOL_VERSION },
    scan: {
      started_at, finished_at: new Date().toISOString(), sessions: 1, events: events.length, blocked: 0, subagent_events: 0,
      files: { indexed: scanned, skipped: skipped.length, gone: 0, failed: 0 }, archived_sessions: [], root: mask(dir), ...(suppressed ? { suppressed } : {}),
    },
    rules: rules.filter((r) => fired.has(mask(r.id))).map(reportRule),
    findings,
  };
  return { report, skipped, rejected };
}

const rank = (l: Level) => LEVELS.indexOf(l);

/** Minimal table: toTable is worded for transcripts ("Indexed N sessions"). Level order, highest first. */
export function preflightTable({ report, skipped }: PreflightResult): string {
  const { scan } = report;
  const sorted = report.findings.slice().sort((a, b) => rank(b.level) - rank(a.level));
  const lines = [`  Preflight ${scan.root}: ${scan.files.indexed} agent files, ${scan.events} events`, ""];
  const names = new Map(report.rules.map((r) => [mask(r.id), r.name ?? r.id]));
  for (const f of sorted) {
    const e = f.events[0];
    lines.push(`  ${f.level.toUpperCase().padEnd(13)}${f.message}  (${names.get(f.rule_id) ?? f.rule_id})`, `               ${e?.raw_ref.file ?? ""}${e?.command_line ? `  ${e.command_line.slice(0, 100)}` : ""}`);
  }
  for (const s of skipped) lines.push(`  skipped ${s.path}: ${s.reason}`);
  if (scan.suppressed) lines.push(`  ${scan.suppressed} findings suppressed by your ignore file`);
  lines.push("  " + "─".repeat(45), `  ${report.findings.length ? `${report.findings.length} finding(s)` : "no findings"}`);
  return mask(lines.join("\n") + "\n");
}

export const failsOn = (report: ScanReport, level?: Level) =>
  level !== undefined && report.findings.some((f) => rank(f.level) >= rank(level));

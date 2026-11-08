// SARIF 2.1.0 export (R9 section 1): a pure function over the scan document, no DB access. Final mask pass as in json.ts.
import type { AgentEvent, Level } from "../normalize/types.ts";
import { maskDeep } from "./json.ts";
import type { ReportRule, ScanReport } from "./report.ts";

type SarifLevel = "note" | "warning" | "error";

/** Sigma level -> SARIF level, security-severity, OCSF severity_id, ECS event.risk_score. Shared by ndjson.ts. */
export const SEVERITY: Record<Level, { sarif: SarifLevel; score?: string; id: number; risk: number }> = {
  informational: { sarif: "note", id: 1, risk: 0 },
  low: { sarif: "note", score: "2.0", id: 2, risk: 21 },
  medium: { sarif: "warning", score: "5.5", id: 3, risk: 47 },
  high: { sarif: "error", score: "8.0", id: 4, risk: 73 },
  critical: { sarif: "error", score: "9.5", id: 5, risk: 99 },
};

const BASE = "CLAUDE_PROJECTS";

/** Path under the Claude projects dir, forward slashes, so no home path or username is published (R9 1.4). */
function relUri(file: string): string {
  const p = file.replace(/\\/g, "/");
  const m = /\/projects\/+(.+)$/.exec(p);
  return m ? m[1]! : p.split("/").slice(-2).join("/");
}

const location = (e: AgentEvent, message?: string, id?: number) => ({
  ...(id === undefined ? {} : { id }),
  ...(message ? { message: { text: message } } : {}),
  physicalLocation: {
    artifactLocation: { uri: relUri(e.raw_ref.file), uriBaseId: BASE },
    region: { startLine: e.raw_ref.line, startColumn: 1, endLine: e.raw_ref.line },
  },
});

function related(e: AgentEvent, i: number) {
  const what = e.command_line ?? e.target_path ?? e.url ?? e.tool_name ?? e.category;
  return location(e, `${e.category}: ${what}`, i + 1);
}

function sarifRule(r: ReportRule) {
  const desc = r.description ?? r.title;
  const fp = r.falsepositives?.length ? ` False positives: ${r.falsepositives.join("; ")}.` : "";
  const sev = SEVERITY[r.level];
  return {
    id: r.id,
    name: r.name ?? r.id,
    shortDescription: { text: r.title },
    fullDescription: { text: desc },
    help: { text: `Review the session timeline with: retrohound show <session-id>.${fp}` },
    defaultConfiguration: { level: sev.sarif },
    properties: { tags: ["security", ...r.tags].slice(0, 10), ...(sev.score ? { "security-severity": sev.score } : {}), ...(r.author ? { author: r.author } : {}) },
  };
}

export function toSarif(report: ScanReport): string {
  const rules = [...report.rules];
  for (const f of report.findings) {
    // A finding whose rule is not in report.rules still needs a ruleIndex target.
    if (!rules.some((r) => r.id === f.rule_id)) rules.push({ id: f.rule_id, title: f.rule_id, level: f.level, tags: [], lane: "hunt" });
  }
  const results = report.findings.map((f) => {
    const [primary, ...rest] = f.events.map((e) => maskDeep(e, true) as AgentEvent);
    const fp16 = f.id.slice(0, 16);
    return {
      ruleId: f.rule_id,
      ruleIndex: rules.findIndex((r) => r.id === f.rule_id),
      level: SEVERITY[f.level].sarif,
      message: { text: f.message },
      ...(primary ? { locations: [location(primary)] } : {}),
      ...(rest.length ? { relatedLocations: rest.map(related) } : {}),
      // GitHub reads only primaryLocationLineHash; the CodeQL shape "<hex>:<n>" is used in case it checks the format (R9 Q2).
      partialFingerprints: { primaryLocationLineHash: `${fp16}:1`, "retrohound/v1": f.id },
      properties: {
        session_id: f.session_id, agent: primary?.agent, ...(primary?.agent_id ? { agent_id: primary.agent_id } : {}),
        scope: primary?.agent_id ? "sub-agent" : "main", event_ids: f.events.map((e) => e.id),
      },
    };
  });
  const doc = {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [{
      tool: { driver: { name: report.tool.name, version: report.tool.version, rules: rules.map(sarifRule) } },
      automationDetails: { id: "retrohound/hunt/" },
      results,
    }],
  };
  return JSON.stringify(maskDeep(doc), null, 2);
}

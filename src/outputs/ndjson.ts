// NDJSON export, one alert line per finding (R9 sections 2 and 3). Raw event lines are not exported (R9 section 4).
// Final mask pass on every line as in json.ts.
import type { AgentEvent, Category, Finding } from "../normalize/types.ts";
import { maskDeep } from "./json.ts";
import type { ReportRule, ScanReport } from "./report.ts";
import { SEVERITY } from "./sarif.ts";

export type NdjsonSchema = "ecs" | "ocsf";

// ECS 9.1.0 is the first version with gen_ai.*; pinned to the minimum.
const ECS_VERSION = "9.1.0";
const OCSF_VERSION = "1.9.0";
const ECS_CATEGORY: Partial<Record<Category, { category: string[]; type: string[] }>> = {
  process_creation: { category: ["process"], type: ["start"] },
  file_access: { category: ["file"], type: ["access"] },
  file_event: { category: ["file"], type: ["change"] },
  web_request: { category: ["network", "web"], type: ["access"] },
  mcp: { category: ["api"], type: ["access"] },
  tool_call: { category: ["api"], type: ["info"] },
  instruction_load: { category: ["file"], type: ["access"] },
  config_change: { category: ["configuration", "file"], type: ["change"] },
};

type Attack = { tactics: string[]; techniques: string[]; subtechniques: string[]; other: string[] };

/** Splits Sigma tags: attack.t1552.001 -> technique T1552 + sub T1552.001, attack.credential_access -> tactic. */
export function parseTags(tags: string[]): Attack {
  const a: Attack = { tactics: [], techniques: [], subtechniques: [], other: [] };
  const add = (list: string[], v: string) => { if (!list.includes(v)) list.push(v); };
  for (const t of tags) {
    const tech = /^attack\.(t\d{4})(?:\.(\d{3}))?$/i.exec(t);
    if (tech) {
      add(a.techniques, tech[1]!.toUpperCase());
      if (tech[2]) add(a.subtechniques, `${tech[1]!.toUpperCase()}.${tech[2]}`);
    } else if (t.startsWith("attack.")) {
      add(a.tactics, t.slice(7).split("_").map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" "));
    } else a.other.push(t);
  }
  return a;
}

const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;
const dirName = (p: string) => p.replace(/[\\/][^\\/]*$/, "");

function ecsEvent(e: AgentEvent) {
  const cat = ECS_CATEGORY[e.category];
  const outcome = e.outcome === "success" ? "success" : e.outcome === "unknown" || !e.outcome ? "unknown" : "failure";
  return {
    "@timestamp": e.ts,
    event: {
      category: cat?.category, type: [...(cat?.type ?? []), ...(e.outcome === "blocked" ? ["denied"] : [])],
      action: e.tool_name, outcome, sequence: e.seq,
    },
    gen_ai: {
      agent: { name: e.agent, id: e.agent_id },
      provider: e.agent === "claude_code" ? { name: "anthropic" } : undefined,
      tool: e.tool_name ? { name: e.tool_name, type: e.mcp_server ? "mcp" : undefined } : undefined,
    },
    process: e.command_line ? { command_line: e.command_line, working_directory: e.project_path } : undefined,
    file: e.target_path ? { path: e.target_path, name: baseName(e.target_path), directory: dirName(e.target_path) } : undefined,
    url: e.url ? { full: e.url, original: e.url, domain: e.domain } : undefined,
    destination: e.domain ? { domain: e.domain } : undefined,
    log: { file: { path: e.raw_ref.file } },
    message: e.text_excerpt,
    retrohound: {
      schema_version: e.schema_version, session_id: e.session_id, parent_session_id: e.parent_session_id, agent_id: e.agent_id,
      agent_version: e.agent_version, project_path: e.project_path, outcome: e.outcome, raw_ref: { line: e.raw_ref.line },
      mcp: e.mcp_server ? { server: e.mcp_server, tool: e.mcp_tool } : undefined,
    },
  };
}

/** A transcript timestamp that is not ISO 8601 with a zone is rewritten as one (the scan's end when it is not a date at all):
 * a SIEM rejects an alert whose @timestamp is "January 1, 2024" even though Date.parse reads it. */
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;
const dateOr = (ts: string, fallback: string) =>
  ISO.test(ts) && !Number.isNaN(Date.parse(ts)) ? ts : Number.isNaN(Date.parse(ts)) ? fallback : new Date(ts).toISOString();

function ecsLine(f: Finding, rule: ReportRule | undefined, report: ScanReport) {
  const [p, ...rest] = f.events;
  const base = p ? ecsEvent(p) : { "@timestamp": f.ts, retrohound: { session_id: f.session_id } };
  const ts = dateOr(base["@timestamp"], report.scan.finished_at);
  const sev = SEVERITY[f.level];
  const atk = parseTags(rule?.tags ?? []);
  const baseEvent = "event" in base ? base.event : {};
  return {
    ...base,
    "@timestamp": ts,
    ecs: { version: ECS_VERSION },
    event: {
      ...baseEvent, kind: "alert", module: "retrohound", dataset: "retrohound.finding", id: f.id,
      severity: sev.id, risk_score: sev.risk, ingested: report.scan.finished_at,
    },
    observer: { product: "retrohound", vendor: "retrohound", type: "hunt" },
    rule: {
      id: f.rule_id, uuid: f.rule_id, name: rule?.name ?? rule?.title, description: rule?.description ?? rule?.title,
      ruleset: "retrohound", ...(rule?.author ? { author: [rule.author] } : {}),
    },
    threat: {
      framework: "MITRE ATT&CK", tactic: { name: atk.tactics },
      technique: { id: atk.techniques, ...(atk.subtechniques.length ? { subtechnique: { id: atk.subtechniques } } : {}) },
    },
    tags: atk.other,
    message: f.message,
    retrohound: {
      ...base.retrohound, ...(ts === base["@timestamp"] ? {} : { raw_ts: base["@timestamp"] }), finding: { id: f.id, event_ids: [p, ...rest].filter(Boolean).map((e) => e!.id) },
    },
  };
}

// evidences[].ai_agent is OCSF 1.9.0. type_id 1 Native: every parsed agent is first-party, no third-party framework.
// The ai_operation profile (ai_model, message_context) does not apply to Detection Finding, so it is not declared.
const evidence = (e: AgentEvent) => ({
  ai_agent: { name: e.agent, version: e.agent_version, instance_uid: e.session_id, type_id: 1 },
  api: e.mcp_server ? { operation: e.mcp_tool, service: { name: e.mcp_server } } : undefined,
  process: e.command_line ? { cmd_line: e.command_line } : undefined,
  file: e.target_path ? { path: e.target_path, name: baseName(e.target_path), type_id: 1 } : undefined,
  url: e.url ? { url_string: e.url, hostname: e.domain } : undefined,
});

function ocsfLine(f: Finding, rule: ReportRule | undefined, report: ScanReport) {
  const p = f.events[0];
  const atk = parseTags(rule?.tags ?? []);
  const times = f.events.map((e) => Date.parse(e.ts)).filter((t) => !Number.isNaN(t));
  const time = Date.parse(dateOr(f.ts, report.scan.finished_at));
  const attacks = [
    ...atk.tactics.map((n) => ({ tactic: { name: n } })),
    ...atk.techniques.map((t) => ({
      technique: { uid: t },
      ...(atk.subtechniques.find((s) => s.startsWith(t)) ? { sub_technique: { uid: atk.subtechniques.find((s) => s.startsWith(t)) } } : {}),
    })),
  ];
  return {
    class_uid: 2004, category_uid: 2, activity_id: 1, type_uid: 200401, time, severity_id: SEVERITY[f.level].id,
    status_id: 1, is_alert: true, message: f.message,
    metadata: {
      version: OCSF_VERSION, product: { name: report.tool.name, vendor_name: "retrohound", version: report.tool.version },
      uid: f.id, correlation_uid: f.session_id,
    },
    finding_info: {
      uid: f.id, title: rule?.name ?? rule?.title ?? f.rule_id, desc: rule?.description ?? rule?.title,
      analytic: { uid: f.rule_id, name: rule?.name ?? rule?.title, type_id: 1 }, attacks, types: ["retrohound/hunt"],
      related_events: f.events.map((e) => ({ uid: e.id })),
      first_seen_time: times.length ? Math.min(...times) : time, last_seen_time: times.length ? Math.max(...times) : time,
    },
    evidences: f.events.map(evidence),
    unmapped: {
      retrohound: {
        session_id: f.session_id, agent: p?.agent, agent_id: p?.agent_id, parent_session_id: p?.parent_session_id,
        rule_author: rule?.author,
        project_path: p?.project_path, raw_ref: p?.raw_ref, other_tags: atk.other,
      },
    },
  };
}

export function toNdjson(report: ScanReport, schema: NdjsonSchema): string {
  const rules = new Map(report.rules.map((r) => [r.id, r]));
  const lines = report.findings.map((f) => {
    const clean = { ...f, events: f.events.map((e) => maskDeep(e, true) as AgentEvent) };
    const line = schema === "ecs" ? ecsLine(clean, rules.get(f.rule_id), report) : ocsfLine(clean, rules.get(f.rule_id), report);
    return JSON.stringify(maskDeep(line));
  });
  return lines.length ? lines.join("\n") + "\n" : "";
}

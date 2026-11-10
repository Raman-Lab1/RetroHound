// index.html of an incident pack: incident.json made readable, offline. No scripts, links, fonts or images, and a CSP
// that forbids loading anything, since the text comes from transcripts an attacker may have shaped. Every cell is
// masked, then escaped (as src/outputs/wrapped.ts does). No whole-page mask pass: run over markup, a secret pattern
// can swallow tags (`token=abc</td></tr>...`), and every value is already masked.
import { mask } from "../normalize/mask.ts";
import type { Pack } from "./pack.ts";

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const h = (s: unknown) => mask(String(s ?? "")).replace(/[&<>"']/g, (c) => ESC[c]!);
const table = (head: string[], rows: unknown[][]) => rows.length
  ? `<table><tr>${head.map((c) => `<th>${h(c)}</th>`).join("")}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${h(c)}</td>`).join("")}</tr>`).join("")}</table>`
  : "<p>none</p>";
const section = (title: string, body: string) => `<h2>${h(title)}</h2>${body}`;
const agent = (id?: string) => (id ? `sub:${id.slice(0, 8)}` : "main");

const CSS = `body{margin:24px;font:14px/1.4 system-ui,sans-serif;color:#1b1f24;background:#fff}
h2{font-size:15px;margin:22px 0 6px}table{border-collapse:collapse;width:100%}
th,td{border:1px solid #d0d7de;padding:3px 6px;text-align:left;vertical-align:top;overflow-wrap:anywhere}th{background:#f6f8fa}`;

export function renderIncidentHtml(p: Pack): string {
  const o = p.counts.outcomes;
  const marks = new Map<string, string[]>();
  for (const f of p.findings) for (const id of f.event_ids) marks.set(id, [...(marks.get(id) ?? []), `${f.level} ${f.rule_name ?? f.rule_id}`]);
  const agentRows = p.sub_agents.flatMap((t) => [
    [t.session_id.slice(0, 8), "main", "", t.main.events, t.main.outcomes.blocked, t.main.outcomes.success, t.main.first_ts, t.main.last_ts],
    ...t.sub_agents.map((a) => ["", `└ ${agent(a.agent_id)}`, a.parent_tool_use_id, a.events, a.outcomes.blocked, a.outcomes.success, a.first_ts, a.last_ts]),
  ]);
  const body = [
    `<h1>RetroHound incident ${h(p.selected.id.slice(0, 8))}</h1>`,
    `<p>${h(p.selected.kind)} ${h(p.selected.id)} · ${h(p.tool.name)} ${h(p.tool.version)} · rule set ${h(p.rule_set_hash ?? "-")}${p.anonymized ? " · anonymized" : ""}</p>`,
    `<p>${h(p.counts.events)} events (${h(p.counts.sub_agent_events)} from sub-agents) · ${h(o.blocked)} blocked · ${h(o.success)} succeeded · ${h(o.error)} errors · ${h(p.counts.findings)} findings · ${h(p.rotate.length)} secrets to rotate</p>`,
    section("Sessions", table(["session", "agent", "project", "first", "last", "events", "archived"], p.sessions.map((s) =>
      [s.session_id, s.agent, s.project_path, s.first_ts, s.last_ts, s.event_count, s.archived ? "yes: transcript gone, kept by the index" : "no"]))),
    section("Findings", table(["level", "rule", "time", "session", "message", "events"], p.findings.map((f) =>
      [f.level, f.rule_name ?? f.rule_id, f.ts, f.session_id.slice(0, 8), f.message, f.event_ids.length]))),
    section("Rotate these secrets (fingerprints, not values)", table(["fingerprint", "kinds", "sessions"], p.rotate.map((r) =>
      [r.fingerprint, r.kinds.join(", ") || "secret", r.sessions]))),
    section("Agents", table(["session", "agent", "spawned by tool call", "events", "blocked", "succeeded", "first", "last"], agentRows)),
    section("Timeline", table(["time", "agent", "category", "tool", "detail", "outcome", "findings"], p.timeline.map((e) =>
      [e.ts, agent(e.agent_id), e.category, e.tool_name, e.command_line ?? e.url ?? e.target_path,
        [e.outcome, e.denial_kind, e.denial_category].filter(Boolean).join(" "), (marks.get(e.id) ?? []).join("; ")]))),
    section("Evidence provenance", table(["source file", "sha256", "first seen", "last seen", "gone at"], p.provenance.map((f) =>
      [f.path, f.sha256, f.first_seen, f.last_seen, f.gone_at ?? "-"]))),
  ].join("\n");
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">${csp}<title>RetroHound incident ${h(p.selected.id.slice(0, 8))}</title><style>${CSS}</style></head><body>\n${body}\n</body></html>\n`;
}

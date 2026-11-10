// The footprint page (`retrohound scan` writes it to ~/.retrohound/report.html): a Footprint as one offline page.
// Same guarantees as src/incident/html.ts: no scripts, links, fonts or images, a CSP that loads nothing, every value
// masked then escaped by the same h() (attributes too). No whole-page mask pass: a secret pattern run over markup can
// swallow tags (`token=abc</td></tr>...`), and every value is already masked. Interactivity is <details> and CSS only.
import { h } from "../incident/html.ts";
import { LEVELS, type Level } from "../normalize/types.ts";
import type { Footprint, Seen, SessionNode } from "./types.ts";

class Html { constructor(readonly s: string) {} } // a table cell already built from h()-escaped parts
const raw = (s: string) => new Html(s);
const NONE = `<p class="mu">none</p>`;
const table = (head: string[], rows: unknown[][]) => rows.length
  ? `<div class="w"><table><tr>${head.map((c) => `<th>${h(c)}</th>`).join("")}</tr>${rows.map((r) =>
    `<tr>${r.map((c) => `<td>${c instanceof Html ? c.s : h(c)}</td>`).join("")}</tr>`).join("")}</table></div>`
  : NONE;
const section = (title: string, body: string) => `<section><h2>${h(title)}</h2>${body}</section>`;
const id8 = (id: string) => `<code title="${h(id)}">${h(id.slice(0, 8))}</code>`;
const badge = (l?: string) => (l ? `<span class="b ${h(l)}">${h(l)}</span>` : "");
const pct = (n: number, of: number) => `${of ? Math.round((n / of) * 100) : 0}%`;
const rank = (l?: Level) => (l ? LEVELS.indexOf(l) : -1);
const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);
const blk = (n: number) => (n ? `<span class="bad">${h(n)} blocked</span>` : "0 blocked");
const counts = (events: number, blocked: number, findings: number, worst?: Level) =>
  `${h(events)} events · ${blk(blocked)} · ${h(findings)} findings ${badge(worst)}`;
const risky = (mode: string) => /bypass|danger/i.test(mode) || mode.toLowerCase() === "auto";

const CSS = `:root{--bg:#fff;--fg:#1f2328;--mu:#59636e;--bd:#d1d9e0;--sf:#f6f8fa;--ac:#0969da;--bad:#cf222e;--warn:#9a6700;--ok:#1a7f37}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--mu:#9198a1;--bd:#3d444d;--sf:#151b23;--ac:#4493f8;--bad:#f85149;--warn:#d29922;--ok:#3fb950}}
*{box-sizing:border-box}body{margin:0 auto;max-width:1200px;padding:16px;font:14px/1.45 system-ui,sans-serif;color:var(--fg);background:var(--bg);overflow-wrap:anywhere}
h1{font-size:20px;margin:0}h2{font-size:16px;margin:28px 0 8px}h3{font-size:14px;margin:14px 0 4px}ul{margin:4px 0;padding-left:20px}
.mu{color:var(--mu)}.bad{color:var(--bad);font-weight:600}.warn{color:var(--warn)}.ok{color:var(--ok)}
.w{overflow-x:auto}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th,td{border:1px solid var(--bd);padding:3px 6px;text-align:left;vertical-align:top}th{background:var(--sf);white-space:nowrap}
.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px}
.t{border:1px solid var(--bd);border-radius:6px;padding:8px;color:var(--mu)}.t b{display:block;font-size:20px;color:var(--fg)}
.t.hot{border-color:var(--bad)}.t.hot b{color:var(--bad)}
.b{display:inline-block;padding:0 6px;border-radius:9px;font-size:12px;color:var(--bg);background:var(--mu)}
.b.critical,.b.high{background:var(--bad)}.b.medium{background:var(--warn)}
details details{margin-left:18px}summary{cursor:pointer;padding:2px 0}
svg.a{display:block;width:100%;height:64px;background:var(--sf)}svg.a rect{fill:var(--ac)}svg.a .x{fill:var(--bad)}svg.a .f{fill:var(--warn)}
.bw{width:120px;background:var(--sf)}.bar{height:10px;background:var(--ac)}code{font:12px ui-monospace,monospace}footer{margin-top:32px;color:var(--mu)}`;

function trust(t: Footprint["trust"]): string {
  const c = t.chain;
  const chain = c === null ? `<span class="warn">index predates the hash chain: earlier writes are not tamper-evident</span>`
    : `hash chain: ${h(c.entries)} entries, head ${h(c.head.slice(0, 12))}; check it with <code>retrohound verify</code>`;
  const r = t.retention_days;
  const ret = r === undefined ? ""
    : r <= 30 ? `<li class="warn">Claude Code deletes transcripts after ${h(r)} days: older history survives only in this index</li>`
    : `<li>Claude Code deletes transcripts after ${h(r)} days</li>`;
  return `<ul><li>${chain}</li><li>${h(t.files.indexed)} source files indexed, ${h(t.files.gone)} gone since</li>`
    + `<li>${h(t.archived_sessions)} archived sessions (transcript gone, kept by the index)</li>${ret}`
    + `<li>events from ${h(t.first_ts ?? "-")} to ${h(t.last_ts ?? "-")}</li></ul>`;
}

// One bar per day with events, height scaled to the busiest day; red overlay for blocked, a top mark for findings.
// The viewBox is at least 30 days wide so a short history stays thin bars instead of one stretched block.
function activity(a: Footprint["activity"]): string {
  if (!a.length) return NONE;
  const max = Math.max(1, ...a.map((x) => x.events));
  const y = (n: number) => (n ? Math.max(1, (n / max) * 40) : 0);
  const bar = (i: number, n: number, cls = "") => `<rect${cls} x="${i}" y="${45 - y(n)}" width=".8" height="${y(n)}"/>`;
  const bars = a.map((x, i) => `<g><title>${h(`${x.day}: ${x.events} events, ${x.blocked} blocked, ${x.findings} findings`)}</title>`
    + bar(i, x.events) + (x.blocked ? bar(i, x.blocked, ` class="x"`) : "")
    + (x.findings ? `<rect class="f" x="${i}" y="0" width=".8" height="3"/>` : "") + "</g>").join("");
  return `<svg class="a" viewBox="0 0 ${Math.max(30, a.length)} 45" preserveAspectRatio="none" role="img" aria-label="events per day">${bars}</svg>`
    + `<p class="mu">${h(a[0]!.day)} to ${h(a[a.length - 1]!.day)} · ${h(a.length)} days with events · busiest ${h(max)} events · `
    + `<span class="bad">red</span>: blocked · <span class="warn">top mark</span>: findings</p>`;
}

const session = (s: SessionNode) => `<details><summary>${id8(s.session_id)} ${h(s.first_ts)} to ${h(s.last_ts)} · `
  + `${counts(s.events, s.blocked, s.findings, s.worst)} ${s.archived ? badge("archived") : ""} · ${h(s.sub_agents.length)} sub-agents</summary>`
  + `<p class="mu">details: <code>retrohound show ${h(s.session_id.slice(0, 8))}</code></p>`
  + (s.sub_agents.length ? `<ul>${s.sub_agents.map((x) => `<li>sub-agent ${id8(x.agent_id)} · ${h(x.events)} events · ${blk(x.blocked)}</li>`).join("")}</ul>` : "")
  + "</details>";

function tree(agents: Footprint["agents"]): string {
  return agents.map((a) => {
    const ps = a.projects;
    const worst = ps.map((p) => p.worst).reduce<Level | undefined>((w, l) => (rank(l) > rank(w) ? l : w), undefined);
    const projects = ps.map((p) => `<details><summary><b>${h(p.project)}</b> · ${h(p.sessions)} sessions · `
      + `${counts(p.events, p.blocked, p.findings, p.worst)}</summary>${p.list.map(session).join("")}${p.sessions > p.list.length
        ? `<p class="mu">${h(p.sessions - p.list.length)} more sessions not shown: the page lists the riskiest across the index</p>` : ""}</details>`).join("");
    return `<details open><summary><b>${h(a.agent)}</b> · ${h(ps.length)} projects · ${h(a.sessions)} sessions · `
      + `${counts(a.events, sum(ps.map((p) => p.blocked)), sum(ps.map((p) => p.findings)), worst)}</summary>${projects || NONE}</details>`;
  }).join("") || NONE;
}

const seen = (label: string, rows: Seen[]) => `<h3>${h(label)}</h3>` + table([label, "events", "sessions", "blocked", "% sub-agent", "first seen", "last seen"],
  rows.map((s) => [s.detail ? `${s.name} (${s.detail})` : s.name, s.events, s.sessions, s.blocked, pct(s.sub_agent, s.events), s.first_ts, s.last_ts]));

export function renderFootprint(d: Footprint): string {
  const T = d.totals;
  const tile = (label: string, v: unknown, hot = false) => `<div class="t${hot ? " hot" : ""}"><b>${h(v)}</b>${h(label)}</div>`;
  const tiles = [tile("agents", T.agents), tile("projects", T.projects), tile("sessions", T.sessions), tile("events", T.events),
    tile("from sub-agents", pct(T.sub_agent_events, T.events)), tile("blocked", T.blocked), tile("distinct secrets", T.secrets),
    ...[...LEVELS].reverse().map((l) => tile(`${l} findings`, T.findings[l], rank(l) >= rank("high") && T.findings[l] > 0))];
  const dmax = Math.max(1, ...d.domains.map((x) => x.events));
  const more = Object.entries(d.omitted).filter(([, n]) => n > 0)
    .map(([k, n]) => `<li>${h(n)} more ${h(k)} not shown; use <code>retrohound query</code></li>`).join("");
  const body = [
    `<header><h1>RetroHound footprint</h1><p class="mu">generated ${h(d.generated_at)} · retrohound ${h(d.tool_version)}</p></header>`,
    section("Can I trust this data?", trust(d.trust)),
    section("Overview", `<div class="g">${tiles.join("")}</div>`),
    section("Activity per day", activity(d.activity)),
    section("Where did agents work?", tree(d.agents)),
    section("What could they reach?", seen("MCP servers", d.tools.mcp_servers) + seen("Hooks", d.tools.hooks)
      + seen("Skills and plugins", d.tools.attributions)),
    section("Who did they contact?", table(["#", "domain", "share", "events", "sessions", "blocked", "% sub-agent", "first seen", "last seen"],
      d.domains.map((x, i) => [i + 1, x.name, raw(`<div class="bw"><div class="bar" style="width:${Math.round((x.events / dmax) * 100)}%"></div></div>`),
        x.events, x.sessions, x.blocked, pct(x.sub_agent, x.events), x.first_ts, x.last_ts]))),
    section("What must I rotate?", `<p class="mu">Fingerprints, never values. Domains are co-occurrence, not proof a secret was sent there.</p>`
      + table(["fingerprint", "kinds", "sessions", "sub-agents", "projects", "domains contacted in the same sessions", "first seen", "last seen"],
        d.secrets.map((s) => [s.fingerprint, s.kinds.join(", ") || "secret", s.sessions, s.sub_agents, s.projects.join(", ") || "-",
          s.domains.join(", ") || "none", s.first_ts, s.last_ts]))),
    section("How long were guard rails off?", table(["permission mode", "events", "sessions", "sub-agent events"],
      d.modes.map((m) => [risky(m.mode) ? raw(`<span class="bad">${h(m.mode)}</span>`) : m.mode, m.events, m.sessions, m.sub_agent]))),
    section("What did they try?", `<h3>Blocked by kind</h3>${table(["kind", "count"], d.blocked.kinds.map((k) => [k.name, k.count]))}`
      + `<h3>Blocked by category</h3>${table(["category", "count"], d.blocked.categories.map((k) => [k.name, k.count]))}`),
    section("Findings", table(["level", "rule", "time", "session", "project", "agent", "message"], d.findings.map((f) =>
      [raw(badge(f.level)), f.rule, f.ts, raw(id8(f.session_id)), f.project, f.agent_id ? raw(`sub-agent ${id8(f.agent_id)}`) : "main", f.message]))),
    `<footer>${more ? `<ul>${more}</ul>` : ""}<p>Built offline from the local index. Nothing on this page was fetched or sent.</p></footer>`,
  ].join("\n");
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">${csp}<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<meta name="color-scheme" content="light dark"><title>RetroHound footprint</title><style>${CSS}</style></head><body>\n${body}\n</body></html>\n`;
}

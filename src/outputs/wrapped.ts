// `wrapped` card: pure data -> one self-contained HTML string. No assets, no scripts, works offline.
// Every string is masked, then HTML-escaped; the finished document gets a last mask pass.
import { mask } from "../normalize/mask.ts";

export type WrappedData = {
  period: string; // e.g. "last 365d"
  anonymized: boolean;
  sessions: number;
  hours: number;
  commands: number;
  files: number;
  secretsTouched: number; // events that touched secrets: a count, never values
  blocked: number;
  subagentPct: number; // % of events from sub-agents
  domains: { name: string; count: number }[]; // top 10
  rules: { name: string; level: string; count: number }[]; // top 5
  riskiest?: { session: string; project: string; findings: number; level: string };
  spiciest?: { command: string; rule: string; level: string };
};

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const h = (s: string | number) => mask(String(s)).replace(/[&<>"']/g, (c) => ESC[c]!);

const stat = (label: string, v: string | number) => `<div class="s"><b>${h(v)}</b><span>${h(label)}</span></div>`;
const list = (title: string, rows: string[]) =>
  `<section><h2>${h(title)}</h2>${rows.length ? `<ol>${rows.map((r) => `<li>${r}</li>`).join("")}</ol>` : "<p>none</p>"}</section>`;

const CSS = `body{margin:0;background:#0f1115;color:#e8e8ea;font:16px/1.4 system-ui,sans-serif;padding:24px}
.card{max-width:760px;margin:auto;background:#181b22;border-radius:14px;padding:28px}
h1{margin:0 0 4px}h2{font-size:14px;text-transform:uppercase;color:#8b93a7;margin:22px 0 6px}
.g{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px}
.s{background:#222632;border-radius:10px;padding:12px}.s b{display:block;font-size:26px}.s span{color:#8b93a7;font-size:13px}
code{display:block;background:#0f1115;padding:10px;border-radius:8px;overflow-wrap:anywhere}ol{margin:0;padding-left:20px}`;

// SVG share card, 1200x630: system fonts only, no scripts/links/images. Convert to PNG with any tool you like.
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const t = (x: number, y: number, size: number, fill: string, s: string | number, w = 400) =>
  `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}"${size > 30 ? ' font-weight="700"' : ""}>${h(clip(String(s), w / (size * 0.55)))}</text>`;

export function renderWrappedSvg(d: WrappedData): string {
  const stats: [string, string | number][] = [
    ["sessions", d.sessions], ["hours with agents", d.hours], ["commands run", d.commands], ["files touched", d.files],
    ["secrets touched", d.secretsTouched], ["blocked attempts", d.blocked], ["from sub-agents", `${d.subagentPct}%`],
  ];
  const cells = stats.map(([l, v], i) => t(60 + (i % 4) * 280, 170 + Math.floor(i / 4) * 110, 52, "#e8e8ea", v, 260) + t(60 + (i % 4) * 280, 200 + Math.floor(i / 4) * 110, 20, "#8b93a7", l, 260));
  const rules = d.rules.slice(0, 5).map((r, i) => t(60, 430 + i * 32, 22, "#e8e8ea", `${r.name} [${r.level}] x${r.count}`, 1080));
  const svg = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif">`
    + `<rect width="1200" height="630" fill="#181b22"/>`
    + t(60, 70, 44, "#e8e8ea", "RetroHound Wrapped", 700) + t(60, 104, 22, "#8b93a7", `${d.period}${d.anonymized ? " (anonymized)" : ""}`, 700)
    + cells.join("") + t(60, 400, 20, "#8b93a7", "TOP RULES FIRED", 400)
    + (rules.length ? rules.join("") : t(60, 430, 22, "#e8e8ea", "none", 400)) + `</svg>\n`;
  return mask(svg);
}

export function renderWrapped(d: WrappedData): string {
  const r = d.riskiest;
  const sp = d.spiciest;
  const body = [
    `<h1>RetroHound Wrapped</h1><p>${h(d.period)}${d.anonymized ? " (anonymized)" : ""}</p>`,
    `<div class="g">${[
      stat("sessions", d.sessions), stat("hours with agents", d.hours), stat("commands run", d.commands),
      stat("files touched", d.files), stat("secrets touched", d.secretsTouched), stat("blocked attempts", d.blocked),
      stat("events from sub-agents", `${d.subagentPct}%`),
    ].join("")}</div>`,
    list("Top domains", d.domains.map((x) => `${h(x.name)} (${h(x.count)})`)),
    list("Top rules fired", d.rules.map((x) => `${h(x.name)} [${h(x.level)}] x${h(x.count)}`)),
    `<section><h2>Riskiest session</h2><p>${r ? `${h(r.session)} in ${h(r.project)}: ${h(r.findings)} findings, worst ${h(r.level)}` : "none"}</p></section>`,
    `<section><h2>Spiciest command</h2>${sp ? `<code>${h(sp.command)}</code><p>${h(sp.rule)} [${h(sp.level)}]</p>` : "<p>none</p>"}</section>`,
  ].join("");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>RetroHound Wrapped</title><style>${CSS}</style></head><body><div class="card">${body}</div></body></html>\n`;
  return mask(html);
}

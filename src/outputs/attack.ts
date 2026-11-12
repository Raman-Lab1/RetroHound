// MITRE ATT&CK Navigator layer (layer format 4.5): the techniques this scan's findings map to, scored by how many
// findings point at each. Open it in the Navigator with "Open Existing Layer". Pure function over the scan document;
// final mask pass as in json.ts. No tactic is set, so a technique shows under every tactic it belongs to.
import { maskDeep } from "./json.ts";
import { parseTags } from "./ndjson.ts";
import type { ScanReport } from "./report.ts";

const asc = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A rule tagged with a sub-technique scores the sub-technique, not also its parent; a parent tagged by other rules keeps
 * its own score, and the Navigator's aggregate (sum) shows it with its sub-techniques. Findings of rules with no
 * technique tag are only counted in the description. */
export function toAttackLayer(report: ScanReport): string {
  const rules = new Map(report.rules.map((r) => [r.id, r]));
  const hits = new Map<string, Map<string, number>>(); // technique id -> rule id -> findings
  let untagged = 0;
  for (const f of report.findings) {
    const rule = rules.get(f.rule_id);
    const a = parseTags(rule?.tags ?? []);
    const ids = [...a.subtechniques, ...a.techniques.filter((t) => !a.subtechniques.some((s) => s.startsWith(`${t}.`)))];
    if (!ids.length) untagged++;
    for (const id of ids) {
      const byRule = hits.get(id) ?? new Map<string, number>();
      byRule.set(f.rule_id, (byRule.get(f.rule_id) ?? 0) + 1);
      hits.set(id, byRule);
    }
  }
  const label = (id: string) => rules.get(id)?.name ?? rules.get(id)?.title ?? id;
  const techniques = [...hits].sort(([a], [b]) => asc(a, b)).map(([techniqueID, byRule]) => {
    const rows = [...byRule].map(([id, c]) => [label(id), c] as const).sort((a, b) => b[1] - a[1] || asc(a[0], b[0]));
    return { techniqueID, score: rows.reduce((n, [, c]) => n + c, 0), comment: rows.map(([n, c]) => `${n} (${c})`).join(", "), enabled: true };
  });
  const { tool, scan } = report;
  const layer = {
    name: "RetroHound findings",
    versions: { layer: "4.5", navigator: "4.9.0" }, // no `attack`: the Navigator's current ATT&CK
    domain: "enterprise-attack",
    description: `${tool.name} ${tool.version}, scan finished ${scan.finished_at}: ${report.findings.length} findings across ${scan.sessions} `
      + `scanned sessions. Score = findings per technique.${untagged ? ` ${untagged} findings come from rules with no ATT&CK technique and are not shown.` : ""}`,
    layout: { expandedSubtechniques: "annotated", showAggregateScores: true, aggregateFunction: "sum" },
    sorting: 3, // score, highest first
    techniques,
    gradient: { colors: ["#ffe5e5", "#d62728"], minValue: 0, maxValue: Math.max(1, ...techniques.map((t) => t.score)) },
  };
  return JSON.stringify(maskDeep(layer), null, 2);
}

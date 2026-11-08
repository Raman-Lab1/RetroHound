// `retrohound.scan/0.1` document (ADR 0014). Final mask pass over every string, deep (ADR 0007), and match-only fields
// (ADR 0006) are stripped from events even if a caller left them on the object.
import { mask } from "../normalize/mask.ts";
import type { ScanReport } from "./report.ts";

const MATCH_ONLY = new Set(["content", "tool_input", "tool_response", "text"]);

/** Deep copy with every string masked. `strip` drops match-only keys from the objects it sees. */
export function maskDeep(v: unknown, strip = false): unknown {
  if (typeof v === "string") return mask(v);
  if (Array.isArray(v)) return v.map((x) => maskDeep(x, strip));
  if (v && typeof v === "object") {
    const entries = Object.entries(v).filter(([k]) => !(strip && MATCH_ONLY.has(k)));
    return Object.fromEntries(entries.map(([k, x]) => [k, maskDeep(x, strip)]));
  }
  return v;
}

export function toJson(report: ScanReport): string {
  const findings = report.findings.map((f) => ({ ...f, events: f.events.map((e) => maskDeep(e, true)) }));
  return JSON.stringify(maskDeep({ ...report, findings }), null, 2);
}

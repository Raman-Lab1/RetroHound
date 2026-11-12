import { describe, expect, test } from "bun:test";
import { toSarif } from "../../src/outputs/sarif.ts";
import { toNdjson } from "../../src/outputs/ndjson.ts";
import { toAttackLayer } from "../../src/outputs/attack.ts";
import type { ScanReport } from "../../src/outputs/report.ts";
import type { AgentEvent, Finding, Level } from "../../src/normalize/types.ts";

// Defanged: placeholder token built by concatenation so no secret-shaped literal lands in the repo.
const TOKEN = "gh" + "p_" + "A1b2C3d4E5".repeat(4);
const FILE = "/home/u/.claude/projects/-home-u-acme/aaaaaaaa-1111.jsonl";

const ev = (o: Partial<AgentEvent> = {}): AgentEvent => ({
  id: "e1", schema_version: "0.1", agent: "claude_code", session_id: "aaaaaaaa-1111", ts: "2026-09-14T10:00:00Z",
  seq: 1, category: "process_creation", project_path: "/work/acme/api", raw_ref: { file: FILE, line: 7 }, ...o,
});
const finding = (o: Partial<Finding> = {}): Finding => ({
  id: "9b1e0000000000000000aaaa", rule_id: "r1", level: "high", ts: "2026-09-14T10:00:30Z", session_id: "aaaaaaaa-1111",
  message: "curl https://example.invalid", events: [ev()], ...o,
});
const report = (findings: Finding[] = [finding()]): ScanReport => ({
  schema: "retrohound.scan/0.1", tool: { name: "retrohound", version: "0.1.0" },
  scan: {
    started_at: "2026-11-07T10:00:00Z", finished_at: "2026-11-07T10:00:03Z", sessions: 1, events: 2, blocked: 0,
    subagent_events: 0, files: { indexed: 1, skipped: 0, gone: 0, failed: 0 }, archived_sessions: [], root: "/home/u/.claude/projects",
  },
  rules: [{
    id: "r1", name: "secret_read_then_egress", title: "Secret read then egress", description: "Secret read, then network egress.",
    level: "high", tags: ["attack.credential_access", "attack.t1552.001", "attack.t1041", "owasp_agentic.x"], lane: "hunt",
    falsepositives: ["deploy scripts"],
  }],
  findings,
});

describe("toSarif", () => {
  test("required fields, ruleIndex, locations, fingerprints", () => {
    const related = ev({ id: "e0", raw_ref: { file: FILE, line: 3 }, target_path: "/work/acme/.env" });
    const doc = JSON.parse(toSarif(report([finding({ events: [ev(), related] })])));
    const run = doc.runs[0];
    expect(doc.version).toBe("2.1.0");
    expect(run.tool.driver.name).toBe("retrohound");
    const rule = run.tool.driver.rules[0];
    expect(rule).toMatchObject({ id: "r1", name: "secret_read_then_egress", defaultConfiguration: { level: "error" } });
    expect(rule.properties["security-severity"]).toBe("8.0");
    expect(rule.properties.tags).toContain("attack.t1552.001");
    expect(rule.help.text).toContain("deploy scripts");
    const r = run.results[0];
    expect(run.tool.driver.rules[r.ruleIndex].id).toBe(r.ruleId);
    expect(r.level).toBe("error");
    expect(r.locations[0].physicalLocation).toEqual({
      artifactLocation: { uri: "-home-u-acme/aaaaaaaa-1111.jsonl", uriBaseId: "CLAUDE_PROJECTS" },
      region: { startLine: 7, startColumn: 1, endLine: 7 },
    });
    expect(r.relatedLocations[0].physicalLocation.region.startLine).toBe(3);
    expect(r.partialFingerprints.primaryLocationLineHash).toBe("9b1e000000000000:1");
    expect(r.properties).toMatchObject({ session_id: "aaaaaaaa-1111", agent: "claude_code", scope: "main", event_ids: ["e1", "e0"] });
  });
  test("level mapping, every finding present, unknown rule gets a stub", () => {
    const levels: Level[] = ["informational", "low", "medium", "high", "critical"];
    const fs = levels.map((level, i) => finding({ id: `f${i}`, level, rule_id: i === 0 ? "ghost" : "r1" }));
    const run = JSON.parse(toSarif(report(fs))).runs[0];
    expect(run.results.map((r: { level: string }) => r.level)).toEqual(["note", "note", "warning", "error", "error"]);
    expect(run.results).toHaveLength(5);
    expect(run.tool.driver.rules.map((r: { id: string }) => r.id)).toEqual(["r1", "ghost"]);
    expect(run.results[0].ruleIndex).toBe(1);
  });
  test("sub-agent attribution", () => {
    const r = JSON.parse(toSarif(report([finding({ events: [ev({ agent_id: "agentxyz99" })] })]))).runs[0].results[0];
    expect(r.properties).toMatchObject({ agent_id: "agentxyz99", scope: "sub-agent" });
  });
  test("masks secrets and strips match-only fields", () => {
    const e = { ...ev({ command_line: `echo ${TOKEN}` }), content: "C0NTENT", tool_input: "T1NPUT" } as AgentEvent;
    const out = toSarif(report([finding({ message: `leak ${TOKEN}`, events: [e, e] })]));
    for (const w of [TOKEN, "C0NTENT", "T1NPUT"]) expect(out).not.toContain(w);
    expect(out).toContain("ghp_…[masked]");
  });
  test("empty report is a valid run with no results", () => {
    const run = JSON.parse(toSarif(report([]))).runs[0];
    expect(run.results).toEqual([]);
  });
});

describe("toNdjson", () => {
  const sub = finding({ events: [ev({ agent_id: "agentxyz99", target_path: "/work/acme/.env", url: "https://paste.example.invalid/u", domain: "paste.example.invalid" })] });
  test("empty report is the empty string", () => {
    expect(toNdjson(report([]), "ecs")).toBe("");
    expect(toNdjson(report([]), "ocsf")).toBe("");
  });
  test("one valid JSON line per finding, trailing newline, no blank lines", () => {
    for (const s of ["ecs", "ocsf"] as const) {
      const out = toNdjson(report([finding(), sub]), s);
      expect(out.endsWith("\n")).toBe(true);
      const lines = out.slice(0, -1).split("\n");
      expect(lines).toHaveLength(2);
      for (const l of lines) expect(l.length).toBeGreaterThan(0), JSON.parse(l);
    }
  });
  test("ECS alert mapping", () => {
    const o = JSON.parse(toNdjson(report([sub]), "ecs").trim());
    expect(o).toMatchObject({
      ecs: { version: "9.1.0" }, event: { kind: "alert", id: sub.id, severity: 4, risk_score: 73, category: ["process"] },
      rule: { uuid: "r1", name: "secret_read_then_egress", ruleset: "retrohound" },
      threat: { framework: "MITRE ATT&CK", tactic: { name: ["Credential Access"] }, technique: { id: ["T1552", "T1041"], subtechnique: { id: ["T1552.001"] } } },
      tags: ["owasp_agentic.x"], url: { domain: "paste.example.invalid" },
      gen_ai: { agent: { name: "claude_code", id: "agentxyz99" } }, retrohound: { session_id: "aaaaaaaa-1111", agent_id: "agentxyz99", finding: { event_ids: ["e1"] } },
    });
    expect(o.file).toMatchObject({ name: ".env", directory: "/work/acme" });
  });
  test("OCSF detection finding mapping", () => {
    const o = JSON.parse(toNdjson(report([sub]), "ocsf").trim());
    expect(o).toMatchObject({ class_uid: 2004, type_uid: 200401, severity_id: 4, time: Date.parse(sub.ts), metadata: { version: "1.9.0", uid: sub.id } });
    expect(o.finding_info.analytic.uid).toBe("r1");
    expect(o.finding_info.attacks).toContainEqual({ technique: { uid: "T1552" }, sub_technique: { uid: "T1552.001" } });
    expect(o.finding_info.related_events).toEqual([{ uid: "e1" }]);
    expect(o.unmapped.retrohound).toMatchObject({ agent_id: "agentxyz99" });
    expect(o.unmapped.retrohound.ai_agent).toBeUndefined();
    expect(o.evidences[0].ai_agent).toEqual({ name: "claude_code", instance_uid: "aaaaaaaa-1111", type_id: 1 });
    expect(o.evidences[0].api).toBeUndefined();
  });
  test("OCSF evidence per event: agent version, MCP server and tool as api", () => {
    const mcp = ev({ id: "e2", category: "mcp", agent: "codex", agent_version: "0.50.0", tool_name: "mcp__docs__fetch", mcp_server: "docs", mcp_tool: "fetch" });
    const o = JSON.parse(toNdjson(report([finding({ events: [ev(), mcp] })]), "ocsf").trim());
    expect(o.metadata.profiles).toBeUndefined();
    expect(o.evidences[1]).toMatchObject({
      ai_agent: { name: "codex", version: "0.50.0", type_id: 1 }, api: { operation: "fetch", service: { name: "docs" } },
    });
  });
  test("masks secrets and strips match-only fields in both schemas", () => {
    const e = { ...ev({ command_line: `echo ${TOKEN}`, text_excerpt: TOKEN }), content: "C0NTENT", tool_response: "T2ESP" } as AgentEvent;
    for (const s of ["ecs", "ocsf"] as const) {
      const out = toNdjson(report([finding({ message: TOKEN, events: [e] })]), s);
      for (const w of [TOKEN, "C0NTENT", "T2ESP"]) expect(out).not.toContain(w);
    }
  });
});

describe("toAttackLayer", () => {
  test("one entry per technique, the sub-technique instead of its parent, scored by findings; untagged ones only counted", () => {
    const r = report([finding(), finding({ id: "f2" }), finding({ id: "f3", rule_id: "r2" })]);
    r.rules.push({ id: "r2", title: "No technique", level: "low", tags: ["attack.discovery"], lane: "hunt" });
    const layer = JSON.parse(toAttackLayer(r));
    expect(layer).toMatchObject({ name: "RetroHound findings", domain: "enterprise-attack", versions: { layer: "4.5" } });
    expect(layer.techniques).toEqual([
      { techniqueID: "T1041", score: 2, comment: "secret_read_then_egress (2)", enabled: true },
      { techniqueID: "T1552.001", score: 2, comment: "secret_read_then_egress (2)", enabled: true },
    ]);
    expect(layer.gradient).toMatchObject({ minValue: 0, maxValue: 2 });
    expect(layer.description).toContain("3 findings across 1 scanned sessions");
    expect(layer.description).toContain("1 findings come from rules with no ATT&CK technique");
  });

  test("a parent tagged by another rule keeps its own entry, summed by the Navigator; counts are per rule id", () => {
    const r = report([finding(), finding({ id: "f2", rule_id: "r2" }), finding({ id: "f3", rule_id: "r3" }), finding({ id: "f4", rule_id: "gone" })]);
    r.rules.push({ id: "r2", name: "secret_read_then_egress", title: "Same name", level: "low", tags: ["attack.t1552"], lane: "hunt" },
      { id: "r3", title: "Untitled twin", level: "low", tags: ["attack.t1552"], lane: "hunt" });
    const layer = JSON.parse(toAttackLayer(r));
    expect(layer.techniques.map((t: { techniqueID: string; score: number; comment: string }) => [t.techniqueID, t.score, t.comment])).toEqual([
      ["T1041", 1, "secret_read_then_egress (1)"], ["T1552", 2, "Untitled twin (1), secret_read_then_egress (1)"],
      ["T1552.001", 1, "secret_read_then_egress (1)"]]);
    expect(layer.layout).toMatchObject({ showAggregateScores: true, aggregateFunction: "sum" });
    expect(layer.description).toContain("1 findings come from rules with no ATT&CK technique"); // the finding whose rule is gone
  });

  test("no findings is still a valid layer (maxValue above minValue); rule names are masked", () => {
    const empty = JSON.parse(toAttackLayer(report([])));
    expect(empty).toMatchObject({ techniques: [], gradient: { maxValue: 1 } });
    expect(empty.description).not.toContain("no ATT&CK technique");
    const r = report();
    r.rules[0]!.name = `rule ${TOKEN}`;
    expect(toAttackLayer(r)).not.toContain(TOKEN);
  });
});

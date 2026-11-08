import { describe, expect, test } from "bun:test";
import { toJson } from "../../src/outputs/json.ts";
import { toTable } from "../../src/outputs/table.ts";
import type { ScanReport } from "../../src/outputs/report.ts";
import type { AgentEvent, Finding } from "../../src/normalize/types.ts";

// Defanged: placeholder token built by concatenation so no secret-shaped literal lands in the repo.
const TOKEN = "gh" + "p_" + "A1b2C3d4E5".repeat(4);
const FP = "0123456789abcdef";

const ev = (o: Partial<AgentEvent> = {}): AgentEvent => ({
  id: "e1", schema_version: "0.1", agent: "claude_code", session_id: "aaaaaaaa-1111", ts: "2026-09-14T10:00:00Z",
  seq: 1, category: "process_creation", project_path: "/work/acme/api", raw_ref: { file: "x.jsonl", line: 1 }, ...o,
});
const finding = (o: Partial<Finding> = {}): Finding => ({
  id: "f1", rule_id: "r1", level: "high", ts: "2026-09-14T10:00:00Z", session_id: "aaaaaaaa-1111",
  message: "curl https://example.invalid", events: [ev()], ...o,
});
const report = (o: Partial<ScanReport> = {}, findings: Finding[] = [finding()]): ScanReport => ({
  schema: "retrohound.scan/0.1", tool: { name: "retrohound", version: "0.1.0" },
  scan: {
    started_at: "2026-11-07T10:00:00Z", finished_at: "2026-11-07T10:00:03Z", sessions: 1284, events: 1000, blocked: 3,
    subagent_events: 250, files: { indexed: 1, skipped: 0, gone: 0, failed: 0 }, archived_sessions: ["z"], root: "/home/u/.claude/projects",
  },
  rules: [{ id: "r1", name: "secret_read_then_egress", title: "T", level: "high", tags: ["attack.t1552.001"], lane: "hunt" }],
  findings, ...o,
});

describe("toJson", () => {
  test("masks a planted secret in message and event strings", () => {
    const f = finding({ message: `token ${TOKEN}`, events: [ev({ command_line: `echo ${TOKEN}`, text_excerpt: TOKEN })] });
    const out = toJson(report({}, [f]));
    expect(out).not.toContain(TOKEN);
    expect(out).toContain("ghp_…[masked]");
    expect(JSON.parse(out).schema).toBe("retrohound.scan/0.1");
  });
  test("strips match-only fields from events", () => {
    const e = { ...ev(), content: "C0NTENT", tool_input: "T1NPUT", tool_response: "T2ESP", text: "TEXT0" };
    const out = toJson(report({}, [finding({ events: [e as AgentEvent] })]));
    for (const w of ["C0NTENT", "T1NPUT", "T2ESP", "TEXT0"]) expect(out).not.toContain(w);
  });
});

describe("toTable", () => {
  test("header, summary, finding line, footer, rotate list", () => {
    const f = finding({ events: [ev({ secret_fps: [FP], secret_kinds: ["github_token"] })] });
    const out = toTable(report({}, [f]), { color: false });
    expect(out).toContain("Indexed 1,284 sessions · 1,000 events in 3.0s");
    expect(out).toContain("3 blocked · 25% of events from sub-agents · 1 archived sessions");
    expect(out).toMatch(/HIGH\s+secret_read_then_egress\s+aaaaaaaa\s+2026-09-14\s+\/work\/acme\/api\s+attack\.t1552\.001\s+\[main\]/);
    expect(out).toContain(`${FP}  github_token  1 session(s)`);
    expect(out).toContain("1 high   →  retrohound show aaaaaaaa");
  });
  test("collapses one rule across sessions and attributes sub-agents", () => {
    const fs = [1, 2, 3, 4].map((i) => finding({ id: `f${i}`, session_id: `s${i}`, events: [ev({ agent_id: i === 1 ? "agentxyz99" : undefined })] }));
    const out = toTable(report({}, fs), { color: false });
    expect(out).toContain("4 sessions  [sub-agent agentxyz+main]");
    expect(out.match(/secret_read_then_egress/g)).toHaveLength(1);
  });
  test("long rule names keep a gap, and many sub-agents are counted, not listed", () => {
    const fs = [1, 2, 3, 4].map((i) => finding({ id: `f${i}`, rule_id: "r2", session_id: `s${i}`, events: [ev({ agent_id: i > 1 ? `agent${i}xxxx` : undefined })] }));
    const rules = [{ id: "r2", name: "control_plane_agent_config_risky_write", title: "T", level: "high" as const, tags: [], lane: "hunt" as const }];
    const out = toTable(report({ rules }, fs), { color: false });
    expect(out).toContain("control_plane_agent_config_risky_write  4 sessions  [main+3 sub-agents]");
  });
  test("empty state", () => {
    const out = toTable(report({ scan: { ...report().scan, sessions: 0 } }, []), { color: false });
    expect(out).toBe("No Claude Code sessions found at /home/u/.claude/projects\n");
  });
  test("skipped lines: one summary line when any, none when zero", () => {
    const lines = { malformed: 2, unknown_types: { "future-type": 3, other: 1 } };
    expect(toTable(report({ scan: { ...report().scan, lines } }), { color: false })).toContain("skipped lines: 2 malformed · 4 of unknown type (future-type 3, other 1)");
    const zero = { malformed: 0, unknown_types: {} };
    expect(toTable(report({ scan: { ...report().scan, lines: zero } }), { color: false })).not.toContain("skipped lines");
  });
  test("no ANSI when color is false, ANSI when true", () => {
    expect(toTable(report(), { color: false })).not.toContain("\x1b[");
    expect(toTable(report(), { color: true })).toContain("\x1b[");
  });
  test("masks a planted secret", () => {
    const f = finding({ events: [ev({ project_path: `/w/${TOKEN}` })] });
    expect(toTable(report({}, [f]), { color: false })).not.toContain(TOKEN);
  });
});

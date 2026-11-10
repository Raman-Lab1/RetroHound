// collectFootprint over an index built by a real scan of hand-written defanged transcripts (as tests/incident does).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRuleDir } from "../../src/cli/rules.ts";
import { collectFootprint, riskOrder, top } from "../../src/footprint/data.ts";
import type { Footprint } from "../../src/footprint/types.ts";
import { runScan } from "../../src/scan.ts";
import { openReadOnly } from "../../src/store/index.ts";
import { MIGRATIONS, migrate } from "../../src/store/schema.ts";
import { open } from "../../src/store/sqlite.ts";
import { TOOL_VERSION } from "../../src/version.ts";

const base = mkdtempSync(join(tmpdir(), "rh-footprint-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const KEY = "AKIA" + "ABCDEFGHIJKLMNOP"; // placeholder in the AWS key shape, split so no file holds it whole
const A = "2222aaaa-0000-4000-8000-000000000001";
const B = "2222bbbb-0000-4000-8000-000000000002";
const HIT = `title: Hit command
id: 0b6c7a52-0000-4000-8000-00000000a11d
name: hit
level: high
logsource: { product: ai_coding_agent }
detection:
    selection: { command_line|contains: hitcmd }
    condition: selection
`;

const ts = (n: number, day = 7) => `2026-11-0${day}T10:00:${String(n).padStart(2, "0")}.000Z`;
const common = (sid: string, n: number, day?: number) => ({ uuid: `${sid}-${n}`, sessionId: sid, timestamp: ts(n, day), cwd: "/home/x/acme" });
const use = (sid: string, n: number, id: string, name: string, input: object, extra = {}) =>
  ({ type: "assistant", ...common(sid, n), message: { content: [{ type: "tool_use", id, name, input }] }, ...extra });
const result = (sid: string, n: number, id: string, extra = {}) =>
  ({ type: "user", ...common(sid, n), message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] }, ...extra });

const dir = join(base, "data");
const proj = join(dir, "claude", "projects", "-home-x-acme");
const db = join(dir, "index.db");
const rules = join(dir, "rules");
const scan = () => runScan({ root: join(dir, "claude"), dbPath: db, rulesDir: rules });
const now = new Date("2026-11-10T00:00:00.000Z");
const collect = (path = db): Footprint => {
  const index = openReadOnly(path);
  try {
    return collectFootprint(index, { rules: loadRuleDir(rules).rules, retentionDays: 30, now });
  } finally {
    index.close();
  }
};

beforeAll(async () => {
  mkdirSync(rules, { recursive: true });
  writeFileSync(join(rules, "hit.yml"), HIT);
  mkdirSync(proj, { recursive: true });
  const lines = [
    { type: "permission-mode", permissionMode: "auto", sessionId: A },
    use(A, 1, "t1", "Bash", { command: "hitcmd https://example.invalid/x" }),
    result(A, 2, "t1", { toolDenialKind: "permission-rule" }),
    use(A, 3, "t2", "Bash", { command: `aws s3 ls --access-key ${KEY}` }),
    result(A, 4, "t2"),
    use(A, 5, "t3", "Agent", { prompt: "look around" }),
    result(A, 6, "t3", { toolUseResult: { agentId: "a1" } }),
    use(A, 7, "t4", "Bash", { command: "ls" }, { agentId: "a1" }),
    use(A, 8, "t5", "mcp__srv__lookup", { q: "docs" }, { attributionMcpServer: "srv" }),
    { type: "attachment", ...common(A, 9), attachment: { type: "hook_success", hookEvent: "PreToolUse", command: "node hook.js", exitCode: 0 } },
  ];
  writeFileSync(join(proj, `${A}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const b = { ...use(B, 1, "t9", "Bash", { command: "hitcmd" }), ...common(B, 1, 8), cwd: "/home/x/other" };
  writeFileSync(join(proj, `${B}.jsonl`), JSON.stringify(b) + "\n");
  await scan();
});

describe("collectFootprint", () => {
  test("fills totals, trust, the agent tree with sub-agents, tools, modes, blocks, findings and activity", () => {
    const fp = collect();
    expect(fp.generated_at).toBe(now.toISOString());
    expect(fp.tool_version).toBe(TOOL_VERSION);
    expect(fp.trust).toMatchObject({ chain: { entries: expect.any(Number), head: expect.stringMatching(/^[0-9a-f]{64}$/) }, files: { indexed: 2, gone: 0 }, archived_sessions: 0, retention_days: 30 });
    expect([fp.trust.first_ts, fp.trust.last_ts]).toEqual([ts(1), ts(1, 8)]);
    expect(fp.totals).toMatchObject({ agents: 1, projects: 2, sessions: 2, sub_agent_events: 1, blocked: 1, secrets: 1 });
    expect(fp.totals.findings).toEqual({ informational: 0, low: 0, medium: 0, high: 2, critical: 0 });

    const [agent] = fp.agents;
    expect(agent!.agent).toBe("claude_code");
    expect(agent!.events).toBe(fp.totals.events);
    const acme = agent!.projects.find((p) => p.project === "/home/x/acme")!;
    expect(acme).toMatchObject({ sessions: 1, blocked: 1, findings: 1, worst: "high" });
    expect(acme.list.map((s) => [s.session_id, s.archived, s.sub_agents])).toEqual([[A, false, [{ agent_id: "a1", events: 1, blocked: 0 }]]]);

    expect(fp.tools.mcp_servers.map((s) => [s.name, s.events, s.sessions])).toEqual([["srv", 1, 1]]);
    expect(fp.tools.attributions.map((s) => s.name)).toEqual(["mcp:srv"]);
    expect(fp.tools.hooks.map((s) => [s.name, s.detail, s.events])).toEqual([["node hook.js", "hook:PreToolUse", 1]]);
    expect(fp.domains.map((d) => [d.name, d.blocked, d.sub_agent])).toEqual([["example.invalid", 1, 0]]);
    expect(fp.modes.map((m) => [m.mode, m.sessions])).toEqual([["auto", 1], ["-", 1]]);
    expect(fp.modes[0]!.sub_agent).toBe(1);
    expect(fp.blocked).toEqual({ kinds: [{ name: "permission-rule", count: 1 }], categories: [] });

    expect(fp.findings.map((f) => [f.rule, f.level, f.session_id, f.project])).toEqual([["hit", "high", B, "/home/x/other"], ["hit", "high", A, "/home/x/acme"]]);
    expect(fp.findings[0]!.agent_id).toBeUndefined();
    expect(fp.activity).toEqual([
      { day: "2026-11-07", events: fp.totals.events - 1, blocked: 1, findings: 1 },
      { day: "2026-11-08", events: 1, blocked: 0, findings: 1 },
    ]);
    expect(fp.omitted).toEqual({ sessions: 0, findings: 0, domains: 0, secrets: 0, tools: 0 });
  });

  test("a secret is reported by fingerprint, never by value", () => {
    const fp = collect();
    expect(fp.secrets.map((s) => [s.kinds, s.sessions, s.sub_agents, s.projects, s.domains])).toEqual([
      [["aws_access_key"], 1, 0, ["/home/x/acme"], ["example.invalid"]],
    ]);
    const json = JSON.stringify(fp);
    expect(fp.secrets[0]!.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(json).toContain(fp.secrets[0]!.fingerprint);
    expect(json).not.toContain(KEY);
  });

  test("sessions are kept riskiest first and the cut ones are counted", () => {
    const s = (session_id: string, findings: number, last_ts: string, worst?: "low" | "high") => ({ session_id, findings, last_ts, worst });
    const [kept, omitted] = top([s("a", 0, ts(9)), s("b", 3, ts(1), "low"), s("c", 1, ts(2), "high"), s("d", 3, ts(5), "low")], 3, riskOrder);
    expect(kept.map((x) => x.session_id)).toEqual(["c", "d", "b"]);
    expect(omitted).toBe(1);
  });

  test("a deleted transcript leaves an archived session", async () => {
    rmSync(join(proj, `${B}.jsonl`));
    await scan();
    const fp = collect();
    expect(fp.trust).toMatchObject({ files: { indexed: 2, gone: 1 }, archived_sessions: 1 });
    expect(fp.totals.sessions).toBe(2);
  });

  test("an index from before the chain has a null chain, and an empty one has zero counts", () => {
    const path = join(base, "old.db");
    const old = open(path);
    migrate(old, MIGRATIONS.slice(0, 2));
    old.close();
    const fp = collect(path);
    expect(fp.trust.chain).toBeNull();
    expect(fp.trust.first_ts).toBeUndefined();
    expect(fp.totals).toMatchObject({ agents: 0, sessions: 0, events: 0, blocked: 0, secrets: 0 });
    expect(fp.agents).toEqual([]);
  });
});

describe("compareConfig", () => {
  const item = (kind: "mcp_server" | "hook", name: string, agent = "claude_code", scope = "user", source = "/home/x/.claude.json") =>
    ({ agent, kind, name, scope, source });
  const configured = (config: Parameters<typeof collectFootprint>[1]["config"]) => {
    const index = openReadOnly(db);
    try {
      return collectFootprint(index, { rules: [], now, config }).configured;
    } finally {
      index.close();
    }
  };

  test("each configured item with its use, never-seen ones at 0, and nothing unlisted when all is configured", () => {
    const c = configured([{ items: [item("mcp_server", "idle"), item("mcp_server", "srv"), item("hook", "node hook.js"), item("mcp_server", "srv", "codex"),
      item("hook", "x.sh", "codex"), item("mcp_server", "srv", "claude_code", "project", "/home/x/acme/.mcp.json")], files: 2,
      skipped: [{ path: "/home/x/.claude.json", reason: "larger than 1048576 bytes" }] }])!;
    expect(c.items.map((i) => [i.agent, i.kind, i.name, i.events, i.observable])).toEqual([["claude_code", "hook", "node hook.js", 1, true],
      ["claude_code", "mcp_server", "srv", 1, true], ["claude_code", "mcp_server", "idle", 0, true], ["codex", "hook", "x.sh", 0, false], ["codex", "mcp_server", "srv", 0, true]]);
    expect(c.items[2]!.last_ts).toBeUndefined();
    expect(c.items[1]).toMatchObject({ scopes: ["project", "user"], files: 2, source: "/home/x/.claude.json" }); // one row, two scopes
    expect(c.unlisted).toEqual([]);
    expect(c).toMatchObject({ files: 2, skipped: 1 });
  });

  test("a plugin counts the calls of its own skills, which the transcript names first", async () => {
    const d = join(base, "plugin");
    const sid = "3333aaaa-0000-4000-8000-000000000003";
    mkdirSync(join(d, "claude", "projects", "-home-x-kit"), { recursive: true });
    const line = use(sid, 1, "k1", "Read", { file_path: "/home/x/kit/README.md" }, { attributionSkill: "kit:review", attributionPlugin: "kit" });
    writeFileSync(join(d, "claude", "projects", "-home-x-kit", `${sid}.jsonl`), JSON.stringify(line) + "\n");
    const path = join(d, "index.db");
    await runScan({ root: join(d, "claude"), dbPath: path, rulesDir: rules });
    const index = openReadOnly(path);
    try {
      const plugin = { agent: "claude_code", kind: "plugin" as const, name: "kit", scope: "user", source: "/home/x/.claude/settings.json" };
      const c = collectFootprint(index, { rules: [], now, config: [{ items: [plugin], files: 1, skipped: [] }] }).configured!;
      expect(c.items[0]).toMatchObject({ name: "kit", events: 1, observable: true });
    } finally {
      index.close();
    }
  });

  test("used but configured nowhere is listed; no config read leaves the section out", () => {
    expect(configured([])!.unlisted.map((u) => [u.agent, u.kind, u.name, u.events])).toEqual([["claude_code", "hook", "node hook.js", 1], ["claude_code", "mcp_server", "srv", 1]]);
    expect(collect().configured).toBeUndefined();
  });
});

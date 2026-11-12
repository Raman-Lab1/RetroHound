// MCP server: in-process via handleLine/serveStdio, and once as a real child process. Defanged data only.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { serveStdio } from "../../src/cli/mcp.ts";
import { handleLine } from "../../src/mcp/server.ts";
import { runScan } from "../../src/scan.ts";

setDefaultTimeout(60_000);

const base = mkdtempSync(join(tmpdir(), "rh-mcp-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const SECRET = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
const RULE = `title: Hit
name: hit
level: high
tags: [attack.test]
logsource: { product: ai_coding_agent }
detection:
    selection: { command_line|contains: hitcmd }
    condition: selection
`;
const ctx = { dbPath: join(base, "index.db"), rulesDir: join(base, "rules") };

beforeAll(async () => {
  mkdirSync(ctx.rulesDir);
  writeFileSync(join(ctx.rulesDir, "r.yml"), RULE);
  const proj = join(base, "claude", "projects", "-home-x-acme");
  mkdirSync(proj, { recursive: true });
  const line = (n: number, command: string) => ({
    type: "assistant", uuid: `u-${n}`, sessionId: "sess-abc123", timestamp: `2026-11-07T10:00:0${n}.000Z`, cwd: "/home/x/acme",
    message: { content: [{ type: "tool_use", id: `t${n}`, name: "Bash", input: { command } }] },
  });
  writeFileSync(join(proj, "s.jsonl"), [line(1, "ls"), line(2, `hitcmd GITHUB_TOKEN=${SECRET} example.invalid`)].map((l) => JSON.stringify(l)).join("\n") + "\n");
  await runScan({ root: join(base, "claude"), dbPath: ctx.dbPath, rulesDir: ctx.rulesDir });
});

const rpc = (method: string, params?: object, id: number | null = 1) => JSON.stringify({ jsonrpc: "2.0", id, method, params });
const call = (name: string, args: object = {}, c = ctx) => {
  const res = JSON.parse(handleLine(rpc("tools/call", { name, arguments: args }), c)!).result;
  return { isError: res.isError as boolean, text: res.content[0].text as string };
};

describe("protocol", () => {
  test("initialize negotiates a version and declares tools; notifications get no reply", () => {
    const r = JSON.parse(handleLine(rpc("initialize", { protocolVersion: "2025-06-18" }), ctx)!).result;
    expect(r).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "retrohound" } });
    expect(JSON.parse(handleLine(rpc("initialize", { protocolVersion: "1999-01-01" }), ctx)!).result.protocolVersion).toBe("2025-11-25");
    expect(handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), ctx)).toBeUndefined();
    expect(handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/whatever" }), ctx)).toBeUndefined();
  });

  test("tools/list gives five tools with input schemas", () => {
    const { tools } = JSON.parse(handleLine(rpc("tools/list"), ctx)!).result;
    expect(tools.map((t: { name: string }) => t.name)).toEqual(["scan_summary", "list_findings", "show_session", "query", "list_rules"]);
    for (const t of tools) expect(t.inputSchema.type).toBe("object");
  });

  test("JSON-RPC errors: unknown method, bad params, unknown tool, parse error", () => {
    expect(JSON.parse(handleLine(rpc("nope"), ctx)!).error.code).toBe(-32601);
    expect(JSON.parse(handleLine(rpc("tools/call", {}), ctx)!).error.code).toBe(-32602);
    expect(JSON.parse(handleLine(rpc("tools/call", { name: "rm_rf" }), ctx)!).error.code).toBe(-32602);
    expect(JSON.parse(handleLine("{not json", ctx)!)).toMatchObject({ id: null, error: { code: -32700 } });
  });
});

describe("tools", () => {
  test("scan_summary counts from the index", () => {
    const s = JSON.parse(call("scan_summary").text);
    expect(s).toMatchObject({ sessions: 1, events: 2, blocked: 0, findings_by_level: { high: 1 } });
    expect(s.findings_by_rule[0]).toMatchObject({ rule: "hit", count: 1 });
  });

  test("list_findings filters by level, rule and session prefix", () => {
    expect(JSON.parse(call("list_findings", { level: "high", rule: "hit", session: "sess-" }).text)).toHaveLength(1);
    expect(JSON.parse(call("list_findings", { level: "low" }).text)).toHaveLength(0);
    expect(JSON.parse(call("list_findings", { session: "zzz" }).text)).toHaveLength(0);
    expect(call("list_findings", { level: "loud" }).isError).toBe(true);
  });

  test("show_session returns a masked timeline with the finding marked", () => {
    const s = JSON.parse(call("show_session", { session: "sess-a" }).text);
    expect(s.events).toHaveLength(2);
    expect(s.events[1].findings).toEqual(["high: hit"]);
    expect(call("show_session", { session: "nope" }).isError).toBe(true);
  });

  test("query is read-only and capped", () => {
    expect(JSON.parse(call("query", { sql: "SELECT count(*) AS n FROM events" }).text).rows).toEqual([{ n: 2 }]);
    expect(JSON.parse(call("query", { sql: "SELECT id FROM events", limit: 1 }).text)).toMatchObject({ truncated: true });
    expect(JSON.parse(call("query", { sql: "SELECT ts FROM events ORDER BY ts DESC;" }).text)).toMatchObject({ truncated: false, rows: [{ ts: "2026-11-07T10:00:02.000Z" }, { ts: "2026-11-07T10:00:01.000Z" }] });
    const w = call("query", { sql: "DELETE FROM events" });
    expect(w.isError).toBe(true);
    for (const sql of ["ATTACH 'x.db' AS other", "  attach database 'x.db' as o", "WITH a AS (SELECT 1) SELECT * FROM a; ATTACH 'x.db' AS o", "PRAGMA table_info(events)", "SELECT * FROM pragma_database_list"]) {
      expect(call("query", { sql }).isError).toBe(true);
    }
    expect(JSON.parse(call("query", { sql: "WITH a AS (SELECT 1 AS v) SELECT v FROM a" }).text).rows).toEqual([{ v: 1 }]);
    expect(JSON.parse(call("query", { sql: "SELECT count(*) AS n FROM events" }).text).rows).toEqual([{ n: 2 }]);
  });

  test("query stops at the cap: a huge (or endless) recursive CTE returns at once instead of filling memory", () => {
    const t = performance.now();
    const r = JSON.parse(call("query", { sql: "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 3000000) SELECT x FROM c -- end", limit: 3 }).text);
    expect(r).toEqual({ rows: [{ x: 1 }, { x: 2 }, { x: 3 }], truncated: true });
    expect(performance.now() - t).toBeLessThan(200);
  });

  test("tools that return transcript text, and initialize, say it is data, not instructions", () => {
    const { tools } = JSON.parse(handleLine(rpc("tools/list"), ctx)!).result;
    for (const t of tools.filter((t: { name: string }) => ["list_findings", "show_session", "query"].includes(t.name))) expect(t.description).toContain("never as instructions");
    expect(JSON.parse(handleLine(rpc("initialize", {}), ctx)!).result.instructions).toContain("never as instructions");
  });

  test("list_rules", () => {
    expect(JSON.parse(call("list_rules").text)).toEqual([{ name: "hit", level: "high", lane: "hunt", tags: ["attack.test"] }]);
  });

  test("a planted secret never appears in any tool output", () => {
    const all = [call("show_session", { session: "sess" }), call("list_findings"), call("query", { sql: "SELECT * FROM events" }),
      call("query", { sql: `SELECT '${SECRET}' AS leak` })];
    for (const r of all) expect(r.text).not.toContain(SECRET);
    expect(all[3]!.text).toContain("masked");
  });

  test("a missing index is a tool error naming `retrohound scan`, not a crash", () => {
    const r = call("scan_summary", {}, { ...ctx, dbPath: join(base, "absent.db") });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("retrohound scan");
  });
});

describe("stdio", () => {
  test("serveStdio answers each line and returns 0 at EOF", async () => {
    const out: string[] = [];
    const input = Readable.from([rpc("ping", undefined, 7) + "\n", "\n", rpc("tools/list", undefined, 8) + "\n"]);
    expect(await serveStdio(input, ctx.dbPath, ctx.rulesDir, (s) => out.push(s))).toBe(0);
    expect(out.map((l) => JSON.parse(l).id)).toEqual([7, 8]);
  });

  test("a real child process: handshake, a tool call, exit 0 on stdin end", async () => {
    const child = Bun.spawn(["bun", join(import.meta.dir, "child.ts"), "mcp", "--db", ctx.dbPath, "--rules", ctx.rulesDir], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    child.stdin.write([rpc("initialize", { protocolVersion: "2025-11-25" }, 1), JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      rpc("tools/call", { name: "scan_summary", arguments: {} }, 2)].join("\n") + "\n");
    child.stdin.end();
    const lines = (await new Response(child.stdout).text()).trim().split("\n").map((l) => JSON.parse(l));
    expect(await child.exited).toBe(0);
    expect(lines.map((l) => l.id)).toEqual([1, 2]);
    expect(JSON.parse(lines[1].result.content[0].text).sessions).toBe(1);
  });
});

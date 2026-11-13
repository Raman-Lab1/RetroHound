// scan pipeline over temp dirs and hand-written transcripts. Defanged: example.invalid, placeholder values only.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { COLLECTORS } from "../src/collectors/index.ts";
import { toJson } from "../src/outputs/json.ts";
import { toSarif } from "../src/outputs/sarif.ts";
import { toTable } from "../src/outputs/table.ts";
import { runScan, type ScanOptions } from "../src/scan.ts";
import { verifyChain } from "../src/store/chain.ts";
import { openReadOnly } from "../src/store/index.ts";
import { open } from "../src/store/sqlite.ts";

const base = mkdtempSync(join(tmpdir(), "rh-scan-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const RULE = (min: number) => `title: Many hits
name: many
level: medium
correlation:
    type: event_count
    rules: [hit]
    group-by: [session_id, agent_id]
    timespan: 10m
    condition: { gte: ${min} }
`;
const HIT = `title: Hit
name: hit
logsource: { product: ai_coding_agent }
detection:
    selection: { command_line|contains: hitcmd }
    condition: selection
---
`;

let n = 0;
const cmd = (sid: string, second: number, extra: object = {}) => ({
  type: "assistant", uuid: `u-${++n}`, sessionId: sid, timestamp: `2026-11-07T10:00:${String(second).padStart(2, "0")}.000Z`,
  cwd: "/home/x/acme", message: { content: [{ type: "tool_use", id: `t${n}`, name: "Bash", input: { command: `hitcmd ${n}` } }] }, ...extra,
});
const put = (path: string, lines: object[]) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
};

let dir: string;
let root: string;
let opts: ScanOptions;
beforeEach(() => {
  dir = mkdtempSync(join(base, "case-"));
  root = join(dir, "claude");
  mkdirSync(join(dir, "rules"));
  writeFileSync(join(dir, "rules", "r.yml"), HIT + RULE(3));
  opts = { root, dbPath: join(dir, "index.db"), rulesDir: join(dir, "rules") };
  // One session in three files: the main stream is split over a transcript and an orphaned part (2 hits each, so 4
  // together reach 3 and neither alone does), plus a sub-agent stream of its own (correlations never span streams, 0004).
  const proj = join(root, "projects", "-home-x-acme");
  put(join(proj, "s1.jsonl"), [cmd("s1", 1), cmd("s1", 2)]);
  put(join(proj, "s1.orphaned-1.jsonl"), [cmd("s1", 5), cmd("s1", 6)]);
  put(join(proj, "s1", "subagents", "agent-a1.jsonl"), [cmd("s1", 3, { agentId: "a1" }), cmd("s1", 4, { agentId: "a1" })]);
});

describe("runScan", () => {
  test("a two-file session fires an event_count correlation once, and the report counts add up", async () => {
    const r = await runScan(opts);
    expect(r.schema).toBe("retrohound.scan/0.1");
    expect(r.findings.map((f) => f.rule_id)).toEqual(["many"]);
    expect(r.rules.map((x) => x.id)).toEqual(["many"]);
    expect(r.scan).toMatchObject({ sessions: 1, events: 6, subagent_events: 2, blocked: 0, archived_sessions: [] });
    expect("blocked_breakdown" in r.scan).toBe(false); // additive: absent when nothing was blocked
    expect(r.scan.files).toEqual({ indexed: 3, skipped: 0, gone: 0, failed: 0 });
    expect(r.findings[0]!.events.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(r)).not.toContain("tool_input"); // match-only fields never leave the parser
  });

  test("blocked events are broken down by kind, scope, category, attribution and project, the same from the index", async () => {
    const denied = (second: number, kind: string, extra: object = {}, result: object = {}) => {
      const use = cmd("s2", second, extra);
      const id = use.message.content[0]!.id;
      const tool_result = { type: "tool_result", tool_use_id: id, content: "no", is_error: true };
      return [use, { ...use, type: "user", uuid: `u-${++n}`, toolDenialKind: kind, ...result, message: { content: [tool_result] } }];
    };
    const proj = join(root, "projects", "-home-x-acme");
    put(join(proj, "s2.jsonl"), [
      ...denied(10, "permission-rule", { attributionSkill: "deploy" }),
      ...denied(11, "automode-blocked", {}, { permissionDecision: { decision: "reject", classifierCategory: "credential_materialization" } }),
      ...denied(12, "user-rejected"),
    ]);
    put(join(proj, "s2", "subagents", "agent-b1.jsonl"), denied(13, "permission-rule", { agentId: "b1" }));
    const want = {
      kinds: { "permission-rule": { main: 1, sub_agent: 1 }, "automode-blocked": { main: 1, sub_agent: 0 }, "user-rejected": { main: 1, sub_agent: 0 } },
      categories: { credential_materialization: 1 },
      attributions: { "skill:deploy": 1 },
      top_projects: [{ project_path: "/home/x/acme", blocked: 4 }],
    };
    const indexed = await runScan(opts);
    expect(indexed.scan.blocked).toBe(4);
    expect(indexed.scan.blocked_breakdown).toEqual(want);
    expect(JSON.parse(toJson(indexed)).scan.blocked_breakdown).toEqual(want);
    expect((await runScan({ ...opts, noIndex: true })).scan.blocked_breakdown).toEqual(want);
    expect(toTable(indexed, { color: false })).toContain([
      "    by kind: permission-rule 2 (1 sub-agent) · automode-blocked 1 · user-rejected 1",
      "    by category: credential_materialization 1",
      "    by attribution: skill:deploy 1",
      "    top projects: /home/x/acme 4\n",
    ].join("\n"));
    expect("blocked_breakdown" in (await runScan({ ...opts, project: "elsewhere" })).scan).toBe(false);
  });

  test("a warm re-scan skips every file and returns the same findings from the DB", async () => {
    const first = await runScan(opts);
    const warm = await runScan(opts);
    expect(warm.scan.files).toEqual({ indexed: 0, skipped: 3, gone: 0, failed: 0 });
    expect(warm.findings).toEqual(first.findings);
  });

  test("a changed file re-evaluates its whole session", async () => {
    await runScan(opts);
    appendFileSync(join(root, "projects", "-home-x-acme", "s1.jsonl"), JSON.stringify(cmd("s1", 5)) + "\n");
    const r = await runScan(opts);
    expect(r.scan.files).toMatchObject({ indexed: 1, skipped: 2 });
    expect(r.findings.length).toBe(1);
    expect(r.scan.events).toBe(7);
  });

  test("a changed rule set re-evaluates untouched files, and a rule that stopped firing leaves no stale finding", async () => {
    expect((await runScan(opts)).findings.length).toBe(1);
    writeFileSync(join(dir, "rules", "r.yml"), HIT + RULE(9));
    const r = await runScan(opts);
    expect(r.scan.files.skipped).toBe(3);
    expect(r.findings).toEqual([]);
  });

  test("a session split over groups (legacy flat agent-*.jsonl) is re-read whole when one of its files changes", async () => {
    // "many" fires on the main file's hits, "sub" on the sub-agent file's: each finding needs the other group re-read.
    writeFileSync(join(dir, "rules", "sub.yml"), "title: Sub\nname: sub\nlevel: low\nlogsource: { product: ai_coding_agent }\n"
      + "detection:\n    selection: { agent_id: b1 }\n    condition: selection\n");
    const proj = join(root, "projects", "-home-x-acme");
    put(join(proj, "s3.jsonl"), [cmd("s3", 1), cmd("s3", 2), cmd("s3", 3)]);
    put(join(proj, "agent-b1.jsonl"), [cmd("s3", 11, { agentId: "b1" })]);
    const s3 = (r: Awaited<ReturnType<typeof runScan>>) => [...new Set(r.findings.filter((f) => f.session_id === "s3").map((f) => f.rule_id))].sort();
    expect(s3(await runScan(opts))).toEqual(["many", "sub"]);
    appendFileSync(join(proj, "agent-b1.jsonl"), JSON.stringify(cmd("s3", 20, { agentId: "b1" })) + "\n");
    expect(s3(await runScan(opts))).toEqual(["many", "sub"]);
    appendFileSync(join(proj, "s3.jsonl"), JSON.stringify(cmd("s3", 21)) + "\n");
    const r = await runScan(opts);
    expect(r.scan.files).toMatchObject({ indexed: 1 });
    expect(s3(r)).toEqual(["many", "sub"]);
  });

  test("a scan of another root under new rules does not mark this root's findings current (0006)", async () => {
    const other = { ...opts, root: join(dir, "other") };
    put(join(other.root, "projects", "-home-x-b", "s9.jsonl"), [cmd("s9", 1)]);
    expect((await runScan(opts)).findings.length).toBe(1);
    writeFileSync(join(dir, "rules", "r.yml"), HIT + RULE(9));
    await runScan(other);
    expect((await runScan(opts)).findings).toEqual([]);
  });

  test("an index from before run scopes re-evaluates once after the upgrade, and its chain verifies", async () => {
    writeFileSync(join(dir, "rules", "r.yml"), HIT + RULE(9));
    await runScan({ ...opts, root: join(dir, "empty") });
    writeFileSync(join(dir, "rules", "r.yml"), HIT + RULE(3));
    expect((await runScan(opts)).findings.length).toBe(1);
    // The v4 shape, its last run under RULE(9): the state a scan of another root left behind before this fix.
    const db = open(opts.dbPath!);
    db.exec(`UPDATE rule_runs SET rule_set_hash = (SELECT rule_set_hash FROM rule_runs ORDER BY id LIMIT 1);
      ALTER TABLE rule_runs DROP COLUMN scope; PRAGMA user_version = 4`);
    db.close();
    writeFileSync(join(dir, "rules", "r.yml"), HIT + RULE(9));
    expect((await runScan(opts)).findings).toEqual([]);
    const ro = openReadOnly(opts.dbPath!);
    expect(verifyChain(ro).ok).toBe(true);
    ro.close();
  });

  test("noIndex orders findings like the index, by (ts, id), in JSON and SARIF", async () => {
    put(join(root, "projects", "-home-x-acme", "a9.jsonl"), [cmd("a9", 40), cmd("a9", 41), cmd("a9", 42)]); // read before s1
    const mem = await runScan({ ...opts, noIndex: true });
    const idx = await runScan(opts);
    expect(mem.findings.map((f) => f.session_id)).toEqual(["s1", "a9"]);
    const jsonIds = (r: typeof mem) => JSON.parse(toJson(r)).findings.map((f: { id: string }) => f.id);
    const sarifIds = (r: typeof mem) => JSON.parse(toSarif(r)).runs[0].results.map((x: { partialFingerprints: Record<string, string> }) => x.partialFingerprints["retrohound/v1"]);
    expect(jsonIds(mem)).toEqual(jsonIds(idx));
    expect(sarifIds(mem)).toEqual(sarifIds(idx));
    expect(sarifIds(mem)).toEqual(jsonIds(mem));
  });

  test("noIndex evaluates everything and writes nothing", async () => {
    const r = await runScan({ ...opts, noIndex: true });
    expect(r.findings.length).toBe(1);
    expect(r.scan).toMatchObject({ sessions: 1, events: 6, subagent_events: 2 });
    expect(existsSync(opts.dbPath!)).toBe(false);
  });

  test("a vanished transcript leaves the session archived and its findings in place", async () => {
    await runScan(opts);
    rmSync(join(root, "projects"), { recursive: true });
    mkdirSync(join(root, "projects"));
    const r = await runScan(opts);
    expect(r.scan).toMatchObject({ sessions: 1, archived_sessions: ["s1"], files: { gone: 3 } });
    expect(r.findings.length).toBe(1);
  });

  test("level, project and since filters", async () => {
    expect((await runScan({ ...opts, level: "high" })).findings).toEqual([]);
    expect((await runScan({ ...opts, level: "low" })).findings.length).toBe(1);
    expect((await runScan({ ...opts, project: "other" })).scan.sessions).toBe(0);
    expect((await runScan({ ...opts, project: "ACME" })).scan.sessions).toBe(1);
    expect((await runScan({ ...opts, since: "2027-01-01" })).scan.sessions).toBe(0);
  });

  test("the stored hash is the sha256 of the file, taken from the parse read", async () => {
    await runScan(opts);
    const file = join(root, "projects", "-home-x-acme", "s1.jsonl");
    const db = openReadOnly(opts.dbPath!);
    const row = db.prepare("SELECT sha256 FROM files_indexed WHERE path LIKE '%/s1.jsonl'").get() as { sha256: string };
    db.close();
    expect(row.sha256).toBe(createHash("sha256").update(readFileSync(file)).digest("hex"));
  });

  test("the rule author reaches the report and SARIF (DRL 1.1 keeps it in output based on matches)", async () => {
    writeFileSync(join(dir, "rules", "r.yml"), HIT.replace("name: hit\n", "name: hit\nauthor: Example Author\n") + RULE(3).replace("name: many\n", "name: many\nauthor: Example Author\n"));
    const r = await runScan(opts);
    expect(r.rules.map((x) => x.author)).toEqual(["Example Author"]);
    expect(JSON.parse(toSarif(r)).runs[0].tool.driver.rules[0].properties.author).toBe("Example Author");
  });

  test("onRejected receives the rules the loader refused", async () => {
    writeFileSync(join(dir, "rules", "bad.yml"), "title: [unclosed\n");
    let rejected = -1;
    await runScan({ ...opts, onRejected: (r) => (rejected = r.length) });
    expect(rejected).toBe(1);
  });

  test("unknown line types and malformed lines are counted, not fatal; a warm run re-reads nothing", async () => {
    const extra = join(root, "projects", "-home-x-acme", "s2.jsonl");
    mkdirSync(dirname(extra), { recursive: true });
    writeFileSync(extra, [JSON.stringify(cmd("s2", 1)), JSON.stringify({ type: "future-type", sessionId: "s2" }), "{not json"].join("\n") + "\n");
    const want = { malformed: 1, unknown_types: { "future-type": 1 } };
    expect((await runScan({ ...opts, noIndex: true })).scan.lines).toEqual(want);
    const cold = await runScan(opts);
    expect(cold.scan.lines).toEqual(want);
    expect(cold.scan.sessions).toBe(2);
    expect((await runScan(opts)).scan.lines).toEqual({ malformed: 0, unknown_types: {} });
  });

  test("a missing rules dir or transcript root is an empty scan, not an error", async () => {
    const r = await runScan({ ...opts, rulesDir: join(dir, "nope"), root: join(dir, "nowhere") });
    expect(r.findings).toEqual([]);
    expect(r.scan.sessions).toBe(0);
  });
});

// --agent all: every collector at its default root, so the tests point each default root at a temp dir.
const CX = "11111111-1111-4111-8111-111111111111";
const AG = "00000000-0000-4000-8000-000000000001";
const cx = (k: number) => [
  { timestamp: "2026-11-07T10:00:00.000Z", type: "session_meta", payload: { id: CX, session_id: CX, cwd: "C:\\Users\\x\\proj", cli_version: "0.167.0" } },
  ...Array.from({ length: k }, (_, i) => ({
    timestamp: `2026-11-07T10:00:0${i + 1}.000Z`, type: "event_msg",
    payload: { type: "item_completed", thread_id: CX, item: { type: "CommandExecution", command: ["bash", "-lc", `hitcmd ${i}`], status: "completed", exit_code: 0 } },
  })),
];
const ag = (k: number) => Array.from({ length: k }, (_, i) => [
  { step_index: 2 * i, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-07T10:00:00Z", tool_calls: [{ name: "run_command", args: { CommandLine: `hitcmd ${i}` } }] },
  { step_index: 2 * i + 1, source: "MODEL", type: "GENERIC", status: "DONE", created_at: "2026-11-07T10:00:00Z", content: "Command exited with code 0." },
]).flat();

describe("runScan --agent all", () => {
  const saved = { ...COLLECTORS };
  let all: ScanOptions;
  beforeEach(() => {
    put(join(dir, "codex", "sessions", "2026", "11", "07", `rollout-2026-11-07T10-00-00-${CX}.jsonl`), cx(3));
    put(join(dir, "agy", "brain", AG, ".system_generated", "logs", "transcript_full.jsonl"), ag(3));
    const roots: Record<string, string> = { claude_code: root, codex: join(dir, "codex"), antigravity: join(dir, "agy") };
    for (const [k, c] of Object.entries(saved)) COLLECTORS[k] = { ...c, defaultRoot: () => roots[k] ?? join(dir, "none", k) };
    all = { ...opts, root: undefined, agent: "all" };
  });
  afterAll(() => Object.assign(COLLECTORS, saved));

  test("indexes every agent into one report; totals and per-agent counts add up", async () => {
    const r = await runScan(all);
    expect(r.scan.agents).toEqual({
      claude_code: { sessions: 1, events: 6, findings: 1 },
      codex: { sessions: 1, events: 3, findings: 1 },
      antigravity: { sessions: 1, events: 3, findings: 1 },
    });
    expect(r.scan).toMatchObject({ sessions: 3, events: 12, subagent_events: 2, files: { indexed: 5, skipped: 0, gone: 0, failed: 0 } });
    expect(new Set(r.findings.map((f) => f.events[0]!.agent))).toEqual(new Set(["claude_code", "codex", "antigravity"]));
    expect(toTable(r, { color: false })).toContain("codex        1 sessions · 3 events · 1 findings");
    expect((await runScan(all)).scan.files).toEqual({ indexed: 0, skipped: 5, gone: 0, failed: 0 });
  });

  test("a rule change re-evaluates every agent's untouched files", async () => {
    expect((await runScan(all)).findings.length).toBe(3);
    writeFileSync(join(dir, "rules", "r.yml"), HIT + RULE(9));
    const r = await runScan(all);
    expect(r.scan.files.skipped).toBe(5);
    expect(r.findings).toEqual([]);
  });

  test("a vanished agent's sessions are re-read from the index when the rules change", async () => {
    await runScan(all);
    rmSync(join(dir, "codex"), { recursive: true });
    appendFileSync(join(dir, "rules", "r.yml"), "# changed\n");
    const r = await runScan(all);
    expect(r.scan.archived_sessions).toEqual([CX]);
    expect(r.scan.agents!.codex).toEqual({ sessions: 1, events: 3, findings: 1 });
    expect(r.scan.files.gone).toBe(1);
  });

  test("noIndex works with all and writes nothing", async () => {
    const r = await runScan({ ...all, noIndex: true });
    expect(r.scan).toMatchObject({ sessions: 3, events: 12, files: { indexed: 5 } });
    expect(r.findings.length).toBe(3);
    expect(existsSync(opts.dbPath!)).toBe(false);
  });

  test("root with all is refused; a single-agent report has no agents field", async () => {
    await expect(runScan({ ...all, root })).rejects.toThrow("--root cannot be used with --agent all");
    expect((await runScan(opts)).scan.agents).toBeUndefined();
    expect(Object.keys((await runScan({ ...opts, noIndex: true })).scan)).not.toContain("agents");
  });
});

describe("first-seen fields (ADR 0016)", () => {
  const FS = ["global", "project"].map((s) => `title: First ${s}
name: fs-${s}
logsource: { product: ai_coding_agent, category: web_request }
detection:
    selection: { first_seen_${s}: true }
    condition: selection
x-retrohound: { requires: [first_seen] }
`).join("---\n");
  const fetch = (sid: string, ts: string, url: string, cwd = "/home/x/acme") => ({
    type: "assistant", uuid: `u-${++n}`, sessionId: sid, timestamp: ts, cwd,
    message: { content: [{ type: "tool_use", id: `t${n}`, name: "WebFetch", input: { url } }] },
  });
  const fired = (r: Awaited<ReturnType<typeof runScan>>) =>
    r.findings.filter((f) => f.rule_id.startsWith("fs-")).map((f) => `${f.rule_id} ${f.session_id} ${f.events[0]!.domain}`).sort();

  test("the earliest use of a domain fires, per project and overall; --no-index agrees with the index", async () => {
    writeFileSync(join(dir, "rules", "fs.yml"), FS);
    const proj = join(root, "projects", "-home-x-acme");
    // Baseline: inside the first 14 days, so its domain never fires.
    put(join(proj, "s09.jsonl"), [fetch("s09", "2026-10-01T10:00:00.000Z", "https://base.example.invalid/")]);
    put(join(proj, "s10.jsonl"), [fetch("s10", "2026-10-20T10:00:00.000Z", "https://a.example.invalid/x")]);
    put(join(proj, "s11.jsonl"), [
      fetch("s11", "2026-11-08T10:00:00.000Z", "https://a.example.invalid/y"),
      fetch("s11", "2026-11-08T10:00:01.000Z", "https://b.example.invalid/"),
    ]);
    put(join(root, "projects", "-home-x-other", "s12.jsonl"), [fetch("s12", "2026-11-09T10:00:00.000Z", "https://a.example.invalid/", "/home/x/other")]);
    const want = [
      "fs-global s10 a.example.invalid", "fs-global s11 b.example.invalid",
      "fs-project s10 a.example.invalid", "fs-project s11 b.example.invalid", "fs-project s12 a.example.invalid",
    ];
    expect(fired(await runScan({ ...opts, noIndex: true }))).toEqual(want);
    expect(fired(await runScan(opts))).toEqual(want);
    expect(fired(await runScan(opts))).toEqual(want); // a warm rescan keeps them
  });

  test("cold start: nothing fires while the data spans under 14 days", async () => {
    writeFileSync(join(dir, "rules", "fs.yml"), FS);
    put(join(root, "projects", "-home-x-acme", "s10.jsonl"), [fetch("s10", "2026-11-01T10:00:00.000Z", "https://a.example.invalid/")]);
    expect(fired(await runScan({ ...opts, noIndex: true }))).toEqual([]);
    expect(fired(await runScan(opts))).toEqual([]);
  });
});

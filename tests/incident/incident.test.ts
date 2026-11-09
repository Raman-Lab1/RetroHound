// `incident` over an index built by a real scan of hand-written defanged transcripts. Registered on a fresh program,
// not through main.ts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { registerIncident } from "../../src/cli/incident.ts";
import { UsageError, type IO } from "../../src/cli/io.ts";
import type { Pack } from "../../src/incident/pack.ts";
import { runScan } from "../../src/scan.ts";

const base = mkdtempSync(join(tmpdir(), "rh-incident-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const KEY = "AKIA" + "ABCDEFGHIJKLMNOP"; // placeholder in the AWS key shape, split so no file holds it whole
const A = "1111aaaa-0000-4000-8000-000000000001";
const B = "1111bbbb-0000-4000-8000-000000000002";
const HIT = `title: Hit command
id: 0b6c7a52-0000-4000-8000-00000000a11d
name: hit
level: high
logsource: { product: ai_coding_agent }
detection:
    selection: { command_line|contains: hitcmd }
    condition: selection
`;

const ts = (n: number) => `2026-11-07T10:00:${String(n).padStart(2, "0")}.000Z`;
const common = (sid: string, n: number) => ({ uuid: `${sid}-${n}`, sessionId: sid, timestamp: ts(n), cwd: "/home/x/acme" });
const use = (sid: string, n: number, id: string, name: string, input: object, extra = {}) =>
  ({ type: "assistant", ...common(sid, n), message: { content: [{ type: "tool_use", id, name, input }] }, ...extra });
const result = (sid: string, n: number, id: string, extra = {}) =>
  ({ type: "user", ...common(sid, n), message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] }, ...extra });

const dir = join(base, "data");
const proj = join(dir, "claude", "projects", "-home-x-acme");
const db = join(dir, "index.db");
const rules = join(dir, "rules");
const scan = () => runScan({ root: join(dir, "claude"), dbPath: db, rulesDir: rules });

let out = "";
const io: IO = { out: (s) => (out += s), err: () => {}, isTTY: false, env: {} };
async function cli(...argv: string[]): Promise<number> {
  let code = 0;
  const program = new Command().exitOverride();
  registerIncident(program, async (fn) => void (code = await fn()), io);
  try {
    await program.parseAsync(["incident", ...argv, "--db", db, "--rules", rules], { from: "user" });
  } catch (e) {
    if (e instanceof UsageError) return 2;
    throw e;
  }
  return code;
}
let n = 0;
const fresh = () => join(base, `pack-${n++}`);
const readPack = (d: string) => JSON.parse(readFileSync(join(d, "incident.json"), "utf8")) as Pack;
const strings = (v: unknown): string[] =>
  typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(strings) : [];

beforeAll(async () => {
  mkdirSync(rules, { recursive: true });
  writeFileSync(join(rules, "hit.yml"), HIT);
  mkdirSync(proj, { recursive: true });
  const lines = [
    use(A, 1, "t1", "Bash", { command: "hitcmd https://example.invalid/x" }),
    result(A, 2, "t1", { toolDenialKind: "permission-rule" }),
    use(A, 3, "t2", "Bash", { command: `aws s3 ls --access-key ${KEY} s3://example.invalid` }),
    result(A, 4, "t2"),
    use(A, 5, "t3", "Agent", { prompt: "look around" }),
    result(A, 6, "t3", { toolUseResult: { agentId: "a1" } }),
    use(A, 7, "t4", "Bash", { command: "ls" }, { agentId: "a1" }),
    result(A, 8, "t4", { agentId: "a1" }),
  ];
  writeFileSync(join(proj, `${A}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  writeFileSync(join(proj, `${B}.jsonl`), JSON.stringify(use(B, 9, "t9", "Bash", { command: "hitcmd" })) + "\n");
  await scan();
});

describe("incident", () => {
  let first = "";
  test("a session prefix writes the pack with timeline, sub-agent tree, counts, rotate list and provenance", async () => {
    first = fresh();
    expect(await cli("1111a", "--out", first)).toBe(0);
    expect(readdirSync(first).sort()).toEqual(["incident.json", "index.html", "manifest.json"]);
    const p = readPack(first);
    expect(p.schema).toBe("retrohound.incident/0.1");
    expect(p.selected).toEqual({ kind: "session", id: A });
    expect(p.sessions.map((s) => [s.session_id, s.archived])).toEqual([[A, false]]);
    expect(p.counts.outcomes.blocked).toBe(1);
    expect(p.counts.outcomes.success).toBe(3);
    expect(p.timeline.map((e) => e.ts)).toEqual([...p.timeline.map((e) => e.ts)].sort());
    expect(p.timeline.find((e) => e.outcome === "blocked")?.denial_kind).toBe("permission-rule");
    expect(p.sub_agents[0]!.sub_agents.map((a) => [a.agent_id, a.parent_tool_use_id, a.events])).toEqual([["a1", "t3", 1]]);
    expect(p.findings.map((f) => [f.rule_name, f.level, f.session_id])).toEqual([["hit", "high", A]]);
    expect(p.rules).toEqual([expect.objectContaining({ name: "hit", file_sha256: createHash("sha256").update(HIT).digest("hex") })]);
    expect(p.rotate.map((r) => [r.kinds, r.sessions])).toEqual([[["aws_access_key"], 1]]);
    expect(p.rotate[0]!.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    const sha = createHash("sha256").update(readFileSync(join(proj, `${A}.jsonl`))).digest("hex");
    expect(p.provenance.map((f) => [f.path.endsWith(`${A}.jsonl`), f.sha256, f.gone_at])).toEqual([[true, sha, null]]);
  });

  test("no secret value appears in any field, and the HTML shows the masked form", () => {
    const p = readPack(first);
    expect(strings(p).filter((s) => s.includes(KEY))).toEqual([]);
    expect(p.timeline.find((e) => e.secret_fps)?.command_line).toContain("AKIA…[masked]");
    expect(readFileSync(join(first, "index.html"), "utf8")).toContain("AKIA…[masked]");
  });

  test("manifest hashes match the files, and a second run is byte-identical", async () => {
    const m = JSON.parse(readFileSync(join(first, "manifest.json"), "utf8")) as { files: { path: string; sha256: string }[] };
    expect(m.files.map((f) => f.path)).toEqual(["incident.json", "index.html"]);
    for (const f of m.files) expect(createHash("sha256").update(readFileSync(join(first, f.path))).digest("hex")).toBe(f.sha256);
    const again = fresh();
    expect(await cli(A, "--out", again)).toBe(0);
    for (const name of readdirSync(first)) expect(readFileSync(join(again, name)).equals(readFileSync(join(first, name)))).toBe(true);
  });

  test("the HTML loads nothing from outside", () => {
    const html = readFileSync(join(first, "index.html"), "utf8");
    expect(html).toContain("default-src 'none'");
    expect(html).not.toMatch(/<script|<link|<img|<iframe|\b(?:src|href|action)\s*=|url\(|@import/i);
  });

  test("a finding id prefix selects its session", async () => {
    const id = readPack(first).findings[0]!.id;
    const d = fresh();
    expect(await cli(id.slice(0, 12), "--out", d)).toBe(0);
    const p = readPack(d);
    expect(p.selected).toEqual({ kind: "finding", id });
    expect(p.sessions.map((s) => s.session_id)).toEqual([A]);
  });

  test("ambiguous or unknown ids, a missing index and a non-empty --out are usage errors", async () => {
    expect(await cli("1111", "--out", fresh())).toBe(2);
    expect(await cli("zzzz", "--out", fresh())).toBe(2);
    expect(await cli(A, "--out", first)).toBe(2); // holds a pack already
    const empty = fresh();
    mkdirSync(empty);
    expect(await cli(A, "--out", empty)).toBe(0);
    const program = new Command().exitOverride();
    let threw = false;
    registerIncident(program, async (fn) => void (await fn()), io);
    await program.parseAsync(["incident", A, "--db", join(base, "none.db")], { from: "user" }).catch((e) => (threw = e instanceof UsageError));
    expect(threw).toBe(true);
  });

  test("--anonymize hides the project name in paths", async () => {
    const d = fresh();
    expect(await cli(A, "--out", d, "--anonymize")).toBe(0);
    const p = readPack(d);
    expect(p.anonymized).toBe(true);
    expect(p.sessions[0]!.project_path).toMatch(/anon-[0-9a-f]{6}/);
    expect([p.sessions[0]!.project_path, ...p.provenance.map((f) => f.path)].filter((s) => s?.includes("acme"))).toEqual([]);
  });

  test("an archived session (transcripts gone) still packs, from the index alone", async () => {
    rmSync(join(dir, "claude", "projects"), { recursive: true });
    mkdirSync(join(dir, "claude", "projects"));
    await scan();
    const d = fresh();
    expect(await cli(A, "--out", d)).toBe(0);
    const p = readPack(d);
    expect(p.sessions[0]!.archived).toBe(true);
    expect(p.provenance[0]!.gone_at).not.toBeNull();
    expect(p.counts.events).toBe(readPack(first).counts.events);
  });
});

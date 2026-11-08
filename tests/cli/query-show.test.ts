// query and show over an index built by a real scan of hand-written defanged transcripts.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { IO } from "../../src/cli/io.ts";
import { main } from "../../src/cli/main.ts";

const base = mkdtempSync(join(tmpdir(), "rh-qs-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const HIT = `title: Hit command
id: 0b6c7a52-0000-4000-8000-00000000a11d
name: hit
level: high
logsource: { product: ai_coding_agent }
detection:
    selection: { command_line|contains: hitcmd }
    condition: selection
`;
const line = (sid: string, n: number, extra: object = {}) => ({
  type: "assistant", uuid: `u-${n}`, sessionId: sid, timestamp: `2026-11-07T10:00:0${n}.000Z`, cwd: "/home/x/acme",
  message: { content: [{ type: "tool_use", id: `t${n}`, name: "Bash", input: { command: n === 1 ? "hitcmd https://example.invalid/x" : "ls" } }] },
  ...extra,
});
const put = (path: string, lines: object[]) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
};

let dir: string;
let db: string;
let out: string;
let err: string;
let io: IO;
const run = (...argv: string[]) => main(argv, io);
const scan = () => run("scan", "--root", join(dir, "claude"), "--db", db, "--rules", join(dir, "rules"));

beforeEach(async () => {
  dir = mkdtempSync(join(base, "case-"));
  db = join(dir, "index.db");
  out = err = "";
  io = { out: (s) => (out += s), err: (s) => (err += s), isTTY: false, env: {} };
  mkdirSync(join(dir, "rules"));
  writeFileSync(join(dir, "rules", "hit.yml"), HIT);
  const proj = join(dir, "claude", "projects", "-home-x-acme");
  put(join(proj, "abcd1111.jsonl"), [line("abcd1111", 1), line("abcd1111", 2, { agentId: "a1" })]);
  put(join(proj, "abcd2222.jsonl"), [line("abcd2222", 3)]);
  await scan();
  out = "";
});

describe("query", () => {
  test("table and json output of a SELECT", async () => {
    expect(await run("query", "SELECT session_id, event_count FROM sessions ORDER BY session_id", "--db", db)).toBe(0);
    expect(out).toContain("abcd1111");
    expect(out).toContain("(2 rows)");
    out = "";
    expect(await run("query", "SELECT count(*) AS n FROM events", "--db", db, "--format", "json")).toBe(0);
    expect(JSON.parse(out)).toEqual([{ n: 3 }]);
  });

  test.each([
    "INSERT INTO sessions VALUES ('x','claude_code',NULL,'a','b',0)",
    "DELETE FROM events",
    "DROP TABLE events",
  ])("write attempt fails and changes nothing: %s", async (sql) => {
    expect(await run("query", sql, "--db", db)).toBe(2);
    expect(err).toContain("query failed");
    out = "";
    await run("query", "SELECT count(*) AS n FROM events", "--db", db, "--format", "json");
    expect(JSON.parse(out)).toEqual([{ n: 3 }]);
  });

  test("strings are masked again on output", async () => {
    // A secret-shaped value that reached a DB cell some other way must still not print.
    const key = "AKIA" + "ABCDEFGHIJKLMNOP";
    expect(await run("query", `SELECT '${key}' AS k`, "--db", db, "--format", "json")).toBe(0);
    expect(out).not.toContain(key);
  });

  test("a missing index and a bad format exit 2", async () => {
    expect(await run("query", "SELECT 1", "--db", join(dir, "none.db"))).toBe(2);
    expect(await run("query", "SELECT 1", "--db", db, "--format", "csv")).toBe(2);
  });
});

describe("show", () => {
  test("an 8-char-style prefix shows the timeline with the finding at its primary event", async () => {
    expect(await run("show", "abcd1", "--db", db, "--rules", join(dir, "rules"))).toBe(0);
    expect(out).toContain("Session abcd1111");
    expect(out).toContain("main");
    expect(out).toContain("sub:a1");
    expect(out).toMatch(/hitcmd .*<== HIGH hit/);
    expect(out).not.toContain("archived");
  });

  test("an ambiguous prefix lists the matches and exits 2; an unknown one exits 2", async () => {
    expect(await run("show", "abcd", "--db", db)).toBe(2);
    expect(err).toContain("abcd1111");
    expect(err).toContain("abcd2222");
    expect(await run("show", "zzz", "--db", db)).toBe(2);
    expect(await run("show", "abcd1", "--db", join(dir, "none.db"))).toBe(2);
  });

  test("a session whose transcripts are gone is marked archived", async () => {
    rmSync(join(dir, "claude", "projects"), { recursive: true });
    mkdirSync(join(dir, "claude", "projects"));
    await scan();
    out = "";
    expect(await run("show", "abcd1", "--db", db)).toBe(0);
    expect(out).toContain("[archived");
  });
});

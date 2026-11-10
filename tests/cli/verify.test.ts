// `retrohound verify` over an index built by a real scan of hand-written defanged transcripts. The chain itself is
// tested on both engines in tests/store/chain-check.ts; this covers the command: output, exit codes, bad input.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import type { IO } from "../../src/cli/io.ts";
import { main } from "../../src/cli/main.ts";
import { registerVerify } from "../../src/cli/verify.ts";
import { open } from "../../src/store/sqlite.ts";

const base = mkdtempSync(join(tmpdir(), "rh-verify-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const HIT = `title: Hit command
id: 0b6c7a52-0000-4000-8000-00000000b22e
name: hit
level: high
logsource: { product: ai_coding_agent }
detection:
    selection: { command_line|contains: hitcmd }
    condition: selection
`;
const toolUse = (n: number, command: string) => ({
  type: "assistant", uuid: `u-${n}`, sessionId: "abcd1111", timestamp: `2026-11-07T10:00:0${n}.000Z`, cwd: "/home/x/acme",
  message: { content: [{ type: "tool_use", id: `t${n}`, name: "Bash", input: { command } }] },
});
const toolResult = (n: number) => ({
  type: "user", uuid: `r-${n}`, sessionId: "abcd1111", timestamp: `2026-11-07T10:00:0${n + 1}.000Z`, cwd: "/home/x/acme",
  message: { content: [{ type: "tool_result", tool_use_id: `t${n}`, content: "done" }] },
});
const jsonl = (lines: object[]) => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";

let dir: string;
let db: string;
let transcript: string;
let out: string;
let io: IO;
const scan = () => main(["scan", "--root", join(dir, "claude"), "--db", db, "--rules", join(dir, "rules"), "--no-report"], io);

/** Runs `verify` the way main.ts will once it registers it. */
async function verify(...argv: string[]): Promise<number> {
  out = "";
  let code = -1;
  const program = new Command().exitOverride();
  registerVerify(program, async (fn) => void (code = await fn()), io);
  await program.parseAsync(["verify", "--db", db, ...argv], { from: "user" });
  return code;
}
const parsed = () => {
  const m = /^ok: (\d+) entries, head ([0-9a-f]{64})\n/.exec(out);
  if (!m) throw new Error(`not an ok line: ${out}`);
  return { entries: Number(m[1]), head: m[2]! };
};
const sql = (text: string, ...params: number[]) => {
  const w = open(db);
  const rows = w.prepare(text).all(...params);
  w.close();
  return rows;
};

beforeEach(async () => {
  dir = mkdtempSync(join(base, "case-"));
  db = join(dir, "index.db");
  io = { out: (s) => (out += s), err: () => {}, isTTY: false, env: {} };
  mkdirSync(join(dir, "rules"));
  writeFileSync(join(dir, "rules", "hit.yml"), HIT);
  const proj = join(dir, "claude", "projects", "-home-x-acme");
  mkdirSync(proj, { recursive: true });
  transcript = join(proj, "abcd1111.jsonl");
  writeFileSync(transcript, jsonl([toolUse(1, "hitcmd https://example.invalid/x"), toolUse(3, "ls")]));
  expect(await scan()).toBe(0);
});

test("a scanned index verifies; a rescan where an outcome becomes known still does, and the older head is kept", async () => {
  expect(await verify()).toBe(0);
  const first = parsed();
  expect(first.entries).toBeGreaterThan(3); // events, the file and the finding
  appendFileSync(transcript, jsonl([toolResult(3)])); // t3's outcome: unknown -> success
  expect(await scan()).toBe(0);
  expect(await verify()).toBe(0);
  const second = parsed();
  expect(second.entries).toBeGreaterThan(first.entries);
  expect(second.head).not.toBe(first.head);
  const changed = sql("SELECT e.outcome FROM chain c JOIN events e ON e.id = c.row_id WHERE c.seq > ? AND c.tbl = 'events'", first.entries);
  expect(changed.map((row) => row.outcome)).toEqual(["success"]);
  expect(await verify("--head", first.head.toUpperCase())).toBe(0);
  expect(parsed().head).toBe(second.head);
  const added = sql("SELECT tbl || ' ' || op AS k, count(*) AS n FROM chain WHERE seq > ? GROUP BY k ORDER BY k", first.entries);
  expect(out.split("\n")[1]).toBe(`added since the recorded head: ${added.map((r) => `${r.k} ×${r.n}`).join(", ")}`);
  expect(await verify("--head", second.head)).toBe(0);
  expect(out.split("\n")[1]).toBe("added since the recorded head: nothing");
  expect(await verify()).toBe(0);
  expect(out.split("\n")[1]).toBe(""); // no head, no second line
});

test("an event edited by SQL fails with exit 1 and is named; so does a head the chain does not have", async () => {
  sql("UPDATE events SET command_line = 'ls -la' WHERE command_line = 'ls'");
  const [row] = sql("SELECT id FROM events WHERE command_line = 'ls -la'");
  expect(await verify()).toBe(1);
  expect(out).toStartWith(`broken: events row ${row?.id}: does not match chain entry `);
  sql("UPDATE events SET command_line = 'ls' WHERE command_line = 'ls -la'");
  expect(await verify()).toBe(0);
  expect(await verify("--head", "a".repeat(64))).toBe(1);
  expect(out).toStartWith(`broken: head ${"a".repeat(64)} is not in the chain`);
});

test("bad input is a usage error: a malformed head, a missing index, an index from before the chain", async () => {
  await expect(verify("--head", "not-a-hash")).rejects.toThrow(/bad --head/);
  for (const suffix of ["", "-wal", "-shm"]) rmSync(db + suffix, { force: true });
  await expect(verify()).rejects.toThrow(/no index at/);
  sql("PRAGMA user_version = 2");
  await expect(verify()).rejects.toThrow(/run `retrohound scan` once to upgrade it/);
});

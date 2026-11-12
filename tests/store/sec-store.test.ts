// Store hardening: a planted trigger, a hand-edited sessions table, history rewritten after a recorded head, another
// program's database given as --db, the incident pack's snapshot, and what purge will delete. Defanged data only.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defaultLogPath } from "../../src/hooks/run.ts";
import { main } from "../../src/cli/main.ts";
import type { IO } from "../../src/cli/io.ts";
import { buildPack } from "../../src/incident/pack.ts";
import { chainWriter, verifyChain } from "../../src/store/chain.ts";
import { indexFiles } from "../../src/store/indexer.ts";
import { openReadOnly, openStore } from "../../src/store/index.ts";
import { MIGRATIONS, migrate, schemaProblem } from "../../src/store/schema.ts";
import { open, type Db } from "../../src/store/sqlite.ts";
import { parser, write } from "./store-check.ts";

const base = mkdtempSync(join(tmpdir(), "rh-sec-store-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let dir: string, db: string, file: string;
beforeEach(() => {
  dir = mkdtempSync(join(base, "case-"));
  [db, file] = [join(dir, "index.db"), join(dir, "s1.jsonl")];
});

const sql = (text: string) => {
  const w = open(db);
  try {
    w.exec(text);
  } finally {
    w.close();
  }
};
const verify = (head?: string) => {
  const r = openReadOnly(db);
  try {
    return schemaProblem(r) ?? verifyChain(r, head);
  } finally {
    r.close();
  }
};
async function scan(lines?: Parameters<typeof write>[1]): Promise<void> {
  if (lines) write(file, lines);
  const store = openStore(db);
  try {
    await indexFiles(store, [file], parser().parse, "p1");
  } finally {
    store.close();
  }
}
const headOf = () => {
  const v = verify();
  if (typeof v === "string" || !v.ok) throw new Error(`not ok: ${JSON.stringify(v)}`);
  return v;
};

test("a trigger planted in the index fails verify and refuses the next scan, which would have dropped the event", async () => {
  await scan([{ id: "a", command_line: "ls" }]);
  headOf();
  sql(`CREATE TRIGGER t BEFORE INSERT ON events WHEN NEW.command_line LIKE '%example.invalid%' BEGIN SELECT RAISE(IGNORE); END`);
  expect(verify()).toMatch(/^trigger t is not as RetroHound creates it/);
  await expect(scan([{ id: "a", command_line: "ls" }, { id: "b", command_line: "curl https://example.invalid/x" }]))
    .rejects.toThrow(/trigger t .*; left unchanged$/);
  sql("DROP TRIGGER t");
  await scan([{ id: "a", command_line: "ls" }, { id: "b", command_line: "curl https://example.invalid/x" }]);
  expect(headOf().entries).toBeGreaterThan(0);
});

test("an index created at an older version upgrades through the schema check and verifies", async () => {
  const old = open(db);
  migrate(old, MIGRATIONS.slice(0, 2));
  old.close();
  await scan([{ id: "a" }]);
  expect(verify()).toMatchObject({ ok: true });
});

test("a sessions row deleted or edited by hand fails verify, also after a rescan of the unchanged file", async () => {
  await scan([{ id: "a" }, { id: "b" }]);
  headOf();
  sql("DELETE FROM sessions WHERE session_id = 's1'");
  expect(verify()).toMatchObject({ ok: false, problem: expect.stringMatching(/^sessions row s1: does not match its events/) });
  await scan(); // unchanged: skipped, so nothing restores the row
  expect(verify()).toMatchObject({ ok: false });
  await scan([{ id: "a" }, { id: "b" }, { id: "c" }]); // grown: the session is refreshed from its events
  headOf();
  sql("UPDATE sessions SET first_ts = '2030-01-01T00:00:00.000Z'");
  expect(verify()).toMatchObject({ ok: false, problem: expect.stringMatching(/^sessions row s1/) });
});

test("since --head, a rewrite of an existing event is counted apart from a new event", async () => {
  await scan([{ id: "a", command_line: "curl https://example.invalid/x" }]);
  const { head } = headOf();
  const w = open(db);
  const row = w.prepare("UPDATE events SET command_line = 'ls' RETURNING *").all();
  chainWriter(w).append("events", "write", row); // re-chained with the public formula
  w.close();
  expect(verify(head)).toMatchObject({ ok: true, since: { "events rewrite": 1 } });
  await scan([{ id: "a", command_line: "ls" }, { id: "b" }]);
  expect(verify(head)).toMatchObject({ ok: true, since: { "events rewrite": 1, "events write": 1 } });
});

test("another program's database at user_version 1 is refused before any change: version, journal mode, file mode", async () => {
  const other = open(db);
  other.exec("CREATE TABLE events (title TEXT); PRAGMA user_version = 1");
  other.close();
  chmodSync(db, 0o644);
  const before = readFileSync(db);
  expect(() => openStore(db)).toThrow(/not a RetroHound index/);
  expect(readFileSync(db).equals(before)).toBe(true); // header byte 18 would read 2 after a switch to WAL
  if (process.platform !== "win32") expect(statSync(db).mode & 0o777).toBe(0o644);
});

test("the incident pack reads one snapshot: a scan committing mid-build does not move its index_head", async () => {
  await scan([{ id: "a" }]);
  const { head } = headOf();
  const r = openReadOnly(db);
  let fired = false;
  const racing: Db = {
    ...r,
    prepare(text) {
      const s = r.prepare(text);
      if (fired || !text.includes("FROM events WHERE session_id")) return s;
      fired = true;
      return { ...s, all: (...p) => {
        const rows = s.all(...p);
        const store = openStore(db); // another process's scan, committing between the pack's reads
        store.transaction(() => store.upsertEvents(file, [{ ...parserEvent("z") }]));
        store.close();
        return rows;
      } };
    },
  };
  try {
    const pack = buildPack(racing, { kind: "session", id: "s1", sessions: ["s1"] }, [], false);
    expect(fired).toBe(true);
    expect(pack.index_head).toBe(head);
    expect(pack.counts.events).toBe(1);
  } finally {
    r.close();
  }
});
const parserEvent = (id: string) => ({
  id, schema_version: "0.1" as const, agent: "claude_code" as const, session_id: "s1", ts: "2026-11-07T00:00:09.000Z", seq: 9,
  category: "tool_call" as const, raw_ref: { file, line: 9 },
});

test("purge refuses a file that is not an index, still deletes a tampered one, and names the hook log it keeps", async () => {
  let out = "";
  const io: IO = { out: (s) => (out += s), err: (s) => (out += s), isTTY: false, env: {} };
  const notes = join(dir, "notes.db");
  const n = open(notes);
  n.exec("CREATE TABLE notes (x)");
  n.close();
  expect(await main(["purge", "--db", notes, "--yes"], io)).toBe(2);
  expect(existsSync(notes)).toBe(true);
  writeFileSync(join(dir, "plain.txt"), "not sqlite");
  expect(await main(["purge", "--db", join(dir, "plain.txt"), "--yes"], io)).toBe(2);
  expect(out).toContain("is not a RetroHound index");

  await scan([{ id: "a" }]);
  sql("CREATE TRIGGER t BEFORE INSERT ON events BEGIN SELECT RAISE(IGNORE); END");
  const log = defaultLogPath();
  const hadLog = existsSync(log);
  if (!hadLog) mkdirSync(dirname(log), { recursive: true }), writeFileSync(log, "");
  out = "";
  expect(await main(["purge", "--db", db, "--yes"], io)).toBe(0);
  expect(existsSync(db)).toBe(false);
  expect(out).toContain(`Kept: the hook log ${log}`);
  if (!hadLog) rmSync(log);
});

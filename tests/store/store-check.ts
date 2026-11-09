// Store behaviour, one body for both engines: tests/store/store.test.ts runs every case in Bun and in a real `node`.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { secretKinds } from "../../src/normalize/mask.ts";
import type { Finding, ParsedFile, RawEvent } from "../../src/normalize/types.ts";
import { indexFiles } from "../../src/store/indexer.ts";
import { defaultDbPath, findingId, openReadOnly, openStore, type Store } from "../../src/store/index.ts";
import { MIGRATIONS, migrate } from "../../src/store/schema.ts";
import { open } from "../../src/store/sqlite.ts";

const SECRET = "sk" + "-ant-" + "A1b2C3d4E5".repeat(4);
const CANARY = "match-only-canary";

function event(line: Partial<RawEvent>, i: number, file: string): RawEvent {
  return {
    id: `id-${i}`,
    schema_version: "0.1",
    agent: "claude_code",
    session_id: "s1",
    ts: `2026-11-07T00:00:0${i}.000Z`,
    seq: i,
    category: "tool_call",
    raw_ref: { file, line: i + 1 },
    ...line,
  };
}

/** A fake transcript: one JSON object per line, each the fields of one event. */
export function write(path: string, lines: Partial<RawEvent>[]): void {
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n"));
}

export function parser() {
  const calls: string[] = [];
  const parse = async (path: string): Promise<ParsedFile> => {
    calls.push(path);
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    const events = lines.map((l, i) => event(JSON.parse(l) as Partial<RawEvent>, i, path));
    return { events, stats: { lines: lines.length, malformed: 0, unknown_types: {} } };
  };
  return { parse, calls };
}

async function withStore(dir: string, body: (store: Store, db: string) => Promise<void>): Promise<void> {
  const db = join(dir, "index.db");
  const store = openStore(db);
  try {
    await body(store, db);
  } finally {
    store.close();
  }
}

const ids = (store: Store, session = "s1") => store.sessionEvents(session).map((e) => e.id);
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

export function finding(rule_id: string, events: RawEvent[]): Finding {
  return {
    id: findingId(rule_id, events.map((e) => e.id)),
    rule_id,
    level: "high",
    ts: "2026-11-07T00:00:00.000Z",
    session_id: "s1",
    message: "found",
    events,
  };
}

export const CASES: [name: string, run: (dir: string) => Promise<void>][] = [
  ["fresh DB has the schema at the current version", (dir) =>
    withStore(dir, async (_store, path) => {
      const ro = openReadOnly(path);
      assert.equal(ro.prepare("PRAGMA user_version").get()?.user_version, MIGRATIONS.length);
      const names = ro.prepare("SELECT name FROM sqlite_master").all().map((r) => r.name);
      for (const name of ["events", "sessions", "files_indexed", "findings", "rule_runs"]) assert.ok(names.includes(name));
      assert.deepEqual(names.filter((n) => String(n).startsWith("events_")).sort(), ["events_session_seq", "events_source_file"]);
      ro.close();
    })],

  ["upgrading a v1 DB with data drops the unused indexes and keeps every row and query result", async (dir) => {
    const path = join(dir, "v1.db");
    const db = open(path);
    migrate(db, MIGRATIONS.slice(0, 1));
    assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 1);
    assert.equal(db.prepare("SELECT count(*) AS c FROM sqlite_master WHERE name LIKE 'events_%'").get()?.c, 6);
    db.close();
    const file = join(dir, "a.jsonl");
    write(file, [{ category: "tool_call" }, { category: "tool_call", outcome: "blocked" }]);
    const first = openStore(path); // already at v2 after this open; index a file, then rebuild the v1 shape below
    await indexFiles(first, [file], parser().parse, "p1");
    const before = first.sessionEvents("s1").map((e) => e.id);
    first.close();
    const old = open(path);
    old.exec("CREATE INDEX events_category ON events (category); CREATE INDEX events_ts ON events (ts); CREATE INDEX events_target_path ON events (target_path); CREATE INDEX events_domain ON events (domain); DROP TABLE chain; PRAGMA user_version = 1");
    old.close();
    const store = openStore(path);
    assert.deepEqual(store.sessionEvents("s1").map((e) => e.id), before);
    assert.equal(store.eventStats(["s1"]).blocked, 1);
    store.close();
    const ro = openReadOnly(path);
    assert.equal(ro.prepare("PRAGMA user_version").get()?.user_version, MIGRATIONS.length);
    assert.equal(ro.prepare("SELECT count(*) AS c FROM sqlite_master WHERE name IN ('events_category','events_ts')").get()?.c, 0);
    ro.close();
  }],

  ["the stored hash is the one the parser computed from its own read; without one the indexer reads the file", (dir) =>
    withStore(dir, async (store) => {
      const file = join(dir, "h.jsonl");
      write(file, [{ category: "tool_call" }]);
      const { parse, calls } = parser();
      const given = createHash("sha256").update("parser-bytes").digest("hex");
      await indexFiles(store, [file], async (p) => ({ ...(await parse(p)), sha256: given }), "p1");
      assert.equal(store.getFile(file)?.sha256, given);
      write(file, [{ category: "tool_call" }, { category: "tool_call" }]);
      await indexFiles(store, [file], parse, "p1");
      assert.equal(store.getFile(file)?.sha256, sha(file));
      assert.equal(calls.length, 2);
    })],

  ["schema is applied once: reopening keeps data and version", async (dir) => {
    const path = join(dir, "index.db");
    const first = openStore(path);
    first.recordRuleRun({ rule_set_hash: "h", started_at: "a", finished_at: "b", events: 1, findings: 0 });
    first.close();
    const second = openStore(path); // the CREATE TABLEs would throw if they ran again
    assert.equal(second.lastRuleRun()?.rule_set_hash, "h");
    second.close();
    const db = open(path);
    assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, MIGRATIONS.length);
    db.close();
  }],

  ["migrations run in order, once each, and a failed one rolls back", async (dir) => {
    const db = open(join(dir, "m.db"));
    const list = ["CREATE TABLE a (x)", "INSERT INTO a VALUES (1)"];
    migrate(db, list);
    migrate(db, list);
    assert.equal(db.prepare("SELECT count(*) AS c FROM a").get()?.c, 1);
    assert.throws(() => migrate(db, [...list, "INSERT INTO a VALUES (2); INSERT INTO nope VALUES (3)"]));
    assert.equal(db.prepare("SELECT count(*) AS c FROM a").get()?.c, 1);
    assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 2);
    db.close();
  }],

  ["a DB from a newer version is refused and left closed", async (dir) => {
    const path = join(dir, "index.db");
    const db = open(path);
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
    db.close();
    assert.throws(() => openStore(path), /newer/);
    rmSync(path); // EBUSY on Windows if the failed open kept the handle
  }],

  ["creates missing directories, and restricts modes where the OS supports them", async (dir) => {
    const path = join(dir, "a", "b", "index.db");
    openStore(path).close();
    assert.ok(existsSync(path));
    if (process.platform !== "win32") {
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.equal(statSync(join(dir, "a", "b")).mode & 0o777, 0o700);
    }
    assert.match(defaultDbPath().replaceAll("\\", "/"), /\/\.retrohound\/index\.db$/);
  }],

  ["unchanged file is skipped, and last_seen moves", (dir) =>
    withStore(dir, async (store) => {
      const file = join(dir, "s1.jsonl");
      write(file, [{ id: "a" }, { id: "b" }]);
      const { parse, calls } = parser();
      assert.deepEqual(await indexFiles(store, [file], parse, "1"), { indexed: 1, skipped: 0, gone: 0, events: 2, failed: [] });
      const before = store.getFile(file);
      assert.deepEqual(await indexFiles(store, [file], parse, "1"), { indexed: 0, skipped: 1, gone: 0, events: 0, failed: [] });
      assert.equal(calls.length, 1);
      const after = store.getFile(file);
      assert.equal(after?.first_seen, before?.first_seen);
      assert.ok(after!.last_seen >= before!.last_seen);
      assert.equal(after?.sha256, sha(file));
    })],

  ["changed file is re-indexed and re-hashed", (dir) =>
    withStore(dir, async (store) => {
      const file = join(dir, "s1.jsonl");
      write(file, [{ id: "a", outcome: "unknown" }]);
      const { parse, calls } = parser();
      await indexFiles(store, [file], parse, "1");
      const oldHash = store.getFile(file)?.sha256;
      write(file, [{ id: "a", outcome: "success" }, { id: "b" }]);
      const r = await indexFiles(store, [file], parse, "1");
      assert.equal(r.indexed, 1);
      assert.equal(calls.length, 2);
      assert.deepEqual(ids(store), ["a", "b"]);
      assert.equal(store.sessionEvents("s1")[0]?.outcome, "success");
      assert.equal(store.getSession("s1")?.event_count, 2);
      assert.notEqual(store.getFile(file)?.sha256, oldHash);
      assert.equal(store.getFile(file)?.sha256, sha(file));
    })],

  ["same size and mtime means no read at all: sha256 stays, parser is not called", (dir) =>
    withStore(dir, async (store) => {
      const file = join(dir, "s1.jsonl");
      const when = new Date(1_700_000_000_123);
      write(file, [{ id: "a" }]);
      utimesSync(file, when, when);
      const { parse, calls } = parser();
      await indexFiles(store, [file], parse, "1");
      const hash = store.getFile(file)?.sha256;
      write(file, [{ id: "b" }]);
      utimesSync(file, when, when);
      assert.equal((await indexFiles(store, [file], parse, "1")).skipped, 1);
      assert.equal(store.getFile(file)?.sha256, hash);
      assert.equal(calls.length, 1);
    })],

  ["trimmed rewrite keeps old events", (dir) =>
    withStore(dir, async (store) => {
      const file = join(dir, "s1.jsonl");
      write(file, [{ id: "a" }, { id: "b" }, { id: "c" }]);
      const { parse } = parser();
      await indexFiles(store, [file], parse, "1");
      write(file, [{ id: "c" }]);
      assert.equal((await indexFiles(store, [file], parse, "1")).indexed, 1);
      assert.deepEqual(ids(store).sort(), ["a", "b", "c"]);
      assert.equal(store.getSession("s1")?.event_count, 3);
    })],

  ["deleted file sets gone_at and keeps events; the session reads as archived", (dir) =>
    withStore(dir, async (store) => {
      const file = join(dir, "s1.jsonl");
      write(file, [{ id: "a", project_path: "/work/acme" }]);
      const { parse } = parser();
      await indexFiles(store, [file], parse, "1");
      assert.equal(store.getSession("s1")?.archived, false);
      rmSync(file);
      assert.equal((await indexFiles(store, [], parse, "1")).gone, 1);
      const row = store.getFile(file);
      assert.ok(row?.gone_at);
      assert.equal(row?.sha256.length, 64); // the hash as last seen outlives the file (0008)
      assert.deepEqual(ids(store), ["a"]);
      assert.deepEqual(store.listSessions().map((s) => [s.session_id, s.archived, s.project_path]), [["s1", true, "/work/acme"]]);
      assert.equal((await indexFiles(store, [file], parse, "1")).gone, 0); // listed but missing, and already recorded
      assert.equal(store.getFile(file)?.gone_at, row?.gone_at);
    })],

  ["a session stays live while any of its files is on disk, and a file that returns is no longer gone", (dir) =>
    withStore(dir, async (store) => {
      const main = join(dir, "s1.jsonl");
      const sub = join(dir, "agent-1.jsonl");
      write(main, [{ id: "a" }]);
      const when = new Date(1_700_000_000_123);
      write(sub, [{ id: "b", agent_id: "agent-1" }]);
      utimesSync(sub, when, when);
      const { parse } = parser();
      await indexFiles(store, [main, sub], parse, "1");
      const content = readFileSync(sub);
      rmSync(sub);
      await indexFiles(store, [main], parse, "1");
      assert.ok(store.getFile(sub)?.gone_at);
      assert.equal(store.getSession("s1")?.archived, false);
      writeFileSync(sub, content);
      utimesSync(sub, when, when);
      assert.equal((await indexFiles(store, [main, sub], parse, "1")).skipped, 2); // unchanged, so only touched
      assert.equal(store.getFile(sub)?.gone_at, null);
    })],

  ["a file outside the list that still exists is not gone", (dir) =>
    withStore(dir, async (store) => {
      const file = join(dir, "s1.jsonl");
      write(file, [{ id: "a" }]);
      const { parse } = parser();
      await indexFiles(store, [file], parse, "1");
      assert.equal((await indexFiles(store, [], parse, "1")).gone, 0);
      assert.equal(store.getFile(file)?.gone_at, null);
    })],

  ["parser_version bump rebuilds files on disk and leaves gone files alone", (dir) =>
    withStore(dir, async (store) => {
      const live = join(dir, "live.jsonl");
      const vanished = join(dir, "vanished.jsonl");
      write(live, [{ id: "old-1" }, { id: "old-2" }]);
      write(vanished, [{ id: "kept", session_id: "s2" }]);
      const { parse, calls } = parser();
      await indexFiles(store, [live, vanished], parse, "1");
      const hash = store.getFile(live)?.sha256;
      rmSync(vanished);
      await indexFiles(store, [live], parse, "1");

      write(live, [{ id: "old-1" }, { id: "new" }]);
      utimesSync(live, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
      assert.equal((await indexFiles(store, [live], parse, "2")).indexed, 1);
      assert.deepEqual(ids(store).sort(), ["new", "old-1"]); // old-2 goes: the one case events are deleted
      assert.equal(store.getFile(live)?.parser_version, "2");
      assert.notEqual(store.getFile(live)?.sha256, hash);
      assert.deepEqual(ids(store, "s2"), ["kept"]);
      assert.equal(store.getFile(vanished)?.parser_version, "1");
      assert.equal(calls.length, 3);

      // Same size and mtime with a new version re-parses but does not re-hash: only those two trigger a sha256.
      const same = store.getFile(live)?.sha256;
      write(live, [{ id: "old-1" }, { id: "wen" }]);
      utimesSync(live, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
      await indexFiles(store, [live], parse, "3");
      assert.deepEqual(ids(store).sort(), ["old-1", "wen"]);
      assert.equal(store.getFile(live)?.sha256, same);
      assert.equal(calls.length, 4);
    })],

  ["a rebuild that empties a session removes its summary row", (dir) =>
    withStore(dir, async (store) => {
      const file = join(dir, "s1.jsonl");
      write(file, [{ id: "a" }]);
      const { parse } = parser();
      await indexFiles(store, [file], parse, "1");
      write(file, []);
      await indexFiles(store, [file], parse, "2");
      assert.equal(store.getSession("s1"), undefined);
      assert.deepEqual(store.listSessions(), []);
    })],

  ["a failed parse keeps what the file had, does not stop the run, is retried, and its error is masked", (dir) =>
    withStore(dir, async (store) => {
      const bad = join(dir, "bad.jsonl");
      const good = join(dir, "good.jsonl");
      write(bad, [{ id: "a" }]);
      write(good, [{ id: "g", session_id: "s2" }]);
      const { parse } = parser();
      await indexFiles(store, [bad], parse, "1");
      write(bad, [{ id: "a" }, { id: "b" }]);
      const failing = async (path: string) => {
        if (path === bad) throw new Error(`bad line: ${SECRET}`);
        return parse(path);
      };
      const r = await indexFiles(store, [bad, good], failing, "2");
      assert.equal(r.indexed, 1);
      assert.equal(r.failed.length, 1);
      assert.equal(r.failed[0]?.path, bad);
      assert.equal(secretKinds(r.failed[0]?.error ?? SECRET).length, 0);
      assert.deepEqual(ids(store), ["a"]);
      assert.equal(store.getFile(bad)?.parser_version, "1");
      const retry = await indexFiles(store, [bad, good], parse, "2");
      assert.deepEqual([retry.indexed, retry.skipped, retry.failed.length], [1, 1, 0]);
      assert.deepEqual(ids(store), ["a", "b"]);
    })],

  ["a failure mid-file rolls that file back: one transaction per file", (dir) =>
    withStore(dir, async (store) => {
      const file = join(dir, "s1.jsonl");
      write(file, [{ id: "a" }]);
      const { parse } = parser();
      await indexFiles(store, [file], parse, "1");
      const broken = async (path: string): Promise<ParsedFile> => {
        const parsed = await parse(path);
        parsed.events.push({ ...parsed.events[0]!, session_id: undefined as unknown as string });
        return parsed;
      };
      const r = await indexFiles(store, [file], broken, "2");
      assert.equal(r.failed.length, 1);
      assert.deepEqual(ids(store), ["a"]); // the rebuild's delete was undone too
      assert.equal(store.getFile(file)?.parser_version, "1");
    })],

  ["events read back equal what toStored wrote: lists are arrays and absent fields stay absent", (dir) =>
    withStore(dir, async (store) => {
      const file = join(dir, "s1.jsonl");
      write(file, [
        { id: "a", url: "https://example.invalid/x", domain: "example.invalid", secret_kinds: ["sk_key"], secret_fps: ["0011223344556677"] },
        { id: "b", secret_kinds: [] },
      ]);
      await indexFiles(store, [file], parser().parse, "1");
      const [a, b] = store.sessionEvents("s1");
      assert.deepEqual(a, { ...event({ id: "a", url: "https://example.invalid/x", domain: "example.invalid" }, 0, file), secret_kinds: ["sk_key"], secret_fps: ["0011223344556677"] });
      assert.deepEqual(b, event({ id: "b" }, 1, file));
    })],

  ["session summary spans all its events and files", (dir) =>
    withStore(dir, async (store) => {
      const main = join(dir, "s1.jsonl");
      const sub = join(dir, "agent-1.jsonl");
      write(main, [{ id: "a", ts: "2026-01-02T00:00:00.000Z" }, { id: "b", ts: "2026-01-03T00:00:00.000Z", project_path: "/work/late" }]);
      write(sub, [{ id: "c", ts: "2026-01-01T00:00:00.000Z", project_path: "/work/early" }]);
      await indexFiles(store, [main, sub], parser().parse, "1");
      const s = store.getSession("s1");
      assert.deepEqual([s?.first_ts, s?.last_ts, s?.event_count], ["2026-01-01T00:00:00.000Z", "2026-01-03T00:00:00.000Z", 3]);
      assert.equal(s?.project_path, "/work/early");
      assert.deepEqual(ids(store), ["c", "a", "b"]);
    })],

  ["no raw text reaches the DB file, whatever path it came in by", async (dir) => {
    const path = join(dir, "index.db");
    const file = join(dir, "s1.jsonl");
    const dirty = `x ${SECRET} y`;
    const line: Partial<RawEvent> = {
      command_line: dirty,
      target_path: dirty,
      url: dirty,
      project_path: dirty,
      text_excerpt: dirty,
      content: CANARY,
      tool_input: CANARY,
      tool_response: CANARY,
      text: CANARY,
    };
    write(file, [line]);
    const store = openStore(path);
    await indexFiles(store, [file], parser().parse, "1");
    const raw = event({ ...line, session_id: dirty }, 0, dirty);
    store.insertFindings([{ ...finding(`rule ${dirty}`, [raw]), message: dirty, session_id: dirty, ts: dirty }]);
    assert.equal(store.sessionEvents("s1")[0]?.command_line, "x sk-…[masked] y");
    store.close();
    const bytes = readFileSync(path, "latin1");
    assert.equal(bytes.includes(SECRET), false);
    assert.equal(bytes.includes(CANARY), false);
    assert.deepEqual(secretKinds(bytes), []);
  }],

  ["a path that masking changes is still found, skipped and never marked gone", (dir) =>
    withStore(dir, async (store) => {
      const file = join(dir, "TOKEN=abcdefgh12345678.jsonl");
      write(file, [{ id: "a" }]);
      const { parse, calls } = parser();
      await indexFiles(store, [file], parse, "1");
      assert.equal(store.listFiles().some((f) => f.path.includes("abcdefgh")), false);
      const r = await indexFiles(store, [file], parse, "1");
      assert.deepEqual([r.skipped, r.gone, calls.length], [1, 0, 1]);
      assert.equal(store.getFile(file)?.gone_at, null);
    })],

  ["findings: read back masked, a RawEvent inside loses its match-only fields, a repeat keeps the first evidence", (dir) =>
    withStore(dir, async (store) => {
      const raw = event({ command_line: `x ${SECRET}`, text_excerpt: "the match", content: CANARY, text: CANARY }, 0, "/t/s1.jsonl");
      const f = { ...finding("rule-1", [raw]), message: `found ${SECRET}` };
      store.insertFindings([f]);
      const [stored] = store.listFindings();
      assert.equal(stored?.id, f.id);
      assert.equal(stored?.message, "found sk-…[masked]");
      assert.equal(stored?.events[0]?.command_line, "x sk-…[masked]");
      assert.equal("content" in stored!.events[0]!, false);
      assert.equal("text" in stored!.events[0]!, false);

      const { text_excerpt: _dropped, ...fromDb } = raw;
      store.insertFindings([{ ...f, level: "critical", message: "reworded", events: [fromDb] }]);
      const all = store.listFindings();
      assert.equal(all.length, 1);
      assert.deepEqual([all[0]?.level, all[0]?.message], ["critical", "reworded"]);
      assert.equal(all[0]?.events[0]?.text_excerpt, "the match");

      store.insertFindings([{ ...finding("rule-2", [raw]), session_id: "s2" }]);
      assert.equal(store.listFindings().length, 2);
      assert.deepEqual(store.listFindings("s2").map((x) => x.rule_id), ["rule-2"]);
    })],

  ["findingId ignores event order and depends on the rule", async () => {
    assert.equal(findingId("r", ["b", "a"]), findingId("r", ["a", "b"]));
    assert.notEqual(findingId("r", ["a"]), findingId("q", ["a"]));
    assert.equal(findingId("r", ["b", "a"]), createHash("sha256").update("rab").digest("hex"));
  }],

  ["findings survive a parser rebuild of the events they point at", (dir) =>
    withStore(dir, async (store) => {
      const file = join(dir, "s1.jsonl");
      write(file, [{ id: "a" }]);
      const { parse } = parser();
      await indexFiles(store, [file], parse, "1");
      store.insertFindings([finding("rule-1", [event({ id: "a" }, 0, file)])]);
      write(file, [{ id: "b" }]);
      await indexFiles(store, [file], parse, "2");
      assert.deepEqual(ids(store), ["b"]);
      assert.equal(store.listFindings()[0]?.events[0]?.id, "a");
    })],

  ["rule runs: the latest one is returned, undefined before any", (dir) =>
    withStore(dir, async (store) => {
      assert.equal(store.lastRuleRun(), undefined);
      const run = { rule_set_hash: "one", started_at: "a", finished_at: "b", events: 5, findings: 1 };
      store.recordRuleRun(run);
      store.recordRuleRun({ ...run, rule_set_hash: "two" });
      assert.deepEqual(store.lastRuleRun(), { ...run, rule_set_hash: "two" });
    })],

  ["a write through the read-only handle fails, and the data is untouched", async (dir) => {
    const path = join(dir, "index.db");
    const file = join(dir, "s1.jsonl");
    write(file, [{ id: "a" }]);
    const store = openStore(path);
    await indexFiles(store, [file], parser().parse, "1");
    store.close();

    const ro = openReadOnly(path);
    assert.equal(ro.prepare("SELECT count(*) AS c FROM events").get()?.c, 1);
    assert.throws(() => ro.exec("DELETE FROM events"));
    assert.throws(() => ro.prepare("UPDATE events SET agent = ?").run("x"));
    assert.throws(() => ro.exec("DROP TABLE events"));
    assert.throws(() => ro.exec("CREATE TABLE t (x)"));
    assert.throws(() => ro.exec("PRAGMA user_version = 9"));
    const other = join(dir, "other.db");
    assert.throws(() => ro.exec(`ATTACH '${other.replaceAll("'", "''")}' AS o; CREATE TABLE o.t (x)`)); // user SQL may try
    assert.equal(existsSync(other), false);
    assert.equal(ro.prepare("SELECT count(*) AS c FROM events").get()?.c, 1);
    ro.close();

    assert.throws(() => openReadOnly(join(dir, "missing.db")));
    assert.equal(existsSync(join(dir, "missing.db")), false);
  }],

  ["replaceFindings swaps one session's findings; eventStats counts blocked and sub-agent events", (dir) =>
    withStore(dir, async (store) => {
      const file = join(dir, "s1.jsonl");
      write(file, [{ id: "a", outcome: "blocked", agent_id: "x" }, { id: "b", outcome: "success" }]);
      await indexFiles(store, [file], parser().parse, "1");
      const [a, b] = store.sessionEvents("s1");
      store.insertFindings([finding("old", [a!]), { ...finding("other", [b!]), session_id: "s2" }]);
      store.replaceFindings(["s1"], [finding("new", [b!])]);
      assert.deepEqual(store.listFindings().map((f) => f.rule_id).sort(), ["new", "other"]);
      assert.deepEqual(store.eventStats(), { blocked: 1, subagent: 1 });
      assert.deepEqual(store.eventStats(["nope"]), { blocked: 0, subagent: 0 });
    })],

  ["a set-aside copy upserting last keeps a known outcome and the original raw_ref", (dir) =>
    withStore(dir, async (store) => {
      const orig = join(dir, "s1.jsonl");
      const copy = join(dir, "s1.jsonl.superseded-1");
      write(orig, [{ id: "a", outcome: "blocked" }, { id: "b", outcome: "unknown" }]);
      write(copy, [{ id: "a", outcome: "unknown" }, { id: "b", outcome: "success" }, { id: "c" }]);
      const { parse } = parser();
      await indexFiles(store, [orig], parse, "1");
      await indexFiles(store, [orig, copy], parse, "1");
      const [a, b] = store.sessionEvents("s1").sort((x, y) => x.id.localeCompare(y.id));
      assert.equal(a?.outcome, "blocked");
      assert.equal(a?.raw_ref.file, orig);
      assert.equal(b?.outcome, "success"); // the copy may still upgrade unknown
      assert.equal(b?.raw_ref.file, orig);
      assert.equal(store.sessionEvents("s1").length, 3);
    })],

  ["WAL journal for write speed: close leaves one file, and a read-only handle reads it", async (dir) => {
    const path = join(dir, "index.db");
    const store = openStore(path);
    store.recordRuleRun({ rule_set_hash: "h", started_at: "a", finished_at: "b", events: 1, findings: 0 });
    const ro = openReadOnly(path); // while the writer is open
    assert.equal(ro.prepare("PRAGMA journal_mode").get()?.journal_mode, "wal");
    assert.equal(ro.prepare("SELECT count(*) AS c FROM rule_runs").get()?.c, 1);
    ro.close();
    store.close();
    // macOS system SQLite (used by Bun there) persists -wal/-shm by design; `purge` removes them. Node bundles its own.
    if (!(process.versions.bun && process.platform === "darwin")) assert.equal(existsSync(`${path}-wal`) || existsSync(`${path}-shm`), false);
  }],

  ["reopen after close, and delete after close (no EBUSY on Windows)", async (dir) => {
    const path = join(dir, "index.db");
    const file = join(dir, "s1.jsonl");
    write(file, [{ id: "a" }]);
    const { parse } = parser();
    let store = openStore(path);
    await indexFiles(store, [file], parse, "1");
    store.close();

    store = openStore(path);
    assert.deepEqual(ids(store), ["a"]);
    assert.equal((await indexFiles(store, [file], parse, "1")).skipped, 1);
    store.close();

    const ro = openReadOnly(path);
    ro.prepare("SELECT count(*) AS c FROM events").get();
    ro.close();

    rmSync(path);
    assert.equal(existsSync(path), false);
    store = openStore(path); // purge, then a fresh scan
    assert.deepEqual(store.listSessions(), []);
    store.close();
    rmSync(path);
  }],
];

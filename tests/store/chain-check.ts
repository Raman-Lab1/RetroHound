// The hash chain (ADR 0015), one body for both engines: tests/store/store.test.ts runs every case in Bun and in `node`.
import assert from "node:assert/strict";
import { renameSync } from "node:fs";
import { join } from "node:path";
import { createChain, GENESIS, verifyChain } from "../../src/store/chain.ts";
import { indexFiles } from "../../src/store/indexer.ts";
import { openReadOnly, openStore, type Store } from "../../src/store/index.ts";
import { MIGRATIONS } from "../../src/store/schema.ts";
import { open, type Row } from "../../src/store/sqlite.ts";
import { finding, parser, write } from "./store-check.ts";

function verify(path: string, head?: string) {
  const db = openReadOnly(path);
  try {
    return verifyChain(db, head);
  } finally {
    db.close();
  }
}
function sql(path: string, text: string): Row[] {
  const db = open(path);
  try {
    return db.prepare(text).all().map((r) => ({ ...r }));
  } finally {
    db.close();
  }
}
function ok(path: string, head?: string) {
  const v = verify(path, head);
  if (!v.ok) assert.fail(v.problem);
  return v;
}
function broken(path: string, head?: string): string {
  const v = verify(path, head);
  if (v.ok) assert.fail("verify passed on a tampered index");
  return v.problem;
}

/** A file of three events and one finding: 5 chain entries. */
async function fill(store: Store, file: string): Promise<void> {
  write(file, [{ id: "a", outcome: "unknown" }, { id: "b" }, { id: "c" }]);
  await indexFiles(store, [file], parser().parse, "p1");
  store.insertFindings([finding("rule-1", store.sessionEvents("s1").slice(0, 1))]);
}

async function indexed(dir: string, body: (store: Store, db: string, file: string) => Promise<void>): Promise<void> {
  const [db, file] = [join(dir, "index.db"), join(dir, "s1.jsonl")];
  const store = openStore(db);
  try {
    await fill(store, file);
    await body(store, db, file);
  } finally {
    store.close();
  }
}

export const CASES: [name: string, run: (dir: string) => Promise<void>][] = [
  ["every write is chained and verifies: index, findings, replace, unchanged rescan, gone and back, a rollback", (dir) =>
    indexed(dir, async (store, db, file) => {
      assert.equal(ok(db).entries, 5);
      await indexFiles(store, [file], parser().parse, "p1"); // unchanged: only last_seen moves, which is not chained
      assert.equal(ok(db).entries, 5);
      store.replaceFindings(["s1"], [finding("rule-1", store.sessionEvents("s1").slice(0, 1))]); // a delete, an insert
      assert.equal(ok(db).entries, 7);
      renameSync(file, `${file}.away`);
      assert.equal((await indexFiles(store, [], parser().parse, "p1")).gone, 1);
      assert.equal(ok(db).entries, 8);
      renameSync(`${file}.away`, file); // same size and mtime: touched, and no longer gone
      assert.equal((await indexFiles(store, [file], parser().parse, "p1")).skipped, 1);
      assert.equal(ok(db).entries, 9);
      assert.throws(() => store.transaction(() => (store.markGone(file), assert.fail("boom"))));
      store.transaction(() => store.markGone(file)); // must link to the committed head, not the rolled-back one
      assert.equal(ok(db).entries, 10);
    })],

  ["an outcome that becomes known appends that event and the file; unchanged re-upserts append nothing", (dir) =>
    indexed(dir, async (store, db, file) => {
      write(file, [{ id: "a", outcome: "success" }, { id: "b" }, { id: "c" }, { id: "d" }]);
      await indexFiles(store, [file], parser().parse, "p1");
      assert.equal(store.sessionEvents("s1")[0]?.outcome, "success");
      assert.equal(ok(db).entries, 8);
      const added = sql(db, "SELECT tbl, row_id, op FROM chain WHERE seq > 5 ORDER BY seq");
      assert.deepEqual(added.map((r) => [r.tbl, r.op]), [["events", "write"], ["events", "write"], ["files_indexed", "write"]]);
      assert.deepEqual(added.slice(0, 2).map((r) => r.row_id), ["a", "d"]);
    })],

  ["a parser-version rebuild chains each delete and re-insert, and verifies", (dir) =>
    indexed(dir, async (store, db, file) => {
      await indexFiles(store, [file], parser().parse, "p2");
      assert.equal(ok(db).entries, 12);
      assert.deepEqual(sql(db, "SELECT op FROM chain WHERE seq > 5 ORDER BY seq").map((r) => r.op), [
        ...["delete", "delete", "delete"], ...["write", "write", "write", "write"],
      ]);
    })],

  ["a row changed outside the store is named: edited, planted without an entry, deleted", (dir) =>
    indexed(dir, async (_store, db) => {
      sql(db, "UPDATE events SET outcome = 'success' WHERE id = 'a'");
      assert.match(broken(db), /^events row a: does not match chain entry \d+ \(edited outside RetroHound\)$/);
      sql(db, "UPDATE events SET outcome = 'unknown' WHERE id = 'a'");
      ok(db); // the hash is of the content: the original value verifies again
      sql(db, "UPDATE files_indexed SET gone_at = 'x' WHERE 1");
      assert.match(broken(db), /^files_indexed row .*s1\.jsonl: does not match chain entry \d+/);
      sql(db, "UPDATE files_indexed SET gone_at = NULL WHERE 1");
      sql(db, "INSERT INTO findings (id, rule_id, level, ts, session_id, message, events) VALUES ('planted', 'r', 'high', 't', 's1', 'm', '[]')");
      assert.match(broken(db), /^findings row planted: no chain entry/);
      sql(db, "DELETE FROM findings WHERE id = 'planted'");
      sql(db, "DELETE FROM events WHERE id = 'b'");
      assert.match(broken(db), /^chain entry \d+: events row b is missing \(deleted outside RetroHound\)$/);
    })],

  ["a changed chain is named: an edited entry, a removed entry, and a rebuilt chain against a recorded head", (dir) =>
    indexed(dir, async (store, db) => {
      const recorded = ok(db).head;
      store.replaceFindings(["s1"], []);
      const later = ok(db).head;
      assert.notEqual(later, recorded);
      assert.equal(ok(db, recorded).head, later); // an older head is still in the chain
      assert.equal(ok(db, GENESIS).entries, 6);
      assert.match(broken(db, "f".repeat(64)), /^head f{64} is not in the chain/);

      sql(db, "UPDATE chain SET op = 'seed' WHERE seq = 2");
      assert.match(broken(db), /^chain entry 2: hash does not match its contents/);
      sql(db, "UPDATE chain SET op = 'write' WHERE seq = 2");
      ok(db);

      const w = open(db); // someone with write access rebuilds the whole chain consistently
      w.exec("DROP TABLE chain");
      createChain(w);
      w.close();
      assert.equal(ok(db).entries, 4); // self-consistent again...
      assert.match(broken(db, later), /is not in the chain \(it was cut back or rebuilt\)$/); // ...but not the recorded head

      sql(db, "DELETE FROM chain WHERE seq = 2");
      assert.match(broken(db), /^chain entry 3: prev is not the hash of the entry before it/);
    })],

  ["an index from before the chain is seeded on upgrade, the same way every time, and verifies", async (dir) => {
    const db = join(dir, "index.db");
    const store = openStore(db);
    await fill(store, join(dir, "s1.jsonl"));
    store.close();
    const downgrade = () => {
      sql(db, "DROP TABLE chain"); // the v2 shape: v3 only adds the chain, v4 the config snapshots, v5 the run scope
      sql(db, "DROP TABLE config_snapshots");
      sql(db, "ALTER TABLE rule_runs DROP COLUMN config_items");
      sql(db, "ALTER TABLE rule_runs DROP COLUMN scope"); // v5
      sql(db, "PRAGMA user_version = 2");
    };
    downgrade();
    openStore(db).close();
    const first = ok(db);
    assert.equal(first.entries, 5);
    assert.deepEqual(sql(db, "SELECT DISTINCT op FROM chain").map((r) => r.op), ["seed"]);
    assert.equal(sql(db, "PRAGMA user_version")[0]?.user_version, MIGRATIONS.length);
    downgrade();
    openStore(db).close();
    assert.equal(ok(db).head, first.head);
  }],
];

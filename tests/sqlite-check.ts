// Adapter behaviour, one body for both engines: tests/sqlite.test.ts runs it in Bun and in a real `node` process.
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { open } from "../src/store/sqlite.ts";

export function check(path: string): void {
  const db = open(path);
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, n INTEGER, b BLOB); CREATE INDEX t_name ON t (name);");
  db.exec("PRAGMA user_version = 3");

  const insert = db.prepare("INSERT INTO t (name, n, b) VALUES (?, ?, ?)");
  db.exec("BEGIN");
  const first = insert.run("a", 1, null);
  insert.run("b", 2 ** 53 - 1, new Uint8Array([1, 2]));
  db.exec("COMMIT");
  assert.equal(Number(first.changes), 1);
  assert.equal(Number(first.lastInsertRowid), 1);

  const one = db.prepare("SELECT id, name, n, b FROM t WHERE name = ?");
  assert.deepEqual({ ...one.get("a") }, { id: 1, name: "a", n: 1, b: null });
  const blobRow = one.get("b");
  assert.equal(blobRow?.n, 2 ** 53 - 1);
  assert.deepEqual([...(blobRow?.b as Uint8Array)], [1, 2]);
  assert.equal(one.get("missing"), undefined);
  assert.deepEqual(one.all("missing"), []);

  const all = db.prepare("SELECT name FROM t ORDER BY id").all();
  assert.deepEqual(all.map((r) => r.name), ["a", "b"]);
  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 3);
  db.close();

  const ro = open(path, { readonly: true });
  assert.equal(ro.prepare("SELECT count(*) AS c FROM t").get()?.c, 2);
  assert.throws(() => ro.exec("DELETE FROM t"));
  assert.throws(() => ro.prepare("INSERT INTO t (name) VALUES (?)").run("x"));
  assert.throws(() => ro.exec("DROP TABLE t"));
  assert.equal(ro.prepare("SELECT count(*) AS c FROM t").get()?.c, 2);
  ro.close();

  rmSync(path); // `purge` deletes the DB: close must release the file, which Windows enforces
  assert.throws(() => open(path, { readonly: true }));
  assert.equal(existsSync(path), false);
}

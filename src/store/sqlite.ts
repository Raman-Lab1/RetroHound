// The only file allowed to touch bun:sqlite / node:sqlite (ADR 0002). Rules for callers:
// plain positional `?` params only (Node 22.13 reads numbered `?N` params as named and cannot bind them), explicit
// BEGIN/COMMIT around batches, no integers above 2^53, and no booleans or
// undefined as params (Node throws where Bun would not; SqlValue keeps them out, so map optional fields to null).
// Rows from Node have a null prototype: read fields, don't compare whole rows.
import { createRequire } from "node:module";

export type SqlValue = string | number | bigint | Uint8Array | null;
export type Row = Record<string, SqlValue>;
export type RunResult = { changes: number | bigint; lastInsertRowid: number | bigint };

export type Statement = {
  run(...params: SqlValue[]): RunResult;
  get(...params: SqlValue[]): Row | undefined; // undefined when no row matches, on both engines
  all(...params: SqlValue[]): Row[];
};

export type Db = {
  prepare(sql: string): Statement;
  exec(sql: string): void; // may hold several statements
  close(): void;
};

type Engine = {
  prepare(sql: string): {
    run(...params: SqlValue[]): RunResult;
    get(...params: SqlValue[]): Row | null | undefined;
    all(...params: SqlValue[]): Row[];
    finalize?(): void; // Bun only
  };
  exec(sql: string): unknown;
  close(): void;
};
type EngineClass = new (path: string, options?: object) => Engine;

const require = createRequire(import.meta.url);

function connect(path: string, readonly: boolean): Engine {
  if (process.versions.bun) {
    // On macOS Bun uses the system SQLite, which keeps -wal/-shm after close; a read-only open needs them there.
    const { Database } = require("bun:sqlite") as { Database: EngineClass };
    return readonly ? new Database(path, { readonly: true }) : new Database(path);
  }
  const m = require("node:sqlite") as { Database?: EngineClass; DatabaseSync: EngineClass };
  return new (m.Database ?? m.DatabaseSync)(path, { readOnly: readonly }); // DEP0210 rename
}

/** Opens `path`, creating it unless `readonly`. Writes through a readonly handle throw, and so does a missing file. */
export function open(path: string, { readonly = false }: { readonly?: boolean } = {}): Db {
  const db = connect(path, readonly);
  const prepared: ReturnType<Engine["prepare"]>[] = [];
  return {
    prepare(sql) {
      const s = db.prepare(sql);
      prepared.push(s);
      return {
        run: (...params) => s.run(...params),
        get: (...params) => s.get(...params) ?? undefined,
        all: (...params) => s.all(...params),
      };
    },
    exec(sql) {
      db.exec(sql);
    },
    close() {
      for (const s of prepared) s.finalize?.(); // Bun holds the file open past close() otherwise
      db.close();
    },
  };
}

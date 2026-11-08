// `retrohound query "<SQL>"`: read-only SQL over the index (ADR 0002). The handle is opened read-only, so a write
// fails inside SQLite rather than by filtering text; every string is masked again on the way out (0007).
import { mask } from "../normalize/mask.ts";
import { defaultDbPath, openReadOnly } from "../store/index.ts";
import type { Row } from "../store/sqlite.ts";
import { oneOf, UsageError, type IO, type Registrar } from "./io.ts";

const cell = (v: Row[string]): string | number | null =>
  typeof v === "string" ? mask(v) : typeof v === "bigint" ? Number(v) : v instanceof Uint8Array ? "<blob>" : v;

function runQuery(sql: string, format: string, dbPath: string, io: IO): number {
  const fmt = oneOf("format", format, ["table", "json"] as const);
  let rows: Record<string, string | number | null>[];
  try {
    const db = openReadOnly(dbPath);
    try {
      rows = db.prepare(sql).all().map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [mask(k), cell(v)])));
    } finally {
      db.close();
    }
  } catch (e) {
    throw new UsageError(`query failed: ${mask((e as Error).message)}`); // a missing index lands here too
  }
  if (fmt === "json") return io.out(JSON.stringify(rows, null, 2) + "\n"), 0;
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const text = (r: Record<string, unknown>, c: string) => String(r[c] ?? "NULL").replace(/\s+/g, " ");
  const width = cols.map((c) => Math.min(60, Math.max(c.length, ...rows.map((r) => text(r, c).length))));
  const fit = (s: string, i: number) => (s.length > width[i]! ? s.slice(0, width[i]! - 1) + "…" : s.padEnd(width[i]!));
  io.out([cols.map(fit).join("  "), ...rows.map((r) => cols.map((c, i) => fit(text(r, c), i)).join("  ")), `(${rows.length} rows)`].join("\n") + "\n");
  return 0;
}

export const registerQuery: Registrar = (program, run, io) => {
  program.command("query <sql>").description("Run read-only SQL over the index (tables: events, sessions, findings, files_indexed)")
    .option("--format <format>", "table or json", "table")
    .option("--db <path>", "index database", defaultDbPath())
    .action((sql: string, f: { format: string; db: string }) => run(() => runQuery(sql, f.format, f.db, io)));
};

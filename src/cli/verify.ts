// `retrohound verify`: checks the index's hash chain (ADR 0015) through a read-only handle. Exit 0 with the head to
// record elsewhere, or 1 with the first entry or row that does not add up.
import { existsSync } from "node:fs";
import { mask } from "../normalize/mask.ts";
import { verifyChain } from "../store/chain.ts";
import { defaultDbPath, openReadOnly } from "../store/index.ts";
import { MIGRATIONS, schemaProblem } from "../store/schema.ts";
import { UsageError, type IO, type Registrar } from "./io.ts";

function verify(dbPath: string, head: string | undefined, io: IO): number {
  if (head !== undefined && !/^[0-9a-f]{64}$/i.test(head)) throw new UsageError(`bad --head '${mask(head)}' (expected 64 hex characters)`);
  if (!existsSync(dbPath)) throw new UsageError(`no index at ${dbPath}, run \`retrohound scan\` first`);
  const db = openReadOnly(dbPath);
  try {
    const version = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
    // scan refuses another program's database too, so advising it to upgrade would be wrong
    if (version === 0 || !db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'files_indexed'").get())
      throw new UsageError(`${dbPath} is not a RetroHound index`);
    if (version !== MIGRATIONS.length) {
      const fix = version < MIGRATIONS.length ? ": run `retrohound scan` once to upgrade it, which starts the chain" : "";
      throw new UsageError(`index schema version ${version}, this RetroHound verifies ${MIGRATIONS.length}${fix}`);
    }
    const problem = schemaProblem(db); // a trigger can drop rows before the chain sees them
    const v = problem ? { ok: false as const, problem } : verifyChain(db, head?.toLowerCase());
    // A head can't refuse entries appended after it, so show them: an events delete outside a parser upgrade stands out,
    // and an events rewrite is history changed after the head (a rescan resolving an outcome is one too).
    const since = v.ok && v.since
      ? `added since the recorded head: ${Object.entries(v.since).sort().map(([k, n]) => `${k} ×${n}`).join(", ") || "nothing"}\n` : "";
    io.out(mask(v.ok ? `ok: ${v.entries} entries, head ${v.head}\n${since}` : `broken: ${v.problem}\n`));
    return v.ok ? 0 : 1;
  } finally {
    db.close();
  }
}

export const registerVerify: Registrar = (program, run, io) => {
  program.command("verify").description("Check the index's hash chain; prints the head to record elsewhere")
    .option("--db <path>", "index database", defaultDbPath())
    .option("--head <hash>", "a head printed by an earlier verify: fail unless it is still in the chain")
    .action((f: { db: string; head?: string }) => run(() => verify(f.db, f.head, io)));
};

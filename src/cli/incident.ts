// `retrohound incident <session-id|finding-id>`: one folder to hand an incident responder (docs/incident.md).
// Read-only on the index, so it works the same on archived sessions (ADR 0008).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderIncidentHtml } from "../incident/html.ts";
import { buildPack, type Selection } from "../incident/pack.ts";
import { mask } from "../normalize/mask.ts";
import { defaultDbPath, openReadOnly } from "../store/index.ts";
import type { Db } from "../store/sqlite.ts";
import { DEFAULT_RULES_DIR } from "../version.ts";
import { UsageError, type IO, type Registrar } from "./io.ts";
import { EXTRA_HELP, loadRuleDir, repeat } from "./rules.ts";

type Flags = { out?: string; db: string; rules: string; extraRules?: string[]; anonymize?: boolean };

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** An unambiguous prefix of a session id or a finding id. A finding selects the session(s) of its events. */
function select(db: Db, prefix: string): Selection {
  const hits = db.prepare(`SELECT 'session' AS kind, session_id AS id FROM sessions WHERE substr(session_id, 1, length(?)) = ?
    UNION ALL SELECT 'finding', id FROM findings WHERE substr(id, 1, length(?)) = ? ORDER BY 1 DESC, 2 LIMIT 11`).all(prefix, prefix, prefix, prefix);
  if (hits.length === 0) throw new UsageError(`no session or finding id starts with '${prefix}'`);
  if (hits.length > 1) {
    const list = hits.slice(0, 10).map((x) => `  ${x.kind} ${x.id}`).join("\n");
    throw new UsageError(`'${prefix}' is ambiguous, it matches ${hits.length > 10 ? "more than 10" : hits.length} ids:\n${list}`);
  }
  const { kind, id } = hits[0] as { kind: Selection["kind"]; id: string };
  if (kind === "session") return { kind, id, sessions: [id] };
  const f = db.prepare("SELECT session_id, events FROM findings WHERE id = ?").get(id)!;
  const events = JSON.parse(String(f.events)) as { session_id: string }[];
  return { kind, id, sessions: [...new Set([String(f.session_id), ...events.map((e) => e.session_id)])].sort() };
}

function incident(prefix: string, f: Flags, io: IO): number {
  if (!existsSync(f.db)) throw new UsageError(`no index at ${f.db}, run \`retrohound scan\` first`);
  const rules = loadRuleDir(f.rules, f.extraRules).rules;
  const db = openReadOnly(f.db);
  try {
    const sel = select(db, prefix);
    const out = f.out ?? `retrohound-incident-${sel.id.slice(0, 8)}`;
    // Never mixes with other files: a pack is only trustworthy if the folder holds nothing but what manifest.json lists.
    if (existsSync(out) && (!statSync(out).isDirectory() || readdirSync(out).length)) {
      throw new UsageError(`${out} exists and is not an empty directory; pass --out with a new or empty one`);
    }
    const pack = buildPack(db, sel, rules, Boolean(f.anonymize));
    const files: [string, string][] = [
      ["incident.json", JSON.stringify(pack, (_k, v: unknown) => (typeof v === "string" ? mask(v) : v), 2) + "\n"],
      ["index.html", renderIncidentHtml(pack)],
    ];
    const manifest = { schema: "retrohound.incident-manifest/0.1", files: files.map(([path, text]) => ({ path, sha256: sha256(text) })) };
    files.push(["manifest.json", JSON.stringify(manifest, null, 2) + "\n"]);
    mkdirSync(out, { recursive: true, mode: 0o700 }); // masked evidence: private like the index (0008)
    for (const [name, text] of files) writeFileSync(join(out, name), text, { mode: 0o600, flag: "wx" });
    io.out(mask(`wrote ${out}: ${pack.sessions.length} session(s), ${pack.counts.events} events, ${pack.findings.length} findings\n`));
    return 0;
  } finally {
    db.close();
  }
}

export const registerIncident: Registrar = (program, run, io) => {
  program.command("incident <id>").description("Write an incident pack (incident.json, index.html, manifest.json) for a session or finding id prefix")
    .option("--out <dir>", "new or empty directory to write (default ./retrohound-incident-<id>)")
    .option("--anonymize", "hash project names, user name and project dirs in paths and commands")
    .option("--db <path>", "index database", defaultDbPath())
    .option("--rules <dir>", "rules directory, for rule names and hashes", DEFAULT_RULES_DIR)
    .option("--extra-rules <dir>", EXTRA_HELP, repeat)
    .action((id: string, f: Flags) => run(() => incident(id, f, io)));
};

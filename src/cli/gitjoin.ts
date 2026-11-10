// `retrohound git-secrets`: secrets an agent saw that are also in a project's local history. Exit 1 when any is.
import { existsSync } from "node:fs";
import { joinSecrets } from "../gitjoin.ts";
import { mask } from "../normalize/mask.ts";
import { defaultDbPath } from "../store/index.ts";
import { oneOf, UsageError, type IO, type Registrar } from "./io.ts";

async function gitSecrets(f: { project?: string; db: string; format: string }, io: IO): Promise<number> {
  const fmt = oneOf("format", f.format, ["table", "json"] as const);
  if (!existsSync(f.db)) throw new UsageError(`no index at ${f.db}, run \`retrohound scan\` first`);
  const r = await joinSecrets(f.db, f.project);
  // fingerprints, kinds, short shas and dates carry no secret; paths and file names are masked like everywhere else
  const hits = r.hits.map((h) => ({ ...h, project: mask(h.project), file: mask(h.file) }));
  const summary = { agent_seen_secrets: r.secrets, projects_scanned: r.scanned.length, projects_skipped: r.skipped.map(mask) };
  if (fmt === "json") io.out(JSON.stringify({ hits, ...summary }, null, 2) + "\n");
  else {
    const rows = hits.map((h) => `${h.fp}  ${h.kinds.join(",")}  ${h.project}  ${h.commit}  ${h.file}  ${h.date}  ${h.sessions.join(",")}`);
    io.out([...(rows.length ? ["fingerprint  kind  project  commit  file  date  sessions", ...rows] : []),
      `${hits.length} commit(s) hold a secret the agent saw; ${r.secrets} secret(s) checked in ${r.scanned.length} project(s), ` +
      `${r.skipped.length} skipped (missing or not a repository)`].join("\n") + "\n");
  }
  return hits.length ? 1 : 0;
}

export const registerGitSecrets: Registrar = (program, run, io) => {
  program.command("git-secrets").description("Find secrets an agent saw that were committed to the project's local history")
    .option("--project <substr>", "only sessions whose project path contains this")
    .option("--db <path>", "index database", defaultDbPath())
    .option("--format <format>", "table or json", "table")
    .action((f: { project?: string; db: string; format: string }) => run(() => gitSecrets(f, io)));
};

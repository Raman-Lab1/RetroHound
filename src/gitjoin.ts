// Did a secret the agent saw get committed? Joins the index's secret fingerprints against the local history of each
// project those sessions ran in. Same detector and fingerprint as the parser (ADR 0007), so a hit is the same secret;
// only fingerprints and kinds leave this module, never a value.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { secretFingerprints } from "./normalize/mask.ts";
import { openReadOnly } from "./store/index.ts";

export type Seen = { kinds: Set<string>; sessions: Set<string>; first_ts: string };
export type Hit = { fp: string; kinds: string[]; project: string; commit: string; file: string; date: string; sessions: string[] };
export type JoinResult = { hits: Hit[]; secrets: number; scanned: string[]; skipped: string[] };

/** Fingerprints the agent saw (with kinds, sessions, first ts) and the projects of the sessions carrying them. */
export function seenSecrets(dbPath: string, project?: string): { seen: Map<string, Seen>; projects: string[] } {
  const db = openReadOnly(dbPath);
  try {
    const rows = db.prepare(`SELECT j.value AS fp, e.secret_kinds AS kinds, e.session_id AS sid, e.ts, s.project_path AS project
      FROM events e JOIN json_each(e.secret_fps) j JOIN sessions s ON s.session_id = e.session_id
      WHERE e.secret_fps IS NOT NULL ORDER BY e.ts`).all();
    const seen = new Map<string, Seen>();
    const projects = new Set<string>();
    for (const r of rows) {
      if (project !== undefined && !String(r.project ?? "").includes(project)) continue;
      const fp = String(r.fp);
      const s = seen.get(fp) ?? { kinds: new Set(), sessions: new Set(), first_ts: String(r.ts) };
      for (const k of JSON.parse(String(r.kinds ?? "[]")) as string[]) s.kinds.add(k);
      s.sessions.add(String(r.sid));
      seen.set(fp, s);
      if (r.project) projects.add(String(r.project));
    }
    return { seen, projects: [...projects].sort() };
  } finally {
    db.close();
  }
}

/** Streams `git log -p --all` of `dir`, calling `found` for every wanted fingerprint in added lines or a commit message.
 * Resolves false when `dir` is not a work tree (or missing), or git is not installed. */
export async function scanHistory(dir: string, wanted: Set<string>, found: (fp: string, commit: string, file: string, date: string) => void): Promise<boolean> {
  const git = spawn("git", ["-C", dir, "log", "-p", "--all", "--no-color", "--no-ext-diff", "--no-textconv", "--date=iso-strict",
    "--pretty=medium", "--no-show-signature", "--src-prefix=a/", "--dst-prefix=b/"], { // the repo's config must not change the format
    stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" }, // a partial clone must not fetch blobs
  });
  const lines = createInterface({ input: git.stdout! });
  // no git (spawn 'error'): stdout never ends (Bun), so close the reader and skip the project
  const exit = new Promise<number>((ok) => (git.on("error", () => (lines.close(), ok(1))), git.on("close", (c) => ok(c ?? 1))));
  let commit = "", date = "", file = "", inHunk = false;
  let buf: string[] = [];
  const flush = (where: string) => {
    // the whole added text of one file at once, so a multi-line key block matches as it did in the transcript
    if (buf.length) for (const fp of secretFingerprints(buf.join("\n"))) if (wanted.has(fp)) found(fp, commit, where, date);
    buf = [];
  };
  for await (const line of lines) {
    if (line.startsWith("commit ")) {
      flush(file || "(commit message)"), (file = ""), (inHunk = false), (commit = line.split(" ")[1]!.slice(0, 12)), (date = "");
    } else if (line.startsWith("diff --git ")) {
      flush(file || "(commit message)"), (file = ""), (inHunk = false);
    } else if (inHunk) {
      if (line.startsWith("+")) buf.push(line.slice(1));
    } else if (line.startsWith("@@")) inHunk = true;
    else if (line.startsWith("+++ ")) file = line.slice(4).replace(/^b\//, "");
    else if (line.startsWith("Date:")) date = line.slice(5).trim();
    else if (!file && line.startsWith("    ")) buf.push(line.slice(4)); // message lines are indented by four spaces
  }
  flush(file || "(commit message)");
  return (await exit) === 0;
}

export async function joinSecrets(dbPath: string, project?: string): Promise<JoinResult> {
  const { seen, projects } = seenSecrets(dbPath, project);
  const res: JoinResult = { hits: [], secrets: seen.size, scanned: [], skipped: [] };
  const key = new Set<string>();
  for (const p of seen.size ? projects : []) {
    // ponytail: whole history every run, one project at a time; fine for typical repos, slow on huge monorepos
    const ok = await scanHistory(p, new Set(seen.keys()), (fp, commit, file, date) => {
      if (key.has(`${fp} ${commit} ${file}`)) return;
      key.add(`${fp} ${commit} ${file}`);
      const s = seen.get(fp)!;
      res.hits.push({ fp, kinds: [...s.kinds], project: p, commit, file, date, sessions: [...s.sessions] });
    });
    (ok ? res.scanned : res.skipped).push(p);
  }
  return res;
}

// `retrohound wrapped`: the shareable card, built from the index only (no transcript re-read).
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename } from "node:path";
import type { AgentEvent, Finding, Level } from "../normalize/types.ts";
import { LEVELS } from "../normalize/types.ts";
import { renderWrapped, renderWrappedSvg, type WrappedData } from "../outputs/wrapped.ts";
import { DEFAULT_RULES_DIR } from "../scan.ts";
import { defaultDbPath, openStore } from "../store/index.ts";
import { parseSince, UsageError, type IO, type Registrar } from "./io.ts";
import { EXTRA_HELP, loadRuleDir, repeat } from "./rules.ts";

type Flags = { since: string; anonymize?: boolean; out: string; db: string; rules: string; extraRules?: string[] };

const rank = (l: Level) => LEVELS.indexOf(l);
const top = (m: Map<string, number>, n: number) => [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
// Directory names under a home that say nothing about who or which client; every other one is hashed.
const KEEP = new Set(["desktop", "documents", "downloads", "library", "applications", "appdata", "projects", "code", "dev",
  "work", "workspace", "repos", "git", "src", "lib", "test", "tests", "docs", "bin", "dist", "build", "node_modules",
  // credential files with no extension: the reads an investigator most needs to see
  "credentials", "config", "known_hosts", "authorized_keys", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"]);
const HOME = String.raw`([\\/](?:Users|home)|(?<![\w~])~|\$\{?HOME\}?|%USERPROFILE%)`;
const UNDER_HOME = new RegExp(HOME + String.raw`([\\/][^\s"'${"`"}<>|;&(),=:]*)`, "gi");
// inside "..." or '...' a path runs to the closing quote, spaces included; unquoted it stops at the first space (a limit)
const QUOTED_HOME = new RegExp(String.raw`(["'])` + HOME + String.raw`([\\/][^"'\n]*)(?=\1)`, "gi");
// a field that is only a path: everything after the home is path, spaces included
const PATH_HOME = new RegExp(HOME + String.raw`([\\/].*)`, "is");
export type Anonymizer = ((s: string) => string) & { host: (h: string) => string; path: (s: string) => string };

const LOCAL = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?|0\.0\.0\.0)$/i;
const FORGE = /(github|gitlab|bitbucket|codeberg|sr\.ht)/i;
const URL_RE = /\b([a-z][a-z0-9+.-]*:\/\/)(?:([^\s/@"'`<>]*)@)?(\[[^\]\s]+\]|[^\s/:?#"'`<>]+)((?::\d+)?)((?:\/[^\s"'`<>;|&()]*)?)/gi;
const SCP_RE = /\b([\w.-]+@)([\w.-]+):(?!\/\/)([^\s"'`<>;|&()]*)/g;
// host:path with no user@, only inside scp/rsync arguments (a bare a:b elsewhere is not a host)
const BARE_RE = /\b(scp|rsync)\b([^;|&\n]*)/g;
const BARE_ARG = /(^|\s)(?![\w]:[\\/])([A-Za-z0-9][\w.-]*):(?!\/\/)(?=[^\s"'`<>;|&()]*)([^\s"'`<>;|&()]*)/g;
const OPT_RE = /(-[lJWo])(\s*)(\S+)/g;
const SSH_RE = /\b(ssh|sftp)((?:\s+-[iplJoFLRDEeBbcmWwOSQ]\s*\S+|\s+-[A-Za-z]+)*)\s+(?:([\w.-]+)@)?([\w.-]+)/g;

/** Project names, the user name, the encoded project dir (ADR 0014) and other dirs under a home replaced by hashes,
 * longest first. Keyed with a random key per call, so ids are stable in one pack or card but cannot be confirmed with
 * a word list or linked across shares. */
export function anonymizer(events: Pick<AgentEvent, "raw_ref">[], projects: string[]): Anonymizer {
  const key = randomBytes(32);
  const hash = (s: string) => `anon-${createHmac("sha256", key).update(s.toLowerCase()).digest("hex").slice(0, 12)}`;
  // a dotfile or a name with an extension (.env, x.ts) is kept: generic, and what an investigator needs
  const part = (c: string) => (c.includes(".") || c.startsWith("anon-") || KEEP.has(c.toLowerCase()) ? c : hash(c));
  const under = (head: string, rest: string) => head + rest.split(/([\\/]+)/).map((c, i) => (i % 2 || !c ? c : part(c))).join("");
  const dirs = (s: string) => s.replace(QUOTED_HOME, (_m, q: string, head: string, rest: string) => q + under(head, rest))
    .replace(UNDER_HOME, (_m, head: string, rest: string) => under(head, rest));
  const tokens = new Set<string>([basename(homedir()), userInfo().username]);
  for (const p of projects) {
    tokens.add(p);
    tokens.add(basename(p.replace(/[\\/]+$/, "").replace(/\\/g, "/")));
    const user = /(?:home|Users)[\\/]+([^\\/]+)/i.exec(p)?.[1];
    if (user) tokens.add(user);
  }
  for (const e of events) {
    const enc = /projects[\\/]+([^\\/]+)/.exec(e.raw_ref.file)?.[1];
    if (enc) tokens.add(enc);
  }
  const list = [...tokens].filter((t) => t.length >= 3).sort((a, b) => b.length - a.length);
  const re = list.length ? new RegExp(list.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gi") : undefined;
  const host = (h: string) => (LOCAL.test(h) || /^anon-\w+\.invalid$/.test(h) ? h : `${hash(h)}.invalid`);
  const repo = (h: string, path: string) => // owner/repo on a git forge says who and what; keep the rest of the path
    FORGE.test(h) ? path.replace(/^(\/?)([^/\s]+)\/([^/\s]+?)(\.git)?(?=$|[/?#])/, (_m, sl, o, r, g) => `${sl}${hash(o)}/${hash(r)}${g ?? ""}`) : path;
  const hostUser = (v: string) => v.replace(/^(?:([^@\s]+)@)?([^@\s:]+)(.*)$/, (_m, u: string | undefined, h: string, r: string) => `${u === undefined ? "" : `${hash(u)}@`}${host(h)}${r}`);
  // -l is a login name, -J/-W name hosts, -o carries User/HostName/ProxyJump; other option values stay as they are
  const optVal = (f: string, v: string) => f === "-l" ? hash(v) : f === "-J" ? v.split(",").map(hostUser).join(",") : f === "-W" ? hostUser(v)
    : f === "-o" ? v.replace(/^(user)=(.+)$/i, (_m, k: string, x: string) => `${k}=${hash(x)}`).replace(/^(hostname|proxyjump)=(.+)$/i, (_m, k: string, x: string) => `${k}=${x.split(",").map(hostUser).join(",")}`) : v;
  const hosts = (s: string) => s
    .replace(URL_RE, (_m, sch: string, user: string | undefined, h: string, port: string, path: string) =>
      `${sch}${user === undefined ? "" : `${hash(user)}@`}${host(h)}${port}${repo(h, path)}`)
    .replace(SCP_RE, (_m, user: string, h: string, path: string) => `${hash(user.slice(0, -1))}@${host(h)}:${repo(h, path)}`)
    .replace(BARE_RE, (_m, cmd: string, args: string) => cmd + args.replace(BARE_ARG, (_a, sp: string, h: string, rest: string) => `${sp}${host(h)}:${repo(h, rest)}`))
    .replace(SSH_RE, (_m, cmd: string, opts: string, user: string | undefined, h: string) =>
      `${cmd}${opts.replace(OPT_RE, (_o, f: string, sp: string, v: string) => `${f}${sp}${optVal(f, v)}`)} ${user === undefined ? "" : `${hash(user)}@`}${host(h)}`);
  const names = (s: string) => (re ? s.replace(re, hash) : s);
  const path = (s: string) => hosts(names(s).replace(PATH_HOME, (_m, head: string, rest: string) => under(head, rest)));
  return Object.assign((s: string) => hosts(dirs(names(s))), { host, path });
}

function riskiest(findings: Finding[]): { session: string; findings: number; level: Level } | undefined {
  const by = new Map<string, Finding[]>();
  for (const f of findings) by.set(f.session_id, [...(by.get(f.session_id) ?? []), f]);
  const score = (fs: Finding[]) => Math.max(...fs.map((f) => rank(f.level))) * 1000 + fs.length;
  const best = [...by].sort((a, b) => score(b[1]) - score(a[1]))[0];
  return best && { session: best[0], findings: best[1].length, level: LEVELS[Math.max(...best[1].map((f) => rank(f.level)))]! };
}

export function collect(dbPath: string, rulesDir: string, since: string, anonymize: boolean, extras: string[] = []): WrappedData {
  const store = openStore(dbPath);
  try {
    const sessions = store.listSessions().filter((s) => s.last_ts >= since);
    const ids = new Set(sessions.map((s) => s.session_id));
    const events = sessions.flatMap((s) => store.sessionEvents(s.session_id));
    const findings = store.listFindings().filter((f) => ids.has(f.session_id));
    const names = new Map(loadRuleDir(rulesDir, extras).rules.map((r) => [r.id, r.name ?? r.title]));
    const same = (s: string) => s;
    const fix = anonymize ? anonymizer(events, sessions.map((s) => s.project_path ?? "").filter(Boolean)) : Object.assign(same, { host: same, path: same });
    const domains = new Map<string, number>();
    const rules = new Map<string, number>();
    const levels = new Map<string, string>();
    for (const e of events) if (e.domain) bump(domains, e.domain);
    for (const f of findings) {
      const n = names.get(f.rule_id) ?? f.rule_id;
      bump(rules, n);
      if (rank(f.level) >= rank((levels.get(n) ?? "informational") as Level)) levels.set(n, f.level);
    }
    const hot = findings.filter((f) => f.events[0]?.command_line).sort((a, b) => rank(b.level) - rank(a.level))[0];
    const r = riskiest(findings);
    const proj = r && sessions.find((s) => s.session_id === r.session)?.project_path;
    const stats = store.eventStats([...ids]);
    return {
      period: `since ${since.slice(0, 10)}`, anonymized: anonymize,
      sessions: sessions.length,
      hours: Math.round(sessions.reduce((t, s) => t + (Date.parse(s.last_ts) - Date.parse(s.first_ts)), 0) / 360_000) / 10, // shortcut: wall-clock span, idle gaps included
      commands: events.filter((e) => e.category === "process_creation").length,
      files: new Set(events.filter((e) => (e.category === "file_access" || e.category === "file_event") && e.target_path).map((e) => e.target_path)).size,
      secretsTouched: events.filter((e) => e.secret_kinds?.length || e.result_secret_kinds?.length).length,
      blocked: stats.blocked,
      subagentPct: events.length ? Math.round((stats.subagent * 100) / events.length) : 0,
      domains: top(domains, 10).map(([name, count]) => ({ name: fix.host(name), count })),
      rules: top(rules, 5).map(([name, count]) => ({ name: fix(name), level: levels.get(name) ?? "", count })),
      riskiest: r && { ...r, session: r.session.slice(0, 8), project: fix.path(proj ?? "-") },
      spiciest: hot && { command: fix(hot.events[0]!.command_line!), rule: fix(names.get(hot.rule_id) ?? hot.rule_id), level: hot.level },
    };
  } finally {
    store.close();
  }
}

function wrapped(f: Flags, io: IO): number {
  if (f.out.toLowerCase().endsWith(".png")) {
    io.err("PNG output is not supported (it would need a browser dependency); use --out card.svg and convert it\n");
    return 2;
  }
  if (!existsSync(f.db)) throw new UsageError(`no index at ${f.db}, run \`retrohound scan\` first`); // openStore would create it
  const data = collect(f.db, f.rules, parseSince(f.since), Boolean(f.anonymize), f.extraRules);
  writeFileSync(f.out, f.out.toLowerCase().endsWith(".svg") ? renderWrappedSvg(data) : renderWrapped(data));
  io.out(`wrote ${f.out}\n`);
  return 0;
}

export const registerWrapped: Registrar = (program, run, io) => {
  program.command("wrapped").description("Write a shareable, self-contained HTML report card from the index")
    .option("--since <when>", "window: 30d, 12h or a date", "365d")
    .option("--anonymize", "hash project names, user names and dirs under a home (and URL and ssh hosts, git owner/repo)")
    .option("--out <file>", "output file (.html, or .svg for a 1200x630 share card)", "wrapped.html")
    .option("--db <path>", "index database", defaultDbPath())
    .option("--rules <dir>", "rules directory, for rule names", DEFAULT_RULES_DIR)
    .option("--extra-rules <dir>", EXTRA_HELP, repeat)
    .action((f: Flags) => run(() => wrapped(f, io)));
};

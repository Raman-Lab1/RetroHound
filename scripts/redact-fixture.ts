// Turns real Claude Code transcripts into committable fixtures: `bun scripts/redact-fixture.ts <in.jsonl|dir> <out>`.
// Keeps JSON structure, line types, tool names, ids, timestamps and command shape. Replaces usernames, project names,
// hostnames, web domains, git remote owners, emails, public IPs and free text (prompts, replies, tool output, file bodies, any other
// string with whitespace, heredoc bodies and quoted messages in commands), pseudonymises uuids and agent ids, and
// masks secrets with mask().
// Pseudonyms are consistent across every file of one run. Output is still worth a read before it is committed.
// shortcut: hostnames = *.local/.lan/.internal/.corp/.home names plus `--drop <word>`; no way to know others.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { mask } from "../src/normalize/mask.ts";

const FREE = new Set([
  "text", "thinking", "content", "description", "prompt", "lastPrompt", "customTitle", "aiTitle", "title", "summary",
  "stdout", "stderr", "old_string", "new_string", "new_source", "output", "message_text", "plan", "lines", "originalFile",
  "addedLines", "oldString", "newString", "signature", "data", "base64",
]);
// Kept (cleaned) even with spaces. Any other string with whitespace or over MAX_TOKEN chars is free text: default deny,
// because new transcript fields keep appearing (systemPrompt, serverClassifierRequest, AskUserQuestion answers...).
const KEEP = new Set([
  "command", "cwd", "file_path", "filePath", "notebook_path", "path", "filename", "name", "url", "persistedOutputPath",
  "attributionMcpServer", "attributionSkill", "attributionPlugin", "server",
]);
const MAX_TOKEN = 200;
const IDS = new Set(["accountUuid", "organizationUuid"]);
// A heredoc body in a command is file content or a script: the delimiters stay, the body goes.
const HEREDOC_BODY = /(<<-?\s*(['"]?)(\w+)\2[^\n]*\n)([\s\S]*?)(\n[ \t]*\3(?=[\s);&|'"]|$))/g;
// A quoted string in a command holding three words or more is a message (commit, echo, --description), not shape.
const QUOTED = /"(?:[^"\\]|\\.)*"|'[^']*'/g;
const WORDS = /[A-Za-z]{2,}(?:[ ,]+[A-Za-z]{2,}){2,}/;
const COMMENT = /(^|\s)#(?![!{])([^\n]*)/g; // shell comments, same rule
const CONTAINERS = new Set(["desktop", "documents", "projects", "src", "repos", "dev", "code", "work", "github", "git", "source"]);
const NOT_PROJECTS = new Set(["library", "applications", "downloads", "pictures", "movies", "music", "public", "home"]);
// Case-sensitive: `src/users/dto` is no home. Names are word characters, dots and dashes only.
const HOME = /(?:^|[\\/])(?:Users|home)[\\/]([\w.-]+)((?:[\\/][\w.-]+){0,2})/g;
const REMOTE = /^([\w.-]+)\/([\w.-]+)$/; // git_state remotes: "owner/repo"
const ENCODED = /(?:^|[^\w])-?(?:[A-Za-z]-)?-Users-([A-Za-z0-9_.]+)-/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const HOSTNAME = /(?<![\w.-])[\w-]+\.(?:local|lan|internal|corp|home)(?![\w.-])/gi; // not `.env.local`, `settings.local.json`
const PATHS = new Set(["cwd", "file_path", "filePath", "notebook_path", "path", "filename", "persistedOutputPath"]);
const UUID = /(?<![0-9A-Za-z])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9A-Za-z])/gi;
// Agent ids (`a0123456789abcdef`, `aplanner-0123456789abcdef`) and the session prefix in team names (`session-1a2b3c4d`).
const HEXID = /(?<![0-9A-Za-z])(?=[0-9]*[a-f])(?:[0-9a-f]{16,17}|(?<=session-)[0-9a-f]{8})(?![0-9A-Za-z])/g;
// A named agent id (`amis-backend-0123456789abcdef`) and a teammate id (`mis-backend@session-…`) carry the name the
// owner gave a teammate, which often says what the project is about. Generic roles stay. Not the `agent-` of a file name.
const AGENT_NAMED = /(?<![0-9A-Za-z])a(?!gent-)([a-z][a-z0-9-]*?)-(?=[0-9a-f]{16,17}(?![0-9A-Za-z]))/g;
const TEAMMATE = /^([a-z][\w-]*)@/i;
const ROLES = new Set(["planner", "queen", "architect", "coder", "tester", "reviewer", "researcher", "docs-writer",
  "team-lead", "general-purpose", "explore", "plan"]);
const IPV4 =/(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/g;
const PRIVATE_IP = /^(?:10|127|0|255)\.|^192\.168\.|^172\.(?:1[6-9]|2\d|3[01])\.|^169\.254\.|^192\.0\.2\.|^198\.51\.100\.|^203\.0\.113\./;
const SYSTEM_USERS =new Set(["shared", "public", "default", "all", "runner", "root", "user", "x"]);
// Web domains say what a project is about, so every one maps to `siteN.example` (subdomains kept, generic labels as is,
// others `subN`), except these and their subdomains: the hosts rules/ai_coding_agent/** match on, then infrastructure.
const ALLOW = new Set([
  "pastebin.com", "paste.ee", "hastebin.com", "ghostbin.com", "rentry.co", "dpaste.org", "ix.io", "termbin.com",
  "transfer.sh", "file.io", "0x0.st", "temp.sh", "bashupload.com", "anonfiles.com", "gofile.io", "ngrok.io",
  "ngrok-free.app", "ngrok.app", "trycloudflare.com", "webhook.site", "requestbin.com", "pipedream.net", "interact.sh",
  "oast.fun", "oast.live", "oast.pro", "oast.site", "oast.me", "burpcollaborator.net", "discord.com", "discordapp.com",
  "hooks.slack.com", "api.anthropic.com", "api.openai.com", "host.docker.internal",
  "example.com", "example.org", "example.net", "json-schema.org", "github.com", "api.github.com",
  "raw.githubusercontent.com", "claude.ai", "claude.com", "code.claude.com", "registry.npmjs.org", "pypi.org",
]);
const RESERVED_TLD = new Set(["invalid", "example", "test", "localhost", "local", "lan", "internal", "corp", "home"]);
const GENERIC = new Set(["www", "api", "docs", "app", "blog", "news", "beta", "dev", "cdn", "static", "assets", "images", "mail", "smtp", "raw", "en", "status", "files"]);
const URL_HOST = /\b[a-z][a-z0-9+.-]*:\/\/(?:[^\s/@"'`<>]*@)?([a-z0-9.-]+)/gi;
// Outside URLs only these TLDs count, lower case: `.md`, `.sh`, `.py`, `.so`, `.app`, `.news` are file names and module paths.
// `\.` too: a grep pattern names a domain as well.
const BARE_HOST = /(?<![\w.@/\\-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\?\.)+(?:com|org|net|gov|edu|io|ai|co|dev|uk|za|jp)(?![\w-]|\\?\.[a-z0-9])/g;
const ANY_HOST = /(?<![\w-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\?\.)+[a-z][a-z0-9-]*[a-z](?![\w-]|\\?\.[a-z0-9])/gi;
const kept = (host: string) => {
  const p = host.split(".");
  return RESERVED_TLD.has(p.at(-1)!) || p.some((_, i) => ALLOW.has(p.slice(i).join(".")));
};
/** `a.b.example.co.uk` -> `example.co.uk`; no public suffix list, so `x.github.io`-style hosts share `github.io`. */
const registrable = (host: string) => {
  const p = host.split(".");
  return p.slice(p.length >= 3 && p.at(-1)!.length === 2 && /^(?:co|com|org|net|gov|ac|edu)$/.test(p.at(-2)!) ? -3 : -2).join(".");
};
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export class Redactor {
  private names = new Map<string, string>(); // lower-cased real value -> pseudonym
  private counts = { user: 0, proj: 0, host: 0, mate: 0 };
  private rx?: RegExp;
  private ips = new Map<string, string>();
  private ids = new Map<string, string>();
  private sites = new Map<string, string>(); // registrable domain -> siteN
  private subs = new Map<string, string>(); // subdomain label -> subN

  constructor(private extra: string[] = []) {
    for (const w of extra) this.add(w, "host");
  }

  private add(real: string, kind: "user" | "proj" | "host" | "mate"): void {
    const key = real.toLowerCase();
    if (real.length < 3 || SYSTEM_USERS.has(key) || this.names.has(key)) return;
    this.names.set(key, `${kind}${++this.counts[kind]}`);
    this.rx = undefined;
  }

  /** Learns usernames and project names from a line of text, before anything is replaced. */
  learn(s: string): void {
    for (const m of s.matchAll(HOME)) {
      this.add(m[1]!, "user");
      const rest = (m[2] ?? "").split(/[\\/]/).filter(Boolean);
      const proj = CONTAINERS.has(rest[0]?.toLowerCase() ?? "") ? rest[1] : rest[0];
      if (proj && !proj.startsWith(".") && !proj.includes(".") && !NOT_PROJECTS.has(proj.toLowerCase())) this.add(proj, "proj");
    }
    for (const m of s.matchAll(ENCODED)) this.add(m[1]!, "user");
    for (const m of s.matchAll(HOSTNAME)) this.add(m[0], "host");
    for (const m of s.matchAll(URL_HOST)) this.site(m[1]!);
    for (const m of s.matchAll(BARE_HOST)) this.site(m[0]);
    for (const m of s.matchAll(AGENT_NAMED)) this.mate(m[1]!);
  }

  private mate(name: string): void {
    if (!ROLES.has(name.toLowerCase())) this.add(name, "mate");
  }

  private site(host: string): void {
    host = host.toLowerCase().replace(/\\\./g, ".").replace(/\.$/, "");
    if (!/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/.test(host) || kept(host)) return;
    const reg = registrable(host);
    if (!this.sites.has(reg)) this.sites.set(reg, `site${this.sites.size + 1}`);
  }

  /** A host whose registrable domain was learned becomes `<labels>.siteN.example`; anything else stays. */
  private domains(s: string): string {
    return s.replace(ANY_HOST, (h) => {
      const host = h.toLowerCase().replace(/\\\./g, ".");
      const fake = this.sites.get(registrable(host));
      if (!fake || kept(host)) return h;
      const labels = host.split(".").slice(0, -registrable(host).split(".").length).map((l) => {
        if (GENERIC.has(l)) return l;
        if (!this.subs.has(l)) this.subs.set(l, `sub${this.subs.size + 1}`);
        return this.subs.get(l)!;
      });
      return [...labels, fake, "example"].join(h.includes("\\.") ? "\\." : ".");
    });
  }

  /** Learns from every decoded string and key of a JSON line, so a `\n` or `\\` escape cannot glue onto a name. */
  learnLine(l: string): void {
    const visit = (v: unknown, key: string): void => {
      if (typeof v === "string") {
        this.learn(v);
        const remote = key === "remote" ? REMOTE.exec(v) : null;
        if (remote) { this.add(remote[1]!, "user"); this.add(remote[2]!, "proj"); }
        if (key === "domain" || key === "host" || key === "hostname") this.site(v);
        const mate = key === "teammate_id" ? TEAMMATE.exec(v) : null;
        if (mate) this.mate(mate[1]!);
      } else if (Array.isArray(v)) v.forEach((x) => visit(x, key));
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { this.learn(k); visit(x, k); }
    };
    try { visit(JSON.parse(l), ""); } catch { this.learn(l); }
  }

  // Each name also matches with `-`/`_`/`.`/space swapped or dropped: Claude Code encodes project dirs that way, and
  // text writes `my app` or `myapp` for `my-app`.
  private regex(): RegExp | undefined {
    if (this.rx || !this.names.size) return this.rx;
    const alts = [...this.names.keys()].sort((a, b) => b.length - a.length)
      .map((n) => escapeRe(n).replace(/\\?[-_.]/g, "[-_.\\s]?"));
    return (this.rx = new RegExp(String.raw`(?<![A-Za-z0-9])(?:${alts.join("|")})(?![A-Za-z0-9])`, "gi"));
  }

  private pseudonym(match: string): string {
    const bare = (n: string) => n.toLowerCase().replace(/[-_.\s]/g, "");
    for (const [real, fake] of this.names) if (bare(real) === bare(match)) return fake;
    return "redacted";
  }

  /** Public IPv4s (a server of yours, say) map to 192.0.2.x (RFC 5737); private and loopback ones stay. */
  private ip(addr: string): string {
    if (PRIVATE_IP.test(addr)) return addr;
    if (!this.ips.has(addr)) this.ips.set(addr, `192.0.2.${(this.ips.size % 254) + 1}`);
    return this.ips.get(addr)!;
  }

  /** Session uuids and agent ids are the real ones: each maps to a same-shaped pseudonym, consistently, so
   * uuid/parentUuid chains, session dirs and agent-<id>.jsonl names still line up. */
  private id(real: string): string {
    const key = real.toLowerCase();
    let fake = this.ids.get(key);
    if (!fake) {
      const n = (this.ids.size + 1).toString(16);
      fake = real.includes("-") ? `${n.padStart(8, "0")}-0000-4000-8000-000000000000` : n.padStart(real.length, "0");
      this.ids.set(key, fake);
    }
    return fake;
  }

  /** Emails, domains, names, public IPs, ids, secrets. Used for every string that is kept. */
  clean(s: string): string {
    const rx = this.regex();
    s = this.domains(s.replace(EMAIL, "user@example.invalid"))
      .replace(AGENT_NAMED, (m, n: string) => `a${this.names.get(n.toLowerCase()) ?? n}-`);
    return mask((rx ? s.replace(rx, (m) => this.pseudonym(m)) : s)
      .replace(IPV4, (a) => this.ip(a)).replace(UUID, (u) => this.id(u)).replace(HEXID, (h) => this.id(h)));
  }

  /** A file or dir name with whitespace in it is free text ("Client X report.md"): it goes, its extension stays. */
  static pathNames(s: string): string {
    return s.split(/([\\/])/).map((seg) => (/\s/.test(seg) ? `redacted${/\.[A-Za-z0-9]{1,8}$/.exec(seg)?.[0] ?? ""}` : seg)).join("");
  }

  /** Free text becomes a placeholder naming its length class, so sizes stay plausible but nothing is readable. */
  static placeholder(s: string): string {
    const n = s.length;
    return n === 0 ? "" : `[redacted text: ${n < 80 ? "short" : n < 500 ? "medium" : n < 5000 ? "long" : "huge"}]`;
  }

  /** Heredoc bodies and quoted messages go; the shell structure around them stays. */
  static command(s: string): string {
    return s
      .replace(HEREDOC_BODY, (_m, head, _q, _t, body, tail) => head + Redactor.placeholder(body) + tail)
      .replace(QUOTED, (q) => (WORDS.test(q.replace(/\[redacted text: \w+\]/g, "")) ? q[0] + Redactor.placeholder(q.slice(1, -1)) + q[0] : q))
      .replace(COMMENT, (c, lead, body) => (WORDS.test(body) ? `${lead}# ${Redactor.placeholder(body)}` : c));
  }

  private string(s: string, key: string): string {
    if (IDS.has(key)) return "00000000-0000-4000-8000-000000000000";
    if (FREE.has(key)) return Redactor.placeholder(s);
    if (key === "command") return this.clean(Redactor.command(s));
    if (PATHS.has(key)) return this.clean(Redactor.pathNames(s));
    if (KEEP.has(key)) return this.clean(s);
    return /\s/.test(s) || s.length > MAX_TOKEN ? Redactor.placeholder(s) : this.clean(s);
  }

  walk(v: unknown, key = ""): unknown {
    if (typeof v === "string") return this.string(v, key);
    if (Array.isArray(v)) return v.map((x) => this.walk(x, key));
    // A key can be free text too: AskUserQuestion answers are keyed by the question.
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [this.string(k, ""), this.walk(x, k)]));
    return v;
  }

  line(l: string): string {
    if (!l) return l;
    try { return JSON.stringify(this.walk(JSON.parse(l))); } catch { return Redactor.placeholder(l); }
  }
}

function* files(p: string): Generator<string> {
  if (!statSync(p).isDirectory()) return yield p;
  for (const n of readdirSync(p)) yield* files(join(p, n));
}

/** Redacts every .jsonl (and sub-agent .meta.json) under `src` into `dst`, keeping relative paths (pseudonymised). Returns files written. */
export function redactTree(src: string, dst: string, extra: string[] = []): number {
  const inputs = [...files(src)].filter((f) => /\.(?:jsonl|meta\.json)$/.test(f));
  const texts = inputs.map((f) => readFileSync(f, "utf8"));
  const r = new Redactor(extra);
  for (const t of texts) for (const l of t.split("\n")) r.learnLine(l);
  for (const f of inputs) r.learn(f);
  const base = statSync(src).isDirectory() ? src : dirname(src);
  inputs.forEach((f, i) => {
    const out = join(dst, r.clean(relative(base, f).replace(/\\/g, "/")));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, texts[i]!.split("\n").map((l) => r.line(l.replace(/\r$/, ""))).join("\n"));
  });
  return inputs.length;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const extra: string[] = [];
  for (let i = args.indexOf("--drop"); i >= 0; i = args.indexOf("--drop")) extra.push(...args.splice(i, 2).slice(1));
  const [src, dst] = args;
  if (!src || !dst) { console.error("usage: redact-fixture.ts <in.jsonl|dir> <out> [--drop <word>]..."); process.exit(2); }
  console.log(`redacted ${redactTree(src, dst, extra)} file(s) -> ${dst}`);
}

// Secret masking and detection (ADR 0007). One table drives both, so they cannot drift.
import { createHmac, randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const MARK = "…[masked]";

// Group 1 stays visible, the rest of the match is masked. `strong` = also detected and fingerprinted; the others are
// too noisy to alert on. Transcripts hold attacker-influenced text, so no pattern may go quadratic: the bounds and
// anchors below are what keep them linear (tests/mask.test.ts times each one).
// Use only replace/search/matchAll on these: they ignore or reset lastIndex, RegExp.test on a /g regex does not.
const PATTERNS: { name: string; strong: boolean; re: RegExp }[] = [
  { name: "private_key", strong: true, re: /(-----BEGIN) [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/g },
  { name: "aws_access_key", strong: true, re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "github_token", strong: true, re: /\b(gh[pousr]_)[A-Za-z0-9]{30,}\b/g },
  { name: "github_pat", strong: true, re: /\b(github_pat_)[A-Za-z0-9_]{20,}/g },
  { name: "gitlab_token", strong: true, re: /\b(glpat-)[A-Za-z0-9_-]{20,}/g },
  { name: "slack_token", strong: true, re: /\b(xox[abprs]-)[A-Za-z0-9-]{10,}/g },
  { name: "slack_webhook", strong: true, re: /(hooks\.slack\.com\/services)\/[A-Za-z0-9/_-]+/g },
  { name: "stripe_key", strong: true, re: /\b((?:sk|rk|pk)_(?:live|test)_)[A-Za-z0-9]{16,}/g },
  { name: "sk_key", strong: true, re: /\b(sk-)(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g },
  { name: "google_api_key", strong: true, re: /\b(AIza)[0-9A-Za-z_-]{35}(?![\w-])/g },
  { name: "npm_token", strong: true, re: /\b(npm_)[A-Za-z0-9]{36}\b/g },
  { name: "huggingface_token", strong: true, re: /\b(hf_)[A-Za-z0-9]{30,}\b/g },
  { name: "jwt", strong: true, re: /\b(eyJ)[A-Za-z0-9_-]{8,1024}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  // HTTP schemes are case-insensitive, so `authorization: bearer x` counts. Other casings need that header: as bare
  // words they are English ("bearer tokenization").
  {
    name: "bearer_token",
    strong: true,
    re: /\b(Bearer\s+|(?:[Aa]uthorization|AUTHORIZATION)["']?\s*[=:]\s*["']?(?:bearer|BEARER)\s+)(?!\$)[A-Za-z0-9._~+/=-]{12,}/g,
  },
  // Any other scheme (Basic, token, Digest), also URL-encoded (`Authorization%3A%20Bearer%20...`).
  {
    name: "authorization",
    strong: false,
    re: /((?:[Aa]uthorization|AUTHORIZATION)(?:\\?["'])?(?:\s*[=:]|%3[Aa])(?:\s|%20)*(?:\\?["'])?[A-Za-z]+(?:\s|%20)+)(?![$<{(…])[A-Za-z0-9._~+/=%-]{8,}/g,
  },
  // `curl -u user:pw` and `--user=user:pw` (not `docker -u 1000:1000`), `mysql -p<pw>`, `--password <pw>`. A quoted
  // -u or -p value runs to its closing quote, spaces included.
  { name: "cli_user", strong: false, re: /((?:^|\s)(?:-u|--user)(?:\s+|=)?["']?[^\s:"']+:)(?![$<{(…]|\d+\b)(?:(?<=["'][^\s:"']{1,200}:)[^"'\n]{3,200}|[^\s"']{3,})/g },
  { name: "mysql_password", strong: false, re: /(?<=\b(?:mysql|mysqldump|mysqladmin|mariadb)\b[^\n|;&]{0,200})(\s-p["']?)(?![$<{(…"'])(?:(?<=-p["'])[^"'\n]{1,200}|[^\s"']+)/g },
  { name: "password_flag", strong: false, re: /(--password(?:=|\s+)["']?)(?![$<{(…-])[^\s"']{3,}/g },
  // Masks KEY=<value ≥ 8 chars>, also JSON-escaped (`\"password\":\"x\"`), skipping $VAR, <placeholder>, ${VAR},
  // $(cmd) and an already masked value. PASS covers PASSWORD, PASSWD and DB_PASS; `_PWD` is MYSQL_PWD, not $PWD.
  {
    name: "assignment",
    strong: false,
    re: /((?:KEY|TOKEN|SECRET|PASS|_PWD|CREDENTIALS?|AUTH)[A-Za-z0-9_]{0,64}(?:\\?["'])?\s*[=:]\s*(?:\\?["'])?)(?![$<{(…])[^\s"'&;,)}\\]{8,}/gi,
  },
  { name: "url_credential", strong: false, re: /(\b\w+:\/\/[^\s:/@]+:)[^\s@/]{3,}(?=@)/g },
];
const STRONG = PATTERNS.filter((p) => p.strong);

/** Masks every pattern, keeping a short type prefix. Idempotent. */
export function mask(s: string): string {
  for (const { re } of PATTERNS) s = s.replace(re, `$1${MARK}`);
  return s;
}

/** Names of the strong patterns in `s`, in table order. Never values. */
export function secretKinds(s: string): string[] {
  return STRONG.filter(({ re }) => s.search(re) >= 0).map(({ name }) => name);
}

// A token is the same secret with or without `Bearer `, and a key block the same in raw or JSON-escaped text.
const tokenOf = (match: string) => match.replace(/^[^\n]*?bearer\s+|\\[nr]|\s/gi, "");

// The per-install fingerprint key (ADR 0007): 32 random bytes, made on the first secret seen. Created whole (written to a
// temp file, then hard-linked into place) so a crash or a racing hook never leaves a short key; opened without
// following a symlink and refused unless it is a 32-byte regular file.
let fpKey: Buffer | undefined;
const key = () => (fpKey ??= readKey(join(homedir(), ".retrohound", "fp.key")));
export function readKey(path: string): Buffer {
  if (!lstatSync(path, { throwIfNoEntry: false })) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, randomBytes(32), { mode: 0o600 });
    try {
      linkSync(tmp, path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; // another process made it first: use theirs
    } finally {
      unlinkSync(tmp);
    }
  }
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (e) {
    throw new Error(`${path}: cannot open the fingerprint key (a symlink is refused): ${(e as Error).message}`);
  }
  try {
    const st = fstatSync(fd), buf = Buffer.alloc(32);
    if (!st.isFile() || st.size !== 32 || readSync(fd, buf, 0, 32, 0) !== 32) throw new Error(`${path}: not a 32-byte regular file, refusing it`);
    try {
      if (st.mode & 0o077) chmodSync(path, 0o600);
    } catch {
      // not supported on every filesystem
    }
    return buf;
  } finally {
    closeSync(fd);
  }
}

/** One `kind/fp` per distinct strong secret in `s`: fp is the first 16 hex of HMAC-SHA256 under the per-install key,
 * kind the first strong pattern (table order, most specific first) that matched the token. Stable on one machine;
 * not comparable across machines, and a weak value cannot be confirmed by guessing without the key. */
export function secretFingerprints(s: string): string[] {
  const fps = new Map<string, string>();
  for (const { name, re } of STRONG) {
    for (const [match] of s.matchAll(re)) {
      const fp = createHmac("sha256", key()).update(tokenOf(match)).digest("hex").slice(0, 16);
      if (!fps.has(fp)) fps.set(fp, `${name}/${fp}`);
    }
  }
  return [...fps.values()];
}

/** A stored fingerprint as [fp, kind]. An index from before 0.3.2 holds a bare fp, with no kind. The separator is not
 * `:` because the mask reads `aws_access_key:<hex>` as an assignment. */
export function splitFp(v: string): [string, string | undefined] {
  const i = v.indexOf("/");
  return i < 0 ? [v, undefined] : [v.slice(i + 1), v.slice(0, i)];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const SEP = String.raw`[\\/]+`;

/** `home` -> `~`. Windows homes match any slash style (also JSON-escaped), any case, and Git Bash's `/c/Users/x`.
 * Whole path components only: `/Users/x` leaves `/Users/xavier` alone. */
export function scrubHome(s: string, home: string): string {
  const base = home.replace(/[\\/]+$/, "");
  if (!base || /^[A-Za-z]:$/.test(base)) return s; // no home, or a filesystem root
  const windows = /^[A-Za-z]:|^\\\\/.test(home);
  let source = escapeRe(base);
  if (windows) {
    const [head = "", ...tail] = base.split(/[\\/]+/).filter(Boolean);
    const anchor = /^[A-Za-z]:$/.test(head) ? `(?:${head}|/${head[0]})` : SEP + escapeRe(head);
    source = [anchor, ...tail.map(escapeRe)].join(SEP);
  }
  return s.replace(new RegExp(String.raw`(?<![\w.-])${source}(?![\w-])`, windows ? "gi" : "g"), "~");
}

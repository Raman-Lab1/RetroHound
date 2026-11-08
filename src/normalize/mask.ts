// Secret masking and detection (ADR 0007). One table drives both, so they cannot drift.
import { createHash } from "node:crypto";

const MARK = "…[masked]";

// Group 1 stays visible, the rest of the match is masked. `strong` = also detected and fingerprinted; the others are
// too noisy to alert on. Transcripts hold attacker-influenced text, so no pattern may go quadratic: the bounds and
// anchors below are what keep them linear (tests/mask.test.ts times each one).
// Use only replace/search/matchAll on these: they ignore or reset lastIndex, RegExp.test on a /g regex does not.
const PATTERNS: { name: string; strong: boolean; re: RegExp }[] = [
  { name: "private_key", strong: true, re: /(-----BEGIN) [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  { name: "aws_access_key", strong: true, re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "github_token", strong: true, re: /\b(gh[pousr]_)[A-Za-z0-9]{30,}\b/g },
  { name: "github_pat", strong: true, re: /\b(github_pat_)[A-Za-z0-9_]{20,}/g },
  { name: "gitlab_token", strong: true, re: /\b(glpat-)[A-Za-z0-9_-]{20,}/g },
  { name: "slack_token", strong: true, re: /\b(xox[abprs]-)[A-Za-z0-9-]{10,}/g },
  { name: "slack_webhook", strong: true, re: /(hooks\.slack\.com\/services)\/[A-Za-z0-9/_-]+/g },
  { name: "stripe_key", strong: true, re: /\b((?:sk|rk|pk)_(?:live|test)_)[A-Za-z0-9]{16,}/g },
  { name: "sk_key", strong: true, re: /\b(sk-)(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g },
  { name: "jwt", strong: true, re: /\b(eyJ)[A-Za-z0-9_-]{8,1024}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  // HTTP schemes are case-insensitive, so `authorization: bearer x` counts. Other casings need that header: as bare
  // words they are English ("bearer tokenization").
  {
    name: "bearer_token",
    strong: true,
    re: /\b(Bearer\s+|(?:[Aa]uthorization|AUTHORIZATION)["']?\s*[=:]\s*["']?(?:bearer|BEARER)\s+)(?!\$)[A-Za-z0-9._~+/=-]{12,}/g,
  },
  // Masks KEY=<value ≥ 8 chars>, skipping $VAR, <placeholder>, ${VAR}, $(cmd) and an already masked value.
  {
    name: "assignment",
    strong: false,
    re: /((?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH)[A-Za-z0-9_]{0,64}["']?\s*[=:]\s*["']?)(?![$<{(…])[^\s"'&;,)}]{8,}/gi,
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

/** First 16 hex of the sha256 of each distinct strong secret in `s`. Safe to store: strong tokens are high-entropy. */
export function secretFingerprints(s: string): string[] {
  const fps = new Set<string>();
  for (const { re } of STRONG) {
    for (const [match] of s.matchAll(re)) fps.add(createHash("sha256").update(tokenOf(match)).digest("hex").slice(0, 16));
  }
  return [...fps];
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

// `hook run` (ADR 0009): PreToolUse payload in, permission decision out (per-agent formats in agents.ts). Fail-open by construction: the caller turns
// any exception into "no decision, exit 0". Only enforce-lane single-event detections (and the built-in tamper guard) decide; it never emits `allow`
// or `updatedInput`, and the log never holds raw tool input (0007).
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { markHooksEdit } from "./context.ts";
import { render, supportsAsk, toEvents, type Agent } from "./agents.ts";
import { evaluate } from "../engine/evaluate.ts";
import { LEVELS } from "../normalize/types.ts";
import { loadRules, parseSource, type DetectionRule, type ParsedDoc, type Rule } from "../engine/load.ts";
import { mask } from "../normalize/mask.ts";
import { toStored } from "../normalize/stored.ts";
import type { Finding, RawEvent } from "../normalize/types.ts";
import { isSuppressed, NO_IGNORE, type Ignore } from "../suppress.ts";
import { TOOL_VERSION } from "../version.ts";

export const MODES = ["log", "confirm", "block"] as const;
export type Mode = (typeof MODES)[number];
export type Decision = "deny" | "ask";

export type HookResult = { output?: string; rule?: string; would?: Decision };

/** Same directory as the default index DB (store/index.ts defaultDbPath), without loading the SQLite layer. */
export const defaultLogPath = () => join(homedir(), ".retrohound", "hook-log.jsonl");

const isEnforce = (r: Rule): r is DetectionRule => r.kind === "detection" && r.lane === "enforce";

const attack = (r: DetectionRule) => r.tags.find((t) => /^attack\.t\d/i.test(t))?.slice(7).toUpperCase();

// Built in, not a rule file: a forged cache or an edited rules dir loads no rules, so rule files cannot guard themselves.
const TAMPER = { kind: "detection", id: "retrohound_hook_tamper", name: "retrohound_hook_tamper", title: "Write to RetroHound's own state or rules",
  level: "critical", lane: "enforce", tags: ["attack.t1562.001"], falsepositives: [], path: "(built in)", doc: 0, silenced: false, fields: [], matches: () => false } satisfies DetectionRule;
// macOS and Windows volumes are case-insensitive by default: ~/.RetroHound is ~/.retrohound there.
const FOLD = process.platform === "darwin" || process.platform === "win32";
const STATE = new RegExp(String.raw`/\.retrohound(?:[/\s"';|&)]|$)`, FOLD ? "i" : ""); // ~/.retrohound: ignore.yml, rules caches, hook log
const low = (s: string) => (FOLD ? s.toLowerCase() : s);
// ponytail: literal text only; a write through a variable, a script file or a relative path is not seen. It stops the
// obvious one-liner, not code that already runs as you (that can always switch a same-user hook off).
const WRITES = />|\b(?:tee|cp|mv|rm|ln|install|touch|truncate|dd|chmod|sed\s+-i|perl|python3?|node|bun|deno|ruby)\b/;
function inside(path: string, dir: string): boolean {
  const p = low(path), d = low(dir).replace(/\/+$/, "");
  return p === d || p.startsWith(d + "/");
}

/** A write to ~/.retrohound or to a protected path (the rules dirs): it could switch enforcement off. */
export function tampers(e: RawEvent, protect: string[]): boolean {
  if (e.category === "file_event") return !!e.target_path && (STATE.test(e.target_path) || protect.some((d) => inside(e.target_path!, d)));
  const c = e.category === "process_creation" ? e.command_line : undefined;
  return !!c && WRITES.test(c) && (STATE.test(c) || protect.some((d) => low(c).includes(low(d))));
}

/** The most severe enforce-lane rule the call trips, or none. Throws on a payload that is not a PreToolUse object. */
export function decide(stdin: string, rules: Rule[], ignore: Ignore = NO_IGNORE, agent: Agent = "claude_code", protect: string[] = []): { rule: DetectionRule; event: RawEvent } | undefined {
  const events = toEvents(agent, JSON.parse(stdin)).map(markHooksEdit);
  const guarded = events.find((e) => tampers(e, protect));
  if (guarded) return { rule: TAMPER, event: guarded }; // never suppressed: the ignore file is one of the guarded files
  const hits = evaluate(rules.filter(isEnforce), events).map((m) => ({ rule: m.rule as DetectionRule, event: m.events[0]! }))
    .filter((h) => !isSuppressed({ rule_id: mask(h.rule.id), events: [toStored(h.event)] } as unknown as Finding, ignore)); // stored (masked) values, as scan
  hits.sort((a, b) => LEVELS.indexOf(b.rule.level) - LEVELS.indexOf(a.rule.level));
  return hits[0];
}

export function logTrial(path: string, rec: Record<string, string>): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, mask(JSON.stringify(rec)) + "\n", { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // not supported on every filesystem
  }
}

/** `protect`: paths besides ~/.retrohound that no write may reach (the rules dirs). */
export function runHook(stdin: string, mode: Mode, rules: Rule[], logPath = defaultLogPath(), ignore: Ignore = NO_IGNORE, agent: Agent = "claude_code", protect: string[] = []): HookResult {
  if (mode === "confirm" && !supportsAsk(agent)) throw new Error(`${agent} does not support ask (confirm mode); use --mode log or block`);
  const hit = decide(stdin, rules, ignore, agent, protect);
  if (!hit) return {};
  const name = hit.rule.name ?? hit.rule.id;
  const would: Decision = mode === "confirm" ? "ask" : "deny";
  if (mode === "log") {
    logTrial(logPath, { ts: hit.event.ts, agent, session_id: hit.event.session_id, tool: hit.event.tool_name ?? "", rule: name, would_decide: "deny" });
    return { rule: name, would: "deny" };
  }
  const tag = attack(hit.rule);
  const reason = mask(`RetroHound: ${name}${tag ? ` (${tag})` : ""}`);
  return { output: render(agent, would, reason), rule: name, would };
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Per-rules-dirs cache file next to the trial log (the same name as before when there are no extra dirs). */
export const defaultCachePath = (dir: string, extras: string[] = []) =>
  join(dirname(defaultLogPath()), `rules-cache-${sha([dir, ...extras].map((d) => resolve(d)).join("\0")).slice(0, 12)}.json`);

type CacheFile = { key: string; sum: string; paths: string[]; docs: ParsedDoc[][] };

/** The cached parse of the enforce sources, only if it is intact and was made from exactly these files. */
function readCache(path: string, key: string): CacheFile | undefined {
  try {
    const c: CacheFile = JSON.parse(readFileSync(path, "utf8"));
    const ok = c.key === key && Array.isArray(c.paths) && Array.isArray(c.docs) && c.docs.length === c.paths.length && c.docs.every(Array.isArray) && c.sum === sha(JSON.stringify([c.paths, c.docs]));
    return ok ? c : undefined;
  } catch {
    return undefined; // missing or corrupt: parse the YAML
  }
}

// JSON turns NaN/Infinity into null and drops Map/Set contents: such a rule is never cached.
const jsonSafe = (_k: string, v: unknown) => {
  if ((typeof v === "number" && !Number.isFinite(v)) || v instanceof Map || v instanceof Set) throw new Error("not JSON-safe");
  return v;
};

function writeCache(path: string, key: string, paths: string[], docs: ParsedDoc[][]): void {
  try {
    if (docs.some((f) => f.some((d) => d.error !== undefined))) return; // a rejection is reported from the YAML every time
    const json = JSON.stringify([paths, docs], jsonSafe);
    const [p, d] = JSON.parse(json) as [string[], ParsedDoc[][]];
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ key, sum: sha(json), paths: p, docs: d } satisfies CacheFile), { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // a cache that cannot be written only costs the next run a parse
  }
}

const ENFORCE = /lane["']?\s*:\s*["']?enforce/; // a superset of what the loader reads as lane enforce: key or value quoted too

/**
 * Like cli/rules.ts loadRuleDir, but parses only files that mention `lane: enforce`: the hook pays for every tool call.
 * The parse (plain data, never compiled rules) is cached under the stat of every rule file (size, mtime, ctime, inode),
 * so a warm call opens no rule file: reading them all was most of the hook's own time. Any edit, add or remove changes
 * the key. Nothing is cached while a file's ctime is under a second old: a second edit in the same timestamp tick could
 * leave size and times unchanged. The cache is only as safe as ~/.retrohound: the tamper guard above denies the
 * obvious writes to it.
 */
export function loadEnforceRules(dir: string, cachePath?: string, extras: string[] = []): Rule[] {
  const dirs = [dir, ...extras]; // shipped first: on a reused id the extra rule is the one loadRules rejects
  const names = dirs.map((d) => {
    try {
      return (readdirSync(d, { recursive: true }) as string[]).filter((n) => /\.ya?ml$/.test(n)).sort();
    } catch {
      return []; // no rules directory: nothing from it can decide
    }
  });
  const files = dirs.flatMap((d, k) => names[k]!.map((n) => join(d, n)));
  const stats = files.map((f) => statSync(f, { bigint: true }));
  const key = sha(JSON.stringify([TOOL_VERSION, dirs.map((d) => resolve(d)), names, stats.map((s) => [s.size, s.mtimeNs, s.ctimeNs, s.ino].map(String))]));
  cachePath ??= defaultCachePath(dir, extras);
  const hit = readCache(cachePath, key);
  if (hit) return loadRules(hit.paths.map((path, i) => ({ path, text: "", docs: hit.docs[i] }))).rules;
  const sources = files.map((path) => ({ path, text: readFileSync(path, "utf8") })).filter((s) => ENFORCE.test(s.text));
  let docs;
  try {
    docs = sources.map((s) => parseSource(s.text));
    const settled = BigInt(Date.now() - 1000) * 1_000_000n;
    if (stats.every((s) => s.ctimeNs < settled)) writeCache(cachePath, key, sources.map((s) => s.path), docs);
  } catch {
    docs = undefined; // a file that is not YAML at all: loadRules reports it
  }
  return loadRules(sources.map((s, i) => ({ ...s, docs: docs?.[i] }))).rules;
}

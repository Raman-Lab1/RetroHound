// `hook run` (ADR 0009): PreToolUse payload in, permission decision out (per-agent formats in agents.ts). Fail-open by construction: the caller turns
// any exception into "no decision, exit 0". Only enforce-lane single-event detections decide; it never emits `allow`
// or `updatedInput`, and the log never holds raw tool input (0007).
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { render, supportsAsk, toEvent, type Agent } from "./agents.ts";
import { evaluate } from "../engine/evaluate.ts";
import { LEVELS } from "../normalize/types.ts";
import { loadRules, parseSource, type DetectionRule, type ParsedDoc, type Rule } from "../engine/load.ts";
import { mask } from "../normalize/mask.ts";
import { toStored } from "../normalize/stored.ts";
import type { Finding, RawEvent } from "../normalize/types.ts";
import { isSuppressed, NO_IGNORE, type Ignore } from "../suppress.ts";

export const MODES = ["log", "confirm", "block"] as const;
export type Mode = (typeof MODES)[number];
export type Decision = "deny" | "ask";

export type HookResult = { output?: string; rule?: string; would?: Decision };

/** Same directory as the default index DB (store/index.ts defaultDbPath), without loading the SQLite layer. */
export const defaultLogPath = () => join(homedir(), ".retrohound", "hook-log.jsonl");

const isEnforce = (r: Rule): r is DetectionRule => r.kind === "detection" && r.lane === "enforce";

const attack = (r: DetectionRule) => r.tags.find((t) => /^attack\.t\d/i.test(t))?.slice(7).toUpperCase();

/** The most severe enforce-lane rule the call trips, or none. Throws on a payload that is not a PreToolUse object. */
export function decide(stdin: string, rules: Rule[], ignore: Ignore = NO_IGNORE, agent: Agent = "claude_code"): { rule: DetectionRule; event: RawEvent } | undefined {
  const enforce = rules.filter(isEnforce);
  const event = toEvent(agent, JSON.parse(stdin));
  const stored = [toStored(event)]; // the ignore file matches stored (masked) values, as scan does
  const hits = evaluate(enforce, [event]).map((m) => m.rule as DetectionRule)
    .filter((r) => !isSuppressed({ rule_id: mask(r.id), events: stored } as unknown as Finding, ignore));
  hits.sort((a, b) => LEVELS.indexOf(b.level) - LEVELS.indexOf(a.level));
  return hits[0] ? { rule: hits[0], event } : undefined;
}

export function logTrial(path: string, rec: Record<string, string>): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, mask(JSON.stringify(rec)) + "\n", { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // not supported on every filesystem
  }
}

export function runHook(stdin: string, mode: Mode, rules: Rule[], logPath = defaultLogPath(), ignore: Ignore = NO_IGNORE, agent: Agent = "claude_code"): HookResult {
  if (mode === "confirm" && !supportsAsk(agent)) throw new Error(`${agent} does not support ask (confirm mode); use --mode log or block`);
  const hit = decide(stdin, rules, ignore, agent);
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

/** Per-rules-dir cache file next to the trial log. */
export const defaultCachePath = (dir: string) => join(dirname(defaultLogPath()), `rules-cache-${sha(resolve(dir)).slice(0, 12)}.json`);

type CacheFile = { key: string; sum: string; docs: ParsedDoc[][] };

/** The cached parse of the sources, only if it is intact and was made from exactly these file contents. */
function readCache(path: string, key: string, count: number): ParsedDoc[][] | undefined {
  try {
    const c: CacheFile = JSON.parse(readFileSync(path, "utf8"));
    const ok = c.key === key && Array.isArray(c.docs) && c.docs.length === count && c.docs.every(Array.isArray) && c.sum === sha(JSON.stringify(c.docs));
    return ok ? c.docs : undefined;
  } catch {
    return undefined; // missing or corrupt: parse the YAML
  }
}

// JSON turns NaN/Infinity into null and drops Map/Set contents: such a rule is never cached.
const jsonSafe = (_k: string, v: unknown) => {
  if ((typeof v === "number" && !Number.isFinite(v)) || v instanceof Map || v instanceof Set) throw new Error("not JSON-safe");
  return v;
};

function writeCache(path: string, key: string, docs: ParsedDoc[][]): void {
  try {
    if (docs.some((f) => f.some((d) => d.error !== undefined))) return; // a rejection is reported from the YAML every time
    const json = JSON.stringify(docs, jsonSafe);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ key, sum: sha(json), docs: JSON.parse(json) } satisfies CacheFile), { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // a cache that cannot be written only costs the next run a parse
  }
}

/**
 * Like cli/rules.ts loadRuleDir, but parses only files that mention `lane: enforce`: the hook pays for every tool call.
 * The YAML parse is the dominant cost, so its result (plain data, never compiled rules) is cached under a hash of the
 * selected files' paths and contents: any edit, add or remove changes the key and the YAML is parsed again.
 */
export function loadEnforceRules(dir: string, cachePath = defaultCachePath(dir)): Rule[] {
  let names: string[] = [];
  try {
    names = (readdirSync(dir, { recursive: true }) as string[]).filter((n) => /\.ya?ml$/.test(n)).sort();
  } catch {
    // no rules directory: nothing can decide
  }
  const sources = names.map((n) => ({ path: join(dir, n), text: readFileSync(join(dir, n), "utf8") })).filter((s) => /lane:\s*enforce/.test(s.text));
  const key = sha(JSON.stringify(sources.map((s) => [s.path, s.text])));
  let docs = readCache(cachePath, key, sources.length);
  if (!docs) {
    try {
      docs = sources.map((s) => parseSource(s.text));
      writeCache(cachePath, key, docs);
    } catch {
      docs = undefined; // a file that is not YAML at all: loadRules reports it
    }
  }
  return loadRules(sources.map((s, i) => ({ ...s, docs: docs?.[i] }))).rules;
}

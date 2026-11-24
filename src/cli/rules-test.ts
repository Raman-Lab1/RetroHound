// `retrohound rules test`: the rule-quality gate. Every non-silenced rule needs
// <tests>/<name>/{positive,negative}.jsonl; each line is a partial RawEvent (defaults fill the contract fields) and a
// file is one session. Positive: every line fires a detection rule alone (for a first_seen_* rule, every line after the
// cold-start window), a correlation fires on the whole file.
// Negative: non-empty, never fires. Also bans `re` patterns with more than one unescaped .* / .+ (ReDoS).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { parseAllDocuments } from "yaml";
import { evaluate } from "../engine/evaluate.ts";
import { coldStartCutoff, FIRST_SEEN_FIELDS, firstSeenOf, setFirstSeen } from "../engine/first-seen.ts";
import type { Rule } from "../engine/load.ts";
import { mask } from "../normalize/mask.ts";
import type { RawEvent } from "../normalize/types.ts";
import type { IO } from "./io.ts";
import { loadRuleDir } from "./rules.ts";

export type RuleCheck = { name: string; files: string[]; positive: string[]; negative: string[] };
export type RulesReport = { rejected: string[]; badRe: string[]; rules: RuleCheck[] };

function events(path: string): RawEvent[] {
  const lines = readFileSync(path, "utf8").split(/\r?\n/).filter((l) => l.trim());
  return lines.map((line, i) => ({
    id: `e${i + 1}`, schema_version: "0.1", agent: "claude_code", session_id: "s1",
    ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), seq: i + 1, category: "tool_call",
    raw_ref: { file: path, line: i + 1 }, ...JSON.parse(line),
  }));
}

const hits = (rule: Rule, evs: RawEvent[]) => evaluate([rule], evs).filter((m) => m.rule === rule).length;

/** Every pattern under a `field|re` key, at any depth of a detection block. */
const reValues = (x: unknown, re = false): string[] =>
  typeof x === "string" ? (re ? [x] : [])
  : Array.isArray(x) ? x.flatMap((v) => reValues(v, re))
  : x && typeof x === "object" ? Object.entries(x).flatMap(([k, v]) => reValues(v, k.split("|").includes("re")))
  : [];

// The engine runs an unbounded `re` on 8 KiB windows (modifiers.ts regexTest), which bounds quadratic patterns but not
// `.*a.*b` (cubic in V8, ~1 s per KiB).
function badRePatterns(rules: Rule[]): string[] {
  return [...new Set(rules.map((r) => r.path))].flatMap((path) =>
    parseAllDocuments(readFileSync(path, "utf8")).flatMap((d) => reValues((d.toJS() as { detection?: unknown } | null)?.detection))
      .filter((r) => (r.match(/(?<!\\)\.[*+]/g) ?? []).length > 1).map((r) => `${path}: ${r}`));
}

function checkOne(rule: Rule, testsDir: string): RuleCheck {
  const name = rule.name ?? rule.id;
  const dir = join(testsDir, name);
  const pos = join(dir, "positive.jsonl");
  const neg = join(dir, "negative.jsonl");
  const files = [
    ...(rule.name ? [] : ["rule has no name"]),
    ...[pos, neg].filter((f) => !existsSync(f)).map((f) => `missing ${f}`),
  ];
  const run = (file: string, check: (evs: RawEvent[]) => string[]): string[] => {
    if (!existsSync(file)) return [];
    try {
      const evs = events(file);
      setFirstSeen(firstSeenOf(evs)); // the scan's pre-pass (ADR 0016), over this file: its ts values decide
      return evs.length ? check(evs) : [`${file} is empty`];
    } catch (e) {
      return [`${file}: ${(e as Error).message}`];
    } finally {
      setFirstSeen();
    }
  };
  // A first_seen rule's baseline lines (before the cold-start cutoff) can never fire: only the later lines must.
  const cold = rule.kind === "detection" && FIRST_SEEN_FIELDS.some((f) => rule.fields.includes(f));
  const positive = run(pos, (evs) => {
    if (rule.kind === "correlation") return hits(rule, evs) ? [] : ["correlation did not fire on the positive file"];
    const cutoff = cold ? coldStartCutoff(evs.map((e) => e.ts)) : "";
    const live = evs.filter((e) => e.ts >= cutoff);
    if (!live.length) return ["no positive line after the cold-start window"];
    return live.filter((e) => hits(rule, [e]) === 0).map((e) => `positive line ${e.raw_ref.line} did not fire`);
  });
  const negative = run(neg, (evs) => (hits(rule, evs) ? ["fired on the negative file"] : []));
  return { name, files, positive, negative };
}

/** Each rule's tests sit in `testsDir`, else next to the rules dir it came from: `<dir>/../tests`. */
export function checkRules(dir: string, testsDir?: string, extras: string[] = []): RulesReport {
  const { rules, rejected } = loadRuleDir(dir, extras);
  const home = (r: Rule) => [...extras, dir].find((d) => !relative(d, r.path).startsWith("..")) ?? dir;
  return {
    rejected: rejected.map((x) => `${x.path} #${x.doc}: ${x.reason}: ${x.message}`),
    badRe: badRePatterns(rules),
    rules: rules.filter((r) => !r.silenced).map((r) => checkOne(r, testsDir ?? join(dirname(home(r)), "tests"))),
  };
}

export function testRules(dir: string, testsDir: string | undefined, io: IO, extras: string[] = []): number {
  const rep = checkRules(dir, testsDir, extras);
  const lines = rep.rules.map((r) => {
    const probs = [...r.files, ...r.positive, ...r.negative];
    return probs.length ? `  FAIL ${r.name}\n${probs.map((p) => `       ${p}`).join("\n")}` : `  ok   ${r.name}`;
  });
  const global = [...rep.rejected.map((x) => `rejected: ${x}`), ...rep.badRe.map((x) => `re with more than one .* / .+: ${x}`)];
  const failed = rep.rules.filter((r) => r.files.length + r.positive.length + r.negative.length).length;
  io.out(mask([...lines, ...global.map((g) => `  FAIL ${g}`), `  ${rep.rules.length - failed}/${rep.rules.length} rules pass, ${global.length} other problems`].join("\n") + "\n"));
  return failed || global.length ? 1 : 0;
}

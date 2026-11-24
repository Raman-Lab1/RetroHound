// `retrohound rules list|show` and the rule-directory loader the CLI shares (ADR 0003). Read-only.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";
import { loadRules, type LoadResult, type Rule, type Source } from "../engine/load.ts";
import { mask } from "../normalize/mask.ts";
import { UsageError, type IO } from "./io.ts";

const yamlFiles = (dir: string) =>
  (readdirSync(dir, { recursive: true }) as string[]).map((n) => n.replaceAll("\\", "/")).filter((n) => /\.ya?ml$/.test(n)).sort();

/** `name`: relative to `dir` for the main dir (as scan hashes it), the full path for an extra dir. */
export type RuleSource = Source & { name: string; extra: boolean };

/** The rule files of `dir` (none if it does not exist, like scan), then of each extra dir, which must exist: the user named it. */
export function ruleSources(dir: string, extras: string[] = []): RuleSource[] {
  let names: string[] = [];
  try {
    names = yamlFiles(dir);
  } catch {
    // no rules directory: an empty rule set, like scan
  }
  const out = names.map((n) => ({ path: join(dir, n), name: n, extra: false }));
  for (const d of extras) {
    if (!statSync(d, { throwIfNoEntry: false })?.isDirectory()) throw new UsageError(`--extra-rules: not a directory: ${d}`);
    out.push(...yamlFiles(d).map((n) => ({ path: join(d, n), name: join(d, n), extra: true })));
  }
  return out.map((s) => ({ ...s, text: readFileSync(s.path, "utf8") }));
}

/** loadRules, but an extra rule reusing an id or name already taken (by a shipped rule or another extra) is a usage error, never a shadow. */
export function loadSources(sources: RuleSource[]): LoadResult {
  const res = loadRules(sources);
  const extra = new Set(sources.filter((s) => s.extra).map((s) => s.path));
  const dup = res.rejected.find((x) => x.reason === "duplicate-id" && extra.has(x.path));
  if (dup) throw new UsageError(`${dup.path}: ${dup.message}`);
  return res;
}

export const loadRuleDir = (dir: string, extras: string[] = []): LoadResult => loadSources(ruleSources(dir, extras));

/** commander parser for the repeatable `--extra-rules <dir>`. */
export const repeat = (v: string, prev: string[] = []) => [...prev, v];
export const EXTRA_HELP = "more rules to load on top of --rules (repeatable)";

const category = (r: Rule) => (r.kind === "correlation" ? "correlation" : (r.category ?? "any")) + (r.silenced ? " silenced" : "");

export function listRules(dir: string, io: IO, extras: string[] = []): number {
  const { rules, rejected } = loadRuleDir(dir, extras);
  const rows = rules.map((r) => `  ${(r.name ?? r.id).padEnd(44)} ${r.level.padEnd(13)} ${r.lane.padEnd(8)} ${category(r)}`);
  io.out(mask([`  ${rules.length} rules, ${rejected.length} rejected`, ...rows].join("\n") + "\n"));
  if (rejected.length) {
    io.out(mask(["", "  Rejected:", ...rejected.map((x) => `  ${x.path} #${x.doc} ${x.title ?? ""}: ${x.reason}: ${x.message}`)].join("\n") + "\n"));
  }
  return 0;
}

export function showRule(dir: string, key: string, io: IO, extras: string[] = []): number {
  const rule = loadRuleDir(dir, extras).rules.find((r) => r.name === key || r.id === key);
  if (!rule) throw new UsageError(`no rule named '${key}' (see \`retrohound rules list\`)`);
  const yaml = parseAllDocuments(readFileSync(rule.path, "utf8"))[rule.doc]?.toString() ?? "";
  const meta = `${rule.title}\nid: ${rule.id}  level: ${rule.level}  lane: ${rule.lane}  category: ${category(rule)}\nfile: ${rule.path}\n`;
  io.out(mask(`${meta}\n${yaml}`));
  return 0;
}

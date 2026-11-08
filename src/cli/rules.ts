// `retrohound rules list|show` and the rule-directory loader the CLI shares (ADR 0003). Read-only.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";
import { loadRules, type LoadResult, type Rule } from "../engine/load.ts";
import { mask } from "../normalize/mask.ts";
import { UsageError, type IO } from "./io.ts";

export function loadRuleDir(dir: string): LoadResult {
  let names: string[] = [];
  try {
    names = (readdirSync(dir, { recursive: true }) as string[]).map((n) => n.replaceAll("\\", "/")).filter((n) => /\.ya?ml$/.test(n));
  } catch {
    // no rules directory: an empty rule set, like scan
  }
  return loadRules(names.sort().map((n) => ({ path: join(dir, n), text: readFileSync(join(dir, n), "utf8") })));
}

const category = (r: Rule) => (r.kind === "correlation" ? "correlation" : (r.category ?? "any"));

export function listRules(dir: string, io: IO): number {
  const { rules, rejected } = loadRuleDir(dir);
  const rows = rules.map((r) => `  ${(r.name ?? r.id).padEnd(44)} ${r.level.padEnd(13)} ${r.lane.padEnd(8)} ${category(r)}`);
  io.out(mask([`  ${rules.length} rules, ${rejected.length} rejected`, ...rows].join("\n") + "\n"));
  if (rejected.length) {
    io.out(mask(["", "  Rejected:", ...rejected.map((x) => `  ${x.path} #${x.doc} ${x.title ?? ""}: ${x.reason}: ${x.message}`)].join("\n") + "\n"));
  }
  return 0;
}

export function showRule(dir: string, key: string, io: IO): number {
  const rule = loadRuleDir(dir).rules.find((r) => r.name === key || r.id === key);
  if (!rule) throw new UsageError(`no rule named '${key}' (see \`retrohound rules list\`)`);
  const yaml = parseAllDocuments(readFileSync(rule.path, "utf8"))[rule.doc]?.toString() ?? "";
  const meta = `${rule.title}\nid: ${rule.id}  level: ${rule.level}  lane: ${rule.lane}  category: ${category(rule)}\nfile: ${rule.path}\n`;
  io.out(mask(`${meta}\n${yaml}`));
  return 0;
}

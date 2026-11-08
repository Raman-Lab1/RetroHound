// `.retrohound-ignore.yml` (ADR 0003): hide known-benign findings at report time. The index keeps
// everything (ADR 0008); this only filters what scan, preflight and the hook report. Zero network.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { UsageError } from "./cli/io.ts";
import type { Rule } from "./engine/load.ts";
import { mask } from "./normalize/mask.ts";
import type { Finding } from "./normalize/types.ts";

/** String fields of the stored event a `match` may name (a typo is an error, never a silent no-match). */
const FIELDS = new Set([
  "agent", "agent_version", "session_id", "parent_session_id", "agent_id", "parent_tool_use_id", "project_path", "category",
  "tool_name", "command_line", "target_path", "url", "domain", "mcp_server", "mcp_tool", "outcome", "permission_mode",
  "prompt_source", "entrypoint", "attribution", "denial_kind", "denial_category", "text_excerpt",
]);
const KEYS = new Set(["rule", "match", "project_path", "reason"]);

export type IgnoreEntry = { rule_ids: Set<string>; match: Record<string, string>; project_path?: string; reason?: string; file: string };
export type Ignore = { entries: IgnoreEntry[]; files: string[] };
export const NO_IGNORE: Ignore = { entries: [], files: [] };

const isMap = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

function parseEntry(raw: unknown, i: number, file: string, rules: Rule[], skipUnknown: boolean): IgnoreEntry | undefined {
  const bad = (m: string) => new UsageError(`${file}: entry ${i + 1}: ${m}`);
  if (!isMap(raw)) throw bad("must be a mapping with `rule` and `match`");
  for (const k of Object.keys(raw)) if (!KEYS.has(k)) throw bad(`unknown key '${k}' (allowed: ${[...KEYS].join(", ")})`);
  if (typeof raw.rule !== "string") throw bad("`rule` must be a rule id or name (string)");
  const hit = rules.filter((r) => r.id === raw.rule || r.name === raw.rule);
  if (!hit.length) {
    if (skipUnknown) return undefined; // the hook loads only enforce rules; scan validates the whole file
    throw bad(`unknown rule '${raw.rule}'`);
  }
  const match = raw.match ?? {};
  if (!isMap(match)) throw bad("`match` must be a mapping of field to exact string");
  for (const [k, v] of Object.entries(match)) {
    if (!FIELDS.has(k)) throw bad(`unknown match field '${k}'`);
    if (typeof v !== "string") throw bad(`match.${k} must be a string`);
  }
  for (const k of ["project_path", "reason"] as const) if (raw[k] !== undefined && typeof raw[k] !== "string") throw bad(`${k} must be a string`);
  if (!Object.keys(match).length && raw.project_path === undefined) throw bad("needs `match` or `project_path` (an entry may not hide a whole rule)");
  return { rule_ids: new Set(hit.map((r) => mask(r.id))), match: match as Record<string, string>, project_path: raw.project_path as string | undefined, reason: raw.reason as string | undefined, file };
}

function parseFile(file: string, rules: Rule[], skipUnknown: boolean): IgnoreEntry[] {
  const doc = parseDocument(readFileSync(file, "utf8"));
  if (doc.errors.length) throw new UsageError(`${file}: ${doc.errors[0]!.message}`);
  let data: unknown;
  try {
    data = doc.toJS({ maxAliasCount: 0 }); // no aliases: no entity-expansion bombs
  } catch (e) {
    throw new UsageError(`${file}: ${(e as Error).message}`);
  }
  if (data == null) return [];
  if (!Array.isArray(data)) throw new UsageError(`${file}: must be a list of entries`);
  return data.flatMap((raw, i) => parseEntry(raw, i, file, rules, skipUnknown) ?? []);
}

/**
 * Search order: `file` (--ignore) if given, and it must exist; else `~/.retrohound/ignore.yml` if present.
 * A repo's own `.retrohound-ignore.yml` is never read implicitly: a malicious clone could hide its own sessions'
 * findings from `scan`, its own surface from `preflight`, or its own tool calls from the hook. Pass it with --ignore.
 */
export function loadIgnore(rules: Rule[], opts: { file?: string; home?: string; skipUnknownRules?: boolean } = {}): Ignore {
  if (opts.file && !existsSync(opts.file)) throw new UsageError(`--ignore file not found: ${opts.file}`);
  const candidates = opts.file
    ? [opts.file]
    : [join(opts.home ?? homedir(), ".retrohound", "ignore.yml")];
  const files = candidates.filter((f) => existsSync(f));
  return { entries: files.flatMap((f) => parseFile(f, rules, opts.skipUnknownRules ?? false)), files };
}

/** Matches on the finding's primary event (events[0]) as stored, i.e. the masked values `show` and the JSON report print. */
export function isSuppressed(f: Finding, ignore: Ignore): boolean {
  const e = f.events[0] as unknown as Record<string, unknown> | undefined;
  if (!e) return false;
  return ignore.entries.some(
    (x) => x.rule_ids.has(f.rule_id) && (x.project_path === undefined || e.project_path === x.project_path) && Object.entries(x.match).every(([k, v]) => e[k] === v),
  );
}

export function applyIgnore(findings: Finding[], ignore: Ignore): { kept: Finding[]; suppressed: number } {
  const kept = ignore.entries.length ? findings.filter((f) => !isSuppressed(f, ignore)) : findings;
  return { kept, suppressed: findings.length - kept.length };
}

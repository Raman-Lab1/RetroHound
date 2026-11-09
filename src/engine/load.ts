// Sigma v2.1 subset loader (ADR 0003). Whatever the engine cannot honour is rejected with a named reason, per document,
// so an unsupported rule is never evaluated wrongly and one bad rule does not sink the rest of its file.
import { parseAllDocuments } from "yaml";
import { CATEGORIES, LEVELS, type Category, type Level } from "../normalize/types.ts";
import { compileCondition } from "./condition.ts";
import { linkCorrelations, parseCorrelation, type CorrelationRule } from "./correlate.ts";
import { allOf, anyOf, compileItem, RuleError, type Pred } from "./modifiers.ts";

export type Lane = "hunt" | "enforce";

export type RuleMeta = {
  id: string; // `id`, else `name`, else `title`: Finding.rule_id always has a value
  name?: string;
  title: string;
  author?: string; // DRL 1.1: messages from matches keep the rule author
  level: Level; // medium when the rule sets none
  lane: Lane; // hunt when the rule sets none
  status?: string;
  description?: string;
  tags: string[];
  falsepositives: string[];
  path: string;
  doc: number; // position within the file
  silenced: boolean; // `rules list`: emits nothing, because only non-generating correlations reference it (0004)
};

export type DetectionRule = RuleMeta & {
  kind: "detection";
  category?: Category; // none = all categories
  service?: string; // AgentEvent.agent
  fields: string[]; // canonical fields read: tells which rules need match-only text (0006)
  matches: Pred;
};

export type Rule = DetectionRule | CorrelationRule;

export type Rejection = { path: string; doc: number; title?: string; reason: string; message: string };
export type LoadResult = { rules: Rule[]; rejected: Rejection[] };

type Doc = Record<string, unknown>;
type Where = { path: string; doc: number };

const SERVICES = new Set(["claude_code", "codex", "antigravity", "gemini_cli", "cursor"]);

function isMap(x: unknown): x is Doc {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function strings(doc: Doc, key: string): string[] {
  const v = doc[key];
  if (v == null) return [];
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v;
  throw new RuleError("bad-metadata", `${key} must be a list of strings`);
}

function optString(doc: Doc, key: string): string | undefined {
  const v = doc[key];
  if (v == null) return undefined;
  if (typeof v !== "string") throw new RuleError("bad-metadata", `${key} must be a string`);
  return v;
}

/** The metadata shared by detections and correlations, including the strict `x-retrohound` block. */
function parseMeta(doc: Doc, where: Where, maxEventsAllowed: boolean): RuleMeta {
  const title = doc.title;
  if (typeof title !== "string" || title === "") throw new RuleError("missing-title", "title is required");
  const level = doc.level ?? "medium";
  if (!LEVELS.includes(level as Level)) throw new RuleError("bad-metadata", `unknown level '${String(level)}'`);
  const x = doc["x-retrohound"] ?? {};
  if (!isMap(x)) throw new RuleError("bad-x-retrohound", "x-retrohound must be a map");
  const unknown = Object.keys(x).find((k) => k !== "lane" && !(k === "max_events_between" && maxEventsAllowed));
  if (unknown) throw new RuleError("bad-x-retrohound", `x-retrohound.${unknown} is not valid here`);
  const lane = x.lane ?? "hunt";
  if (lane !== "hunt" && lane !== "enforce") throw new RuleError("bad-x-retrohound", `unknown lane '${String(lane)}'`);
  const id = optString(doc, "id");
  const name = optString(doc, "name");
  return {
    id: id ?? name ?? title,
    name,
    title,
    author: optString(doc, "author"),
    level: level as Level,
    lane,
    status: optString(doc, "status"),
    description: optString(doc, "description"),
    tags: strings(doc, "tags"),
    falsepositives: strings(doc, "falsepositives"),
    ...where,
    silenced: false,
  };
}

function parseLogsource(doc: Doc): { category?: Category; service?: string } {
  const src = doc.logsource;
  if (!isMap(src)) throw new RuleError("missing-logsource", "logsource is required");
  if (src.product !== "ai_coding_agent") throw new RuleError("unknown-product", `unknown product '${String(src.product)}'`);
  if (src.category != null && !CATEGORIES.includes(src.category as Category)) throw new RuleError("unknown-category", `unknown category '${String(src.category)}'`);
  if (src.service != null && !SERVICES.has(src.service as string)) throw new RuleError("unknown-service", `unknown service '${String(src.service)}'`);
  return { category: (src.category ?? undefined) as Category | undefined, service: (src.service ?? undefined) as string | undefined };
}

function compileMap(map: Doc, id: string, used: Set<string>): Pred {
  const items = Object.entries(map).map(([key, value]) => compileItem(key, value, used));
  if (items.length === 0) throw new RuleError("bad-selection", `selection '${id}' is empty`);
  return allOf(items);
}

function compileSelection(id: string, body: unknown, used: Set<string>): Pred {
  if (isMap(body)) return compileMap(body, id, used);
  if (!Array.isArray(body) || !body.every(isMap)) throw new RuleError("keyword-list", `selection '${id}': keyword searches are not supported`);
  if (body.length === 0) throw new RuleError("bad-selection", `selection '${id}' is empty`);
  return anyOf(body.map((map) => compileMap(map, id, used)));
}

function compileDetection(doc: Doc, where: Where): DetectionRule {
  const meta = parseMeta(doc, where, false);
  const logsource = parseLogsource(doc);
  const detection = doc.detection;
  if (!isMap(detection)) throw new RuleError("missing-detection", "detection is required");
  const { condition, ...named } = detection;
  if ("timeframe" in named) throw new RuleError("obsolete-timeframe", "detection.timeframe is obsolete, use a correlation rule");
  const conditions = Array.isArray(condition) ? condition : [condition];
  if (conditions.length === 0 || !conditions.every((c) => typeof c === "string")) throw new RuleError("missing-condition", "detection.condition is required");
  const used = new Set<string>();
  const selections = new Map(Object.entries(named).map(([id, body]) => [id, compileSelection(id, body, used)]));
  const matches = anyOf(conditions.map((c: string) => compileCondition(c, selections)));
  return { ...meta, kind: "detection", ...logsource, fields: [...used], matches };
}

function compileDoc(doc: unknown, where: Where): Rule {
  if (!isMap(doc)) throw new RuleError("not-a-rule", "a rule document must be a map");
  if ("action" in doc) throw new RuleError("unsupported-document", "rule collections (action:) are not supported");
  if ("filter" in doc) throw new RuleError("unsupported-document", "Sigma filter documents are not supported");
  if ("correlation" in doc) return parseCorrelation(doc, parseMeta(doc, where, true));
  return compileDetection(doc, where);
}

/** One YAML document as plain data, or the parse error that makes it a rejection. JSON-safe, so a loader may cache it. */
export type ParsedDoc = { error: string; reason?: string; data?: undefined } | { error?: undefined; data: unknown };
export type Source = { path: string; text: string; docs?: ParsedDoc[] }; // docs = parseSource(text) done earlier

/** Throws only when the file as a whole is not YAML. */
export function parseSource(text: string): ParsedDoc[] {
  return parseAllDocuments(text).map((p): ParsedDoc => {
    try {
      return p.errors.length > 0 ? { error: p.errors[0]!.message } : { data: p.toJS() };
    } catch (e) {
      return { error: (e as Error).message, reason: "invalid-rule" };
    }
  });
}

/** Parses every document of every source. Never throws on rule content. */
export function loadRules(sources: Source[]): LoadResult {
  const rules: Rule[] = [];
  const rejected: Rejection[] = [];
  const claimed = new Map<string, Rule>(); // `id`s and `name`s share one namespace: a correlation may use either
  for (const { path, text, docs: cached } of sources) {
    let docs;
    try {
      docs = cached ?? parseSource(text);
    } catch (e) {
      rejected.push({ path, doc: 0, reason: "yaml-parse", message: (e as Error).message });
      continue;
    }
    docs.forEach((parsed, doc) => {
      let title: string | undefined;
      try {
        if (parsed.error !== undefined) throw new RuleError(parsed.reason ?? "yaml-parse", parsed.error);
        const data = parsed.data;
        if (data === null || data === undefined) return; // a trailing `---`
        if (isMap(data) && typeof data.title === "string") title = data.title;
        const rule = compileDoc(data, { path, doc });
        const keys = [isMap(data) ? data.id : null, rule.name].filter((k) => k != null) as string[];
        const taken = keys.find((k) => claimed.has(k));
        if (taken) throw new RuleError("duplicate-id", `'${taken}' is already used by ${claimed.get(taken)!.path}`);
        for (const k of keys) claimed.set(k, rule);
        rules.push(rule);
      } catch (e) {
        if (e instanceof RuleError) rejected.push({ path, doc, title, reason: e.reason, message: e.message });
        else rejected.push({ path, doc, title, reason: "invalid-rule", message: (e as Error).message });
      }
    });
  }
  const kept = linkCorrelations(rules, claimed, (rule, e) => {
    rejected.push({ path: rule.path, doc: rule.doc, title: rule.title, reason: e.reason, message: e.message });
  });
  return { rules: kept, rejected };
}

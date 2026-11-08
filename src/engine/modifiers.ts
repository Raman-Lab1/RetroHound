// Compiles one `field|mod|mod: value` item of a Sigma selection into a predicate (ADR 0003). All pattern work is done
// here, once. The returned closures run per event, so they use string methods where they can and lowercase a field
// at most once per event, however many rules read it.
import { isInside } from "../normalize/paths.ts";
import { downloadExecuted, resetDerived, unquotedOf } from "./derived.ts";
import type { RawEvent } from "../normalize/types.ts";

export type Row = Record<string, unknown>;
export type Pred = (ev: Row) => boolean;

/** A rule the engine refuses. `reason` is a stable name, `message` is for the rule author. */
export class RuleError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

// `satisfies` fails the build here when the contract gains or loses a field.
const FIELD_TABLE = {
  id: 1, schema_version: 1, agent: 1, agent_version: 1, session_id: 1, parent_session_id: 1, agent_id: 1,
  parent_tool_use_id: 1, project_path: 1, ts: 1, seq: 1, category: 1, tool_name: 1, command_line: 1, target_path: 1,
  url: 1, domain: 1, mcp_server: 1, mcp_tool: 1, outcome: 1, permission_mode: 1, prompt_source: 1, entrypoint: 1,
  attribution: 1, denial_kind: 1, denial_category: 1, secret_kinds: 1, result_secret_kinds: 1, secret_fps: 1,
  text_excerpt: 1, raw_ref: 1, content: 1, tool_input: 1, tool_response: 1, text: 1,
} satisfies Record<keyof RawEvent, 1>;

// Fields the engine computes, so they work on raw parser events and DB rows alike. They are not in the contract.
// The booleans take only true or false; command_line_unquoted is a string that takes every string modifier.
const UNQUOTED = "command_line_unquoted";
const BOOLEANS = new Map<string, { reads: string[]; test: (ev: Row) => boolean }>([
  ["target_outside_project", { reads: ["target_path", "project_path"], test: (ev) => outsideProject(ev) }],
  ["download_executed", { reads: ["command_line"], test: (ev) => typeof ev.command_line === "string" && downloadExecuted(ev.command_line) }],
]);
const FIELDS = new Set([...Object.keys(FIELD_TABLE), ...BOOLEANS.keys(), UNQUOTED]);
const ALIASES = new Map([
  ["CommandLine", "command_line"],
  ["TargetFilename", "target_path"],
  ["CurrentDirectory", "project_path"],
]);
const LIST_FIELDS = new Set(["secret_kinds", "result_secret_kinds", "secret_fps"]);
const NUMERIC_FIELDS = new Set(["seq"]);

export const isDerived = (field: string): boolean => field === UNQUOTED || BOOLEANS.has(field);

// How a predicate reads a field, and what `used` records for it: the stored column the value comes from.
const reader = (field: string): ((ev: Row) => unknown) => (field === UNQUOTED ? unquotedOf : (ev) => ev[field]);
const source = (field: string): string => (field === UNQUOTED ? "command_line" : field);

/** True when both paths are set and the target is provably not under the project root (`/proj-evil` is outside `/proj`). */
function outsideProject(ev: Row): boolean {
  const t = ev.target_path;
  const p = ev.project_path;
  return typeof t === "string" && typeof p === "string" && t !== "" && p !== "" && !isInside(t, p);
}

/** The canonical name of a field a rule mentions, or a rejection: a typo must not become a silent false. */
export function resolveField(name: string): string {
  const field = ALIASES.get(name) ?? name;
  if (!FIELDS.has(field)) throw new RuleError("unknown-field", `unknown field '${name}'`);
  return field;
}

// One lowercased value per field, valid for the event it was computed from.
type Slot = { ev: Row | null; val: string };
const SLOTS = new Map<string, Slot>();

function slotFor(field: string): Slot {
  let slot = SLOTS.get(field);
  if (!slot) SLOTS.set(field, (slot = { ev: null, val: "" }));
  return slot;
}

function lowered(slot: Slot, ev: Row, value: string): string {
  if (slot.ev === ev) return slot.val;
  slot.ev = ev;
  return (slot.val = value.toLowerCase());
}

/** Drops the cache so no raw text outlives a run and a reused event object cannot read stale values. */
export function resetFieldCache(): void {
  for (const slot of SLOTS.values()) {
    slot.ev = null;
    slot.val = "";
  }
  resetDerived();
}

const STAR = -1;
const ONE = -2;
const DASH = -3; // windash: any of - / en-dash em-dash horizontal-bar
const DASHES = [0x2d, 0x2f, 0x2013, 0x2014, 0x2015];
const isWord = (c: string | undefined) => c !== undefined && /\w/.test(c);

// `\` escapes only `*`, `?` and itself; before anything else, or at the end, it is a plain backslash. So `C:\Users\`
// needs no doubling, `\*` is a literal star and `\\*` is a backslash then a wildcard.
function parsePattern(value: string, windash: boolean): number[] {
  const out: number[] = [];
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    const next = value[i + 1];
    if (c === "\\" && (next === "*" || next === "?" || next === "\\")) out.push(value.charCodeAt(++i));
    else if (c === "*") out.push(STAR);
    else if (c === "?") out.push(ONE);
    else if (windash && (c === "-" || c === "/") && !isWord(value[i - 1]) && isWord(next)) out.push(DASH);
    else out.push(value.charCodeAt(i));
  }
  return out;
}

// Iterative, so a pattern from a rule file cannot backtrack exponentially: O(text * pattern) at worst, no allocation.
function globMatch(s: string, p: number[]): boolean {
  let i = 0;
  let j = 0;
  let star = -1;
  let mark = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    const t = p[j]; // undefined past the end
    if (t === STAR) {
      star = j++;
      mark = i;
    } else if (t === ONE || t === c || (t === DASH && DASHES.includes(c))) {
      i++;
      j++;
    } else if (star >= 0) {
      j = star + 1;
      i = ++mark;
    } else return false;
  }
  while (p[j] === STAR) j++;
  return j === p.length;
}

type StringTest = (s: string) => boolean;
type Shape = "exact" | "contains" | "startswith" | "endswith";

type Plan = { codes: number[]; lit: string | null; kind: "includes" | "endsWith" | "startsWith" | "equals" };

function plan(value: string, shape: Shape, cased: boolean, windash: boolean): Plan {
  const codes = parsePattern(cased ? value : value.toLowerCase(), windash);
  if (shape === "contains" || shape === "endswith") codes.unshift(STAR);
  if (shape === "contains" || shape === "startswith") codes.push(STAR);
  let from = 0;
  let to = codes.length;
  while (from < to && codes[from] === STAR) from++;
  while (to > from && codes[to - 1] === STAR) to--;
  const core = codes.slice(from, to);
  const head = from > 0;
  const tail = to < codes.length;
  const kind = head && tail ? "includes" : head ? "endsWith" : tail ? "startsWith" : "equals";
  return { codes, kind, lit: core.some((c) => c < 0) ? null : String.fromCharCode(...core) };
}

function planTest(p: Plan): StringTest {
  const lit = p.lit;
  if (lit === null) return (s) => globMatch(s, p.codes);
  if (p.kind === "includes") return (s) => s.includes(lit);
  if (p.kind === "endsWith") return (s) => s.endsWith(lit);
  if (p.kind === "startsWith") return (s) => s.startsWith(lit);
  return (s) => s === lit;
}

const patternTest = (value: string, shape: Shape, cased: boolean, windash: boolean): StringTest => planTest(plan(value, shape, cased, windash));

// A long OR-list of plain literals on one field is one alternation regex per match kind instead of one scan per value.
// The literals are escaped and (case-insensitive path) already lowercased, and the regex has no `i` flag and runs on the
// same lowercased text as includes/startsWith/endsWith, so there is no case-folding difference. No `re` checks or 8 KiB cap.
const MIN_MERGE = 4;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const REGEX_WRAP = { includes: ["", ""], startsWith: ["^", ""], endsWith: ["", "$"] } as const;

function mergedTest(kind: keyof typeof REGEX_WRAP, lits: string[]): StringTest {
  const [pre, post] = REGEX_WRAP[kind];
  const re = new RegExp(`${pre}(?:${lits.map(escapeRe).join("|")})${post}`);
  return (s) => re.test(s);
}

/** The tests for an OR-list: literals of the same kind merge once there are enough of them, the rest stay as they were. */
function orTests(plans: Plan[]): StringTest[] {
  const by = new Map<string, string[]>();
  for (const p of plans) if (p.lit !== null && p.kind !== "equals") by.set(p.kind, [...(by.get(p.kind) ?? []), p.lit]);
  const tests: StringTest[] = [];
  const merged = new Set<string>();
  for (const [kind, lits] of by) {
    if (lits.length < MIN_MERGE) continue;
    merged.add(kind);
    tests.push(mergedTest(kind as keyof typeof REGEX_WRAP, lits));
  }
  for (const p of plans) if (p.lit === null || !merged.has(p.kind)) tests.push(planTest(p));
  return tests;
}

// Refuses what 0003 bans and what JS would silently read differently from PCRE (`\A` is a plain `A` here).
function checkRegex(src: string): void {
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === "\\") {
      const n = src[++i] ?? "";
      if (n === "k" || (!inClass && /[1-9]/.test(n))) throw new RuleError("regex-backreference", `backreference in /${src}/`);
      if (/[a-zA-Z]/.test(n) && !"dDwWsSbBnrtfvcxu".includes(n)) throw new RuleError("bad-regex", `unsupported escape \\${n} in /${src}/`);
      if ((n === "u" || n === "x") && src[i + 1] === "{") throw new RuleError("bad-regex", `\\${n}{...} in /${src}/: write a character above U+FFFF as a surrogate pair`);
    } else if (inClass) {
      if (c === "]") inClass = false;
      else if (c === "[" && src[i + 1] === ":") throw new RuleError("bad-regex", `POSIX class in /${src}/`);
      else if (c >= "\uD800" && c <= "\uDFFF") throw new RuleError("bad-regex", `character above U+FFFF inside [...] in /${src}/: it would match half a character`);
    } else if (c === "[") inClass = true;
    else if (c === "(" && /^\(\?<?[=!]/.test(src.slice(i, i + 4))) throw new RuleError("regex-lookaround", `lookaround in /${src}/`);
  }
}

// shortcut: `re` sees only the first 8 KiB of a field, so a match past that is missed (0006 stores up to 32 MB); raise
// it, or scan the tail too, when a rule needs it. The cap bounds linear and quadratic patterns (`a+b`); an unanchored
// `.*a.*b` is cubic in V8 (about 1 s at 1 KiB), which only reviewed bundled rules may use.
const REGEX_MAX_TEXT = 8192;

function regexTest(value: unknown, flags: string): StringTest {
  if (typeof value !== "string") throw new RuleError("bad-value", "re needs a string pattern");
  checkRegex(value);
  try {
    const re = new RegExp(value, flags);
    return (s) => re.test(s.length > REGEX_MAX_TEXT ? s.slice(0, REGEX_MAX_TEXT) : s);
  } catch (e) {
    throw new RuleError("bad-regex", `${(e as Error).message} (inline flags: use |re|i, |re|m, |re|s)`);
  }
}

function onField(field: string, cased: boolean, test: StringTest): Pred {
  const slot = slotFor(field);
  const get = reader(field);
  return (ev) => {
    const v = get(ev);
    if (typeof v === "string") return test(cased ? v : lowered(slot, ev, v));
    if (typeof v === "number") return test(String(v));
    if (Array.isArray(v)) return (v as string[]).some((x) => test(cased ? x : x.toLowerCase())); // any element
    return false;
  };
}

function fieldrefPred(field: string, other: string, shape: Shape): Pred {
  const a = slotFor(field);
  const b = slotFor(other);
  const text = (slot: Slot, ev: Row, name: string): string | null => {
    const v = reader(name)(ev);
    return typeof v === "string" ? lowered(slot, ev, v) : typeof v === "number" ? String(v) : null;
  };
  return (ev) => {
    const x = text(a, ev, field);
    const y = text(b, ev, other);
    if (x === null || y === null) return false;
    return shape === "startswith" ? x.startsWith(y) : shape === "endswith" ? x.endsWith(y) : x === y;
  };
}

export function anyOf(ps: Pred[]): Pred {
  if (ps.length === 1) return ps[0]!;
  return (ev) => {
    for (const p of ps) if (p(ev)) return true;
    return false;
  };
}

export function allOf(ps: Pred[]): Pred {
  if (ps.length === 1) return ps[0]!;
  return (ev) => {
    for (const p of ps) if (!p(ev)) return false;
    return true;
  };
}

const COMPARE: Record<string, (a: number, b: number) => boolean> = {
  gt: (a, b) => a > b,
  gte: (a, b) => a >= b,
  lt: (a, b) => a < b,
  lte: (a, b) => a <= b,
};

type Mods = { shape: Shape; re: boolean; flags: string; cased: boolean; all: boolean; exists: boolean; cmp: string; fieldref: boolean; windash: boolean };

function parseMods(field: string, mods: string[]): Mods {
  const m: Mods = { shape: "exact", re: false, flags: "", cased: false, all: false, exists: false, cmp: "", fieldref: false, windash: false };
  const combo = (why: string) => new RuleError("bad-modifier-combo", `${field}|${mods.join("|")}: ${why}`);
  if (new Set(mods).size !== mods.length) throw combo("repeated modifier");
  for (const mod of mods) {
    if (mod === "contains" || mod === "startswith" || mod === "endswith") {
      if (m.shape !== "exact") throw combo("only one of contains, startswith, endswith");
      m.shape = mod;
    } else if (mod === "re") m.re = true;
    else if (mod === "i" || mod === "m" || mod === "s") m.flags += mod;
    else if (mod === "cased") m.cased = true;
    else if (mod === "all") m.all = true;
    else if (mod === "exists") m.exists = true;
    else if (Object.hasOwn(COMPARE, mod)) m.cmp = mod;
    else if (mod === "fieldref") m.fieldref = true;
    else if (mod === "windash") m.windash = true;
    else if (mod === "expand") throw new RuleError("placeholder", `${field}: placeholders are not supported`);
    else throw new RuleError("unsupported-modifier", `${field}: modifier '${mod}' is not supported`);
  }
  if ((m.exists || m.cmp) && mods.length > 1) throw combo(`${m.cmp || "exists"} stands alone`);
  if (m.flags && !m.re) throw combo("regex flags need re");
  if (m.re && (m.shape !== "exact" || m.cased || m.windash)) throw combo("re takes only all and the flags i, m, s");
  if (m.fieldref && (m.shape === "contains" || m.cased || m.all || m.windash)) throw combo("fieldref takes only startswith or endswith");
  return m;
}

function derivedItem(field: string, mods: string[], value: unknown, used: Set<string>): Pred {
  if (mods.length > 0 || typeof value !== "boolean") throw new RuleError("bad-value", `${field} takes true or false and no modifiers`);
  const { reads, test } = BOOLEANS.get(field)!;
  for (const f of reads) used.add(f);
  return (ev) => test(ev) === value;
}

/** Compiles one selection map entry. `used` collects every canonical field the rule reads. */
export function compileItem(key: string, value: unknown, used: Set<string>): Pred {
  const [name = "", ...mods] = key.split("|");
  if (name === "") throw new RuleError("keyword-list", `'${key}' names no field: keyword searches are not supported`);
  const field = resolveField(name);
  if (BOOLEANS.has(field)) return derivedItem(field, mods, value, used);
  used.add(source(field));
  const get = reader(field);
  const m = parseMods(field, mods);
  const list: unknown[] = Array.isArray(value) ? value : [value];
  if (list.length === 0) throw new RuleError("bad-value", `${field}: empty value list`);

  if (m.exists) {
    if (typeof value !== "boolean") throw new RuleError("bad-value", `${field}|exists needs true or false`);
    return value ? (ev) => get(ev) != null : (ev) => get(ev) == null; // a DB row's NULL counts as absent
  }
  if (field === "raw_ref") throw new RuleError("bad-value", "raw_ref is an object: only |exists applies");
  if (value === null) {
    if (mods.length > 0) throw new RuleError("bad-value", `${field}: null takes no modifiers`);
    return (ev) => get(ev) == null;
  }
  if (list.includes(null)) throw new RuleError("null-in-list", `${field}: null must be its own selection`);
  if (m.all && list.length < 2) throw new RuleError("bad-modifier-combo", `${field}|all needs at least two values`);
  for (const v of list) {
    if (typeof v !== "string" && typeof v !== "number") throw new RuleError("bad-value", `${field}: ${JSON.stringify(v)} is not a string or number`);
  }

  if (m.cmp) {
    if (!NUMERIC_FIELDS.has(field)) throw new RuleError("bad-value", `${field}|${m.cmp}: field is not numeric`);
    const compare = COMPARE[m.cmp]!;
    return anyOf(
      list.map((v) => {
        if (typeof v !== "number") throw new RuleError("bad-value", `${field}|${m.cmp} needs a number`);
        return (ev) => typeof ev[field] === "number" && compare(ev[field], v);
      }),
    );
  }
  if (m.fieldref) {
    if (LIST_FIELDS.has(field)) throw new RuleError("bad-modifier-combo", `${field}|fieldref: not a scalar field`);
    return anyOf(
      list.map((v) => {
        const other = resolveField(String(v));
        if (LIST_FIELDS.has(other) || other === "raw_ref" || BOOLEANS.has(other)) throw new RuleError("bad-modifier-combo", `${field}|fieldref: ${other} is not a scalar field`);
        used.add(source(other));
        return fieldrefPred(field, other, m.shape);
      }),
    );
  }
  if (!m.re && !m.all) {
    const tests = orTests(list.map((v) => plan(String(v), m.shape, m.cased, m.windash)));
    return onField(field, m.cased, tests.length === 1 ? tests[0]! : (s) => tests.some((t) => t(s)));
  }
  const preds = list.map((v) =>
    m.re ? onField(field, true, regexTest(v, m.flags)) : onField(field, m.cased, patternTest(String(v), m.shape, m.cased, m.windash)),
  );
  return m.all ? allOf(preds) : anyOf(preds);
}

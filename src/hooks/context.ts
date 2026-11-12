// An Edit's old_string is a fragment: a rule cannot tell whether it sits inside the hooks block of the settings file.
// The live hook can read the file as it is now (config paths only, 1 MiB cap) and, when the fragment overlaps a hook
// section, appends IN_HOOKS to the event's content so the enforce rule decides. The rule, not this file, blocks.
import { readFileSync, statSync } from "node:fs";
import type { RawEvent } from "../normalize/types.ts";

export const IN_HOOKS = "x-retrohound-in-hooks-block";
const CONFIG = /(?:^|\/)(?:\.claude\/settings(?:\.local)?\.json|\.gemini\/settings\.json|\.codex\/config\.toml)$/i;
const JSON_KEYS = /"(?:hooks|statusLine|apiKeyHelper|awsAuthRefresh|awsCredentialExport|otelHeadersHelper)"\s*:\s*/gi;
const TOML_HEAD = /^[ \t]*\[\[?[ \t]*([^\]\n]*?)[ \t]*\]/gm;
const TOML_NOTIFY = /^[ \t]*["']?notify["']?[ \t]*=/gim;
const MAX = 1024 * 1024;

/** End (exclusive) of the JSON value starting at `i`: a string, a balanced {} or [], or a bare token. */
function valueEnd(t: string, i: number): number {
  let depth = 0, str = false;
  for (let j = i; j < t.length; j++) {
    const c = t[j]!;
    if (str) {
      if (c === "\\") j++;
      else if (c === '"') { str = false; if (!depth) return j + 1; }
    } else if (c === '"') str = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") { if (--depth <= 0) return j + 1; }
    else if (!depth && (c === "," || c === "\n")) return j;
  }
  return t.length;
}

/** [start, end) ranges of the hook-bearing parts of a settings file. */
export function hookSpans(text: string, toml: boolean): [number, number][] {
  const out: [number, number][] = [];
  if (!toml) {
    for (const m of text.matchAll(JSON_KEYS)) out.push([m.index!, valueEnd(text, m.index! + m[0].length)]);
    return out;
  }
  const heads = [...text.matchAll(TOML_HEAD)];
  heads.forEach((h, k) => { if (/^hooks(?:[.\s]|$)/i.test(h[1]!)) out.push([h.index!, heads[k + 1]?.index ?? text.length]); });
  for (const m of text.matchAll(TOML_NOTIFY)) { // any table: over-marking only blocks an edit that touches a notify key
    const at = m.index! + m[0].length;
    const arr = /^[ \t]*\[/.exec(text.slice(at, at + 20));
    out.push([m.index!, arr ? valueEnd(text, at + arr[0].length - 1) : (text.indexOf("\n", at) + 1 || text.length)]);
  }
  return out;
}

const olds = (input: string | undefined): string[] => {
  try {
    const i = JSON.parse(input ?? "{}");
    return [i.old_string, ...(Array.isArray(i.edits) ? i.edits.map((e: any) => e?.old_string) : [])].filter((s): s is string => typeof s === "string" && s !== "");
  } catch {
    return [];
  }
};

/** The event with IN_HOOKS in its content when an Edit/MultiEdit old_string overlaps a hook section of the current file. */
export function markHooksEdit(e: RawEvent): RawEvent {
  if (e.category !== "file_event" || !e.target_path || !CONFIG.test(e.target_path) || !/^(?:Multi)?Edit$/.test(e.tool_name ?? "")) return e;
  try {
    if (statSync(e.target_path).size > MAX) return e;
    const text = readFileSync(e.target_path, "utf8");
    const spans = hookSpans(text, e.target_path.toLowerCase().endsWith(".toml"));
    const hit = olds(e.tool_input).some((o) => {
      for (let at = text.indexOf(o); at >= 0; at = text.indexOf(o, at + 1)) if (spans.some(([s, end]) => at < end && at + o.length > s)) return true;
      return false;
    });
    return hit ? { ...e, content: `${e.content ?? ""}\n${IN_HOOKS}` } : e;
  } catch {
    return e; // unreadable or missing: the rule sees the event as before
  }
}

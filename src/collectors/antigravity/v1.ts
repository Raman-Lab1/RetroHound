// Antigravity CLI transcript_full.jsonl -> events (docs/formats/antigravity.md). A bad line is counted, never fatal.
// Tool args are translated to Claude Code's shape and run through mapToolUse, so paths, heredocs, URLs and secrets are
// handled the same way; tool_name stays Antigravity's own name (see the rule-coverage notes in the format doc).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { secretFingerprints, secretKinds } from "../../normalize/mask.ts";
import { normalizeSlashes } from "../../normalize/paths.ts";
import type { ParsedFile, RawEvent } from "../../normalize/types.ts";
import { type ToolFields, mapToolUse, toJson } from "../claude-code/v1.ts";
import { conversations, locate, rootOf } from "./discover.ts";

type Line = Record<string, any>;
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i;
const EXIT = /Command exited with code (-?\d+)/;
const REQUEST = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/;

function addSecrets(ev: Partial<RawEvent>): void {
  const raw = [ev.tool_input, ev.content].filter((s) => s !== undefined);
  const kinds = [...new Set(raw.flatMap((s) => secretKinds(s)))];
  const fps = [...new Set(raw.flatMap((s) => secretFingerprints(s)))];
  if (kinds.length) ev.secret_kinds = kinds;
  if (fps.length) ev.secret_fps = fps;
}

/** Fields for one tool call; undefined for a tool name we do not know (the caller counts it). Shared with the live
 * hook (src/hooks/agents.ts). Both name sets: the CLI transcripts' (read_file, ...) and the hooks doc's (view_file, ...). */
export function mapCall(name: string, a: Line, cwd?: string): ToolFields | undefined {
  const path = str(a.Path) ?? str(a.AbsolutePath) ?? str(a.TargetFile);
  switch (name) {
    case "run_command": return mapToolUse("Bash", { command: a.CommandLine }, cwd);
    case "read_file": case "view_file": return mapToolUse("Read", { file_path: path }, cwd);
    case "write_file": case "write_to_file": return mapToolUse("Write", { file_path: path, content: a.Content ?? a.CodeContent }, cwd);
    case "edit_file": case "replace_file_content": return mapToolUse("Edit", { file_path: path, new_string: a.Replacement ?? a.ReplacementContent }, cwd);
    case "multi_replace_file_content": return mapToolUse("Edit", { file_path: path, new_string: toJson(a.ReplacementChunks ?? []) }, cwd);
    case "read_url_content": return mapToolUse("WebFetch", { url: a.Url });
    case "search_web": {
      const q = str(a.query);
      return q && URL_LIKE.test(q) ? mapToolUse("WebFetch", { url: q }) : { category: "web_request", tool_name: name };
    }
    case "invoke_subagent":
    case "ask_question": return { category: "tool_call", tool_name: name };
    default: return undefined;
  }
}

function outcomeOf(ev: RawEvent, text: string): RawEvent["outcome"] {
  if (ev.tool_name !== "run_command") return "success"; // ask_question: a Deny answer is data, not a rejected call
  const code = EXIT.exec(text)?.[1];
  return code === undefined ? "unknown" : code === "0" ? "success" : "error";
}

/** Parses one transcript_full.jsonl. Never throws. */
export async function parseFile(path: string): Promise<ParsedFile & { sha256?: string }> {
  const file = normalizeSlashes(path);
  const { brain, conv } = locate(path);
  const map = brain ? conversations(brain) : new Map();
  const root = rootOf(map, conv);
  const project = str(map.get(conv)?.workspace);
  const events: RawEvent[] = [];
  const unknown = new Map<string, number>(); // a Map: names come from the transcript
  const stats: ParsedFile["stats"] = { lines: 0, malformed: 0, unknown_types: {} };
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    stats.malformed++; // unreadable or removed mid-scan
    return { events, stats };
  }
  const count = (k: string) => unknown.set(k, (unknown.get(k) ?? 0) + 1);
  let pending: RawEvent[] = []; // calls awaiting their GENERIC result, in order

  const parseLine = (raw: string, i: number) => {
    if (!raw.trim()) return;
    stats.lines++;
    let o: Line;
    try {
      o = JSON.parse(raw);
      if (o === null || typeof o !== "object" || Array.isArray(o)) throw new Error("not an object");
    } catch {
      stats.malformed++;
      return;
    }
    let sub = 0;
    const emit = (fields: Partial<RawEvent>) => {
      const id = createHash("sha256").update(`${file}\0${o.step_index ?? `L${i}`}\0${sub++}`).digest("hex").slice(0, 32);
      const all = { id, schema_version: "0.1", agent: "antigravity", session_id: root, ts: str(o.created_at) ?? "", seq: events.length,
        raw_ref: { file, line: i + 1 }, agent_id: conv === root ? undefined : conv, project_path: project, ...fields };
      // absent, never undefined: `|exists` tests presence
      const ev = Object.fromEntries(Object.entries(all).filter(([, v]) => v !== undefined)) as RawEvent;
      events.push(ev);
      return ev;
    };
    switch (o.type) {
      case "USER_INPUT": {
        pending = [];
        const text = str(o.content);
        if (text) emit({ category: "user_prompt", text: REQUEST.exec(text)?.[1] ?? text, prompt_source: "typed" });
        break;
      }
      case "PLANNER_RESPONSE":
        pending = []; // a call still waiting here never got a result: it stays outcome unknown
        if (str(o.content)) emit({ category: "assistant_message", text: o.content });
        for (const c of Array.isArray(o.tool_calls) ? o.tool_calls : []) {
          const name = str(c?.name);
          if (!name) continue;
          const args: Line = c.args !== null && typeof c.args === "object" ? c.args : {};
          const fields = mapCall(name, args, project);
          if (!fields) count(`tool:${name}`);
          const ev = emit({ category: "tool_call", ...fields, tool_name: name, tool_input: toJson(args), outcome: "unknown" });
          addSecrets(ev);
          pending.push(ev);
        }
        break;
      case "GENERIC": {
        const ev = pending.shift();
        const text = str(o.content);
        if (!ev || !text) break;
        ev.tool_response = text;
        ev.outcome = outcomeOf(ev, text);
        const kinds = secretKinds(text);
        if (kinds.length) ev.result_secret_kinds = kinds;
        break;
      }
      case "SYSTEM_MESSAGE":
        break; // the parent's notice that opens a sub-agent conversation
      default:
        count(String(o.type));
    }
  };
  bytes.toString("utf8").split("\n").forEach((raw, i) => {
    try {
      parseLine(raw, i);
    } catch {
      stats.malformed++; // e.g. nesting deep enough to overflow the stack: only this line is lost
    }
  });
  stats.unknown_types = Object.fromEntries(unknown);
  return { events, stats, sha256: createHash("sha256").update(bytes).digest("hex") };
}

// Per-agent PreToolUse protocol for `hook run --agent` (ADR 0009): payload -> the RawEvent the rules see, built with
// the collectors' own mapping, and a decision in that agent's output format. Never `allow`, never input rewrites.
// Codex: learn.chatgpt.com/docs/hooks. Antigravity: antigravity.google/docs/hooks.
import { mapToolUse, type ToolFields } from "../collectors/claude-code/v1.ts";
import { mapCall } from "../collectors/antigravity/v1.ts";
import { cwdOf, mapItem, shellFields, type Fields } from "../collectors/codex/map.ts";
import { secretFingerprints, secretKinds } from "../normalize/mask.ts";
import type { RawEvent } from "../normalize/types.ts";

export const AGENTS = ["claude_code", "codex", "antigravity"] as const;
export type Agent = (typeof AGENTS)[number];
type Line = Record<string, any>;
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const obj = (v: unknown): Line => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Line) : {});

const base = (agent: Agent, id: unknown, session: unknown, cwd?: string) => ({
  id: String(id ?? "hook"), schema_version: "0.1", agent, session_id: String(session ?? ""), ts: new Date().toISOString(),
  seq: 0, raw_ref: { file: "hook", line: 0 }, project_path: cwd,
});

function claude(p: Line): RawEvent {
  const cwd = str(p.cwd);
  return { ...base("claude_code", p.tool_use_id, p.session_id, cwd), permission_mode: str(p.permission_mode), agent_id: str(p.agent_id),
    ...mapToolUse(p.tool_name, p.tool_input, cwd) } as RawEvent;
}

/**
 * apply_patch envelope (`*** Add File: p` / `*** Update File: p` [`*** Move to: q`] / `*** Delete File: p`, body lines
 * after each) -> the rollout's FileChange `changes` map, so the collector's own mapping makes the file_events. The live
 * payload is unseen (docs/formats/codex.md), so the patch is taken from any string in tool_input that has these headers.
 */
export function patchChanges(input: unknown): Record<string, Line> {
  const texts = typeof input === "string" ? [input] : Object.values(obj(input)).flatMap((v) => (Array.isArray(v) ? v : [v]));
  const patch = texts.find((t): t is string => typeof t === "string" && /^\*\*\* (?:Add|Update|Delete) File: /m.test(t)) ?? "";
  const changes: Record<string, Line> = {};
  let cur: Line | undefined;
  for (const line of patch.split(/\r?\n/)) {
    const h = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (h) changes[h[2]!.trim()] = cur = { type: h[1]!.toLowerCase(), lines: [] };
    else if (cur && line.startsWith("*** Move to: ")) cur.move_path = line.slice(13).trim();
    else if (cur && !/^\*\*\* (?:End|Begin) Patch/.test(line)) cur.lines.push(line);
  }
  for (const c of Object.values(changes)) {
    if (c.type === "add") c.content = c.lines.map((l: string) => l.replace(/^\+/, "")).join("\n");
    else if (c.type === "update") c.unified_diff = c.lines.join("\n");
    delete c.lines;
  }
  return changes;
}

function codex(p: Line): RawEvent[] {
  const cwd = cwdOf(p.cwd);
  const c = obj(p.tool_input).command;
  const head = { ...base("codex", p.tool_use_id, p.session_id, cwd), permission_mode: str(p.permission_mode) };
  const files = p.tool_name === "apply_patch" ? mapItem({ type: "FileChange", changes: patchChanges(p.tool_input) }, false, cwd) as Fields[] : [];
  // apply_patch with no file header stays one tool_call; outcome is unknown before the tool runs, so it is left out
  if (files.length) return files.map(({ outcome: _, ...f }) => ({ ...head, ...f }) as RawEvent);
  // Bash: the same command_line extraction as the rollout collector's shell calls (codex/v1.ts)
  const f = p.tool_name === "Bash" ? shellFields(Array.isArray(c) ? c.map(String) : typeof c === "string" ? [c] : [], cwd) : mapToolUse(p.tool_name, p.tool_input, cwd);
  return [{ ...head, ...f } as RawEvent];
}

// Same mapping as the Antigravity collector; a tool it does not know is still a tool_call the rules can see.
const agyFields = (name: string, a: Line, cwd?: string): ToolFields => mapCall(name, a, cwd) ?? { category: "tool_call", tool_name: name };

function antigravity(p: Line): RawEvent {
  const name: string = p.toolCall.name;
  const args = obj(p.toolCall.args);
  const cwd = Array.isArray(p.workspacePaths) ? cwdOf(p.workspacePaths[0]) : undefined;
  const ev = { ...base("antigravity", p.stepIdx, p.conversationId, cwd), ...agyFields(name, args, cwd), tool_name: name, tool_input: JSON.stringify(args) };
  const raw = [ev.tool_input, ev.content].filter((s): s is string => typeof s === "string");
  const kinds = [...new Set(raw.flatMap(secretKinds))], fps = [...new Set(raw.flatMap(secretFingerprints))];
  return { ...ev, ...(kinds.length ? { secret_kinds: kinds } : {}), ...(fps.length ? { secret_fps: fps } : {}) } as RawEvent;
}

/** The events for one PreToolUse payload (one, or one per file of a Codex apply_patch). Throws on a payload that is not
 * that agent's tool-call object. */
export function toEvents(agent: Agent, p: unknown): RawEvent[] {
  const o = obj(p);
  if (agent === "antigravity" ? typeof o.toolCall?.name !== "string" : typeof o.tool_name !== "string") throw new Error("not a tool-call payload");
  const evs = agent === "codex" ? codex(o) : [agent === "antigravity" ? antigravity(o) : claude(o)];
  return evs.map((ev) => Object.fromEntries(Object.entries(ev).filter(([, v]) => v !== undefined)) as RawEvent); // absent, not undefined: `|exists`
}

/** Codex parses `ask` but treats it as a failed hook and runs the tool, so confirm mode would silently allow. */
export const supportsAsk = (agent: Agent) => agent !== "codex";

export function render(agent: Agent, decision: "deny" | "ask", reason: string): string {
  const out = agent === "antigravity" ? { decision, reason }
    : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason } };
  return JSON.stringify(out) + "\n";
}

// Per-agent PreToolUse protocol for `hook run --agent` (ADR 0009): payload -> the RawEvent the rules see, built with
// the collectors' own mapping, and a decision in that agent's output format. Never `allow`, never input rewrites.
// Codex: learn.chatgpt.com/docs/hooks. Antigravity: antigravity.google/docs/hooks.
import { mapToolUse, type ToolFields } from "../collectors/claude-code/v1.ts";
import { mapCall } from "../collectors/antigravity/v1.ts";
import { cwdOf, shellFields } from "../collectors/codex/map.ts";
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

function codex(p: Line): RawEvent {
  const cwd = cwdOf(p.cwd);
  const c = obj(p.tool_input).command;
  // Bash: the same command_line extraction as the rollout collector's shell calls (codex/v1.ts)
  const f = p.tool_name === "Bash" ? shellFields(Array.isArray(c) ? c.map(String) : typeof c === "string" ? [c] : [], cwd) : mapToolUse(p.tool_name, p.tool_input, cwd);
  return { ...base("codex", p.tool_use_id, p.session_id, cwd), permission_mode: str(p.permission_mode), ...f } as RawEvent;
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

/** The event for one PreToolUse payload. Throws on a payload that is not that agent's tool-call object. */
export function toEvent(agent: Agent, p: unknown): RawEvent {
  const o = obj(p);
  if (agent === "antigravity" ? typeof o.toolCall?.name !== "string" : typeof o.tool_name !== "string") throw new Error("not a tool-call payload");
  const ev = agent === "codex" ? codex(o) : agent === "antigravity" ? antigravity(o) : claude(o);
  return Object.fromEntries(Object.entries(ev).filter(([, v]) => v !== undefined)) as RawEvent; // absent, not undefined: `|exists`
}

/** Codex parses `ask` but treats it as a failed hook and runs the tool, so confirm mode would silently allow. */
export const supportsAsk = (agent: Agent) => agent !== "codex";

export function render(agent: Agent, decision: "deny" | "ask", reason: string): string {
  const out = agent === "antigravity" ? { decision, reason }
    : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason } };
  return JSON.stringify(out) + "\n";
}

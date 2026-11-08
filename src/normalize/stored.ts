// The one place a RawEvent becomes storable (ADR 0006, 0007). RawEvent is assignable to AgentEvent, so tsc will not
// catch a leak: fields are picked from an allow-list, never spread, and every string is masked.
import { mask } from "./mask.ts";
import type { AgentEvent, RawEvent } from "./types.ts";

const EXCERPT_MAX = 500;

export const OPTIONAL_STRINGS = [
  "agent_version",
  "parent_session_id",
  "agent_id",
  "parent_tool_use_id",
  "project_path",
  "tool_name",
  "command_line",
  "target_path",
  "url",
  "domain",
  "mcp_server",
  "mcp_tool",
  "outcome",
  "permission_mode",
  "prompt_source",
  "entrypoint",
  "attribution",
  "denial_kind",
  "denial_category",
  "text_excerpt",
] as const satisfies readonly (keyof AgentEvent)[];

export const LIST_FIELDS = ["secret_kinds", "result_secret_kinds", "secret_fps"] as const satisfies readonly (keyof AgentEvent)[];

const same = <T extends string>(s: T) => mask(s) as T;

/** A masked copy of `e` holding allow-listed fields only. Absent stays absent, and empty lists are dropped. Idempotent. */
export function toStored(e: RawEvent): AgentEvent {
  const out: AgentEvent = {
    id: mask(e.id),
    schema_version: "0.1", // the only version there is, and a constant cannot carry anything
    agent: same(e.agent),
    session_id: mask(e.session_id),
    ts: mask(e.ts),
    seq: e.seq,
    category: same(e.category),
    raw_ref: { file: mask(e.raw_ref.file), line: e.raw_ref.line },
  };
  const fields = out as Record<string, unknown>;
  for (const key of OPTIONAL_STRINGS) {
    const value = e[key];
    if (value != null) fields[key] = mask(value);
  }
  for (const key of LIST_FIELDS) {
    const value = e[key];
    if (value?.length) fields[key] = value.map(mask);
  }
  // Masks first: a cut through a secret could leave a tail too short for any pattern to match.
  if (out.text_excerpt !== undefined) out.text_excerpt = out.text_excerpt.slice(0, EXCERPT_MAX);
  return out;
}

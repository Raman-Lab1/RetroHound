// Maps one Codex `item_completed` item (or a legacy shell call) to event fields. Pure: no file access.
import { secretKinds } from "../../normalize/mask.ts";
import { normalizeSlashes } from "../../normalize/paths.ts";
import type { RawEvent } from "../../normalize/types.ts";
import { mapToolUse } from "../claude-code/v1.ts";

type Line = Record<string, any>;
export type Fields = Partial<RawEvent>;

const CMD_FLAG = /^(?:-[a-z]{0,3}c|-command|\/c)$/i; // pwsh -Command, sh -c / -lc, cmd /c
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

/** `file:///C:/x` (what CommandExecution.cwd holds) -> `C:/x`; anything else is a plain path. */
export function cwdOf(v: unknown): string | undefined {
  const s = str(v);
  if (!s) return undefined;
  if (!/^file:\/\//i.test(s)) return normalizeSlashes(s);
  try {
    const p = decodeURIComponent(new URL(s).pathname);
    return normalizeSlashes(/^\/[A-Za-z]:/.test(p) ? p.slice(1) : p);
  } catch {
    return undefined;
  }
}

/** The text of a content list (`[{type:"text", text}]`) or a string. */
export function textOf(content: unknown): string | undefined {
  if (typeof content === "string") return str(content);
  if (!Array.isArray(content)) return undefined;
  return str(content.flatMap((b: Line) => (typeof b?.text === "string" ? [b.text] : [])).join("\n"));
}

/** `[shell, -Command|-c|-lc, script]` -> the script; any other argv is joined. */
export function shellFields(argv: string[], cwd?: string): Fields {
  const at = argv.findIndex((a, i) => i > 0 && CMD_FLAG.test(a));
  const script = at > 0 && argv[at + 1] !== undefined ? argv.slice(at + 1).join(" ") : argv.join(" ");
  const shell = (argv[0] ?? "").split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, "");
  const tool = /^(?:pwsh|powershell)$/.test(shell) ? "PowerShell" : shell === "cmd" ? "cmd" : "Bash";
  const ev = mapToolUse(tool, { command: script }, cwd);
  if (tool === "cmd") ev.category = "process_creation"; // mapToolUse only knows Bash-like names
  return ev;
}

const argvOf = (c: unknown): string[] =>
  Array.isArray(c) ? c.filter((a): a is string => typeof a === "string") : typeof c === "string" ? [c] : [];

function commandFields(item: Line): Fields {
  const ev = shellFields(argvOf(item.command), cwdOf(item.cwd));
  const ok = item.status === "completed" && item.exit_code === 0;
  ev.outcome = ok ? "success" : item.status === "failed" || (typeof item.exit_code === "number" && item.exit_code !== 0) ? "error" : "unknown";
  withOutput(ev, str(item.aggregated_output));
  const cwd = cwdOf(item.cwd);
  return cwd ? { ...ev, project_path: cwd } : ev;
}

function withOutput(ev: Fields, out: string | undefined) {
  if (!out) return;
  ev.tool_response = out;
  const kinds = secretKinds(out);
  if (kinds.length) ev.result_secret_kinds = kinds;
}

/** An MCP call, named as Claude Code and Codex hooks name it (`mcp__<server>__<tool>`), with the exact server and tool:
 * the name split in mapToolUse guesses when a tool name holds `__`. */
function mcpFields(item: Line): Fields | undefined {
  const server = str(item.server), tool = str(item.tool);
  if (!server || !tool) return undefined;
  const ev: Fields = { ...mapToolUse(`mcp__${server}__${tool}`, item.arguments ?? {}), mcp_server: server, mcp_tool: tool };
  const failed = item.status === "failed" || item.result?.isError === true || item.error != null;
  ev.outcome = failed ? "error" : item.status === "completed" ? "success" : "unknown";
  withOutput(ev, textOf(item.result?.content));
  return ev;
}

function webFields(item: Line): Fields {
  const url = str(item.action?.url);
  const ev: Fields = url ? mapToolUse("WebFetch", { url }) : mapToolUse("WebSearch", { query: str(item.query) ?? "" });
  const hits = Array.isArray(item.results) ? item.results.map((r: Line) => [r?.title, r?.snippet].filter(str).join(" ")) : [];
  return { ...ev, outcome: "success", ...(hits.length ? { tool_response: hits.join("\n") } : {}) };
}

/** Fields for one item, or undefined when the item is not an event (reasoning, a finished sub-agent, unknown kinds). */
export function mapItem(item: Line, fromSubagent: boolean): Fields | undefined {
  switch (item.type) {
    case "CommandExecution":
      return commandFields(item);
    case "McpToolCall":
      return mcpFields(item);
    case "Extension":
      return item.kind === "web.search" ? webFields(item) : undefined;
    case "UserMessage": {
      const text = textOf(item.content);
      return text ? { category: "user_prompt", text, prompt_source: fromSubagent ? "system" : "typed" } : undefined;
    }
    case "AgentMessage": {
      const text = textOf(item.content);
      return text ? { category: "assistant_message", text } : undefined;
    }
    case "SubAgentActivity":
      if (item.kind !== "started") return undefined;
      return { ...mapToolUse("Agent", { agent_thread_id: item.agent_thread_id, agent_path: item.agent_path, model: item.model }), outcome: "success" };
    default:
      return undefined;
  }
}

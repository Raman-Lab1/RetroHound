// Minimal MCP server core: JSON-RPC 2.0 over newline-delimited stdio. `handleLine` is pure (line in, line out), so
// tests drive it without a process. Spec: https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle
// and .../server/tools (the 2026-07-28 revision is stateless; its clients fall back to `initialize`, handled here).
import { TOOL_VERSION } from "../version.ts";
import { TOOLS, ToolError, UNTRUSTED, callTool, type Ctx } from "./tools.ts";

export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;
const INFO = { name: "retrohound", version: TOOL_VERSION };

type Id = string | number | null;
const E = { parse: -32700, request: -32600, method: -32601, params: -32602 } as const;

const ok = (id: Id, result: unknown) => JSON.stringify({ jsonrpc: "2.0", id, result });
const fail = (id: Id, code: number, message: string) => JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function callResult(params: Record<string, unknown>, ctx: Ctx, id: Id): string {
  const tool = TOOLS.find((t) => t.name === params.name);
  if (!tool) return fail(id, E.params, `Unknown tool: ${String(params.name)}`);
  const args = params.arguments ?? {};
  if (!isObj(args)) return fail(id, E.params, "arguments must be an object");
  try {
    return ok(id, { content: [{ type: "text", text: JSON.stringify(callTool(tool, args, ctx), null, 2) }], isError: false });
  } catch (e) {
    const msg = e instanceof ToolError ? e.message : "internal error";
    return ok(id, { content: [{ type: "text", text: msg }], isError: true });
  }
}

/** One input line to one output line; undefined for notifications (nothing is sent back). */
export function handleLine(line: string, ctx: Ctx): string | undefined {
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    return fail(null, E.parse, "Parse error");
  }
  if (!isObj(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return isObj(msg) && "id" in msg ? undefined : fail(null, E.request, "Invalid Request"); // a stray response is ignored
  }
  if (!("id" in msg)) return undefined; // notifications (initialized, cancelled, ...): unknown ones are ignored too
  const id = msg.id as Id;
  const params = isObj(msg.params) ? msg.params : {};
  switch (msg.method) {
    case "initialize": {
      const asked = params.protocolVersion;
      const version = (PROTOCOL_VERSIONS as readonly unknown[]).includes(asked) ? asked : PROTOCOL_VERSIONS[0];
      return ok(id, { protocolVersion: version, capabilities: { tools: {} }, serverInfo: INFO, instructions: UNTRUSTED });
    }
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case "tools/call":
      return typeof params.name === "string" ? callResult(params, ctx, id) : fail(id, E.params, "params.name is required");
    default:
      return fail(id, E.method, `Method not found: ${msg.method}`);
  }
}

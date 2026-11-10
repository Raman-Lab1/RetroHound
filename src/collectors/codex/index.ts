// The Codex collector. Registered in src/collectors/index.ts as COLLECTORS.codex.
import { homedir } from "node:os";
import { join } from "node:path";
import type { Collector } from "../index.ts";
import { discover } from "./discover.ts";
import { groupKey, parseFile } from "./v1.ts";

export const codex: Collector = {
  agent: "codex",
  parserVersion: "codex/v4", // v4: MCP tool calls
  defaultRoot: () => process.env.CODEX_HOME || join(homedir(), ".codex"),
  discover,
  parseFile,
  groupKey: (p) => groupKey(p),
};

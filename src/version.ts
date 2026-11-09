// Constants the hook path needs without loading scan.ts (collectors, store).
import { fileURLToPath } from "node:url";

export const TOOL_VERSION = "0.2.0";
// src/version.ts and the bundle dist/cli.mjs both sit one level below the repo/package root.
export const DEFAULT_RULES_DIR = fileURLToPath(new URL("../rules/ai_coding_agent", import.meta.url));

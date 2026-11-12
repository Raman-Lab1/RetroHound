import { homedir } from "node:os";
import { join } from "node:path";
import type { Collector } from "../index.ts";
import { discover, groupKey } from "./discover.ts";
import { parseFile } from "./v1.ts";

export const antigravity: Collector = {
  agent: "antigravity",
  parserVersion: "antigravity/v4", // v4: a bad line no longer drops the file
  defaultRoot: () => join(homedir(), ".gemini", "antigravity-cli"),
  discover,
  parseFile,
  groupKey,
};

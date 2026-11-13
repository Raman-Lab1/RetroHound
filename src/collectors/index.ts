// One entry per supported agent. scan picks one with --agent; each collector owns its layout on disk (discover), its
// parser (parseFile, versioned: a bump re-parses every file, ADR 0005) and which files form one session (groupKey).
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, ParsedFile } from "../normalize/types.ts";
import { antigravity } from "./antigravity/index.ts";
import { discover as claudeDiscover } from "./claude-code/discover.ts";
import { codex } from "./codex/index.ts";
import { parseFile as claudeParse } from "./claude-code/v1.ts";

export type Collector = {
  agent: AgentEvent["agent"];
  parserVersion: string;
  defaultRoot: () => string;
  discover: (root: string) => string[]; // sorted, forward slashes; a missing root gives []
  parseFile: (path: string) => Promise<ParsedFile & { sha256?: string }>; // never throws for bad content
  groupKey: (path: string) => string; // files with the same key are one session and are evaluated together (ADR 0004)
};

const claudeCode: Collector = {
  agent: "claude_code",
  parserVersion: "claude-code/v3", // v2: heredoc bodies move only when a data reader stores them; v3: a bad line no longer ends the file, Grep is a file read
  defaultRoot: () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
  discover: claudeDiscover,
  parseFile: claudeParse,
  // <project>/<session>/subagents/x.jsonl and <project>/<session>.jsonl[.copy] are one session
  groupKey: (p) => /^(.*)\/subagents\/[^/]+$/.exec(p)?.[1] ?? p.replace(/\.(?:jsonl|orphaned-)[^/]*$/, ""),
};

export const COLLECTORS: Record<string, Collector> = { claude_code: claudeCode, codex, antigravity };

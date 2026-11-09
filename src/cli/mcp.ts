// `retrohound mcp`: stdio MCP server over the index (read-only). stdout carries protocol messages only; diagnostics go
// to stderr. Resolves when stdin ends.
import { createInterface } from "node:readline";
import { handleLine } from "../mcp/server.ts";
import { DEFAULT_RULES_DIR } from "../scan.ts";
import { defaultDbPath } from "../store/index.ts";
import type { Registrar } from "./io.ts";
import { EXTRA_HELP, loadRuleDir, repeat } from "./rules.ts";

export async function serveStdio(input: NodeJS.ReadableStream, dbPath: string, rulesDir: string, write: (s: string) => void, extraRules: string[] = []): Promise<number> {
  if (extraRules.length) loadRuleDir(rulesDir, extraRules); // a bad --extra-rules is a usage error at startup, not on every tool call
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    const reply = handleLine(line, { dbPath, rulesDir, extraRules });
    if (reply !== undefined) write(reply + "\n");
  }
  return 0;
}

export const registerMcp: Registrar = (program, run, io) => {
  program.command("mcp").description("Serve the index to MCP clients over stdio (read-only tools)")
    .option("--db <path>", "index database", defaultDbPath())
    .option("--rules <dir>", "rules directory", DEFAULT_RULES_DIR)
    .option("--extra-rules <dir>", EXTRA_HELP, repeat)
    .action((f: { db: string; rules: string; extraRules?: string[] }) => run(() => serveStdio(process.stdin, f.db, f.rules, io.out, f.extraRules)));
};

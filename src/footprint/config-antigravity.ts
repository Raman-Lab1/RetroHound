// What Antigravity CLI is configured to reach (docs/formats/antigravity.md, "Configuration surface"): MCP servers
// (mcp_config.json), hooks (hooks.json, named groups), skills and plugins. Same bounds and masking as config-codex.ts.
import { statSync } from "node:fs";
import { join } from "node:path";
import { settingsPath } from "../hooks/install.ts";
import { collector } from "./config-codex.ts";
import type { ConfigReader } from "./types.ts";

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export const readAntigravityConfig: ConfigReader = ({ home, projects }) => {
  const c = collector("antigravity");
  const gemini = join(home, ".gemini");
  const json = (root: string, file: string, scope: string): Json | undefined => {
    const text = c.read(root, file, scope);
    if (!text?.trim()) return undefined; // absent, or empty as Antigravity first writes mcp_config.json
    try {
      return obj(JSON.parse(text));
    } catch {
      return void c.skip(file, "not JSON");
    }
  };
  // `mcpServers.<name>`: `command` is stdio, `serverUrl`/`url` Streamable HTTP. Only key names are looked at; the
  // values go into the hash only.
  const mcp = (root: string, file: string, scope: string) => {
    for (const [name, s] of Object.entries(obj(json(root, file, scope)?.mcpServers))) {
      const v = obj(s);
      if (v.disabled === true) continue;
      const detail = "command" in v ? "stdio" : "serverUrl" in v || "url" in v ? "http" : undefined;
      c.add({ kind: "mcp_server", name, scope, source: file, ...(detail ? { detail } : {}) }, v);
    }
  };
  // Top-level keys are named groups (`enabled: false` turns one off). PreToolUse/PostToolUse hold {matcher, hooks: [...]},
  // the other events hold handlers directly; a handler is {type?, command, timeout?}.
  const hooks = (root: string, file: string, scope: string) => {
    for (const group of Object.values(json(root, file, scope) ?? {})) {
      if (obj(group).enabled === false) continue;
      for (const [event, entries] of Object.entries(obj(group))) {
        for (const e of list(entries)) {
          for (const h of [e, ...list(obj(e).hooks)]) {
            const cmd = obj(h).command;
            if (typeof cmd === "string") c.add({ kind: "hook", name: cmd, scope, source: file, detail: `hook:${event}` });
          }
        }
      }
    }
  };

  mcp(gemini, join(gemini, "config", "mcp_config.json"), "user");
  hooks(gemini, join(gemini, "config", "hooks.json"), "user");
  for (const d of [["config", "skills"], ["skills"], ["antigravity-cli", "skills"]]) c.skills(join(gemini, ...d), "user");
  const plugins = join(gemini, "config", "plugins");
  for (const f of c.folders(plugins)) {
    try {
      if (!statSync(join(plugins, f)).isDirectory()) continue;
    } catch {
      continue;
    }
    c.add({ kind: "plugin", name: f, scope: "user", source: join(plugins, f) });
    c.skills(join(plugins, f, "skills"), "plugin", plugins);
    mcp(plugins, join(plugins, f, "mcp_config.json"), "plugin");
  }
  for (const p of c.projects(home, projects)) {
    mcp(p, join(p, ".agents", "mcp_config.json"), "project");
    hooks(p, settingsPath("project", p, {}, "antigravity"), "project");
    for (const d of [".agents", ".agent"]) c.skills(join(p, d, "skills"), "project"); // .agent: the older name, still read
  }
  return c.out;
};

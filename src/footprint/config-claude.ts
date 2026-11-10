// Claude Code's configuration surface for the footprint report (docs/formats/claude-code.md, "Configuration surface"):
// the MCP servers, hooks, skills and plugins set up on this machine, named in the index's own form so they join with
// what transcripts show. Files are read as text from fixed locations only: nothing is executed, imported, fetched or
// written, no symlink is followed out of the directory being read, and env, headers, args, url and OAuth/token values
// are never read out. Every string returned is masked.
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fwd, hookCommands, inside, MAX_FILE_BYTES, MAX_FILES } from "../collectors/repo/collect.ts";
import { settingsPath } from "../hooks/install.ts";
import { mask } from "../normalize/mask.ts";
import { type ConfigItem, type ConfigRead, type ConfigReader, MAX_CONFIG_ITEMS } from "./types.ts";

// ponytail: the index can hold thousands of project paths; the first 200 are read, which bounds a report's disk reads.
export const MAX_PROJECTS = 200;

/** managed-settings.json, managed-settings.d/, managed-mcp.json and .claude/skills an organization deploys. */
export const MANAGED_DIR =
  process.platform === "darwin" ? "/Library/Application Support/ClaudeCode"
  : process.platform === "win32" ? "C:\\Program Files\\ClaudeCode"
  : "/etc/claude-code";

type Json = Record<string, unknown>;
const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
/** Tool names are `mcp__<server>__<tool>` with every character outside A-Z a-z 0-9 _ - turned into `_`. */
const toolName = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");

// RETROHOUND_MANAGED_DIR: a test seam, so tests never read the machine's managed config.
export const readClaudeConfig: ConfigReader = (o) => readClaude(o, o.env?.RETROHOUND_MANAGED_DIR || MANAGED_DIR);

/** readClaudeConfig with the managed directory as a parameter, so tests can point it at a temp dir. */
export function readClaude({ home, projects, env = process.env }: Parameters<ConfigReader>[0], managed: string): ConfigRead {
  const out: ConfigRead = { items: [], files: 0, skipped: [] };
  const skip = (path: string, reason: string) => void out.skipped.push({ path: mask(path), reason });
  let full = false;
  const add = (kind: ConfigItem["kind"], name: string, scope: string, source: string, detail?: string) => {
    if (out.items.length >= MAX_CONFIG_ITEMS) {
      if (!full) skip(source, `more than ${MAX_CONFIG_ITEMS} configured items, the rest left out`);
      full = true;
      return;
    }
    out.items.push({ agent: "claude_code", kind, name: mask(name), scope, source: mask(source), ...(detail ? { detail: mask(detail) } : {}) });
  };

  /** The text of a regular file that resolves inside `root` and fits MAX_FILE_BYTES; a missing file is normal. */
  const read = (file: string, root: string): string | undefined => {
    let real: string, size: number;
    try {
      real = fwd(realpathSync(file));
      const st = statSync(real);
      if (!st.isFile()) return undefined;
      size = st.size;
      if (!inside(fwd(realpathSync(root)), real)) return skip(file, "resolves outside the directory");
    } catch {
      return undefined;
    }
    if (size > MAX_FILE_BYTES) return skip(file, `larger than ${MAX_FILE_BYTES} bytes`);
    try {
      const text = readFileSync(real, "utf8");
      out.files++;
      return text;
    } catch {
      return skip(file, "unreadable");
    }
  };
  const json = (file: string, root: string): [Json, string] | undefined => {
    const text = read(file, root);
    if (text === undefined) return undefined;
    try {
      const j: unknown = JSON.parse(text);
      if (j && typeof j === "object" && !Array.isArray(j)) return [j as Json, text];
    } catch {
      // reported below
    }
    skip(file, "not a JSON object");
  };
  const list = (dir: string) => {
    try {
      const all = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)); // not locale-dependent
      if (all.length > MAX_FILES) skip(dir, `more than ${MAX_FILES} entries, only the first ${MAX_FILES} read`);
      return all.slice(0, MAX_FILES);
    } catch {
      return [];
    }
  };

  // Server names only, plus the transport: env, headers, args and url stay unread.
  const servers = (map: unknown, scope: string, source: string, prefix = "") => {
    for (const [name, s] of Object.entries(obj(map))) {
      const type = obj(s).type;
      add("mcp_server", toolName(prefix + name), scope, source, typeof type === "string" ? type : undefined);
    }
  };
  const hooks = (text: string, scope: string, source: string) => {
    for (const [event, command] of hookCommands(text)) add("hook", command, scope, source, `hook:${event}`);
  };
  const enabled = new Set<string>(); // `name@marketplace` ids some settings file turns on
  const settings = (file: string, root: string, scope: string) => {
    const r = json(file, root);
    if (!r) return;
    hooks(r[1], scope, file);
    for (const [id, on] of Object.entries(obj(r[0].enabledPlugins))) {
      if (on !== true) continue;
      enabled.add(id);
      add("plugin", id.replace(/@.*/, ""), scope, file);
    }
    if (scope === "managed") servers(r[0].managedMcpServers, scope, file);
  };
  /** `<dir>/<name>/SKILL.md`: the frontmatter `name` when it is a valid skill name, else the directory name. */
  const skills = (dir: string, root: string, scope: string, prefix = "") => {
    for (const e of list(dir)) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      const file = join(dir, e.name, "SKILL.md");
      const text = read(file, root);
      if (text === undefined) continue;
      const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
      add("skill", prefix + (/^name:[ \t]*["']?([a-z0-9-]+)["']?[ \t]*\r?$/m.exec(front)?.[1] ?? e.name), scope, file);
    }
  };
  /** One installed plugin: hooks/hooks.json, .mcp.json and skills/, plus the hooks and MCP servers plugin.json adds. */
  const plugin = (root: string, base: string, id: string) => {
    try {
      if (!inside(fwd(realpathSync(base)), fwd(realpathSync(root)))) return skip(root, "plugin outside the plugins directory");
    } catch {
      return; // removed since it was recorded
    }
    const manifest = join(root, ".claude-plugin", "plugin.json");
    const m = json(manifest, root)?.[0] ?? {};
    const name = typeof m.name === "string" ? m.name : id; // components are namespaced under the manifest name
    const hookFile = (f: string) => {
      const r = json(f, root);
      if (r) hooks(r[1], "plugin", f);
    };
    const mcpFile = (f: string) => {
      const r = json(f, root);
      if (r) servers(r[0].mcpServers ?? r[0], "plugin", f, `plugin_${name}_`);
    };
    hookFile(join(root, "hooks", "hooks.json"));
    mcpFile(join(root, ".mcp.json"));
    // plugin.json `hooks` / `mcpServers`: a ./file.json, an inline object, or an array of either (.mcpb bundles unread).
    // deduplicated and capped: a plugin.json can repeat one file thousands of times
    for (const h of [...new Set([m.hooks].flat())].slice(0, MAX_FILES)) {
      if (typeof h !== "string") hooks(JSON.stringify({ hooks: h }), "plugin", manifest);
      else if (h.endsWith(".json")) hookFile(join(root, h));
    }
    for (const s of [...new Set([m.mcpServers].flat())].slice(0, MAX_FILES)) {
      if (typeof s !== "string") servers(s, "plugin", manifest, `plugin_${name}_`);
      else if (s.endsWith(".json")) mcpFile(join(root, s));
    }
    skills(join(root, "skills"), root, "plugin", `${name}:`);
  };

  const cfg = env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  // ~/.claude.json (inside CLAUDE_CONFIG_DIR when set): user servers at the top, local-scope ones per project path.
  const state = env.CLAUDE_CONFIG_DIR ? join(cfg, ".claude.json") : join(home, ".claude.json");
  const global = json(state, dirname(state))?.[0];
  servers(global?.mcpServers, "user", state);
  settings(settingsPath("user", home, { CLAUDE_CONFIG_DIR: cfg }), cfg, "user");
  skills(join(cfg, "skills"), cfg, "user");

  settings(join(managed, "managed-settings.json"), managed, "managed");
  for (const e of list(join(managed, "managed-settings.d"))) {
    if (e.name.endsWith(".json") && !e.name.startsWith(".")) settings(join(managed, "managed-settings.d", e.name), managed, "managed");
  }
  const fixed = join(managed, "managed-mcp.json");
  servers(json(fixed, managed)?.[0].mcpServers, "managed", fixed);
  skills(join(managed, ".claude", "skills"), managed, "managed");

  // home is the user scope, read above; a project path that is gone since it was indexed has nothing to read
  const live = [...new Set(projects)].filter((p) => isAbsolute(p) && p !== home && isDir(p));
  if (live.length > MAX_PROJECTS) skip("projects", `more than ${MAX_PROJECTS} project paths, only the first ${MAX_PROJECTS} read`);
  for (const p of live.slice(0, MAX_PROJECTS)) {
    servers(obj(obj(global?.projects)[p]).mcpServers, "local", state);
    const mcp = join(p, ".mcp.json");
    servers(json(mcp, p)?.[0].mcpServers, "project", mcp);
    settings(settingsPath("project", p), p, "project");
    settings(settingsPath("local", p), p, "local");
    skills(join(p, ".claude", "skills"), p, "project");
  }

  // Last, once every settings file has said which plugins are on. Several installs of one plugin (per scope or
  // project) can hold different versions: the most recently updated one is read.
  const base = join(cfg, "plugins");
  for (const [id, installs] of Object.entries(obj(json(join(base, "installed_plugins.json"), cfg)?.[0].plugins))) {
    if (!enabled.has(id) || !Array.isArray(installs)) continue;
    const latest = installs.map(obj).sort((a, b) => String(b.lastUpdated ?? "").localeCompare(String(a.lastUpdated ?? "")))[0];
    if (typeof latest?.installPath === "string") plugin(latest.installPath, base, id.replace(/@.*/, ""));
  }
  return out;
}

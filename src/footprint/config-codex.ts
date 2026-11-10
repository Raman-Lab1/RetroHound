// What Codex CLI is configured to reach (docs/formats/codex.md, "Configuration surface"): MCP servers and inline hooks
// in config.toml, hooks.json, plugins, skills. Fixed locations only, read as text: nothing is executed, imported or
// written, and env, headers, args, URLs and tokens are never read out (only their key names decide the transport).
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { hookCommands, MAX_FILE_BYTES } from "../collectors/repo/collect.ts";
import { settingsPath } from "../hooks/install.ts";
import { mask } from "../normalize/mask.ts";
import { type ConfigItem, type ConfigRead, type ConfigReader, MAX_CONFIG_ITEMS } from "./types.ts";

export const MAX_PROJECTS = 200; // project paths read per agent: each costs a few stat calls; the index can hold thousands
const MAX_ENTRIES = 500; // skill or plugin folders read per directory

/** The result being built, with every string masked on the way in. */
export function collector(agent: string) {
  const out: ConfigRead = { items: [], files: 0, skipped: [] };
  const skip = (path: string, reason: string) => void out.skipped.push({ path: mask(path), reason });
  let full = false;
  const add = (i: Omit<ConfigItem, "agent">) => {
    if (out.items.length >= MAX_CONFIG_ITEMS) {
      if (!full) skip(i.source, `more than ${MAX_CONFIG_ITEMS} configured items, the rest left out`);
      full = true;
      return;
    }
    out.items.push({ agent, kind: i.kind, name: mask(i.name), scope: i.scope, source: mask(i.source), ...(i.detail ? { detail: mask(i.detail) } : {}) });
  };
  /** Text of `path` if it is a file inside `root` once symlinks are resolved and not oversized; absent -> undefined. */
  const read = (root: string, path: string): string | undefined => {
    let real: string, base: string;
    try {
      [real, base] = [realpathSync(path), realpathSync(root)];
    } catch {
      return undefined; // absent: the normal case
    }
    if (real !== base && !real.startsWith(base + sep)) return skip(path, "symlink outside the directory");
    try {
      const st = statSync(real);
      if (!st.isFile()) return undefined;
      if (st.size > MAX_FILE_BYTES) return skip(path, `larger than ${MAX_FILE_BYTES} bytes`);
      const text = readFileSync(real, "utf8");
      out.files++;
      return text;
    } catch {
      return skip(path, "unreadable");
    }
  };
  /** Entry names of `dir`, sorted and capped; none when it is absent. */
  const folders = (dir: string): string[] => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return [];
    }
    if (names.length > MAX_ENTRIES) skip(dir, `more than ${MAX_ENTRIES} entries, only the first ${MAX_ENTRIES} read`);
    return names.slice(0, MAX_ENTRIES);
  };
  /** `<dir>/<folder>/SKILL.md`, one level. Name: the frontmatter `name`, else the folder (Codex and Antigravity docs). */
  const skills = (dir: string, scope: string, root = dir) => {
    for (const f of folders(dir)) {
      const text = read(root, join(dir, f, "SKILL.md"));
      if (text === undefined) continue;
      const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
      const name = /^name:[ \t]*["']?([^"'\r\n]+?)["']?[ \t]*$/m.exec(front)?.[1] ?? f;
      add({ kind: "skill", name, scope, source: join(dir, f, "SKILL.md") });
    }
  };
  /** Index project paths still on disk, deduplicated, home excluded (its files are the user scope), capped. */
  const projects = (home: string, paths: string[]) => {
    const list: string[] = [];
    for (const p of new Set(paths)) {
      try {
        if (p === home || !statSync(p).isDirectory()) continue;
      } catch {
        continue; // gone since it was indexed
      }
      if (list.length === MAX_PROJECTS) {
        skip("projects", `more than ${MAX_PROJECTS} project paths, only the first ${MAX_PROJECTS} read`);
        break;
      }
      list.push(p);
    }
    return list;
  };
  return { out, add, skip, read, folders, skills, projects };
}

/** A dotted TOML key as its parts: `plugins."a@b"` -> [plugins, a@b]. */
const keyParts = (s: string) => [...s.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|([\w-]+)/g)].map((m) => m[1] ?? m[2] ?? m[3]!);

/** A single-line TOML string: literal '...' as is, basic "..." unescaped as JSON; anything else undefined. */
function tomlString(v: string): string | undefined {
  if (v.startsWith('"""') || v.startsWith("'''")) return undefined;
  const m = /^"((?:[^"\\]|\\.)*)"|^'([^']*)'/.exec(v);
  try {
    return m ? (m[2] ?? (JSON.parse(`"${m[1]}"`) as string)) : undefined;
  } catch {
    return undefined; // a TOML-only escape such as \U0001F600
  }
}

// ponytail: a line scan, not a TOML parser. It sees table headers ([mcp_servers.<name>], [plugins."<id>"],
// [[hooks.<Event>.hooks]]), key NAMES inside them, `enabled = false`, and single-line hook `command` strings. Not seen:
// inline tables (`mcp_servers = { ... }`), dotted keys outside a header, multi-line hook commands (reported as skipped).
// Upgrade: a real TOML parser if configs in those forms turn up.
function scanToml(text: string, source: string, scope: string, c: ReturnType<typeof collector>): void {
  let table: string[] = [];
  let item: Omit<ConfigItem, "agent"> | undefined; // the server or plugin of the current table, added at its end
  let enabled = true;
  let multi = false; // inside a multi-line string: no header or key there is real
  const flush = () => void (item && enabled && c.add(item));
  for (const line of text.split(/\r?\n/)) {
    const wasMulti = multi;
    if ((line.match(/"""|'''/g)?.length ?? 0) % 2) multi = !multi;
    if (wasMulti) continue;
    const header = /^\s*\[\[?([^\]]+)\]\]?\s*(?:#.*)?$/.exec(line);
    if (header) {
      flush();
      table = keyParts(header[1]!);
      enabled = true;
      const [root, name] = table;
      item = table.length !== 2 ? undefined
        : root === "mcp_servers" ? { kind: "mcp_server", name: name!, scope, source }
        : root === "plugins" ? { kind: "plugin", name: name!.split("@")[0]!, scope, source } // index form: no @marketplace
        : undefined;
      continue;
    }
    const kv = /^\s*([\w-]+)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, value = ""] = kv;
    if (item && key === "enabled") enabled = !value.startsWith("false");
    else if (item?.kind === "mcp_server" && (key === "command" || key === "url")) item.detail = key === "command" ? "stdio" : "http";
    else if (table[0] === "hooks" && table[2] === "hooks" && table.length === 3 && key === "command") {
      const cmd = tomlString(value);
      if (cmd === undefined) c.skip(source, `hook command for ${table[1]} not a single-line string`);
      else c.add({ kind: "hook", name: cmd, scope, source, detail: `hook:${table[1]}` });
    }
  }
  flush();
}

export const readCodexConfig: ConfigReader = ({ home, projects, env = {} }) => {
  const c = collector("codex");
  const codexHome = env.CODEX_HOME || join(home, ".codex");
  const config = (root: string, file: string, scope: string) => {
    const text = c.read(root, file);
    if (text !== undefined) scanToml(text, file, scope, c);
  };
  const hooks = (root: string, file: string, scope: string) => {
    const text = c.read(root, file);
    if (text === undefined) return;
    try {
      JSON.parse(text);
    } catch {
      return c.skip(file, "not JSON");
    }
    for (const [event, cmd] of hookCommands(text)) c.add({ kind: "hook", name: cmd, scope, source: file, detail: `hook:${event}` });
  };
  config(codexHome, join(codexHome, "config.toml"), "user");
  hooks(codexHome, join(codexHome, "hooks.json"), "user");
  c.skills(join(codexHome, "skills"), "user");
  c.skills(join(home, ".agents", "skills"), "user");
  for (const p of c.projects(home, projects)) {
    config(p, join(p, ".codex", "config.toml"), "project");
    hooks(p, settingsPath("project", p, env, "codex"), "project");
    c.skills(join(p, ".agents", "skills"), "project");
  }
  return c.out;
};

// Commands a repo's config runs without the user asking (on open, on create, on commit, on `cd`), read as TEXT for
// `preflight`. Each becomes an `open:<kind>` process_creation event; files_config_runs_repo_script decides if it runs a repo script.
export const MAX_LINES = 200; // script lines read per husky / .envrc file

const LIFECYCLE = ["initializeCommand", "onCreateCommand", "updateContentCommand", "postCreateCommand", "postStartCommand", "postAttachCommand"];

/** JSONC (devcontainer.json, tasks.json): drop comments outside strings and trailing commas, then parse. Undefined if it still is not JSON. */
export function parseJsonc(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    try {
      return JSON.parse(text.replace(/("(?:\\.|[^"\\])*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (_, s) => s ?? "").replace(/,(\s*[}\]])/g, "$1"));
    } catch {
      return undefined;
    }
  }
}

const words = (v: unknown): string[] => (typeof v === "string" ? [v] : Array.isArray(v) ? [v.filter((x) => typeof x === "string").join(" ")] : []);

/** A lifecycle value is a string, an argv array, or an object of those (run in parallel). */
const lifecycle = (v: unknown): string[] =>
  v && typeof v === "object" && !Array.isArray(v) ? Object.values(v).flatMap(words) : words(v);

const lines = (text: string) =>
  text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).slice(0, MAX_LINES);

/** [kind, command] pairs for one repo file; `hook:*` commands of settings files are read by hookCommands instead. */
export function openCommands(rel: string, text: string): [string, string][] {
  if (rel === ".envrc") return lines(text).map((l) => ["envrc", l]);
  if (rel.startsWith(".husky/")) return lines(text).map((l) => ["husky", l]);
  if (rel.endsWith("devcontainer.json")) {
    const j = parseJsonc(text) as Record<string, unknown> | undefined;
    return LIFECYCLE.flatMap((k) => lifecycle(j?.[k]).map((c): [string, string] => [`devcontainer:${k}`, c]));
  }
  if (rel === ".vscode/tasks.json") {
    const tasks = (parseJsonc(text) as { tasks?: unknown } | undefined)?.tasks;
    // only tasks that start on folder open: the others run when the user picks them
    type Cmd = { command?: unknown; args?: unknown };
    const one = (t: Cmd | undefined): [string, string][] => {
      if (typeof t?.command !== "string") return [];
      const args = (Array.isArray(t.args) ? t.args : []).map((a) => (typeof a === "string" ? a : (a as { value?: unknown })?.value)).filter((a) => typeof a === "string");
      return [["task", [t.command, ...args].join(" ")]];
    };
    // platform overrides run on that OS too; `dependsOn` tasks are not followed
    return (Array.isArray(tasks) ? tasks : []).flatMap((t: Cmd & { runOptions?: { runOn?: unknown }; osx?: Cmd; linux?: Cmd; windows?: Cmd }) =>
      t?.runOptions?.runOn === "folderOpen" ? [t, t.osx, t.linux, t.windows].flatMap(one) : []);
  }
  return [];
}

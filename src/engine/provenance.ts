// `instruction_named_package` (ADR 0017): true on a command event that installs a package an instruction text loaded
// earlier in the same session names. `evaluate` runs the pre-pass over the events it is given, before it evaluates;
// nothing is stored. Instruction text is `content` (match-only, ADR 0006), so only a parsed transcript can give it:
// the index and the live hook see no content and the field stays false.
type Row = Record<string, unknown>;

export const PROVENANCE_FIELD = "instruction_named_package";

// ponytail: the installers of exec_package_install_new, first operand run only; the value after a value-taking flag
// (`-r file`, `--registry URL`) is skipped, other flags are assumed boolean.
const INSTALL = /\b(?:npm\s+(?:install|i|add)|pnpm\s+(?:add|install|i)|yarn\s+add|bun\s+add|pip3?\s+install|uv\s+add|cargo\s+add|go\s+get|gem\s+install)\s+([^\n;&|)`]*)/gi;
const NOUN = /`([@\w][\w.\-/]*)`\s+(?:package|library|module|dependency)\b/gi; // "the `left-pad` package"
const VALUE_FLAG = /^(?:-[rcetf]|--(?:requirement|constraint|registry|index-url|extra-index-url|prefix|target|editable))$/;
const MANIFEST = /\.(?:txt|json|lock|toml)$/;
const NAME =/^@?[\w][\w.\-/]*$/;

/** Package-like names an install command line carries: version, extras and flags dropped, lower-cased. */
export function installed(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(INSTALL)) {
    let skip = false;
    for (const raw of m[1]!.split(/\s+/)) {
      if (skip) { skip = false; continue; }
      if (raw.startsWith("-")) { skip = VALUE_FLAG.test(raw); continue; }
      const name = raw.replace(/["']/g, "").replace(/\[.*$/, "").replace(/(?<=.)(@|==|>=|<=|~=).*$/, "").toLowerCase();
      if (NAME.test(name) && !MANIFEST.test(name) && !name.startsWith("/")) out.push(name);
    }
  }
  return out;
}

const text = (v: unknown): string => (typeof v === "string" ? v : "");
const isInstruction = (ev: Row): boolean => ev.category === "instruction_load" || ev.tool_name === "Skill" || ev.tool_name === "@file";

let current = new WeakSet<object>();

export const instructionNamed = (ev: Row): boolean => current.has(ev);

/** The pre-pass over events in contract order: per session, the names instructions gave so far; a later install of one is marked. */
export function setProvenance(events?: readonly Row[]): void {
  current = new WeakSet();
  const named = new Map<string, Set<string>>();
  for (const ev of events ?? []) {
    const sid = text(ev.session_id);
    const set = named.get(sid) ?? new Set<string>();
    if (isInstruction(ev)) {
      const body = text(ev.content);
      for (const n of [...installed(body), ...[...body.matchAll(NOUN)].map((m) => m[1]!.toLowerCase())]) set.add(n);
      named.set(sid, set);
    } else if (set.size && installed(text(ev.command_line)).some((n) => set.has(n))) current.add(ev);
  }
}

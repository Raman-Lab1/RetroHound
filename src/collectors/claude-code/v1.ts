// One tolerant parser for every Claude Code transcript version seen (ADR 0005). A bad line is counted, never fatal.
// Events carry raw values because rules need them (0006); masking for storage happens later, outside this file.
import { createHash, type Hash } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { secretFingerprints, secretKinds } from "../../normalize/mask.ts";
import { collapse, normalizeSlashes } from "../../normalize/paths.ts";
import type { ParsedFile, RawEvent } from "../../normalize/types.ts";

type Line = Record<string, any>;
export type ToolFields = Partial<RawEvent> & Pick<RawEvent, "category" | "tool_name">;

const SKIPPED = new Set(
  ("system api-request api-request-blob api-request-shape last-prompt atis-latch mode ai-title queue-operation " +
    "session-owner custom-title agent-name file-history-snapshot file-history-delta tools-used pr-link cost-state " +
    "frame-link artifact-comment-monitor artifact-autoreact-ledger summary progress bridge-session continued-in").split(" "),
);
const SHELL_TOOLS = new Set(["Bash", "PowerShell", "Monitor"]); // Monitor's `command` runs in a shell too
const FILE_WRITES = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const MCP_NAME = /^mcp__(.+)__(.+)$/; // server names can contain `_`, so split on the last `__`
const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i;
const SHELL_URL = /\b(?:https?|wss?|s?ftp|ssh|git):\/\/[^\s"'`<>|;)\\]+/gi;
const LOOPBACK = /^(?:localhost|127(?:\.\d+){3}|0\.0\.0\.0|\[::1?\])$/;
const UNRESOLVABLE = /^(?:[A-Za-z]:|[$%~\\])/; // relative to something other than the cwd, or already absolute
// Run after normalizeSlashes, which leaves a leading // only on UNC paths.
const ROOT = /^(?:[A-Za-z]:\/|\/\/[^/]+\/[^/]+\/?|\/(?!\/))/;
const HOME_ANCHOR = /^(?:~|\$HOME|\$\{HOME\})(?:[\\/]|$)/;
const COPY_SUFFIX = /(?:\.jsonl\.superseded-[^\\/]*|\.orphaned-[^\\/]*\.jsonl)$/;
const AGENT_FILE = /[\\/]agent-([^\\/]+?)\.jsonl$/;
const SUBAGENT_FILE = /^(.*)[\\/]subagents[\\/][^\\/]+$/;
const READ_BYTES = 1024 * 1024;
const MAX_SPILL_BYTES = 32 * 1024 * 1024;
const MAX_HEREDOCS = 64; // beyond this a command stays whole: visible to rules, and the search stays linear

// The body may be empty, and a terminator followed by `)`, `;` or a space also ends it: ending early only leaves more
// text visible, while ending late would swallow the commands in between.
// `(?!\w)`: a tag that shrinks on backtracking would rescan an unterminated body once per character of the tag.
const HEREDOC = /(?<!<)<<-?\s*(['"]?)(\w+)(?!\w)\1([^\n]*)\n(?:([\s\S]*?)\n)??[ \t]*\2(?=[\s);&|]|$)/g;
// Commands that only store their stdin. Any other reader (a shell, python, node, ssh, sudo, a script...) may run it.
// Only the system cat/tee: `/tmp/x/cat` may be anything. `git commit -e` hands the message to an editor, which may be sh.
const DATA_READER = /^(?:\/(?:usr\/)?bin\/)?(?:cat|tee)(?=[\s<>]|$)|^(?:git\s+(?:commit|tag)|gh\s+(?:pr|issue|release))\b(?!.*\s(?:-[a-zA-Z]*e|--edit))/;
// Statements allowed before a stored heredoc. An allow-list: a function, alias, eval, PATH change, `hash`, zsh's
// `functions[cat]=` ... may each make the reader something else, and only these cannot. Anything else keeps the body.
const SAFE_BEFORE = /^(?:cd|git|gh)(?=\s|$)/;
// `X=1 tee` is still tee; `PATH=/tmp/x cat`, a preload or an editor may not be, so those are kept and fail DATA_READER.
const ASSIGNMENTS = /^\s*(?:(?!(?:\w*PATH|LD_\w*|DYLD_\w*|GIT_\w*|\w*EDITOR|VISUAL)=)\w+=\S*\s+)*/;
const PIPED_ON = /(?<!\|)\|(?!\|)|[<>]\(/; // `cat <<E | sh`, `cat <<E > >(sh)`

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

/** Copy without undefined values: event fields are absent, never undefined, because `|exists` tests presence. */
function defined<T extends object>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(o)) if (value !== undefined) out[key] = value;
  return out as T;
}

/**
 * True when only a data reader gets the heredoc and nothing runs its output: `cat > f <<E`, `git commit -F - <<E`,
 * `git commit -m "$(cat <<E`. Every command enclosing the heredoc on its line must be a data reader.
 */
function isData(before: string, after: string): boolean {
  if (PIPED_ON.test(after) || /\\\s*$/.test(after)) return false; // `cat <<E \` continues the header: `| sh` may follow
  // A `<<` in quotes or a comment is no heredoc, so the shell runs the lines below it. Counting quotes is crude, but
  // erring keeps the body in command_line, the safe side.
  if (/[#']/.test(before) || (before.replaceAll('"$(', "").replaceAll(')"', "").split('"').length - 1) % 2) return false;
  const statements = before.split(/\|\||&&|[;&|\n]/);
  const pieces = (s: string) => s.split(/\$\(|[(`]/).map((cmd) => cmd.replace(ASSIGNMENTS, ""));
  return pieces(statements.pop()!).every((cmd) => DATA_READER.test(cmd)) &&
    statements.every((s) => pieces(s).every((cmd) => (cmd = cmd.replace(/^[\s)"]+/, "")) === "" || DATA_READER.test(cmd) || SAFE_BEFORE.test(cmd)));
}

/** Heredoc bodies that are stored as data move to content; a body anything may execute stays in the command line. */
function splitHeredocs(cmd: string): [string, string | undefined] {
  if (cmd.split("<<").length > MAX_HEREDOCS) return [cmd, undefined];
  const bodies: string[] = [];
  let line = ""; // the command so far, without stored bodies: what the shell runs before this heredoc
  let last = 0;
  for (const m of cmd.matchAll(HEREDOC)) {
    const [whole, , tag, rest = "", body = ""] = m;
    line += cmd.slice(last, m.index);
    last = m.index + whole.length;
    if (isData(line, rest)) {
      if (body) bodies.push(body);
      line += `<<${tag}${rest}`;
    } else line += whole;
  }
  line += cmd.slice(last);
  return [line, bodies.length ? bodies.join("\n") : undefined];
}

function domainOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase() || undefined;
  } catch {
    return undefined; // e.g. https://${HOST}/x in a shell command
  }
}

/** The first URL that leaves the machine, else the first: a loopback URL first must not hide the host after it. */
function shellUrl(cmd: string): string | undefined {
  const urls = [...cmd.matchAll(SHELL_URL)].map((m) => m[0].replace(/[.,]+$/, ""));
  return urls.find((u) => !LOOPBACK.test(domainOf(u) ?? "")) ?? urls[0];
}

/** Resolves `.` and `..` lexically. A root absorbs extra `..`; going above `~` is unknowable, so that path stays. */
function resolveDots(p: string): string {
  const root = ROOT.exec(p)?.[0];
  const anchor = root ?? HOME_ANCHOR.exec(p)?.[0];
  if (anchor === undefined) return p; // relative, or anchored on a variable we cannot see
  const rest = p.slice(anchor.length);
  const segs = root === undefined ? collapse(rest.split(/[\\/]/), "home") : collapse(rest.split("/"), "posix");
  return segs ? anchor.replace("\\", "/") + segs.join("/") : p;
}

// Windows paths use forward slashes here, as project_path does, so rules and fieldrefs see one shape (paths.ts).
// `..` is gone so that `target_path|fieldref|startswith: project_path` cannot be walked out of (rule #24).
function resolvePath(p: string, cwd?: string): string {
  return resolveDots(normalizeSlashes(!cwd || p.startsWith("/") || UNRESOLVABLE.test(p) ? p : `${cwd}/${p}`));
}

function addSecrets(ev: Partial<RawEvent>): void {
  const raw = [ev.tool_input, ev.content].filter((s) => s !== undefined);
  const kinds = [...new Set(raw.flatMap((s) => secretKinds(s)))];
  const fps = [...new Set(raw.flatMap((s) => secretFingerprints(s)))];
  if (kinds.length) ev.secret_kinds = kinds;
  if (fps.length) ev.secret_fps = fps;
}

function fileWriteBody(i: Line): string | undefined {
  // strings only: join() stringifies nested arrays recursively, and a deep one overflows the stack
  const edits = Array.isArray(i.edits) ? i.edits.map((e: Line) => str(e?.new_string) ?? "").join("\n") : undefined;
  return str(i.content ?? i.new_string ?? i.new_source ?? edits);
}

const MAX_DEPTH = 64;
const capDepth = (v: unknown, depth: number): unknown =>
  v === null || typeof v !== "object" ? v
    : depth >= MAX_DEPTH ? "[nested too deep]"
    : Array.isArray(v) ? v.map((x) => capDepth(x, depth + 1))
    : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, capDepth(x, depth + 1)]));

/** JSON text. JSON.parse accepts input too deep to serialize; its deep parts become a marker, so the rest is kept. */
export function toJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return JSON.stringify(capDepth(v, 0));
  }
}

/** Maps one tool call to event fields, including secret detection. Shared with the v0.2 hook (0009). */
export function mapToolUse(name: string, input: unknown, cwd?: string): ToolFields {
  const i: Line = input !== null && typeof input === "object" ? input : {};
  const ev: ToolFields = { category: "tool_call", tool_name: name, tool_input: toJson(input ?? {}) };
  // Grep's glob picks the files read, and overrides ignore rules: `{path: dir, glob: ".env"}` reads dir/.env.
  const glob = name === "Grep" ? str(i.glob) : undefined;
  const named = str(i.file_path) ?? str(i.notebook_path) ?? str(i.path);
  const path = glob ? `${named ?? "."}/${glob}` : named;
  if (path) ev.target_path = resolvePath(path, cwd);
  const mcp = MCP_NAME.exec(name);

  if (SHELL_TOOLS.has(name)) {
    ev.category = "process_creation";
    if (typeof i.command === "string") {
      [ev.command_line, ev.content] = splitHeredocs(i.command);
      ev.url = shellUrl(ev.command_line) ?? (ev.content && shellUrl(ev.content)); // a stored body may still be run
    }
  } else if (name === "Read" || (name === "Grep" && path)) { // Grep returns the lines of the file it names
    ev.category = "file_access";
  } else if (FILE_WRITES.has(name)) {
    ev.category = "file_event";
    ev.content = fileWriteBody(i);
  } else if (name === "WebFetch") {
    ev.category = "web_request";
    ev.url = str(i.url);
  } else if (mcp) {
    ev.mcp_server = mcp[1];
    ev.mcp_tool = mcp[2];
    // Browser MCP servers nest navigation inside a batch: actions[].input.url.
    const batched = Array.isArray(i.actions) ? i.actions.find((a: Line) => typeof a?.input?.url === "string")?.input.url : undefined;
    const url = str(i.url) ?? batched;
    ev.category = url && URL_LIKE.test(url) ? "web_request" : "mcp";
    if (ev.category === "web_request") ev.url = url;
  }
  if (ev.url) ev.domain = domainOf(ev.url);
  addSecrets(ev);
  return defined(ev);
}

function attachmentFields(a: Line, cwd?: string): Partial<RawEvent>[] {
  if (a.type === "file" && str(a.filename)) {
    return [{ category: "file_access", tool_name: "@file", target_path: resolvePath(a.filename, cwd), content: str(a.content?.file?.content) }];
  }
  if (a.type === "instructions" && Array.isArray(a.files)) {
    return a.files
      .filter((f: Line) => str(f?.path))
      .map((f: Line) => ({ category: "instruction_load" as const, target_path: resolvePath(f.path, cwd), content: str(f.content) }));
  }
  // hook_success, and hook_cancelled: a hook that hung still ran.
  if (typeof a.type === "string" && a.type.startsWith("hook_") && str(a.command)) {
    const ok = a.type === "hook_success" && !a.exitCode;
    const url = shellUrl(a.command);
    return [{
      category: "process_creation", tool_name: `hook:${str(a.hookEvent) ?? "unknown"}`, command_line: a.command,
      content: str(a.stdout), outcome: ok ? "success" : "error", url, domain: url && domainOf(url),
    }];
  }
  return [];
}

/** The text of a string or a block list (`message.content`, `tool_result.content`); images and the like are dropped. */
function textOf(content: unknown): string | undefined {
  if (typeof content === "string") return str(content);
  if (!Array.isArray(content)) return undefined;
  return str(content.flatMap((b: Line) => (b?.type === "text" && typeof b.text === "string" ? [b.text] : [])).join("\n"));
}

const toolResults = (o: Line): Line[] =>
  Array.isArray(o.message?.content) ? o.message.content.filter((b: Line) => b?.type === "tool_result" && str(b.tool_use_id)) : [];

const attributionOf = (o: Line) =>
  (o.attributionSkill && `skill:${o.attributionSkill}`) || (o.attributionMcpServer && `mcp:${o.attributionMcpServer}`) ||
  (o.attributionPlugin && `plugin:${o.attributionPlugin}`) || undefined;

// node:readline also splits on U+2028/U+2029, which JSON leaves raw, so a pasted one would destroy its line.
// Plain reads: on Bun for Windows createReadStream took 5 to 8 times as long over the fixtures.
function* lines(path: string, hash: Hash): Generator<string> {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(READ_BYTES);
    const decoder = new TextDecoder(); // keeps multi-byte characters split across reads
    let rest = "";
    for (let got = readSync(fd, buffer); got > 0; got = readSync(fd, buffer)) {
      hash.update(buffer.subarray(0, got)); // the index's file hash comes from these bytes, not a second read
      const chunk = decoder.decode(buffer.subarray(0, got), { stream: true });
      if (!chunk.includes("\n")) {
        rest += chunk;
        continue;
      }
      const parts = (rest + chunk).split("\n");
      rest = parts.pop() ?? "";
      for (const part of parts) yield part.endsWith("\r") ? part.slice(0, -1) : part;
    }
    rest += decoder.decode();
    if (rest) yield rest.endsWith("\r") ? rest.slice(0, -1) : rest;
  } finally {
    closeSync(fd);
  }
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** One JSON object, or undefined for anything else: invalid JSON, a bare value, an array. */
function parseLine(line: string): Line | undefined {
  try {
    const o: unknown = JSON.parse(line);
    return o !== null && typeof o === "object" && !Array.isArray(o) ? (o as Line) : undefined;
  } catch {
    return undefined;
  }
}

/** Large outputs spill to <session>/tool-results/. Only the name is taken from the line, never its directory. */
function readSpill(sessionDir: string, persisted: unknown): string | undefined {
  const name = str(persisted)?.split(/[\\/]/).pop();
  if (!name) return undefined;
  const file = `${sessionDir}/tool-results/${name}`;
  try {
    return statSync(file).size <= MAX_SPILL_BYTES ? readText(file) : undefined;
  } catch {
    return undefined;
  }
}

/** Fallback spawn link: the parent's Agent result names the sub-agent. Team agents have no meta.json toolUseId.
 * Searches the text rather than streaming it: a team session repeats this for every agent in one parent file. */
function spawnLinkFromParent(parentFile: string, agentId: string): string | undefined {
  const text = readText(parentFile);
  for (let at = text?.indexOf(agentId) ?? -1; text !== undefined && at >= 0; at = text.indexOf(agentId, at + 1)) {
    const end = text.indexOf("\n", at);
    const o = parseLine(text.slice(text.lastIndexOf("\n", at) + 1, end < 0 ? undefined : end));
    if (o?.toolUseResult?.agentId === agentId) return toolResults(o)[0]?.tool_use_id;
    if (end < 0) break;
    at = end;
  }
  return undefined;
}

type Result = { id: string; kind?: string; rejected: boolean; category?: string; isError: boolean; text?: string; spill?: string };

/** Parses one transcript. Never throws. `id` is stable across runs and shared with set-aside copies; `raw_ref` names the
 * file actually read. */
export async function parseFile(path: string): Promise<ParsedFile & { sha256?: string }> {
  const file = normalizeSlashes(path);
  const canonical = file.replace(COPY_SUFFIX, ".jsonl"); // a set-aside copy repeats lines, and must upsert onto them
  const subagent = SUBAGENT_FILE.exec(path);
  const sessionDir = subagent?.[1] ?? path.replace(/\.(?:jsonl|orphaned-)[^\\/]*$/, "");
  const fileAgent = AGENT_FILE.exec(path)?.[1];
  const meta = fileAgent ? parseLine(readText(path.replace(/\.jsonl$/, ".meta.json")) ?? "") : undefined;

  const events: RawEvent[] = [];
  const unknown = new Map<string, number>(); // a Map: `type` is transcript text, and could be `__proto__`
  const toolEvents = new Map<string, RawEvent>();
  const results: Result[] = [];
  const skillBodies: [string, string][] = [];
  const spawnLinks = new Map<string, string>();
  const repeats = new Map<string, number>();
  const stats: ParsedFile["stats"] = { lines: 0, malformed: 0, unknown_types: {} };
  const carry: Line = { session_id: sessionDir.split(/[\\/]/).pop(), permission_mode: str(meta?.permissionMode) };
  let firstTs: string | undefined;

  // No uuid: identify the line by its text and which repeat it is. Line numbers differ between copies and would make
  // a different line in a copy overwrite this one, while permission-mode lines repeat byte for byte within a file.
  const textIdentity = (line: string) => {
    const nth = (repeats.get(line) ?? 0) + 1;
    repeats.set(line, nth);
    return `${line}\0${nth}`;
  };

  const handle = (o: Line, lineNo: number, line: string) => {
    let sub = 0;
    let identity = str(o.uuid);
    const cwd = carry.project_path;
    const emit = (fields: Partial<RawEvent>): RawEvent => {
      identity ??= textIdentity(line);
      // Survives a trimmed rewrite and a set-aside copy (0008). sub keeps multi-event lines apart.
      const id = createHash("sha256").update(`${canonical}\0${identity}\0${sub++}`).digest("hex").slice(0, 32);
      const ev = defined<RawEvent>({
        id, schema_version: "0.1", agent: "claude_code", session_id: carry.session_id, ts: carry.ts ?? "",
        seq: events.length, raw_ref: { file, line: lineNo }, agent_id: str(o.agentId) ?? fileAgent,
        agent_version: carry.agent_version, project_path: carry.project_path, entrypoint: carry.entrypoint,
        permission_mode: carry.permission_mode, prompt_source: str(o.promptSource) ?? (o.isMeta ? "system" : undefined),
        attribution: attributionOf(o), category: "tool_call", ...fields,
      });
      events.push(ev);
      return ev;
    };

    switch (o.type) {
      case "assistant":
        for (const b of Array.isArray(o.message?.content) ? o.message.content : []) {
          if (b?.type === "tool_use" && str(b.name)) {
            const ev = emit({ ...mapToolUse(b.name, b.input, cwd), outcome: "unknown" });
            if (str(b.id)) toolEvents.set(b.id, ev);
          } else if (b?.type === "text" && str(b.text)) {
            emit({ category: "assistant_message", text: b.text });
          }
        }
        break;
      case "user": {
        const text = textOf(o.message?.content);
        if (text && o.isMeta && str(o.sourceToolUseID)) skillBodies.push([o.sourceToolUseID, text]);
        else if (text && !o.isCompactSummary) emit({ category: "user_prompt", text });
        for (const b of toolResults(o)) {
          const t = o.toolUseResult;
          if (str(t?.agentId)) spawnLinks.set(t.agentId, b.tool_use_id);
          results.push({
            id: b.tool_use_id, kind: str(o.toolDenialKind), rejected: o.permissionDecision?.decision === "reject",
            category: str(o.permissionDecision?.classifierCategory), isError: !!b.is_error, text: textOf(b.content),
            spill: t?.persistedOutputPath,
          });
        }
        break;
      }
      case "attachment":
        for (const fields of attachmentFields(o.attachment ?? {}, cwd)) {
          addSecrets(fields);
          emit(fields);
        }
        break;
      case "permission-mode":
        emit({ category: "config_change" });
        break;
      default:
        if (!SKIPPED.has(o.type)) unknown.set(String(o.type), (unknown.get(String(o.type)) ?? 0) + 1);
    }
  };

  const hash = createHash("sha256");
  let read = false; // sha256 is returned only when the whole file was read
  try {
    let lineNo = 0;
    for (const line of lines(path, hash)) {
      lineNo++;
      if (!line.trim()) continue;
      stats.lines++;
      const l = parseLine(line);
      if (!l) {
        stats.malformed++;
        continue;
      }
      carry.ts = str(l.timestamp) ?? carry.ts;
      firstTs ??= carry.ts;
      carry.session_id = str(l.sessionId) ?? carry.session_id;
      carry.project_path = str(l.cwd) ? normalizeSlashes(l.cwd) : carry.project_path;
      carry.agent_version = str(l.version) ?? carry.agent_version;
      carry.entrypoint = str(l.entrypoint) ?? carry.entrypoint;
      carry.permission_mode = str(l.permissionMode) ?? carry.permission_mode;
      try {
        handle(l, lineNo, line);
      } catch {
        stats.malformed++; // e.g. nesting deep enough to overflow the stack: only this line is lost
      }
    }
    read = true;
  } catch {
    stats.malformed++; // unreadable, or removed by Claude Code's cleanup mid-scan
  }

  for (const r of results) {
    const ev = toolEvents.get(r.id);
    if (!ev) continue;
    const denied = !!r.kind || r.rejected;
    ev.outcome = denied ? "blocked" : r.isError ? "error" : "success";
    if (r.kind) ev.denial_kind = r.kind;
    if (r.category) ev.denial_category = r.category;
    const response = readSpill(sessionDir, r.spill) ?? r.text;
    if (!response) continue;
    ev.tool_response = response;
    const kinds = secretKinds(response);
    if (kinds.length) ev.result_secret_kinds = kinds;
  }
  for (const [id, body] of skillBodies) {
    const ev = toolEvents.get(id);
    if (!ev) continue;
    ev.content = ev.content ? `${ev.content}\n${body}` : body;
    addSecrets(ev);
  }

  const spawned = str(meta?.toolUseId) ?? (subagent && fileAgent ? spawnLinkFromParent(`${sessionDir}.jsonl`, fileAgent) : undefined);
  const fallbackTs = firstTs ?? fileTime(path);
  for (const ev of events) {
    ev.ts ||= fallbackTs; // lines before the first timestamp
    if (!ev.agent_id) continue;
    const parent = (ev.agent_id === fileAgent ? spawned : undefined) ?? spawnLinks.get(ev.agent_id);
    if (parent) ev.parent_tool_use_id = parent;
  }
  stats.unknown_types = Object.fromEntries(unknown);
  return { events, stats, sha256: read ? hash.digest("hex") : undefined };
}

function fileTime(path: string): string {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

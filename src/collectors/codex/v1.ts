// Codex rollout parser (docs/formats/codex.md). A bad line is counted, never fatal. Events carry raw values for rules
// (ADR 0006); masking for storage happens outside this file. Actions come from `event_msg` `item_completed`, never
// from the code-mode `exec` script text. `response_item` is read only for pre-paginated rollouts (shell function_call).
import { createHash } from "node:crypto";
import { normalizeSlashes } from "../../normalize/paths.ts";
import type { ParsedFile, RawEvent } from "../../normalize/types.ts";
import { argvOf, cwdOf, mapItem, shellFields, textOf, type Fields } from "./map.ts";
import { defaultZstd, firstLine, readRollout, type Zstd } from "./read.ts";

type Line = Record<string, any>;
type Call = { o: Line; lineNo: number; ts: string; turn?: string; name: string; input?: string; ev?: RawEvent };
const RUNNING = /^Script running with cell ID (\S+)/; // an exec cell that yielded before finishing
const IGNORED = new Set("response_item event_msg token_usage_record world_state inter_agent_communication_metadata turn_context".split(" "));
const LEGACY_SHELL = new Set(["shell", "exec_command", "shell_command", "container.exec"]);
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/i;

function parseLine(line: string): Line | undefined {
  try {
    const o: unknown = JSON.parse(line);
    return o !== null && typeof o === "object" && !Array.isArray(o) ? (o as Line) : undefined;
  } catch {
    return undefined;
  }
}

/** The root thread id that `payload` (a session_meta payload) belongs to. A sub-agent's and a guardian's `session_id`
 * is their parent's (observed at depth 1); `parent_thread_id` is the fallback. */
const rootOf = (p: Line): string | undefined => str(p.session_id) ?? str(p.parent_thread_id) ?? str(p.id);
const isGuardian = (p: Line) => p.source?.subagent?.other === "guardian";

const keys = new Map<string, string>();
/** Files of one root session share a key: the root thread id from the first line, else the id in the file name. */
export function groupKey(path: string, zstd: Zstd | null = defaultZstd): string {
  const p = normalizeSlashes(path);
  const known = keys.get(p);
  if (known) return known;
  let root: string | undefined;
  try {
    const first = parseLine(firstLine(path, zstd));
    root = first?.type === "session_meta" ? rootOf(first.payload ?? {}) : undefined;
  } catch {
    // unreadable (e.g. .zst without zstd): the file name still names the thread
  }
  const key = `codex:${root ?? UUID.exec(p)?.[1] ?? p}`;
  keys.set(p, key);
  return key;
}

/** Parses one rollout. Never throws for bad content; throws only when a .zst cannot be read on this runtime (the scan
 * reports that as a failed file with the message). */
export async function parseFileWith(path: string, zstd: Zstd | null): Promise<ParsedFile & { sha256?: string }> {
  const file = normalizeSlashes(path);
  // ids must not change when Codex compresses the file (R2) or `codex archive` moves it to archived_sessions/
  const canonical = file.slice(file.lastIndexOf("/") + 1).replace(/\.zst$/, "");
  const stats: ParsedFile["stats"] = { lines: 0, malformed: 0, unknown_types: {} };
  const events: RawEvent[] = [];
  const unknown = new Map<string, number>();
  let rollout: ReturnType<typeof readRollout>;
  try {
    rollout = readRollout(path, zstd);
  } catch (e) {
    if (path.endsWith(".zst") && !zstd) throw e;
    stats.malformed++; // unreadable or a corrupt archive
    return { events, stats };
  }

  const st = { session: UUID.exec(file)?.[1] ?? "", agent: undefined as string | undefined, version: undefined as string | undefined,
    cwd: undefined as string | undefined, ts: "", start: 0, guardian: false, legacy: false, sub: false, parentTurn: undefined as string | undefined,
    turn: undefined as string | undefined };
  let seenMeta = false;

  const emit = (o: Line, lineNo: number, n: number, fields: Fields): RawEvent => {
    const id = createHash("sha256").update(`${canonical}\0${o.ordinal ?? lineNo}\0${n}`).digest("hex").slice(0, 32);
    const ev: Record<string, unknown> = {
      id, schema_version: "0.1", agent: "codex", session_id: st.session, agent_id: st.agent, agent_version: st.version,
      project_path: st.cwd, ts: st.ts, seq: events.length, raw_ref: { file, line: lineNo }, category: "tool_call", ...fields,
    };
    for (const k of Object.keys(ev)) if (ev[k] === undefined) delete ev[k];
    events.push(ev as RawEvent);
    return ev as RawEvent;
  };

  // Interrupts: a call with no output yet, or an exec cell that answered "Script running" and was never reported
  // finished, is in flight. `turn_aborted` marks those of its turn blocked (Claude's interrupted tool_result).
  const inflight = new Map<string, Call>(); // call_id -> call
  const cells = new Map<string, Call>(); // exec cell id -> the exec call that opened it
  const waits = new Map<string, string>(); // `wait` call_id -> cell id it polls
  const track = (o: Line, lineNo: number, p: Line, ev?: RawEvent) => {
    const id = str(p.call_id);
    if (!id) return;
    if (p.type === "function_call" && p.name === "wait") waits.set(id, String(parseLine(String(p.arguments ?? ""))?.cell_id));
    else if (p.type === "custom_tool_call" || p.type === "function_call")
      inflight.set(id, { o, lineNo, ts: st.ts, turn: st.turn, name: str(p.name) ?? "unknown", input: str(p.input) ?? str(p.arguments), ev });
    else if (p.type === "custom_tool_call_output" || p.type === "function_call_output") {
      const running = RUNNING.exec(textOf(p.output) ?? "")?.[1];
      const call = inflight.get(id);
      inflight.delete(id);
      if (call && running) cells.set(running, call);
      const polled = waits.get(id);
      if (polled !== undefined && !running) cells.delete(polled);
    }
  };
  const abort = (turn: string | undefined, kind: string) => {
    for (const m of [inflight, cells]) {
      for (const [k, c] of m) {
        if (turn && c.turn !== turn) continue;
        m.delete(k);
        if (c.ev) Object.assign(c.ev, { outcome: "blocked", denial_kind: kind }); // a legacy shell call already emitted
        else emit(c.o, c.lineNo, 0, { tool_name: c.name, tool_input: c.input, ts: c.ts, outcome: "blocked", denial_kind: kind });
      }
    }
  };

  const meta = (p: Line) => {
    seenMeta = true;
    st.session = rootOf(p) ?? st.session;
    st.version = str(p.cli_version);
    st.cwd = cwdOf(p.cwd);
    st.guardian = isGuardian(p);
    st.legacy = p.history_mode !== "paginated";
    st.sub = !!p.parent_thread_id && !st.guardian;
    st.start = typeof p.subagent_history_start_ordinal === "number" ? p.subagent_history_start_ordinal : 0;
    if (st.sub) st.agent = str(p.agent_path) ?? str(p.id);
  };

  const guardian = (o: Line, lineNo: number, p: Line) => {
    if (p.type === "task_started") st.parentTurn = str(p.turn_attribution?.parent_turn_id);
    if (p.type !== "task_complete") return;
    const verdict = parseLine(String(p.last_agent_message ?? ""));
    if (!verdict || verdict.outcome === "allow" || !str(verdict.outcome)) return;
    const { risk_level, user_authorization, outcome } = verdict;
    // Linked to the parent session, and to the reviewed turn only by id: which call of that turn it judged is not recorded.
    emit(o, lineNo, 0, {
      tool_name: "guardian_review", outcome: "blocked", denial_kind: String(outcome), denial_category: str(risk_level),
      tool_input: JSON.stringify({ parent_turn_id: st.parentTurn, risk_level, user_authorization, outcome }), text: str(verdict.rationale),
    });
  };

  const handle = (o: Line, lineNo: number) => {
    const p: Line = o.payload && typeof o.payload === "object" ? o.payload : {};
    if (o.type === "turn_context") st.cwd = cwdOf(p.cwd) ?? st.cwd;
    if (o.type === "turn_context" || p.type === "task_started") st.turn = str(p.turn_id) ?? st.turn;
    if (st.guardian) return o.type === "event_msg" ? guardian(o, lineNo, p) : undefined;
    if (o.type === "event_msg" && p.type === "item_completed" && p.item) {
      const fields = mapItem(p.item, st.sub, st.cwd);
      for (const [n, f] of (Array.isArray(fields) ? fields : fields ? [fields] : []).entries()) emit(o, lineNo, n, f);
    } else if (o.type === "event_msg" && p.type === "turn_aborted") {
      abort(str(p.turn_id), str(p.reason) ?? "interrupted");
    } else if (o.type === "response_item" && st.legacy && p.type === "function_call" && LEGACY_SHELL.has(p.name)) {
      const a = parseLine(String(p.arguments ?? "")) ?? {};
      track(o, lineNo, p, emit(o, lineNo, 0, { ...shellFields(argvOf(a.command ?? a.cmd)), outcome: "unknown" }));
    } else if (o.type === "response_item") track(o, lineNo, p);
  };

  let lineNo = 0;
  for (const raw of rollout.text.split("\n")) {
    lineNo++;
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!line.trim()) continue;
    stats.lines++;
    const o = parseLine(line);
    if (!o) {
      stats.malformed++;
      continue;
    }
    try {
      st.ts = str(o.timestamp) ?? st.ts;
      if (o.type === "session_meta") {
        if (!seenMeta) meta(o.payload ?? {}); // a forked sub-agent file repeats the parent's header: only the first counts
        continue;
      }
      if (typeof o.ordinal === "number" && o.ordinal < st.start) continue; // copied parent history
      if (!IGNORED.has(o.type)) unknown.set(String(o.type), (unknown.get(String(o.type)) ?? 0) + 1);
      handle(o, lineNo);
    } catch {
      stats.malformed++; // e.g. nesting deep enough to overflow the stack: only this line is lost
    }
  }
  stats.unknown_types = Object.fromEntries(unknown);
  return { events, stats, sha256: rollout.raw ? createHash("sha256").update(rollout.raw).digest("hex") : undefined };
}

export const parseFile = (path: string) => parseFileWith(path, defaultZstd);

// Finds Antigravity CLI conversations and links sub-agents to their parent (docs/formats/antigravity.md). Read-only.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { normalizeSlashes } from "../../normalize/paths.ts";
import { open } from "../../store/sqlite.ts";

const SYS = ".system_generated";
const TRANSCRIPT = `${SYS}/logs/transcript_full.jsonl`; // transcript.jsonl and logs/chunks/* are copies of it
const LAYOUT = /^(.*\/brain)\/([^/]+)\/\.system_generated\//;

export type Conversation = { parent?: string; workspace?: string; role?: string };

const names = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return []; // missing or unreadable
  }
};

/** `brain/<conv>/.system_generated/logs/transcript_full.jsonl` under `root` (~/.gemini/antigravity-cli), sorted. */
export function discover(root: string): string[] {
  const brain = join(root, "brain");
  return names(brain)
    .map((c) => normalizeSlashes(join(brain, c, TRANSCRIPT)))
    .filter((f) => existsSync(f))
    .sort();
}

/** file:///C:/x/y -> C:/x/y ; file:///home/x -> /home/x */
function fromUri(uri: unknown): string | undefined {
  if (typeof uri !== "string" || !uri.startsWith("file://")) return undefined;
  try {
    const p = decodeURIComponent(uri.slice(7)).replace(/^\/(?=[A-Za-z]:)/, "");
    return normalizeSlashes(p);
  } catch {
    return undefined;
  }
}

const firstUri = (json: unknown): unknown => {
  try {
    return JSON.parse(String(json))?.[0];
  } catch {
    return undefined;
  }
};

/** conversation id -> workspace from the CLI's own index `conversation_summaries.db` (`workspace_uris`, a JSON list of
 * file URIs; one row per conversation, roots included). Read-only; a missing, locked or changed db gives none. */
function summaryWorkspaces(home: string): Map<string, string> {
  const out = new Map<string, string>();
  const path = join(home, "conversation_summaries.db");
  if (!existsSync(path)) return out;
  try {
    const db = open(path, { readonly: true });
    try {
      for (const r of db.prepare("SELECT conversation_id, workspace_uris FROM conversation_summaries").all()) {
        const ws = fromUri(firstUri(r.workspace_uris));
        if (typeof r.conversation_id === "string" && ws) out.set(r.conversation_id, ws);
      }
    } finally {
      db.close();
    }
  } catch {
    // not a db we can read: the next source decides
  }
  return out;
}

/** conversation id -> workspace from `history.jsonl` (`{workspace, conversationId}` per prompt; the prompt that opens a
 * conversation has no conversationId, so a one-prompt conversation is not here). */
function historyWorkspaces(home: string): Map<string, string> {
  const out = new Map<string, string>();
  let text = "";
  try {
    text = readFileSync(join(home, "history.jsonl"), "utf8");
  } catch {
    return out; // missing or unreadable
  }
  for (const line of text.split("\n")) {
    try {
      const o = JSON.parse(line);
      if (typeof o?.conversationId === "string" && typeof o.workspace === "string" && o.workspace && !out.has(o.conversationId))
        out.set(o.conversationId, normalizeSlashes(o.workspace));
    } catch {
      // blank or partial line
    }
  }
  return out;
}

const links = new Map<string, Map<string, Conversation>>(); // memo per brain dir: groupKey is called once per file

/** child -> parent links from every `subagents/<child>.json`, and each conversation's workspace, first found of:
 * conversation_summaries.db, the sub-agent link file (a root takes its first child's), history.jsonl. */
export function conversations(brain: string): Map<string, Conversation> {
  const hit = links.get(brain);
  if (hit) return hit;
  const map = new Map<string, Conversation>();
  for (const parent of names(brain)) {
    const dir = join(brain, parent, SYS, "subagents");
    for (const f of names(dir).filter((n) => n.endsWith(".json"))) {
      try {
        const j = JSON.parse(readFileSync(join(dir, f), "utf8"));
        const child = f.slice(0, -5);
        const workspace = fromUri(j?.workspaceUris?.[0]);
        map.set(child, { ...map.get(child), parent, workspace, role: j?.subagentDescriptor?.role });
        map.set(parent, { workspace, ...map.get(parent) });
      } catch {
        // a malformed link file only loses the link
      }
    }
  }
  const home = dirname(brain);
  const [db, history] = [summaryWorkspaces(home), historyWorkspaces(home)];
  for (const c of new Set([...db.keys(), ...history.keys()])) {
    const known = map.get(c) ?? {};
    map.set(c, { ...known, workspace: db.get(c) ?? known.workspace ?? history.get(c) });
  }
  links.set(brain, map);
  return map;
}

/** The root conversation id: follows parent links, with a bound against a cycle. */
export function rootOf(map: Map<string, Conversation>, conv: string): string {
  let c = conv;
  for (let n = 0; n < 32 && map.get(c)?.parent; n++) c = map.get(c)!.parent!;
  return c;
}

/** Parent and sub-agent files share a key: the brain dir plus the root conversation id. */
export function groupKey(path: string): string {
  const { brain, conv } = locate(path);
  return brain ? `${brain}/${rootOf(conversations(brain), conv)}` : path;
}

export function locate(path: string): { brain?: string; conv: string } {
  const [, brain, conv] = LAYOUT.exec(normalizeSlashes(path)) ?? [];
  return brain && conv ? { brain, conv } : { conv: normalizeSlashes(path).split("/").pop() ?? path };
}

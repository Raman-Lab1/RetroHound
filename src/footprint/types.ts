// The footprint report: what the index knows about every AI coding agent on this machine, as aggregates.
// Built from the index only by src/footprint/data.ts (no transcript re-read, so deleted sessions still count) and
// rendered by src/footprint/html.ts as one offline page. Every string here is already masked (ADR 0007).
// Lists are sorted (most first, then by name) and capped; `omitted` says how many rows each cap left out.
import { createHash } from "node:crypto";
import { mask } from "../normalize/mask.ts";
import type { Level } from "../normalize/types.ts";

/** One thing the agents used or reached: an MCP server, a hook command, a skill/plugin, a web domain. */
export type Seen = {
  name: string;
  detail?: string; // hooks: the hook event (`hook:PreToolUse`)
  events: number;
  sessions: number;
  blocked: number; // events with outcome "blocked"
  sub_agent: number; // events with an agent_id
  first_ts: string;
  last_ts: string;
};

export type SubAgentNode = { agent_id: string; events: number; blocked: number };

export type SessionNode = {
  session_id: string;
  first_ts: string;
  last_ts: string;
  events: number;
  blocked: number;
  findings: number;
  worst?: Level; // highest finding level, absent without findings
  archived: boolean; // every source file is gone: Claude Code deleted it, the index kept it (ADR 0008)
  sub_agents: SubAgentNode[];
};

export type ProjectNode = {
  project: string; // project_path, "-" when the agent gave none
  sessions: number;
  events: number;
  blocked: number;
  findings: number;
  worst?: Level;
  list: SessionNode[]; // capped across the whole report, highest risk then most recent first
};

export type AgentNode = { agent: string; sessions: number; events: number; projects: ProjectNode[] };

/** Where one secret went: by fingerprint, never the value. */
export type SecretReach = {
  fingerprint: string;
  kinds: string[];
  sessions: number;
  sub_agents: number; // distinct agent_ids among the events that carried it
  projects: string[];
  domains: string[]; // domains contacted in the same sessions (co-occurrence, not proof the secret was sent there)
  first_ts: string;
  last_ts: string;
};

export type FindingRow = {
  level: Level;
  rule: string; // rule name, else title, else id
  ts: string;
  session_id: string;
  project: string;
  agent_id?: string; // the primary event's sub-agent
  message: string;
};

/** One thing an agent's config files set up, read when the report is built (src/footprint/config-*.ts), never stored. */
export type ConfigItem = {
  agent: string; // claude_code | codex | antigravity: the index's `agent` column
  kind: "mcp_server" | "hook" | "skill" | "plugin";
  // In the index's own form, so it joins with what transcripts show: the `mcp_server` column value; the hook's
  // `command_line`; for skill/plugin the part after `skill:` / `plugin:` in `attribution`. A plugin's events also include
  // the calls on its own MCP servers (`plugin_<name>_<server>`), each event once.
  name: string;
  scope: string; // user | project | local | managed | plugin
  source: string; // the file it was read from
  detail?: string; // hook: `hook:<Event>`; mcp_server: transport (stdio, http, sse) when given
  hash: string; // entryHash of the whole entry (server object, SKILL.md text, ...), so a change shows; set by every reader
};

/** sha256 of the masked, canonical (keys sorted) JSON of a config entry: a change in command, args, url or env shows
 * in the config snapshots (src/footprint/snapshot.ts) without the value being stored. A masked secret that changes
 * stays the same hash. */
export const entryHash = (entry: unknown) => createHash("sha256").update(mask(JSON.stringify(entry ?? null, (_k, v: unknown) =>
  v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v))).digest("hex");

/** What one agent's reader found. Names and hook commands only: env, headers, args and URLs are never read out, only
 * hashed (masked) into `hash`. */
export type ConfigRead = { items: ConfigItem[]; files: number; skipped: { path: string; reason: string }[] };

/** home: the user's home dir; projects: project paths from the index (only those still on disk are read). */
/** Items one reader returns at most: a hostile plugin.json or skill tree must not exhaust memory. */
export const MAX_CONFIG_ITEMS = 5000;

export type ConfigReader = (o: { home: string; projects: string[]; env?: Record<string, string | undefined> }) => ConfigRead;

/** Configured versus observed: each item with how often transcripts show it, and what transcripts show that no
 * config file read now sets up (removed since, or set up somewhere RetroHound does not read). */
export type ConfigFootprint = {
  // events 0 means "never seen used" only when `observable`: as collected, Codex transcripts record MCP calls but no hook
  // run or skill/plugin attribution, and Antigravity's none of the four, so for those 0 says nothing.
  // One row per agent + kind + name, however many files set it up (a skill folder copied into every project is one row).
  items: {
    agent: string; kind: ConfigItem["kind"]; name: string;
    detail?: string; // the distinct details, ", "-joined
    scopes: string[]; // distinct, sorted
    files: number; // config files that set it up
    source: string; // the first of them, sorted
    events: number; sessions: number; last_ts?: string; observable: boolean;
  }[];
  unlisted: { agent: string; kind: ConfigItem["kind"]; name: string; events: number; sessions: number; last_ts: string }[];
  files: number;
  skipped: number;
};

/** The config snapshot of the latest indexed scan against the one before (src/footprint/snapshot.ts). new and removed:
 * agent + kind + name in one and not the other; changed: same agent, kind, name, scope and source, another hash. */
export type ConfigSnapshotDiff = {
  compared: boolean; // false until two scans have taken a snapshot; the lists are then empty
  new: { agent: string; kind: string; name: string; scope: string; source: string }[];
  changed: ConfigSnapshotDiff["new"];
  removed: ConfigSnapshotDiff["new"];
};

export type Footprint = {
  generated_at: string;
  tool_version: string;
  trust: {
    // Size and head only, not a verdict: walking the chain loads every row (GBs at 500k events), so that stays with
    // `retrohound verify`. null: the index predates the chain (ADR 0015).
    chain: { entries: number; head: string } | null;
    files: { indexed: number; gone: number };
    archived_sessions: number;
    retention_days?: number; // Claude Code's cleanupPeriodDays, when the caller knows it
    first_ts?: string; // earliest event in the index
    last_ts?: string;
  };
  totals: {
    agents: number;
    projects: number;
    sessions: number;
    events: number;
    sub_agent_events: number;
    blocked: number;
    secrets: number; // distinct fingerprints
    findings: Record<Level, number>;
  };
  activity: { day: string; events: number; blocked: number; findings: number }[]; // UTC days with events, ascending, last 365
  agents: AgentNode[];
  tools: { mcp_servers: Seen[]; hooks: Seen[]; attributions: Seen[] }; // attributions: skill:<x>, plugin:<x>, mcp:<server>
  domains: Seen[];
  secrets: SecretReach[];
  modes: { mode: string; events: number; sessions: number; sub_agent: number }[]; // permission_mode, "-" when unset
  blocked: { kinds: { name: string; count: number }[]; categories: { name: string; count: number }[] };
  findings: FindingRow[]; // highest level first, then newest
  configured?: ConfigFootprint; // absent when the caller read no config
  config_changes?: ConfigSnapshotDiff; // absent on an index from before config snapshots (opened read-only, never upgraded)
  omitted: { sessions: number; findings: number; domains: number; secrets: number; tools: number };
};

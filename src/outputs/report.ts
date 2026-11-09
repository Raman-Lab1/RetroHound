// Shared contract between scan (src/scan.ts), outputs and the CLI: the `retrohound.scan/0.1` document (ADR 0014)
// plus the summary counts ADR 0008 asks `scan` to print.
import type { Lane } from "../engine/load.ts";
import type { Finding, Level } from "../normalize/types.ts";

/** A rule that fired. Sigma fields verbatim. */
export type ReportRule = {
  id: string;
  name?: string;
  title: string;
  author?: string; // DRL 1.1 (rules/LICENSE): output based on matches keeps the rule's author
  description?: string;
  level: Level;
  tags: string[];
  lane: Lane;
  falsepositives?: string[];
};

/** The blocked events of the kept sessions, by the agent's own decision fields. Counts, most first. */
export type BlockedBreakdown = {
  kinds: Record<string, { main: number; sub_agent: number }>; // denial_kind; "unspecified" when the agent gave none
  categories?: Record<string, number>; // denial_category (Claude Code's classifier; Codex's risk level)
  attributions?: Record<string, number>; // skill:<x> | mcp:<server> | plugin:<x> the blocked call ran under
  top_projects: { project_path: string; blocked: number }[]; // the session's project path, at most 5; "-" when none
};

export type ScanReport = {
  schema: "retrohound.scan/0.1";
  tool: { name: string; version: string };
  scan: {
    started_at: string;
    finished_at: string;
    sessions: number;
    events: number;
    blocked: number; // events with outcome "blocked" (includes interrupted, see denial_kind)
    blocked_breakdown?: BlockedBreakdown; // only when blocked > 0
    subagent_events: number; // events with an agent_id, for "% from sub-agents"
    files: { indexed: number; skipped: number; gone: number; failed: number };
    // Lines the parser skipped in the files parsed by this run (skipped files are not re-read).
    lines?: { malformed: number; unknown_types: Record<string, number> };
    archived_sessions: string[]; // sessions whose transcripts Claude Code deleted, kept by the index (0008)
    suppressed?: number; // findings left out by an ignore file (.retrohound-ignore.yml); the index still holds them (0008)
    root: string; // where transcripts were looked for, masked; for the empty state (--agent all: every root, ", ")
    agents?: Record<string, { sessions: number; events: number; findings: number }>; // --agent all only, after filters
  };
  rules: ReportRule[];
  findings: Finding[]; // masked; events[0] is the primary event
};

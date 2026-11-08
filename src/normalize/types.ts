// The shared event contract (docs/logsource.md). Every collector and rule depends on it: change it deliberately.

export const LEVELS = ["informational", "low", "medium", "high", "critical"] as const; // all five Sigma levels (0014)
export type Level = (typeof LEVELS)[number];

export const CATEGORIES = [
  "tool_call", // generic
  "process_creation", // shell commands; hook runs as tool_name "hook:<Event>"
  "file_access", // Read, @-mentioned file
  "file_event", // Write/Edit/NotebookEdit, incl. writes to config files (0003: was file_change)
  "web_request", // WebFetch, MCP call carrying a URL (0003: was network)
  "mcp",
  "instruction_load", // CLAUDE.md, skills, rules loaded
  "config_change", // config-state lines Claude Code writes, e.g. permission-mode (0003: narrowed)
  "user_prompt",
  "assistant_message",
] as const;
export type Category = (typeof CATEGORIES)[number];

export type Outcome = "success" | "error" | "blocked" | "unknown";

/**
 * Normalized event, as stored and output. Every string is masked (0007) before it reaches the DB or an output.
 * List fields are absent, never `[]`, when empty: Sigma `|exists` (X1) is true for any present field.
 */
export type AgentEvent = {
  id: string; // hash(source_file, line uuid ?? line_no, sub_index) (0002, 0008)
  schema_version: "0.1";
  agent: "claude_code" | "codex" | "antigravity" | "gemini_cli" | "cursor";
  agent_version?: string; // line `version`
  session_id: string; // Claude's sessionId, also on sub-agent events (0005)
  parent_session_id?: string; // unset for Claude Code (0005)
  agent_id?: string; // sub-agent id; main-file events have none
  parent_tool_use_id?: string; // the parent's Agent tool_use id
  project_path?: string; // line `cwd`
  ts: string; // ISO-8601
  seq: number; // line order within the file, one stream (0005)
  category: Category;
  tool_name?: string; // Bash, PowerShell, Read, Edit, WebFetch, mcp__x__y, hook:<Event>
  command_line?: string;
  target_path?: string; // absolute when resolvable
  url?: string;
  domain?: string;
  mcp_server?: string;
  mcp_tool?: string;
  outcome?: Outcome;
  permission_mode?: string;
  prompt_source?: string; // typed | sdk | system
  entrypoint?: string; // cli | claude-desktop
  attribution?: string; // skill:<x> | mcp:<server> | plugin:<x>
  denial_kind?: string; // toolDenialKind
  denial_category?: string; // classifierCategory
  secret_kinds?: string[]; // pattern names from tool_input and content, never values (0007)
  result_secret_kinds?: string[]; // pattern names from tool_response (0007)
  secret_fps?: string[]; // first 16 hex of sha256 of each strong match (0007)
  text_excerpt?: string; // masked, <= 500 chars
  raw_ref: { file: string; line: number }; // pointer only, raw text is not stored
};

/** Raw text for rule matching in memory. Never written to the DB or any output (0006). */
export type MatchOnly = {
  content?: string; // Write/Edit body, heredoc body, instruction/@-file/Skill text, hook stdout
  tool_input?: string; // JSON.stringify of the raw tool_use.input
  tool_response?: string; // the paired tool_result text
  text?: string; // full prompt / assistant text
};

/** What rules see at collection time. Assignable to AgentEvent, so the type alone does not stop a leak (0006). */
export type RawEvent = AgentEvent & MatchOnly;

export type Finding = {
  id: string; // sha256(rule_id + sorted event ids) (0014)
  rule_id: string;
  level: Level;
  ts: string;
  session_id: string;
  message: string; // masked, one line
  events: AgentEvent[]; // masked; [0] = primary event, the rest are related events of a correlation
};

export type ParseStats = {
  lines: number;
  malformed: number;
  unknown_types: Record<string, number>; // line `type` -> count
};

export type ParsedFile = { events: RawEvent[]; stats: ParseStats };

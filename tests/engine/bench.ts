// Throughput of the engine alone, run by hand: `bun tests/engine/bench.ts`. Thirty rules of bundled-rule shape over
// synthetic, defanged events. Not a test, so a busy machine cannot fail the suite.
import type { Category, RawEvent } from "../../src/normalize/types.ts";
import { evaluate } from "../../src/engine/evaluate.ts";
import { loadRules } from "../../src/engine/load.ts";

const rule = (i: number, category: string | null, body: string) => `title: Bench ${i}
name: bench_${i}
level: medium
logsource: { product: ai_coding_agent${category ? `, category: ${category}` : ""} }
detection:
${body.split("\n").map((l) => `    ${l}`).join("\n")}
`;

const SHELL = "process_creation";
const docs: string[] = [
  rule(0, "file_access", "selection:\n    target_path|endswith: [/.env, /.aws/credentials, .pem, .p12, /.netrc, /.npmrc, /id_rsa, /id_ed25519]\nfilter:\n    target_path|endswith: [.env.example, .env.sample]\ncondition: selection and not filter"),
  rule(1, null, "selection:\n    secret_kinds|exists: true\ncondition: selection"),
  rule(2, null, "selection:\n    domain|exists: true\nfilter:\n    domain: [localhost, 127.0.0.1]\nshell:\n    command_line|contains: [curl, wget, ' nc ', scp, 'git push', 'npm publish']\ncondition: (selection and not filter) or shell"),
  rule(3, SHELL, "selection:\n    command_line|re: 'rm\\s+-[a-z]*r[a-z]*f?\\s+/'\ncondition: selection"),
  rule(4, SHELL, "selection:\n    command_line|contains|all: [curl, '| sh']\ncondition: selection"),
  rule(5, SHELL, "selection:\n    command_line|contains: [base64 -d, 'eval $(', xxd -r]\ncondition: selection"),
  rule(6, SHELL, "selection:\n    command_line|startswith: [sudo , 'su -']\ncondition: selection"),
  rule(7, SHELL, "selection:\n    command_line|re|i: 'chmod\\s+(777|\\+s)'\ncondition: selection"),
  rule(8, SHELL, "selection:\n    command_line|contains: [--no-verify, --force, --dangerously-skip-permissions]\ncondition: selection"),
  rule(9, SHELL, "sel_a:\n    command_line|contains: crontab\nsel_b:\n    command_line|contains: launchctl\nsel_c:\n    command_line|contains: systemctl enable\ncondition: 1 of sel_*"),
  rule(10, SHELL, "selection:\n    command_line|windash|contains: ' -enc '\ncondition: selection"),
  rule(11, SHELL, "selection:\n    command_line: '*ssh*-R*'\ncondition: selection"),
  rule(12, "file_event", "selection:\n    target_path|contains: [/.claude/, /.cursor/, /.mcp.json, /.git/hooks/]\ncondition: selection"),
  rule(13, "file_event", "selection:\n    target_path|fieldref|startswith: project_path\ncondition: not selection"),
  rule(14, "file_event", "selection:\n    content|re: '[\\u200B-\\u200F\\u2060-\\u2064]'\ncondition: selection"),
  rule(15, "file_event", "selection:\n    content|contains: [ignore previous instructions, do not tell the user]\ncondition: selection"),
  rule(16, "web_request", "selection:\n    domain|endswith: [.ngrok.io, .example.invalid, .trycloudflare.com]\ncondition: selection"),
  rule(17, "web_request", "selection:\n    url|contains: [webhook, pastebin, transfer.sh]\ncondition: selection"),
  rule(18, "mcp", "selection:\n    mcp_tool|contains: [exec, shell, run_command]\ncondition: selection"),
  rule(19, "mcp", "selection:\n    tool_input|contains: [password, api_key]\ncondition: selection"),
  rule(20, "instruction_load", "selection:\n    content|re: '[\\uE0000-\\uE007F]'\ncondition: selection"),
  rule(21, "instruction_load", "selection:\n    content|contains: [curl , wget , always run]\ncondition: selection"),
  rule(22, "config_change", "selection:\n    permission_mode: [bypassPermissions, acceptEdits]\ncondition: selection"),
  rule(23, "user_prompt", "selection:\n    text|contains: [password, api key]\nsource:\n    prompt_source: typed\ncondition: selection and source"),
  rule(24, "assistant_message", "selection:\n    text|contains: [i cannot verify, skipping the tests]\ncondition: selection"),
  rule(25, null, "selection:\n    outcome: blocked\ncondition: selection"),
  rule(26, null, "selection:\n    seq|gt: 1000\n    tool_name: [Bash, PowerShell]\ncondition: selection"),
  rule(27, null, "selection:\n    attribution|startswith: 'plugin:'\ncondition: selection"),
  `title: Bench 28\nname: bench_28\ncorrelation:\n    type: temporal_ordered\n    rules: [bench_0, bench_2]\n    group-by: [session_id, agent_id]\n    timespan: 10m\n    generate: true\nx-retrohound: { max_events_between: 20 }\n`,
  `title: Bench 29\nname: bench_29\ncorrelation:\n    type: event_count\n    rules: [bench_25]\n    group-by: [session_id, agent_id]\n    timespan: 5m\n    generate: true\n    condition: { gte: 2 }\n`,
];

const COMMANDS = ["git status", "bun test tests/engine", "cat README.md | head -40", "curl -s https://example.invalid/api", "ls -la src", "npm run build"];
const CATEGORIES: Category[] = [SHELL, SHELL, SHELL, "file_access", "file_access", "file_event", "web_request", "mcp", "user_prompt", "assistant_message", "assistant_message", "tool_call", "instruction_load", "config_change"];
const FILLER = "the quick brown fox jumps over the lazy dog while the build runs ".repeat(30); // about 2 KB

function makeEvents(count: number): RawEvent[] {
  return Array.from({ length: count }, (_, i) => {
    const category = CATEGORIES[i % CATEGORIES.length]!;
    const base: RawEvent = {
      id: `id-${i}`, schema_version: "0.1", agent: "claude_code", session_id: `s${Math.floor(i / 2000)}`,
      project_path: "/home/user/project", ts: new Date(1_767_225_600_000 + i * 2000).toISOString(), seq: i % 2000, category,
      raw_ref: { file: "a.jsonl", line: i }, outcome: i % 97 === 0 ? "blocked" : "success",
    };
    if (category === SHELL) return { ...base, tool_name: "Bash", command_line: `${COMMANDS[i % COMMANDS.length]} --run ${i}`, tool_input: `{"command":"${COMMANDS[i % COMMANDS.length]}"}`, tool_response: FILLER };
    if (category === "file_access") return { ...base, tool_name: "Read", target_path: `/home/user/project/src/file${i % 50}.ts`, tool_response: FILLER };
    if (category === "file_event") return { ...base, tool_name: "Edit", target_path: `/home/user/project/src/file${i % 50}.ts`, content: FILLER };
    if (category === "web_request") return { ...base, tool_name: "WebFetch", url: "https://example.invalid/docs", domain: "example.invalid" };
    if (category === "mcp") return { ...base, tool_name: "mcp__x__y", mcp_server: "x", mcp_tool: "y", tool_input: '{"q":"docs"}' };
    if (category === "instruction_load") return { ...base, target_path: "/home/user/project/CLAUDE.md", content: FILLER };
    if (category === "config_change") return { ...base, permission_mode: "default" };
    return { ...base, text: FILLER, prompt_source: "typed" };
  });
}

const started = performance.now();
const { rules, rejected } = loadRules(docs.map((text, i) => ({ path: `bench${i}.yml`, text })));
const loadMs = performance.now() - started;
if (rejected.length > 0) throw new Error(JSON.stringify(rejected));

const events = makeEvents(200_000);
const runs: number[] = [];
let matches = 0;
for (let i = 0; i < 6; i++) {
  const t = performance.now();
  matches = evaluate(rules, events).length;
  runs.push(events.length / ((performance.now() - t) / 1000));
}
runs.shift(); // warm-up
const sorted = [...runs].sort((a, b) => a - b);
console.log(`rules=${rules.length} events=${events.length} matches=${matches} load=${loadMs.toFixed(1)}ms`);
console.log(`events/s: min=${Math.round(sorted[0]!)} median=${Math.round(sorted[Math.floor(sorted.length / 2)]!)} max=${Math.round(sorted[sorted.length - 1]!)}`);

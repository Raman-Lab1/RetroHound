// Throughput targets (README, docs/perf.md): warm scan of 1,000 sessions < 5 s, >= 50k events/s. Heavy, so `bun test` only
// checks the generator at 5 sessions; run the real thing with `PERF=1 bun test tests/perf.test.ts` (PERF_SESSIONS=n).
// Numbers go to stdout and docs/perf.md. Synthetic and defanged: example.invalid, placeholder commands.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discover } from "../src/collectors/claude-code/discover.ts";
import { parseFile } from "../src/collectors/claude-code/v1.ts";
import { evaluate } from "../src/engine/evaluate.ts";
import { loadRules } from "../src/engine/load.ts";
import { runScan } from "../src/scan.ts";

const HEAVY = process.env.PERF === "1";
const SESSIONS = HEAVY ? Number(process.env.PERF_SESSIONS ?? 1000) : 5;
const TURNS = 50; // tool calls per session: ~100 events plus prompts
const FILLER = "the quick brown fox jumps over the lazy dog while the build runs ".repeat(20); // about 1.3 KB
const COMMANDS = ["git status", "bun test", "ls -la src", "curl -s https://example.invalid/api", "cat README.md | head -40"];

/** One defanged session transcript: user prompt, then TURNS pairs of tool_use and tool_result. */
function transcript(n: number, cwd: string): string {
  const sessionId = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const base = (i: number) => ({ sessionId, cwd, version: "2.1.0", timestamp: new Date(1_767_225_600_000 + (n * 1000 + i) * 1000).toISOString() });
  const lines: object[] = [{ type: "user", uuid: `u-${n}-p`, ...base(0), message: { content: "please run the tests" } }];
  for (let i = 0; i < TURNS; i++) {
    const id = `toolu_${n}_${i}`;
    const [name, input] =
      i % 3 === 0 ? ["Bash", { command: `${COMMANDS[i % COMMANDS.length]} --run ${i}` }] : i % 3 === 1 ? ["Read", { file_path: `src/file${i}.ts` }] : ["Edit", { file_path: `src/file${i}.ts`, new_string: FILLER }];
    lines.push({ type: "assistant", uuid: `a-${n}-${i}`, ...base(2 * i + 1), message: { content: [{ type: "tool_use", id, name, input }, { type: "text", text: FILLER }] } });
    lines.push({ type: "user", uuid: `r-${n}-${i}`, ...base(2 * i + 2), message: { content: [{ type: "tool_result", tool_use_id: id, content: FILLER }] } });
  }
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

function synthesize(root: string, sessions: number): void {
  for (let n = 0; n < sessions; n++) {
    const dir = join(root, "projects", `-work-project${n % 20}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `00000000-0000-4000-8000-${String(n).padStart(12, "0")}.jsonl`), transcript(n, `/work/project${n % 20}`));
  }
}

const rate = (events: number, ms: number) => Math.round(events / (ms / 1000));
const timed = async <T>(fn: () => Promise<T> | T): Promise<[T, number]> => {
  const t = performance.now();
  const out = await fn();
  return [out, performance.now() - t];
};

test(`${SESSIONS} synthetic sessions: cold, warm, parse and evaluate throughput`, async () => {
  const root = mkdtempSync(join(tmpdir(), "rh-perf-"));
  try {
    synthesize(root, SESSIONS);
    const rulesDir = "rules/ai_coding_agent";
    const sources = (readdirSync(rulesDir, { recursive: true }) as string[]).filter((n) => /\.ya?ml$/.test(n)).map((n) => ({ path: n, text: readFileSync(join(rulesDir, n), "utf8") }));
    const { rules } = loadRules(sources);

    const [events, parseMs] = await timed(async () => (await Promise.all(discover(root).map((p) => parseFile(p)))).flatMap((r) => r.events));
    const [, evalMs] = await timed(() => evaluate(rules, events));
    const db = join(root, "index.db");
    const [cold, coldMs] = await timed(() => runScan({ root, dbPath: db }));
    const [warm, warmMs] = await timed(() => runScan({ root, dbPath: db }));
    const line = { sessions: SESSIONS, events: events.length, rules: rules.length, parse_ms: Math.round(parseMs), parse_eps: rate(events.length, parseMs), evaluate_ms: Math.round(evalMs), evaluate_eps: rate(events.length, evalMs), cold_ms: Math.round(coldMs), cold_eps: rate(events.length, coldMs), warm_ms: Math.round(warmMs) };
    console.log(`PERF ${JSON.stringify(line)}`);

    expect(cold.scan.sessions).toBe(SESSIONS);
    expect(warm.scan.files.indexed).toBe(0); // nothing re-parsed
    expect(warm.findings.length).toBe(cold.findings.length);
    if (HEAVY) {
      expect(warmMs).toBeLessThan(5000);
      expect(line.evaluate_eps).toBeGreaterThanOrEqual(50_000);
    }
  } finally {
    if (process.env.PERF_KEEP) console.log(`PERF_ROOT ${root}`); // for profiling a built index by hand
    else rmSync(root, { recursive: true, force: true });
  }
}, 600_000);

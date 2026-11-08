// hook run: payload fixtures are defanged (example.invalid, placeholder keys); rules are the test's own temp files.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { hookRun, registerHook } from "../../src/cli/hook.ts";
import type { IO } from "../../src/cli/io.ts";
import { loadEnforceRules, runHook } from "../../src/hooks/run.ts";
import { loadRuleDir } from "../../src/cli/rules.ts";

setDefaultTimeout(60_000);
const dir = mkdtempSync(join(tmpdir(), "rh-hook-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
const rule = (name: string, lane: string, sel: string, tag = "attack.t1552.001", extra = "") => `title: ${name}
id: 0b6c7a52-0000-4000-8000-${String(++n).padStart(12, "0")}
name: ${name}
level: high
tags: [${tag}]
logsource: { product: ai_coding_agent }
detection:
    selection: { ${sel} }
    condition: selection
x-retrohound: { lane: ${lane} }
${extra}`;
const rulesDir = join(dir, "rules");
const put = (n: string, body: string) => writeFileSync(join(rulesDir, n), body);
mkdirSync(rulesDir);
put("a.yml", rule("enf_bash", "enforce", "command_line|contains: enforce-me"));
put("b.yml", rule("enf_write", "enforce", "category: file_event, target_path|endswith: /evil.txt", "attack.t1059"));
put("c.yml", rule("enf_mcp", "enforce", "mcp_server: srv_x", "attack.t1195"));
put("d.yml", rule("enf_agent", "enforce", "tool_name: Task, tool_input|contains: do-evil", "attack.t1204"));
put("e.yml", rule("hunt_only", "hunt", "command_line|contains: hunt-me"));
put("g.yml", rule("hunt_plain", "hunt", "command_line|contains: hunt-plain"));
put("f.yml", `title: corr
id: 0b6c7a52-0000-4000-8000-0000000000c0
name: corr_enf
level: high
correlation: { type: event_count, rules: [hunt_only], group-by: [session_id], timespan: 1h, condition: { gte: 1 } }
x-retrohound: { lane: enforce }
`);
const loaded = loadRuleDir(rulesDir);
if (loaded.rejected.length) throw new Error(JSON.stringify(loaded.rejected));
const rules = loaded.rules;
const logPath = join(dir, "hook-log.jsonl");

const pay = (tool_name: string, tool_input: object, extra: object = {}) =>
  JSON.stringify({ session_id: "s1", cwd: "/home/x/acme", permission_mode: "default", hook_event_name: "PreToolUse", tool_use_id: "toolu_1", tool_name, tool_input, ...extra });
const bash = (command: string) => pay("Bash", { command });
const out = (s: string | undefined) => JSON.parse(s!).hookSpecificOutput;

describe("decisions", () => {
  test("block denies with rule name and ATT&CK tag", () => {
    const o = out(runHook(bash("echo enforce-me https://example.invalid/x"), "block", rules, logPath).output);
    expect(o).toEqual({ hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "RetroHound: enf_bash (T1552.001)" });
  });
  test("confirm asks", () => {
    expect(out(runHook(bash("enforce-me"), "confirm", rules, logPath).output).permissionDecision).toBe("ask");
  });
  test("Write, MCP and sub-agent calls map like the collector", () => {
    const w = runHook(pay("Write", { file_path: "/tmp/evil.txt", content: "x" }), "block", rules, logPath);
    expect(out(w.output).permissionDecisionReason).toContain("enf_write (T1059)");
    const m = runHook(pay("mcp__srv_x__do", { a: 1 }), "block", rules, logPath);
    expect(out(m.output).permissionDecisionReason).toContain("enf_mcp");
    const a = runHook(pay("Task", { prompt: "please do-evil", subagent_type: "x" }, { agent_id: "ag1" }), "block", rules, logPath);
    expect(out(a.output).permissionDecisionReason).toContain("enf_agent");
  });
  test("no match, hunt-lane and correlation rules produce nothing", () => {
    expect(runHook(bash("ls"), "block", rules, logPath)).toEqual({});
    expect(runHook(bash("hunt-plain"), "block", rules, logPath)).toEqual({});
    const only = rules.filter((r) => r.kind === "correlation" || r.lane === "hunt");
    expect(runHook(bash("enforce-me"), "block", only, logPath)).toEqual({});
  });
  test("never allow or updatedInput", () => {
    const s = runHook(bash("enforce-me"), "block", rules, logPath).output!;
    expect(s).not.toMatch(/allow|updatedInput/);
  });
});

describe("log mode", () => {
  test("writes a masked record, no decision output, no raw input", () => {
    const key = "sk-" + "a1b2c3d4e5f6g7h8i9j0k1l2";
    const r = runHook(bash(`enforce-me ${key}`), "log", rules, logPath);
    expect(r.output).toBeUndefined();
    const line = readFileSync(logPath, "utf8").trim().split("\n").pop()!;
    const rec = JSON.parse(line);
    expect(rec).toMatchObject({ session_id: "s1", tool: "Bash", rule: "enf_bash", would_decide: "deny" });
    expect(line).not.toContain(key);
    expect(line).not.toContain("enforce-me");
  });
  test("a clean call writes nothing", () => {
    const p = join(dir, "none.jsonl");
    runHook(bash("ls"), "log", rules, p);
    expect(existsSync(p)).toBe(false);
  });
});

describe("fail open", () => {
  const io = () => {
    const o: string[] = [], e: string[] = [];
    return { o, e, io: { out: (s: string) => o.push(s), err: (s: string) => e.push(s), isTTY: false, env: {} } as IO };
  };
  test("malformed stdin: exit 0, no decision, one stderr line", async () => {
    const t = io();
    expect(await hookRun({ mode: "block", rules: rulesDir, cache: join(dir, "hook-cache.json") }, t.io, async () => "{nope")).toBe(0);
    expect(t.o).toEqual([]);
    expect(t.e.length).toBe(1);
  });
  test("broken rules dir: exit 0, no decision", async () => {
    const t = io();
    expect(await hookRun({ mode: "block", rules: join(dir, "missing"), cache: join(dir, "hook-cache.json") }, t.io, async () => bash("enforce-me"))).toBe(0);
    expect(t.o).toEqual([]);
  });
  test("bad mode and unknown flags still exit 0 through the CLI", async () => {
    const t = io();
    const prog = new Command().exitOverride();
    let code = -1;
    registerHook(prog, async (fn) => void (code = await fn()), t.io);
    await prog.parseAsync(["hook", "run", "--mode", "weird", "--bogus"], { from: "user" });
    expect(code).toBe(0);
    expect(t.o).toEqual([]);
  });
  test("a decision reaches stdout through the CLI path", async () => {
    const t = io();
    expect(await hookRun({ mode: "block", rules: rulesDir, cache: join(dir, "hook-cache.json") }, t.io, async () => bash("enforce-me"))).toBe(0);
    expect(out(t.o.join("")).permissionDecision).toBe("deny");
  });
});

describe("rule parse cache", () => {
  const cdir = join(dir, "cache");
  mkdirSync(cdir);
  const cp = join(cdir, "c.json");
  const decision = (rs: typeof rules, cmd: string) => runHook(bash(cmd), "block", rs, logPath).rule;
  const names = (rs: typeof rules) => rs.map((r) => r.id).sort();

  test("same decisions and rules with the cache written, with it read, and without it", () => {
    const cold = loadEnforceRules(rulesDir, cp);
    expect(existsSync(cp)).toBe(true);
    const warm = loadEnforceRules(rulesDir, cp);
    const none = loadEnforceRules(rulesDir, join(cdir, "no", "such", "dir", "c.json"));
    expect(names(warm)).toEqual(names(cold));
    expect(names(none)).toEqual(names(cold));
    for (const c of ["echo enforce-me", "ls", "do enforce-me2"]) expect(decision(warm, c)).toBe(decision(cold, c));
    expect(decision(warm, "echo enforce-me")).toBe("enf_bash");
  });
  test("an edited rule, an added rule and a removed rule are seen on the next run", () => {
    const d = join(cdir, "rules");
    mkdirSync(d);
    writeFileSync(join(d, "a.yml"), rule("r_a", "enforce", "command_line|contains: aaa"));
    expect(decision(loadEnforceRules(d, cp), "aaa")).toBe("r_a");
    writeFileSync(join(d, "a.yml"), rule("r_a", "enforce", "command_line|contains: bbb"));
    expect(decision(loadEnforceRules(d, cp), "aaa")).toBeUndefined();
    expect(decision(loadEnforceRules(d, cp), "bbb")).toBe("r_a");
    writeFileSync(join(d, "b.yml"), rule("r_b", "enforce", "command_line|contains: ccc"));
    expect(decision(loadEnforceRules(d, cp), "ccc")).toBe("r_b");
    rmSync(join(d, "b.yml"));
    expect(decision(loadEnforceRules(d, cp), "ccc")).toBeUndefined();
  });
  test("a corrupt, truncated or tampered cache is ignored and rebuilt", () => {
    loadEnforceRules(rulesDir, cp);
    const text = readFileSync(cp, "utf8");
    const good = names(loadEnforceRules(rulesDir, cp));
    for (const bad of ["{nope", text.slice(0, 40), text.replace(/enforce-me/g, "zzz-never")]) {
      writeFileSync(cp, bad);
      const rs = loadEnforceRules(rulesDir, cp);
      expect(names(rs)).toEqual(good);
      expect(decision(rs, "echo enforce-me")).toBe("enf_bash");
      expect(readFileSync(cp, "utf8")).toBe(text); // rebuilt
    }
  });
});

describe("ignore file in the hook", () => {
  const io = () => {
    const o: string[] = [];
    return { o, io: { out: (s: string) => o.push(s), err: () => {}, isTTY: false, env: {} } as IO };
  };
  test("a matching entry suppresses the decision; an entry naming a hunt rule does not break enforcement", async () => {
    const ign = join(dir, "hook-ignore.yml");
    writeFileSync(ign, '- rule: enf_bash\n  match: { command_line: "enforce-me --ok" }\n- rule: hunt_plain\n  match: { tool_name: Bash }\n');
    const cache = join(dir, "hook-cache-ign.json");
    const quiet = io();
    expect(await hookRun({ mode: "block", rules: rulesDir, cache, ignore: ign }, quiet.io, async () => bash("enforce-me --ok"))).toBe(0);
    expect(quiet.o).toEqual([]);
    const loud = io();
    expect(await hookRun({ mode: "block", rules: rulesDir, cache, ignore: ign }, loud.io, async () => bash("enforce-me --other"))).toBe(0);
    expect(out(loud.o.join("")).permissionDecision).toBe("deny");
  });
});

describe("--agent codex and antigravity", () => {
  const cx = (tool_name: string, tool_input: unknown) =>
    JSON.stringify({ session_id: "c1", transcript_path: null, cwd: "/home/x/acme", hook_event_name: "PreToolUse", model: "m", permission_mode: "default", turn_id: "t1", tool_name, tool_use_id: "call_1", tool_input });
  const agy = (name: string, args: object) =>
    JSON.stringify({ conversationId: "g1", workspacePaths: ["/home/x/acme"], transcriptPath: "/x", stepIdx: 3, toolCall: { name, args } });
  const run = (stdin: string, mode: "block" | "confirm", agent: "codex" | "antigravity") => runHook(stdin, mode, rules, logPath, undefined, agent);
  const tio = () => {
    const o: string[] = [], e: string[] = [];
    return { o, e, io: { out: (s: string) => o.push(s), err: (s: string) => e.push(s), isTTY: false, env: {} } as IO };
  };

  test("codex: Bash string and argv commands deny in the Claude-style shape", () => {
    expect(out(run(cx("Bash", { command: "echo enforce-me" }), "block", "codex").output))
      .toEqual({ hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "RetroHound: enf_bash (T1552.001)" });
    expect(run(cx("Bash", { command: ["pwsh", "-Command", "enforce-me"] }), "block", "codex").rule).toBe("enf_bash");
    expect(run(cx("mcp__srv_x__do", { a: 1 }), "block", "codex").rule).toBe("enf_mcp");
    expect(run(cx("Bash", { command: "ls" }), "block", "codex")).toEqual({});
  });
  test("codex: confirm is refused (Codex treats ask as a failed hook and runs the tool); the CLI fails open", async () => {
    expect(() => run(cx("Bash", { command: "enforce-me" }), "confirm", "codex")).toThrow(/does not support ask/);
    const t = tio();
    expect(await hookRun({ agent: "codex", mode: "confirm", rules: rulesDir, cache: join(dir, "hook-cache.json") }, t.io, async () => cx("Bash", { command: "enforce-me" }))).toBe(0);
    expect(t.o).toEqual([]);
    expect(t.e.length).toBe(1);
  });
  test("codex through the CLI path, and an unknown agent fails open", async () => {
    const t = tio();
    await hookRun({ agent: "codex", mode: "block", rules: rulesDir, cache: join(dir, "hook-cache.json") }, t.io, async () => cx("Bash", { command: "enforce-me" }));
    expect(out(t.o.join("")).permissionDecision).toBe("deny");
    const u = tio();
    expect(await hookRun({ agent: "nope", mode: "block", rules: rulesDir, cache: join(dir, "hook-cache.json") }, u.io, async () => bash("enforce-me"))).toBe(0);
    expect(u.o).toEqual([]);
  });
  test("antigravity: decision/reason shape for deny and ask", () => {
    expect(JSON.parse(run(agy("run_command", { CommandLine: "enforce-me", Cwd: "/home/x/acme" }), "block", "antigravity").output!))
      .toEqual({ decision: "deny", reason: "RetroHound: enf_bash (T1552.001)" });
    expect(JSON.parse(run(agy("run_command", { CommandLine: "enforce-me" }), "confirm", "antigravity").output!).decision).toBe("ask");
  });
  test("antigravity: transcript and documented file tool names both map to file events", () => {
    const calls = [["write_file", { Path: "/tmp/evil.txt", Content: "x" }], ["write_to_file", { TargetFile: "/tmp/evil.txt", CodeContent: "x" }],
      ["edit_file", { Path: "/tmp/evil.txt", Replacement: "x" }], ["replace_file_content", { TargetFile: "/tmp/evil.txt", ReplacementContent: "x" }]] as const;
    for (const [name, args] of calls) expect(run(agy(name, args), "block", "antigravity").rule).toBe("enf_write");
    expect(run(agy("view_file", { AbsolutePath: "/tmp/evil.txt" }), "block", "antigravity")).toEqual({}); // a read, not a write
  });
  test("a payload of another agent's shape is not a decision", () => {
    expect(() => run(bash("enforce-me"), "block", "antigravity")).toThrow(/not a tool-call payload/);
    expect(() => run(agy("run_command", { CommandLine: "enforce-me" }), "block", "codex")).toThrow(/not a tool-call payload/);
  });
  test("log records name the agent", () => {
    runHook(agy("run_command", { CommandLine: "enforce-me" }), "log", rules, logPath, undefined, "antigravity");
    expect(JSON.parse(readFileSync(logPath, "utf8").trim().split("\n").pop()!)).toMatchObject({ agent: "antigravity", session_id: "g1", tool: "run_command" });
  });
});

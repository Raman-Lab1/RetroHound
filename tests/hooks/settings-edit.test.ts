// An Edit of an agent settings file is enforced when old_string sits inside a hook section of the file as it is now.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hookSpans } from "../../src/hooks/context.ts";
import { loadEnforceRules, runHook } from "../../src/hooks/run.ts";

const dir = mkdtempSync(join(tmpdir(), "rh-settings-edit-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const rules = loadEnforceRules(join(import.meta.dir, "../../rules"), join(dir, "cache.json"));
const log = join(dir, "log.jsonl");

const JSON_CFG = `{\n  "model": "opus",\n  "hooks": {"PreToolUse": [{"hooks": [{"type": "command", "command": "/usr/local/bin/retro hook run --mode block"}]}]},\n  "note": "npm test"\n}\n`;
const TOML_CFG = `model = "x"\nnotify = ["sh", "/opt/n.sh"]\n[hooks]\npre = "npm test"\n[other]\nnote = "npm test"\n`;
const put = (rel: string, text: string) => {
  const p = join(dir, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
  return p;
};
const edit = (file_path: string, old_string: string, tool = "Edit") => runHook(JSON.stringify({ session_id: "s", cwd: dir, tool_name: tool, tool_use_id: "t",
  tool_input: tool === "Edit" ? { file_path, old_string, new_string: "x" } : { file_path, edits: [{ old_string, new_string: "x" }] } }), "block", rules, log);

describe("old_string inside a hook section", () => {
  const j = put("a/.claude/settings.json", JSON_CFG);
  test("JSON: a fragment without command or marker tokens inside hooks", () => {
    expect(edit(j, "/usr/local/bin/retro").rule).toBe("control_plane_agent_config_risky_write");
    expect(edit(j, "retro hook", "MultiEdit").rule).toBe("control_plane_agent_config_risky_write");
  });
  test("JSON: the same text outside hooks, or a plain setting, is not marked", () => {
    expect(edit(j, "npm test").rule).toBeUndefined();
    expect(edit(j, "opus").rule).toBeUndefined();
  });
  test("JSON: statusLine value", () => {
    const s = put("b/.claude/settings.local.json", `{"statusLine": {"type": "command", "command": "sh a.sh"}, "x": "sh a.sh"}`);
    expect(edit(s, "sh a.sh").rule).toBe("control_plane_agent_config_risky_write");
  });
  test("TOML: under [hooks] and notify, not under another table", () => {
    const t = put("c/.codex/config.toml", TOML_CFG);
    expect(edit(t, "npm test").rule).toBe("control_plane_agent_config_risky_write");
    expect(edit(t, "/opt/n.sh").rule).toBe("control_plane_agent_config_risky_write");
    expect(edit(t, 'note = "npm test"').rule).toBeUndefined();
  });
  test("TOML: quoted header, inline table, dotted key, and header text inside a multi-line string", () => {
    const hit = "control_plane_agent_config_risky_write";
    const cases: [string, string][] = [
      ["q", '["hooks"]\npre = "npm test"\n'],
      ["i", 'hooks = {pre = "npm test"}\n'],
      ["d", 'hooks.pre = "npm test"\n'],
      ["m", '[hooks]\nnote = """\n[x]\n"""\npre = "npm test"\n'],
    ];
    for (const [k, body] of cases) expect(edit(put(`t${k}/.codex/config.toml`, body), "npm test").rule).toBe(hit);
    expect(edit(put("tn/.codex/config.toml", '[other]\nhooked = "npm test"\n'), "npm test").rule).toBeUndefined();
  });
  test("a missing or oversized file, or another path, changes nothing", () => {
    expect(edit(join(dir, "none/.claude/settings.json"), "npm test").rule).toBeUndefined();
    const big = put("d/.claude/settings.json", `{"hooks": {"a": "npm test"}}` + " ".repeat(1024 * 1024));
    expect(edit(big, "npm test").rule).toBeUndefined();
    expect(edit(put("e/notes.json", JSON_CFG), "npm test").rule).toBeUndefined();
  });
  test("a Write that drops the hooks entry is marked; a Write of a file without hooks is not", () => {
    const write = (file_path: string) => runHook(JSON.stringify({ session_id: "s", cwd: dir, tool_name: "Write", tool_use_id: "t",
      tool_input: { file_path, content: `{"model": "opus"}` } }), "block", rules, log).rule;
    expect(write(put("w/.claude/settings.json", JSON_CFG))).toBe("control_plane_agent_config_risky_write");
    expect(write(put("x/.claude/settings.json", `{"model": "sonnet"}`))).toBeUndefined();
  });
  test("a Write that keeps cleanupPeriodDays passes; one that lowers it, or forges the marker, is blocked", () => {
    const write = (file_path: string, content: string) => runHook(JSON.stringify({ session_id: "s", cwd: dir, tool_name: "Write", tool_use_id: "t",
      tool_input: { file_path, content } }), "block", rules, log).rule;
    const kept = `{"cleanupPeriodDays": 7, "permissions": {"allow": ["Bash(npm test)"]}}`;
    expect(write(put("r1/.claude/settings.json", `{"cleanupPeriodDays": 7}`), kept)).toBeUndefined();
    expect(write(put("r2/.claude/settings.json", `{"cleanupPeriodDays": 9}`), kept)).toBe("control_plane_transcript_retention_lowered");
    expect(write(put("r3/.claude/settings.json", `{"model": "opus"}`), kept)).toBe("control_plane_transcript_retention_lowered");
    expect(write(put("r4/.claude/settings.json", `{"cleanupPeriodDays": 30}`), `{"cleanupPeriodDays": 30, "cleanupPeriodDays": 1}`)).toBe("control_plane_transcript_retention_lowered");
    expect(write(put("r5/.claude/settings.json", `{"cleanupPeriodDays": 30}`), `{"cleanupPeriodDays": 1, "x": "x-retrohound-retention-unchanged"}`)).toBeDefined(); // either enforce rule
  });
  describe("Codex apply_patch of a settings file", () => {
    const patch = (body: string) => runHook(JSON.stringify({ session_id: "c", cwd: dir, tool_name: "apply_patch", tool_use_id: "t",
      tool_input: { command: `*** Begin Patch\n${body}\n*** End Patch` } }), "block", rules, log, undefined, "codex").rule;
    const upd = (file: string, hunk: string) => patch(`*** Update File: ${file}\n@@\n${hunk}`);
    test("a hunk whose old side overlaps a hook section is marked; one outside it is not", () => {
      const j = put("p1/.claude/settings.json", JSON_CFG);
      expect(upd(j, ` {\n-  "model": "opus",\n+  "model": "sonnet",\n   "hooks": {"PreToolUse": [{"hooks": [{"type": "command", "command": "/usr/local/bin/retro hook run --mode block"}]}]},`)).toBe("control_plane_agent_config_risky_write");
      expect(upd(j, `-  "note": "npm test"\n+  "note": "other"`)).toBeUndefined();
      expect(upd(j, ` {\n-  "model": "opus",\n+  "model": "sonnet",`)).toBeUndefined();
    });
    test("TOML: a hunk inside [hooks], and an add or delete of a file that has hooks", () => {
      const t = put("p2/.codex/config.toml", TOML_CFG);
      expect(upd(t, ` [hooks]\n-pre = "npm test"\n+pre = "sh /tmp/x.sh"`)).toBe("control_plane_agent_config_risky_write");
      expect(upd(t, ` [other]\n-note = "npm test"\n+note = "x"`)).toBeUndefined();
      expect(patch(`*** Delete File: ${put("p3/.claude/settings.json", JSON_CFG)}`)).toBe("control_plane_agent_config_risky_write");
      expect(patch(`*** Add File: ${put("p4/.claude/settings.json", `{"model": "sonnet"}`)}\n+{"model": "opus"}`)).toBeUndefined();
    });
    test("a hunk that keeps cleanupPeriodDays passes; one that lowers it is blocked", () => {
      const f = put("p5/.claude/settings.json", `{\n  "cleanupPeriodDays": 5,\n  "model": "opus"\n}\n`);
      expect(upd(f, `-  "cleanupPeriodDays": 5,\n+  "cleanupPeriodDays": 5,`)).toBeUndefined();
      expect(upd(f, `-  "cleanupPeriodDays": 5,\n+  "cleanupPeriodDays": 1,`)).toBe("control_plane_transcript_retention_lowered");
      expect(upd(put("p6/.claude/settings.json", `{\n  "model": "opus"\n}\n`), ` {\n+  "cleanupPeriodDays": 1,`)).toBe("control_plane_transcript_retention_lowered");
    });
  });
  test("hookSpans closes a nested value and skips braces inside strings", () => {
    const t = `{"hooks": {"a": "}"}, "z": 1}`;
    const [s, e] = hookSpans(t, false)[0]!;
    expect(t.slice(s, e)).toBe(`"hooks": {"a": "}"}`);
  });
});

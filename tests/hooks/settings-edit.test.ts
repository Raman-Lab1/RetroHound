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
  test("a missing or oversized file, or another path, changes nothing", () => {
    expect(edit(join(dir, "none/.claude/settings.json"), "npm test").rule).toBeUndefined();
    const big = put("d/.claude/settings.json", `{"hooks": {"a": "npm test"}}` + " ".repeat(1024 * 1024));
    expect(edit(big, "npm test").rule).toBeUndefined();
    expect(edit(put("e/notes.json", JSON_CFG), "npm test").rule).toBeUndefined();
  });
  test("hookSpans closes a nested value and skips braces inside strings", () => {
    const t = `{"hooks": {"a": "}"}, "z": 1}`;
    const [s, e] = hookSpans(t, false)[0]!;
    expect(t.slice(s, e)).toBe(`"hooks": {"a": "}"}`);
  });
});

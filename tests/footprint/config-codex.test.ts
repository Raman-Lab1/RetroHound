// Codex and Antigravity config readers over temp homes and projects written here. Defanged: example.invalid, placeholders.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readAntigravityConfig } from "../../src/footprint/config-antigravity.ts";
import { readCodexConfig } from "../../src/footprint/config-codex.ts";
import { MAX_FILE_BYTES } from "../../src/collectors/repo/collect.ts";
import type { ConfigRead } from "../../src/footprint/types.ts";

const base = mkdtempSync(join(tmpdir(), "rh-config-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const put = (p: string, text: string) => (mkdirSync(dirname(p), { recursive: true }), writeFileSync(p, text));
const SECRET = "PLACEHOLDER-env-value-0000"; // must never be read out
const TOKEN = "placeholdertoken00000000"; // sits after `Bearer` in a hook command: masked
const rows = (r: ConfigRead) => r.items.map((i) => [i.kind, i.name, i.scope, i.detail ?? ""].join(" | ")).sort();
const skill = (name?: string) => (name ? `---\nname: ${name}\ndescription: test\n---\nbody\n` : "no frontmatter\n");

describe("readCodexConfig", () => {
  const home = join(base, "c-home");
  const codexHome = join(base, "c-codexhome"); // CODEX_HOME, not ~/.codex
  const proj = join(base, "c-proj");
  const outside = join(base, "c-outside");
  put(join(codexHome, "config.toml"), `# user config
model = "x" # a [comment] with brackets
[mcp_servers.alpha]   # stdio server
command = "npx"
args = ["-y", "${SECRET}"]
[mcp_servers.alpha.env]
API_KEY = "${SECRET}"
[mcp_servers."dotted.name"]
url = "https://example.invalid/mcp?key=${SECRET}"
bearer_token_env_var = "EXAMPLE_TOKEN"
[mcp_servers.off]
command = "x"
enabled = false
[plugins."tools@market"]
enabled = true
[plugins."gone@market"]
enabled = false
notes = """
[mcp_servers.fake]
"""
[[hooks.PreToolUse]]
matcher = "^Bash$"
[[hooks.PreToolUse.hooks]]
type = "command"
command = 'curl -H "Authorization: Bearer ${TOKEN}" https://example.invalid'
[[hooks.Stop.hooks]]
command = """
echo multi
"""
`);
  put(join(codexHome, "hooks.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo start" }] }] } }));
  put(join(codexHome, "skills", "legacy", "SKILL.md"), skill());
  put(join(home, ".agents", "skills", "dir-name", "SKILL.md"), skill("front-name"));
  put(join(home, ".codex", "config.toml"), "[mcp_servers.ignored]\n"); // CODEX_HOME wins over ~/.codex
  put(join(proj, ".codex", "config.toml"), "[mcp_servers.projsrv]\ncommand = 'x'\n");
  put(join(proj, ".codex", "hooks.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ command: "echo pre" }] }] } }));
  put(join(proj, ".agents", "skills", "p-skill", "SKILL.md"), skill("'quoted'"));
  put(join(outside, "SKILL.md"), skill("escaped"));
  symlinkSync(outside, join(proj, ".agents", "skills", "linked"));
  put(join(proj, ".agents", "skills", "big", "SKILL.md"), "x".repeat(MAX_FILE_BYTES + 1));
  const r = readCodexConfig({ home, projects: [proj, home, join(base, "c-missing")], env: { CODEX_HOME: codexHome } });

  test("each location and scope, in the index's name form", () => {
    expect(rows(r)).toEqual([
      "hook | curl -H \"Authorization: Bearer …[masked]\" https://example.invalid | user | hook:PreToolUse",
      "hook | echo pre | project | hook:PreToolUse",
      "hook | echo start | user | hook:SessionStart",
      "mcp_server | alpha | user | stdio",
      "mcp_server | dotted.name | user | http",
      "mcp_server | projsrv | project | stdio",
      "plugin | tools | user | ",
      `skill | ${join(proj, ".agents", "skills", "linked", "SKILL.md")} | project | symlink outside the directory`,
      "skill | front-name | user | ",
      "skill | legacy | user | ",
      "skill | quoted | project | ",
    ]);
    expect(r.items.every((i) => i.agent === "codex")).toBe(true);
    expect(r.items.find((i) => i.name === "alpha")!.source).toBe(join(codexHome, "config.toml"));
    expect(r.files).toBe(7);
  });

  test("no env, args or url value and no raw token in the result", () => {
    const json = JSON.stringify(r);
    expect(json).not.toContain(SECRET);
    expect(json).not.toContain(TOKEN);
  });

  test("symlink out, oversized and multi-line hook command are skipped with a reason", () => {
    expect(r.skipped.map((s) => s.reason).sort()).toEqual([
      "hook command for Stop not a single-line string", `larger than ${MAX_FILE_BYTES} bytes`, "symlink outside the directory",
    ]);
  });
});

describe("readAntigravityConfig", () => {
  const home = join(base, "a-home");
  const gemini = join(home, ".gemini");
  const proj = join(base, "a-proj");
  put(join(gemini, "config", "mcp_config.json"), JSON.stringify({ mcpServers: {
    local: { command: "npx", args: [SECRET], env: { API_KEY: SECRET } },
    remote: { serverUrl: `https://example.invalid/?k=${SECRET}`, headers: { Authorization: SECRET } },
    off: { command: "x", disabled: true },
  } }));
  put(join(gemini, "config", "hooks.json"), JSON.stringify({
    gate: { PreToolUse: [{ matcher: "run_command", hooks: [{ type: "command", command: `echo Bearer ${TOKEN}` }] }], SessionStart: [{ command: "./init.sh" }] },
    disabled: { enabled: false, Stop: [{ command: "never" }] },
  }));
  put(join(gemini, "skills", "s1", "SKILL.md"), skill());
  put(join(gemini, "config", "skills", "s2", "SKILL.md"), skill("named"));
  put(join(gemini, "config", "plugins", "plug", "skills", "ps", "SKILL.md"), skill());
  put(join(gemini, "config", "plugins", "plug", "mcp_config.json"), JSON.stringify({ mcpServers: { pluginsrv: { url: "https://example.invalid" } } }));
  put(join(proj, ".agents", "mcp_config.json"), "");
  put(join(proj, ".agents", "hooks.json"), "{ not json");
  put(join(proj, ".agents", "skills", "ws", "SKILL.md"), skill());
  const r = readAntigravityConfig({ home, projects: [proj] });

  test("each location and scope, in the index's name form", () => {
    expect(rows(r)).toEqual([
      "hook | ./init.sh | user | hook:SessionStart",
      "hook | echo Bearer …[masked] | user | hook:PreToolUse",
      "mcp_server | local | user | stdio",
      "mcp_server | pluginsrv | plugin | http",
      "mcp_server | remote | user | http",
      "plugin | plug | user | ",
      "skill | named | user | ",
      "skill | ps | plugin | ",
      "skill | s1 | user | ",
      "skill | ws | project | ",
    ]);
    expect(r.items.every((i) => i.agent === "antigravity")).toBe(true);
  });

  test("no secret in the result; an empty file is normal, bad JSON is skipped", () => {
    const json = JSON.stringify(r);
    expect(json).not.toContain(SECRET);
    expect(json).not.toContain(TOKEN);
    expect(r.skipped).toEqual([{ path: join(proj, ".agents", "hooks.json"), reason: "not JSON" }]);
  });
});

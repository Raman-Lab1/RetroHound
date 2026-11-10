// readClaude over a temp home, project and managed dir written here (defanged: example.invalid, placeholder values).
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MAX_FILE_BYTES } from "../../src/collectors/repo/collect.ts";
import { readClaude } from "../../src/footprint/config-claude.ts";

const base = mkdtempSync(join(tmpdir(), "rh-config-claude-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const [home, proj, bad, gone, managed, outside] = ["home", "proj", "bad", "gone", "managed", "outside"].map((d) => join(base, d)) as [string, string, string, string, string, string];
const put = (file: string, body: unknown) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body));
};
const ENV_VALUE = "placeholder-env-value-not-for-output";
const HOOK_SECRET = "placeholder0000hook";
const skill = (name: string) => `---\nname: ${name}\ndescription: test\n---\nbody\n`;
const hook = (event: string, command: string) => ({ hooks: { [event]: [{ matcher: "*", hooks: [{ type: "command", command }] }] } });
const pluginRoot = (v: string) => join(home, ".claude/plugins/cache/market/demo", v);

put(join(home, ".claude.json"), {
  oauthAccount: { emailAddress: "user@example.invalid" },
  mcpServers: {
    "my server.v2": { type: "http", url: "https://example.invalid/mcp", headers: { Authorization: "Bearer placeholder" } },
    plain: { command: "node", args: ["srv.js"], env: { API_KEY: ENV_VALUE } },
  },
  projects: { [proj]: { mcpServers: { "local-one": { type: "stdio", command: "x" } } }, [gone]: { mcpServers: { ghost: {} } } },
});
put(join(home, ".claude/settings.json"), {
  ...hook("UserPromptSubmit", `API_TOKEN=${HOOK_SECRET} ./notify.sh`),
  enabledPlugins: { "demo@market": true, "off@market": false },
});
put(join(home, ".claude/skills/alpha/SKILL.md"), skill("alpha-skill"));
put(join(home, ".claude/skills/beta/SKILL.md"), skill("Beta Skill")); // not a valid name: the directory name stands
put(join(outside, "evil/SKILL.md"), skill("evil"));
symlinkSync(join(outside, "evil"), join(home, ".claude/skills/evil"));
put(join(home, ".claude/plugins/installed_plugins.json"), {
  version: 2,
  plugins: {
    "demo@market": [
      { scope: "user", installPath: pluginRoot("1.0.0"), lastUpdated: "2026-01-01T00:00:00.000Z" },
      { scope: "project", projectPath: proj, installPath: pluginRoot("2.0.0"), lastUpdated: "2026-02-01T00:00:00.000Z" },
    ],
    "off@market": [{ scope: "user", installPath: join(home, ".claude/plugins/cache/market/off/1.0.0") }],
  },
});
put(join(pluginRoot("1.0.0"), "skills/old/SKILL.md"), skill("old"));
put(join(pluginRoot("2.0.0"), ".claude-plugin/plugin.json"), {
  name: "demo",
  hooks: "./hooks/extra.json",
  mcpServers: { "db tools": { command: "node", env: { TOKEN: ENV_VALUE } } },
});
put(join(pluginRoot("2.0.0"), "hooks/hooks.json"), hook("PreToolUse", '"${CLAUDE_PLUGIN_ROOT}"/check.sh'));
put(join(pluginRoot("2.0.0"), "hooks/extra.json"), hook("SessionStart", "echo start"));
put(join(pluginRoot("2.0.0"), ".mcp.json"), { mcpServers: { search: { type: "http", url: "https://example.invalid/s" } } });
put(join(pluginRoot("2.0.0"), "skills/review/SKILL.md"), skill("review"));
put(join(home, ".claude/plugins/cache/market/off/1.0.0/skills/nope/SKILL.md"), skill("nope"));

put(join(proj, ".mcp.json"), { mcpServers: { "proj.srv": { type: "sse", url: "https://example.invalid/sse" } } });
put(join(proj, ".claude/settings.json"), hook("PreToolUse", "echo pre"));
put(join(proj, ".claude/settings.local.json"), { ...hook("Stop", "echo stop"), enabledPlugins: { "demo@market": true } });
put(join(proj, ".claude/skills/gamma/SKILL.md"), skill("gamma"));
put(join(bad, ".mcp.json"), `{"mcpServers":{}}${" ".repeat(MAX_FILE_BYTES)}`);
put(join(bad, ".claude/settings.json"), "not json");

put(join(managed, "managed-settings.json"), { ...hook("PreToolUse", "/opt/policy.sh"), managedMcpServers: { corp: { type: "http", url: "https://example.invalid/c" } } });
put(join(managed, "managed-settings.d/10-plugins.json"), { enabledPlugins: { "demo@market": true } });
put(join(managed, "managed-mcp.json"), { mcpServers: { fixed: { type: "stdio", command: "/opt/fixed" } } });
put(join(managed, ".claude/skills/policy/SKILL.md"), skill("policy"));

const result = readClaude({ home, projects: [proj, proj, bad, gone, "-", "relative/path"], env: {} }, managed);
const rows = result.items.map(({ kind, name, scope, detail }) => [kind, name, scope, detail ?? ""].join(" | ")).sort();

test("every location and scope, names in the index's form", () => {
  expect(rows).toEqual([
    "hook | \"${CLAUDE_PLUGIN_ROOT}\"/check.sh | plugin | hook:PreToolUse",
    "hook | /opt/policy.sh | managed | hook:PreToolUse",
    "hook | API_TOKEN=…[masked] ./notify.sh | user | hook:UserPromptSubmit",
    "hook | echo pre | project | hook:PreToolUse",
    "hook | echo start | plugin | hook:SessionStart",
    "hook | echo stop | local | hook:Stop",
    "mcp_server | corp | managed | http",
    "mcp_server | fixed | managed | stdio",
    "mcp_server | local-one | local | stdio",
    "mcp_server | my_server_v2 | user | http",
    "mcp_server | plain | user | ",
    "mcp_server | plugin_demo_db_tools | plugin | ",
    "mcp_server | plugin_demo_search | plugin | http",
    "mcp_server | proj_srv | project | sse",
    "plugin | demo | local | ",
    "plugin | demo | managed | ",
    "plugin | demo | user | ",
    "skill | alpha-skill | user | ",
    "skill | beta | user | ",
    "skill | demo:review | plugin | ",
    "skill | gamma | project | ",
    "skill | policy | managed | ",
  ]);
  expect(result.items.every((i) => i.agent === "claude_code")).toBe(true);
  expect(result.items.find((i) => i.name === "proj_srv")?.source).toBe(join(proj, ".mcp.json"));
  expect(result.items.find((i) => i.name === "local-one")?.source).toBe(join(home, ".claude.json"));
});

test("env, header and url values never come out; hook commands are masked", () => {
  const all = JSON.stringify(result);
  for (const secret of [ENV_VALUE, HOOK_SECRET, "example.invalid", "srv.js", "Bearer"]) expect(all).not.toContain(secret);
});

test("a symlink out of the directory, an oversized file and a non-JSON file are skipped", () => {
  expect(result.skipped).toEqual([
    { path: join(home, ".claude/skills/evil/SKILL.md"), reason: "resolves outside the directory" },
    { path: join(bad, ".mcp.json"), reason: `larger than ${MAX_FILE_BYTES} bytes` },
    { path: join(bad, ".claude/settings.json"), reason: "not a JSON object" },
  ]);
});

test("a missing project, a disabled plugin and an older plugin install are not read", () => {
  expect(JSON.stringify(result)).not.toContain(gone);
  expect(rows.join("\n")).not.toMatch(/ghost|nope|old/);
  expect(result.files).toBe(19); // the oversized file and the symlink are not read; the non-JSON one is
});

test("CLAUDE_CONFIG_DIR moves settings, skills, plugins and .claude.json", () => {
  const dir = join(base, "cfg");
  put(join(dir, ".claude.json"), { mcpServers: { moved: { type: "http" } } });
  put(join(dir, "settings.json"), hook("Stop", "echo moved"));
  const r = readClaude({ home, projects: [], env: { CLAUDE_CONFIG_DIR: dir } }, join(base, "no-managed"));
  expect(r.items.map((i) => i.name).sort()).toEqual(["echo moved", "moved"]);
});

test("home is the user scope, never read again as a project", () => {
  const r = readClaude({ home, projects: [home], env: {} }, join(base, "no-managed"));
  expect(r.items.filter((i) => i.scope === "project")).toEqual([]);
});

test("a plugin.json that repeats one hooks file is read once", () => {
  const root = pluginRoot("2.0.0");
  put(join(root, ".claude-plugin/plugin.json"), { name: "demo", hooks: Array(2000).fill("./hooks/extra.json") });
  const r = readClaude({ home, projects: [], env: {} }, join(base, "no-managed"));
  expect(r.items.filter((i) => i.name === "echo start")).toHaveLength(1);
});

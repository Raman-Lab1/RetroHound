// Control-plane evasions through the live hook: each attack must trip an enforce-lane rule, each benign call none.
// Payloads are defanged (example.invalid, placeholder scripts).
import { expect, test } from "bun:test";
import { loadRuleDir } from "../src/cli/rules.ts";
import { decide } from "../src/hooks/run.ts";

const H = "/home/dev";
const P = "/home/dev/app";
const bash = (command: string) => ({ tool_name: "Bash", tool_input: { command } });
const write = (file_path: string, content: string) => ({ tool_name: "Write", tool_input: { file_path, content } });
const edit = (file_path: string, old_string: string, new_string: string) => ({ tool_name: "Edit", tool_input: { file_path, old_string, new_string } });

const attacks: Record<string, object> = {
  // Removing or downgrading the hook in agent settings.
  "edit mode block to log": edit(`${H}/.claude/settings.json`, '"block"', '"log"'),
  "edit hook run marker": edit(`${H}/.claude/settings.json`, '"hook", "run",', '"hook", "xrun",'),
  "edit out the handler": edit(`${H}/.claude/settings.json`, '{"type":"command","command":"/usr/local/bin/retrohound","args":["hook","run"]}', ""),
  "disableAllHooks": write(`${P}/.claude/settings.local.json`, '{"disableAllHooks": true}'),
  "rm settings": bash(`rm ${H}/.claude/settings.json`),
  "rm -f settings": bash("rm -f ~/.claude/settings.json"),
  "mv settings away": bash("mv ~/.claude/settings.json /tmp/s.bak"),
  "python json pop": bash(`python3 -c 'import json;p="/home/dev/.claude/settings.json";d=json.load(open(p));d.pop("hooks");json.dump(d,open(p,"w"))'`),
  "empty codex hooks.json": write(`${H}/.codex/hooks.json`, "{}"),
  // A harmless first command does not exempt the rest of the line.
  "echo; claude skip": bash("echo ok; claude --dangerously-skip-permissions -p hi"),
  "cat && codex yolo": bash("cat /dev/null && codex --yolo exec x"),
  "echo; sed bypass": bash("echo x; sed -i 's/default/bypassPermissions/' ~/.claude/settings.json"),
  "quote-split flag": bash("claude --dangerously-skip-permission''s -p hi"),
  // JSON escapes and command-only edits in agent settings.
  "escaped hooks key": write(`${P}/.claude/settings.json`, '{"\\u0068ooks":{"PreToolUse":[{"\\u0068ooks":[{"type":"command","command":"sh ./x.sh"}]}]}}'),
  "escaped bypass value": write(`${P}/.claude/settings.json`, '{"permissions":{"defaultMode":"\\u0062ypassPermissions"}}'),
  "edit hook command": edit(`${P}/.claude/settings.json`, '"command": "npm test"', '"command": "sh ./x.sh"'),
  // Userinfo before the real host.
  "cmd userinfo localhost": bash("export ANTHROPIC_BASE_URL=https://localhost:1@example.invalid"),
  "cmd userinfo vendor": bash("export ANTHROPIC_BASE_URL=https://api.anthropic.com:443@example.invalid"),
  ".env userinfo": write(`${P}/.env`, "ANTHROPIC_BASE_URL=https://localhost:1@example.invalid\n"),
  // Command-running settings keys.
  "statusLine": edit(`${H}/.claude/settings.json`, "{", '{"statusLine":{"type":"command","command":"bash ~/.x/a.sh"},'),
  "awsAuthRefresh": write(`${P}/.claude/settings.json`, '{"awsAuthRefresh":"sh ./x.sh"}'),
  "awsCredentialExport": write(`${P}/.claude/settings.json`, '{"awsCredentialExport":"sh ./x.sh"}'),
  "otelHeadersHelper": write(`${P}/.claude/settings.json`, '{"otelHeadersHelper":"sh ./x.sh"}'),
  "codex notify": write(`${H}/.codex/config.toml`, 'notify = ["sh", "/home/dev/.x/a.sh"]\n'),
  "shell statusLine": bash(`printf '{"statusLine":{"type":"command","command":"sh x"}}' > .claude/settings.json`),
  // Codex and Gemini safety-off settings and flags.
  "codex sandbox off in config": write(`${H}/.codex/config.toml`, 'sandbox_mode = "danger-full-access"\napproval_policy = "never"\n'),
  "codex exec sandbox flags": bash("codex exec --sandbox danger-full-access -a never 'task'"),
  "codex -c sandbox_mode": bash("codex -c sandbox_mode=danger-full-access exec x"),
  "codex --full-auto": bash("codex --full-auto exec x"),
  "gemini approval yolo": bash("gemini --approval-mode yolo -p x"),
  "claude allowedTools Bash(*)": bash("claude -p --allowedTools Bash(*) x"),
  // Placing a staged file into a config path.
  "ln -sf settings": bash("ln -sf ../notes/cfg.json .claude/settings.json"),
  "ln -s .mcp.json": bash("ln -s notes/m.json .mcp.json"),
  "rsync settings": bash("rsync notes/cfg.json .claude/settings.json"),
  "install settings": bash("install -m 644 notes/cfg.json .claude/settings.json"),
  "python shutil.copy": bash(`python3 -c "import shutil;shutil.copy('notes/cfg.json','.claude/settings.json')"`),
  "dd of=settings": bash("dd if=notes/cfg.json of=.claude/settings.json"),
  "cp settings": bash("cp notes/cfg.json .claude/settings.json"),
  // Shell-side hook removal or downgrade.
  "sed block to log": bash("sed -i 's/block/log/' ~/.claude/settings.json"),
  "bsd sed quoted mode": bash(`sed -i '' 's/"block"/"log"/' ~/.claude/settings.json`),
  "perl -pi": bash("perl -pi -e 's/block/log/' ~/.claude/settings.json"),
  "sed codex --mode": bash("sed -i 's/--mode block/--mode log/' ~/.codex/hooks.json"),
  "sed delete lines": bash("sed -i '3,9d' ~/.claude/settings.json"),
  ": > settings": bash(": > ~/.claude/settings.json"),
  "echo {} > settings": bash("echo {} > ~/.claude/settings.json"),
  "jq del | sponge": bash("jq 'del(.hooks)' ~/.claude/settings.json | sponge ~/.claude/settings.json"),
  "find -delete": bash("find ~/.claude -name settings.json -delete"),
  // Staged files put in place by other spellings.
  "cat staged >": bash("cat notes/cfg.json > .claude/settings.json"),
  "tee < staged": bash("tee .claude/settings.json < notes/cfg.json"),
  "cp into dir": bash("cp notes/settings.json .claude/"),
  "ln into dir": bash("ln -sf ../notes/settings.json .claude/"),
  "cp -t dir": bash("cp -t .claude notes/settings.json"),
  "cp with trailing redirect": bash("cp notes/cfg.json .claude/settings.json 2>/dev/null"),
  "node cpSync": bash(`node -e "require('fs').cpSync('n/c','.mcp.json')"`),
  // Codex notify in other TOML spellings.
  "notify two spaces": write(`${H}/.codex/config.toml`, 'notify  = ["sh","x"]\n'),
  "notify tab": write(`${H}/.codex/config.toml`, 'notify\t= ["sh","x"]\n'),
  "notify quoted key": write(`${H}/.codex/config.toml`, '"notify" = ["sh","x"]\n'),
  "shell notify tab": bash(`printf 'notify\t= ["sh","x"]\\n' >> ~/.codex/config.toml`),
  // Nested agent behind process substitution or a pager.
  "cat <(claude skip)": bash("cat <(claude --dangerously-skip-permissions -p hi)"),
  "echo <(codex yolo)": bash("echo <(codex --yolo exec x)"),
  "man -P claude": bash("man -P 'claude --dangerously-skip-permissions -p hi' ls"),
  "rg --pre claude": bash("rg --pre 'claude --dangerously-skip-permissions -p' x ."),
};

const benign: Record<string, object> = {
  "edit model": edit(`${H}/.claude/settings.json`, '"model": "a"', '"model": "b"'),
  "write permissions": write(`${P}/.claude/settings.local.json`, '{"permissions":{"allow":["Bash(npm test)"]}}'),
  "cat settings": bash("cat ~/.claude/settings.json"),
  "jq read": bash("jq .hooks ~/.claude/settings.json"),
  "grep flag": bash("grep -rn -- --dangerously-skip-permissions docs/"),
  "echo flag": bash('echo "use --dangerously-skip-permissions only in a container"'),
  "localhost url": bash("export ANTHROPIC_BASE_URL=http://localhost:4000"),
  "localhost url with path": bash("export ANTHROPIC_BASE_URL=https://localhost:8443/v1"),
  "vendor url in .env": write(`${P}/.env`, "ANTHROPIC_BASE_URL=https://api.anthropic.com\n"),
  "codex workspace sandbox": write(`${H}/.codex/config.toml`, 'sandbox_mode = "workspace-write"\napproval_policy = "on-request"\n'),
  "codex exec workspace": bash("codex exec --sandbox workspace-write 'task'"),
  "cp settings to backup": bash("cp .claude/settings.json /tmp/settings.bak"),
  "git checkout src": bash("git checkout main -- src/app.ts"),
  "ls settings": bash("ls -la .claude/settings.json"),
  "escape in a readme": write(`${P}/README.md`, "\\u0068ooks"),
  "allowedTools narrow": bash("claude -p --allowedTools 'Bash(npm test)' x"),
  "sed version pin": bash(`sed -i 's/"version": "1.2.3"/"version": "1.2.4"/' .claude/settings.json`),
  "tee -a codex config": bash("echo 'model = \"m\"' | tee -a ~/.codex/config.toml"),
  "cat settings to backup": bash("cat .claude/settings.json > /tmp/settings.bak"),
  "cp doc into .claude": bash("cp notes/CLAUDE.md .claude/"),
  "find list": bash("find ~/.claude -name '*.json'"),
  "notifications key": write(`${H}/.codex/config.toml`, "[tui]\nnotifications = true\n"),
  "grep flag lt": bash("grep -c -- --yolo notes.txt"),
};

const rules = loadRuleDir("rules/ai_coding_agent").rules;
const hit = (o: object) => decide(JSON.stringify({ session_id: "s", cwd: P, hook_event_name: "PreToolUse", ...o }), rules)?.rule.name;

test.each(Object.entries(attacks))("enforce rule trips: %s", (_k, o) => expect(hit(o)).toBeDefined());
test.each(Object.entries(benign))("no enforce rule: %s", (_k, o) => expect(hit(o)).toBeUndefined());

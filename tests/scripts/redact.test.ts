// Synthetic transcript, defanged: example.invalid, placeholder keys built by concatenation, fake user `alice`.
import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test";
// These tests start real processes, which take ~2 s each on slow, security-scanned Windows machines; 5 s is too tight.
setDefaultTimeout(60_000);
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parseFile } from "../../src/collectors/claude-code/v1.ts";
import { redactTree } from "../../scripts/redact-fixture.ts";

const root = mkdtempSync(join(tmpdir(), "rh-redact-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const KEY = "AKIA" + "EXAMPLEEXAMPLE00";
const PROMPT = "please refactor the zebra-quux billing module";
let n = 0;
const base = (type: string, cwd: string, extra: object) => ({
  type, uuid: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, sessionId: "s1",
  timestamp: `2026-11-07T10:00:${String(n).padStart(2, "0")}.000Z`, cwd, version: "2.1.319", ...extra,
});
const use = (cwd: string, id: string, name: string, input: object) =>
  base("assistant", cwd, { message: { content: [{ type: "tool_use", id, name, input }] } });

function transcript(cwd: string): object[] {
  return [
    base("user", cwd, { message: { role: "user", content: PROMPT } }),
    base("assistant", cwd, { message: { content: [{ type: "text", text: "Sure, mail bob@corp.example.invalid about zebra-quux" }] } }),
    use(cwd, "t1", "Bash", { command: `curl -H "Authorization: Bearer ${KEY}ZZ" https://example.invalid/x`, description: "fetch zebra-quux" }),
    base("user", cwd, { message: { content: [{ type: "tool_result", tool_use_id: "t1", content: `ok from buildbox.local ${KEY}` }] } }),
    use(cwd, "t2", "Read", { file_path: `${cwd}/src/a.ts` }),
    use(cwd, "t3", "WebFetch", { url: "https://example.invalid/doc" }),
    { type: "ai-title", aiTitle: "zebra-quux work", sessionId: "s1" },
  ];
}

const summary = async (p: string) => (await parseFile(p)).events.map((e) => [e.category, e.tool_name]);

describe("redact-fixture", () => {
  for (const [label, home] of [["posix", "/Users/alice"], ["windows", "C:\\Users\\alice"]] as const) {
    test(`${label}: removes identifiers, keeps parse result`, async () => {
      const cwd = `${home}${label === "posix" ? "/" : "\\"}acme-secret-proj`;
      const enc = label === "posix" ? "-Users-alice-acme-secret-proj" : "C--Users-alice-acme-secret-proj";
      const src = join(root, label, "in");
      const file = join(src, enc, "s1.jsonl");
      mkdirSync(join(src, enc), { recursive: true });
      writeFileSync(file, transcript(cwd).map((l) => JSON.stringify(l)).join("\n") + "\n");

      const out = join(root, label, "out");
      expect(redactTree(src, out)).toBe(1);
      const outFile = join(out, enc.replace("alice", "user1").replace("acme-secret-proj", "proj1"), "s1.jsonl");
      const text = readFileSync(outFile, "utf8");

      for (const secret of ["alice", "acme-secret-proj", "bob@", "corp.example", "zebra-quux", "buildbox", KEY]) {
        expect(text.toLowerCase()).not.toContain(secret.toLowerCase());
      }
      expect(text).toContain("user1");
      expect(text).toContain("proj1");
      expect(text).not.toContain(JSON.parse(readFileSync(file, "utf8").split(/\r?\n/)[0]!).uuid); // uuids pseudonymised
      expect(await summary(outFile)).toEqual(await summary(file));
      expect((await parseFile(outFile)).events.length).toBeGreaterThanOrEqual(3);
    });
  }

  test("same project maps to the same pseudonym across files", () => {
    const src = join(root, "multi");
    mkdirSync(src, { recursive: true });
    for (const f of ["a.jsonl", "b.jsonl"]) writeFileSync(join(src, f), JSON.stringify({ type: "user", cwd: "/home/alice/acme-secret-proj" }) + "\n");
    redactTree(src, join(root, "multi-out"));
    const [a, b] = ["a.jsonl", "b.jsonl"].map((f) => readFileSync(join(root, "multi-out", f), "utf8"));
    expect(a).toBe(b);
  });

  test("free text outside known fields, in keys and inside commands is replaced; command shape stays", () => {
    const src = join(root, "deny");
    mkdirSync(src, { recursive: true });
    const cmd = [
      "cd /Users/alice/proj && cat > a.py <<'EOF'\nheredoc private body\nEOF",
      'git commit -m "commit message about the merger" && ssh 1.2.3.4 # remember to ping the team lead',
      "cat .env.local src/users/dto/x.ts",
    ].join("\n");
    const lines = [
      { type: "user", cwd: "/Users/alice/proj", serverClassifierContext: { git_state: { remote: "octo-owner42/proj" } },
        toolUseResult: { originalFile: "whole file", structuredPatch: [{ lines: ["+one"] }], answers: { "Which plan do we ship?": "the cheap one" },
          newField: "some brand new prose field", file: { base64: "QUJD" } } },
      use("/Users/alice/proj", "t9", "Bash", { command: cmd }),
    ];
    writeFileSync(join(src, "a.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    redactTree(src, join(root, "deny-out"));
    const text = readFileSync(join(root, "deny-out", "a.jsonl"), "utf8");
    for (const leak of ["octo-owner42", "whole file", "+one", "Which plan", "cheap one", "brand new prose", "QUJD",
      "heredoc private", "merger", "1.2.3.4", "team lead"]) expect(text).not.toContain(leak);
    for (const kept of ["cat > a.py <<'EOF'\\n[redacted text: short]\\nEOF", "git commit -m \\\"[redacted text: short]\\\"",
      "ssh 192.0.2.1 #", "cat .env.local src/users/dto/x.ts"]) expect(text).toContain(kept);
  });

  test("session uuids, agent ids and spaced file names are pseudonymised consistently, paths included", async () => {
    const sid = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
    const agent = "aplanner-0123456789abcdef";
    const dir = join(root, "ids", sid, "subagents");
    mkdirSync(dir, { recursive: true });
    const parent = { type: "user", sessionId: sid, cwd: "/Users/alice/proj", teamName: `session-${sid.slice(0, 8)}`,
      message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] }, toolUseResult: { agentId: agent } };
    writeFileSync(join(root, "ids", `${sid}.jsonl`), JSON.stringify(parent) + "\n");
    writeFileSync(join(dir, `agent-${agent}.jsonl`), JSON.stringify(
      use("/Users/alice/proj", "t2", "Read", { file_path: "/Users/alice/proj/Client Secret Plan.md" })) + "\n");
    expect(redactTree(join(root, "ids"), join(root, "ids-out"))).toBe(2);
    const out = (readdirSync(join(root, "ids-out"), { recursive: true }) as string[]).map((f) => f.replace(/\\/g, "/"));
    const text = out.filter((f) => f.endsWith(".jsonl")).map((f) => readFileSync(join(root, "ids-out", f), "utf8")).join("");
    for (const leak of [sid, sid.slice(0, 8), "0123456789abcdef", "Client Secret"]) expect(out.join() + text).not.toContain(leak);
    const sub = out.find((f) => f.includes("/subagents/agent-"))!;
    const [, newSid, newAgent] = /^(.+)\/subagents\/agent-(.+)\.jsonl$/.exec(sub)!;
    expect(text).toContain(`"sessionId":"${newSid}"`);
    expect(text).toContain(`"agentId":"${newAgent}"`);
    expect(text).toContain("/proj1/redacted.md");
    const { events } = await parseFile(join(root, "ids-out", sub));
    expect(events[0]!.parent_tool_use_id).toBe("t1"); // the spawn link still resolves through the renamed files
  });

  test("teammate names go in every field, agent ids included; generic roles and agent-<id> file names stay", () => {
    const src = join(root, "mates");
    mkdirSync(src, { recursive: true });
    const lines = [
      { type: "x", cwd: "/Users/alice/proj", toolUseResult: { agentId: "azebra-billing-0123456789abcdef", name: "zebra-billing" } },
      { type: "x", cwd: "/Users/alice/proj", attachment: { teammate_id: "quux-fixer@session-1a2b3c4d", recipient: "quux-fixer" } },
      { type: "x", cwd: "/Users/alice/proj", toolUseResult: { agentId: "aplanner-0123456789abcdee", to: "team-lead" } },
    ];
    writeFileSync(join(src, "a.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    writeFileSync(join(src, "agent-a0123456789abcdef.jsonl"), JSON.stringify({ type: "x", message: "@zebra-billing" }) + "\n");
    redactTree(src, join(root, "mates-out"));
    const out = readdirSync(join(root, "mates-out")).sort();
    const text = out.map((f) => readFileSync(join(root, "mates-out", f), "utf8")).join("");
    for (const leak of ["zebra", "quux"]) expect(text).not.toContain(leak);
    expect(text).toMatch(/"agentId":"amate1-[0-9a-f]{16}","name":"mate1"/);
    expect(text).toContain('"teammate_id":"mate2@session-');
    expect(text).toContain('"recipient":"mate2"');
    expect(text).toContain('"message":"@mate1"');
    expect(text).toMatch(/"agentId":"aplanner-[0-9a-f]{16}","to":"team-lead"/);
    expect(out.find((f) => f.startsWith("agent-"))).toMatch(/^agent-[0-9a-f]{17}\.jsonl$/);
  });

  test("web domains map to consistent siteN.example pseudonyms; allowlisted hosts, file names and member chains stay", () => {
    const src = join(root, "dom");
    mkdirSync(src, { recursive: true });
    const cmd = [
      "curl -s https://api.zebra-agency.gov/v1 https://eonet.gsfc.zebra-agency.gov/x https://www.quux-news.co.in/a",
      "grep -n 'feeds\\.quux-news\\.co\\.in' x.ts; curl https://api.github.com/repos https://abc.ngrok-free.app/h",
      "curl https://api.anthropic.com/v1 http://localhost:3000; cat settings.local.json; node -e process.env.HOME",
    ].join(" && ");
    const lines = [
      use("/Users/alice/proj", "t1", "Bash", { command: cmd }),
      use("/Users/alice/proj", "t2", "WebFetch", { url: "https://zebra-agency.gov/apod" }),
      { type: "x", cwd: "/Users/alice/proj", domain: "docs.zebra-agency.gov" },
    ];
    writeFileSync(join(src, "a.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    writeFileSync(join(src, "b.jsonl"), JSON.stringify(use("/Users/alice/proj", "t3", "Bash", { command: "ping api.zebra-agency.gov" })) + "\n");
    redactTree(src, join(root, "dom-out"));
    const read = (f: string) => readFileSync(join(root, "dom-out", f), "utf8");
    const a = read("a.jsonl"), b = read("b.jsonl");
    for (const leak of ["zebra-agency", "quux-news", "eonet", "gsfc", ".gov"]) expect(a + b).not.toContain(leak);
    const site = /https:\/\/api\.(site\d+)\.example\/v1/.exec(a)![1]!;
    expect(a).toContain(`https://${site}.example/apod`);
    expect(a).toContain(`"domain":"docs.${site}.example"`);
    expect(a).toMatch(new RegExp(`https://sub\\d+\\.sub\\d+\\.${site}\\.example/x`)); // subdomain shape kept, labels masked
    expect(b).toContain(`ping api.${site}.example`); // same pseudonym in another file
    const news = /https:\/\/www\.(site\d+)\.example\/a/.exec(a)![1]!;
    expect(news).not.toBe(site);
    expect(a).toMatch(new RegExp(`'sub\\d+\\\\\\\\.${news}\\\\\\\\.example'`)); // grep pattern, dots still escaped
    for (const kept of ["https://api.github.com/repos", "https://abc.ngrok-free.app/h", "https://api.anthropic.com/v1",
      "http://localhost:3000", "settings.local.json", "x.ts", "process.env.HOME"]) expect(a).toContain(kept);
  });

  test("--drop words (hostnames) are replaced", () => {
    const src = join(root, "drop");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "a.jsonl"), JSON.stringify({ type: "x", cwd: "/home/alice/p", n: "ssh rackhost01" }) + "\n");
    redactTree(src, join(root, "drop-out"), ["rackhost01"]);
    expect(readFileSync(join(root, "drop-out", "a.jsonl"), "utf8")).not.toContain("rackhost01");
  });
});

describe("check-staged", () => {
  const script = join(import.meta.dir, "../../scripts/check-staged.ts");
  const git = (cwd: string, ...a: string[]) => spawnSync("git", a, { cwd, encoding: "utf8" });
  const run = (cwd: string) => spawnSync("bun", [script], { cwd, encoding: "utf8" });
  const repo = () => {
    const d = mkdtempSync(join(root, "repo-"));
    git(d, "init", "-q");
    return d;
  };

  test("passes on clean files", () => {
    const d = repo();
    writeFileSync(join(d, "a.txt"), "hello\n");
    git(d, "add", "a.txt");
    expect(run(d).status).toBe(0);
  });

  test("fails on a planted key, naming file and kind but not the value", () => {
    const d = repo();
    writeFileSync(join(d, "cfg.txt"), `id=${KEY}\n`);
    git(d, "add", "cfg.txt");
    const r = run(d);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("cfg.txt");
    expect(r.stderr).toContain("aws_access_key");
    expect(r.stderr + r.stdout).not.toContain(KEY);
  });

  test("fails on anything under fixtures/raw/", () => {
    const d = repo();
    mkdirSync(join(d, "fixtures/raw"), { recursive: true });
    writeFileSync(join(d, "fixtures/raw/s.jsonl"), "{}\n");
    git(d, "add", "-f", "fixtures/raw/s.jsonl");
    const r = run(d);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("fixtures/raw/s.jsonl");
  });
});

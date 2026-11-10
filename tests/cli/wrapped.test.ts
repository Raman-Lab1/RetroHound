// `wrapped` over an index built by a real scan, driven through its registrar on a bare commander Program.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import type { IO } from "../../src/cli/io.ts";
import { main } from "../../src/cli/main.ts";
import { registerWrapped } from "../../src/cli/wrapped.ts";

const base = mkdtempSync(join(tmpdir(), "rh-wr-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const RULE = `title: Hit command
id: 0b6c7a52-0000-4000-8000-00000000a11d
name: hit
level: high
logsource: { product: ai_coding_agent }
detection:
    selection: { command_line|contains: hitcmd }
    condition: selection
`;
const CWD = "/home/zelda/secretproj";
const row = (n: number, command: string, extra: object = {}) => ({
  type: "assistant", uuid: `u-${n}`, sessionId: "sess1111", timestamp: `2026-11-07T10:00:0${n}.000Z`, cwd: CWD,
  message: { content: [{ type: "tool_use", id: `t${n}`, name: "Bash", input: { command } }] }, ...extra,
});

async function setup() {
  const dir = mkdtempSync(join(base, "c-"));
  const db = join(dir, "i.db");
  mkdirSync(join(dir, "rules"));
  writeFileSync(join(dir, "rules", "hit.yml"), RULE);
  const proj = join(dir, "claude", "projects", "-home-zelda-secretproj");
  mkdirSync(proj, { recursive: true });
  const lines = [row(1, `hitcmd https://example.invalid/x ${CWD}/a.txt`), row(2, "ls", { agentId: "a1" })];
  writeFileSync(join(proj, "sess1111.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const io: IO = { out: () => {}, err: () => {}, isTTY: false, env: {} };
  await main(["scan", "--root", join(dir, "claude"), "--db", db, "--rules", join(dir, "rules"), "--no-report"], io);
  return { dir, db };
}

async function wrapped(argv: string[]) {
  let out = "";
  let err = "";
  let code = -1;
  const io: IO = { out: (s) => (out += s), err: (s) => (err += s), isTTY: false, env: {} };
  const program = new Command().exitOverride();
  registerWrapped(program, async (fn) => void (code = await fn()), io);
  await program.parseAsync(["node", "rh", "wrapped", ...argv]);
  return { out, err, code };
}

describe("wrapped command", () => {
  test("writes a card with the pitch numbers", async () => {
    const { dir, db } = await setup();
    const file = join(dir, "w.html");
    const r = await wrapped(["--db", db, "--rules", join(dir, "rules"), "--out", file]);
    expect(r.code).toBe(0);
    const html = readFileSync(file, "utf8");
    expect(html).toContain("example.invalid");
    expect(html).toContain("hitcmd");
    expect(html).toContain("50%"); // one of two events from a sub-agent
  });
  test("--anonymize leaves no project name or user name", async () => {
    const { dir, db } = await setup();
    const file = join(dir, "a.html");
    await wrapped(["--db", db, "--rules", join(dir, "rules"), "--out", file, "--anonymize"]);
    const html = readFileSync(file, "utf8").toLowerCase();
    expect(html).not.toContain("secretproj");
    expect(html).not.toContain("zelda");
    expect(html).toContain("anon-");
  });
  test(".svg writes the share card and --anonymize hides names in it", async () => {
    const { dir, db } = await setup();
    const file = join(dir, "c.svg");
    expect((await wrapped(["--db", db, "--rules", join(dir, "rules"), "--out", file, "--anonymize"])).code).toBe(0);
    const svg = readFileSync(file, "utf8");
    expect(svg).toContain("<svg");
    expect(svg.toLowerCase()).not.toContain("secretproj");
    expect(svg.toLowerCase()).not.toContain("zelda");
    expect(svg).toContain("50%");
  });
  test(".png exits 2 with a note", async () => {
    const { db } = await setup();
    const r = await wrapped(["--db", db, "--out", "x.png"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("PNG");
  });
  test("empty index (nothing in window) still renders", async () => {
    const { dir, db } = await setup();
    const file = join(dir, "e.html");
    expect((await wrapped(["--db", db, "--out", file, "--since", "2030-01-01"])).code).toBe(0);
    expect(readFileSync(file, "utf8")).toContain("none");
  });
});

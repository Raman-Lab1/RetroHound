// show and query print transcript text with control characters as \xNN, so an escape sequence planted in a
// transcript cannot clear the screen, forge lines or set a terminal hyperlink.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IO } from "../../src/cli/io.ts";
import { main } from "../../src/cli/main.ts";

const dir = mkdtempSync(join(tmpdir(), "rh-sq-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ESC = "\x1b";
const cmd = `ls ${ESC}]8;;http://example.invalid/${ESC}\\fake${ESC}]8;;${ESC}\\ ${ESC}[2J`;
const proj = join(dir, "claude", "projects", "-home-x-acme");
mkdirSync(proj, { recursive: true });
mkdirSync(join(dir, "rules"));
writeFileSync(join(proj, "abcd1111.jsonl"), JSON.stringify({
  type: "assistant", uuid: "u-1", sessionId: "abcd1111", timestamp: "2026-11-07T10:00:01.000Z", cwd: "/home/x/acme",
  message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: cmd } }] },
}) + "\n");

let out = "";
const io: IO = { out: (s) => (out += s), err: (s) => (out += s), isTTY: false, env: {} };
const db = join(dir, "index.db");
const run = (...argv: string[]) => main(argv, io);

test("show and query escape control characters from the index", async () => {
  expect(await run("scan", "--root", join(dir, "claude"), "--db", db, "--rules", join(dir, "rules"), "--no-report")).toBe(0);
  for (const argv of [["show", "abcd1111"], ["query", "SELECT command_line FROM events"]]) {
    out = "";
    expect(await run(...argv, "--db", db, ...(argv[0] === "show" ? ["--rules", join(dir, "rules")] : []))).toBe(0);
    expect(out).toContain("\\x1b]8;;");
    expect(out).not.toContain(ESC);
  }
});

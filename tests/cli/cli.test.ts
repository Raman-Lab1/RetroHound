// CLI in-process over temp dirs and hand-written defanged transcripts (example.invalid, placeholder values).
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { main } from "../../src/cli/main.ts";
import type { IO } from "../../src/cli/io.ts";
import { TOOL_VERSION } from "../../src/version.ts";

const base = mkdtempSync(join(tmpdir(), "rh-cli-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const HIT = `title: Hit command
name: hit
level: high
logsource: { product: ai_coding_agent }
detection:
    selection: { command_line|contains: hitcmd }
    condition: selection
`;
const BAD = `title: Broken
name: broken
logsource: { product: nope }
detection:
    selection: { command_line|contains: x }
    condition: selection
`;
const line = (sid: string, n: number) => ({
  type: "assistant", uuid: `u-${n}`, sessionId: sid, timestamp: "2026-11-07T10:00:00.000Z", cwd: "/home/x/acme",
  message: { content: [{ type: "tool_use", id: `t${n}`, name: "Bash", input: { command: `hitcmd ${n}` } }] },
});
const put = (path: string, lines: object[]) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
};

let dir: string;
let out: string;
let err: string;
let io: IO;
const run = (...argv: string[]) => main(argv, io);
const common = () => ["--root", join(dir, "claude"), "--db", join(dir, "index.db"), "--rules", join(dir, "rules")];

beforeEach(() => {
  dir = mkdtempSync(join(base, "case-"));
  out = err = "";
  io = { out: (s) => (out += s), err: (s) => (err += s), isTTY: false, env: {} };
  mkdirSync(join(dir, "rules"));
  writeFileSync(join(dir, "rules", "hit.yml"), HIT);
  put(join(dir, "claude", "projects", "-home-x-acme", "abcdef123456.jsonl"), [line("abcdef123456", 1)]);
});

describe("scan", () => {
  test("table output, exit 0, ADR 0008 summary with the retention warning", async () => {
    expect(await run("scan", ...common())).toBe(0);
    expect(out).toContain("hit");
    expect(out).toContain("History window: 30 days");
    expect(out).toContain("cleanupPeriodDays\": 3650");
  });

  test("--fail-on exits 1 at or below the finding's level, 0 above it", async () => {
    expect(await run("scan", ...common(), "--fail-on", "high")).toBe(1);
    expect(await run("scan", ...common(), "--fail-on", "critical")).toBe(0);
  });

  test("--format json parses and carries the report schema", async () => {
    expect(await run("scan", ...common(), "--format", "json", "--no-index")).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ schema: "retrohound.scan/0.1", scan: { sessions: 1 } });
    expect(existsSync(join(dir, "index.db"))).toBe(false);
  });

  test.each([
    [["--level", "severe"]], [["--format", "xml"]], [["--agent", "cursor"]], [["--since", "yesterday"]], [["--fail-on", "x"]], [["--bogus"]],
    [["--agent", "all"]], // with common()'s --root: each agent has its own root
  ])("bad input %j exits 2 with a message", async (flags) => {
    expect(await run("scan", ...common(), ...flags)).toBe(2);
    expect(err.length).toBeGreaterThan(0);
  });

  test("--since 30d keeps today's session and a far-future date drops it", async () => {
    expect(await run("scan", ...common(), "--format", "json", "--since", "2027-01-01")).toBe(0);
    expect(JSON.parse(out).scan.sessions).toBe(0);
  });

  test("colour only with a TTY and no NO_COLOR", async () => {
    io.isTTY = true;
    await run("scan", ...common());
    expect(out).toContain("\u001b[");
    out = "";
    io.env = { NO_COLOR: "1" };
    await run("scan", ...common());
    expect(out).not.toContain("\u001b[");
  });

  test("rejected rules are reported on stderr in one line", async () => {
    writeFileSync(join(dir, "rules", "bad.yml"), BAD);
    await run("scan", ...common());
    expect(err).toBe("1 rules rejected, see `retrohound rules list`\n");
  });

  test("a missing root prints toTable's empty state", async () => {
    expect(await run("scan", "--root", join(dir, "none"), "--no-index", "--rules", join(dir, "rules"))).toBe(0);
    expect(out).toContain("No Claude Code sessions found");
  });

  test("writes the footprint report next to the index by default, owner-only, and prints its file URL", async () => {
    expect(await run("scan", ...common())).toBe(0);
    const page = join(dir, "index.footprint.html");
    expect(readFileSync(page, "utf8")).toContain("RetroHound footprint");
    expect(statSync(page).mode & 0o777).toBe(0o600);
    expect(out).toContain(`Footprint report (everything in the index): file://`);
    expect(err).toBe("");
  });

  test("--report moves it; --no-report, --no-index and machine formats write none", async () => {
    const page = join(dir, "elsewhere.html");
    expect(await run("scan", ...common(), "--report", page)).toBe(0);
    expect(existsSync(page)).toBe(true);
    for (const flags of [["--no-report"], ["--format", "json"], ["--format", "sarif"], ["--no-index"]]) {
      expect(await run("scan", ...common(), ...flags)).toBe(0);
      expect(existsSync(join(dir, "index.footprint.html"))).toBe(false);
    }
  });

  test.each([[["--no-index"]], [["--format", "json"]]])("--report with %j exits 2", async (flags) => {
    expect(await run("scan", ...common(), "--report", join(dir, "r.html"), ...flags)).toBe(2);
  });

  test("--report onto the index or its WAL is refused and the index is untouched", async () => {
    await run("scan", ...common());
    for (const target of ["index.db", "index.db-wal"]) {
      expect(await run("scan", ...common(), "--report", join(dir, target))).toBe(2);
    }
    expect(await run("query", "select count(*) as n from sessions", "--db", join(dir, "index.db"))).toBe(0);
  });

  test("history.jsonl sessions without a transcript are counted from sessionId only", async () => {
    writeFileSync(join(dir, "claude", "history.jsonl"), `{"sessionId":"gone1","display":"prompt text"}\n{"sessionId":"abcdef123456"}\n`);
    await run("scan", ...common());
    expect(out).toContain("1 sessions in history.jsonl have no transcript");
    expect(out).not.toContain("prompt text");
  });
});

describe("rules", () => {
  test("list shows metadata and rejected rules with the reason; show prints the YAML", async () => {
    writeFileSync(join(dir, "rules", "bad.yml"), BAD);
    expect(await run("rules", "list", "--rules", join(dir, "rules"))).toBe(0);
    expect(out).toMatch(/hit\s+high\s+hunt\s+any/);
    expect(out).toContain("unknown-product");
    out = "";
    expect(await run("rules", "show", "hit", "--rules", join(dir, "rules"))).toBe(0);
    expect(out).toContain("command_line|contains: hitcmd");
    expect(await run("rules", "show", "nope", "--rules", join(dir, "rules"))).toBe(2);
  });
});

describe("purge", () => {
  test("without --yes keeps the DB and exits 1; with --yes deletes it", async () => {
    await run("scan", ...common());
    const db = join(dir, "index.db");
    expect(await run("purge", "--db", db)).toBe(1);
    expect(existsSync(db)).toBe(true);
    expect(out).toContain("Would delete");
    expect(out).toContain("index.footprint.html");
    expect(await run("purge", "--db", db, "--yes")).toBe(0);
    expect(existsSync(db)).toBe(false);
    expect(existsSync(join(dir, "index.footprint.html"))).toBe(false);
  });
});

describe("meta", () => {
  test("--version and --help exit 0, an unknown command exits 2", async () => {
    expect(await run("--version")).toBe(0);
    expect(out).toContain(TOOL_VERSION);
    expect(await run("scan", "--help")).toBe(0);
    expect(out).toContain("--fail-on");
    expect(await run("frobnicate")).toBe(2);
  });
});

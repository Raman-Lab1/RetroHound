// .retrohound-ignore.yml: matching, scoping, strict validation, counts, and "the index keeps everything" (ADR 0003, 0008).
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { UsageError } from "../src/cli/io.ts";
import { toJson } from "../src/outputs/json.ts";
import { toTable } from "../src/outputs/table.ts";
import { runScan, type ScanOptions } from "../src/scan.ts";
import { openStore } from "../src/store/index.ts";
import { loadRuleDir } from "../src/cli/rules.ts";
import { preflightTable, runPreflight } from "../src/preflight.ts";
import { applyIgnore, loadIgnore } from "../src/suppress.ts";

const base = mkdtempSync(join(tmpdir(), "rh-sup-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const RULES = `title: Hit
name: hit
logsource: { product: ai_coding_agent }
detection:
    selection: { command_line|contains: hitcmd }
    condition: selection
---
title: Many hits
name: many
level: medium
correlation:
    type: event_count
    rules: [hit]
    group-by: [session_id]
    timespan: 10m
    condition: { gte: 2 }
`;
const line = (n: number) => ({
  type: "assistant", uuid: `u-${n}`, sessionId: "s1", timestamp: `2026-11-07T10:00:0${n}.000Z`, cwd: "/home/x/acme",
  message: { content: [{ type: "tool_use", id: `t${n}`, name: "Bash", input: { command: `hitcmd ${n}` } }] },
});

let dir: string;
let opts: ScanOptions;
let ignorePath: string;
const ignore = (yaml: string) => (writeFileSync(ignorePath, yaml), { ...opts, ignore: ignorePath });
beforeEach(() => {
  dir = mkdtempSync(join(base, "case-"));
  mkdirSync(join(dir, "rules"));
  writeFileSync(join(dir, "rules", "r.yml"), RULES);
  const file = join(dir, "claude", "projects", "-home-x-acme", "s1.jsonl");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, [1, 2].map((n) => JSON.stringify(line(n))).join("\n") + "\n");
  opts = { root: join(dir, "claude"), dbPath: join(dir, "i.db"), rulesDir: join(dir, "rules") };
  ignorePath = join(dir, "ignore.yml");
});

describe("suppression", () => {
  test("no ignore file: unchanged, and no suppressed field", async () => {
    const r = await runScan(opts);
    expect(r.findings.length).toBe(1);
    expect(r.scan.suppressed).toBeUndefined();
  });

  test("exact match on the primary event suppresses a correlation finding; counted in JSON and table; index keeps it", async () => {
    const first = (await runScan(opts)).findings[0]!.events[0]!;
    const r = await runScan(ignore(`- rule: many\n  match: { command_line: "${first.command_line}" }\n  project_path: ${first.project_path}\n  reason: mine\n`));
    expect(r.findings).toEqual([]);
    expect(r.scan.suppressed).toBe(1);
    expect(JSON.parse(toJson(r)).scan.suppressed).toBe(1);
    expect(toTable(r, { color: false })).toContain("1 findings suppressed by your ignore file");
    const db = openStore(opts.dbPath!);
    expect(db.listFindings().length).toBe(1); // evidence is never deleted
    db.close();
  });

  test("a different value, a different project_path, or a different rule does not suppress", async () => {
    const e = (await runScan(opts)).findings[0]!.events[0]!;
    for (const y of [
      `- rule: many\n  match: { command_line: "other" }\n`,
      `- rule: many\n  match: { command_line: "${e.command_line}" }\n  project_path: /elsewhere\n`,
      `- rule: hit\n  match: { command_line: "${e.command_line}" }\n`,
    ]) {
      const r = await runScan(ignore(y));
      expect(r.findings.length).toBe(1);
      expect(r.scan.suppressed).toBeUndefined();
    }
  });

  test("rule may be named by name; project_path alone is enough", async () => {
    const r = await runScan(ignore(`- rule: many\n  project_path: /home/x/acme\n`));
    expect(r.scan.suppressed).toBe(1);
  });

  test("invalid files are usage errors naming the file and entry", async () => {
    const bad: Record<string, string> = {
      "bad yaml": "- rule: [",
      "unknown key": "- rule: many\n  match: { command_line: x }\n  extra: 1\n",
      "unknown rule": "- rule: nope\n  match: { command_line: x }\n",
      "non-string value": "- rule: many\n  match: { command_line: 5 }\n",
      "unknown field": "- rule: many\n  match: { comand_line: x }\n",
      "not a list": "rule: many\n",
      "whole rule": "- rule: many\n",
      "alias": "- &a { rule: many, match: { command_line: x } }\n- *a\n",
    };
    for (const [name, y] of Object.entries(bad)) {
      const err = await runScan(ignore(y)).then(() => null, (e) => e);
      expect(err, name).toBeInstanceOf(UsageError);
      expect(err.message, name).toContain(ignorePath);
    }
    expect(await runScan({ ...opts, ignore: join(dir, "missing.yml") }).catch((e) => e)).toBeInstanceOf(UsageError);
  });

  test("search order: --ignore alone, else the home file; a repo's own file is never read implicitly", () => {
    const { rules } = loadRuleDir(join(dir, "rules"));
    const home = join(dir, "home");
    mkdirSync(join(home, ".retrohound"), { recursive: true });
    writeFileSync(join(home, ".retrohound", "ignore.yml"), "- rule: hit\n  match: { tool_name: Bash }\n");
    writeFileSync(join(dir, ".retrohound-ignore.yml"), "- rule: many\n  project_path: /p\n");
    expect(loadIgnore(rules, { home }).entries.length).toBe(1);
    const prev = process.cwd();
    try {
      process.chdir(dir); // the repo file sits in the working directory and is still not picked up
      expect(loadIgnore(rules, { home }).entries.length).toBe(1);
    } finally {
      process.chdir(prev);
    }
    expect(loadIgnore(rules, { home, file: join(dir, ".retrohound-ignore.yml") }).entries.length).toBe(1);
    expect(applyIgnore([], loadIgnore(rules, { home })).suppressed).toBe(0);
  });

  test("preflight applies --ignore, prints the count, and ignores the repo's own ignore file", () => {
    const repo = join(dir, "repo");
    mkdirSync(repo);
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "x", scripts: { postinstall: "node setup.js" } }));
    const all = runPreflight(repo);
    const f = all.report.findings[0]!;
    const name = all.report.rules.find((r) => r.id === f.rule_id)!.name;
    writeFileSync(join(repo, ".retrohound-ignore.yml"), `- rule: ${name}\n  match: { category: "${f.events[0]!.category}" }\n`);
    expect(runPreflight(repo).report.findings.length).toBe(all.report.findings.length); // untrusted repo cannot hide findings
    const r = runPreflight(repo, { ignore: join(repo, ".retrohound-ignore.yml") });
    expect(r.report.findings.length).toBe(all.report.findings.length - r.report.scan.suppressed!);
    expect(r.report.scan.suppressed).toBeGreaterThan(0);
    expect(preflightTable(r)).toContain("findings suppressed by your ignore file");
  });
});

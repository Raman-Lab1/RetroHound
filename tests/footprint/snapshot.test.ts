// Config snapshots (src/footprint/snapshot.ts): taken on every indexed scan, pruned to the last SNAPSHOTS, diffed by the
// footprint, never holding a raw value. Scans run against the temp HOME (tests/preload.ts) with defanged config files.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAntigravityConfig } from "../../src/footprint/config-antigravity.ts";
import { readCodexConfig } from "../../src/footprint/config-codex.ts";
import { snapshotDiff } from "../../src/footprint/snapshot.ts";
import type { ConfigItem } from "../../src/footprint/types.ts";
import { runScan } from "../../src/scan.ts";
import { openReadOnly, openStore, SNAPSHOTS } from "../../src/store/index.ts";
import { MIGRATIONS, migrate } from "../../src/store/schema.ts";
import { open } from "../../src/store/sqlite.ts";

const base = mkdtempSync(join(tmpdir(), "rh-snapshot-"));
const KEY = "sk-" + "PLACEHOLDER0000000000000000"; // placeholder in the sk- key shape, split so no file holds it whole
const AWS = "AKIA" + "ABCDEFGHIJKLMNOP";
const claudeJson = join(process.env.HOME!, ".claude.json"); // HOME is a temp dir (tests/preload.ts)
beforeAll(() => mkdirSync(join(base, "claude", "projects"), { recursive: true }));
afterAll(() => {
  rmSync(claudeJson, { force: true });
  rmSync(base, { recursive: true, force: true });
});

const item = (name: string, hash = "h1", over: Partial<ConfigItem> = {}): ConfigItem =>
  ({ agent: "claude_code", kind: "mcp_server", name, scope: "user", source: "/home/x/.claude.json", hash, ...over });
const run = (store: ReturnType<typeof openStore>, items: ConfigItem[]) => {
  store.recordRuleRun({ rule_set_hash: "r", started_at: "t", finished_at: "t", events: 0, findings: 0 });
  store.recordConfigSnapshot(items);
};
const diff = (path: string) => {
  const db = openReadOnly(path);
  try {
    return snapshotDiff(db)[0];
  } finally {
    db.close();
  }
};
const servers = (args: string[]) => writeFileSync(claudeJson, JSON.stringify({
  mcpServers: { docs: { command: "npx", args, env: { API_KEY: KEY } } },
}));
const scan = (dbPath: string, noIndex = false) => runScan({ root: join(base, "claude"), dbPath, noIndex });

describe("config snapshots", () => {
  test("an index from before snapshots is upgraded; its old runs took none, so nothing compares yet", () => {
    const path = join(base, "v3.db");
    const old = open(path);
    migrate(old, MIGRATIONS.slice(0, 3));
    old.exec("INSERT INTO rule_runs (rule_set_hash, started_at, finished_at, events, findings) VALUES ('r', 't', 't', 0, 0)");
    old.close();
    expect(diff(path)).toBeUndefined(); // read-only, not upgraded
    const store = openStore(path);
    run(store, [item("a")]);
    store.close();
    expect(diff(path)).toEqual({ compared: false, new: [], changed: [], removed: [] });
  });

  test("keeps the last SNAPSHOTS scans, pruning in the same write", () => {
    const path = join(base, "prune.db");
    const store = openStore(path);
    for (let i = 0; i < SNAPSHOTS + 2; i++) run(store, [item(`s${i}`), item("x")]);
    store.close();
    const db = openReadOnly(path);
    const ids = db.prepare("SELECT DISTINCT scan_id AS id FROM config_snapshots ORDER BY id").all().map((r) => Number(r.id));
    db.close();
    expect(ids).toEqual(Array.from({ length: SNAPSHOTS }, (_, i) => i + 3));
  });

  test("new, changed and removed against the scan before; a twin under one name is not a change", () => {
    const path = join(base, "diff.db");
    const store = openStore(path);
    const hook = (hash: string) => item("node h.js", hash, { kind: "hook" });
    run(store, [item("same"), item("edited", "h1"), item("gone"), hook("pre"), hook("post")]);
    run(store, [item("same"), item("edited", "h2"), item("added"), hook("pre"), hook("post")]);
    store.close();
    const d = diff(path)!;
    expect(d.compared).toBe(true);
    expect(d.new.map((r) => r.name)).toEqual(["added"]);
    expect(d.changed.map((r) => r.name)).toEqual(["edited"]);
    expect(d.removed.map((r) => r.name)).toEqual(["gone"]);
  });

  test("an indexed scan snapshots the config with no value in it, and a changed argument shows as changed", async () => {
    const path = join(base, "scan.db");
    servers(["--token", AWS]);
    await scan(path);
    expect(diff(path)?.compared).toBe(false);
    servers(["--token", AWS, "--verbose"]);
    await scan(path);
    expect(diff(path)?.changed.map((r) => [r.agent, r.kind, r.name])).toEqual([["claude_code", "mcp_server", "docs"]]);
    const db = openReadOnly(path);
    const rows = JSON.stringify(db.prepare("SELECT * FROM config_snapshots").all());
    db.close();
    for (const secret of [KEY, AWS, "--verbose", "npx"]) expect(rows).not.toContain(secret);
    for (const f of [path, `${path}-wal`]) if (existsSync(f)) expect(readFileSync(f, "latin1")).not.toContain(KEY);
  });

  test("a Codex server's hash follows its table's lines; Antigravity's its entry", () => {
    const home = join(base, "codex-home");
    mkdirSync(join(home, ".codex"), { recursive: true });
    mkdirSync(join(home, ".gemini", "config"), { recursive: true });
    const hashes = (args: string) => {
      writeFileSync(join(home, ".codex", "config.toml"), `[mcp_servers.docs]\ncommand = "npx"\nargs = [${args}]\n`);
      writeFileSync(join(home, ".gemini", "config", "mcp_config.json"), JSON.stringify({ mcpServers: { docs: { command: "npx", args: [args] } } }));
      return [readCodexConfig, readAntigravityConfig].map((r) => r({ home, projects: [] }).items[0]!.hash);
    };
    const [a, b] = [hashes(`"--key", "${KEY}"`), hashes(`"--other"`)];
    expect(a[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(a[0]).not.toBe(b[0]);
    expect(a[1]).not.toBe(b[1]);
  });

  test("--no-index writes nothing", async () => {
    const path = join(base, "none.db");
    servers(["x"]);
    await scan(path, true);
    expect(existsSync(path)).toBe(false);
  });
});

// ADR 0001: src/ makes no network calls, and only the SQLite adapter knows which runtime it is on.
// The scanner reads raw text, comments included: reword a comment rather than teach the guard to skip it.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ADAPTER = "src/store/sqlite.ts";
const NET_MODULES = ["http", "http2", "https", "net", "dns", "tls", "dgram", "undici"];
const NET_NAME = `(?:node:)?(?:${NET_MODULES.join("|")})(?:/[\\w/-]+)?`;
const NET_IMPORT = new RegExp(`(?:\\bfrom\\s*|\\bimport\\s*\\(?\\s*|\\brequire\\s*\\(\\s*)["'\`]${NET_NAME}["'\`]`);

const RULES: { name: string; re: RegExp; adapterMayUse?: boolean }[] = [
  { name: "network-import", re: NET_IMPORT },
  { name: "fetch", re: /\bfetch\s*\(/ },
  { name: "websocket", re: /\bWebSocket\b/ },
  { name: "bun-global", re: /\bBun\./, adapterMayUse: true },
  { name: "bun-module", re: /\bbun:/, adapterMayUse: true },
  { name: "node-sqlite", re: /\bnode:sqlite\b/, adapterMayUse: true },
  { name: "numbered-sql-param", re: /\?\d/ }, // Node 22.13 cannot bind ?1-style params (CI found it)
];

/** Names of the rules that `source`, at repo-relative path `file`, breaks. */
function violations(file: string, source: string): string[] {
  const isAdapter = file.replaceAll("\\", "/") === ADAPTER;
  return RULES.filter((r) => !(isAdapter && r.adapterMayUse) && r.re.test(source)).map((r) => r.name);
}

const SOURCE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const srcFiles = (readdirSync("src", { recursive: true }) as string[]).filter((f) => SOURCE.test(f)).map((f) => join("src", f));

describe("src/ is clean", () => {
  test("the scan sees the real source tree", () => {
    const seen = srcFiles.map((f) => f.replaceAll("\\", "/"));
    expect(seen).toContain(ADAPTER);
    expect(seen).toContain("src/normalize/mask.ts");
  });
  test("no file breaks a guard", () => {
    const bad = srcFiles.flatMap((f) => violations(f, readFileSync(f, "utf8")).map((rule) => `${f}: ${rule}`));
    expect(bad).toEqual([]);
  });
});

describe("the guards fire", () => {
  const FORMS: ((m: string) => string)[] = [
    (m) => `import x from "${m}";`,
    (m) => `import { y } from '${m}';`,
    (m) => `import "${m}";`,
    (m) => `import * as x from "${m}"`,
    (m) => `export * from "${m}";`,
    (m) => `const x = await import("${m}");`,
    (m) => `const x = await import ( '${m}' );`,
    (m) => `const x = require("${m}");`,
    (m) => "const x = require(`" + m + "`);",
    (m) => `import {\n  y,\n} from "${m}";`,
  ];
  const modules = NET_MODULES.flatMap((m) => [m, `node:${m}`]);
  test.each(modules)("network-import: %s", (m) => {
    for (const form of FORMS) expect(violations("src/x.ts", form(m))).toEqual(["network-import"]);
  });
  test.each(["dns/promises", "node:dns/promises", "undici/lib/fetch"])("network-import subpath: %s", (m) => {
    expect(violations("src/x.ts", FORMS[0]!(m))).toEqual(["network-import"]);
  });
  test.each([
    ["fetch", 'await fetch("https://example.invalid");'],
    ["fetch", "await globalThis.fetch (url);"],
    ["websocket", 'new WebSocket("wss://example.invalid");'],
    ["bun-global", 'Bun.file("x");'],
    ["bun-global", "await Bun.write(p, s);"],
    ["bun-module", 'import { Database } from "bun:sqlite";'],
    ["bun-module", 'import { test } from "bun:test";'],
    ["node-sqlite", 'import { DatabaseSync } from "node:sqlite";'],
  ])("%s: %s", (rule, source) => expect(violations("src/x.ts", source)).toEqual([rule]));
});

describe("the guards are not too wide", () => {
  test.each([
    'import { readFileSync } from "node:fs";',
    'import { x } from "./net";',
    'import { x } from "./http.ts";',
    'import { x } from "../dns/lookup.ts";',
    'import x from "netmask";',
    'import x from "http-parser";',
    'const scheme = "https";',
    'const url = "https://example.invalid/";',
    "const fetched = prefetch(x);",
    "const bundle = Bunny.run();",
  ])("%s", (source) => expect(violations("src/x.ts", source)).toEqual([]));
});

describe("the adapter exemption", () => {
  const engine = 'const x = process.versions.bun ? require("bun:sqlite") : require("node:sqlite"); Bun.gc();';
  test("covers the adapter", () => expect(violations(ADAPTER, engine)).toEqual([]));
  test("covers it on a Windows path", () => expect(violations("src\\store\\sqlite.ts", engine)).toEqual([]));
  test("covers nothing else", () => {
    expect(violations("src/store/index.ts", engine)).toEqual(["bun-global", "bun-module", "node-sqlite"]);
    expect(violations("src/store/sqlite.ts.bak", engine)).toEqual(["bun-global", "bun-module", "node-sqlite"]);
  });
  test("does not cover the network", () => {
    expect(violations(ADAPTER, 'import x from "node:net"; fetch(y);')).toEqual(["network-import", "fetch"]);
  });
});

test("numbered SQL params are refused (Node 22.13 binds only plain ?)", () => {
  expect(violations("src/store/index.ts", 'db.prepare("SELECT 1 WHERE ?1 IS NULL")')).toEqual(["numbered-sql-param"]);
  expect(violations("src/store/index.ts", 'db.prepare("SELECT 1 WHERE ? IS NULL")')).toEqual([]);
});

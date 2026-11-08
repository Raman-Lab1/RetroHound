import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mask, scrubHome, secretFingerprints, secretKinds } from "../src/normalize/mask.ts";

// Defanged placeholders, built by concatenation so no secret-shaped literal lands in the repo.
const BODY = "A1b2C3d4E5".repeat(4);
const UP = "EXAMPLE0".repeat(2);
const PEM = (label: string) => "-----BEGIN " + label + " KEY-----";
const PEM_END = (label: string) => "-----END " + label + " KEY-----";
const JWT = "eyJ" + BODY + "." + BODY + "." + BODY;

const STRONG: [kind: string, token: string, masked: string][] = [
  ["private_key", PEM("RSA PRIVATE") + "\n" + BODY + "\n" + PEM_END("RSA PRIVATE"), "-----BEGIN…[masked]"],
  ["private_key", PEM("OPENSSH PRIVATE") + "\\n" + BODY + "\\n" + PEM_END("OPENSSH PRIVATE"), "-----BEGIN…[masked]"],
  ["private_key", PEM("PRIVATE") + "\n" + BODY, "-----BEGIN…[masked]"], // truncated block
  ["aws_access_key", "AK" + "IA" + UP, "AKIA…[masked]"],
  ["aws_access_key", "AS" + "IA" + UP, "ASIA…[masked]"],
  ["github_token", "gh" + "p_" + BODY, "ghp_…[masked]"],
  ["github_token", "gh" + "s_" + BODY, "ghs_…[masked]"],
  ["github_pat", "github" + "_pat_" + BODY, "github_pat_…[masked]"],
  ["gitlab_token", "gl" + "pat-" + BODY, "glpat-…[masked]"],
  ["slack_token", "xo" + "xb-" + BODY, "xoxb-…[masked]"],
  ["slack_webhook", "hooks.slack" + ".com/services/T000/B000/" + BODY, "hooks.slack.com/services…[masked]"],
  ["stripe_key", "sk" + "_live_" + BODY, "sk_live_…[masked]"],
  ["stripe_key", "rk" + "_test_" + BODY, "rk_test_…[masked]"],
  ["sk_key", "sk" + "-" + BODY, "sk-…[masked]"],
  ["sk_key", "sk" + "-ant-" + BODY, "sk-…[masked]"],
  ["sk_key", "sk" + "-proj-" + BODY, "sk-…[masked]"],
  ["jwt", JWT, "eyJ…[masked]"],
  ["bearer_token", "Bearer " + BODY, "Bearer …[masked]"],
  ["bearer_token", "Authorization: bearer " + BODY, "Authorization: bearer …[masked]"],
  ["bearer_token", "authorization: BEARER " + BODY, "authorization: BEARER …[masked]"],
  ["bearer_token", '"AUTHORIZATION": "bearer ' + BODY, '"AUTHORIZATION": "bearer …[masked]'],
];

const MASK_ONLY: [plain: string, masked: string][] = [
  ["API_KEY=" + BODY, "API_KEY=…[masked]"],
  ["export MY_SECRET_VALUE=" + BODY, "export MY_SECRET_VALUE=…[masked]"],
  ['"password": "' + BODY + '"', '"password": "…[masked]"'],
  ["DB_PASSWD: '" + BODY + "'", "DB_PASSWD: '…[masked]'"],
  ["https://user:hunter2@example.invalid/x", "https://user:…[masked]@example.invalid/x"],
];

const NEGATIVE = [
  "550e8400-e29b-41d4-a716-446655440000", // UUID
  "7e16a73d5f8cee3a1b2c3d4e5f60718293a4b5c6", // git SHA
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", // sha256 of nothing
  "$TOKEN",
  "<your-key>",
  "API_KEY=$TOKEN",
  "API_KEY=${API_KEY}",
  "API_KEY=<your-key>",
  "TOKEN=$(gh auth token)",
  "Bearer $TOKEN",
  "Bearer ${TOKEN}",
  "Bearer <your-key>",
  "Authorization: Bearer",
  "authorization: bearer $TOKEN",
  "authorization: bearer ${TOKEN}",
  "authorization: bearer <your-key>",
  "the bearer tokenization scheme", // lowercase prose is not a header
  "task-1794033019734-yc9awe",
  "risk-assessment-framework-for-agents",
  "gh" + "p_short",
  "AK" + "IA" + "short",
  "git@example.invalid:org/repo.git",
  "user@example.invalid",
  "http://localhost:8080/path@tag",
  "https://example.invalid/a:b@c",
  "192.0.2.10",
];

describe("mask", () => {
  test.each(STRONG)("%s: %#", (kind, token, want) => {
    expect(mask(`before ${token} after`)).not.toContain(token);
    expect(mask(token)).toBe(want);
  });
  test.each(MASK_ONLY)("mask-only %s", (plain, want) => expect(mask(plain)).toBe(want));
  test.each(NEGATIVE)("leaves %s", (s) => expect(mask(s)).toBe(s));
  test("masks several secrets in one string", () => {
    const aws = "AK" + "IA" + UP;
    expect(mask(`a ${aws} b ${aws} c`)).toBe("a AKIA…[masked] b AKIA…[masked] c");
  });
});

describe("mask(mask(x)) === mask(x)", () => {
  const fragments = [
    ...STRONG.map(([, token]) => token),
    ...MASK_ONLY.map(([plain]) => plain),
    ...NEGATIVE,
    "https://api_key:abc@h", // assignment value starts as the url_credential mask
    "key=" + "https://u:abc@h",
    "TOKEN=ab/" + "sk" + "-" + BODY,
    "PASSWORD=" + "AK" + "IA" + UP,
    "Bearer " + "AK" + "IA" + UP,
    "Authorization: Bearer " + JWT,
  ];
  test.each(fragments)("%s", (x) => expect(mask(mask(x))).toBe(mask(x)));
  test("every pair of fragments, with each joiner", () => {
    for (const a of fragments) {
      for (const b of fragments) {
        for (const join of ["", " ", "=", ":", "/", "&", '"', "\n"]) {
          const x = a + join + b;
          expect(mask(mask(x))).toBe(mask(x));
        }
      }
    }
  });
});

describe("secretKinds", () => {
  test("names every strong pattern, in table order, once", () => {
    const names = [...new Set(STRONG.map(([kind]) => kind))];
    expect(names).toHaveLength(11);
    expect(secretKinds(STRONG.map(([, token]) => token).join("\n=\n"))).toEqual(names);
  });
  test.each(STRONG)("%s: %#", (kind, token) => expect(secretKinds(token)).toContain(kind));
  test.each(MASK_ONLY)("mask-only %s is not a kind", (plain) => expect(secretKinds(plain)).toEqual([]));
  test.each(NEGATIVE)("not %s", (s) => expect(secretKinds(s)).toEqual([]));
  test("a masked secret is no longer detected", () => {
    for (const [, token] of STRONG) expect(secretKinds(mask(token))).toEqual([]);
  });
  test("a bearer JWT is both kinds", () => expect(secretKinds("Bearer " + JWT)).toEqual(["jwt", "bearer_token"]));
});

describe("secretFingerprints", () => {
  const key = "sk" + "-ant-" + BODY;
  const fp = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

  test("is the first 16 hex of the sha256 of the token", () => expect(secretFingerprints(key)).toEqual([fp(key)]));
  test("one secret typed many times is one fingerprint", () => {
    expect(secretFingerprints(`${key} x ${key} y ${key}`)).toHaveLength(1);
  });
  test("different secrets differ", () => expect(secretFingerprints(`${key} ${key}2`)).toHaveLength(2));
  test("a token has one fingerprint with or without Bearer", () => {
    expect(secretFingerprints("Bearer " + JWT)).toEqual(secretFingerprints(JWT));
    expect(secretFingerprints("Bearer " + key)).toEqual(secretFingerprints(key));
    expect(secretFingerprints("Authorization: bearer " + key)).toEqual(secretFingerprints(key));
  });
  test("a key block has one fingerprint raw and JSON-escaped", () => {
    const block = PEM("RSA PRIVATE") + "\n" + BODY + "\r\n" + PEM_END("RSA PRIVATE");
    expect(secretFingerprints(JSON.stringify({ content: block }))).toEqual(secretFingerprints(block));
  });
  test.each(MASK_ONLY)("never for mask-only %s", (plain) => expect(secretFingerprints(plain)).toEqual([]));
  test.each(NEGATIVE)("none for %s", (s) => expect(secretFingerprints(s)).toEqual([]));
});

describe("global regex state", () => {
  test("repeated and interleaved calls agree", () => {
    const s = STRONG.map(([, token]) => token).join(" ");
    const first = [mask(s), secretKinds(s), secretFingerprints(s)];
    for (let i = 0; i < 5; i++) {
      expect(secretKinds(s)).toEqual(first[1] as string[]);
      expect(secretFingerprints(s)).toEqual(first[2] as string[]);
      expect(mask(s)).toBe(first[0] as string);
      expect(secretKinds("nothing here")).toEqual([]);
    }
  });
});

describe("hostile input stays fast", () => {
  const big = 1_000_000;
  test.each([
    ["long word", "a".repeat(big)],
    ["keyword run", "key".repeat(big / 3)],
    ["auth run with spaces", "auth ".repeat(big / 5)],
    ["jwt starts", "eyJ-".repeat(big / 4)],
    ["url starts", "a://".repeat(big / 4)],
    ["key block starts", "-----BEGIN ".repeat(big / 11)],
    ["bearer run", "Bearer ".repeat(big / 7)],
    ["authorization run", "authorization: ".repeat(big / 15)],
    ["authorization spaces", "authorization" + " ".repeat(big)],
    ["whitespace after keyword", "key" + " ".repeat(big)],
  ])("%s", (_name, s) => {
    const start = performance.now();
    mask(s);
    secretKinds(s);
    secretFingerprints(s);
    expect(performance.now() - start).toBeLessThan(3000);
  });
});

test("fixtures/redacted holds no strong secret and mask is stable on every line (0007)", () => {
  const paths = (readdirSync("fixtures/redacted", { recursive: true }) as string[]).filter((f) => f.endsWith(".jsonl"));
  const bad: string[] = []; // location and pattern name only, never the text
  let lines = 0;
  for (const path of paths) {
    readFileSync(join("fixtures/redacted", path), "utf8").split("\n").forEach((line, i) => {
      lines++;
      const kinds = secretKinds(line);
      if (kinds.length) bad.push(`${path}:${i + 1}: ${kinds.join(",")}`);
      const once = mask(line);
      if (mask(once) !== once) bad.push(`${path}:${i + 1}: not idempotent`);
    });
  }
  expect(lines).toBeGreaterThan(13_000);
  expect(bad).toEqual([]);
}, 60_000);

describe("scrubHome", () => {
  test.each([
    ["/Users/x/a.ts", "/Users/x", "~/a.ts"],
    ["/Users/x", "/Users/x", "~"],
    ["/Users/x/", "/Users/x/", "~/"],
    ["cd /Users/x && ls /Users/x/a", "/Users/x", "cd ~ && ls ~/a"],
    ["file:///Users/x/a", "/Users/x", "file://~/a"],
    ["see /Users/x.", "/Users/x", "see ~."],
    ["C:\\Users\\x\\a.ts", "C:\\Users\\x", "~\\a.ts"],
    ["C:/Users/x/a.ts", "C:\\Users\\x", "~/a.ts"],
    ["C:\\Users\\x\\a.ts", "C:/Users/x", "~\\a.ts"],
    ["c:\\users\\X\\a.ts", "C:\\Users\\x", "~\\a.ts"], // Windows is case-insensitive
    ["C:\\\\Users\\\\x\\\\a.ts", "C:\\Users\\x", "~\\\\a.ts"], // JSON-escaped
    ["/c/Users/x/a.ts", "C:\\Users\\x", "~/a.ts"], // Git Bash
    ["\\\\srv\\home\\x\\a", "\\\\srv\\home\\x", "~\\a"],
  ])("%s with home %s -> %s", (s, home, want) => expect(scrubHome(s, home)).toBe(want));

  test.each([
    ["/Users/xavier/a", "/Users/x"],
    ["/Users/x-old/a", "/Users/x"],
    ["/Users/X/a", "/Users/x"], // POSIX is case-sensitive
    ["/mnt/Users/x/a", "/Users/x"],
    ["C:\\Users\\xavier\\a", "C:\\Users\\x"],
    ["D:\\Users\\x\\a", "C:\\Users\\x"],
    ["/Users/x/a", ""],
    ["/Users/x/a", "/"],
    ["C:\\a", "C:\\"],
    ["/Users/x/a", "C:\\Users\\x"],
  ])("%s stays with home %s", (s, home) => expect(scrubHome(s, home)).toBe(s));

  test("metacharacters in a home are literal", () => {
    expect(scrubHome("/home/a.b/x", "/home/a.b")).toBe("~/x");
    expect(scrubHome("/home/aXb/x", "/home/a.b")).toBe("/home/aXb/x");
    expect(scrubHome("C:\\Users\\a(b)\\x", "C:\\Users\\a(b)")).toBe("~\\x");
  });
  test("is idempotent", () => {
    const once = scrubHome("/Users/x/a", "/Users/x");
    expect(scrubHome(once, "/Users/x")).toBe(once);
  });
});

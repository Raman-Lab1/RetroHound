import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { anonymizer } from "../src/cli/wrapped.ts";
import { maskDeep } from "../src/outputs/json.ts";

const BODY = "A1b2C3d4E5".repeat(4); // defanged placeholder, built so no secret-shaped literal lands in the repo

describe("maskDeep masks object keys", () => {
  test("a secret written into a transcript line's `type` does not reach the JSON report", () => {
    const token = "gh" + "p_" + BODY;
    const out = JSON.stringify(maskDeep({ scan: { lines: { unknown_types: { [`note ${token}`]: 1 } } } }));
    expect(out).not.toContain(token);
    expect(out).toContain("note ghp_…[masked]");
  });
});

describe("anonymizer", () => {
  const projects = ["/Users/jdoe/acme/app"];

  test("hashes sibling and parent dirs under a home, keeps generic names and file names", () => {
    const fix = anonymizer([], projects);
    const out = fix("cat /Users/jdoe/clients/client-bigbank/.env && ls ~/acme-corp/notes /Users/jdoe/acme/app/src/x.ts");
    for (const name of ["jdoe", "clients", "client-bigbank", "acme"]) expect(out).not.toContain(name);
    expect(out).toContain("/.env");
    expect(out).toContain("/src/x.ts");
    expect(fix(out)).toBe(out); // already anonymized parts stay
  });

  test("ids are stable in one pack but keyed per pack, so a word list cannot confirm them", () => {
    const a = anonymizer([], projects), b = anonymizer([], projects);
    expect(a("/Users/jdoe/x")).toBe(a("/Users/JDOE/x"));
    expect(a("/Users/jdoe/x")).not.toBe(b("/Users/jdoe/x"));
    const unkeyed = createHash("sha256").update("jdoe").digest("hex").slice(0, 6);
    expect(a("jdoe")).not.toContain(unkeyed);
    expect(a("jdoe")).toMatch(/^anon-[0-9a-f]{12}$/);
  });
});

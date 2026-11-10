// first_seen_project / first_seen_global (ADR 0016). Defanged: example.invalid, placeholder names only.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate } from "../../src/engine/evaluate.ts";
import { firstSeenOf, setFirstSeen, type FirstSeen } from "../../src/engine/first-seen.ts";
import { loadEnforceRules } from "../../src/hooks/run.ts";
import type { RawEvent } from "../../src/normalize/types.ts";
import { openStore } from "../../src/store/index.ts";
import { compile, event, reason, ruleYaml } from "./helpers.ts";

const base = mkdtempSync(join(tmpdir(), "rh-first-seen-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));
afterEach(() => setFirstSeen());

const day = (d: number, h = 0) => new Date(Date.UTC(2026, 0, 1 + d, h)).toISOString();
const REQ = "x-retrohound: { requires: [first_seen] }\n";
const rule = (field: string, header = REQ) => compile(ruleYaml(`selection: { ${field}: true }\ncondition: selection`, "product: ai_coding_agent", header));

// The anchor makes the data span the cold-start window; it carries no first-seen kind.
const anchor = (d = 20) => event({ id: `anchor${d}`, ts: day(d) });
const ids = (fs: FirstSeen) => ({ project: [...fs.project].sort(), global: [...fs.global].sort() });

describe("firstSeenOf", () => {
  const kinds: [string, Partial<RawEvent>, Partial<RawEvent>][] = [
    ["domain", { domain: "a.example.invalid" }, { domain: "b.example.invalid" }],
    ["mcp server", { mcp_server: "srv_a" }, { mcp_server: "srv_b" }],
    ["hook command", { tool_name: "hook:PreToolUse", command_line: "./hook-a.sh" }, { tool_name: "hook:PreToolUse", command_line: "./hook-b.sh" }],
    ["skill", { attribution: "skill:alpha" }, { attribution: "skill:beta" }],
    ["plugin", { attribution: "plugin:alpha" }, { attribution: "plugin:beta" }],
  ];
  for (const [kind, a, b] of kinds) {
    test(`${kind}: the earliest carrier of each value, later repeats not`, () => {
      const evs = [
        event({ id: "a2", ts: day(3), project_path: "/p", ...a }),
        event({ id: "a1", ts: day(1), project_path: "/p", ...a }),
        event({ id: "b1", ts: day(2), project_path: "/p", ...b }),
        anchor(),
      ];
      expect(ids(firstSeenOf(evs))).toEqual({ project: ["a1", "b1"], global: ["a1", "b1"] });
    });
  }

  test("other values do not count: a Bash command, an mcp: attribution, a hook with no command", () => {
    const evs = [
      event({ id: "x1", ts: day(1), tool_name: "Bash", command_line: "ls" }),
      event({ id: "x2", ts: day(1), attribution: "mcp:srv" }),
      event({ id: "x3", ts: day(1), tool_name: "hook:Stop" }),
      event({ id: "x4", ts: day(1), domain: "" }),
      anchor(),
    ];
    expect(ids(firstSeenOf(evs))).toEqual({ project: [], global: [] });
  });

  test("project scope restarts per project; global does not", () => {
    const evs = [
      event({ id: "p1", ts: day(1), project_path: "/one", domain: "a.example.invalid" }),
      event({ id: "p2", ts: day(2), project_path: "/two", domain: "A.example.invalid" }), // domains compare case-folded
      event({ id: "p3", ts: day(3), project_path: "/two", domain: "a.example.invalid" }),
      anchor(),
    ];
    expect(ids(firstSeenOf(evs))).toEqual({ project: ["p1", "p2"], global: ["p1"] });
  });

  test("a ts tie goes to the smaller id", () => {
    const evs = [event({ id: "t2", ts: day(1), mcp_server: "s" }), event({ id: "t1", ts: day(1), mcp_server: "s" }), anchor()];
    expect(ids(firstSeenOf(evs)).global).toEqual(["t1"]);
  });

  test("cold start: all false until the events span 14 days, earliest to latest", () => {
    const evs = [event({ id: "c1", ts: day(1), domain: "a.example.invalid" }), event({ id: "bad", ts: "not a time" })];
    expect(ids(firstSeenOf([...evs, event({ id: "late", ts: day(14, 23) })])).global).toEqual([]); // 13 days 23 h
    expect(ids(firstSeenOf([...evs, event({ id: "late", ts: day(15) })])).global).toEqual(["c1"]);
  });
});

describe("the index gives the same answer as the in-memory pre-pass", () => {
  test("every kind, both scopes, ties, case", () => {
    const evs: RawEvent[] = [
      event({ id: "d1", ts: day(2), project_path: "/one", domain: "a.example.invalid" }),
      event({ id: "d2", ts: day(1), project_path: "/two", domain: "A.example.invalid" }),
      event({ id: "d3", ts: day(3), domain: "a.example.invalid" }),
      event({ id: "m2", ts: day(4), project_path: "/one", mcp_server: "srv" }),
      event({ id: "m1", ts: day(4), project_path: "/one", mcp_server: "srv" }),
      event({ id: "h1", ts: day(5), project_path: "/one", tool_name: "hook:PreToolUse", command_line: "./h.sh" }),
      event({ id: "h2", ts: day(6), project_path: "/two", tool_name: "hook:PreToolUse", command_line: "./h.sh" }),
      event({ id: "h3", ts: day(1), tool_name: "Bash", command_line: "./h.sh" }),
      event({ id: "s1", ts: day(7), project_path: "/one", attribution: "skill:alpha" }),
      event({ id: "s2", ts: day(8), project_path: "/one", attribution: "plugin:beta", domain: "b.example.invalid" }),
      event({ id: "s3", ts: day(9), project_path: "/one", attribution: "mcp:srv" }),
      anchor(),
    ];
    const store = openStore(join(base, "parity.db"));
    try {
      store.transaction(() => store.upsertEvents("f.jsonl", evs));
      expect(ids(store.firstSeen())).toEqual(ids(firstSeenOf(evs)));
      expect(ids(store.firstSeen())).toEqual({
        project: ["d1", "d2", "d3", "h1", "h2", "m1", "s1", "s2"],
        global: ["d2", "h1", "m1", "s1", "s2"],
      });
    } finally {
      store.close();
    }
  });
});

describe("rules", () => {
  test("a rule reads the pre-pass result, across sessions; with none in place both are false", () => {
    const evs = [event({ id: "a", session_id: "s1", ts: day(1), domain: "a.example.invalid" }), event({ id: "b", session_id: "s2", ts: day(2), domain: "a.example.invalid" }), anchor()];
    const g = rule("first_seen_global");
    const hit = (r: typeof g, ev: RawEvent) => evaluate([r], [ev]).length > 0;
    expect(hit(g, evs[0]!)).toBe(false);
    setFirstSeen(firstSeenOf(evs));
    expect(evs.map((e) => hit(g, e))).toEqual([true, false, false]);
    expect(evs.map((e) => hit(rule("first_seen_project"), e))).toEqual([true, false, false]);
    expect(hit(compile(ruleYaml("selection: { first_seen_global: false }\ncondition: selection", "product: ai_coding_agent", REQ)), evs[1]!)).toBe(true);
  });

  test("reading a first_seen field needs requires: [first_seen]", () => {
    expect(reason(ruleYaml("selection: { first_seen_project: true }\ncondition: selection"))).toBe("first-seen-not-required");
    expect(reason(ruleYaml("selection: { first_seen_global: true }\ncondition: selection", "product: ai_coding_agent", "x-retrohound: { requires: [] }\n"))).toBe("first-seen-not-required");
  });

  test("requires takes known values only, on detections only, and never with lane enforce", () => {
    const sel = "selection: { first_seen_global: true }\ncondition: selection";
    expect(reason(ruleYaml(sel, "product: ai_coding_agent", "x-retrohound: { requires: [history] }\n"))).toBe("bad-x-retrohound");
    expect(reason(ruleYaml(sel, "product: ai_coding_agent", "x-retrohound: { requires: first_seen }\n"))).toBe("bad-x-retrohound");
    expect(reason(ruleYaml(sel, "product: ai_coding_agent", "x-retrohound: { requires: [first_seen], lane: enforce }\n"))).toBe("first-seen-enforce");
    expect(reason(`title: C\ncorrelation: { type: event_count, rules: [x], group-by: [session_id], timespan: 1h, condition: { gte: 1 } }\nx-retrohound: { requires: [first_seen] }\n`)).toBe("bad-x-retrohound");
    expect(reason(ruleYaml("selection: { first_seen_global: yes }\ncondition: selection", "product: ai_coding_agent", REQ))).toBe("bad-value");
  });

  test("the live hook never loads a first_seen rule", () => {
    const dir = join(base, "hook-rules");
    mkdirSync(dir);
    const body = (lane: string) => `title: New domain\nname: nd-${lane}\nlogsource: { product: ai_coding_agent }\n` +
      `detection:\n    selection: { first_seen_global: true }\n    condition: selection\nx-retrohound: { lane: ${lane}, requires: [first_seen] }\n`;
    writeFileSync(join(dir, "a.yml"), body("enforce"));
    writeFileSync(join(dir, "b.yml"), body("hunt"));
    expect(loadEnforceRules(dir, join(base, "hook-cache.json"))).toEqual([]);
  });
});

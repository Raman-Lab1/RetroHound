// `rules convert` and the pySigma pipelines it passes on. A fake `sigma` on a temp PATH stands in for sigma-cli.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { main } from "../../src/cli/main.ts";
import type { IO } from "../../src/cli/io.ts";
import { isDerived, resolveField } from "../../src/engine/modifiers.ts";
import type { RawEvent } from "../../src/normalize/types.ts";
import { toNdjson } from "../../src/outputs/ndjson.ts";
import type { ScanReport } from "../../src/outputs/report.ts";
import { DEFAULT_RULES_DIR, PIPELINES_DIR } from "../../src/version.ts";

// Every contract field set (tsc fails here when RawEvent gains one), each value distinct so a mapping cannot pass by luck.
const EV: Required<RawEvent> = {
  id: "evt-1", schema_version: "0.1", agent: "codex", agent_version: "0.9.1", session_id: "sess-1", parent_session_id: "psess-1",
  agent_id: "agent-1", parent_tool_use_id: "ptu-1", project_path: "/work/acme", ts: "2026-09-14T10:00:00.000Z", seq: 7,
  category: "web_request", tool_name: "WebFetch", command_line: "curl https://example.invalid/x", target_path: "/work/acme/out.txt",
  url: "https://example.invalid/y", domain: "example.invalid", mcp_server: "srv", mcp_tool: "tl", outcome: "blocked",
  permission_mode: "auto", prompt_source: "typed", entrypoint: "cli", attribution: "skill:x", denial_kind: "user-rejected",
  denial_category: "dc", secret_kinds: ["sk"], result_secret_kinds: ["rsk"], secret_fps: ["0123456789abcdef"], text_excerpt: "excerpt",
  raw_ref: { file: "x.jsonl", line: 3 }, content: "body", tool_input: "{}", tool_response: "resp", text: "prompt",
};
const DERIVED = ["target_outside_project", "command_line_unquoted", "download_executed", "first_seen_session"];
const ALIASES = ["CommandLine", "TargetFilename", "CurrentDirectory"];

const report: ScanReport = {
  schema: "retrohound.scan/0.1", tool: { name: "retrohound", version: "0.0.0" },
  scan: {
    started_at: "2026-11-07T10:00:00Z", finished_at: "2026-11-07T10:00:03Z", sessions: 1, events: 1, blocked: 1, subagent_events: 0,
    files: { indexed: 1, skipped: 0, gone: 0, failed: 0 }, archived_sessions: [], root: "/r",
  },
  rules: [{ id: "r1", name: "n", title: "T", level: "high", tags: [], lane: "hunt" }],
  findings: [{ id: "f1", rule_id: "r1", level: "high", ts: EV.ts, session_id: EV.session_id, message: "m", events: [EV] }],
};

/** Dotted path -> every leaf value under it; arrays are walked through, as OCSF attribute paths and SIEMs read them. */
function flat(v: unknown, path = "", out = new Map<string, string[]>()) {
  if (Array.isArray(v)) for (const x of v) flat(x, path, out);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) flat(x, path ? `${path}.${k}` : k, out);
  else if (v !== undefined) out.set(path, [...(out.get(path) ?? []), String(v)]);
  return out;
}

type Item = { type: string; mapping?: Record<string, string>; rule_conditions: { product?: string }[];
  field_name_conditions?: { mode?: string; fields: string[] }[] };

for (const schema of ["ecs", "ocsf"] as const) {
  describe(`pipeline ${schema}.yml`, () => {
    const items = (parse(readFileSync(join(PIPELINES_DIR, `${schema}.yml`), "utf8")) as { transformations: Item[] }).transformations;
    const mapping = items.find((t) => t.type === "field_name_mapping")!.mapping!;
    const conds = items.filter((t) => t.type === "detection_item_failure").flatMap((t) => t.field_name_conditions!);
    const unmapped = conds.filter((c) => c.mode !== "re").flatMap((c) => c.fields);
    const derived = conds.filter((c) => c.mode === "re").flatMap((c) => c.fields).map((p) => new RegExp(`^(?:${p})`)); // re.match
    const emitted = flat(JSON.parse(toNdjson(report, schema)));

    test("applies only to product ai_coding_agent", () => {
      for (const t of items) for (const c of t.rule_conditions) expect(c.product).toBe("ai_coding_agent");
    });

    test("every field is mapped, unmapped or derived, exactly one", () => {
      for (const f of [...Object.keys(EV), ...DERIVED, ...ALIASES]) {
        const hits = [f in mapping, unmapped.includes(f), derived.some((r) => r.test(f))].filter(Boolean);
        expect({ f, hits: hits.length }).toEqual({ f, hits: 1 });
      }
      for (const f of DERIVED.slice(0, 3)) expect(isDerived(f)).toBe(true);
      for (const f of [...Object.keys(mapping), ...unmapped]) expect(() => resolveField(f)).not.toThrow();
    });

    test(`mapped names carry the event's value in ndjson-${schema}`, () => {
      for (const [f, target] of Object.entries(mapping)) {
        const want = String(EV[resolveField(f) as keyof RawEvent]);
        expect({ f, target, values: emitted.get(target) }).toEqual({ f, target, values: expect.arrayContaining([want]) });
      }
    });
  });
}

describe("rules convert", () => {
  const dir = mkdtempSync(join(tmpdir(), "rh-convert-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const fake = join(dir, "bin");
  const empty = join(dir, "empty");
  mkdirSync(fake);
  mkdirSync(empty);
  writeFileSync(join(fake, "sigma"), '#!/bin/sh\nfor a in "$@"; do echo "$a"; done\n');
  chmodSync(join(fake, "sigma"), 0o755);

  const run = async (argv: string[], path: string) => {
    let out = "";
    let err = "";
    const io: IO = { out: (s) => (out += s), err: (s) => (err += s), isTTY: false, env: { PATH: path } };
    return { code: await main(["rules", "convert", ...argv], io), out, err };
  };

  test.skipIf(process.platform === "win32")("runs sigma from PATH with the pipeline file, no shell, output streamed", async () => {
    const r = await run(["-t", "splunk", "--pipeline", "ocsf", "a b.yml", "$(x);y.yml"], fake);
    expect(r).toEqual({ code: 0, err: "", out: ["convert", "-t", "splunk", "-p", join(PIPELINES_DIR, "ocsf.yml"), "--", "a b.yml", "$(x);y.yml", ""].join("\n") });
    expect(existsSync(join(PIPELINES_DIR, "ocsf.yml"))).toBe(true);
    const d = await run(["-t", "splunk", "--pipeline", "ecs", "-s"], fake);
    expect(d.out.split("\n").slice(4, 8)).toEqual([join(PIPELINES_DIR, "ecs.yml"), "-s", "--", DEFAULT_RULES_DIR]);
  });

  test("no sigma on PATH: exit 2 with a one-line install hint", async () => {
    const r = await run(["-t", "splunk", "--pipeline", "ecs"], empty);
    expect(r.code).toBe(2);
    expect(r.err.trim().split("\n")).toHaveLength(1);
    expect(r.err).toContain("pipx install sigma-cli");
  });

  test("an unknown pipeline is a usage error", async () => {
    expect((await run(["-t", "splunk", "--pipeline", "splunk"], empty)).code).toBe(2);
  });
});

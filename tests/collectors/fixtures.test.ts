// Real transcript shapes: goldens on one main + one sub-agent file, smoke over all of fixtures/redacted.
// Regenerate goldens after an intended parser change: UPDATE_GOLDEN=1 bun test tests/collectors
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { discover } from "../../src/collectors/claude-code/discover.ts";
import { parseFile } from "../../src/collectors/claude-code/v1.ts";
import { secretKinds } from "../../src/normalize/mask.ts";
import type { RawEvent } from "../../src/normalize/types.ts";

const TEAM = "fixtures/redacted/-Users-user1-Desktop-proj18/000017a9-0000-4000-8000-000000000000";
const GOLDENS: [string, string][] = [
  ["main", "fixtures/redacted/-Users-user1-Desktop-proj10/00005373-0000-4000-8000-000000000000.jsonl"],
  ["subagent", `${TEAM}/subagents/agent-aplanner-0000000000001847.jsonl`],
];

const digest = (s?: string) => s && createHash("sha256").update(s).digest("hex").slice(0, 12);

/** Everything the parser decides, with long text as a digest so goldens stay small and free of transcript text. */
function project({ schema_version, agent, raw_ref, command_line, content, tool_input, tool_response, text, ...rest }: RawEvent) {
  return { ...rest, file: raw_ref.file, line: raw_ref.line, command_line: digest(command_line), content: digest(content), tool_input: digest(tool_input), tool_response: digest(tool_response), text: digest(text) };
}

describe("goldens", () => {
  test.each(GOLDENS)("%s", async (name, source) => {
    const { events, stats } = await parseFile(source);
    const actual = JSON.stringify({ stats, events: events.map(project) }, null, 1) + "\n";
    const golden = `tests/collectors/golden/${name}.json`;
    if (process.env.UPDATE_GOLDEN) writeFileSync(golden, actual);
    expect(actual).toBe(readFileSync(golden, "utf8").replaceAll("\r\n", "\n"));
    expect(secretKinds(actual)).toEqual([]);
  });
});

describe("smoke over all of fixtures/redacted", () => {
  test("no crash, no malformed line, no unknown type, contract holds", async () => {
    const files = discover("fixtures/redacted");
    expect(files).toHaveLength(12);
    const counts: Record<string, number> = {};
    let toolEvents = 0;
    for (const file of files) {
      const { events, stats } = await parseFile(file);
      expect(stats.malformed).toBe(0);
      expect(stats.unknown_types).toEqual({});
      for (const ev of events) {
        counts[ev.category] = (counts[ev.category] ?? 0) + 1;
        if (ev.tool_input) toolEvents++;
        expect(ev.ts).toMatch(/^\d{4}-\d\d-\d\dT/);
        for (const field of Object.values(ev)) expect(field).not.toBeUndefined();
        for (const key of ["secret_kinds", "secret_fps", "result_secret_kinds"] as const) expect(ev[key]?.length).not.toBe(0);
        if (file.includes("/subagents/")) expect(ev.parent_tool_use_id).toBeTruthy();
      }
    }
    expect(toolEvents).toBe(1427); // tool_use blocks in the fixtures: api-request-blob copies do not count
    expect(counts.process_creation).toBe(907 + 1 + 1951); // Bash calls + Monitor + hook runs
    expect(counts.config_change).toBe(423);
    expect(counts.instruction_load).toBe(33);
  }, 60_000);
});

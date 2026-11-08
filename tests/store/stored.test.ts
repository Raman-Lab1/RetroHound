import { describe, expect, test } from "bun:test";
import { secretFingerprints, secretKinds } from "../../src/normalize/mask.ts";
import { toStored } from "../../src/normalize/stored.ts";
import type { RawEvent } from "../../src/normalize/types.ts";

// Defanged placeholders, built by concatenation so no secret-shaped literal lands in the repo.
const BODY = "A1b2C3d4E5".repeat(4);
const SECRETS: [kind: string, token: string][] = [
  ["private_key", "-----BEGIN RSA PRIVATE" + " KEY-----\n" + BODY + "\n-----END RSA PRIVATE" + " KEY-----"],
  ["aws_access_key", "AK" + "IA" + "EXAMPLE0EXAMPLE0"],
  ["github_token", "gh" + "p_" + BODY],
  ["github_pat", "github" + "_pat_" + BODY],
  ["gitlab_token", "gl" + "pat-" + BODY],
  ["slack_token", "xo" + "xb-" + BODY],
  ["slack_webhook", "hooks.slack" + ".com/services/T000/B000/" + BODY],
  ["stripe_key", "sk" + "_live_" + BODY],
  ["sk_key", "sk" + "-ant-" + BODY],
  ["jwt", "eyJ" + BODY + "." + BODY + "." + BODY],
  ["bearer_token", "Authorization: Bearer " + BODY],
  ["assignment", "API_KEY=" + BODY],
  ["url_credential", "https://user:" + BODY + "@example.invalid/x"],
];

/** A literal listing every field, so a new contract field fails tsc here until toStored and this test know it. */
function everyField(v: string): Required<RawEvent> {
  return {
    id: v,
    schema_version: v as "0.1",
    agent: v as "claude_code",
    agent_version: v,
    session_id: v,
    parent_session_id: v,
    agent_id: v,
    parent_tool_use_id: v,
    project_path: v,
    ts: v,
    seq: 7,
    category: v as "mcp",
    tool_name: v,
    command_line: v,
    target_path: v,
    url: v,
    domain: v,
    mcp_server: v,
    mcp_tool: v,
    outcome: v as "error",
    permission_mode: v,
    prompt_source: v,
    entrypoint: v,
    attribution: v,
    denial_kind: v,
    denial_category: v,
    secret_kinds: [v],
    result_secret_kinds: [v],
    secret_fps: [v],
    text_excerpt: v,
    raw_ref: { file: v, line: 9 },
    content: v,
    tool_input: v,
    tool_response: v,
    text: v,
  };
}
const MATCH_ONLY = ["content", "tool_input", "tool_response", "text"];

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return typeof value === "object" && value ? Object.values(value).flatMap(strings) : [];
}

const minimal: RawEvent = {
  id: "e1",
  schema_version: "0.1",
  agent: "claude_code",
  session_id: "s1",
  ts: "2026-11-07T00:00:00.000Z",
  seq: 1,
  category: "tool_call",
  raw_ref: { file: "/transcripts/s1.jsonl", line: 1 },
};

describe("toStored", () => {
  test.each(SECRETS)("%s in every string field leaves nothing", (_kind, token) => {
    const out = toStored(everyField(`before ${token} after`));
    const json = JSON.stringify(out);
    expect(json).not.toContain(BODY);
    expect(json).not.toContain(token);
    expect(secretKinds(json)).toEqual([]);
    expect(secretFingerprints(json)).toEqual([]);
    for (const value of strings(out)) expect(secretKinds(value)).toEqual([]);
  });

  test("the masking is not passing by accident: the raw event does hold every secret", () => {
    for (const [kind, token] of SECRETS.slice(0, 11)) expect(secretKinds(token)).toContain(kind);
  });

  test("keeps every allow-listed field, and only those", () => {
    const out = toStored(everyField("value"));
    const expected = Object.keys(everyField("value")).filter((k) => !MATCH_ONLY.includes(k));
    expect(Object.keys(out).sort()).toEqual(expected.sort());
    expect(out.schema_version).toBe("0.1");
    expect([out.seq, out.raw_ref.line]).toEqual([7, 9]);
    expect(out.secret_kinds).toEqual(["value"]);
    expect(out.command_line).toBe("value");
  });

  test("match-only fields cannot come through", () => {
    const out = toStored({ ...minimal, content: "c", tool_input: "i", tool_response: "r", text: "t" });
    for (const key of MATCH_ONLY) expect(key in out).toBe(false);
  });

  test("an unknown property does not survive, at either level", () => {
    const secret = "sk" + "-" + BODY;
    const raw = { ...minimal, future_field: secret, raw_ref: { ...minimal.raw_ref, snippet: secret } };
    const out = toStored(raw);
    expect(JSON.stringify(out)).not.toContain(BODY);
    expect(Object.keys(out.raw_ref).sort()).toEqual(["file", "line"]);
    expect("future_field" in out).toBe(false);
  });

  test("absent stays absent and empty lists are dropped, so |exists stays false", () => {
    const out = toStored({ ...minimal, secret_kinds: [], result_secret_kinds: [], secret_fps: [] });
    expect(Object.keys(out).sort()).toEqual(Object.keys(minimal).sort());
  });

  test("tolerates null from a parser that passed a JSON null along", () => {
    const out = toStored({ ...minimal, agent_version: null } as unknown as RawEvent);
    expect("agent_version" in out).toBe(false);
  });

  test("the excerpt is cut to 500 after masking, so a secret across the cut cannot leave a tail", () => {
    const token = "sk" + "-" + BODY;
    const out = toStored({ ...minimal, text_excerpt: "x".repeat(490) + " " + token + " end" });
    expect(out.text_excerpt?.length).toBe(500);
    expect(out.text_excerpt).not.toContain(BODY.slice(0, 8));
    expect(toStored({ ...minimal, text_excerpt: "short" }).text_excerpt).toBe("short");
  });

  test("is idempotent and leaves its input alone", () => {
    const raw = everyField("TOKEN=" + BODY);
    const before = structuredClone(raw);
    const once = toStored(raw);
    expect(toStored(once)).toEqual(once);
    expect(raw).toEqual(before);
    expect(once.raw_ref).not.toBe(raw.raw_ref);
  });
});

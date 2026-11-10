// The footprint page from hand-built Footprint objects (no index): loads and runs nothing, escapes hostile values
// everywhere, masks secrets, and renders an empty index and a full year of activity.
import { describe, expect, test } from "bun:test";
import { renderFootprint } from "../../src/footprint/html.ts";
import type { Footprint, Seen } from "../../src/footprint/types.ts";

const KEY = "AKIA" + "ABCDEFGHIJKLMNOP"; // placeholder in the AWS key shape, split so no file holds it whole
const EVIL = "</details><script>alert(1)</script>";
const QUOTED = `0123abcd" onmouseover="x`; // breaks out of title="..." unless escaped
const T0 = "2026-10-01T09:00:00Z";
const T1 = "2026-11-09T17:00:00Z";
const seen = (name: string, more: Partial<Seen> = {}): Seen =>
  ({ name, events: 10, sessions: 2, blocked: 1, sub_agent: 4, first_ts: T0, last_ts: T1, ...more });
const days = (n: number) => Array.from({ length: n }, (_, i) =>
  ({ day: new Date(Date.UTC(2025, 10, 11) + i * 864e5).toISOString().slice(0, 10), events: 1 + (i % 7) * 3, blocked: i % 5 ? 0 : 1, findings: i % 11 ? 0 : 2 }));

export function sample(): Footprint {
  return {
    generated_at: T1, tool_version: "0.2.0",
    trust: { chain: { ok: true, entries: 1234, head: "9f2c4e6a8b0d1f3e5a7c9e1b3d5f7a9c" }, files: { indexed: 48, gone: 6 },
      archived_sessions: 3, retention_days: 30, first_ts: T0, last_ts: T1 },
    totals: { agents: 2, projects: 3, sessions: 9, events: 4321, sub_agent_events: 1100, blocked: 17, secrets: 2,
      findings: { informational: 4, low: 3, medium: 2, high: 1, critical: 1 } },
    activity: days(40),
    agents: [{ agent: "claude-code", sessions: 7, events: 4000, projects: [
      { project: `/home/dev/${EVIL}`, sessions: 2, events: 900, blocked: 5, findings: 3, worst: "critical", list: [
        { session_id: QUOTED, first_ts: T0, last_ts: T1, events: 600, blocked: 5, findings: 3, worst: "critical", archived: true,
          sub_agents: [{ agent_id: "a1b2c3d4e5f60718", events: 120, blocked: 2 }] },
        { session_id: "fedcba9876543210", first_ts: T0, last_ts: T1, events: 300, blocked: 0, findings: 0, archived: false, sub_agents: [] }] },
      { project: "-", sessions: 5, events: 3100, blocked: 0, findings: 1, worst: "medium", list: [] }] },
    { agent: "codex", sessions: 2, events: 321, projects: [] }],
    tools: { mcp_servers: [seen("filesystem"), seen("browser", { blocked: 0 })],
      hooks: [seen(`curl example.invalid -H "x-api-key: ${KEY}"`, { detail: "hook:PreToolUse" })], attributions: [seen("skill:review")] },
    domains: [seen("example.invalid", { events: 40 }), seen("192.0.2.10", { events: 5 })],
    secrets: [{ fingerprint: "fp:3a7d19c2", kinds: ["aws_access_key"], sessions: 2, sub_agents: 1, projects: ["/home/dev/app"],
      domains: ["example.invalid"], first_ts: T0, last_ts: T1 }],
    modes: [{ mode: "default", events: 3000, sessions: 8, sub_agent: 900 }, { mode: "bypassPermissions", events: 1200, sessions: 2, sub_agent: 200 },
      { mode: "auto", events: 121, sessions: 1, sub_agent: 0 }],
    blocked: { kinds: [{ name: "user_denied", count: 12 }], categories: [{ name: "process_creation", count: 17 }] },
    findings: [{ level: "critical", rule: "Cloud key in command", ts: T1, session_id: QUOTED, project: "/home/dev/app", agent_id: "a1b2c3d4e5f60718",
      message: `ran: aws configure set aws_access_key_id ${KEY}` }, { level: "low", rule: EVIL, ts: T0, session_id: "fedcba9876543210", project: "-", message: "ok" }],
    omitted: { sessions: 0, findings: 4, domains: 0, secrets: 0, tools: 2 },
  };
}

function empty(): Footprint {
  return {
    generated_at: T1, tool_version: "0.2.0", trust: { chain: null, files: { indexed: 0, gone: 0 }, archived_sessions: 0 },
    totals: { agents: 0, projects: 0, sessions: 0, events: 0, sub_agent_events: 0, blocked: 0, secrets: 0,
      findings: { informational: 0, low: 0, medium: 0, high: 0, critical: 0 } },
    activity: [], agents: [], tools: { mcp_servers: [], hooks: [], attributions: [] }, domains: [], secrets: [], modes: [],
    blocked: { kinds: [], categories: [] }, findings: [], omitted: { sessions: 0, findings: 0, domains: 0, secrets: 0, tools: 0 },
  };
}

describe("renderFootprint", () => {
  const html = renderFootprint(sample());

  test("loads nothing and runs nothing", () => {
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`);
    expect(html).not.toMatch(/<script|<link|<img|<iframe|<object|<embed|\b(?:src|href|action)\s*=|url\(|@import/i);
    expect(html).not.toMatch(/https?:\/\//i);
    expect(html).toContain("Nothing on this page was fetched or sent.");
  });

  test("hostile values are escaped in text and attributes", () => {
    expect(html).toContain("&lt;/details&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain(`title="0123abcd&quot; onmouseover=&quot;x"`);
    expect(html).not.toContain(`" onmouseover="`);
    expect(html.match(/<details/g)!.length).toBe(html.match(/<\/details>/g)!.length);
  });

  test("secrets in messages and hook commands are masked", () => {
    expect(html).not.toContain(KEY);
    expect(html).toContain("…[masked]");
  });

  test("the sections an analyst reads", () => {
    expect(html).toContain("hash chain intact: 1234 entries, head 9f2c4e6a8b0d<");
    expect(html).toContain(`<li class="warn">Claude Code deletes transcripts after 30 days`);
    expect(html).toContain(`<div class="t hot"><b>1</b>critical findings</div>`);
    expect(html).toContain("<code>retrohound show 0123abcd</code>");
    expect(html).toContain("domains contacted in the same sessions");
    expect(html).toContain(`<span class="bad">bypassPermissions</span>`);
    expect(html).toContain(`<span class="bad">auto</span>`);
    expect(html).toContain("4 more findings not shown; use <code>retrohound query</code>");
    expect(html).not.toContain("more sessions not shown");
  });

  test("an empty index still renders a whole page", () => {
    const e = renderFootprint(empty());
    expect(e).toContain("index predates the hash chain");
    expect(e).not.toContain("<svg");
    expect(e.match(/>none</g)!.length).toBeGreaterThanOrEqual(10);
    expect(e.endsWith("</body></html>\n")).toBe(true);
  });

  test("one bar per day, for 1 day and for 365", () => {
    for (const n of [1, 365]) {
      const page = renderFootprint({ ...sample(), activity: days(n) });
      expect(page.match(/<g><title>/g)!.length).toBe(n);
      expect(page).toContain(`viewBox="0 0 ${Math.max(30, n)} 45"`);
    }
  });
});

import { describe, expect, test } from "bun:test";
import { renderWrapped, renderWrappedSvg, type WrappedData } from "../../src/outputs/wrapped.ts";

const base: WrappedData = {
  period: "since 2026-01-01", anonymized: false, sessions: 2, hours: 1.5, commands: 3, files: 4, secretsTouched: 1,
  blocked: 2, subagentPct: 40, domains: [{ name: "example.invalid", count: 3 }], rules: [{ name: "r", level: "high", count: 1 }],
};
const FAKE = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";

describe("renderWrapped", () => {
  test("escapes hostile strings", () => {
    const html = renderWrapped({ ...base, spiciest: { command: "<script>alert(1)</script>", rule: '"x"', level: "high" } });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
  test("masks a planted secret", () => {
    const html = renderWrapped({ ...base, spiciest: { command: `curl -H "Authorization: token ${FAKE}"`, rule: "r", level: "high" } });
    expect(html).not.toContain(FAKE);
  });
  test("self-contained: no external references", () => {
    const html = renderWrapped(base);
    expect(html).not.toMatch(/(src|href|url\()\s*=?\s*["']?https?:/i);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<link");
  });
  describe("renderWrappedSvg", () => {
    const hostile = `<&>"' x`;
    const wellFormed = (x: string) => {
      const body = x.replace(/^<\?xml[^>]*\?>\s*/, "");
      const stack: string[] = [];
      for (const m of body.matchAll(/<(\/?)([a-zA-Z][\w:-]*)[^>]*?(\/?)>|<(?!\/?[a-zA-Z])|&(?!(?:amp|lt|gt|quot|#39);)/g)) {
        if (!m[2]) throw new Error(`bare ${m[0]}`);
        if (m[3]) continue;
        if (!m[1]) stack.push(m[2]);
        else if (stack.pop() !== m[2]) throw new Error(`mismatched ${m[2]}`);
      }
      return stack.length === 0;
    };
    const svg = renderWrappedSvg({ ...base, rules: [{ name: hostile, level: "high", count: 1 }] });
    test("is well-formed XML with the card size", () => {
      expect(wellFormed(svg)).toBe(true);
      expect(svg).toContain('width="1200" height="630"');
      expect(() => wellFormed("<svg><g></svg>")).toThrow(); // the checker itself catches breakage
      expect(() => wellFormed("<svg>a & b</svg>")).toThrow();
    });
    test("escapes <&>\"' in values", () => {
      expect(svg).toContain("&lt;&amp;&gt;&quot;&#39; x");
      expect(svg).not.toContain(hostile);
    });
    test("no external references or scripts", () => {
      expect(svg.replace('xmlns="http://www.w3.org/2000/svg"', "")).not.toMatch(/https?:/i);
      expect(svg).not.toContain("<script");
      expect(svg).not.toMatch(/<(image|link|style|foreignObject)/i);
    });
    test("masks a planted secret", () => {
      expect(renderWrappedSvg({ ...base, rules: [{ name: `token ${FAKE}`, level: "high", count: 1 }] })).not.toContain(FAKE);
    });
    test("shows headline numbers and handles empty rules", () => {
      const e = renderWrappedSvg({ ...base, rules: [], anonymized: true });
      expect(e).toContain("40%");
      expect(e).toContain("(anonymized)");
      expect(e).toContain("none");
    });
  });
  test("empty data renders", () => {
    const html = renderWrapped({ ...base, sessions: 0, domains: [], rules: [] });
    expect(html).toContain("none");
    expect(html).toContain("<!doctype html>");
  });
});

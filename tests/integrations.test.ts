// SIEM, DFIR and packaging integrations (docs/integrations.md): the files parse, Wazuh covers every level, and every
// pinned version matches package.json.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { LEVELS } from "../src/normalize/types.ts";
import { SEVERITY } from "../src/outputs/sarif.ts";

const root = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const { version } = JSON.parse(read("package.json")) as { version: string };

/** Tiny well-formedness check: balanced tags, one root element, no `--` inside comments. Throws on the first error. */
function checkXml(src: string): void {
  for (const c of src.matchAll(/<!--([\s\S]*?)-->/g)) if (c[1]!.includes("--")) throw new Error("'--' inside a comment");
  const body = src.replace(/<!--[\s\S]*?-->/g, "");
  if (body.includes("<!--")) throw new Error("unclosed comment");
  const stack: string[] = [];
  let roots = 0;
  for (const m of body.matchAll(/<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w.:@-]+\s*=\s*"[^"<]*")*)\s*(\/?)>/g)) {
    const [, close, name, , self] = m;
    if (close) {
      if (stack.pop() !== name) throw new Error(`unexpected </${name}>`);
    } else {
      if (!stack.length) roots++;
      if (!self) stack.push(name!);
    }
  }
  if (stack.length) throw new Error(`unclosed <${stack.at(-1)}>`);
  if (roots !== 1) throw new Error(`${roots} root elements`);
  // a stray `<` or `&` that is not markup or an entity
  const text = body.replace(/<\/?[A-Za-z_][^<>]*>/g, "");
  if (/<|&(?!(?:amp|lt|gt|quot|apos|#\d+);)/.test(text)) throw new Error("stray < or &");
}

describe("xml check", () => {
  test("accepts well-formed and rejects broken documents", () => {
    expect(() => checkXml('<a x="1"><b/><c>t</c></a>')).not.toThrow();
    for (const bad of ["<a><b></a>", "<a></a><b></b>", "<a>", "<!-- x -- y --><a/>", "<a>1 < 2</a>", "<a>&</a>"])
      expect(() => checkXml(bad)).toThrow();
  });
});

describe("wazuh", () => {
  const rules = read("integrations/wazuh/local_rules.xml");
  test("rules and localfile are well-formed", () => {
    checkXml(rules);
    checkXml(read("integrations/wazuh/localfile.xml"));
    expect(read("integrations/wazuh/localfile.xml")).toContain("<log_format>json</log_format>");
  });
  test("every finding level maps to one Wazuh rule in the custom id range", () => {
    const ids = [...rules.matchAll(/<rule id="(\d+)" level="(\d+)"/g)].map((m) => [Number(m[1]), Number(m[2])] as const);
    for (const [id, lvl] of ids) {
      expect(id).toBeGreaterThanOrEqual(100000);
      expect(id).toBeLessThanOrEqual(120000);
      expect(lvl).toBeLessThanOrEqual(16);
    }
    expect(new Set(ids.map(([id]) => id)).size).toBe(ids.length);
    const mapped = [...rules.matchAll(/<field name="event.severity">\^(\d)\$<\/field>/g)].map((m) => Number(m[1]));
    expect(mapped.sort()).toEqual(LEVELS.map((l) => SEVERITY[l].id).sort());
  });
});

describe("splunk", () => {
  test("props.conf names the sourcetype inputs.conf uses", () => {
    expect(read("integrations/splunk/props.conf")).toContain("[retrohound:ecs]");
    expect(read("integrations/splunk/inputs.conf")).toMatch(/^sourcetype = retrohound:ecs$/m);
  });
});

describe("velociraptor", () => {
  const art = parse(read("integrations/velociraptor/Custom.RetroHound.Scan.yaml"));
  test("artifact parses and has the fields Velociraptor needs", () => {
    expect(art.name).toBe("Custom.RetroHound.Scan");
    expect(art.type).toBe("CLIENT");
    expect(art.sources[0].query).toContain('FetchBinary(ToolName="RetroHound"');
    expect(art.sources[0].query).toContain('"--no-index"');
  });
  test("tool URL pins the package.json version", () => {
    expect(art.tools[0].url).toBe(`https://registry.npmjs.org/retrohound/-/retrohound-${version}.tgz`);
  });
});

describe("github action", () => {
  const action = parse(read("action.yml"));
  test("has the Marketplace metadata and a composite run", () => {
    for (const k of ["name", "description", "branding", "runs"]) expect(action[k]).toBeDefined();
    expect(action.runs.using).toBe("composite");
    expect(Object.keys(action.inputs)).toEqual(["command", "fail-on", "args", "output"]);
  });
  test("pins the package.json version", () => {
    const pins = [...JSON.stringify(action).matchAll(/retrohound@([\w.-]+)/g)].map((m) => m[1]);
    expect(pins.length).toBeGreaterThan(0);
    for (const p of pins) expect(p).toBe(version);
  });
});

describe("homebrew", () => {
  test("formula pins the package.json version", () => {
    expect(read("integrations/homebrew/retrohound.rb")).toContain(`url "https://registry.npmjs.org/retrohound/-/retrohound-${version}.tgz"`);
  });
});

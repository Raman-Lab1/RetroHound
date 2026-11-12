import { describe, expect, test } from "bun:test";
import { event, item, itemReason } from "./helpers.ts";

const cmd = (command_line: string) => event({ command_line });

describe("plain values", () => {
  test("match the whole field, case-insensitively", () => {
    expect(item("command_line", "WHOAMI", cmd("whoami"))).toBe(true);
    expect(item("command_line", "whoami", cmd("whoami /all"))).toBe(false);
  });
  test("* spans any run, newlines included, and ? exactly one character", () => {
    expect(item("command_line", "'cat *.env'", cmd("cat ./a/.env"))).toBe(true);
    expect(item("command_line", "'a*z'", cmd("a\nb\nz"))).toBe(true);
    expect(item("command_line", "'id_?sa'", cmd("id_rsa"))).toBe(true);
    expect(item("command_line", "'id_?sa'", cmd("id_rrsa"))).toBe(false);
    expect(item("command_line", "'a?'", cmd("a"))).toBe(false);
  });
  test("several wildcards, with backtracking", () => {
    expect(item("command_line", "'*a?c*c'", cmd("xxabxabcyyc"))).toBe(true);
    expect(item("command_line", "'*a?c*d'", cmd("xxabxabcyyc"))).toBe(false);
    expect(item("command_line", "'***'", cmd(""))).toBe(true);
  });
  test("backslash escapes follow the spec table", () => {
    expect(item("command_line", String.raw`'a\*b'`, cmd("a*b"))).toBe(true);
    expect(item("command_line", String.raw`'a\*b'`, cmd("axb"))).toBe(false);
    expect(item("command_line", String.raw`'a\?b'`, cmd("axb"))).toBe(false);
    expect(item("command_line", String.raw`'a\\*'`, cmd(String.raw`a\xyz`))).toBe(true);
    expect(item("command_line", String.raw`'a\\\*'`, cmd(String.raw`a\*`))).toBe(true);
    expect(item("command_line", String.raw`'a\\\*'`, cmd(String.raw`a\x`))).toBe(false);
    expect(item("command_line", String.raw`'a\\b'`, cmd(String.raw`a\b`))).toBe(true);
    expect(item("command_line", String.raw`'a\\\\'`, cmd(String.raw`a\\`))).toBe(true);
    expect(item("command_line", String.raw`'a\\\'`, cmd(String.raw`a\\`))).toBe(true);
  });
  test("a Windows path needs no doubling", () => {
    expect(item("target_path", String.raw`'C:\Users\*'`, event({ target_path: String.raw`C:\Users\x\.env` }))).toBe(false);
    expect(item("target_path", String.raw`'C:\Users\x\.env'`, event({ target_path: String.raw`c:\users\x\.env` }))).toBe(true);
    expect(item("target_path|startswith", String.raw`'C:\Users\'`, event({ target_path: String.raw`C:\Users\x` }))).toBe(true);
  });
  test("a %placeholder% without |expand is just text", () => {
    expect(item("command_line|contains", "'%TEMP%'", cmd("echo %temp%"))).toBe(true);
  });
  test("null means missing, '' means empty", () => {
    expect(item("agent_id", "null", event())).toBe(true);
    expect(item("agent_id", "null", event({ agent_id: "a1" }))).toBe(false);
    expect(item("agent_id", "null", { ...event(), agent_id: null } as never)).toBe(true);
    expect(item("command_line", "''", cmd(""))).toBe(true);
    expect(item("command_line", "''", event())).toBe(false);
    expect(item("command_line", "''", cmd("x"))).toBe(false);
  });
  test("a missing field matches nothing, not even *", () => {
    expect(item("command_line", "'*'", event())).toBe(false);
    expect(item("command_line", "'*'", cmd(""))).toBe(true);
  });
  test("numbers compare as text, on string and numeric fields", () => {
    expect(item("seq", "7", event({ seq: 7 }))).toBe(true);
    expect(item("seq", "'7'", event({ seq: 7 }))).toBe(true);
    expect(item("seq", "7", event({ seq: 8 }))).toBe(false);
    expect(item("command_line", "42", cmd("42"))).toBe(true);
  });
  test("a list is OR, a list field matches on any element", () => {
    expect(item("tool_name", "[Bash, PowerShell]", event({ tool_name: "powershell" }))).toBe(true);
    expect(item("tool_name", "[Bash, PowerShell]", event({ tool_name: "Read" }))).toBe(false);
    expect(item("secret_kinds", "aws_access_key", event({ secret_kinds: ["jwt", "AWS_ACCESS_KEY"] }))).toBe(true);
    expect(item("secret_kinds", "aws_access_key", event({ secret_kinds: ["jwt"] }))).toBe(false);
  });
  test("aliases read the canonical field", () => {
    expect(item("CommandLine|contains", "curl", cmd("curl https://example.invalid"))).toBe(true);
    expect(item("TargetFilename|endswith", ".env", event({ target_path: "/a/.env" }))).toBe(true);
    expect(item("CurrentDirectory", "/a", event({ project_path: "/a" }))).toBe(true);
  });
  test("match-only text is readable; a DB row without it just does not match", () => {
    expect(item("tool_response|contains", "needle", event({ tool_response: "hay NEEDLE hay" }))).toBe(true);
    expect(item("tool_response|contains", "needle", event())).toBe(false);
  });
});

describe("contains, startswith, endswith", () => {
  test("contains", () => {
    expect(item("command_line|contains", "CURL", cmd("x curl y"))).toBe(true);
    expect(item("command_line|contains", "curl", cmd("wget"))).toBe(false);
    expect(item("command_line|contains", "'a*c'", cmd("xabcx"))).toBe(true);
    expect(item("command_line|contains", String.raw`'a\*c'`, cmd("xabcx"))).toBe(false);
  });
  test("startswith", () => {
    expect(item("command_line|startswith", "CAT", cmd("cat x"))).toBe(true);
    expect(item("command_line|startswith", "cat", cmd("x cat"))).toBe(false);
    expect(item("command_line|startswith", "'c?t'", cmd("cat x"))).toBe(true);
  });
  test("endswith", () => {
    expect(item("target_path|endswith", ".ENV", event({ target_path: "/a/.env" }))).toBe(true);
    expect(item("target_path|endswith", ".env", event({ target_path: "/a/.env.example" }))).toBe(false);
    expect(item("target_path|endswith", "'.e?v'", event({ target_path: "/a/.env" }))).toBe(true);
  });
  test("leading and trailing stars take the same paths", () => {
    expect(item("command_line", "'*curl*'", cmd("x curl y"))).toBe(true);
    expect(item("command_line", "'curl*'", cmd("curl y"))).toBe(true);
    expect(item("command_line", "'*curl'", cmd("x curl"))).toBe(true);
  });
  test("a list stays OR", () => {
    expect(item("command_line|contains", "[curl, wget]", cmd("wget x"))).toBe(true);
  });
});

describe("all", () => {
  test("ANDs the list", () => {
    expect(item("command_line|contains|all", "[curl, secret]", cmd("curl -d secret"))).toBe(true);
    expect(item("command_line|contains|all", "[curl, secret]", cmd("curl -d x"))).toBe(false);
    expect(item("command_line|re|all", "['^curl', 'x$']", cmd("curl x"))).toBe(true);
    expect(item("command_line|re|all", "['^curl', 'y$']", cmd("curl x"))).toBe(false);
  });
  test("each value may match a different element of a list field", () => {
    expect(item("secret_kinds|contains|all", "[jwt, aws]", event({ secret_kinds: ["jwt", "aws_access_key"] }))).toBe(true);
  });
  test("a single value is rejected", () => {
    expect(itemReason("command_line|contains|all", "curl")).toBe("bad-modifier-combo");
    expect(itemReason("command_line|contains|all", "[curl]")).toBe("bad-modifier-combo");
  });
});

describe("re", () => {
  test("is case-sensitive and unanchored", () => {
    expect(item("command_line|re", "'c.rl'", cmd("x curl y"))).toBe(true);
    expect(item("command_line|re", "'C.RL'", cmd("curl"))).toBe(false);
  });
  test("flags i, m, s", () => {
    expect(item("command_line|re|i", "'C.RL'", cmd("curl"))).toBe(true);
    expect(item("command_line|re|m", "'^b$'", cmd("a\nb\nc"))).toBe(true);
    expect(item("command_line|re", "'^b$'", cmd("a\nb\nc"))).toBe(false);
    expect(item("command_line|re|s", "'a.b'", cmd("a\nb"))).toBe(true);
    expect(item("command_line|re", "'a.b'", cmd("a\nb"))).toBe(false);
    expect(item("command_line|re|i|s", "'A.B'", cmd("a\nb"))).toBe(true);
  });
  test("is stable across repeated events", () => {
    for (let i = 0; i < 3; i++) expect(item("command_line|re", "'curl'", cmd("curl"))).toBe(true);
  });
  test("reads the raw value, numbers and list elements", () => {
    expect(item("seq|re", "'^12$'", event({ seq: 12 }))).toBe(true);
    expect(item("secret_kinds|re", "'^jwt$'", event({ secret_kinds: ["jwt"] }))).toBe(true);
    expect(item("secret_kinds|re", "'^JWT$'", event({ secret_kinds: ["jwt"] }))).toBe(false);
  });
  test("escaped metacharacters and character classes are not mistaken for banned syntax", () => {
    expect(item("command_line|re", String.raw`'\(\?=x'`, cmd("(?=x"))).toBe(true);
    expect(item("command_line|re", "'[(?=]x'", cmd("=x"))).toBe(true);
    expect(item("command_line|re", String.raw`'\\1'`, cmd(String.raw`\1`))).toBe(true);
    expect(item("command_line|re", String.raw`'[\1]'`, cmd("\u0001"))).toBe(true);
    expect(item("command_line|re", "'(?:a|b)c'", cmd("bc"))).toBe(true);
    expect(item("command_line|re", String.raw`'\d+\-x'`, cmd("12-x"))).toBe(true);
  });
  test("lookarounds are rejected", () => {
    for (const re of ["a(?=b)", "a(?!b)", "(?<=a)b", "(?<!a)b"]) expect(itemReason("command_line|re", `'${re}'`)).toBe("regex-lookaround");
  });
  test("backreferences are rejected", () => {
    expect(itemReason("command_line|re", String.raw`'(a)\1'`)).toBe("regex-backreference");
    expect(itemReason("command_line|re", String.raw`'(?<x>a)\k<x>'`)).toBe("regex-backreference");
  });
  test("what JS would read differently from PCRE is rejected", () => {
    expect(itemReason("command_line|re", String.raw`'\Aabc\Z'`)).toBe("bad-regex");
    expect(itemReason("command_line|re", "'[[:alpha:]]'")).toBe("bad-regex");
  });
  test("characters above U+FFFF match as surrogate pairs, other spellings would silently misfire", () => {
    const tagChars = String.raw`'\uDB40[\uDC00-\uDC7F]'`;
    expect(item("content|re", tagChars, event({ content: "a\u{E0041}b" }))).toBe(true);
    expect(item("content|re", tagChars, event({ content: "a​b" }))).toBe(false);
    expect(itemReason("content|re", String.raw`'\u{E0041}'`)).toBe("bad-regex");
    expect(itemReason("content|re", String.raw`'\x{E0041}'`)).toBe("bad-regex");
    expect(itemReason("content|re", "'[\u{1F600}x]'")).toBe("bad-regex");
  });
  test("an invalid pattern and inline flags are rejected", () => {
    expect(itemReason("command_line|re", "'('")).toBe("bad-regex");
    expect(itemReason("command_line|re", "'(?i)abc'")).toBe("bad-regex");
  });
  test("a non-string pattern is rejected", () => {
    expect(itemReason("command_line|re", "5")).toBe("bad-value");
  });
  test("flags need re; re does not mix with shapes, cased or windash", () => {
    expect(itemReason("command_line|i", "x")).toBe("bad-modifier-combo");
    expect(itemReason("command_line|re|contains", "x")).toBe("bad-modifier-combo");
    expect(itemReason("command_line|re|cased", "x")).toBe("bad-modifier-combo");
    expect(itemReason("command_line|re|windash", "x")).toBe("bad-modifier-combo");
  });
});

describe("cased", () => {
  test("on plain values and every shape", () => {
    expect(item("command_line|cased", "Curl", cmd("Curl"))).toBe(true);
    expect(item("command_line|cased", "Curl", cmd("curl"))).toBe(false);
    expect(item("command_line|contains|cased", "Url", cmd("cUrl"))).toBe(true);
    expect(item("command_line|contains|cased", "URL", cmd("cUrl"))).toBe(false);
    expect(item("command_line|cased|startswith", "C", cmd("curl"))).toBe(false);
    expect(item("command_line|endswith|cased", "L", cmd("curl"))).toBe(false);
  });
  test("on list fields", () => {
    expect(item("secret_kinds|cased", "jwt", event({ secret_kinds: ["JWT"] }))).toBe(false);
    expect(item("secret_kinds|cased", "JWT", event({ secret_kinds: ["JWT"] }))).toBe(true);
  });
});

describe("exists", () => {
  test("tests presence only", () => {
    expect(item("secret_kinds|exists", "true", event({ secret_kinds: ["jwt"] }))).toBe(true);
    expect(item("secret_kinds|exists", "true", event())).toBe(false);
    expect(item("secret_kinds|exists", "false", event())).toBe(true);
    expect(item("command_line|exists", "true", cmd(""))).toBe(true);
    expect(item("raw_ref|exists", "true", event())).toBe(true);
  });
  test("a DB row's null is absent", () => {
    expect(item("command_line|exists", "true", { ...event(), command_line: null } as never)).toBe(false);
  });
  test("needs a boolean and stands alone", () => {
    expect(itemReason("command_line|exists", "'true'")).toBe("bad-value");
    expect(itemReason("command_line|exists", "[true]")).toBe("bad-value");
    expect(itemReason("command_line|exists|cased", "true")).toBe("bad-modifier-combo");
  });
});

describe("gt, gte, lt, lte", () => {
  test("compare numbers", () => {
    const ev = event({ seq: 10 });
    expect(item("seq|gt", "9", ev)).toBe(true);
    expect(item("seq|gt", "10", ev)).toBe(false);
    expect(item("seq|gte", "10", ev)).toBe(true);
    expect(item("seq|gte", "11", ev)).toBe(false);
    expect(item("seq|lt", "11", ev)).toBe(true);
    expect(item("seq|lt", "10", ev)).toBe(false);
    expect(item("seq|lte", "10", ev)).toBe(true);
    expect(item("seq|lte", "9", ev)).toBe(false);
    expect(item("seq|gt", "[100, 9]", ev)).toBe(true);
  });
  test("need a number on a numeric field", () => {
    expect(itemReason("seq|gt", "'9'")).toBe("bad-value");
    expect(itemReason("command_line|gt", "9")).toBe("bad-value");
    expect(itemReason("seq|gt|all", "[1, 2]")).toBe("bad-modifier-combo");
  });
});

describe("fieldref", () => {
  const ev = (target_path: string, project_path?: string) => event({ target_path, project_path });
  test("alone is whole-field and case-insensitive", () => {
    expect(item("target_path|fieldref", "project_path", ev("/A", "/a"))).toBe(true);
    expect(item("target_path|fieldref", "project_path", ev("/a/b", "/a"))).toBe(false);
  });
  test("with startswith and endswith, in either order", () => {
    expect(item("target_path|fieldref|startswith", "project_path", ev("/a/b", "/a"))).toBe(true);
    expect(item("target_path|startswith|fieldref", "project_path", ev("/b/a", "/a"))).toBe(false);
    expect(item("target_path|fieldref|endswith", "project_path", ev("/b/a", "/a"))).toBe(true);
    expect(item("target_path|fieldref|endswith", "project_path", ev("/a/b", "/a"))).toBe(false);
  });
  test("the referenced value is literal, never a wildcard", () => {
    expect(item("target_path|fieldref", "project_path", ev("/abc", "/a*"))).toBe(false);
  });
  test("the referenced field goes through aliases and a list is OR", () => {
    expect(item("target_path|fieldref|startswith", "CurrentDirectory", ev("/a/b", "/a"))).toBe(true);
    expect(item("target_path|fieldref", "[url, project_path]", ev("/a", "/a"))).toBe(true);
  });
  test("a missing side never matches", () => {
    expect(item("target_path|fieldref|startswith", "project_path", ev("/a/b"))).toBe(false);
    expect(item("target_path|fieldref", "project_path", event({ project_path: "/a" }))).toBe(false);
  });
  test("numbers read as text", () => {
    expect(item("seq|fieldref", "command_line", event({ seq: 5, command_line: "5" }))).toBe(true);
  });
  test("an unknown referenced field is rejected", () => {
    expect(itemReason("target_path|fieldref", "project_root")).toBe("unknown-field");
  });
  test("other combinations are rejected", () => {
    expect(itemReason("target_path|fieldref|contains", "project_path")).toBe("bad-modifier-combo");
    expect(itemReason("target_path|fieldref|cased", "project_path")).toBe("bad-modifier-combo");
    expect(itemReason("target_path|fieldref|all", "[url, project_path]")).toBe("bad-modifier-combo");
    expect(itemReason("secret_kinds|fieldref", "project_path")).toBe("bad-modifier-combo");
    expect(itemReason("target_path|fieldref", "secret_kinds")).toBe("bad-modifier-combo");
  });
});

describe("windash", () => {
  test("expands a word-leading dash or slash to every variant", () => {
    for (const dash of ["-", "/", "\u2013", "\u2014", "\u2015"]) {
      expect(item("command_line|windash|contains", "' -e '", cmd(`powershell ${dash}e x`))).toBe(true);
    }
    expect(item("command_line|contains|windash", "' /e '", cmd("powershell -e x"))).toBe(true);
    expect(item("command_line|windash|contains", "' -e '", cmd("powershell +e x"))).toBe(false);
  });
  test("leaves a dash inside a word alone", () => {
    expect(item("command_line|windash", "'a-b'", cmd("a-b"))).toBe(true);
    expect(item("command_line|windash", "'a-b'", cmd("a/b"))).toBe(false);
  });
});

describe("value and modifier rejections", () => {
  test.each([
    "base64", "base64offset", "wide", "utf16", "utf16le", "utf16be", "cidr", "neq", "minute", "hour", "day", "week",
    "month", "year", "ignorecase", "toString", "",
  ])("unsupported modifier '%s'", (mod) => {
    expect(itemReason(`command_line|${mod}`, "x")).toBe("unsupported-modifier");
  });
  test("expand names placeholders", () => {
    expect(itemReason("command_line|expand", "'%admin%'")).toBe("placeholder");
  });
  test("repeated and competing modifiers", () => {
    expect(itemReason("command_line|contains|contains", "x")).toBe("bad-modifier-combo");
    expect(itemReason("command_line|contains|startswith", "x")).toBe("bad-modifier-combo");
    expect(itemReason("seq|gt|lt", "1")).toBe("bad-modifier-combo");
  });
  test("null inside a list, or with a modifier", () => {
    expect(itemReason("command_line", "[a, null]")).toBe("null-in-list");
    expect(itemReason("command_line|contains", "null")).toBe("bad-value");
  });
  test("values that are not strings or numbers", () => {
    expect(itemReason("command_line", "true")).toBe("bad-value");
    expect(itemReason("command_line", "{ a: 1 }")).toBe("bad-value");
    expect(itemReason("command_line", "[[a]]")).toBe("bad-value");
    expect(itemReason("command_line", "[]")).toBe("bad-value");
  });
  test("raw_ref is an object: only exists applies", () => {
    expect(itemReason("raw_ref", "x")).toBe("bad-value");
    expect(itemReason("raw_ref|contains", "x")).toBe("bad-value");
  });
});

describe("target_outside_project (computed)", () => {
  const out = (target_path?: string, project_path?: string) => item("target_outside_project", "true", event({ target_path, project_path }));
  test("POSIX: inside, outside, and the /proj-evil prefix trap", () => {
    expect(out("/proj/a/b", "/proj")).toBe(false);
    expect(out("/proj/../etc/x", "/proj")).toBe(true);
    expect(out("/proj-evil/x", "/proj")).toBe(true);
    expect(out("a/b", "/proj")).toBe(false);
  });
  test("Windows: case and slash insensitive, sibling prefix is outside", () => {
    expect(out("c:/users/d/proj/x", String.raw`C:\Users\d\proj`)).toBe(false);
    expect(out(String.raw`C:\Users\d\proj-evil\x`, String.raw`C:\Users\d\proj`)).toBe(true);
  });
  test("missing or null fields never fire; false is the complement", () => {
    expect(out(undefined, "/proj")).toBe(false);
    expect(out("/x", undefined)).toBe(false);
    expect(out(null as never, "/proj")).toBe(false);
    expect(item("target_outside_project", "false", event({ target_path: "/proj/x", project_path: "/proj" }))).toBe(true);
  });
  test("takes only a boolean, no modifiers", () => {
    expect(itemReason("target_outside_project|contains", "true")).toBe("bad-value");
    expect(itemReason("target_outside_project", "'yes'")).toBe("bad-value");
  });
});

describe("hostile input", () => {
  const big = "a".repeat(8_000_000);
  test("re over a huge value with a quadratic pattern finishes in bounded time; a match in the middle is missed", () => {
    const t = performance.now();
    expect(item("command_line|re", "'a+b'", cmd(big))).toBe(false);
    expect(item("command_line|re", "'a+b'", cmd("ab" + big))).toBe(true);
    expect(item("command_line|re", "'b+c'", cmd(big + "bc" + big))).toBe(false);
    expect(performance.now() - t).toBeLessThan(2000);
  });
  test("internal-* globs stay linear in the text", () => {
    const t = performance.now();
    expect(item("command_line", "'*a*a*a*b'", cmd(big))).toBe(false);
    expect(performance.now() - t).toBeLessThan(2000);
  });
});

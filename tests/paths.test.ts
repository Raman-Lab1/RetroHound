import { describe, expect, test } from "bun:test";
import { expandHome, isAbsoluteAny, isInside, normalizeSlashes } from "../src/normalize/paths.ts";

describe("isAbsoluteAny", () => {
  test.each(["/x", "//x", "/", "C:\\x", "C:/x", "c:\\", "\\\\srv\\share\\x", "~", "~/x", "~\\x", "$HOME", "$HOME/x", "${HOME}", "${HOME}/x"])(
    "%s is absolute",
    (p) => expect(isAbsoluteAny(p)).toBe(true),
  );
  test.each(["", "x", "./x", "../x", "..\\x", "C:", "C:x", "\\x", "$OTHER/x", "$HOMEBREW_PREFIX/x", "~user/x", "%USERPROFILE%\\x"])(
    "%s is not absolute",
    (p) => expect(isAbsoluteAny(p)).toBe(false),
  );
});

describe("normalizeSlashes", () => {
  test.each([
    ["C:\\Users\\x\\.ssh\\id_rsa", "C:/Users/x/.ssh/id_rsa"],
    ["C:/a\\b//c", "C:/a/b/c"],
    ["\\\\srv\\share\\x", "//srv/share/x"],
    ["/w//proj///x", "/w/proj/x"],
    ["/w/odd\\name", "/w/odd\\name"], // legal POSIX filename
    ["src/a.ts", "src/a.ts"],
    ["C:\\a\\", "C:/a/"],
  ])("%s -> %s", (p, want) => expect(normalizeSlashes(p)).toBe(want));
});

describe("expandHome", () => {
  test.each([
    ["~", "/home/a", "/home/a"],
    ["~/x/y", "/home/a", "/home/a/x/y"],
    ["~/x", "/home/a/", "/home/a/x"],
    ["$HOME/x", "/home/a", "/home/a/x"],
    ["${HOME}/x", "/home/a", "/home/a/x"],
    ["$HOME", "/home/a", "/home/a"],
    ["~/x/y", "C:\\Users\\a", "C:\\Users\\a\\x\\y"],
    ["~\\x", "C:\\Users\\a", "C:\\Users\\a\\x"],
    ["${HOME}/x", "C:/Users/a", "C:/Users/a\\x"],
    ["~\\x", "/home/a", "/home/a/x"],
  ])("%s with home %s -> %s", (p, home, want) => expect(expandHome(p, home)).toBe(want));
  test.each(["/x", "x", "~user/x", "~.bashrc", "$HOMEBREW_PREFIX/bin", "$HOME2/x", "${HOMEDIR}/x", "a/~/b"])(
    "%s stays",
    (p) => expect(expandHome(p, "/home/a")).toBe(p),
  );
});

describe("isInside", () => {
  test.each([
    ["/w/proj/a", "/w/proj"],
    ["/w/proj", "/w/proj"], // the root counts as inside
    ["/w/proj/", "/w/proj"],
    ["/w/proj/a", "/w/proj/"],
    ["/w/proj/a/../b", "/w/proj"],
    ["//w//proj/a", "/w/proj"],
    ["/a", "/"],
    ["src/a.ts", "/w/proj"],
    ["./a", "/w/proj"],
    ["a/../b", "/w/proj"],
    ["C:\\w\\proj\\a", "C:\\w\\proj"],
    ["C:/w/proj/a", "C:\\w\\proj"],
    ["c:\\W\\PROJ\\a", "C:\\w\\proj"], // Windows is case-insensitive
    ["C:\\w\\proj\\a\\..\\b", "C:\\w\\proj"],
    ["src\\a.ts", "C:\\w\\proj"],
    ["SRC/a.ts", "C:\\w\\proj"],
    ["C:\\anything", "C:\\"],
    ["\\\\Srv\\Share\\w\\a", "\\\\srv\\share\\w"],
    ["\\\\srv\\share\\w", "\\\\srv\\share"],
    ["/c/w/proj/a", "C:\\w\\proj"], // Git Bash form of a drive path
    ["/C/W/proj/a", "c:/w/proj"],
    ["C:\\w\\proj\\a", "/c/w/proj"],
    ["~/Desktop/proj/a", "~/Desktop/proj"], // a cwd stored with ~, as scrubHome writes it
    ["$HOME/proj/a", "~/proj"],
    ["${HOME}/proj/a", "$HOME/proj"],
    ["a/b", "~/proj"],
    ["~/a", "~"],
  ])("%s is inside %s", (c, r) => expect(isInside(c, r)).toBe(true));

  test.each([
    ["/w/proj/../../etc", "/w/proj"],
    ["/w/proj/..", "/w/proj"],
    ["/w/project2", "/w/proj"], // root-prefix trick
    ["/w/proj2/a", "/w/proj"],
    ["/w", "/w/proj"],
    ["/W/PROJ/a", "/w/proj"], // POSIX is case-sensitive
    ["../x", "/w/proj"],
    ["a/../../x", "/w/proj"],
    ["C:\\w\\proj\\..\\..\\etc", "C:\\w\\proj"],
    ["C:/w/proj/../../etc", "C:\\w\\proj"],
    ["C:\\w\\project2", "C:\\w\\proj"],
    ["D:\\w\\proj\\a", "C:\\w\\proj"],
    ["..\\..\\x", "C:\\w\\proj"],
    ["\\\\srv\\other\\w", "\\\\srv\\share\\w"],
    ["\\\\srv2\\share\\w", "\\\\srv\\share\\w"],
    ["\\\\srv\\share\\w\\..\\x", "\\\\srv\\share\\w"],
    ["/w/proj/a", "C:\\w\\proj"], // different anchors
    ["C:\\w\\proj\\a", "/w/proj"],
    ["/d/w/proj/a", "C:\\w\\proj"],
    ["/c/w/proj/a", "/w/proj"],
    ["~/proj/a", "/home/a/proj"], // expandHome first
    ["/home/a/proj/x", "~/proj"],
    ["~/project2", "~/proj"],
    ["~/proj/../../x", "~/proj"],
    ["~/../x", "~"], // above ~ is unknowable
    ["../../x", "~/proj"],
    ["$OTHER/a", "/w/proj"], // unresolved anchors are never inside
    ["$TMPDIR/a", "/w/proj"],
    ["$env:USERPROFILE\\a", "C:\\w\\proj"],
    ["%USERPROFILE%\\a", "C:\\w\\proj"],
    ["~user/a", "/w/proj"],
    ["C:a", "C:\\w\\proj"],
    ["\\a", "C:\\w\\proj"],
    ["", "/w/proj"],
    ["/w/proj/a", ""],
    ["/w/proj/a", "relative/root"],
    ["/w/proj/a", "$HOME2/x"],
  ])("%s is not inside %s", (c, r) => expect(isInside(c, r)).toBe(false));

  test("a backslash is a filename character on POSIX but a separator on Windows", () => {
    expect(isInside("/w/proj/..\\..\\x", "/w/proj")).toBe(true);
    expect(isInside("..\\x", "/w/proj")).toBe(true);
    expect(isInside("C:\\w\\proj\\..\\..\\x", "C:/w/proj")).toBe(false);
  });
});

// Path logic by the path's own shape, never process.platform: a scan may read transcripts written on another OS.

const DRIVE = /^[A-Za-z]:[\\/]/; // C:\x, C:/x
const UNC = /^\\\\/; // \\server\share. A leading // is POSIX: the kernel collapses it, and `rm -rf //etc` means /etc.
const HOME = /^(?:~|\$HOME|\$\{HOME\})(?=[\\/]|$)/; // not $HOMEBREW_PREFIX, not ~user
const UNRESOLVED = /^(?:[A-Za-z]:|[\\~$%])/; // C:x, \x, ~user, $VAR, %VAR%: anchored somewhere we cannot see

const isWindows = (p: string) => DRIVE.test(p) || UNC.test(p);

/** True when `p` does not depend on the cwd. `~`, `$HOME` and `${HOME}` count; other variables do not. */
export function isAbsoluteAny(p: string): boolean {
  return isWindows(p) || p.startsWith("/") || HOME.test(p);
}

/** Windows paths get forward slashes, and duplicate slashes collapse. Backslashes stay in POSIX paths: there they
 * are filename characters. Does not resolve `..`. */
export function normalizeSlashes(p: string): string {
  if (!isWindows(p)) return p.replace(/\/{2,}/g, "/");
  return (UNC.test(p) ? "/" : "") + p.replace(/[\\/]+/g, "/");
}

/** `~`, `$HOME`, `${HOME}` -> `home`, joined with home's separator. Anything else is returned unchanged. */
export function expandHome(p: string, home: string): string {
  const prefix = HOME.exec(p)?.[0];
  if (prefix === undefined) return p;
  const rest = p.slice(prefix.length);
  if (!rest) return home;
  const base = home.replace(/[\\/]+$/, "");
  return base + (isWindows(home) ? rest.replace(/\//g, "\\") : rest.replace(/^\\/, "/"));
}

type Parsed = { kind: "posix" | "drive" | "unc" | "home"; prefix: string; segs: string[] };

// Resolves `.` and `..`. A real root absorbs extra `..`; `~` is not a root, so going above it is unknowable: null.
export function collapse(parts: string[], kind: Parsed["kind"]): string[] | null {
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part !== "..") out.push(part);
    else if (out.length) out.pop();
    else if (kind === "home") return null;
  }
  return out;
}

function parsed(kind: Parsed["kind"], prefix: string, parts: string[]): Parsed | null {
  const segs = collapse(parts, kind);
  return segs && { kind, prefix, segs };
}

function parse(p: string, base?: Parsed): Parsed | null {
  if (!p) return null;
  if (DRIVE.test(p)) return parsed("drive", p.slice(0, 2).toLowerCase(), p.slice(2).toLowerCase().split(/[\\/]/));
  if (UNC.test(p)) {
    const [server = "", share = "", ...rest] = p.toLowerCase().slice(2).split(/[\\/]+/);
    return parsed("unc", `//${server}/${share}`, rest);
  }
  if (p.startsWith("/")) return parsed("posix", "", p.split("/"));
  const home = HOME.exec(p)?.[0];
  if (home !== undefined) return parsed("home", "~", p.slice(home.length).split(/[\\/]/));
  if (!base || UNRESOLVED.test(p)) return null;
  const posixBase = base.kind === "posix";
  const rel = posixBase ? p.split("/") : p.toLowerCase().split(/[\\/]/);
  return parsed(base.kind, base.prefix, [...base.segs, ...rel]);
}

// Git Bash writes C:\x as /c/x. Only meaningful against a drive path, so a real /c/x on POSIX is left alone.
function msysToDrive(p: Parsed, other: Parsed): Parsed {
  const drive = p.segs[0];
  if (p.kind !== "posix" || other.kind !== "drive" || !drive || !/^[A-Za-z]$/.test(drive)) return p;
  return { kind: "drive", prefix: `${drive.toLowerCase()}:`, segs: p.segs.slice(1).map((s) => s.toLowerCase()) };
}

/**
 * True when `child` is `root` itself or below it, after resolving `..`. A relative child resolves against `root`.
 * False whenever that cannot be proven: unexpanded `$VAR`/`~user`, drive-relative `C:x`, or different anchors, so run
 * `expandHome` first when a `~` path meets an absolute root. Windows comparison is case-insensitive, POSIX is not.
 */
export function isInside(child: string, root: string): boolean {
  const r0 = parse(root);
  const c0 = r0 && parse(child, r0);
  if (!r0 || !c0) return false;
  const c = msysToDrive(c0, r0);
  const r = msysToDrive(r0, c0);
  if (c.kind !== r.kind || c.prefix !== r.prefix) return false;
  return r.segs.every((seg, i) => c.segs[i] === seg);
}

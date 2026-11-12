// The computed fields over `command_line` (docs/logsource.md, "Derived fields"). A rule reading them runs them on every
// event it sees, the live hook included, so each is one linear pass: no regex that can backtrack over the whole line.
type Row = Record<string, unknown>;

const ESC: Record<string, string> = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", v: "\v" };

/** The text of one bash ANSI-C `$'…'` string: `\xHH`, `\NNN` octal, `\uHHHH`, `\UHHHHHHHH`, `\n \t \\ \'` decoded. */
function ansiC(body: string): string {
  return body.replace(/\\(?:x([\dA-Fa-f]{1,2})|([0-7]{1,3})|u([\dA-Fa-f]{1,4})|U([\dA-Fa-f]{1,8})|([\s\S]))/g, (m, x, o, u, U, c) => {
    if (c !== undefined) return ESC[c] ?? ("\\'\"?".includes(c) ? c : m);
    const n = x ? parseInt(x, 16) : o ? parseInt(o, 8) & 255 : parseInt(u ?? U, 16);
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
  });
}

/**
 * `command_line` with shell quoting removed: ANSI-C `$'…'` strings decoded, `$"…"` read as `"…"`, `'` and `"` dropped,
 * `\` dropped before a word character, and runs of spaces and tabs collapsed to one space.
 */
export function unquote(s: string): string {
  let out = "";
  let q = ""; // "" outside quotes, `'` single-quoted, `"` double-quoted
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "\\" && q !== "'" && i + 1 < s.length) {
      const n = s[i + 1]!;
      if (/\w/.test(n)) continue; // `\c` reads as `c`
      out += n === '"' || n === "'" ? "\\" : "\\" + n; // an escaped quote neither opens nor closes
      i++;
    } else if (c === "$" && !q && s[i + 1] === "'") {
      let j = i + 2; // ANSI-C string: only starts outside quotes
      while (j < s.length && s[j] !== "'") j += s[j] === "\\" ? 2 : 1;
      out += ansiC(s.slice(i + 2, j)).replace(/['"]|\\(?=\w)/g, ""); // decoded quotes drop like any other
      i = j;
    } else if (c === "$" && !q && s[i + 1] === '"') {
      continue; // `$"…"` reads as `"…"`
    } else if ((c === "'" || c === '"') && (!q || q === c)) {
      q = q ? "" : c;
    } else out += c;
  }
  return out.replace(/[ \t]{2,}/g, " ");
}

let lastEv: Row | null = null;
let lastVal: string | undefined;

/** `command_line_unquoted` of `ev`, computed once per event however many rules read it. */
export function unquotedOf(ev: Row): string | undefined {
  if (ev !== lastEv) {
    lastEv = ev;
    const c = ev.command_line;
    lastVal = typeof c === "string" ? unquote(c) : undefined;
  }
  return lastVal;
}

export function resetDerived(): void {
  lastEv = null;
  lastVal = undefined;
}

// Quoted text is one word, separators and all (`git commit -m "a; bash x"`), and the quote characters are dropped. The
// code string of a shell's `-c` or of `eval` is the exception: its quotes vanish without grouping, so
// `bash -c "curl -o x u && bash x"` splits into both commands.
// Backslashes stay, so `.\x.ps1` and `C:\t\x.ps1` survive; `c\url` is still read as curl (see `kind`).
function commands(s: string): string[][] {
  const out: string[][] = [];
  let cmd: string[] = [];
  let word = "";
  let quote = ""; // the quote we are inside
  let code = ""; // the quote around a `-c` code string, read as unquoted
  let shell = false; // the current command has a shell word, so its `-c` takes code
  const endWord = () => {
    if (word) {
      cmd.push(word);
      shell ||= kind(word) === "shell" || kind(word) === "pwsh";
    }
    word = "";
  };
  const endCmd = () => {
    endWord();
    if (cmd.length) out.push(cmd);
    cmd = [];
    shell = false;
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    const next = s[i + 1];
    if (quote) {
      if (c === quote) quote = "";
      else if (quote === '"' && c === "\\" && next === '"') i++;
      else word += c;
    } else if (c === code) code = "";
    else if (c === "'" || c === '"') {
      const last = word ? "" : (cmd[cmd.length - 1] ?? "");
      if (!code && (last === "eval" || (shell && /^-[a-z]*c$|^-command$/i.test(last)))) code = c;
      else quote = c;
    } else if (c === "\\" && next === "\n") i++; // line continuation
    else if (c === " " || c === "\t") endWord();
    else if (c === ">" || (c === "&" && next === ">")) {
      endWord();
      cmd.push(">");
      while (s[i + 1] === ">" || s[i + 1] === "&") i++; // >> >& &>
    } else if (c === "<") {
      endWord();
      if (next !== "<" && next !== "(") cmd.push("<");
      else for (endCmd(); s[i + 1] === "<"; ) i++; // `<<EOF`, `<<<`, `<(`: not a file
    } else if (c === "(" && /[\w.]$/.test(word)) word += c; // `open(`, `f()`: a call in an interpreter body, not a subshell
    else if (";|&\n\r()`".includes(c)) endCmd();
    else word += c;
  }
  endCmd();
  return out;
}

const DOWNLOADERS = new Set(["curl", "wget", "iwr", "invoke-webrequest", "irm", "invoke-restmethod", "certutil"]);
// The options that take code instead of a script file, by runner. Case matters: `python -E` and `-R` are not code.
const CODE = new Map<string, RegExp>([
  ["shell", /^-[a-zA-Z]*c/],
  ["python", /^-[a-zA-Z]*[cm]/],
  ["perl", /^-[a-zA-Z]*[eE]/],
  ["ruby", /^-[a-zA-Z]*e/],
  ["node", /^-[a-zA-Z]*[ep]/],
  ["php", /^-[a-zA-Z]*r/],
]);
// Options of a prefix command that take a value; the others take none. `timeout` also takes a duration.
const PREFIX_VALUED = new Map([["timeout", /^-[sk]$/], ["nice", /^-n$/], ["stdbuf", /^-[ioe]$/], ["xargs", /^-[IdnPLsEa]$/]]);
const KINDS = new Map<string, string>([
  ...[...DOWNLOADERS].map((n) => [n, n] as [string, string]),
  ...["sh", "bash", "zsh", "dash", "ksh", "fish"].map((n) => [n, "shell"] as [string, string]),
  ...["perl", "ruby", "node", "php"].map((n) => [n, n] as [string, string]),
  ...["pwsh", "powershell"].map((n) => [n, "pwsh"] as [string, string]),
  ["source", "source"],
  [".", "source"],
  ...["sudo", "doas", "env", "eval", "nohup", "exec", "time", "command", "builtin", "then", "do", "else", "if", "!", "{", ...PREFIX_VALUED.keys()].map((n) => [n, "prefix"] as [string, string]),
]);
const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** What a command word runs, by basename: `/usr/bin/curl`, `C:\x\curl.exe` and `c\url` are all curl. */
function kind(w: string): string {
  const l = w.toLowerCase().replace(/\.exe$/, "");
  for (const n of [base(l.replaceAll("\\", "/")), base(l.replace(/\\(?=\w)/g, ""))]) {
    const k = KINDS.get(n) ?? (/^python[0-9.]*$/.test(n) ? "python" : "");
    if (k) return k;
  }
  return "";
}

/** A path as a comparison key: `\` is `/`, and `./i.sh` is `i.sh`, so a bare basename download matches `./name`. */
function norm(p: string): string {
  let s = p.replaceAll("\\", "/");
  while (s.startsWith("./")) s = s.slice(2);
  return s;
}

/** The last segment of a URL's path, or "" when it has none: what `curl -O` and a bare `wget URL` save as. */
function urlBase(u: string): string {
  const s = u.split(/[?#]/, 1)[0]!;
  const rest = s.includes("://") ? s.slice(s.indexOf("://") + 3) : s;
  return rest.includes("/") ? base(rest) : "";
}

type Opts = { vals: string[]; flag: boolean; pos: string[] };

// Short options in a cluster (`-fsSLo P`, `-qO-`) up to the first that takes a value. `want` is the option whose
// values are collected, `flag` the one only noted. shortcut: long options other than `long` are taken as valueless,
// so a long option's value reads as a URL; that only matters if a file named after it is then run.
function getopt(args: string[], valued: string, want: string, flag: string, long: string, longFlag = ""): Opts {
  const o: Opts = { vals: [], flag: false, pos: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq < 0 ? a : a.slice(0, eq);
      if (name === long) o.vals.push(eq < 0 ? (args[++i] ?? "") : a.slice(eq + 1));
      else if (longFlag && name.startsWith(longFlag)) o.flag = true;
    } else if (a.startsWith("-") && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        if (a[j] === flag) o.flag = true;
        else if (valued.includes(a[j]!)) {
          const v = j + 1 < a.length ? a.slice(j + 1) : (args[++i] ?? "");
          if (a[j] === want) o.vals.push(v);
          break;
        }
      }
    } else o.pos.push(a);
  }
  return o;
}

/** The local files a download command writes, besides `>` redirects. */
function downloads(k: string, args: string[]): string[] {
  const files: string[] = [];
  const outFile = args.findIndex((a) => /^-outfile(:|$)/i.test(a)); // PowerShell, where curl and wget may alias iwr
  if (outFile >= 0) files.push(args[outFile]!.length > 8 ? args[outFile]!.slice(9) : (args[outFile + 1] ?? ""));
  if (k === "curl") {
    const d = args.findIndex((a) => /^--output-dir(=|$)/.test(a));
    const dir = d < 0 ? "" : args[d]!.length > 12 ? args[d]!.slice(13) : (args.splice(d + 1, 1)[0] ?? "");
    const o = getopt(args, "AbcCdDeEFHKmoPQrTuUwxXyYz", "o", "O", "--output", "--remote-name");
    const inDir = (f: string) => (dir && f && f !== "-" && !f.startsWith("/") ? `${dir.replace(/\/+$/, "")}/${f}` : f);
    files.push(...[...o.vals, ...(o.flag ? o.pos.map(urlBase) : [])].map(inDir));
  } else if (k === "wget") {
    const o = getopt(args, "aABDeiIlOoPQRtTUwX", "O", "", "--output-document");
    files.push(...(o.vals.length ? o.vals : o.pos.map(urlBase)));
  } else if (k === "certutil" && args.some((a) => /^[-/]urlcache$/i.test(a))) {
    const pos = args.filter((a) => !/^[-/]/.test(a));
    if (pos.length >= 2) files.push(pos[pos.length - 1]!);
  }
  return files;
}

const PWSH_VALUED = new Set(["-executionpolicy", "-ep", "-ex", "-exec", "-windowstyle", "-w", "-workingdirectory", "-wd"]);

/** The file a runner command executes: the first operand of a shell or interpreter, `pwsh -File P`, `source P`. */
function runs(k: string, args: string[]): string | undefined {
  if (k === "source") return args[0];
  const code = CODE.get(k); // -c CODE, -e CODE, -m MODULE: no script file
  if (code) {
    for (const a of args) {
      // `-` and a shell's `-s`: the script comes from stdin, so later operands are its arguments
      if (code.test(a) || a === "-" || (k === "shell" && /^-[a-zA-Z]*s/.test(a))) return undefined;
      if (!a.startsWith("-") && !a.startsWith("+")) return a;
    }
  }
  if (k === "pwsh") {
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!.toLowerCase();
      if (a === "-file" || a === "-f") return args[i + 1];
      if (PWSH_VALUED.has(a)) i++;
      else if (!a.startsWith("-")) return args[i];
      else if (/^-(c|command|e|ec|enc|encodedcommand)$/.test(a)) return undefined;
    }
  }
  return undefined;
}

/** Where the command proper starts: past `X=1`, `sudo -u root`, `env`, and into the code of `bash -c CODE`. */
function start(words: string[]): number {
  let i = 0;
  while (i < words.length) {
    const w = words[i]!;
    const k = kind(w);
    if (/^\w+=/.test(w)) i++;
    else if (k === "prefix") {
      const name = base(w.toLowerCase());
      const valued = PREFIX_VALUED.get(name) ?? /^-[ugCD]$/;
      for (i++; words[i]?.startsWith("-"); ) i += valued.test(words[i]!) ? 2 : 1;
      if (name === "timeout") i++; // the duration
    } else if (k === "shell") {
      const code = CODE.get("shell")!;
      let j = i + 1;
      while (words[j]?.startsWith("-") && !code.test(words[j]!)) j++;
      if (!code.test(words[j] ?? "")) return i;
      i = j + 1;
    } else return i;
  }
  return i;
}

/**
 * `download_executed`: the command line downloads to a local file and a later command in it runs that same file.
 * Linear in the line: one lexing pass, then a constant amount of work per word.
 */
export function downloadExecuted(line: string): boolean {
  const fetched = new Set<string>();
  for (const words of commands(line)) {
    const i = start(words);
    if (i >= words.length) continue;
    const args: string[] = [];
    const into: string[] = [];
    let from: string | undefined;
    for (let j = i + 1; j < words.length; j++) {
      const w = words[j]!;
      if (w === ">" || w === "<") {
        const target = words[++j];
        if (w === ">" && target) into.push(target);
        else from = target;
      } else args.push(w);
    }
    const name = words[i]!;
    const k = kind(name);
    const ran = runs(k, args) ?? (CODE.has(k) ? from : undefined); // `sh < i.sh`
    if (fetched.has(norm(name)) || (ran !== undefined && fetched.has(norm(ran)))) return true;
    if (DOWNLOADERS.has(k)) {
      for (const f of [...downloads(k, args), ...into]) if (norm(f) && f !== "-") fetched.add(norm(f)); // `-o -`: stdout
    }
  }
  return false;
}

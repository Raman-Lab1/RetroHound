// `retrohound rules convert`: hands the rules to a local sigma-cli with our pySigma pipeline (integrations/pysigma).
// Runs `sigma` from PATH without a shell and never installs or downloads it: no `sigma`, exit 2 with a hint.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { DEFAULT_RULES_DIR, PIPELINES_DIR } from "../version.ts";
import { oneOf, type IO, type Registrar } from "./io.ts";

const PIPELINES = ["ecs", "ocsf"] as const;
export const SIGMA_HINT =
  "retrohound: `sigma` not found on PATH; install sigma-cli (`pipx install sigma-cli`) and a backend (`sigma plugin install <backend>`)\n";

type Flags = { target: string; pipeline: string; skipUnsupported?: boolean };

export function convertRules(rules: string[], f: Flags, io: IO): Promise<number> {
  const pipeline = join(PIPELINES_DIR, `${oneOf("pipeline", f.pipeline, PIPELINES)}.yml`);
  const skip = f.skipUnsupported ? ["-s"] : [];
  const args = ["convert", "-t", f.target, "-p", pipeline, ...skip, "--", ...(rules.length ? rules : [DEFAULT_RULES_DIR])];
  return new Promise((done) => {
    // spawn, not execFile: no output buffer limit, and the output streams as sigma writes it.
    const child = spawn("sigma", args, { env: io.env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8").on("data", io.out);
    child.stderr.setEncoding("utf8").on("data", io.err);
    child.on("error", (e: NodeJS.ErrnoException) => {
      io.err(e.code === "ENOENT" ? SIGMA_HINT : `retrohound: cannot run sigma: ${e.message}\n`);
      done(e.code === "ENOENT" ? 2 : 3);
    });
    child.on("close", (code) => done(code === 0 ? 0 : 3)); // a promise settles once: after "error" this is a no-op
  });
}

export const registerConvert: Registrar = (rules, run, io) => {
  rules.command("convert [rules...]").description("Convert rules to SIEM queries with a local sigma-cli (default: the shipped rules)")
    .requiredOption("-t, --target <backend>", "sigma-cli backend, see `sigma list targets`")
    .requiredOption("--pipeline <name>", "field names of the export your SIEM holds: ecs (ndjson-ecs) | ocsf (ndjson-ocsf)")
    .option("-s, --skip-unsupported", "skip rules the backend or pipeline cannot convert instead of stopping")
    .action((paths: string[], f: Flags) => run(() => convertRules(paths, f, io)));
};

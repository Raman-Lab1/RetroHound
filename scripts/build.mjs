// Builds the single-file Node bundle (ADR 0010). Run with bun: `bun scripts/build.mjs`.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
// Node 22.13 to 24.14 print "ExperimentalWarning: SQLite is an experimental feature" on stderr when node:sqlite loads.
// Drop that one warning (matched by type AND message); every other warning still reaches stderr.
const banner = `/*rh-warn*/{const e=process.emitWarning;process.emitWarning=function(w,...a){const t=typeof a[0]==="string"?a[0]:a[0]?.type;if(t==="ExperimentalWarning"&&/^SQLite\\b/.test(String(w?.message??w)))return;return e.call(this,w,...a)}}`;
const r = await Bun.build({ entrypoints: ["src/cli/entry.ts"], target: "node", format: "esm", minify: true, outdir: "dist", naming: "cli.mjs", banner });
if (!r.success) {
  for (const l of r.logs) console.error(String(l));
  process.exit(1);
}

// ADR 0010: the bundle inlines these packages, so their licences ship next to it.
// shortcut: the list is devDependencies minus types and the compiler; derive it from the bundle's inputs if that grows.
const dev = Object.keys(JSON.parse(readFileSync("package.json", "utf8")).devDependencies);
const parts = dev.filter((n) => !n.startsWith("@types/") && n !== "typescript").map((n) => {
  const dir = `node_modules/${n}`;
  const pkg = JSON.parse(readFileSync(`${dir}/package.json`, "utf8"));
  const file = readdirSync(dir).find((f) => /^licen[cs]e/i.test(f));
  if (!file) throw new Error(`${n}: no licence file`);
  return `${n}@${pkg.version} (${pkg.license})\n\n${readFileSync(`${dir}/${file}`, "utf8").trim()}\n`;
});
writeFileSync("dist/THIRD_PARTY_LICENSES", parts.join(`\n${"-".repeat(72)}\n\n`));

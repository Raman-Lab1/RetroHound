// The footprint report `scan` writes by default: the whole index (every agent, project and session RetroHound has
// kept, not only this scan's filters) as one offline page, next to the index. Read-only on the index; the agents'
// config files are read (names and hook commands only) to set what is configured against what was used.
import { chmodSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { collectFootprint } from "../footprint/data.ts";
import { renderFootprint } from "../footprint/html.ts";
import { readConfigs } from "../footprint/snapshot.ts";
import { openReadOnly } from "../store/index.ts";
import { loadRuleDir } from "./rules.ts";

/** Named after its index (index.db -> index.footprint.html), so it never lands on a file the user made, and purge
 * of one index never takes another index's page. */
export const defaultReportPath = (dbPath: string) => join(dirname(dbPath), `${basename(dbPath, extname(dbPath))}.footprint.html`);

type Options = {
  dbPath: string; out: string; rulesDir: string; extraRules?: string[]; retentionDays?: number;
  env: Record<string, string | undefined>; // HOME (else the OS home) and the agents' own variables, e.g. CLAUDE_CONFIG_DIR
};

/** Writes the page owner-only, like the index (it holds masked commands and paths), and returns its file URL. */
export function writeFootprint(o: Options): string {
  const db = openReadOnly(o.dbPath);
  let html: string;
  try {
    const rules = loadRuleDir(o.rulesDir, o.extraRules).rules;
    // most recently used projects first: the readers cap how many they open
    const projects = db.prepare(`SELECT project_path AS p FROM sessions WHERE project_path IS NOT NULL
      GROUP BY project_path ORDER BY MAX(last_ts) DESC`).all().map((r) => String(r.p));
    const config = readConfigs(o.env, projects);
    html = renderFootprint(collectFootprint(db, { rules, retentionDays: o.retentionDays, config }));
  } finally {
    db.close();
  }
  writeFileSync(o.out, html, { mode: 0o600 });
  chmodSync(o.out, 0o600); // `mode` only applies when the file is created
  return pathToFileURL(o.out).href;
}

// The footprint report `scan` writes by default: the whole index (every agent, project and session RetroHound has
// kept, not only this scan's filters) as one offline page, next to the index. Read-only on the index.
import { chmodSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { collectFootprint } from "../footprint/data.ts";
import { renderFootprint } from "../footprint/html.ts";
import { openReadOnly } from "../store/index.ts";
import { loadRuleDir } from "./rules.ts";

export const defaultReportPath = (dbPath: string) => join(dirname(dbPath), "report.html");

type Options = { dbPath: string; out: string; rulesDir: string; extraRules?: string[]; retentionDays?: number };

/** Writes the page owner-only, like the index (it holds masked commands and paths), and returns its file URL. */
export function writeFootprint(o: Options): string {
  const db = openReadOnly(o.dbPath);
  let html: string;
  try {
    const rules = loadRuleDir(o.rulesDir, o.extraRules).rules;
    html = renderFootprint(collectFootprint(db, { rules, retentionDays: o.retentionDays }));
  } finally {
    db.close();
  }
  writeFileSync(o.out, html, { mode: 0o600 });
  chmodSync(o.out, 0o600); // `mode` only applies when the file is created
  return pathToFileURL(o.out).href;
}

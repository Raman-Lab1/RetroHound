// Incremental, append-only indexing (ADR 0008). Reads transcripts, never changes them.
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { mask } from "../normalize/mask.ts";
import type { ParsedFile } from "../normalize/types.ts";
import type { FileRecord, Store } from "./index.ts";

/** `sha256` is the digest of the bytes the parser read; when absent the indexer reads the file itself. */
export type Parse = (path: string) => Promise<ParsedFile & { sha256?: string }>;
export type IndexResult = {
  indexed: number;
  skipped: number;
  gone: number;
  events: number;
  failed: { path: string; error: string }[]; // both masked: parser errors can quote the line they choked on
};

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

/**
 * Indexes `paths`: unchanged files are skipped, the rest are re-parsed whole and committed one transaction per file.
 * A failed file keeps what it had and is retried next run. Any known file now missing is marked gone, listed or not,
 * so a scan of one project can still see it.
 */
export async function indexFiles(store: Store, paths: string[], parse: Parse, parserVersion: string): Promise<IndexResult> {
  const result: IndexResult = { indexed: 0, skipped: 0, gone: 0, events: 0, failed: [] };
  const seen = new Set<string>();
  const unchanged: string[] = [];
  // A file is recorded only with its sessions refreshed, in the last transaction: a crash before it leaves the file
  // unrecorded, so the next run re-parses it (an idempotent upsert) and repairs the session rows.
  const written: FileRecord[] = [];
  const dirty = new Set<string>();

  for (const path of paths) {
    try {
      // Stat before reading: a write landing mid-parse then shows as a change next run, not as already indexed.
      const { size, mtimeMs: mtime } = statSync(path);
      seen.add(mask(path));
      if (!store.shouldIndex(path, size, mtime, parserVersion)) {
        unchanged.push(path);
        result.skipped++;
        continue;
      }
      const known = store.getFile(path);
      const parsed = await parse(path);
      const { events } = parsed;
      const hash = known && known.size === size && known.mtime === mtime ? known.sha256 : (parsed.sha256 ?? (await sha256(path)));
      store.transaction(() => {
        if (known && known.parser_version !== parserVersion) store.deleteEvents(path, false).forEach((s) => dirty.add(s));
        store.upsertEvents(path, events, false).forEach((s) => dirty.add(s));
      });
      written.push({ path, size, mtime, parser_version: parserVersion, sha256: hash });
      result.indexed++;
      result.events += events.length;
    } catch (err) {
      if (existsSync(path)) result.failed.push({ path: mask(path), error: mask(String(err)) });
    }
  }

  // One transaction: a commit per file would put a disk sync per file on every warm scan.
  store.transaction(() => {
    store.refreshSessions(dirty);
    for (const file of written) store.upsertFile(file);
    for (const path of unchanged) store.touchFile(path);
    for (const file of store.listFiles()) {
      // `seen` also covers a path that masking changed, which the existsSync here could not find.
      if (!file.gone_at && !seen.has(file.path) && !existsSync(file.path) && store.markGone(file.path)) result.gone++;
    }
  });
  return result;
}

// Reads a rollout, plain or zstd. Codex compresses rollouts older than 7 days.
import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import * as zlib from "node:zlib";

export type Zstd = (buf: Buffer) => Buffer;
export const NEEDS_ZSTD = "needs Node >= 22.15 to read .jsonl.zst";
// node:zlib has zstd from Node 22.15 and in Bun 1.4; typings may lag, and older runtimes lack it.
export const defaultZstd: Zstd | null = (zlib as unknown as { zstdDecompressSync?: Zstd }).zstdDecompressSync ?? null;

/** Raw bytes as on disk (for the file hash) and the decoded text. Throws when a .zst cannot be read here. */
export function readRollout(path: string, zstd: Zstd | null = defaultZstd): { raw: Buffer; text: string } {
  const raw = readFileSync(path);
  if (!path.endsWith(".zst")) return { raw, text: raw.toString("utf8") };
  if (!zstd) throw new Error(`${NEEDS_ZSTD}: ${path.split(/[\\/]/).pop()}`);
  return { raw, text: zstd(raw).toString("utf8") };
}

/** The first line only. A plain file is read in chunks (session_meta carries a large system prompt). */
export function firstLine(path: string, zstd: Zstd | null = defaultZstd): string {
  if (path.endsWith(".zst")) return readRollout(path, zstd).text.split("\n", 1)[0] ?? "";
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.allocUnsafe(65536);
    const chunks: Buffer[] = [];
    for (let got = readSync(fd, buf), total = 0; got > 0 && total < 8 * 1024 * 1024; got = readSync(fd, buf)) {
      const nl = buf.subarray(0, got).indexOf(10);
      chunks.push(Buffer.from(buf.subarray(0, nl < 0 ? got : nl)));
      total += got;
      if (nl >= 0) break;
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

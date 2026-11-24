import type { Command } from "commander";
// Shared CLI plumbing: the injectable IO and the one error type that maps to exit code 2 (bad input).
export type IO = { out: (s: string) => void; err: (s: string) => void; isTTY: boolean; env: Record<string, string | undefined> };

/** How a subcommand module (query, show) hooks into the program; `run` records its exit code. */
export type Registrar = (program: Command, run: (fn: () => number | Promise<number>) => Promise<void>, io: IO) => void;

export class UsageError extends Error {}

// The reader went away (`| head`): nothing left to print to, but the command still finishes and keeps its exit code.
// Node reports EPIPE as an 'error' event on stdout, which crashes the process unless something listens.
const ignoreEpipe = (e: Error) => {
  if ((e as { code?: string }).code !== "EPIPE") throw e;
};

export function processIO(): IO {
  if (!process.stdout.listeners("error").includes(ignoreEpipe)) process.stdout.on("error", ignoreEpipe);
  return {
    out: (s) => {
      try {
        process.stdout.write(s);
      } catch (e) {
        ignoreEpipe(e as Error); // a synchronous EPIPE
      }
    },
    err: (s) => void process.stderr.write(s),
    isTTY: Boolean(process.stdout.isTTY),
    env: process.env,
  };
}

export const useColor = (io: IO) => io.isTTY && !io.env.NO_COLOR;

/** `30d`, `12h` or an ISO date/time, as the ISO timestamp sessions are compared against. */
export function parseSince(v: string, now = Date.now()): string {
  const rel = /^(\d+)([dh])$/.exec(v);
  if (rel) return new Date(now - Number(rel[1]) * (rel[2] === "d" ? 86_400_000 : 3_600_000)).toISOString();
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new UsageError(`bad --since '${v}' (expected e.g. 30d, 12h or 2026-11-01)`);
  return new Date(t).toISOString();
}

export function oneOf<T extends string>(what: string, value: string, allowed: readonly T[]): T {
  if (!allowed.includes(value as T)) throw new UsageError(`unknown ${what} '${value}' (expected ${allowed.join(" | ")})`);
  return value as T;
}

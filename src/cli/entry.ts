#!/usr/bin/env node
// Bundle entry (ADR 0010): bin.ts with a Node shebang. The default rules dir resolves next to dist/ (see scan.ts).
import { main } from "./main.ts";

process.exitCode = await main(process.argv.slice(2));

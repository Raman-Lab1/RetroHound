// Every test runs against a temp HOME and managed-settings dir, so no scan reads (or writes) the machine's agent config.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = mkdtempSync(join(tmpdir(), "rh-test-env-"));
process.env.HOME = mkdtempSync(join(base, "home-"));
process.env.RETROHOUND_MANAGED_DIR = mkdtempSync(join(base, "managed-"));
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;
process.on("exit", () => rmSync(base, { recursive: true, force: true }));

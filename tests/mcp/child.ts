// Test entry for the child-process test: only the mcp subcommand, so the test does not depend on main.ts wiring.
import { Command } from "commander";
import { processIO } from "../../src/cli/io.ts";
import { registerMcp } from "../../src/cli/mcp.ts";

const program = new Command("retrohound");
let code = 0;
registerMcp(program, async (fn) => void (code = await fn()), processIO());
await program.parseAsync(process.argv.slice(2), { from: "user" });
process.exitCode = code;

// The README demo GIF (docs/demo/demo.tape) runs on this synthetic history; this keeps what it shows true.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeDemo } from "../../scripts/demo-history.ts";
import { runScan } from "../../src/scan.ts";

test("the demo history fires the findings the README demo shows", async () => {
  const root = mkdtempSync(join(tmpdir(), "rh-demo-"));
  try {
    writeDemo(root);
    writeFileSync(join(root, "none.yml"), "[]");
    const r = await runScan({ root, noIndex: true, ignore: join(root, "none.yml") });
    const name = new Map(r.rules.map((x) => [x.id, x.name]));
    expect(new Set(r.findings.map((f) => name.get(f.rule_id)))).toEqual(new Set([
      "secrets_read_then_egress", "exec_pipe_download_to_shell", "secrets_literal_in_tool_input",
      "control_plane_agent_config_risky_write", "secrets_read_secret_file", "blocked_retry_secret_read",
      "secrets_read_secret_file_shell", "network_paste_filedrop_command", "files_mcp_server_added",
      "control_plane_agent_config_write", "exec_package_install_new", "blocked_then_other_tool_secret_read",
    ]));
    expect(r.scan).toMatchObject({ sessions: 1, blocked: 3 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

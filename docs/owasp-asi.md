# OWASP Top 10 for Agentic Applications (2026) coverage

Which rules carry each `owasp_agentic.asiNN` tag. Titles from the OWASP GenAI Security Project announcement of
2025-12-09, checked 2026-11-11:
<https://genai.owasp.org/2025/12/09/owasp-top-10-for-agentic-applications-the-benchmark-for-agentic-security-in-the-age-of-autonomous-ai/>
(document: <https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/>).

A rule may carry several ASI tags. `tests/owasp-asi.test.ts` fails when a row does not list exactly the rules under
`rules/ai_coding_agent/` that carry its tag, so add or remove the rule name here when you change a rule's tags.
A tag outside `asi01`..`asi10` (for example `owasp_agentic.t2`, from OWASP's earlier Agentic AI Threats list) is not
in this table.

| ASI | Title | Rules |
|---|---|---|
| ASI01 | Agent Goal Hijack | `files_instruction_concealment`, `files_instruction_concealment_skill`, `files_invisible_unicode_instruction`, `files_invisible_unicode_skill`, `files_invisible_unicode_write`, `network_paste_filedrop_command`, `network_paste_filedrop_domains`, `secrets_read_then_mcp_payload` |
| ASI02 | Tool Misuse | `blocked_then_other_tool_secret_read`, `exec_git_force_push`, `exec_rm_recursive_dangerous`, `files_mcp_server_added`, `files_mcp_server_command`, `secrets_read_then_mcp_payload` |
| ASI03 | Identity & Privilege Abuse | `blocked_retry_secret_read`, `blocked_then_other_tool_secret_read`, `blocked_then_subagent_same_call`, `control_plane_disable_safety`, `control_plane_llm_endpoint_command`, `control_plane_llm_endpoint_override`, `exec_cloud_cli_credentials`, `secrets_credential_store_access`, `secrets_credential_store_probe`, `secrets_env_dump`, `secrets_literal_in_tool_input`, `secrets_read_secret_file`, `secrets_read_secret_file_shell`, `secrets_read_then_egress` |
| ASI04 | Agentic Supply Chain Vulnerabilities | `control_plane_agent_config_risky_shell_write`, `control_plane_agent_config_risky_write`, `control_plane_agent_config_shell_write`, `control_plane_agent_config_write`, `control_plane_hook_dropper_script`, `control_plane_hook_repo_script`, `control_plane_llm_endpoint_command`, `control_plane_llm_endpoint_override`, `exec_package_install_new`, `exec_vulnerable_agent_version`, `files_mcp_server_added`, `files_mcp_server_command`, `files_npm_lifecycle_script`, `secrets_read_then_mcp_payload` |
| ASI05 | Unexpected Code Execution | `control_plane_hook_dropper_script`, `exec_chmod_downloaded`, `exec_decode_to_shell`, `exec_docker_privileged`, `exec_download_then_run`, `exec_git_global_hooks`, `exec_lolbin_download`, `exec_pipe_download_to_shell`, `files_persistence_command`, `files_persistence_location`, `files_vscode_task_autorun` |
| ASI06 | Memory & Context Poisoning | `files_instruction_concealment`, `files_instruction_concealment_skill`, `files_invisible_unicode_instruction`, `files_invisible_unicode_skill`, `files_invisible_unicode_write` |
| ASI07 | Insecure Inter-Agent Communication | none |
| ASI08 | Cascading Failures | `exec_mass_delete` |
| ASI09 | Human-Agent Trust Exploitation | `files_instruction_concealment`, `files_instruction_concealment_skill` |
| ASI10 | Rogue Agents | none |

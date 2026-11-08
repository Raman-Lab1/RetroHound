# GitHub social preview (Settings > Social preview, upload by hand): `vhs docs/demo/social.tape` from the repo root.
Output docs/assets/.social.gif

Set Shell "bash"
Set FontSize 30
Set Width 1280
Set Height 640
Set Padding 48
Set Theme "Catppuccin Mocha"
Set WindowBar Colorful

Env BASH_SILENCE_DEPRECATION_WARNING "1"
Hide
Type `PS1='' && clear && printf '\e[?25l\n\e[1;35mRetroHound\e[0m\n\e[1mWhat did your AI coding agent actually run?\e[0m\n\n\e[1;31mHIGH\e[0m  exec_pipe_download_to_shell       \e[2m[main]\e[0m\n\e[1;31mHIGH\e[0m  control_plane_agent_config_write  \e[2m[sub-agent]\e[0m\n\e[1;33mMED \e[0m  blocked_retry_secret_read         \e[2m[main]\e[0m\n\n\e[36mLocal · zero network · Sigma rules\e[0m\n\e[36mClaude Code · Codex CLI · Antigravity CLI\e[0m\n'`
Enter
Sleep 1s
Show
Sleep 500ms
Screenshot docs/assets/social-preview.png

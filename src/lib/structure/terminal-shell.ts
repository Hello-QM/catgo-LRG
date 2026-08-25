/** Build the prompt hook that reports a terminal's CWD through OSC 7. */
export function osc7_setup_command(
  shell: string | undefined,
  session_id: string | undefined,
  windows_client: boolean,
): string {
  // Browser OS is only a safe default for a local terminal. A Windows user
  // can connect to a Linux HPC shell, which must still receive the POSIX hook.
  const windows_default = !session_id && !shell && windows_client
  if (shell === `powershell` || shell === `pwsh` || windows_default) {
    return `$global:__CATGO_OSC7=1; function global:prompt { $p=(Get-Location).Path; [Console]::Write("$([char]27)]7;$p$([char]27)\\"); "PS $p> " }; Clear-Host\r`
  }
  if (shell === `cmd`) {
    return `prompt $E]7;$P$E\\$P$G$S\r`
  }
  return ` export __CATGO_OSC7=1; PROMPT_COMMAND='printf "\\033]7;file://%s%s\\033\\\\" "$HOSTNAME" "$PWD"'; clear\r`
}

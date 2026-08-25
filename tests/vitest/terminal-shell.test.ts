import { describe, expect, it } from 'vitest'

import { osc7_setup_command } from '../../src/lib/structure/terminal-shell'

describe(`terminal OSC 7 shell selection`, () => {
  it(`uses PowerShell for a default local terminal on Windows`, () => {
    expect(osc7_setup_command(undefined, undefined, true)).toContain(`Get-Location`)
  })

  it(`uses the POSIX hook for a remote Linux shell on a Windows client`, () => {
    const command = osc7_setup_command(undefined, `hpc-session`, true)
    expect(command).toContain(`PROMPT_COMMAND`)
    expect(command).not.toContain(`Get-Location`)
  })

  it(`uses the selected local shell instead of the browser OS`, () => {
    expect(osc7_setup_command(`cmd`, undefined, true)).toContain(`prompt $E]7;`)
    expect(osc7_setup_command(`git-bash`, undefined, true)).toContain(`PROMPT_COMMAND`)
  })
})

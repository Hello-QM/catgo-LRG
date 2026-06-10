import { describe, expect, it } from 'vitest'
import { build_sdk_system_prompt } from '../llm-client'

describe(`build_sdk_system_prompt unicode_math`, () => {
  it(`appends the Unicode-formula note to the TOOLED prompt when unicode_math is set`, () => {
    const prompt = build_sdk_system_prompt(`deepseek`, undefined, false, false, true)
    expect(prompt).toMatch(/UNICODE characters/)
    expect(prompt).toMatch(/never use \$\.\.\.\$/)
    // Still the tooled prompt, not the text-only one
    expect(prompt).toMatch(/catgo_/)
  })

  it(`omits the note by default (desktop)`, () => {
    const prompt = build_sdk_system_prompt(`deepseek`, undefined, false, false)
    expect(prompt).not.toMatch(/does NOT render LaTeX/)
    expect(prompt).toMatch(/catgo_/)
  })

  it(`text_only branch is unchanged and already carries the note`, () => {
    const prompt = build_sdk_system_prompt(`deepseek`, undefined, false, true)
    expect(prompt).toMatch(/TEXT-ONLY/)
    expect(prompt).toMatch(/UNICODE characters/)
  })
})

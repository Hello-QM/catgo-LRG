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

  it(`text_only prompt is unaffected (has its own Unicode note; unicode_math param is a no-op)`, () => {
    const prompt = build_sdk_system_prompt(`deepseek`, undefined, false, true)
    expect(prompt).toMatch(/TEXT-ONLY/)
    expect(prompt).toMatch(/UNICODE characters/)
  })

  it(`unicode_math is a no-op when text_only is also true (no duplication)`, () => {
    const prompt = build_sdk_system_prompt(`deepseek`, undefined, false, true, true)
    expect(prompt).toMatch(/TEXT-ONLY/)
    const count = (prompt.match(/does NOT render LaTeX/g) ?? []).length
    expect(count).toBe(1)
  })

  it(`sdk-gemini with unicode_math drops the LaTeX instruction`, () => {
    const prompt = build_sdk_system_prompt(`sdk-gemini`, undefined, false, false, true)
    expect(prompt).toMatch(/UNICODE characters/)
    expect(prompt).not.toMatch(/Use LaTeX/)
  })
})

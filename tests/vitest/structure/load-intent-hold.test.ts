import { describe, expect, it } from 'vitest'
import { should_apply_push } from '$lib/structure/controllers/tool-handler'

describe('should_apply_push', () => {
  it('applies edits always', () => {
    expect(should_apply_push('edit', true)).toBe(true)
    expect(should_apply_push(undefined, true)).toBe(true)
  })
  it('applies a load into an empty viewer', () => {
    expect(should_apply_push('load', false)).toBe(true)
  })
  it('holds a load when the viewer already has a structure', () => {
    expect(should_apply_push('load', true)).toBe(false)
  })

  // Backend-authoritative had_structure (3rd arg) — race fix. The FE
  // get_structure() read can return empty during a scene remount /
  // view/reset race, so the backend tags whether the target panel was
  // ALREADY occupied before the push and the gate ORs the two signals.
  it('holds a load when the backend says the panel was occupied (FE reads empty — the race)', () => {
    expect(should_apply_push('load', false, true)).toBe(false)
  })
  it('applies a load when both FE and backend agree the panel is empty', () => {
    expect(should_apply_push('load', false, false)).toBe(true)
  })
  it('holds a load when the FE has a structure even if backend flag is false', () => {
    expect(should_apply_push('load', true, false)).toBe(false)
  })
  it('applies an edit regardless of the backend had_structure flag', () => {
    expect(should_apply_push('edit', false, true)).toBe(true)
  })
})

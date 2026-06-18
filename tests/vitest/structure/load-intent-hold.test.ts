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
})

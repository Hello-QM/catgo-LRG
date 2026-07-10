import { describe, it, expect } from 'vitest'
import { create_modified_registry } from '$lib/structure/close-guard.svelte'

describe('modified registry', () => {
  it('tracks dirty tabs and clears on save', () => {
    const r = create_modified_registry()
    expect(r.is_modified('t1')).toBe(false)
    r.mark('t1')
    expect(r.is_modified('t1')).toBe(true)
    expect(r.any_modified()).toBe(true)
    r.clear('t1')
    expect(r.is_modified('t1')).toBe(false)
    expect(r.any_modified()).toBe(false)
  })
})

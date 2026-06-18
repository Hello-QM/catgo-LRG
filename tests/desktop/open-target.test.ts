import { describe, it, expect, beforeEach } from 'vitest'
import { resolve_open_target } from '../../src/lib/state.svelte'

describe('resolve_open_target', () => {
  it('returns the default when shift is false', () => {
    expect(resolve_open_target('split', false)).toBe('split')
    expect(resolve_open_target('window', false)).toBe('window')
  })

  it('flips split→window when shift is true', () => {
    expect(resolve_open_target('split', true)).toBe('window')
  })

  it('flips window→split when shift is true', () => {
    expect(resolve_open_target('window', true)).toBe('split')
  })
})

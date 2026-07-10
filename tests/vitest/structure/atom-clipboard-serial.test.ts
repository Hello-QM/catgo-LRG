import { describe, it, expect } from 'vitest'
import { serialize_atoms, parse_atoms } from '$lib/structure/atom-clipboard-serial'

describe('atom clipboard serial', () => {
  const sites = [{ species: [{ element: 'O', occu: 1 }], xyz: [1, 2, 3], abc: [0, 0, 0] }] as any
  it('round-trips sites through a marked envelope', () => {
    const text = serialize_atoms(sites)
    expect(text.startsWith('CATGO_ATOMS_V1')).toBe(true)
    expect(parse_atoms(text)).toEqual(sites)
  })
  it('returns null for foreign / non-atom clipboard text', () => {
    expect(parse_atoms('just some copied text')).toBeNull()
    expect(parse_atoms('')).toBeNull()
  })
})

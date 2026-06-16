import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'
import { parse_cif } from '$lib/structure/parsers/cif'

describe('periodic CIF unaffected', () => {
  it('TiO2 fixture still parses with a lattice', () => {
    const text = readFileSync(resolve(__dirname, '../../src/site/structures/TiO2.cif'), 'utf-8')
    const s = parse_cif(text)
    expect(s).not.toBeNull()
    expect(s?.lattice).toBeDefined()
    expect(s?.lattice?.a).toBeGreaterThan(0)
    expect(s?.sites?.length).toBeGreaterThan(0)
  })
})

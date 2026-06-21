// tests/vitest/electronic/palettes.test.ts
import { describe, it, expect } from 'vitest'
import { PALETTE_PRESETS, PALETTE_ORDER, apply_palette } from '$lib/electronic/palettes'

describe('apply_palette', () => {
  it('assigns colors to labels in array order', () => {
    expect(apply_palette(['a', 'b', 'c'], 'npg')).toEqual({
      a: '#E64B35', b: '#4DBBD5', c: '#00A087',
    })
  })

  it('cycles when labels outnumber colors', () => {
    const labels = Array.from({ length: 8 }, (_, i) => `s${i}`)
    const out = apply_palette(labels, 'grayscale') // 6 colors
    expect(out.s6).toBe(PALETTE_PRESETS.grayscale[0])
    expect(out.s7).toBe(PALETTE_PRESETS.grayscale[1])
  })

  it('every preset in PALETTE_ORDER resolves to a non-empty array', () => {
    for (const name of PALETTE_ORDER) {
      expect(PALETTE_PRESETS[name].length).toBeGreaterThan(0)
    }
  })
})

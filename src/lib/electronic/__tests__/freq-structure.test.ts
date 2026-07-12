import { describe, expect, it } from 'vitest'
import { freq_data_to_xyz } from '../freq-structure'

describe('freq_data_to_xyz', () => {
  it('emits a valid XYZ block', () => {
    const xyz = freq_data_to_xyz(['C', 'O'], [[0, 0, 0], [1.5, 0, 0]])
    const lines = xyz.trimEnd().split('\n')
    expect(lines[0]).toBe('2')
    expect(lines[2]).toBe('C 0.00000000 0.00000000 0.00000000')
    expect(lines[3]).toBe('O 1.50000000 0.00000000 0.00000000')
  })
})

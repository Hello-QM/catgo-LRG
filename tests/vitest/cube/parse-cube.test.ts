import { describe, expect, it } from 'vitest'
import { parse_cube_full, parse_cube_header } from '$lib/cube/parse-cube'

const density = [
  'Density control', 'Two voxels, lengths in Bohr', '1 0 0 0',
  '2 1 0 0', '1 0 1 0', '1 0 0 1', '1 0 1 0 0', '0.125 0.25',
].join('\n')
const orbital = density.replace('1 0 0 0\n', '-1 0 0 0\n')
  .replace('0.125 0.25', '1 7\n0.125 0.25')

describe('Gaussian Cube coordinates and datasets', () => {
  it.each([density, orbital])('converts Bohr coordinates and reads voxel values', (text) => {
    const parsed = parse_cube_full(text)
    for (const header of [parsed.header, parse_cube_header(text)]) {
      expect(header.atoms[0].position[0]).toBeCloseTo(0.529177210903, 10)
      expect(header.voxel_axes[0][0]).toBeCloseTo(0.529177210903, 10)
      expect(header.dims).toEqual([2, 1, 1])
    }
    expect([...parsed.grid.data]).toEqual([0.125, 0.25])
    expect([parsed.grid.data_min, parsed.grid.data_max]).toEqual([0.125, 0.25])
  })

  it('allows the orbital count and ID on separate lines', () => {
    expect([...parse_cube_full(orbital.replace('1 7\n', '1\n7\n')).grid.data])
      .toEqual([0.125, 0.25])
  })

  it('accepts Fortran D exponents', () => {
    const parsed = parse_cube_full(density.replace('0.125 0.25', '1.25D-1 2.5d-1'))
    expect([...parsed.grid.data]).toEqual([0.125, 0.25])
  })

  it.each([
    density.replace('1 0 0 0\n', '1 0 0 0 2\n'),
    orbital.replace('1 7\n', '2 7 8\n'),
  ])('explicitly rejects multiple datasets instead of mixing them', (text) => {
    expect(() => parse_cube_full(text)).toThrow(/multiple|NVAL/i)
  })

  it.each([
    density.replace('2 1 0 0', '0 1 0 0'),
    density.replace('2 1 0 0', '-2 1 0 0'),
    density.replace('2 1 0 0', '2x 1 0 0'),
    density.replace('1 0 0 0\n', '1.5 0 0 0\n'),
    density.replace('1 0 1 0 0\n', ''),
    density.replace('0.125 0.25', '0.125'),
    density.replace('0.125 0.25', 'NaN 0.25'),
    density.replace('0.125 0.25', 'Infinity 0.25'),
    density.replace('0.125 0.25', '1e100 0.25'),
    density.replace('0.125 0.25', '0.125 0.25 0.5'),
    orbital.replace('1 7\n', ''),
  ])('rejects malformed input instead of silently returning corrupt data', (text) => {
    expect(() => parse_cube_full(text)).toThrow()
  })
})

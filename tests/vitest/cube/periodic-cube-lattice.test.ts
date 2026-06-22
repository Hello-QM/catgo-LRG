import { describe, expect, test } from 'vitest'
import {
  cube_atoms_to_molecule,
  derive_cube_lattice,
  parse_cube_header,
} from '$lib/cube/parse-cube'
import { find_pbc_images_fast } from '$lib/structure'

// Build a minimal periodic cube (CHGCAR→cube shape): negative n_atoms ⇒ the
// header is already in Ångström (no bohr scaling). `origin` is the grid anchor;
// the grid spans `voxel_axes[i] * dims[i]` along each axis.
function make_cube(opts: {
  cell: number
  grid: number
  origin: [number, number, number]
  atoms: [number, [number, number, number]][]
}): string {
  const { cell, grid, origin, atoms } = opts
  const dv = cell / grid
  const lines: string[] = [`periodic cube`, `regression fixture`]
  // negative count ⇒ Ångström units
  lines.push(`${-atoms.length}  ${origin[0]}  ${origin[1]}  ${origin[2]}`)
  lines.push(`${grid}  ${dv}  0  0`)
  lines.push(`${grid}  0  ${dv}  0`)
  lines.push(`${grid}  0  0  ${dv}`)
  for (const [z, p] of atoms) {
    lines.push(`${z}  ${z}.0  ${p[0]}  ${p[1]}  ${p[2]}`)
  }
  // voxel payload (values are irrelevant to header parsing)
  const total = grid * grid * grid
  for (let i = 0; i < total; i += 6) {
    lines.push(`  ` + new Array(Math.min(6, total - i)).fill(`0.001`).join(`  `))
  }
  return lines.join(`\n`)
}

describe('periodic cube → lattice + displayed-structure pipeline', () => {
  test('derive_cube_lattice spans the full grid (voxel × dims)', () => {
    const header = parse_cube_header(
      make_cube({ cell: 4, grid: 10, origin: [0, 0, 0], atoms: [[78, [0, 0, 0]]] }),
    )
    expect(derive_cube_lattice(header.dims, header.voxel_axes)).toEqual([
      [4, 0, 0],
      [0, 4, 0],
      [0, 0, 4],
    ])
  })

  test('periodic cube carries a real lattice and in-cell fractional coords', () => {
    const header = parse_cube_header(
      make_cube({
        cell: 4,
        grid: 10,
        origin: [0, 0, 0],
        atoms: [
          [78, [0, 0, 0]],
          [78, [2, 2, 2]],
        ],
      }),
    )
    const mol = cube_atoms_to_molecule(header, { periodic: true })

    expect(mol.lattice).toBeTruthy()
    expect(mol.lattice?.matrix).toEqual([
      [4, 0, 0],
      [0, 4, 0],
      [0, 0, 4],
    ])
    // pbc must be all-true so the periodic machinery (cell box + PBC bonds) runs
    expect(mol.lattice?.pbc).toEqual([true, true, true])
    expect(mol.sites[0].abc).toEqual([0, 0, 0])
    expect(mol.sites[1].abc).toEqual([0.5, 0.5, 0.5])
  })

  test('non-zero grid origin is folded into atom coords so they sit in the box', () => {
    // Real periodic cube whose grid is anchored at (-4,-4,-4); the atom is
    // written in absolute Cartesian. After load it must land at the cell centre
    // (frac 0.5,0.5,0.5) RELATIVE to the box drawn from the world origin — not
    // at frac -1 outside the box (which would make the slab look detached).
    const header = parse_cube_header(
      make_cube({
        cell: 4,
        grid: 10,
        origin: [-4, -4, -4],
        atoms: [[78, [-2, -2, -2]]],
      }),
    )
    const mol = cube_atoms_to_molecule(header, { periodic: true })
    expect(mol.lattice).toBeTruthy()
    expect(mol.sites[0].xyz).toEqual([2, 2, 2])
    expect(mol.sites[0].abc).toEqual([0.5, 0.5, 0.5])
  })

  test('find_pbc_images_fast preserves the lattice (cell box stays drawable)', async () => {
    const header = parse_cube_header(
      make_cube({
        cell: 4,
        grid: 10,
        origin: [0, 0, 0],
        atoms: [
          [78, [0, 0, 0]],
          [78, [2, 2, 2]],
        ],
      }),
    )
    const mol = cube_atoms_to_molecule(header, { periodic: true })
    const imaged = await find_pbc_images_fast(mol as never)

    // The cell-box render gate reads get_lattice(displayed_structure); it must
    // remain truthy after the PBC-image expansion that produces displayed_structure.
    expect(`lattice` in imaged && (imaged as { lattice?: unknown }).lattice).toBeTruthy()
    // A boundary atom at frac 0 spawns image copies ⇒ more sites than the input.
    expect(imaged.sites.length).toBeGreaterThan(mol.sites.length)
  })

  test('molecular cube (default, non-periodic) has NO lattice', () => {
    const header = parse_cube_header(
      make_cube({ cell: 4, grid: 10, origin: [-2, -2, -2], atoms: [[8, [0, 0, 0]]] }),
    )
    const mol = cube_atoms_to_molecule(header)
    expect((mol as { lattice?: unknown }).lattice).toBeFalsy()
    // molecular cubes keep absolute Cartesian coords and zeroed fractional coords
    expect(mol.sites[0].xyz).toEqual([0, 0, 0])
    expect(mol.sites[0].abc).toEqual([0, 0, 0])
  })
})

// #536 — the indexed/lazy XYZ loader must preserve the extxyz Lattice.
//
// parse_trajectory_async routes text trajectories > 2 MB through the unified
// indexed loader (TrajFrameReader.load_xyz_frame), which used to pass
// `undefined` lattice/pbc to create_trajectory_frame even though every frame
// comment carried a valid `Lattice="..."` field. The SAME file below the
// threshold (eager parsers/xyz.ts path) kept its lattice — so behavior
// silently diverged on file size: no cell box, non-periodic bonds, and the
// supercell controls vanished for any extxyz over 2 MB.
import type { Matrix3x3 } from '$lib/math'
import { parse_trajectory_async, TrajFrameReader } from '$lib/trajectory/parse'
import { parse_trajectory_data } from '$lib/trajectory/parse'
import { describe, expect, it } from 'vitest'

type LatticeStructure = { lattice?: { matrix: Matrix3x3; pbc: boolean[] } }

/** Synthetic extxyz: per-frame Lattice (variable-cell when grow_cell). */
function make_extxyz(
  num_frames: number,
  atoms_per_frame: number,
  { with_lattice = true, grow_cell = false } = {},
): string {
  const frames: string[] = []
  for (let ii = 0; ii < num_frames; ii++) {
    const aa = 10 + (grow_cell ? ii : 0)
    const lattice = with_lattice
      ? `Lattice="${aa}.0 0.0 0.0 0.0 ${aa}.0 0.0 0.0 0.0 ${aa}.0" `
      : ``
    const lines = [
      `${atoms_per_frame}`,
      `${lattice}Properties=species:S:1:pos:R:3 pbc="T T T" step=${ii}`,
    ]
    for (let jj = 0; jj < atoms_per_frame; jj++) {
      lines.push(`Cu ${(jj % 10) * 0.9} ${Math.floor(jj / 10) * 0.9} ${ii * 0.01}`)
    }
    frames.push(lines.join(`\n`))
  }
  return frames.join(`\n`) + `\n`
}

const lattice_of = (structure: unknown) => (structure as LatticeStructure).lattice

describe(`indexed XYZ loading preserves the extxyz lattice (#536)`, () => {
  it(`forced-indexing path attaches lattice + pbc exactly like the eager path`, async () => {
    const data = make_extxyz(6, 4)
    const indexed = await parse_trajectory_async(data, `traj.extxyz`, undefined, {
      use_indexing: true,
    })
    expect(indexed.is_indexed).toBe(true)
    expect(indexed.frames.length).toBeGreaterThan(0)

    const eager = await parse_trajectory_data(data, `traj.extxyz`)
    const idx_lattice = lattice_of(indexed.frames[0].structure)
    const eager_lattice = lattice_of(eager.frames[0].structure)
    expect(idx_lattice).toBeDefined()
    expect(idx_lattice!.matrix).toEqual([[10, 0, 0], [0, 10, 0], [0, 0, 10]])
    expect(idx_lattice!.pbc).toEqual([true, true, true])
    // Parity with the eager parser — the two paths must never disagree.
    expect(idx_lattice!.matrix).toEqual(eager_lattice!.matrix)
    expect(idx_lattice!.pbc).toEqual(eager_lattice!.pbc)
  })

  it(`on-demand frame loads carry each frame's OWN lattice (variable-cell)`, async () => {
    const data = make_extxyz(8, 3, { grow_cell: true })
    const loader = new TrajFrameReader(`varcell.extxyz`)
    const frame_0 = await loader.load_frame(data, 0)
    const frame_5 = await loader.load_frame(data, 5)
    expect(lattice_of(frame_0!.structure)!.matrix[0][0]).toBe(10)
    expect(lattice_of(frame_5!.structure)!.matrix[0][0]).toBe(15)
  })

  it(`molecular xyz (no Lattice field) stays lattice-free on the indexed path`, async () => {
    const data = make_extxyz(4, 3, { with_lattice: false })
    const result = await parse_trajectory_async(data, `mol.xyz`, undefined, {
      use_indexing: true,
    })
    expect(result.is_indexed).toBe(true)
    expect(lattice_of(result.frames[0].structure)).toBeUndefined()
  })

  it(`>2 MB extxyz auto-routes to the indexed loader AND keeps its lattice`, async () => {
    // Big enough to cross TEXT_INDEX_THRESHOLD (2 MB) so parse_trajectory_async
    // takes the indexed path on its own — the exact user-facing regression.
    const data = make_extxyz(27, 5000)
    expect(data.length).toBeGreaterThan(2 * 1024 * 1024)

    const result = await parse_trajectory_async(data, `big-md.extxyz`)
    expect(result.is_indexed).toBe(true)
    expect(result.total_frames).toBe(27)
    const lattice = lattice_of(result.frames[0].structure)
    expect(lattice).toBeDefined()
    expect(lattice!.matrix).toEqual([[10, 0, 0], [0, 10, 0], [0, 0, 10]])
    expect(lattice!.pbc).toEqual([true, true, true])
  })
})

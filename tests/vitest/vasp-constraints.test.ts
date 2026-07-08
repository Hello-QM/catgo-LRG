import { describe, expect, it } from 'vitest'
import { apply_move_mask, has_constraints, move_mask_from_poscar } from '$lib/trajectory/vasp-constraints'
import type { TrajectoryType } from '$lib/trajectory'

// POSCAR with selective dynamics: atom 0 free (T T T), atom 1 fully fixed (F F F).
const POSCAR = `Pt O test
1.0
5.0 0.0 0.0
0.0 5.0 0.0
0.0 0.0 5.0
Pt O
1 1
Selective dynamics
Direct
0.0 0.0 0.0  T T T
0.5 0.5 0.5  F F F
`

function fake_traj(): TrajectoryType {
  const mk = (force: number[][]) => ({
    step: 0,
    metadata: { forces: force },
    structure: {
      sites: [
        { species: [{ element: 'Pt', occu: 1, oxidation_state: 0 }], abc: [0, 0, 0], xyz: [0, 0, 0], label: 'Pt1', properties: {} },
        { species: [{ element: 'O', occu: 1, oxidation_state: 0 }], abc: [0.5, 0.5, 0.5], xyz: [2.5, 2.5, 2.5], label: 'O2', properties: {} },
      ],
    },
  })
  return { frames: [mk([[0.1, 0, 0], [3.0, 0, 0]])], metadata: {} } as unknown as TrajectoryType
}

describe('vasp-constraints (OUTCAR/XDATCAR sibling CONTCAR)', () => {
  it('move_mask_from_poscar: free atom true, fully-fixed atom false', () => {
    expect(move_mask_from_poscar(POSCAR)).toEqual([true, false])
  })

  it('returns null when the POSCAR has no selective dynamics', () => {
    const no_sd = POSCAR.replace('Selective dynamics\n', '')
    expect(move_mask_from_poscar(no_sd)).toBeNull()
  })

  it('apply_move_mask stamps selective_dynamics + move_mask on every frame', () => {
    const traj = fake_traj()
    expect(has_constraints(traj)).toBe(false)
    expect(apply_move_mask(traj, [true, false])).toBe(true)
    expect(has_constraints(traj)).toBe(true)
    const sites = traj.frames[0].structure.sites
    expect(sites[1].properties?.selective_dynamics).toEqual([false, false, false])
    expect(sites[1].properties?.move_mask).toBe(false)
    expect(sites[0].properties?.move_mask).toBe(true)
  })

  it('apply_move_mask no-ops on atom-count mismatch', () => {
    const traj = fake_traj()
    expect(apply_move_mask(traj, [true])).toBe(false)
  })
})

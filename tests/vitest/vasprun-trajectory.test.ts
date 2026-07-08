import { describe, expect, it } from 'vitest'
import { parse_vasprun_trajectory } from '$lib/structure/parsers/vasp'
import { parse_xyz_trajectory } from '$lib/trajectory/parsers/xyz'
import { compute_force_data } from '$lib/structure/scene/render-data'
import type { Site } from '$lib'

// vasprun.xml with a fixed atom (O, selective F F F) that carries the LARGEST
// force. The energy/force curves and the force arrows must ignore it — the max
// force belongs to the free atom (Cu).
const VASPRUN = `<?xml version="1.0" encoding="ISO-8859-1"?>
<modeling>
 <atominfo>
  <array name="atoms">
   <set>
    <rc><c>Cu</c><c>1</c></rc>
    <rc><c>O </c><c>2</c></rc>
   </set>
  </array>
 </atominfo>
 <structure name="initialpos">
  <varray name="selective">
   <v> T  T  T </v>
   <v> F  F  F </v>
  </varray>
 </structure>
 <calculation>
  <structure>
   <crystal>
    <varray name="basis">
     <v> 5 0 0 </v><v> 0 5 0 </v><v> 0 0 5 </v>
    </varray>
   </crystal>
   <varray name="positions">
    <v> 0.0 0.0 0.0 </v><v> 0.5 0.5 0.5 </v>
   </varray>
  </structure>
  <varray name="forces">
   <v> 0.10 0 0 </v><v> 3.00 0 0 </v>
  </varray>
  <energy><i name="e_fr_energy"> -10.5 </i><i name="e_0_energy"> -10.4 </i></energy>
 </calculation>
 <calculation>
  <structure>
   <crystal>
    <varray name="basis">
     <v> 5 0 0 </v><v> 0 5 0 </v><v> 0 0 5 </v>
    </varray>
   </crystal>
   <varray name="positions">
    <v> 0.0 0.0 0.0 </v><v> 0.5 0.5 0.5 </v>
   </varray>
  </structure>
  <varray name="forces">
   <v> 0.05 0 0 </v><v> 2.50 0 0 </v>
  </varray>
  <energy><i name="e_fr_energy"> -11.0 </i></energy>
 </calculation>
</modeling>`

describe('vasprun.xml trajectory (energy + forces + selective dynamics)', () => {
  it('emits extxyz with energy, forces, and a move_mask column', () => {
    const extxyz = parse_vasprun_trajectory(VASPRUN)
    expect(extxyz).not.toBeNull()
    expect(extxyz!).toContain('energy=-10.5')
    expect(extxyz!).toContain('energy=-11')
    expect(extxyz!).toContain('forces:R:3')
    expect(extxyz!).toContain('move_mask:L:1')
  })

  it('parses two frames with per-step energy; force_max excludes the fixed atom', () => {
    const extxyz = parse_vasprun_trajectory(VASPRUN)!
    const traj = parse_xyz_trajectory(extxyz)
    expect(traj.frames.length).toBe(2)
    expect(traj.frames[0].metadata.energy).toBeCloseTo(-10.5, 6)
    expect(traj.frames[1].metadata.energy).toBeCloseTo(-11.0, 6)
    // Fixed O atom has |F|=3.0 but is F F F → force curve must report the free
    // Cu atom's 0.1, NOT 3.0.
    expect(traj.frames[0].metadata.force_max).toBeCloseTo(0.1, 6)
    expect(traj.frames[1].metadata.force_max).toBeCloseTo(0.05, 6)
    // The fixed atom is flagged movable=false on the site.
    expect(traj.frames[0].structure.sites[1].properties?.move_mask).toBe(false)
    expect(traj.frames[0].structure.sites[0].properties?.move_mask).toBe(true)
  })

  it('compute_force_data max_only picks the free atom, not the larger fixed force', () => {
    const sites = [
      { species: [{ element: 'Cu', occu: 1, oxidation_state: 0 }], abc: [0, 0, 0], xyz: [0, 0, 0], label: 'Cu1', properties: { force: [0.1, 0, 0], move_mask: true } },
      { species: [{ element: 'O', occu: 1, oxidation_state: 0 }], abc: [0.5, 0.5, 0.5], xyz: [2.5, 2.5, 2.5], label: 'O2', properties: { force: [3.0, 0, 0], move_mask: false } },
    ] as unknown as Site[]
    const arrows = compute_force_data(sites, 1, '#fff', 'element', 'max_only', {}, 0, Infinity)
    expect(arrows.length).toBe(1)
    expect(arrows[0].magnitude).toBeCloseTo(0.1, 6) // Cu, not the fixed O's 3.0
    expect(arrows[0].position).toEqual([0, 0, 0])
  })
})

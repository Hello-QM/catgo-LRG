// OUTCAR and XDATCAR carry no selective-dynamics (fixed-atom) information — it
// lives only in the POSCAR/CONTCAR. These helpers derive the fixed mask from a
// sibling CONTCAR/POSCAR and stamp it onto an already-parsed trajectory so the
// frozen-atom rings and the F_max/F_norm curve exclude the constrained atoms,
// exactly as they do for vasprun.xml (which has the constraints inline).

import { parse_poscar } from '$lib/structure/parse'
import type { TrajectoryType } from './index'

/** Per-atom "movable" mask from a POSCAR/CONTCAR's selective dynamics.
 *  true = free (movable in ≥1 direction), false = fully fixed (F F F).
 *  Returns null when the file declares no selective dynamics. */
export function move_mask_from_poscar(content: string): boolean[] | null {
  const parsed = parse_poscar(content)
  if (!parsed?.sites?.length) return null
  let any_sd = false
  const mask = parsed.sites.map((s) => {
    const sd = s.properties?.selective_dynamics as [boolean, boolean, boolean] | undefined
    if (sd) any_sd = true
    return sd ? sd[0] || sd[1] || sd[2] : true
  })
  return any_sd ? mask : null
}

/** Stamp a per-atom movable mask onto every frame of a trajectory (by index —
 *  VASP preserves atom order across POSCAR/OUTCAR/XDATCAR). Sets both move_mask
 *  and selective_dynamics so every consumer (frozen rings, F_max curve, force
 *  arrows, exporters) sees it. No-op + false if the atom counts don't match. */
export function apply_move_mask(trajectory: TrajectoryType, mask: boolean[]): boolean {
  const n = trajectory.frames?.[0]?.structure?.sites?.length
  if (!n || n !== mask.length) return false
  for (const frame of trajectory.frames) {
    const sites = frame.structure?.sites
    if (!sites || sites.length !== mask.length) continue
    sites.forEach((site, i) => {
      site.properties = {
        ...site.properties,
        move_mask: mask[i],
        selective_dynamics: mask[i]
          ? [true, true, true]
          : [false, false, false],
      }
    })
  }
  return true
}

/** True when a trajectory already carries per-atom constraint info (vasprun) and
 *  therefore needs no sibling-CONTCAR lookup. */
export function has_constraints(trajectory: TrajectoryType): boolean {
  const p = trajectory.frames?.[0]?.structure?.sites?.[0]?.properties
  return !!(p && (p.selective_dynamics || p.move_mask !== undefined))
}

import type { AnyStructure, ElementSymbol, Vec3 } from '$lib'
import { add_atom, delete_atoms, replace_atom } from '$lib/structure'
import type { PymatgenStructure } from '$lib/structure'
import { matrix_inverse_3x3, transpose_3x3_matrix } from '$lib/math'
import type { SupercellOp } from '$lib/structure/supercell-operation'
import { execute_supercell_op_sync } from '$lib/structure/supercell-operation'
import { apply_displacements } from './edit-apply'
import type { TrajectoryFrame, TrajectoryType } from './index'
import {
  break_frame_supercell_provenance,
  frame_with_supercell_execution,
} from './supercell-transactions'

/**
 * Discriminated union of pane-ledger operations (design §9.3).
 * `scale_geometry` is the pre-existing streamed all-frame edit (formerly
 * `TrajectoryTransformation` in `clone.ts`); `supercell` is the canonical
 * Build → Lattice → Supercell op executed by `execute_supercell_op_sync`.
 */
export type TrajectoryEditOp =
  | { kind: `scale_geometry`; factor: number }
  | { kind: `delete`; site_indices: number[] }
  | { kind: `add`; element: ElementSymbol; position: Vec3 }
  | { kind: `replace`; site_indices: number[]; new_element: ElementSymbol }
  | { kind: `manipulate`; displacements: Map<number, Vec3> }
  | SupercellOp

/**
 * Apply ONE ledger op to a structure, returning a new structure. Pure: never
 * mutates the input; throws cleanly (no partial result) on invalid ops, so a
 * caller retains its last complete scene.
 */
export function apply_trajectory_edit_op(
  structure: AnyStructure,
  op: TrajectoryEditOp,
): AnyStructure {
  switch (op.kind) {
    case `scale_geometry`:
      return scale_structure_geometry(structure, op.factor)
    case `delete`:
      return delete_atoms(structure, op.site_indices)
    case `add`:
      return add_atom(structure, op.element, op.position)
    case `replace`: {
      let next = structure
      for (const idx of op.site_indices) {
        next = replace_atom(next, idx, op.new_element)
      }
      return next
    }
    case `manipulate`: {
      let inverse:
        | [number, number, number, number, number, number, number, number, number]
        | null = null
      if (`lattice` in structure && structure.lattice) {
        const matrix = matrix_inverse_3x3(
          transpose_3x3_matrix(structure.lattice.matrix),
        )
        inverse = [
          matrix[0][0], matrix[0][1], matrix[0][2],
          matrix[1][0], matrix[1][1], matrix[1][2],
          matrix[2][0], matrix[2][1], matrix[2][2],
        ]
      }
      return {
        ...structure,
        sites: apply_displacements(structure.sites, op.displacements, inverse),
      }
    }
    case `supercell`:
      return execute_supercell_op_sync(
        structure as PymatgenStructure,
        op,
      ).structure as AnyStructure
  }
}

export function apply_trajectory_edit_op_to_frame(
  frame: TrajectoryFrame,
  op: TrajectoryEditOp,
): TrajectoryFrame {
  if (op.kind === `supercell`) {
    return frame_with_supercell_execution(
      frame,
      execute_supercell_op_sync(frame.structure as PymatgenStructure, op),
    )
  }
  const source = op.kind === `add` || op.kind === `delete` ||
      op.kind === `replace` || op.kind === `manipulate`
    ? break_frame_supercell_provenance(frame)
    : frame
  return {
    ...source,
    structure: apply_trajectory_edit_op(source.structure, op),
  }
}

export function topology_signature(structure: AnyStructure): string {
  return structure.sites
    .map((site) => site.species?.[0]?.element ?? site.label ?? `?`)
    .join(`,`)
}

export function validate_uniform_topology(trajectory: TrajectoryType): string | null {
  const first = trajectory.frames[0]?.structure
  if (!first) return `Trajectory has no loaded frame.`
  const signature = topology_signature(first)
  for (let i = 1; i < trajectory.frames.length; i++) {
    const frame = trajectory.frames[i]
    if (!frame?.structure || topology_signature(frame.structure) !== signature) {
      return `Frame ${i} has a different atom count or element order; an all-frame topology edit would be unsafe.`
    }
  }
  return null
}

export function scale_structure_geometry(structure: AnyStructure, factor: number): AnyStructure {
  if (!Number.isFinite(factor) || factor <= 0) throw new Error(`Scale factor must be positive.`)
  const sites = structure.sites
  if (`lattice` in structure && structure.lattice) {
    const next_sites = sites.map((site) => ({
      ...site,
      // Scaling lattice and Cartesian coordinates about the lattice origin
      // preserves fractional coordinates exactly.
      xyz: site.xyz.map((x) => x * factor) as [number, number, number],
      ...(site.abc ? { abc: [...site.abc] as [number, number, number] } : {}),
    }))
    const matrix = structure.lattice.matrix.map((row) => row.map((x) => x * factor))
    return {
      ...structure,
      sites: next_sites,
      lattice: {
        ...structure.lattice,
        matrix,
        a: structure.lattice.a != null ? structure.lattice.a * factor : structure.lattice.a,
        b: structure.lattice.b != null ? structure.lattice.b * factor : structure.lattice.b,
        c: structure.lattice.c != null ? structure.lattice.c * factor : structure.lattice.c,
        volume: structure.lattice.volume != null ? structure.lattice.volume * factor ** 3 : structure.lattice.volume,
      },
    } as AnyStructure
  }
  const center = sites.reduce(
    (acc, site) => [acc[0] + site.xyz[0], acc[1] + site.xyz[1], acc[2] + site.xyz[2]],
    [0, 0, 0],
  ).map((x) => x / Math.max(1, sites.length))
  const next_sites = sites.map((site) => ({
    ...site,
    xyz: site.xyz.map((x, axis) => center[axis] + (x - center[axis]) * factor) as [number, number, number],
    ...(site.abc ? { abc: [...site.abc] as [number, number, number] } : {}),
  }))
  return { ...structure, sites: next_sites } as AnyStructure
}

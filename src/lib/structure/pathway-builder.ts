/**
 * Pure functions for reaction pathway building:
 * - Capture adsorbate atoms relative to surface sites
 * - Apply adsorbates to any surface
 * - Generate combinatorial trajectory (n surfaces × m pathways)
 */

import type { ElementSymbol, Vec3 } from '$lib'
import type { AnyStructure, PymatgenStructure, Site } from '$lib/structure'
import type { TrajectoryFrame, TrajectoryType } from '$lib/trajectory'
import { normalize_pymatgen_frame_structure } from '$lib/trajectory/parsers/json'
import { mat3x3_vec3_multiply, matrix_inverse_3x3, transpose_3x3_matrix } from '$lib/math'
import type {
  AnchoredAtom,
  PathwayFrameMetadata,
  PathwayTrajectoryMetadata,
  ReactionPathway,
} from './pathway-types'

/**
 * Capture adsorbate atoms from a structure as AnchoredAtom[].
 * Atoms with index >= n_surface_atoms are considered adsorbates.
 * Each adsorbate is anchored to its nearest surface atom.
 */
export function capture_adsorbate_atoms(
  structure: AnyStructure,
  n_surface_atoms: number,
): AnchoredAtom[] {
  if (!structure?.sites || n_surface_atoms >= structure.sites.length) return []

  const surface_sites = structure.sites.slice(0, n_surface_atoms)
  const adsorbate_sites = structure.sites.slice(n_surface_atoms)

  return adsorbate_sites.map((site) => {
    // Find nearest surface atom
    let min_dist_sq = Infinity
    let anchor_idx = 0
    for (let i = 0; i < surface_sites.length; i++) {
      const s = surface_sites[i]
      const dx = site.xyz[0] - s.xyz[0]
      const dy = site.xyz[1] - s.xyz[1]
      const dz = site.xyz[2] - s.xyz[2]
      const d2 = dx * dx + dy * dy + dz * dz
      if (d2 < min_dist_sq) {
        min_dist_sq = d2
        anchor_idx = i
      }
    }

    const anchor = surface_sites[anchor_idx]
    return {
      element: site.species[0].element as ElementSymbol,
      anchor_site_idx: anchor_idx,
      offset: [
        site.xyz[0] - anchor.xyz[0],
        site.xyz[1] - anchor.xyz[1],
        site.xyz[2] - anchor.xyz[2],
      ] as Vec3,
    }
  })
}

/**
 * Apply anchored adsorbate atoms to a target surface.
 * Returns a new structure with adsorbate atoms appended.
 */
export function apply_adsorbates_to_surface(
  surface: AnyStructure,
  adsorbate_atoms: AnchoredAtom[],
): AnyStructure {
  if (adsorbate_atoms.length === 0) return surface
  if (!surface?.sites) return surface

  // Precompute inverse lattice matrix for Cartesian → fractional conversion
  let inv_matrix: ReturnType<typeof matrix_inverse_3x3> | null = null
  if (`lattice` in surface && surface.lattice) {
    const lat = (surface as PymatgenStructure).lattice
    inv_matrix = matrix_inverse_3x3(transpose_3x3_matrix(lat.matrix))
  }

  const new_sites: Site[] = adsorbate_atoms.map((atom) => {
    const anchor = surface.sites[atom.anchor_site_idx]
    if (!anchor) {
      throw new Error(
        `Anchor site ${atom.anchor_site_idx} out of range (surface has ${surface.sites.length} sites)`,
      )
    }

    const xyz: Vec3 = [
      anchor.xyz[0] + atom.offset[0],
      anchor.xyz[1] + atom.offset[1],
      anchor.xyz[2] + atom.offset[2],
    ]

    const abc: Vec3 = inv_matrix ? mat3x3_vec3_multiply(inv_matrix, xyz) : xyz

    return {
      species: [{ element: atom.element, occu: 1, oxidation_state: 0 }],
      abc,
      xyz,
      label: atom.element,
      properties: {},
    }
  })

  return {
    ...surface,
    sites: [...surface.sites, ...new_sites],
  }
}

/**
 * Generate the full combinatorial trajectory:
 *   for each surface → for each pathway → for each step
 *
 * @param surfaces - n surface structures (must have same atom count)
 * @param pathways - m reaction pathways, each with k steps
 * @returns Single trajectory with PathwayFrameMetadata on each frame
 */
export function generate_pathway_trajectory(
  surfaces: AnyStructure[],
  pathways: ReactionPathway[],
): TrajectoryType {
  // Validate: all surfaces must have the same atom count
  if (surfaces.length > 1) {
    const n0 = surfaces[0].sites.length
    for (let i = 1; i < surfaces.length; i++) {
      if (surfaces[i].sites.length !== n0) {
        throw new Error(
          `Surface ${i} has ${surfaces[i].sites.length} atoms, but surface 0 has ${n0}. All surfaces must have the same topology.`,
        )
      }
    }
  }

  const frames: TrajectoryFrame[] = []
  let frame_idx = 0

  for (let si = 0; si < surfaces.length; si++) {
    for (const pathway of pathways) {
      for (let ki = 0; ki < pathway.steps.length; ki++) {
        const step = pathway.steps[ki]
        const raw_structure = apply_adsorbates_to_surface(surfaces[si], step.adsorbate_atoms)
        // Normalize to canonical xyz-parser shape — same fix DopingPane
        // applies. `apply_adsorbates_to_surface` returns a pymatgen-shaped
        // dict, which trips Svelte 5's effect flush under the VS Code
        // webview when stuffed straight into a TrajectoryFrame.
        const normalized = normalize_pymatgen_frame_structure(
          raw_structure as unknown as Record<string, unknown>,
        )
        const structure = (normalized ?? raw_structure) as AnyStructure

        const metadata: PathwayFrameMetadata = {
          surface_idx: si,
          pathway_id: pathway.id,
          pathway_name: pathway.name,
          step_idx: ki,
          step_name: step.name,
          label:
            surfaces.length > 1
              ? `Surface ${si + 1} / ${pathway.name} / ${step.name}`
              : `${pathway.name} / ${step.name}`,
        }

        frames.push({ structure, step: frame_idx, metadata: metadata as unknown as Record<string, unknown> })
        frame_idx++
      }
    }
  }

  const traj_meta: PathwayTrajectoryMetadata = {
    type: `reaction_pathway`,
    n_surfaces: surfaces.length,
    n_pathways: pathways.length,
    pathways: pathways.map((p) => ({
      id: p.id,
      name: p.name,
      n_steps: p.steps.length,
      step_names: p.steps.map((s) => s.name),
    })),
  }

  return {
    frames,
    metadata: traj_meta as unknown as Record<string, unknown>,
  }
}

/**
 * Compute the flat frame index from (surface, pathway, step) coordinates.
 */
export function pathway_frame_index(
  surface_idx: number,
  pathway_idx: number,
  step_idx: number,
  pathway_step_counts: number[],
): number {
  const steps_per_surface = pathway_step_counts.reduce((a, b) => a + b, 0)
  let offset = surface_idx * steps_per_surface
  for (let i = 0; i < pathway_idx; i++) offset += pathway_step_counts[i]
  return offset + step_idx
}

/**
 * Decompose a flat frame index into (surface, pathway, step) coordinates.
 */
export function decompose_frame_index(
  frame_idx: number,
  n_surfaces: number,
  pathway_step_counts: number[],
): { surface_idx: number; pathway_idx: number; step_idx: number } {
  const steps_per_surface = pathway_step_counts.reduce((a, b) => a + b, 0)
  const surface_idx = Math.floor(frame_idx / steps_per_surface)
  let remaining = frame_idx % steps_per_surface

  let pathway_idx = 0
  for (let i = 0; i < pathway_step_counts.length; i++) {
    if (remaining < pathway_step_counts[i]) {
      pathway_idx = i
      break
    }
    remaining -= pathway_step_counts[i]
  }

  return { surface_idx, pathway_idx, step_idx: remaining }
}

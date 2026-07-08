// Data extraction functions for trajectory analysis and plotting
import { get_density, type PymatgenStructure } from '$lib/structure'
import type { TrajectoryDataExtractor, TrajectoryFrame, TrajectoryType } from './index'

// Common data extractor that extracts energy and structural properties
export const energy_data_extractor: TrajectoryDataExtractor = (
  frame: TrajectoryFrame,
  _trajectory: TrajectoryType,
): Record<string, number> => {
  const data: Record<string, number> = {
    Step: frame.step,
  }

  if (frame.metadata) {
    // Extract energy-related properties
    const energy_fields = [
      `energy`,
      `energy_per_atom`,
      `potential_energy`,
      `kinetic_energy`,
      `total_energy`,
      `energy_hartree`,
    ]

    for (const field of energy_fields) {
      if (
        field in frame.metadata &&
        typeof frame.metadata[field] === `number`
      ) {
        data[field] = frame.metadata[field] as number
      }
    }
  }

  return data
}

// Data extractor for forces and stresses
export const force_stress_data_extractor: TrajectoryDataExtractor = (
  frame: TrajectoryFrame,
  _trajectory: TrajectoryType,
): Record<string, number> => {
  const data: Record<string, number> = {
    Step: frame.step,
  }

  if (frame.metadata) {
    // Calculate force properties from forces array if available (preferred)
    if (frame.metadata.forces && Array.isArray(frame.metadata.forces)) {
      const forces = frame.metadata.forces as number[][]
      if (forces.length > 0) {
        // Exclude fully-fixed atoms (move_mask=false) from the F_max / F_norm
        // convergence curve — a frozen atom's large constraint reaction is not a
        // relaxation force and must not mask the actual convergence of the free
        // atoms. Falls back to all atoms when no constraint info is present.
        const sites = frame.structure?.sites
        const all_mags = forces.map((force) => Math.hypot(...force))
        const free_mags = all_mags.filter(
          (_, i) => sites?.[i]?.properties?.move_mask !== false,
        )
        const mags = free_mags.length > 0 ? free_mags : all_mags
        data.force_max = Math.max(...mags)
        // Calculate RMS (root mean square) of force magnitudes
        data.force_norm = Math.sqrt(
          mags.reduce((sum, f) => sum + f ** 2, 0) / mags.length,
        )
      }
    } else {
      // Fallback to metadata values if forces array not available
      if (
        frame.metadata.force_max &&
        typeof frame.metadata.force_max === `number`
      ) {
        data.force_max = frame.metadata.force_max
      }
      // Prefer force_norm if available, fall back to force_rms
      if (
        frame.metadata.force_norm &&
        typeof frame.metadata.force_norm === `number`
      ) {
        data.force_norm = frame.metadata.force_norm
      } else if (
        frame.metadata.force_rms &&
        typeof frame.metadata.force_rms === `number`
      ) {
        data.force_norm = frame.metadata.force_rms // Use force_rms as fallback
      }
      // Also expose force_rms as separate property when both max and rms exist
      if (
        frame.metadata.force_rms &&
        typeof frame.metadata.force_rms === `number` &&
        frame.metadata.force_max
      ) {
        data.force_rms = frame.metadata.force_rms
      }
    }

    // Extract other stress and pressure properties (no duplicates expected)
    const other_stress_fields = [
      `stress_max`,
      `stress_frobenius`,
      `stress_trace`,
      `pressure`,
    ]
    for (const field of other_stress_fields) {
      if (
        field in frame.metadata &&
        typeof frame.metadata[field] === `number`
      ) {
        data[field] = frame.metadata[field] as number
      }
    }
  }

  return data
}

// Data extractor for structural properties
export const structural_data_extractor: TrajectoryDataExtractor = (
  frame: TrajectoryFrame,
  _trajectory: TrajectoryType,
): Record<string, number> => {
  const data: Record<string, number> = {
    Step: frame.step,
  }

  // Extract lattice properties (preferred source for volume)
  if (`lattice` in frame.structure) {
    const lattice = frame.structure.lattice
    data.volume = lattice.volume // Use consistent lowercase naming
    data.a = lattice.a
    data.b = lattice.b
    data.c = lattice.c
    data.alpha = lattice.alpha
    data.beta = lattice.beta
    data.gamma = lattice.gamma
  }

  if (frame.metadata) {
    // Extract other structural properties, avoiding volume duplicate
    const structural_fields = [`temperature`]

    for (const field of structural_fields) {
      if (
        field in frame.metadata &&
        typeof frame.metadata[field] === `number`
      ) data[field] = frame.metadata[field] as number
    }

    // Handle density separately - prefer metadata, but calculate if not available
    if (frame.metadata.density && typeof frame.metadata.density === `number`) {
      data.density = frame.metadata.density
    } else if (`lattice` in frame.structure) {
      try {
        data.density = get_density(frame.structure as PymatgenStructure)
      } catch (error) {
        console.warn(`Failed to calculate density for frame ${frame.step}:`, error)
      }
    }

    // Only use metadata volume if lattice volume is not available
    if (
      !data.volume &&
      frame.metadata.volume &&
      typeof frame.metadata.volume === `number`
    ) {
      data.volume = frame.metadata.volume
    }

    // Note: pressure is handled by force_stress_data_extractor to avoid duplication
  } else if (`lattice` in frame.structure) {
    // Calculate density even when no metadata is available
    try {
      data.density = get_density(frame.structure as PymatgenStructure)
    } catch (error) {
      console.warn(`Failed to calculate density for frame ${frame.step}:`, error)
    }
  }

  return data
}

// Helper function to check if a property varies across trajectory frames
// Combined data extractor that extracts all common properties.
//
// Note: previously this function also emitted `_constant_{param}` marker keys
// by calling a helper `property_varies(trajectory, param)` for each of 6
// lattice parameters — each of which iterated every trajectory frame. That's
// an O(6 × N²) proxy-accesses pattern triggered every time `trajectory` was
// reassigned (e.g. atom delete via `_chunked_cross_frame_edit`). For an
// 878-atom delete on a multi-frame trajectory this single hot spot accounted
// for ~1.5 s of the delete cascade in Safari profiling.
//
// The emitted `_constant_*` keys were never consumed: the downstream
// `extract_property_statistics` in `plotting.ts` explicitly skips keys
// starting with `_constant_` (see line ~80), and variance detection already
// happens downstream via `get_coefficient_of_variation` on the collected
// values. Removed the dead O(N²) pass entirely.
export const full_data_extractor: TrajectoryDataExtractor = (
  frame: TrajectoryFrame,
  trajectory: TrajectoryType,
): Record<string, number> => {
  return {
    ...energy_data_extractor(frame, trajectory),
    ...force_stress_data_extractor(frame, trajectory),
    ...structural_data_extractor(frame, trajectory),
  }
}

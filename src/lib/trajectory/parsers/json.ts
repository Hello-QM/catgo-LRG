// JSON-based trajectory parsers (Pymatgen, generic JSON arrays, etc.)
import type { AnyStructure, ElementSymbol, Pbc, Vec3 } from '$lib'
import type { Matrix3x3 } from '$lib/math'
import * as math from '$lib/math'
import type { TrajectoryFrame, TrajectoryType } from '../index'
import { create_structure, create_trajectory_frame } from './common'

/**
 * Rebuild a pymatgen `Structure.as_dict()` payload into the canonical site /
 * lattice shape produced by `create_structure` (the path extxyz / XDATCAR
 * etc. take through the parser pipeline). Pymatgen dicts carry `@class`,
 * `@module`, `charge`, `oxidation_state: null` and may omit `lattice.pbc`;
 * those extra keys + null fields become deep-proxy reactive slots that
 * trigger Svelte 5's `effect_update_depth_exceeded` inside Trajectory's
 * `position_cache` + `trajectory_bond_cache.wire` pipeline under the VS
 * Code extension webview. Routing each frame through `create_structure`
 * normalizes the shape so it matches well-behaved trajectory formats.
 *
 * Exported so producers that build TrajectoryType inline without going
 * through `parse_json_trajectory` (DopingPane, pathway-builder, etc.) can
 * normalize at the boundary instead of stuffing pymatgen dicts directly
 * into `frames[i].structure`.
 *
 * Returns `null` if the structure can't be normalized (missing sites,
 * unrecognized species shape); callers should fall back to the raw
 * structure in that case.
 */
export function normalize_pymatgen_frame_structure(
  s: Record<string, unknown> | AnyStructure | undefined,
): AnyStructure | null {
  if (!s || typeof s !== `object` || !(`sites` in s)) return null
  const sites = (s as { sites?: unknown[] }).sites
  if (!Array.isArray(sites) || sites.length === 0) return null
  const positions: Vec3[] = []
  const elements: ElementSymbol[] = []
  for (const site of sites as Record<string, unknown>[]) {
    const xyz = site.xyz as Vec3 | undefined
    if (!xyz || xyz.length < 3) return null
    positions.push([xyz[0], xyz[1], xyz[2]])
    const species = site.species as Array<{ element?: string }> | undefined
    const element = (species?.[0]?.element ?? (site.label as string | undefined)) as
      | ElementSymbol
      | undefined
    if (!element) return null
    elements.push(element)
  }
  const lattice = (s as { lattice?: { matrix?: number[][]; pbc?: Pbc } }).lattice
  const matrix = (lattice?.matrix as Matrix3x3 | undefined) ?? undefined
  const pbc = lattice?.pbc
  return create_structure(positions, elements, matrix, pbc) as AnyStructure
}

// Parse a JSON object into a trajectory (handles multiple JSON formats)
export function parse_json_trajectory(
  data: object,
  filename?: string,
): TrajectoryType {
  // Handle JSON array of frames
  if (Array.isArray(data)) {
    const frames = data.map((frame_data, idx) => {
      const frame_obj = frame_data as Record<string, unknown>
      const raw_structure = (frame_obj.structure ?? frame_obj) as Record<string, unknown>
      const normalized = normalize_pymatgen_frame_structure(raw_structure)
      return {
        structure: (normalized ?? raw_structure) as AnyStructure,
        step: (frame_obj.step as number) ?? idx,
        metadata: (frame_obj.metadata as Record<string, unknown>) || {},
      }
    })
    return { frames, metadata: { source_format: `array`, frame_count: frames.length } }
  }

  const obj = data as Record<string, unknown>

  // Pymatgen format
  if (obj[`@class`] === `Trajectory` && obj.species && obj.coords && obj.lattice) {
    return parse_pymatgen_trajectory(obj, filename)
  }

  // Object with frames
  if (obj.frames && Array.isArray(obj.frames)) {
    const frames = (obj.frames as TrajectoryFrame[]).map((f, idx) => {
      const normalized = normalize_pymatgen_frame_structure(
        f.structure as unknown as Record<string, unknown>,
      )
      return {
        ...f,
        step: f.step ?? idx,
        structure: (normalized ?? f.structure) as AnyStructure,
      }
    })
    return {
      frames,
      metadata: {
        ...obj.metadata as Record<string, unknown>,
        source_format: `object_with_frames`,
      },
    }
  }

  // Single structure
  if (obj.sites) {
    const normalized = normalize_pymatgen_frame_structure(obj)
    return {
      frames: [{ structure: (normalized ?? obj) as AnyStructure, step: 0, metadata: {} }],
      metadata: { source_format: `single_structure`, frame_count: 1 },
    }
  }

  throw new Error(`Unrecognized trajectory format`)
}

function parse_pymatgen_trajectory(
  obj: Record<string, unknown>,
  filename?: string,
): TrajectoryType {
  const species = obj.species as { element: ElementSymbol }[]
  const coords = obj.coords as number[][][]
  const matrix = obj.lattice as Matrix3x3
  const frame_properties = obj.frame_properties as Record<string, unknown>[] || []

  const frames = coords.map((frame_coords, idx) => {
    const positions = frame_coords.map((abc) =>
      math.mat3x3_vec3_multiply(math.transpose_3x3_matrix(matrix), abc as Vec3)
    )

    // Process frame properties to extract numpy arrays
    const raw_properties = frame_properties[idx] || {}
    const processed_properties: Record<string, unknown> = {}

    Object.entries(raw_properties).forEach(([key, value]) => {
      if (
        value && typeof value === `object` &&
        (value as Record<string, unknown>)[`@class`] === `array`
      ) {
        // Extract numpy array data
        const array_obj = value as Record<string, unknown>
        processed_properties[key] = array_obj.data

        // Calculate force statistics for forces
        if (key === `forces` && Array.isArray(array_obj.data)) {
          const forces = array_obj.data as number[][]
          const force_magnitudes = forces.map((force) => Math.hypot(...force))
          processed_properties.force_max = Math.max(...force_magnitudes)
          processed_properties.force_norm = Math.sqrt(
            force_magnitudes.reduce((sum, f) => sum + f ** 2, 0) /
              force_magnitudes.length,
          )
        }

        // Calculate stress statistics for stress tensor
        if (key === `stress` && Array.isArray(array_obj.data)) {
          const stress_tensor = array_obj.data
          if (!math.is_square_matrix(stress_tensor, 3)) {
            console.warn(`Invalid stress tensor structure in frame ${idx}`)
          } else {
            // Calculate stress components (diagonal elements represent normal stresses)
            const normal_stresses = [
              stress_tensor[0][0],
              stress_tensor[1][1],
              stress_tensor[2][2],
            ]
            processed_properties.stress_max = Math.max(...normal_stresses.map(Math.abs))
            // Calculate hydrostatic pressure (negative of mean normal stress)
            processed_properties.pressure =
              -(normal_stresses[0] + normal_stresses[1] + normal_stresses[2]) / 3
          }
        }
      } else {
        processed_properties[key] = value
      }
    })

    return create_trajectory_frame(
      positions,
      species.map((specie) => specie.element),
      matrix,
      [true, true, true],
      idx,
      processed_properties,
    )
  })

  return {
    frames,
    metadata: {
      filename,
      source_format: `pymatgen_trajectory`,
      frame_count: frames.length,
      species_list: [...new Set(species.map((specie) => specie.element))],
      periodic_boundary_conditions: [true, true, true],
    },
  }
}

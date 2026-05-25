// Supercell generation utilities for PymatgenStructure
import type { Matrix3x3, Vec3 } from '$lib/math'
import * as math from '$lib/math'
import type { PymatgenStructure, Site } from './index'

type SupercellType = PymatgenStructure & {
  supercell_scaling?: Vec3
}

// Parse supercell scaling input from various formats. Can be "2x2x2", [2,2,2], or a single number.
// Returns [x, y, z] scaling factors.
export function parse_supercell_scaling(scaling: string | number | Vec3): Vec3 {
  if (typeof scaling === `string`) {
    // Parse "2x2x2" format
    const parts = scaling.toLowerCase().split(/[x×,\s]+/).filter((p) => p.trim())
    if (parts.length === 1) {
      const val = parseInt(parts[0], 10)
      if (isNaN(val) || val <= 0) {
        throw new Error(`Invalid supercell scaling: ${scaling}`)
      }
      return [val, val, val] as Vec3
    } else if (parts.length === 3) {
      const values = parts.map((val) => parseInt(val, 10))
      if (values.some((val) => isNaN(val) || val <= 0)) {
        throw new Error(`Invalid supercell scaling: ${scaling}`)
      }
      return values as Vec3
    } else {
      throw new Error(
        `Invalid supercell format: ${scaling}. Use formats like "2x2x2" or "3x1x2"`,
      )
    }
  } else if (typeof scaling === `number`) {
    if (scaling <= 0 || !Number.isInteger(scaling)) {
      throw new Error(`Supercell scaling must be a positive integer, got: ${scaling}`)
    }
    return [scaling, scaling, scaling] as Vec3
  } else if (Array.isArray(scaling) && scaling.length === 3) {
    if (scaling.some((v) => !Number.isInteger(v) || v <= 0)) {
      throw new Error(
        `All supercell scaling factors must be positive integers: ${scaling}`,
      )
    }
    return scaling as Vec3
  } else throw new Error(`Invalid supercell scaling format: ${scaling}`)
}

// Generate all lattice points for a supercell. Takes [nx, ny, nz] scaling factors
// and returns array of fractional coordinates for lattice points
export function generate_lattice_points(scaling_factors: Vec3): Vec3[] {
  const [nx, ny, nz] = scaling_factors
  const points: Vec3[] = []

  // Generate in x, y, z order to match expected test results
  for (let kk = 0; kk < nz; kk++) {
    for (let jj = 0; jj < ny; jj++) {
      for (let ii = 0; ii < nx; ii++) points.push([ii, jj, kk] as Vec3)
    }
  }

  return points
}

// Scale a lattice matrix by supercell factors
// Takes original 3x3 lattice matrix and [nx, ny, nz] scaling factors
// Returns new scaled lattice matrix
export function scale_lattice_matrix(
  orig_matrix: Matrix3x3,
  scaling_factors: Vec3,
): Matrix3x3 {
  const [nx, ny, nz] = scaling_factors

  // Scale each lattice vector by its corresponding factor
  return [
    math.scale(orig_matrix[0], nx),
    math.scale(orig_matrix[1], ny),
    math.scale(orig_matrix[2], nz),
  ] as Matrix3x3
}

// Create a supercell from a PymatgenStructure
// Takes original structure, scaling factors, and whether to fold coordinates back to unit cell (default: true)
// Returns new supercell structure
export function make_supercell(
  structure: PymatgenStructure,
  scaling: string | number | Vec3,
  to_unit_cell: boolean = true,
): PymatgenStructure {
  if (!structure.lattice) {
    throw new Error(`Cannot create supercell: structure has no lattice`)
  }

  const scaling_factors = parse_supercell_scaling(scaling)
  const [nx, ny, nz] = scaling_factors
  const det = nx * ny * nz

  // Short circuit for 1x1x1 (no actual supercell needed)
  if (nx === 1 && ny === 1 && nz === 1) {
    return {
      ...structure,
      supercell_scaling: scaling_factors,
    } as SupercellType
  }

  // Create new scaled lattice
  const new_lattice_matrix = scale_lattice_matrix(
    structure.lattice.matrix,
    scaling_factors,
  )
  const lattice_params = math.calc_lattice_params(new_lattice_matrix)

  const new_lattice = {
    ...structure.lattice,
    matrix: new_lattice_matrix,
    ...lattice_params,
  }

  // Pre-compute matrices (constant for all sites)
  const orig_T = math.transpose_3x3_matrix(structure.lattice.matrix)
  const new_T = math.transpose_3x3_matrix(new_lattice_matrix)
  const new_T_inv = math.matrix_inverse_3x3(new_T)

  const new_sites: Site[] = []

  // Generate sites
  for (let kk = 0; kk < nz; kk++) {
    for (let jj = 0; jj < ny; jj++) {
      for (let ii = 0; ii < nx; ii++) {
        const translation = math.mat3x3_vec3_multiply(orig_T, [ii, jj, kk])
        const label_suffix = det > 1 ? `_${ii}${jj}${kk}` : ``

        for (const site of structure.sites) {
          // Translate to new position in Cartesian coordinates
          const cart_pos = math.add(site.xyz, translation)

          // Convert to fractional coordinates in new lattice
          let frac_pos = math.mat3x3_vec3_multiply(new_T_inv, cart_pos)

          // Wrap to unit cell if requested
          if (to_unit_cell) {
            frac_pos = frac_pos.map((coord) => {
              let wrapped = coord % 1
              if (wrapped < 0) wrapped += 1
              if (wrapped >= 0.9999999999) wrapped = 0
              return wrapped
            }) as Vec3
          }

          // Convert back to Cartesian in new lattice
          const final_pos = math.mat3x3_vec3_multiply(new_T, frac_pos)

          new_sites.push({
            species: site.species,
            xyz: final_pos,
            abc: frac_pos,
            label: label_suffix ? `${site.label}${label_suffix}` : site.label,
            properties: site.properties,
          })
        }
      }
    }
  }

  return {
    ...structure,
    lattice: new_lattice,
    sites: new_sites,
    charge: structure.charge ? structure.charge * det : structure.charge,
    supercell_scaling: scaling_factors,
  } as SupercellType
}

// Threshold (in number of cells = nx·ny·nz) beyond which a CPU-side supercell
// build (WASM `create_supercell` / TS `make_supercell`) is considered too large
// to expand without freezing the main thread. When the WebGPU large-system
// overlay is OFF and a requested factor exceeds this, the UI warns / guards
// instead of building. With the overlay ON the build is skipped entirely (GPU
// instances the base cell), so this threshold does NOT apply.
export const CPU_SUPERCELL_CELL_WARN_THRESHOLD = 64

// Hard ceiling on the EFFECTIVE GPU instance count (base atom count × number of
// cells) — a guard against pathological factors (e.g. a fat-fingered
// 1000×1000×1000), NOT a perf budget. The GPU supercell path is pure
// instancing: bonds are detected on the BASE cell only and GPU memory stays
// base-cell-sized, so only the draw instance count grows — which GPUs handle
// into the hundreds of millions (OVITO-class). 200M is comfortably above
// 100M-atom visualization while still catching absurd input. Frame rate may
// drop near the top (fill rate), but it degrades gracefully — it never freezes.
export const GPU_SUPERCELL_MAX_INSTANCES = 200_000_000

// Product of the [nx,ny,nz] factors parsed from a scaling input = number of
// cells. Returns 1 (no supercell) for malformed input so callers can treat a
// bad string as "no expansion" rather than throwing.
export function supercell_cell_count(scaling: string | number | Vec3): number {
  try {
    const [nx, ny, nz] = parse_supercell_scaling(scaling)
    return nx * ny * nz
  } catch {
    return 1
  }
}

// Validate supercell input string
// Takes user input string and returns true if valid, false otherwise
export function is_valid_supercell_input(input: string): boolean {
  try {
    parse_supercell_scaling(input)
    return true
  } catch {
    return false
  }
}

// Format supercell scaling factors for display
// Takes scaling factors and returns formatted string like "2×2×2"
export function format_supercell_scaling(scaling: Vec3): string {
  return scaling.join(`×`)
}

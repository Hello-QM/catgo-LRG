import type { AnyStructure, PymatgenStructure } from '$lib/structure'
import type { Vec3 } from '$lib/math'
import { mat3x3_vec3_multiply, matrix_inverse_3x3, transpose_3x3_matrix } from '$lib/math'

/**
 * Translate selected sites by a displacement vector in Cartesian coordinates.
 * Updates both xyz and abc coordinates for crystal structures.
 *
 * @param structure - The structure to modify
 * @param site_indices - Indices of sites to translate
 * @param displacement - [dx, dy, dz] displacement in Angstroms
 * @returns New structure with translated sites
 */
export function translate_sites(
  structure: AnyStructure,
  site_indices: number[],
  displacement: Vec3,
): AnyStructure {
  if (!structure?.sites || site_indices.length === 0) return structure

  // Create a Set for O(1) lookup
  const indices_set = new Set(site_indices)

  // Pre-calculate fractional displacement for crystal structures
  let abc_displacement = displacement
  if ('lattice' in structure && structure.lattice) {
    const lattice = structure.lattice as PymatgenStructure['lattice']
    const lattice_transposed = transpose_3x3_matrix(lattice.matrix)
    const inv_matrix = matrix_inverse_3x3(lattice_transposed)
    abc_displacement = mat3x3_vec3_multiply(inv_matrix, displacement)
  }

  const new_sites = structure.sites.map((site, idx) => {
    if (!indices_set.has(idx)) return site

    // Update Cartesian coordinates
    const new_xyz: Vec3 = [
      site.xyz[0] + displacement[0],
      site.xyz[1] + displacement[1],
      site.xyz[2] + displacement[2],
    ]

    // For crystal structures, also update fractional coordinates
    let new_abc = site.abc
    if ('lattice' in structure && structure.lattice) {
      new_abc = [
        site.abc[0] + abc_displacement[0],
        site.abc[1] + abc_displacement[1],
        site.abc[2] + abc_displacement[2],
      ] as Vec3
    }

    return {
      ...site,
      xyz: new_xyz,
      abc: new_abc,
    }
  })

  return {
    ...structure,
    sites: new_sites,
  }
}

/**
 * Get the step size for atom movement based on modifier keys.
 *
 * @param shift - Shift key pressed (10x multiplier)
 * @param ctrl - Ctrl/Cmd key pressed (0.1x multiplier)
 * @param base_step - Base step size in Angstroms (default 0.1)
 * @returns Step size in Angstroms
 */
export function get_movement_step(
  shift: boolean,
  ctrl: boolean,
  base_step = 0.1,
): number {
  if (shift) return base_step * 10 // 1.0 Angstrom
  if (ctrl) return base_step * 0.1 // 0.01 Angstrom
  return base_step // 0.1 Angstrom
}

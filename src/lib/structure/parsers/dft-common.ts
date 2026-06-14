// Shared helpers for DFT input/output structure parsers (QE, CASTEP, SIESTA, OUTCAR).
// All produce CatGo's ParsedStructure model with Cartesian Ångström coordinates.

import type { Site, Vec3 } from '$lib'
import type { Matrix3x3 } from '$lib/math'
import * as math from '$lib/math'
import type { ElementSymbol } from './common'

// 1 bohr = 0.529177210903 Å (1 Å = 1.8897259886 bohr)
export const BOHR_TO_ANG = 0.52917721090

/** Lattice rows are vectors; fractional → Cartesian uses the transposed matrix. */
export function frac_to_cart(abc: Vec3, matrix: Matrix3x3): Vec3 {
  return math.mat3x3_vec3_multiply(math.transpose_3x3_matrix(matrix), abc)
}

/** Cartesian → fractional via the inverse of the transposed lattice matrix. */
export function cart_to_frac(xyz: Vec3, matrix: Matrix3x3): Vec3 {
  const inv = math.matrix_inverse_3x3(math.transpose_3x3_matrix(matrix))
  return math.mat3x3_vec3_multiply(inv, xyz)
}

export function make_site(
  element: ElementSymbol,
  xyz: Vec3,
  abc: Vec3,
  label: string,
  properties: Record<string, unknown> = {},
): Site {
  return { species: [{ element, occu: 1 }], abc, xyz, label, properties }
}

/** Build the ParsedStructure.lattice object (matrix + a/b/c/angles/volume). */
export function periodic_lattice(matrix: Matrix3x3) {
  return { matrix, ...math.calc_lattice_params(matrix) }
}

/** Strip a trailing comment (`!` or `#`) and surrounding whitespace from a line. */
export function strip_comment(line: string): string {
  const cut = line.search(/[!#]/)
  return (cut >= 0 ? line.slice(0, cut) : line).trim()
}

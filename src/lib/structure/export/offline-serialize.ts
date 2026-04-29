/**
 * Offline structure serialization — pure frontend POSCAR/XYZ export.
 *
 * These functions produce VASP POSCAR and XYZ format strings from a
 * pymatgen-compatible structure dict without any backend dependency.
 */

export interface Site {
  species: { element: string; oxidation_state?: number }[];
  xyz: [number, number, number];
  abc?: [number, number, number];
  properties?: Record<string, unknown>;
}

export interface StructureData {
  lattice?: { matrix: number[][] };
  sites: Site[];
  charge?: number;
}

/**
 * Invert a 3x3 matrix. Throws if the matrix is singular.
 */
export function mat3_inverse(m: number[][]): number[][] {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-15) throw new Error('Singular lattice matrix');
  const inv_det = 1 / det;
  return [
    [(e * i - f * h) * inv_det, (c * h - b * i) * inv_det, (b * f - c * e) * inv_det],
    [(f * g - d * i) * inv_det, (a * i - c * g) * inv_det, (c * d - a * f) * inv_det],
    [(d * h - e * g) * inv_det, (b * g - a * h) * inv_det, (a * e - b * d) * inv_det],
  ];
}

/**
 * Convert Cartesian coordinates to fractional using the inverse lattice matrix.
 *
 * The inverse matrix rows correspond to the reciprocal lattice vectors,
 * so frac_i = sum_j(cart_j * inv[j][i]).
 */
export function cart_to_frac(
  xyz: [number, number, number],
  inv: number[][],
): [number, number, number] {
  return [
    xyz[0] * inv[0][0] + xyz[1] * inv[1][0] + xyz[2] * inv[2][0],
    xyz[0] * inv[0][1] + xyz[1] * inv[1][1] + xyz[2] * inv[2][1],
    xyz[0] * inv[0][2] + xyz[1] * inv[1][2] + xyz[2] * inv[2][2],
  ];
}

/**
 * Serialize a structure to VASP POSCAR format (pure frontend, no backend needed).
 *
 * POSCAR format:
 *   Line 1: Comment
 *   Line 2: Scale factor
 *   Lines 3-5: Lattice vectors
 *   Line 6: Element symbols
 *   Line 7: Element counts
 *   Line 8: "Direct" or "Cartesian"
 *   Lines 9+: Fractional coordinates
 */
export function structure_to_poscar(
  structure: StructureData,
  comment = 'CatGo export',
): string {
  if (!structure.lattice?.matrix) {
    throw new Error('POSCAR requires a lattice (periodic structure)');
  }

  const lines: string[] = [comment, '1.0'];

  // Lattice vectors
  for (const row of structure.lattice.matrix) {
    lines.push(`  ${row.map((v) => v.toFixed(10).padStart(16)).join('')}`);
  }

  // Count elements (preserving order of first appearance)
  const element_order: string[] = [];
  const element_counts: Record<string, number> = {};
  for (const site of structure.sites) {
    const el = site.species[0]?.element || 'X';
    if (!(el in element_counts)) {
      element_order.push(el);
      element_counts[el] = 0;
    }
    element_counts[el]++;
  }

  lines.push(element_order.join('  '));
  lines.push(element_order.map((el) => element_counts[el]).join('  '));
  lines.push('Direct');

  // Group sites by element, output fractional coords
  const inv = mat3_inverse(structure.lattice.matrix);
  for (const el of element_order) {
    for (const site of structure.sites) {
      if ((site.species[0]?.element || 'X') !== el) continue;
      const frac = site.abc || cart_to_frac(site.xyz, inv);
      lines.push(`  ${frac.map((v) => v.toFixed(10).padStart(16)).join('')}`);
    }
  }

  return lines.join('\n') + '\n';
}

/**
 * Serialize a structure to XYZ format (pure frontend, no backend needed).
 *
 * XYZ format:
 *   Line 1: Atom count
 *   Line 2: Comment
 *   Lines 3+: Element  x  y  z
 */
export function structure_to_xyz(
  structure: StructureData,
  comment = 'CatGo export',
): string {
  const lines: string[] = [String(structure.sites.length), comment];
  for (const site of structure.sites) {
    const el = site.species[0]?.element || 'X';
    const [x, y, z] = site.xyz;
    lines.push(
      `${el.padEnd(4)} ${x.toFixed(8).padStart(14)} ${y.toFixed(8).padStart(14)} ${z.toFixed(8).padStart(14)}`,
    );
  }
  return lines.join('\n') + '\n';
}

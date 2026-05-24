import type { Site, PymatgenLattice } from '$lib/structure'

/** Pack atom positions into a flat Float32Array(3N), row = (x,y,z).
 *  A raw trajectory frame (already a 3N Float32Array) is returned as-is. */
export function pack_positions(input: readonly Site[] | Float32Array): Float32Array {
  if (input instanceof Float32Array) return input
  const out = new Float32Array(input.length * 3)
  for (let i = 0; i < input.length; i++) {
    const [x, y, z] = input[i].xyz
    out[i * 3] = x
    out[i * 3 + 1] = y
    out[i * 3 + 2] = z
  }
  return out
}

/** Flatten a 3x3 lattice matrix (rows = lattice vectors a,b,c) row-major into
 *  Float32Array(9). Non-periodic structures (no lattice) -> all zeros, which the
 *  compute shader treats as "no PBC". */
export function pack_lattice(lattice: PymatgenLattice | undefined): Float32Array {
  const out = new Float32Array(9)
  const m = lattice?.matrix
  if (!m) return out
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out[r * 3 + c] = m[r][c]
  return out
}

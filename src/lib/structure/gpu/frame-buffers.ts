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

/** Overlay transient edit positions without mutating the authoritative frame.
 *
 * The interaction controller replaces its Map once per animation frame while
 * translating or rotating selected atoms. Preserve the trajectory zero-copy
 * path when that map is empty; only clone the 3N frame while a preview is live.
 */
export function apply_position_overrides(
  positions: Float32Array,
  overrides:
    | ReadonlyMap<number, readonly [number, number, number]>
    | null
    | undefined,
): Float32Array {
  if (!overrides || overrides.size === 0) return positions
  const out = positions.slice()
  const atom_count = Math.floor(out.length / 3)
  for (const [site_idx, xyz] of overrides) {
    if (!Number.isInteger(site_idx) || site_idx < 0 || site_idx >= atom_count) continue
    const offset = site_idx * 3
    out[offset] = xyz[0]
    out[offset + 1] = xyz[1]
    out[offset + 2] = xyz[2]
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

/**
 * Pure trajectory-edit primitives. No Svelte, no side effects — unit-testable.
 *
 * `apply_displacements` is the single position-edit operation both the
 * edit-current and edit-all scopes use (issue #51 "single write path").
 * `write_sites_to_cache_slice` mirrors a frame's sites into its `position_cache`
 * Float32Array so the renderer + bond pipeline see the edit synchronously.
 */

export type Vec3 = [number, number, number]
export type Mat3Flat = [number, number, number, number, number, number, number, number, number]

interface EditSite {
  xyz: Vec3
  abc: Vec3
  // other fields preserved via spread
  [k: string]: unknown
}

function mat3_vec3(m: Mat3Flat, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ]
}

/**
 * Return a new sites array with `displacements` (atom index → cartesian Δ)
 * applied to xyz and abc. Untouched sites are kept by reference. Input is
 * never mutated. `inv_lattice` (inverse of the transposed lattice matrix,
 * row-major flat 9) converts the cartesian Δ to a fractional Δ; pass `null`
 * for non-periodic / when abc should track the cartesian Δ directly.
 */
export function apply_displacements<T extends EditSite>(
  sites: readonly T[],
  displacements: ReadonlyMap<number, Vec3>,
  inv_lattice: Mat3Flat | null,
): T[] {
  if (displacements.size === 0) return sites.slice()
  return sites.map((s, i) => {
    const d = displacements.get(i)
    if (!d) return s
    const fd = inv_lattice ? mat3_vec3(inv_lattice, d) : d
    // Delta-add (abc + inv·Δ) is intentional, NOT a full recompute like
    // `apply_per_atom_displacements` (new_abc = inv·new_xyz): it preserves the
    // user's wrapped/unwrapped fractional coords and avoids re-wrap surprises
    // during trajectory edits — do not "align" this to the full-recompute form.
    return {
      ...s,
      xyz: [s.xyz[0] + d[0], s.xyz[1] + d[1], s.xyz[2] + d[2]] as Vec3,
      abc: [s.abc[0] + fd[0], s.abc[1] + fd[1], s.abc[2] + fd[2]] as Vec3,
    }
  })
}

/** Build a fresh xyz-flat (3·n) Float32Array from sites. Renderer/bond
 *  fallback for when the `position_cache` is transiently null — e.g. an
 *  edit-all enqueues a pending op (which nulls the cache) in the same flush
 *  the bond pipeline reads positions. Reads the already-committed frame
 *  sites so the getter never returns null mid-edit. */
export function sites_to_float32(sites: readonly { xyz: Vec3 }[]): Float32Array {
  const out = new Float32Array(sites.length * 3)
  for (let i = 0; i < sites.length; i++) {
    const xyz = sites[i].xyz
    out[i * 3] = xyz[0]
    out[i * 3 + 1] = xyz[1]
    out[i * 3 + 2] = xyz[2]
  }
  return out
}

/** Mirror sites' xyz into a position-cache Float32Array slice, in place. */
export function write_sites_to_cache_slice(
  slice: Float32Array,
  sites: readonly { xyz: Vec3 }[],
): void {
  const n = Math.min(sites.length, Math.floor(slice.length / 3))
  for (let i = 0; i < n; i++) {
    const xyz = sites[i].xyz
    slice[i * 3] = xyz[0]
    slice[i * 3 + 1] = xyz[1]
    slice[i * 3 + 2] = xyz[2]
  }
}

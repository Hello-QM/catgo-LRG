export type Bond = { i: number; j: number; order: number }

export type BondOverride =
  | { op: `add`; i: number; j: number; order: number }
  | { op: `remove`; i: number; j: number }
  | { op: `setorder`; i: number; j: number; order: number }

/** Normalised undirected key for an (i,j) pair. */
function key(i: number, j: number): string {
  return i < j ? `${i}-${j}` : `${j}-${i}`
}

/**
 * Apply the render-only override layer onto the mirrored connectivity.
 * Pure — never mutates inputs. Order of ops: removes/setorders match by
 * undirected pair; adds append (deduped).
 */
export function merge_bonds(base: Bond[], overrides: BondOverride[]): Bond[] {
  const map = new Map<string, Bond>()
  for (const b of base) map.set(key(b.i, b.j), { ...b })

  for (const ov of overrides) {
    const k = key(ov.i, ov.j)
    if (ov.op === `remove`) {
      map.delete(k)
    } else if (ov.op === `setorder`) {
      const cur = map.get(k)
      if (cur) cur.order = ov.order
    } else {
      // add (idempotent on the undirected pair)
      map.set(k, { i: ov.i, j: ov.j, order: ov.order })
    }
  }
  return [...map.values()]
}

/** Drop overrides that reference an atom index ≥ n_atoms (deleted upstream). */
export function prune_overrides(
  overrides: BondOverride[],
  n_atoms: number,
): BondOverride[] {
  return overrides.filter((o) => o.i < n_atoms && o.j < n_atoms)
}

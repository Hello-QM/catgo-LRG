// Render-layer atom override util — pure, no Svelte. Mirrors bond-merge.ts.
//
// The catrender WASM core consumes `atom_overrides:[{op,idx,hex?}]` directly
// (RT9 svg.rs / RT10 types.rs `AtomOverride`). This module's job is therefore
// NORMALISATION, not transformation: dedupe per-idx (last op wins), drop
// out-of-range indices (atom deleted upstream — mirror `prune_overrides`),
// and surface a {hidden,recolor} view the pane uses for hit-test masking and
// for building the array it hands to the wasm input. A hidden atom's incident
// bonds are dropped by the core; the recolor entry is normalised even when the
// same idx is also hidden (moot then, but kept so toggling hide back off
// restores the colour).

export type AtomOverride =
  | { op: `hide`; idx: number }
  | { op: `recolor`; idx: number; hex: string }

/**
 * Normalise the render-only atom override layer.
 * Pure — never mutates inputs. `idx >= n_atoms` is pruned (deleted upstream).
 * Returns the deduped view: `hidden` (set of indices to drop) and `recolor`
 * (idx → hex, last write wins).
 */
export function merge_atoms(
  n_atoms: number,
  overrides: AtomOverride[],
): { hidden: Set<number>; recolor: Map<number, string> } {
  const hidden = new Set<number>()
  const recolor = new Map<number, string>()
  for (const ov of overrides) {
    if (ov.idx < 0 || ov.idx >= n_atoms) continue
    if (ov.op === `hide`) {
      hidden.add(ov.idx)
    } else {
      // recolor — last op per idx wins
      recolor.set(ov.idx, ov.hex)
    }
  }
  return { hidden, recolor }
}

/** Drop overrides referencing an atom index ≥ n_atoms (deleted upstream). */
export function prune_atom_overrides(
  overrides: AtomOverride[],
  n_atoms: number,
): AtomOverride[] {
  return overrides.filter((o) => o.idx >= 0 && o.idx < n_atoms)
}

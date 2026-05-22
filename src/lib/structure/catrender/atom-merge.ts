// Render-layer atom override util — pure, no Svelte. Mirrors bond-merge.ts.
//
// The catrender WASM core consumes `atom_overrides:[{op,idx,hex?}]` directly
// (RT9 svg.rs / RT10 types.rs `AtomOverride`). The wasm payload is therefore
// the RAW pruned override array (see `prune_atom_overrides`) — the Rust core
// dedups per-idx and applies hide/recolor internally; this module does NOT
// build the wasm input.
//
// `merge_atoms` is the front-end-only normalisation used purely for click
// HIT-TEST masking: it dedupes per-idx (last op wins) and drops out-of-range
// indices, surfacing a `{hidden, recolor}` view. The pane uses `hidden` to map
// a clicked <circle> back to its ORIGINAL atom index — svg.rs emits one circle
// per visible atom in original order, so the picker must skip hidden indices
// to avoid selecting the wrong atom. `recolor` is normalised even when the
// same idx is also hidden (moot then, but kept so toggling hide back off
// restores the colour).

export type AtomOverride =
  | { op: `hide`; idx: number }
  | { op: `recolor`; idx: number; hex: string }
  | { op: `glow`; idx: number; hex: string }

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

/** Per-element-pair bond-distance-rule encoding for the GPU bond compute.
 *
 *  The WebGL/CPU path (src/lib/structure/scene/visibility.ts) applies
 *  `bond_distance_rules` as a POST-FILTER on already-detected bonds: for a
 *  detected bond with length d and element pair (eA,eB), it looks up the rule
 *  keyed by the SORTED pair `[eA,eB].sort().join('-')`; if a rule exists it
 *  keeps the bond only when `min ≤ d ≤ max`, and if no rule exists it keeps the
 *  bond (the strategy decides). Rules can only REMOVE strategy-detected bonds,
 *  never add. This module produces the GPU-side data to reproduce that exactly:
 *
 *   1. A per-atom element-id `Uint32Array` (one small int id per site's primary
 *      element symbol).
 *   2. A packed rules `Float32Array` of `[id_a, id_b, min, max]` per rule, with
 *      `id_a ≤ id_b` (sorted so the pair key is order-independent, matching the
 *      CPU `[e1,e2].sort()`), where ids are bit-cast to f32 in the shader.
 *
 *  The id mapping is SHARED between the per-atom array and the rules: a symbol
 *  resolves to the same id in both. Symbols that appear only in a rule but not
 *  in the structure still get an id, but since no atom carries that id the rule
 *  simply never matches (harmless). Symbols in the structure but not in any rule
 *  get an id that no rule references ⇒ no rule matches ⇒ bond kept (matching the
 *  CPU "no rule for that pair ⇒ keep"). */

import type { Site } from '$lib/structure'

export type BondDistanceRuleLike = {
  element_1: string
  element_2: string
  min_dist: number
  max_dist: number
}

export type EncodedBondRules = {
  /** Per-atom element id, one entry per site (primary species symbol). */
  elem_ids: Uint32Array
  /** Packed rules: 4 floats per rule [id_a, id_b, min, max], id_a ≤ id_b.
   *  id_a/id_b are integer ids stored as f32 (exact for the small id range). */
  rules: Float32Array
  /** Number of rules encoded (rules.length / 4). */
  rule_count: number
}

/** Build the per-atom element-id array + packed rules buffer for the GPU bond
 *  post-filter. Pure (no GPU). `rules` empty ⇒ rule_count 0 and an empty rules
 *  buffer, so the shader applies no filtering (behaviour identical to no rules).
 *
 *  The id mapping assigns a stable small int to each distinct symbol seen across
 *  BOTH the structure sites and the rule elements, so the two encodings agree. */
export function encode_bond_rules(
  sites: readonly Site[],
  rules: readonly BondDistanceRuleLike[],
): EncodedBondRules {
  const id_of = new Map<string, number>()
  const intern = (sym: string): number => {
    let id = id_of.get(sym)
    if (id === undefined) {
      id = id_of.size
      id_of.set(sym, id)
    }
    return id
  }

  // Per-atom ids first (so the most common symbols get the low ids; the exact
  // values don't matter, only that atom ids and rule ids share the same map).
  const elem_ids = new Uint32Array(sites.length)
  for (let i = 0; i < sites.length; i++) {
    const elem = sites[i].species[0]?.element
    elem_ids[i] = elem != null ? intern(elem) : intern(`__none__`)
  }

  const out_rules = new Float32Array(rules.length * 4)
  for (let r = 0; r < rules.length; r++) {
    const a = intern(rules[r].element_1)
    const b = intern(rules[r].element_2)
    const lo = Math.min(a, b)
    const hi = Math.max(a, b)
    out_rules[r * 4 + 0] = lo
    out_rules[r * 4 + 1] = hi
    out_rules[r * 4 + 2] = rules[r].min_dist
    out_rules[r * 4 + 3] = rules[r].max_dist
  }

  return { elem_ids, rules: out_rules, rule_count: rules.length }
}

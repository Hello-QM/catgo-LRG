// Adsorbate molecular-fragment isolation for bond-order perception.
//
// CatGo structures are typically a METAL SLAB (periodic) + a small ORGANIC
// ADSORBATE (CO, OH, COOH, formate, CH3, benzene, ...). We want bond orders
// perceived ONLY on the organic adsorbate; the slab stays single sticks.
//
// This module walks the SAME live bond-pair graph the viewer draws (the
// `filtered_bond_pairs` consumed by the shadow-sync effect) — it does NOT
// re-detect bonds — so the fragments match exactly what is rendered. Each
// fragment is a connected component of ORGANIC-ORGANIC edges only:
// metal-adsorbate binding bonds (C-Pt, O-Pt, H-Pt) are deliberately cut so
// the binding bond never pulls slab atoms into the fragment, and the binding
// atom keeps its dangling valence (which the propagator reads to drive the
// correct C≡O / C=O on the free end).
//
// Pure, headless, no wasm, no network.

import type { Matrix3x3 } from '$lib/math'
import { element_data } from '$lib/element'
import type { BondPair, Site } from '$lib/structure'

// Adsorbate-chemistry element set (mirrors heuristics.py VALENCE_TABLE
// coverage). B and Si are intentionally ORGANIC here (boranes / silanes are
// valid adsorbates); B-metal / Si-metal contacts are cut on the metal side.
export const ORGANIC_SET: ReadonlySet<string> = new Set([
  `H`,
  `B`,
  `C`,
  `N`,
  `O`,
  `F`,
  `Si`,
  `P`,
  `S`,
  `Se`,
  `Cl`,
  `Br`,
  `I`,
])

// A component bigger than this is treated as an extended framework
// (graphene / h-BN / COF sheet), not a small adsorbate.
export const MAX_FRAGMENT_ATOMS = 64

export type FragmentEdge = {
  a_local: number
  b_local: number
  a_global: number
  b_global: number
  jimage: [number, number, number]
}

export type Fragment = {
  // Global site indices that make up this fragment.
  site_indices: number[]
  // Intra-fragment organic-organic bonds, in a compact [0..n) local index space.
  local_bonds: FragmentEdge[]
  // global site index -> local index within this fragment
  global_to_local: Map<number, number>
}

const metal_lookup = new Map(
  element_data.map((el) => [el.symbol as string, el.metal === true]),
)

function element_of(site: Site | undefined): string | undefined {
  if (!site) return undefined
  // majority species (handles fractional occupancy / disordered sites)
  const species = site.species ?? []
  if (species.length === 0) return undefined
  let best = species[0]
  for (const s of species) if (s.occu > best.occu) best = s
  return best.element
}

// An atom is ORGANIC iff its element is in ORGANIC_SET. Everything else
// (true metals by element_data.metal===true, or unknown) is FRAMEWORK.
function is_organic_element(el: string | undefined): boolean {
  if (el === undefined) return false
  return ORGANIC_SET.has(el)
}

// True metal (slab) test — robust framework classifier for the metal-side cut.
// Keyed on element_data.metal===true so metalloids (B, Si) handled as organic
// are not misclassified as framework.
export function is_framework_metal(el: string | undefined): boolean {
  if (el === undefined) return false
  if (ORGANIC_SET.has(el)) return false
  return metal_lookup.get(el) === true
}

function jimage_is_zero(j: [number, number, number]): boolean {
  return j[0] === 0 && j[1] === 0 && j[2] === 0
}

/**
 * Isolate adsorbate molecular fragments from the live bond-pair graph.
 *
 * @param filtered_bond_pairs the same intra-cell + cross-cell BondPair[] the
 *   viewer's shadow-sync consumes (carries site_idx_1/2 + jimage).
 * @param sites              structure.sites (for element classification).
 * @param lattice            3x3 lattice matrix (rows = a,b,c) or null for a
 *   gas-phase molecule. Only used to recognise periodic-spanning sheets.
 * @returns one Fragment per organic connected component that survives the
 *   exclude-as-slab filter. Metal atoms and metal-adsorbate bonds are never
 *   in any fragment.
 */
export function isolate_adsorbate_fragments(
  filtered_bond_pairs: BondPair[],
  sites: Site[],
  _lattice: Matrix3x3 | null,
): Fragment[] {
  if (!Array.isArray(filtered_bond_pairs) || filtered_bond_pairs.length === 0) {
    return []
  }
  const n = sites.length

  // 1. organic mask over all sites
  const organic = new Array<boolean>(n)
  for (let i = 0; i < n; i++) organic[i] = is_organic_element(element_of(sites[i]))

  // 2. organic-organic-only adjacency (cuts metal-adsorbate bonds). Keep the
  //    full edge (with jimage) so cross-cell organic bonds stay in-component.
  const adj = new Map<number, FragmentEdge[]>()
  const edges: FragmentEdge[] = []
  for (const bp of filtered_bond_pairs) {
    const a = bp.site_idx_1
    const b = bp.site_idx_2
    if (a < 0 || b < 0 || a >= n || b >= n) continue // out-of-range guard
    if (!organic[a] || !organic[b]) continue // an edge is kept iff BOTH ends organic
    const jimage = (bp.jimage ?? [0, 0, 0]) as [number, number, number]
    const edge: FragmentEdge = {
      a_local: -1,
      b_local: -1,
      a_global: a,
      b_global: b,
      jimage,
    }
    edges.push(edge)
    if (!adj.has(a)) adj.set(a, [])
    if (!adj.has(b)) adj.set(b, [])
    adj.get(a)!.push(edge)
    adj.get(b)!.push(edge)
  }
  if (edges.length === 0) return []

  // 3. connected components over the organic-only adjacency (DFS)
  const comp_of = new Map<number, number>()
  let n_comp = 0
  for (const start of adj.keys()) {
    if (comp_of.has(start)) continue
    const cid = n_comp++
    const stack = [start]
    comp_of.set(start, cid)
    while (stack.length) {
      const u = stack.pop()!
      for (const e of adj.get(u) ?? []) {
        const v = e.a_global === u ? e.b_global : e.a_global
        if (!comp_of.has(v)) {
          comp_of.set(v, cid)
          stack.push(v)
        }
      }
    }
  }

  // group atoms + edges per component
  const comp_atoms: number[][] = Array.from({ length: n_comp }, () => [])
  const comp_edges: FragmentEdge[][] = Array.from({ length: n_comp }, () => [])
  const comp_periodic = new Array<boolean>(n_comp).fill(false)
  for (const [atom, cid] of comp_of) comp_atoms[cid].push(atom)
  for (const e of edges) {
    const cid = comp_of.get(e.a_global)!
    comp_edges[cid].push(e)
    if (!jimage_is_zero(e.jimage)) comp_periodic[cid] = true
  }

  // 4. exclude-as-slab filter + 5. remap to local index space
  const fragments: Fragment[] = []
  for (let cid = 0; cid < n_comp; cid++) {
    const atoms = comp_atoms[cid]
    const size = atoms.length
    // (b) size > MAX regardless → extended framework, drop.
    if (size > MAX_FRAGMENT_ATOMS) continue
    // (a) periodic-spanning AND large → infinite sheet, drop.
    if (comp_periodic[cid] && size > MAX_FRAGMENT_ATOMS) continue
    // small finite molecules + small clusters pass.

    atoms.sort((p, q) => p - q) // deterministic local order
    const global_to_local = new Map<number, number>()
    atoms.forEach((g, i) => global_to_local.set(g, i))

    const local_bonds: FragmentEdge[] = comp_edges[cid].map((e) => ({
      a_local: global_to_local.get(e.a_global)!,
      b_local: global_to_local.get(e.b_global)!,
      a_global: e.a_global,
      b_global: e.b_global,
      jimage: e.jimage,
    }))

    fragments.push({ site_indices: atoms, local_bonds, global_to_local })
  }

  return fragments
}

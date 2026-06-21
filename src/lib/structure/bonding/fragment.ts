// Organic connected-component isolation for whole-structure bond-order
// perception.
//
// CatGo structures range from a METAL SLAB + a small ORGANIC ADSORBATE
// (CO, OH, COOH, formate, CH3, benzene, ...) to extended CARBON-BASED
// FRAMEWORKS (graphene, C3N4, h-BN, COF). We perceive bond orders EVERYWHERE
// there is organic conjugation — including periodic sheets that bond to their
// own PBC image — and never invent orders on metals. The organic-vs-metal
// distinction lives entirely in PERCEPTION (metals can't be aromatic; the
// valence heuristic only assigns multiple orders to organic SP2 / carbonyl /
// etc.), so a Pt slab still gets only single sticks.
//
// This module walks the SAME live bond-pair graph the viewer draws (the
// `filtered_bond_pairs` consumed by the shadow-sync effect) — it does NOT
// re-detect bonds — so the components match exactly what is rendered. Each
// component is a connected cluster of ORGANIC-ORGANIC edges only:
// metal-adsorbate binding bonds (C-Pt, O-Pt, H-Pt) are deliberately cut so
// the binding bond never pulls slab atoms into the component, and the binding
// atom keeps its dangling valence (which the propagator reads to drive the
// correct C≡O / C=O on the free end). Cross-cell organic edges (jimage != 0)
// are KEPT, so a periodic sheet is one component closing through its own
// image rather than being split at the cell boundary.
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

export type OrganicEdge = {
  a_local: number
  b_local: number
  a_global: number
  b_global: number
  jimage: [number, number, number]
}

export type OrganicComponent = {
  // Global site indices that make up this organic component.
  site_indices: number[]
  // Intra-component organic-organic bonds, in a compact [0..n) local index space.
  local_bonds: OrganicEdge[]
  // global site index -> local index within this component
  global_to_local: Map<number, number>
}

// Backward-compatible aliases. The perception layer + tests import these
// names; the concept is now a neutral "organic component" (an extended
// framework is just a large, periodic-spanning one) rather than an
// "adsorbate fragment", but renaming the exported types would churn callers.
export type FragmentEdge = OrganicEdge
export type Fragment = OrganicComponent

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

/**
 * Isolate organic connected components from the live bond-pair graph.
 *
 * EVERY organic connected component is returned — including extended,
 * periodic-spanning frameworks (graphene / C3N4 / h-BN / COF). There is NO
 * exclude-as-slab size/periodicity filter: a graphene sheet that bonds to its
 * own PBC image is a single component and is perceived in full. Metal atoms
 * and metal-adsorbate bonds are never in any component (the organic-vs-metal
 * line lives here; metals never receive multiple orders).
 *
 * @param filtered_bond_pairs the same intra-cell + cross-cell BondPair[] the
 *   viewer's shadow-sync consumes (carries site_idx_1/2 + jimage).
 * @param sites              structure.sites (for element classification).
 * @param _lattice           3x3 lattice matrix (rows = a,b,c) or null for a
 *   gas-phase molecule. Unused here (cross-cell edges carry their own jimage);
 *   the perception layer uses it for MIC geometry.
 * @returns one OrganicComponent per organic connected component.
 */
export function isolate_adsorbate_fragments(
  filtered_bond_pairs: BondPair[],
  sites: Site[],
  _lattice: Matrix3x3 | null,
): OrganicComponent[] {
  if (!Array.isArray(filtered_bond_pairs) || filtered_bond_pairs.length === 0) {
    return []
  }
  const n = sites.length

  // 1. organic mask over all sites
  const organic = new Array<boolean>(n)
  for (let i = 0; i < n; i++) organic[i] = is_organic_element(element_of(sites[i]))

  // 2. organic-organic-only adjacency (cuts metal-adsorbate bonds). Keep the
  //    full edge (with jimage) so cross-cell organic bonds stay in-component.
  const adj = new Map<number, OrganicEdge[]>()
  const edges: OrganicEdge[] = []
  for (const bp of filtered_bond_pairs) {
    const a = bp.site_idx_1
    const b = bp.site_idx_2
    if (a < 0 || b < 0 || a >= n || b >= n) continue // out-of-range guard
    if (!organic[a] || !organic[b]) continue // an edge is kept iff BOTH ends organic
    const jimage = (bp.jimage ?? [0, 0, 0]) as [number, number, number]
    const edge: OrganicEdge = {
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
  const comp_edges: OrganicEdge[][] = Array.from({ length: n_comp }, () => [])
  for (const [atom, cid] of comp_of) comp_atoms[cid].push(atom)
  for (const e of edges) {
    const cid = comp_of.get(e.a_global)!
    comp_edges[cid].push(e)
  }

  // 4. remap each component to a local [0..n) index space. NO exclude-as-slab
  //    filter: every organic component (small adsorbate, large framework,
  //    periodic-spanning sheet alike) is perceived.
  const components: OrganicComponent[] = []
  for (let cid = 0; cid < n_comp; cid++) {
    const atoms = comp_atoms[cid]

    atoms.sort((p, q) => p - q) // deterministic local order
    const global_to_local = new Map<number, number>()
    atoms.forEach((g, i) => global_to_local.set(g, i))

    const local_bonds: OrganicEdge[] = comp_edges[cid].map((e) => ({
      a_local: global_to_local.get(e.a_global)!,
      b_local: global_to_local.get(e.b_global)!,
      a_global: e.a_global,
      b_global: e.b_global,
      jimage: e.jimage,
    }))

    components.push({ site_indices: atoms, local_bonds, global_to_local })
  }

  return components
}

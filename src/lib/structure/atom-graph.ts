import type { AnyStructure, ElementSymbol, Matrix3x3, Pbc, Vec3 } from '$lib'
import { mat3x3_vec3_multiply, transpose_3x3_matrix } from '$lib/math'
import { get_default_bond_length } from './atom-manipulation'
import type { AtomGraphEntry } from './viewer-registry.svelte'

/** Build the compact atom graph CatBot uses for semantic atom selection.
 *
 * Distances honor the minimum-image convention when the structure is
 * periodic (lattice matrix present and sites carry fractional `abc`), so an
 * atom bonded only across a cell boundary is recognized as a neighbor
 * instead of being mislabeled `coordination: 0` / `terminal` and split into
 * a spurious component — the common case for slabs and bulk. Non-periodic
 * inputs (molecules) fall back to raw Cartesian distance. Wrapping is
 * applied only along periodic axes (a 2D slab's vacuum axis is not wrapped).
 * O(n^2) over site pairs — fine for the molecule/slab sizes CatBot inspects.
 */
export function build_atom_graph(structure?: AnyStructure): AtomGraphEntry[] {
  const sites = structure?.sites ?? []
  const adjacency = sites.map(() => [] as number[])

  // Minimum-image setup — only when a lattice matrix is available and every
  // site has fractional coords. `matrix_T` is transpose(lattice) so that
  // cartesian = transpose(M) · fractional (the repo's abc↔xyz convention,
  // see atom-manipulation.ts).
  const lattice = structure && `lattice` in structure
    ? (structure as { lattice?: { matrix?: Matrix3x3; pbc?: Pbc } }).lattice
    : undefined
  const matrix_T = lattice?.matrix ? transpose_3x3_matrix(lattice.matrix) : undefined
  const pbc: Pbc = lattice?.pbc ?? [true, true, true]
  const use_pbc = !!matrix_T && sites.every((site) => Array.isArray(site.abc))

  const distance = (i: number, j: number): number => {
    if (use_pbc && matrix_T) {
      const da = sites[i].abc[0] - sites[j].abc[0]
      const db = sites[i].abc[1] - sites[j].abc[1]
      const dc = sites[i].abc[2] - sites[j].abc[2]
      const wrapped: Vec3 = [
        pbc[0] ? da - Math.round(da) : da,
        pbc[1] ? db - Math.round(db) : db,
        pbc[2] ? dc - Math.round(dc) : dc,
      ]
      const [dx, dy, dz] = mat3x3_vec3_multiply(matrix_T, wrapped)
      return Math.hypot(dx, dy, dz)
    }
    return Math.hypot(
      sites[i].xyz[0] - sites[j].xyz[0],
      sites[i].xyz[1] - sites[j].xyz[1],
      sites[i].xyz[2] - sites[j].xyz[2],
    )
  }

  for (let i = 0; i < sites.length; i++) {
    const element_i = sites[i].species?.[0]?.element ?? sites[i].label ?? `?`
    for (let j = i + 1; j < sites.length; j++) {
      const element_j = sites[j].species?.[0]?.element ?? sites[j].label ?? `?`
      const cutoff = get_default_bond_length(
        element_i as ElementSymbol,
        element_j as ElementSymbol,
      ) * 1.25
      if (distance(i, j) <= cutoff) {
        adjacency[i].push(j)
        adjacency[j].push(i)
      }
    }
  }

  const components = Array(sites.length).fill(-1) as number[]
  let component = 0
  for (let start = 0; start < sites.length; start++) {
    if (components[start] >= 0) continue
    const stack = [start]
    components[start] = component
    while (stack.length) {
      const current = stack.pop()!
      for (const neighbor of adjacency[current]) {
        if (components[neighbor] >= 0) continue
        components[neighbor] = component
        stack.push(neighbor)
      }
    }
    component++
  }

  return sites.map((site, index) => {
    const neighbors = adjacency[index]
    const terminal = neighbors.length <= 1
    return {
      index,
      element: site.species?.[0]?.element ?? site.label ?? `?`,
      xyz: [...site.xyz],
      neighbors,
      coordination: neighbors.length,
      component: components[index],
      terminal,
      // A terminal atom whose sole neighbor is itself multi-coordinated — a
      // sidechain/branch tip worth offering as a selection candidate.
      branch_candidate: neighbors.length === 1 && adjacency[neighbors[0]].length >= 2,
    }
  })
}

import type { AnyStructure, ElementSymbol } from '$lib'
import { get_default_bond_length } from './atom-manipulation'
import type { AtomGraphEntry } from './viewer-registry.svelte'

/** Build the compact atom graph CatBot uses for semantic atom selection. */
export function build_atom_graph(structure?: AnyStructure): AtomGraphEntry[] {
  const sites = structure?.sites ?? []
  const adjacency = sites.map(() => [] as number[])
  for (let i = 0; i < sites.length; i++) {
    const element_i = sites[i].species?.[0]?.element ?? sites[i].label ?? `?`
    for (let j = i + 1; j < sites.length; j++) {
      const element_j = sites[j].species?.[0]?.element ?? sites[j].label ?? `?`
      const cutoff = get_default_bond_length(
        element_i as ElementSymbol,
        element_j as ElementSymbol,
      ) * 1.25
      if (Math.hypot(
        sites[i].xyz[0] - sites[j].xyz[0],
        sites[i].xyz[1] - sites[j].xyz[1],
        sites[i].xyz[2] - sites[j].xyz[2],
      ) <= cutoff) {
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
      branch_candidate:
        terminal &&
        neighbors.length === 1 &&
        adjacency[neighbors[0]].length >= 2,
    }
  })
}

import { describe, expect, it } from 'vitest'
import type { AnyStructure } from '$lib'
import { build_atom_graph } from '$lib/structure/atom-graph'

describe(`CatBot atom graph`, () => {
  it(`marks terminal branch candidates and connected components`, () => {
    const structure = {
      sites: [
        { species: [{ element: `C`, occu: 1 }], label: `C`, xyz: [0, 0, 0] },
        { species: [{ element: `C`, occu: 1 }], label: `C`, xyz: [1.4, 0, 0] },
        { species: [{ element: `C`, occu: 1 }], label: `C`, xyz: [2.8, 0, 0] },
        { species: [{ element: `He`, occu: 1 }], label: `He`, xyz: [20, 0, 0] },
      ],
    } as unknown as AnyStructure

    const graph = build_atom_graph(structure)
    expect(graph[0]).toMatchObject({
      neighbors: [1],
      coordination: 1,
      component: 0,
      terminal: true,
      branch_candidate: true,
    })
    expect(graph[1]).toMatchObject({
      neighbors: [0, 2],
      coordination: 2,
      branch_candidate: false,
    })
    expect(graph[3]).toMatchObject({
      neighbors: [],
      component: 1,
      terminal: true,
      branch_candidate: false,
    })
  })
})

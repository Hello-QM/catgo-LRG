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

  it(`recognizes cross-cell bonds via the minimum-image convention`, () => {
    // Two C atoms 2.8 Å apart directly, but only 0.2 Å across the x boundary
    // of a 3 Å cell — a bond only the minimum-image distance can see.
    const structure = {
      sites: [
        { species: [{ element: `C`, occu: 1 }], label: `C`, xyz: [0.1, 0, 0], abc: [0.033333, 0, 0] },
        { species: [{ element: `C`, occu: 1 }], label: `C`, xyz: [2.9, 0, 0], abc: [0.966667, 0, 0] },
      ],
      lattice: { matrix: [[3, 0, 0], [0, 3, 0], [0, 0, 3]], pbc: [true, true, true] },
    } as unknown as AnyStructure

    const graph = build_atom_graph(structure)
    expect(graph[0].neighbors).toEqual([1])
    expect(graph[1].neighbors).toEqual([0])
    expect(graph[0].coordination).toBe(1)
    // One connected component despite spanning the cell boundary.
    expect(graph[0].component).toBe(graph[1].component)
  })

  it(`does not wrap a non-periodic (vacuum) axis`, () => {
    // Same separation but along z, where pbc is false (a slab's vacuum gap).
    const structure = {
      sites: [
        { species: [{ element: `C`, occu: 1 }], label: `C`, xyz: [0, 0, 0.1], abc: [0, 0, 0.033333] },
        { species: [{ element: `C`, occu: 1 }], label: `C`, xyz: [0, 0, 2.9], abc: [0, 0, 0.966667] },
      ],
      lattice: { matrix: [[3, 0, 0], [0, 3, 0], [0, 0, 3]], pbc: [true, true, false] },
    } as unknown as AnyStructure

    const graph = build_atom_graph(structure)
    expect(graph[0].neighbors).toEqual([])
    expect(graph[0].component).not.toBe(graph[1].component)
  })

  it(`returns an empty graph for a missing structure`, () => {
    expect(build_atom_graph(undefined)).toEqual([])
  })
})

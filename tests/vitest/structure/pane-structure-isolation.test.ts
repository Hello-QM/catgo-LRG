import { describe, expect, it } from 'vitest'
import { clone_structure } from '$lib/structure/clone'
import type { AnyStructure } from '$lib'

/**
 * Regression: structures crossing between panes / tabs.
 *
 * Panes used to receive structure objects BY REFERENCE (module-level sample
 * singletons, shared library entries, reused DB imports). The viewer mutates
 * `sites[i]` in place, so an edit in one pane bled into every other pane/tab
 * aliasing the same source object. `clone_structure` gives each pane an
 * independent deep copy.
 */

function make_structure(): AnyStructure {
  return {
    sites: [
      { species: [{ element: 'O', occu: 1 }], xyz: [0, 0, 0], abc: [0, 0, 0], label: 'O' },
      { species: [{ element: 'Ni', occu: 1 }], xyz: [1, 1, 1], abc: [0.5, 0.5, 0.5], label: 'Ni' },
    ],
    lattice: { matrix: [[2, 0, 0], [0, 2, 0], [0, 0, 2]] },
  } as unknown as AnyStructure
}

describe('pane structure isolation', () => {
  it('clone_structure returns a deep-independent copy', () => {
    const src = make_structure()
    const copy = clone_structure(src)
    expect(copy).not.toBe(src)
    expect(copy!.sites[0]).not.toBe(src.sites[0])
    expect(copy!.sites[0].xyz).not.toBe(src.sites[0].xyz)
    // mutate the copy in place (as the WASM fast-ops do)
    ;(copy!.sites[0].xyz as number[])[0] = 99
    expect((src.sites[0].xyz as number[])[0]).toBe(0)
  })

  it('passes null / undefined through unchanged', () => {
    expect(clone_structure(undefined)).toBeUndefined()
    expect(clone_structure(null)).toBeNull()
  })

  it('two panes loading the same shared source do not share site objects', () => {
    const shared = make_structure() // module-singleton-style source
    const pane1_structure = clone_structure(shared)
    const pane2_structure = clone_structure(shared)
    // in-place edit in pane 1 (e.g. atom move via scene fast-op)
    ;(pane1_structure!.sites[0].xyz as number[])[0] = 5
    expect((pane2_structure!.sites[0].xyz as number[])[0]).toBe(0)
    expect((shared.sites[0].xyz as number[])[0]).toBe(0)
  })
})

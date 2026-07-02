// load_popout_structure must never drop the payload: popouts share
// localStorage with the main window, so the restored active tab can be a
// terminal clone with no structure pane — the old code silently returned and
// the popout showed a terminal instead of the structure (Window + Overwrite
// "nothing opens").
import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock(`$lib/workflow/workflow-state.svelte`, () => ({
  pending_open_structure: { structure: null, label: ``, seq: 0 },
}))

import { pending_open_structure } from '$lib/workflow/workflow-state.svelte'
import { load_popout_structure } from '../../../desktop/lib/popout-manager'
import {
  create_empty_leaf,
  create_terminal_leaf,
  structurePane,
} from '../../../desktop/pane-tree'
import type { StructureTabState } from '../../../desktop/pane-utils'

const PAYLOAD = { structure: { sites: [{}] }, filename: `a.poscar` }

function stash(key: string) {
  localStorage.setItem(key, JSON.stringify(PAYLOAD))
  return `#structure?key=${key}`
}

beforeEach(() => {
  localStorage.clear()
  pending_open_structure.structure = null
  pending_open_structure.label = ``
  pending_open_structure.seq = 0
})

describe(`load_popout_structure`, () => {
  test(`loads into the active structure leaf`, () => {
    const root = create_empty_leaf()
    const ts = { root, active_leaf_id: root.id } as unknown as StructureTabState
    const update = vi.fn()
    load_popout_structure(stash(`k1`), () => ts, `tab-1`, update)
    expect(structurePane(root)?.structure).toEqual(PAYLOAD.structure)
    expect(structurePane(root)?.source_filename).toBe(`a.poscar`)
    expect(update).toHaveBeenCalledWith(`tab-1`)
    expect(pending_open_structure.seq).toBe(0)
  })

  test(`falls back to the tab's first structure pane when the active leaf is a terminal`, () => {
    const term = create_terminal_leaf()
    const struct = create_empty_leaf()
    const root = {
      kind: `split`,
      id: `s1`,
      direction: `h`,
      ratio: 0.5,
      children: [term, struct],
    } as unknown as StructureTabState[`root`]
    const ts = { root, active_leaf_id: term.id } as unknown as StructureTabState
    load_popout_structure(stash(`k2`), () => ts, `tab-1`, vi.fn())
    expect(structurePane(struct)?.structure).toEqual(PAYLOAD.structure)
    expect(pending_open_structure.seq).toBe(0)
  })

  test(`signals pending_open_structure when the tab has no structure pane at all`, () => {
    const root = create_terminal_leaf()
    const ts = { root, active_leaf_id: root.id } as unknown as StructureTabState
    load_popout_structure(stash(`k3`), () => ts, `tab-1`, vi.fn())
    expect(pending_open_structure.seq).toBe(1)
    expect(pending_open_structure.structure).toEqual(PAYLOAD.structure)
    expect(pending_open_structure.label).toBe(`a.poscar`)
  })

  test(`signals pending_open_structure when there is no active tab state`, () => {
    load_popout_structure(stash(`k4`), () => null, `tab-1`, vi.fn())
    expect(pending_open_structure.seq).toBe(1)
    expect(pending_open_structure.structure).toEqual(PAYLOAD.structure)
  })
})

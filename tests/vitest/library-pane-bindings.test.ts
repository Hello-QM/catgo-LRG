import { describe, expect, it, vi } from 'vitest'
import type { AnyStructure } from '$lib'
import type { LibraryEntry, StructureTabState } from '../../desktop/pane-utils'
import { create_empty_pane, create_tab_state } from '../../desktop/pane-utils'
import { leaves, splitLeaf, structurePane, type LeafNode } from '../../desktop/pane-tree'
import {
  cancel_pending_library_removal,
  leaves_for_library_entry,
  prepare_library_entry_removal,
  sync_active_library_entry,
} from '../../desktop/lib/library-pane-bindings'
import { close_panel, type PaneManagerDeps } from '../../desktop/lib/pane-manager'

function structure(element: string): AnyStructure {
  return {
    sites: [{
      species: [{ element, occu: 1 }],
      label: element,
      xyz: [0, 0, 0],
      abc: [0, 0, 0],
    }],
  } as unknown as AnyStructure
}

function entry(id: string, is_trajectory = false): LibraryEntry {
  return {
    id,
    filename: `same.traj`,
    format: is_trajectory ? `traj` : `cif`,
    structure: is_trajectory ? undefined : structure(id),
    trajectory: is_trajectory ? { frames: [{ structure: structure(id), step: 0 }] } : undefined,
    is_trajectory,
  }
}

function two_pane_tab(): { ts: StructureTabState; left: LeafNode; right: LeafNode } {
  const ts = create_tab_state()
  const result = splitLeaf(ts.root, ts.active_leaf_id, `h`)
  if (!result) throw new Error(`failed to split test pane`)
  ts.root = result.root
  const [left, right] = leaves(ts.root)
  return { ts, left, right }
}

function bind(leaf: LeafNode, item: LibraryEntry): void {
  const pane = structurePane(leaf)
  if (!pane) throw new Error(`expected structure pane`)
  Object.assign(pane, create_empty_pane(), {
    structure: item.structure,
    trajectory: item.trajectory ?? null,
    is_trajectory_mode: item.is_trajectory,
    source_filename: item.filename,
    library_entry_id: item.id,
  })
}

function deps(ts: StructureTabState) {
  const update_tab_label = vi.fn()
  const reset_viewer = vi.fn()
  const value: PaneManagerDeps = {
    tab_states: { tab: ts },
    update_tab_label,
    export_fs_browse: vi.fn(),
    reset_viewer,
  }
  return { value, update_tab_label, reset_viewer }
}

describe(`library entry to pane bindings`, () => {
  it(`distinguishes two same-name trajectory instances by entry id`, () => {
    const { ts, left, right } = two_pane_tab()
    const first = entry(`trajectory-1`, true)
    const second = entry(`trajectory-2`, true)
    ts.library = [first, second]
    bind(left, first)
    bind(right, second)

    expect(leaves_for_library_entry(ts, first.id).map((leaf) => leaf.id)).toEqual([left.id])
    expect(leaves_for_library_entry(ts, second.id).map((leaf) => leaf.id)).toEqual([right.id])
  })

  it(`removes one same-name static entry only after its pane closes`, () => {
    const { ts, left, right } = two_pane_tab()
    const first = entry(`structure-1`)
    const second = entry(`structure-2`)
    ts.library = [first, second]
    bind(left, first)
    bind(right, second)
    ts.active_leaf_id = right.id

    expect(prepare_library_entry_removal(ts, first.id)).toEqual({ kind: `close`, leaf_id: left.id })
    expect(ts.library.map((item) => item.id)).toEqual([first.id, second.id])

    const manager = deps(ts)
    close_panel(manager.value, `tab`, left.id)

    expect(ts.library.map((item) => item.id)).toEqual([second.id])
    expect(leaves(ts.root).map((leaf) => leaf.id)).toEqual([right.id])
    expect(structurePane(right)?.library_entry_id).toBe(second.id)
    expect(manager.reset_viewer).toHaveBeenCalledWith(`tab`, left.id)
  })

  it(`closes only the selected same-name trajectory instance`, () => {
    const { ts, left, right } = two_pane_tab()
    const first = entry(`trajectory-1`, true)
    const second = entry(`trajectory-2`, true)
    ts.library = [first, second]
    bind(left, first)
    bind(right, second)
    const right_pane = structurePane(right)
    if (!right_pane) throw new Error(`expected right structure pane`)
    right_pane.current_step_idx = 1

    expect(prepare_library_entry_removal(ts, first.id)).toEqual({ kind: `close`, leaf_id: left.id })
    close_panel(deps(ts).value, `tab`, left.id)

    expect(ts.library.map((item) => item.id)).toEqual([second.id])
    expect(leaves(ts.root).map((leaf) => leaf.id)).toEqual([right.id])
    expect(structurePane(right)?.library_entry_id).toBe(second.id)
    expect(structurePane(right)?.current_step_idx).toBe(1)
  })

  it(`direct pane close keeps the library entry but unbinds it`, () => {
    const ts = create_tab_state()
    const item = entry(`keep-me`)
    ts.library = [item]
    bind(leaves(ts.root)[0], item)

    close_panel(deps(ts).value, `tab`, ts.active_leaf_id)

    expect(ts.library.map((value) => value.id)).toEqual([item.id])
    expect(structurePane(leaves(ts.root)[0])?.library_entry_id).toBeNull()
    expect(ts.active_library_id).toBeNull()
  })

  it(`deletes an unbound entry without closing another pane`, () => {
    const { ts, left } = two_pane_tab()
    const displayed = entry(`displayed`)
    const unbound = entry(`unbound`)
    ts.library = [displayed, unbound]
    bind(left, displayed)

    expect(prepare_library_entry_removal(ts, unbound.id)).toEqual({ kind: `unbound` })
    expect(ts.library.map((item) => item.id)).toEqual([displayed.id])
    expect(leaves(ts.root)).toHaveLength(2)
    expect(structurePane(left)?.library_entry_id).toBe(displayed.id)
  })

  it(`keeps pane and entry when a pending removal is cancelled`, () => {
    const ts = create_tab_state()
    const item = entry(`cancel-me`, true)
    ts.library = [item]
    const leaf = leaves(ts.root)[0]
    bind(leaf, item)

    expect(prepare_library_entry_removal(ts, item.id)).toEqual({ kind: `close`, leaf_id: leaf.id })
    cancel_pending_library_removal(ts, leaf.id)

    expect(ts.pending_library_removal).toBeNull()
    expect(ts.library).toHaveLength(1)
    expect(structurePane(leaf)?.library_entry_id).toBe(item.id)
  })

  it(`refuses an ambiguous legacy duplicate binding`, () => {
    const { ts, left, right } = two_pane_tab()
    const item = entry(`legacy-duplicate`, true)
    ts.library = [item]
    bind(left, item)
    bind(right, item)

    expect(prepare_library_entry_removal(ts, item.id)).toEqual({ kind: `ambiguous` })
    expect(ts.pending_library_removal).toBeNull()
    expect(ts.library).toHaveLength(1)
  })

  it(`does not delete an entry when a delayed close no longer matches it`, () => {
    const ts = create_tab_state()
    const original = entry(`original`)
    const replacement = entry(`replacement`)
    ts.library = [original, replacement]
    const leaf = leaves(ts.root)[0]
    bind(leaf, original)

    expect(prepare_library_entry_removal(ts, original.id)).toEqual({ kind: `close`, leaf_id: leaf.id })
    bind(leaf, replacement)
    close_panel(deps(ts).value, `tab`, leaf.id)

    expect(ts.library.map((item) => item.id)).toEqual([original.id, replacement.id])
    expect(ts.pending_library_removal).toBeNull()
  })

  it(`keeps open panes when the library list is cleared, leaving bindings inert`, () => {
    const { ts, left, right } = two_pane_tab()
    const first = entry(`a`)
    const second = entry(`b`)
    ts.library = [first, second]
    bind(left, first)
    bind(right, second)

    // Simulate "Clear list": empty the library, leave panes mounted.
    ts.library = []

    // Open panes are untouched.
    expect(leaves(ts.root).map((leaf) => leaf.id)).toEqual([left.id, right.id])
    expect(structurePane(left)?.library_entry_id).toBe(first.id)
    // A now-dangling binding is inert: removal reports missing, highlight clears.
    expect(prepare_library_entry_removal(ts, first.id)).toEqual({ kind: `missing` })
    ts.active_leaf_id = left.id
    expect(sync_active_library_entry(ts)).toBeNull()
    // A direct close commits nothing (no pending removal was armed).
    close_panel(deps(ts).value, `tab`, left.id)
    expect(leaves(ts.root).map((leaf) => leaf.id)).toEqual([right.id])
    expect(ts.library).toEqual([])
  })

  it(`derives sidebar highlighting from the active pane`, () => {
    const { ts, left, right } = two_pane_tab()
    const first = entry(`left`)
    const second = entry(`right`, true)
    ts.library = [first, second]
    bind(left, first)
    bind(right, second)

    ts.active_leaf_id = left.id
    expect(sync_active_library_entry(ts)).toBe(first.id)
    ts.active_leaf_id = right.id
    expect(sync_active_library_entry(ts)).toBe(second.id)
  })
})

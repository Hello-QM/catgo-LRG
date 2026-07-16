import { create_selection_state } from '$lib/structure/state/selection-state.svelte'
import { describe, expect, it } from 'vitest'

const struct = (n: number) =>
  ({
    sites: Array.from({ length: n }, () => ({ species: [{ element: `C` }], xyz: [0, 0, 0] })),
  }) as never

describe(`external history entries (Build T5)`, () => {
  it(`stores only the token — no structure snapshot on either stack`, () => {
    const sel = create_selection_state()
    sel.push_external_entry(`trajectory-supercell-op-0`)
    expect(sel.can_undo).toBe(true)

    const entry = sel.pop_entry()
    expect(entry).toEqual({ kind: `external`, history_token: `trajectory-supercell-op-0` })
    expect(entry !== null && `structure` in entry).toBe(false)

    sel.push_external_redo(`trajectory-supercell-op-0`)
    expect(sel.can_redo).toBe(true)
    const redo = sel.pop_redo_entry()
    expect(redo).toEqual({ kind: `external`, history_token: `trajectory-supercell-op-0` })
    expect(redo !== null && `structure` in redo).toBe(false)
  })

  it(`a fresh external edit clears the redo branch`, () => {
    const sel = create_selection_state()
    sel.push_redo(struct(1))
    expect(sel.can_redo).toBe(true)
    sel.push_external_entry(`trajectory-supercell-op-1`)
    expect(sel.can_redo).toBe(false)
  })

  it(`redo's re-push keeps the redo branch (clear_redo=false)`, () => {
    const sel = create_selection_state()
    sel.push_external_redo(`tok-a`)
    sel.push_external_redo(`tok-b`)
    sel.push_external_entry(`tok-b`, false) // the redo() re-push path
    expect(sel.can_redo).toBe(true) // NOT cleared
    expect(sel.can_undo).toBe(true)
  })

  it(`pop_redo_entry wraps legacy structure snapshots as structure-kind entries`, () => {
    const sel = create_selection_state()
    sel.push_redo(struct(3))
    const entry = sel.pop_redo_entry()
    expect(entry?.kind).toBe(`structure`)
    if (entry?.kind === `structure`) {
      expect((entry.structure as unknown as { sites: unknown[] }).sites).toHaveLength(3)
    }
    expect(sel.pop_redo_entry()).toBeNull()
  })

  it(`legacy pop_redo still round-trips structure snapshots`, () => {
    const sel = create_selection_state()
    sel.push_redo(struct(2))
    const snap = sel.pop_redo() as { sites: unknown[] } | null
    expect(snap?.sites).toHaveLength(2)
    expect(sel.pop_redo()).toBeNull()
  })

  it(`first_structure_snapshot skips external entries`, () => {
    const sel = create_selection_state()
    sel.push_external_entry(`tok-early`)
    expect(sel.first_structure_snapshot).toBeNull()
    sel.push_structure_entry(struct(2))
    const snap = sel.first_structure_snapshot as unknown as { sites: unknown[] } | null
    expect(snap?.sites).toHaveLength(2)
  })

  it(`external entries respect the undo trim limit`, () => {
    const sel = create_selection_state()
    for (let idx = 0; idx < sel.MAX_UNDO_HISTORY + 5; idx++) {
      sel.push_external_entry(`tok-${idx}`)
    }
    expect(sel.undo_history).toHaveLength(sel.MAX_UNDO_HISTORY)
    expect(sel.undo_history[0]).toEqual({ kind: `external`, history_token: `tok-5` })
  })
})

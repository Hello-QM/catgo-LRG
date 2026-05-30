import { describe, it, expect } from 'vitest'
import { create_selection_state } from '$lib/structure/state/selection-state.svelte'

const struct = (n: number) =>
  ({ sites: Array.from({ length: n }, () => ({ species: [{ element: `C` }], xyz: [0, 0, 0] })) }) as never

describe(`selection-state redo stack`, () => {
  it(`push_redo / pop_redo / can_redo round-trip`, () => {
    const s = create_selection_state()
    expect(s.can_redo).toBe(false)
    s.push_redo(struct(3))
    expect(s.can_redo).toBe(true)
    const r = s.pop_redo() as { sites: unknown[] } | null
    expect(r?.sites).toHaveLength(3)
    expect(s.can_redo).toBe(false)
    expect(s.pop_redo()).toBeNull()
  })

  it(`a fresh structure edit clears the redo branch`, () => {
    const s = create_selection_state()
    s.push_redo(struct(1))
    expect(s.can_redo).toBe(true)
    s.push_structure_entry(struct(2)) // clear_redo defaults true
    expect(s.can_redo).toBe(false)
  })

  it(`redo's internal re-push keeps the redo stack (clear_redo=false)`, () => {
    const s = create_selection_state()
    s.push_redo(struct(1))
    s.push_redo(struct(2))
    s.push_structure_entry(struct(9), false) // the redo() path
    expect(s.can_redo).toBe(true) // NOT cleared
    expect(s.can_undo).toBe(true)
  })

  it(`atom / bond edits also clear redo`, () => {
    const s = create_selection_state()
    s.push_redo(struct(1))
    s.push_atom_entry({ removed_indices: [], removed_sites: [], removed_atom_opacity_entries: [] } as never)
    expect(s.can_redo).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { create_modified_registry } from '$lib/structure/close-guard.svelte'
import { clear_modified_if_sole_pane, create_tab_state } from '../../../desktop/pane-utils'
import { leaves, splitLeaf, structurePane } from '../../../desktop/pane-tree'

describe('modified registry', () => {
  it('tracks dirty tabs and clears on save', () => {
    const r = create_modified_registry()
    expect(r.is_modified('t1')).toBe(false)
    r.mark('t1')
    expect(r.is_modified('t1')).toBe(true)
    expect(r.any_modified()).toBe(true)
    r.clear('t1')
    expect(r.is_modified('t1')).toBe(false)
    expect(r.any_modified()).toBe(false)
  })

  it('clear_all wipes every dirty tab (Close-All completion)', () => {
    const r = create_modified_registry()
    r.mark('t1')
    r.mark('t2')
    expect(r.any_modified()).toBe(true)
    r.clear_all()
    expect(r.is_modified('t1')).toBe(false)
    expect(r.is_modified('t2')).toBe(false)
    expect(r.any_modified()).toBe(false)
  })
})

describe('clear_modified_if_sole_pane', () => {
  const structure = { sites: [{}] } as never

  it('clears when the pane is the sole content-bearing pane', () => {
    const r = create_modified_registry()
    const ts = create_tab_state()
    const leaf = leaves(ts.root)[0]
    structurePane(leaf)!.structure = structure
    r.mark('t1')
    expect(clear_modified_if_sole_pane(r, ts.root, 't1', leaf.id)).toBe(true)
    expect(r.is_modified('t1')).toBe(false)
  })

  it('keeps the flag when a sibling pane also has content', () => {
    const r = create_modified_registry()
    const ts = create_tab_state()
    const first = ts.active_leaf_id
    const res = splitLeaf(ts.root, first, 'h')!
    ts.root = res.root
    for (const l of leaves(ts.root)) structurePane(l)!.structure = structure
    r.mark('t1')
    expect(clear_modified_if_sole_pane(r, ts.root, 't1', first)).toBe(false)
    expect(r.is_modified('t1')).toBe(true)
  })

  it('keeps the flag when only a different pane has content', () => {
    const r = create_modified_registry()
    const ts = create_tab_state()
    const first = ts.active_leaf_id
    const res = splitLeaf(ts.root, first, 'h')!
    ts.root = res.root
    const sibling = leaves(ts.root).find((l) => l.id !== first)!
    structurePane(sibling)!.structure = structure
    r.mark('t1')
    expect(clear_modified_if_sole_pane(r, ts.root, 't1', first)).toBe(false)
    expect(r.is_modified('t1')).toBe(true)
  })

  it('clears when no pane has content', () => {
    const r = create_modified_registry()
    const ts = create_tab_state()
    r.mark('t1')
    expect(clear_modified_if_sole_pane(r, ts.root, 't1', ts.active_leaf_id)).toBe(true)
    expect(r.is_modified('t1')).toBe(false)
  })
})

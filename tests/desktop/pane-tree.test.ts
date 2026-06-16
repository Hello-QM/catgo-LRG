import { describe, expect, it } from 'vitest'
import { create_empty_pane } from '../../desktop/pane-utils'
import {
  CAP, buildPreset, create_empty_leaf, escalateForImport, findFirstEmptyLeaf,
  findLeafById, findSplit, isEmptyLeaf, leafCount, leaves, matchesPreset,
  removeLeaf, setRatio, splitLeaf,
  type LeafNode, type PaneNode, type SplitNode,
} from '../../desktop/pane-tree'

const leaf = (id: string): LeafNode => ({ kind: 'leaf', id, content: { type: 'structure', pane: create_empty_pane() } })
const split = (id: string, dir: 'h' | 'v', ratio: number, a: PaneNode, b: PaneNode): SplitNode => ({ kind: 'split', id, direction: dir, ratio, children: [a, b] })

describe('leaves / leafCount / find', () => {
  it('single leaf', () => {
    const root = leaf('L1')
    expect(leaves(root).map(l => l.id)).toEqual(['L1'])
    expect(leafCount(root)).toBe(1)
  })
  it('nested tree returns leaves left-to-right', () => {
    const root = split('S1', 'h', 0.5, split('S2', 'v', 0.5, leaf('A'), leaf('B')), leaf('C'))
    expect(leaves(root).map(l => l.id)).toEqual(['A', 'B', 'C'])
    expect(leafCount(root)).toBe(3)
    expect(findLeafById(root, 'B')?.id).toBe('B')
    expect(findLeafById(root, 'nope')).toBeNull()
    expect(findSplit(root, 'S2')?.direction).toBe('v')
    expect(findSplit(root, 'A')).toBeNull()
  })
})

describe('empty leaves', () => {
  it('create_empty_leaf is an empty structure leaf with a unique id', () => {
    const a = create_empty_leaf(); const b = create_empty_leaf()
    expect(a.kind).toBe('leaf')
    expect(a.content.type).toBe('structure')
    expect(isEmptyLeaf(a)).toBe(true)
    expect(a.id).not.toBe(b.id)
  })
  it('findFirstEmptyLeaf returns first content-free leaf or null', () => {
    const filled = create_empty_leaf(); filled.content.pane.structure = { sites: [{}] } as never
    const empty = create_empty_leaf()
    const root = split('S', 'h', 0.5, filled, empty)
    expect(findFirstEmptyLeaf(root)?.id).toBe(empty.id)
    const full = split('S2', 'h', 0.5, filled, filled)
    expect(findFirstEmptyLeaf(full)).toBeNull()
  })
})

describe('splitLeaf / removeLeaf', () => {
  it('splitLeaf replaces a leaf with a split of [old, newEmpty]', () => {
    const root0 = create_empty_leaf()
    const { root, newLeafId } = splitLeaf(root0, root0.id, 'h')
    expect(root.kind).toBe('split')
    expect(leafCount(root)).toBe(2)
    expect((root as SplitNode).direction).toBe('h')
    expect((root as SplitNode).ratio).toBe(0.5)
    expect(findLeafById(root, newLeafId)).not.toBeNull()
    // original leaf id preserved as children[0]
    expect(((root as SplitNode).children[0] as LeafNode).id).toBe(root0.id)
  })
  it('splitLeaf refuses at CAP leaves', () => {
    let root: PaneNode = create_empty_leaf()
    let active = (root as LeafNode).id
    for (let i = 1; i < CAP; i++) { const r = splitLeaf(root, active, 'v'); root = r.root; active = r.newLeafId }
    expect(leafCount(root)).toBe(CAP)
    expect(splitLeaf(root, active, 'v')).toBeNull()
  })
  it('removeLeaf collapses parent split, sibling takes its place', () => {
    const a = create_empty_leaf(); const b = create_empty_leaf(); const c = create_empty_leaf()
    const root = split('S1', 'h', 0.4, split('S2', 'v', 0.5, a, b), c)
    const next = removeLeaf(root, b.id) // S2 collapses -> a takes S2's slot
    expect(leaves(next).map(l => l.id)).toEqual([a.id, c.id])
    expect((next as SplitNode).id).toBe('S1')
    expect(((next as SplitNode).children[0] as LeafNode).id).toBe(a.id)
  })
  it('removeLeaf of the only leaf returns the leaf unchanged (never empty tree)', () => {
    const only = create_empty_leaf()
    expect(removeLeaf(only, only.id)).toBe(only)
  })
})

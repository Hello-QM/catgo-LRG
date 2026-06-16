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

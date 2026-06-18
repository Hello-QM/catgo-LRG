# Pane-Tree Core (Subproject 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the desktop fixed 4-pane grid (`single|splitH|splitV|quad`) with one recursive binary **pane tree**, behavior-equivalent except the two deltas in the spec §6.5 (independent quad dividers; one-leaf-at-a-time escalation).

**Architecture:** A pure-data tree (`SplitNode | LeafNode`) plus pure ops in a new `desktop/pane-tree.ts`, rendered by a new recursive `desktop/PaneTree.svelte`. `StructureTabState` swaps `panes[]/layout/active_pane/col_split/row_split` for `root: PaneNode` + `active_leaf_id` + `close_confirm_leaf_id`. Leaf content in this subproject is a single `{type:'structure', pane: PaneState}` variant (subproject 2 widens it to include `terminal`). `PaneState` is **unchanged**.

**Tech Stack:** SvelteKit 2 / Svelte 5 runes (`$state`/`$derived`/`$props`), TypeScript, Vitest, `deno fmt` (single quotes, no semicolons, 2-space, 90-col — let the pre-commit hook format).

**Constraint (spec D8):** Desktop only. `desktop/` is not imported by `src/lib/mobile/*` (verified). The only shared file is `desktop/pane-utils.ts` exports — but mobile imports of it must be re-verified in Task 2 (it changes `StructureTabState`/`create_tab_state`). No edit to `src/lib/mobile/*`.

---

## Contract changes (shared reference — every task below depends on these names)

| Thing | Before | After |
|------|--------|-------|
| `StructureTabState` | `panes: PaneState[4]`, `layout: LayoutType`, `active_pane: number`, `close_confirm_pane: number\|null`, `col_split`, `row_split` | `root: PaneNode`, `active_leaf_id: string`, `close_confirm_leaf_id: string\|null` (keeps `library`, `active_library_id`) |
| App `$state` `drag_target_pane` | `number\|null` | `drag_target_leaf: string\|null` |
| App `$state` `resize_axis` | `'col'\|'row'` | removed (drag tracks `active_split_id: string\|null`) |
| App `$state` `file_input_target_pane` | `number` | `file_input_target_leaf: string` |
| App `$state` `active_pane` usages | `ts.active_pane` | `ts.active_leaf_id` |
| `modal.import_target_pane` (`desktop/state/modal-state.svelte`) | `number` | `import_target_leaf: string` |
| `exp.close_after` (`desktop/state/export-state.svelte`) | `{tab_id, pane_idx:number}` | `{tab_id, leaf_id:string}` |
| `CloseAllEntry` (`desktop/state/modal-state.svelte`) | `pane_idx: number` | `leaf_id: string` |
| `pending_layout_change.new_layout` (tab-manager) | `LayoutType` | `PresetId` |
| Dep/fn signatures: `handle_open_file`, `handle_open_folder`, `handle_unload`, `close_panel`, `save_and_close_panel`, `process_file_content`, `import_many`, `popout_pane`, `apply_entry_to_pane`, `create_on_file_load`, `create_on_file_drop` | `…pane_idx: number` | `…leaf_id: string` |
| `DragDropDeps.get/set_drag_target_pane` | `number\|null` | `string\|null` |
| DOM attribute | `[data-pane]` | `[data-leaf-id]` |
| Removed exports from `pane-utils.ts` | `LayoutType`, `layout_panel_count`, `find_import_target_pane`, `get_visible_panes`, `get_grid_style`, `get_pane_position` | — (moved to tree model) |

**Build-red window:** Task 1 (pane-tree.ts) is fully green/committable. Tasks 2–15 are one atomic model flip — `pnpm check` is expected to be RED from Task 2 until the last consumer in Task 15, then GREEN. `pnpm test` for `pane-tree.test.ts` stays green throughout. Commit WIP at each task (feature branch).

---

## Task 1: `desktop/pane-tree.ts` — pure tree model + ops (TDD, fully green)

**Files:**
- Create: `desktop/pane-tree.ts`
- Test: `tests/desktop/pane-tree.test.ts`

The canonical API (every later task imports from here):
`leaves`, `leafCount`, `findLeafById`, `findSplit`, `isEmptyLeaf`, `findFirstEmptyLeaf`, `create_empty_leaf`, `splitLeaf`, `escalateForImport`, `removeLeaf`, `setRatio`, `buildPreset`, `matchesPreset`, `CAP`, and types `PaneNode`/`SplitNode`/`LeafNode`/`LeafContent`/`PresetId`/`SplitDir`.

- [ ] **Step 1.1: Write failing tests for types + `leaves`/`leafCount`/`findLeafById`/`findSplit`**

Create `tests/desktop/pane-tree.test.ts`:

```ts
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
```

- [ ] **Step 1.2: Run, verify fail**

Run: `pnpm vitest run tests/desktop/pane-tree.test.ts`
Expected: FAIL — `pane-tree.ts` does not exist / exports undefined.

- [ ] **Step 1.3: Implement types + traversal in `desktop/pane-tree.ts`**

```ts
/**
 * Recursive pane tree — the desktop layout primitive (replaces the fixed
 * single/splitH/splitV/quad grid). A tab's layout is one PaneNode.
 *
 * Subproject 1: leaf content is only { type: 'structure', pane }. Subproject 2
 * widens LeafContent to include { type: 'terminal', ... }.
 */
import type { PaneState } from './pane-utils'
import { create_empty_pane, pane_has_content } from './pane-utils'

export type SplitDir = 'h' | 'v' // 'h' = side by side (vertical divider); 'v' = stacked (horizontal divider)
export type PresetId = 'single' | 'splitH' | 'splitV' | 'quad'

export type LeafContent = { type: 'structure'; pane: PaneState }

export interface LeafNode {
  kind: 'leaf'
  id: string
  content: LeafContent
}

export interface SplitNode {
  kind: 'split'
  id: string
  direction: SplitDir
  ratio: number // 0..1 fraction for children[0]; clamped 0.2..0.8 on user drag
  children: [PaneNode, PaneNode]
}

export type PaneNode = SplitNode | LeafNode

/** Max leaves per tab (spec D6). Preserves the old single->2->4 GPU envelope. */
export const CAP = 4

let _id_counter = 0
function next_id(prefix: string): string {
  _id_counter += 1
  return `${prefix}-${_id_counter}`
}

export function leaves(node: PaneNode): LeafNode[] {
  if (node.kind === 'leaf') return [node]
  return [...leaves(node.children[0]), ...leaves(node.children[1])]
}

export function leafCount(node: PaneNode): number {
  return node.kind === 'leaf' ? 1 : leafCount(node.children[0]) + leafCount(node.children[1])
}

export function findLeafById(node: PaneNode, id: string): LeafNode | null {
  if (node.kind === 'leaf') return node.id === id ? node : null
  return findLeafById(node.children[0], id) ?? findLeafById(node.children[1], id)
}

export function findSplit(node: PaneNode, id: string): SplitNode | null {
  if (node.kind === 'leaf') return null
  if (node.id === id) return node
  return findSplit(node.children[0], id) ?? findSplit(node.children[1], id)
}
```

- [ ] **Step 1.4: Run, verify pass**

Run: `pnpm vitest run tests/desktop/pane-tree.test.ts`
Expected: PASS (the `leaves / leafCount / find` block).

- [ ] **Step 1.5: Commit**

```bash
git add desktop/pane-tree.ts tests/desktop/pane-tree.test.ts
git commit -m "feat(pane-tree): tree types + traversal (leaves/leafCount/find)"
```

- [ ] **Step 1.6: Add failing tests for `create_empty_leaf`/`isEmptyLeaf`/`findFirstEmptyLeaf`**

Append to the test file:

```ts
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
```

- [ ] **Step 1.7: Run, verify fail** — `pnpm vitest run tests/desktop/pane-tree.test.ts` → FAIL (undefined exports).

- [ ] **Step 1.8: Implement empty-leaf helpers** (append to `pane-tree.ts`):

```ts
export function create_empty_leaf(): LeafNode {
  return { kind: 'leaf', id: next_id('leaf'), content: { type: 'structure', pane: create_empty_pane() } }
}

/** A leaf is "empty" when it is a structure leaf holding nothing renderable. */
export function isEmptyLeaf(leaf: LeafNode): boolean {
  return leaf.content.type === 'structure' && !pane_has_content(leaf.content.pane)
}

export function findFirstEmptyLeaf(node: PaneNode): LeafNode | null {
  for (const l of leaves(node)) if (isEmptyLeaf(l)) return l
  return null
}
```

- [ ] **Step 1.9: Run, verify pass** — `pnpm vitest run tests/desktop/pane-tree.test.ts` → PASS.

- [ ] **Step 1.10: Commit**

```bash
git add desktop/pane-tree.ts tests/desktop/pane-tree.test.ts
git commit -m "feat(pane-tree): empty-leaf helpers (create_empty_leaf/isEmptyLeaf/findFirstEmptyLeaf)"
```

- [ ] **Step 1.11: Add failing tests for `splitLeaf` + `removeLeaf` (collapse) + CAP**

Append:

```ts
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
```

- [ ] **Step 1.12: Run, verify fail.**

- [ ] **Step 1.13: Implement `splitLeaf` + `removeLeaf`** (append):

```ts
/** Replace `leafId` with a split of [existing, newEmptyLeaf]. Returns null at CAP. */
export function splitLeaf(root: PaneNode, leafId: string, direction: SplitDir): { root: PaneNode; newLeafId: string } | null {
  if (leafCount(root) >= CAP) return null
  const target = findLeafById(root, leafId)
  if (!target) return null
  const newLeaf = create_empty_leaf()
  const replacement: SplitNode = { kind: 'split', id: next_id('split'), direction, ratio: 0.5, children: [target, newLeaf] }
  return { root: replaceNode(root, leafId, replacement), newLeafId: newLeaf.id }
}

/** Remove a leaf; collapse its parent split so the sibling takes the parent's place. */
export function removeLeaf(root: PaneNode, leafId: string): PaneNode {
  if (root.kind === 'leaf') return root // never destroy the sole leaf
  return removeIn(root, leafId)
}

function removeIn(node: SplitNode, leafId: string): PaneNode {
  const [a, b] = node.children
  if (a.kind === 'leaf' && a.id === leafId) return b
  if (b.kind === 'leaf' && b.id === leafId) return a
  const na = a.kind === 'split' ? removeIn(a, leafId) : a
  const nb = b.kind === 'split' ? removeIn(b, leafId) : b
  if (na === a && nb === b) return node
  return { ...node, children: [na, nb] }
}

/** Pure structural replace of a node (by id) anywhere in the tree. */
function replaceNode(node: PaneNode, id: string, replacement: PaneNode): PaneNode {
  if (node.kind === 'leaf') return node.id === id ? replacement : node
  if (node.id === id) return replacement
  const a = replaceNode(node.children[0], id, replacement)
  const b = replaceNode(node.children[1], id, replacement)
  if (a === node.children[0] && b === node.children[1]) return node
  return { ...node, children: [a, b] }
}
```

- [ ] **Step 1.14: Run, verify pass. Commit.**

```bash
git add desktop/pane-tree.ts tests/desktop/pane-tree.test.ts
git commit -m "feat(pane-tree): splitLeaf (CAP) + removeLeaf (collapse to sibling)"
```

- [ ] **Step 1.15: Add failing tests for `setRatio`, `escalateForImport`, `buildPreset`, `matchesPreset`**

Append:

```ts
describe('setRatio', () => {
  it('sets a split ratio (pure) and clamps 0.2..0.8', () => {
    const root = split('S', 'h', 0.5, create_empty_leaf(), create_empty_leaf())
    expect((setRatio(root, 'S', 0.7) as SplitNode).ratio).toBe(0.7)
    expect((setRatio(root, 'S', 0.01) as SplitNode).ratio).toBe(0.2)
    expect((setRatio(root, 'S', 0.99) as SplitNode).ratio).toBe(0.8)
    expect(setRatio(root, 'missing', 0.7)).toBe(root)
  })
})

describe('escalateForImport (open-file target policy)', () => {
  it('1->2->3->4 leaves one at a time, then null at CAP (open new tab)', () => {
    let root: PaneNode = create_empty_leaf()
    let active = (root as LeafNode).id
    // fill the first leaf so it is no longer empty
    ;(root as LeafNode).content.pane.structure = { sites: [{}] } as never
    for (let n = 2; n <= CAP; n++) {
      const r = escalateForImport(root, active)!
      root = r.root; active = r.leafId
      expect(leafCount(root)).toBe(n)
      findLeafById(root, active)!.content.pane.structure = { sites: [{}] } as never
    }
    expect(escalateForImport(root, active)).toBeNull()
  })
  it('reuses an existing empty leaf instead of splitting', () => {
    const filled = create_empty_leaf(); filled.content.pane.structure = { sites: [{}] } as never
    const empty = create_empty_leaf()
    const root = split('S', 'h', 0.5, filled, empty)
    const r = escalateForImport(root, filled.id)!
    expect(r.leafId).toBe(empty.id)
    expect(leafCount(r.root)).toBe(2) // no new split
  })
})

describe('buildPreset / matchesPreset', () => {
  it('builds canonical preset trees', () => {
    expect(leafCount(buildPreset('single'))).toBe(1)
    expect(leafCount(buildPreset('splitH'))).toBe(2)
    expect((buildPreset('splitH') as SplitNode).direction).toBe('h')
    expect((buildPreset('splitV') as SplitNode).direction).toBe('v')
    expect(leafCount(buildPreset('quad'))).toBe(4)
  })
  it('matchesPreset recognizes the canonical shapes, else null', () => {
    expect(matchesPreset(buildPreset('single'))).toBe('single')
    expect(matchesPreset(buildPreset('splitH'))).toBe('splitH')
    expect(matchesPreset(buildPreset('splitV'))).toBe('splitV')
    expect(matchesPreset(buildPreset('quad'))).toBe('quad')
    const custom = split('S', 'h', 0.5, split('S2', 'v', 0.5, create_empty_leaf(), create_empty_leaf()), create_empty_leaf())
    expect(matchesPreset(custom)).toBeNull() // left-2-right-1
  })
})
```

- [ ] **Step 1.16: Run, verify fail.**

- [ ] **Step 1.17: Implement `setRatio`, `escalateForImport`, `buildPreset`, `matchesPreset`** (append):

```ts
export function setRatio(root: PaneNode, splitId: string, ratio: number): PaneNode {
  const clamped = Math.max(0.2, Math.min(0.8, ratio))
  function go(node: PaneNode): PaneNode {
    if (node.kind === 'leaf') return node
    if (node.id === splitId) return { ...node, ratio: clamped }
    const a = go(node.children[0]); const b = go(node.children[1])
    if (a === node.children[0] && b === node.children[1]) return node
    return { ...node, children: [a, b] }
  }
  return go(root)
}

/**
 * Open-file target: reuse the first empty leaf; else split the active leaf
 * (one at a time) up to CAP; else null (caller opens a new tab).
 * Direction reproduces the old single->splitH (first split 'h') then 'v'.
 */
export function escalateForImport(root: PaneNode, activeLeafId: string): { root: PaneNode; leafId: string } | null {
  const empty = findFirstEmptyLeaf(root)
  if (empty) return { root, leafId: empty.id }
  const dir: SplitDir = leafCount(root) === 1 ? 'h' : 'v'
  const split = splitLeaf(root, activeLeafId, dir)
  if (!split) return null
  return { root: split.root, leafId: split.newLeafId }
}

export function buildPreset(preset: PresetId): PaneNode {
  if (preset === 'single') return create_empty_leaf()
  if (preset === 'splitH') return { kind: 'split', id: next_id('split'), direction: 'h', ratio: 0.5, children: [create_empty_leaf(), create_empty_leaf()] }
  if (preset === 'splitV') return { kind: 'split', id: next_id('split'), direction: 'v', ratio: 0.5, children: [create_empty_leaf(), create_empty_leaf()] }
  // quad = h-split of two v-splits
  const col = (): SplitNode => ({ kind: 'split', id: next_id('split'), direction: 'v', ratio: 0.5, children: [create_empty_leaf(), create_empty_leaf()] })
  return { kind: 'split', id: next_id('split'), direction: 'h', ratio: 0.5, children: [col(), col()] }
}

export function matchesPreset(root: PaneNode): PresetId | null {
  if (root.kind === 'leaf') return 'single'
  const [a, b] = root.children
  if (a.kind === 'leaf' && b.kind === 'leaf') return root.direction === 'h' ? 'splitH' : 'splitV'
  if (root.direction === 'h' && a.kind === 'split' && b.kind === 'split'
    && a.direction === 'v' && b.direction === 'v'
    && a.children.every(c => c.kind === 'leaf') && b.children.every(c => c.kind === 'leaf')) return 'quad'
  return null
}
```

- [ ] **Step 1.18: Run full pane-tree suite, verify all pass.**

Run: `pnpm vitest run tests/desktop/pane-tree.test.ts`
Expected: PASS (all describe blocks).

- [ ] **Step 1.19: Commit**

```bash
git add desktop/pane-tree.ts tests/desktop/pane-tree.test.ts
git commit -m "feat(pane-tree): setRatio, escalateForImport, buildPreset/matchesPreset"
```

---

## Task 2: `desktop/pane-utils.ts` — reshape `StructureTabState` + `create_tab_state`

**Files:**
- Modify: `desktop/pane-utils.ts:37` (remove `LayoutType`), `:60-70` (`StructureTabState`), `:74-78` (`layout_panel_count`), `:112-123` (`create_tab_state`), `:140-181` (remove grid helpers).

> ⚠️ This is the start of the build-red window.

- [ ] **Step 2.1: Verify mobile does not consume the changing exports**

Run: `grep -rn "create_tab_state\|StructureTabState\|\.panes\b\|\.active_pane\|LayoutType\|layout_panel_count\|find_import_target_pane\|get_grid_style\|get_pane_position\|get_visible_panes" src/lib/mobile`
Expected: NO output. If any hit appears, STOP and report — mobile would be affected (violates D8); the plan must gate the change instead.

- [ ] **Step 2.2: Edit `StructureTabState` (`pane-utils.ts:60-70`)**

Replace:

```ts
export interface StructureTabState {
  panes: PaneState[]
  layout: LayoutType
  active_pane: number
  close_confirm_pane: number | null
  col_split: number
  row_split: number
  library: LibraryEntry[]
  active_library_id: string | null
}
```

with:

```ts
import type { PaneNode } from './pane-tree'

export interface StructureTabState {
  root: PaneNode
  active_leaf_id: string
  close_confirm_leaf_id: string | null
  library: LibraryEntry[]
  active_library_id: string | null
}
```

(Place the `import type { PaneNode }` with the other top imports to satisfy `deno fmt`/lint ordering.)

- [ ] **Step 2.3: Rewrite `create_tab_state` (`pane-utils.ts:112-123`)**

```ts
export function create_tab_state(): StructureTabState {
  const root = create_empty_leaf()
  return {
    root,
    active_leaf_id: root.id,
    close_confirm_leaf_id: null,
    library: [],
    active_library_id: null,
  }
}
```

Add the import at top: `import { create_empty_leaf } from './pane-tree'`.

- [ ] **Step 2.4: Delete the grid-only exports**

Delete `export type LayoutType` (`:37`), `layout_panel_count` (`:74-78`), `find_import_target_pane` (`:140-157`), `get_visible_panes` (`:161-163`), `get_grid_style` (`:165-172`), `get_pane_position` (`:174-181`). KEEP `PaneState`, `LibraryEntry`, `get_pane_label`, `create_empty_pane`, `pane_has_content`, `content_to_base64`, `auto_name`, `is_chgcar_file`, `NON_STRUCTURE_EXTS`, `update_export_format`, `format_from_ext`, `serialize_structure_content`, `SampleStructure`.

- [ ] **Step 2.5: Add a quick test that `create_tab_state` starts on a single empty leaf**

Append to `tests/desktop/pane-tree.test.ts`:

```ts
import { create_tab_state } from '../../desktop/pane-utils'
describe('create_tab_state', () => {
  it('starts as one empty structure leaf, active = that leaf', () => {
    const ts = create_tab_state()
    expect(leafCount(ts.root)).toBe(1)
    expect(ts.active_leaf_id).toBe((ts.root as LeafNode).id)
    expect(isEmptyLeaf(ts.root as LeafNode)).toBe(true)
    expect(ts.close_confirm_leaf_id).toBeNull()
  })
})
```

- [ ] **Step 2.6: Run pane-tree test (the new block must pass; rest of repo will not type-check yet)**

Run: `pnpm vitest run tests/desktop/pane-tree.test.ts`
Expected: PASS. (Do not run `pnpm check` yet — consumers are mid-migration.)

- [ ] **Step 2.7: Commit (WIP — build red is expected)**

```bash
git add desktop/pane-utils.ts desktop/pane-tree.ts tests/desktop/pane-tree.test.ts
git commit -m "refactor(pane-utils): StructureTabState -> tree root (WIP: consumers migrate next)"
```

---

## Task 3: `desktop/PaneTree.svelte` — recursive renderer (reproduces pane chrome verbatim)

**Files:**
- Create: `desktop/PaneTree.svelte`

This renders one `PaneNode`. A `SplitNode` → flex container + one divider between its two recursive children. A `LeafNode` → the exact `.pane` wrapper + `.panel-header` + close-confirm banner + `.panel-content` lifted verbatim from `App.svelte:1649-1803` and CSS from `App.svelte:2417-2576`. It calls back into App for everything stateful.

> The component receives the leaf-body as a Svelte **snippet** from App (so the heavy `<Structure>`/`<Trajectory>`/`<WorkflowView>`/landing markup stays in App.svelte with all its existing imports/handlers, and PaneTree only owns the recursion + chrome). This keeps PaneTree small and avoids moving ~150 lines of viewer wiring.

- [ ] **Step 3.1: Write `PaneTree.svelte`**

```svelte
<script lang="ts">
  import type { PaneNode, LeafNode, SplitNode } from './pane-tree'
  import type { Snippet } from 'svelte'

  interface Props {
    node: PaneNode
    multi: boolean // leafCount(root) > 1 — gates per-leaf header chrome
    active_leaf_id: string
    drag_target_leaf: string | null
    close_confirm_leaf_id: string | null
    active_split_id: string | null
    leaf_body: Snippet<[LeafNode]>     // App renders the viewer/landing for a leaf
    header: Snippet<[LeafNode]>        // App renders the dot+label+popout+close buttons
    banner: Snippet<[LeafNode]>        // App renders the close-confirm banner
    on_activate: (leaf_id: string) => void
    on_split_mousedown: (e: MouseEvent, split_id: string, dir: 'h' | 'v') => void
    on_split_dblclick: (split_id: string) => void
  }
  let { node, multi, active_leaf_id, drag_target_leaf, close_confirm_leaf_id, active_split_id, leaf_body, header, banner, on_activate, on_split_mousedown, on_split_dblclick }: Props = $props()
</script>

{#if node.kind === 'split'}
  {@const s = node as SplitNode}
  <div class="split {s.direction === 'h' ? 'h' : 'v'}">
    <div class="split-child" style={s.direction === 'h' ? `flex-basis:${s.ratio * 100}%` : `flex-basis:${s.ratio * 100}%`}>
      <svelte:self node={s.children[0]} {multi} {active_leaf_id} {drag_target_leaf} {close_confirm_leaf_id} {active_split_id} {leaf_body} {header} {banner} {on_activate} {on_split_mousedown} {on_split_dblclick} />
    </div>
    <div
      class="grid-divider {s.direction === 'h' ? 'grid-divider-col' : 'grid-divider-row'}"
      class:active={active_split_id === s.id}
      onmousedown={(e) => on_split_mousedown(e, s.id, s.direction)}
      ondblclick={() => on_split_dblclick(s.id)}
      role="separator"
      aria-orientation={s.direction === 'h' ? 'vertical' : 'horizontal'}
    ></div>
    <div class="split-child" style={`flex-basis:${(1 - s.ratio) * 100}%`}>
      <svelte:self node={s.children[1]} {multi} {active_leaf_id} {drag_target_leaf} {close_confirm_leaf_id} {active_split_id} {leaf_body} {header} {banner} {on_activate} {on_split_mousedown} {on_split_dblclick} />
    </div>
  </div>
{:else}
  {@const leaf = node as LeafNode}
  <div
    class="pane"
    class:active={active_leaf_id === leaf.id}
    class:dragover={drag_target_leaf === leaf.id}
    class:warn-glow={close_confirm_leaf_id === leaf.id}
    data-leaf-id={leaf.id}
    role="button"
    tabindex="0"
    onclick={() => on_activate(leaf.id)}
    onkeydown={(e) => { if (e.key === 'Enter') on_activate(leaf.id) }}
  >
    {#if multi}
      <div class="panel-header">{@render header(leaf)}</div>
    {/if}
    {@render banner(leaf)}
    <div class="panel-content">{@render leaf_body(leaf)}</div>
  </div>
{/if}

<style>
  /* moved verbatim from App.svelte:2417-2576 (grid-container -> flex split) */
  .split { display: flex; width: 100%; height: 100%; min-width: 0; min-height: 0; }
  .split.h { flex-direction: row; }
  .split.v { flex-direction: column; }
  .split-child { position: relative; min-width: 0; min-height: 0; overflow: hidden; }
  .grid-divider { background: var(--border-color, #2a2a2a); transition: background 0.15s; z-index: 1; flex: 0 0 auto; }
  .grid-divider-col { width: 6px; cursor: col-resize; }
  .grid-divider-row { height: 6px; cursor: row-resize; }
  .grid-divider:hover, .grid-divider.active { background: var(--accent-color, #3b82f6); }
  .pane { position: relative; overflow: hidden; background: var(--pane-bg, transparent); cursor: pointer; display: flex; flex-direction: column; width: 100%; height: 100%; }
  .pane.warn-glow { box-shadow: inset 0 0 0 2px rgba(245, 158, 11, 0.5); }
  .panel-content { flex: 1; min-height: 0; position: relative; overflow: hidden; height: 0; }
  /* NOTE: .panel-header/.panel-dot/.panel-label/.panel-*-btn/.panel-close-banner/.banner-* rules
     are supplied by App.svelte's global <style> (the header/banner snippets render there);
     keep them in App.svelte. Only the split/pane/divider/content geometry moves here. */
</style>
```

> Verify against the originals while editing: `App.svelte:2417-2454` (`.grid-container`/`.grid-divider*`/`.pane`/`.panel-content`) and confirm `--border-color`/`--accent-color` var names match the originals (read the file; adjust the fallbacks to whatever the source uses).

- [ ] **Step 3.2: Type-check just this file is deferred to Task 16** (App must provide the snippets first). For now confirm the file parses:

Run: `pnpm exec svelte-check --workspace desktop --threshold error 2>&1 | head -40`
Expected: errors are limited to App.svelte (not yet migrated) and "unused"/prop-mismatch noise; `PaneTree.svelte` itself should not have syntax errors. (Full green is Task 16.)

- [ ] **Step 3.3: Commit**

```bash
git add desktop/PaneTree.svelte
git commit -m "feat(pane-tree): recursive PaneTree.svelte (flex splits + verbatim pane chrome via snippets)"
```

---

## Task 4: `App.svelte` — template swap (render `<PaneTree>`) + state renames

**Files:**
- Modify: `desktop/App.svelte` — imports `49-56`/`112-116`, state `146-148`/`189-196`, wrappers `200`/`286-287`, template `1632-2097`, CSS unchanged blocks stay.

- [ ] **Step 4.1: Fix imports (`App.svelte:49-56`)** — drop `LayoutType, layout_panel_count, find_import_target_pane, get_visible_panes, get_grid_style, get_pane_position`; add:

```ts
import PaneTree from './PaneTree.svelte'
import {
  type PaneNode, type LeafNode,
  leaves, leafCount, findLeafById, findSplit, findFirstEmptyLeaf,
  escalateForImport, removeLeaf, setRatio, matchesPreset, create_empty_leaf,
} from './pane-tree'
```

Keep `get_pane_label, create_empty_pane, pane_has_content, content_to_base64, create_tab_state, auto_name, PaneState, LibraryEntry, SampleStructure` from `./pane-utils`.

- [ ] **Step 4.2: Rename `$state` (`App.svelte:146-148`)**

```ts
let drag_target_leaf = $state<string | null>(null)
let is_panel_resizing = $state(false)
let active_split_id = $state<string | null>(null)
```

(Delete `drag_target_pane` and `resize_axis`.)

- [ ] **Step 4.3: Update `drag_deps`/`resize_deps` (`App.svelte:189-196`)** — `get/set_drag_target_pane` → operate on `drag_target_leaf` (string). Replace `resize_deps` (which set `is_panel_resizing`/`resize_axis`) — resize now flows through PaneTree callbacks (Step 4.7); keep a minimal `resize_deps` only if still referenced, else remove it and the `ResizeDeps` import at `112-116`.

- [ ] **Step 4.4: `popout_pane` wrapper (`App.svelte:200`)**

```ts
function popout_pane(tab_id: string, leaf_id: string) { return _popout_pane(tab_id, leaf_id, tab_states, is_tauri) }
```

- [ ] **Step 4.5: Replace the grid render block (`App.svelte:1632-1661`)**

Replace the `{@const visible}`/`{@const panel_count}` + `.grid-container` + `{#each visible}` opening with:

```svelte
{#if tab.type === `structure`}
  {@const ts = tab_states[tab.id]}
  {#if ts}
    <div class="structure-workspace">
      {#if ts.library.length >= 2}
        <StructureLibrary ... />  <!-- unchanged props -->
      {/if}
      <PaneTree
        node={ts.root}
        multi={leafCount(ts.root) > 1}
        active_leaf_id={ts.active_leaf_id}
        drag_target_leaf={tab.id === tm.active_tab_id ? drag_target_leaf : null}
        close_confirm_leaf_id={ts.close_confirm_leaf_id}
        {active_split_id}
        on_activate={(id) => ts.active_leaf_id = id}
        on_split_mousedown={(e, sid, dir) => start_split_resize(e, sid, dir, tab.id)}
        on_split_dblclick={(sid) => { ts.root = setRatio(ts.root, sid, 0.5) }}
        {leaf_body}
        {header}
        {banner}
      />
    </div>
  {/if}
{/if}
```

- [ ] **Step 4.6: Define the three snippets** (`leaf_body`, `header`, `banner`) inside the same `{#if ts}` scope, porting the verbatim markup from `App.svelte:1663-1803` (header buttons + close-confirm banner + viewer/landing dispatch). Each replaces `idx`/`ts.panes[idx]`/`ts.active_pane` per the contract table. Skeleton:

```svelte
{#snippet header(leaf: LeafNode)}
  {@const pane = leaf.content.pane}
  {#if pane_has_content(pane)}<span class="panel-dot"></span>{/if}
  <span class="panel-label">{get_pane_label(pane)}</span>
  {#if pane_has_content(pane)}
    <button class="panel-popout-btn" onclick={(e) => { e.stopPropagation(); popout_pane(tab.id, leaf.id) }} title={t(`app.open_in_new_window`)}>
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
    </button>
  {/if}
  <button class="panel-close-btn" onclick={(e) => { e.stopPropagation(); handle_unload(tab.id, leaf.id) }} title={t(`app.close_panel`)}>
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
  </button>
{/snippet}

{#snippet banner(leaf: LeafNode)}
  {#if ts.close_confirm_leaf_id === leaf.id}
    {@const pane = leaf.content.pane}
    <div class="panel-close-banner">
      <!-- port verbatim from App.svelte:1695-1735; ts.panes[idx] -> pane;
           close_panel(tab.id, idx) -> close_panel(tab.id, leaf.id);
           save_and_close_panel(tab.id, idx) -> (…, leaf.id);
           ts.close_confirm_pane = null -> ts.close_confirm_leaf_id = null -->
    </div>
  {/if}
{/snippet}

{#snippet leaf_body(leaf: LeafNode)}
  {@const pane = leaf.content.pane}
  {#if pane.mode === `workflow`}
    <WorkflowView ... onclose={() => { Object.assign(findLeafById(ts.root, leaf.id)!.content.pane, create_empty_pane()); update_tab_label(tab.id) }} onchange={() => { pane.modified = true }} ... />
  {:else if pane.is_trajectory_mode && pane.trajectory}
    <Trajectory bind:selected_sites={pane.selected_sites} bind:current_step_idx={pane.current_step_idx} structure_props={{ ..., is_active: ts.active_leaf_id === leaf.id && tab.id === tm.active_tab_id }} ... />
  {:else if pane.structure}
    <Structure
      tab_id={tab.id}
      is_active={ts.active_leaf_id === leaf.id && tab.id === tm.active_tab_id}
      bind:structure={pane.structure}
      bind:saveable_structure={pane.saveable_structure}
      bind:selected_sites={pane.selected_sites}
      bind:remote_origin={pane.remote_origin}
      bind:open_plugin_hub={pane.open_plugin_hub}
      on_file_load={create_on_file_load(tab.id, leaf.id)}
      on_file_drop={create_on_file_drop(tab.id, leaf.id)}
      on_clear_structure={() => { Object.assign(pane, create_empty_pane()); update_tab_label(tab.id) }}
      ... />
  {:else}
    <!-- landing page: port App.svelte:1804-2042 -->
    <!-- class:secondary-pane={leaf.id !== leaves(ts.root)[0].id};
         drop quad-layout/stacked-layout classes -> class:compact={leafCount(ts.root) > 1};
         idx===0 gates -> leaf.id === leaves(ts.root)[0].id;
         sample/builder/chat/hpc/terminal onclick: write pane.* (clone_structure!) + ts.active_leaf_id = leaf.id;
         handle_open_file(tab.id, idx) -> handle_open_file(tab.id, leaf.id);
         workflow-card: pane.mode='workflow' (NO panes=[...] needed) + update_tab_label -->
  {/if}
{/snippet}
```

> `bind:` to `pane.X` works because `pane = findLeafById(ts.root, leaf.id).content.pane` resolves the live `$state` proxy node. The old `ts.panes=[...ts.panes]` reactivity nudges are dropped — mutating the proxy's nested fields is reactive. Preserve `clone_structure()` on every structure assignment (memory: structure-must-clone-on-assign).

- [ ] **Step 4.7: Add `start_split_resize` (replaces `on_divider_mousedown`/`on_center_mousedown` wrappers at `286-287`)**

```ts
function start_split_resize(e: MouseEvent, split_id: string, dir: 'h' | 'v', tab_id: string) {
  on_split_drag(resize_deps_min, e, split_id, dir, tab_id, () => active_split_id = split_id, () => active_split_id = null)
}
```

(The actual drag math lives in `resize-handlers.ts`, Task 6.)

- [ ] **Step 4.8: Delete the divider markup block (`App.svelte:2049-2097`)** entirely (PaneTree renders dividers now).

- [ ] **Step 4.9: Fix the close-confirm count modal (`App.svelte:2224-2226`)**

```svelte
{@const structure_count = leaves(confirm_ts.root).filter(l => pane_has_content(l.content.pane)).length}
```

- [ ] **Step 4.10: Commit (WIP)**

```bash
git add desktop/App.svelte desktop/PaneTree.svelte
git commit -m "refactor(app): render PaneTree + leaf snippets; drop grid markup/dividers (WIP)"
```

---

## Task 5: `App.svelte` — logic sites (handlers, effects, injectors)

Apply these exact rewrites (from the grounding). Each `ts.panes[i]` → resolve a leaf; each `ts.active_pane` → `ts.active_leaf_id`; index params → leaf-id params.

- [ ] **Step 5.1:** `open_plugin_hub_on_active_pane` (`291-304`): `const leaf = findLeafById(ts.root, ts.active_leaf_id); if (!leaf) return; const pane = leaf.content.pane;` then keep the water-load + `pane.open_plugin_hub` bump (use `clone_structure`).
- [ ] **Step 5.2:** `open_edit_as_text` (`405-462`): capture `const target_leaf_id = ts.active_leaf_id`; in `editor_on_save` `const leaf = findLeafById(target_ts.root, target_leaf_id); if (!leaf) return;` then mutate `leaf.content.pane.*`.
- [ ] **Step 5.3:** `handle_sidebar_open_workflow` (`466-489`): `existing = leaves(ts.root).find(l => l.content.pane.mode==='workflow' && l.content.pane.workflow_id===workflow_id)` → `ts.active_leaf_id = existing.id`; else `const t = findFirstEmptyLeaf(ts.root) ?? findLeafById(ts.root, ts.active_leaf_id)!; Object.assign(t.content.pane, { ...create_empty_pane(), mode:'workflow', workflow_id, workflow_compact }); ts.active_leaf_id = t.id`. Drop `ts.panes=[...]`.
- [ ] **Step 5.4:** `pending_open_structure` `$effect` (`519-545`): `const leaf = leaves(ts.root)[0]; if (tab_id===prev_tab_id && leaf.content.pane.structure) { warn; return }` then write `leaf.content.pane.*` (clone).
- [ ] **Step 5.5:** `get_current_structure` (`547-553`): `const leaf = findLeafById(ts.root, ts.active_leaf_id); const pane = leaf?.content.pane; return pane?.structure ?? null`.
- [ ] **Step 5.6:** DELETE the auto-escalate `$effect` (`589-597`) — impossible in a tree.
- [ ] **Step 5.7:** dirty-detect `$effect` (`599-610`): `for (const ts of Object.values(tab_states)) for (const leaf of leaves(ts.root)) { const pane = leaf.content.pane; if (pane.structure && !pane.modified && pane.initial_site_count>0 && pane.structure.sites.length!==pane.initial_site_count) pane.modified = true }`.
- [ ] **Step 5.8:** `load_file_from_path` (`614-624`): `const empty = findFirstEmptyLeaf(ts.root); const leaf_id = empty ? empty.id : ts.active_leaf_id;` pass `leaf_id` to `process_file_content`.
- [ ] **Step 5.9:** `handle_open_file` (`676-706`) + `handle_open_folder` (`708-739`): signature `(tab_id, leaf_id: string)`; `ts.active_leaf_id = leaf_id`; thread `leaf_id` into `import_many`; web path stashes `file_input_target_leaf = leaf_id`.
- [ ] **Step 5.10:** rename `$state` `file_input_target_pane` → `file_input_target_leaf: string` (declaration + `handle_file_input`/`handle_folder_input` at `741-789`).
- [ ] **Step 5.11:** `handle_database_import` (`791-806`): `const leaf = findLeafById(ts.root, modal.import_target_leaf); if (!leaf) return; const pane = leaf.content.pane;` mutate (clone). Rename `modal.import_target_pane`→`modal.import_target_leaf` (and the site that sets it).
- [ ] **Step 5.12:** `apply_entry_to_pane` (`1003-1044`): signature `(tab_id, ts, leaf_id: string, e, remote_origin, local_file_path)`; `const leaf = findLeafById(ts.root, leaf_id); if (!leaf) return; const p = leaf.content.pane;` keep cube/traj/structure branches; `ts.active_leaf_id = leaf_id`. Update its 3 callers (5.13, 5.14, select_library_entry).
- [ ] **Step 5.13:** `handle_load_trajectory_stream` (`211-241`): `const r = escalateForImport(ts.root, ts.active_leaf_id); let leaf_id; if (!r) { open_tab('structure'); const nts = tm.tab_states[tm.active_tab_id]; leaf_id = nts.active_leaf_id } else { ts.root = r.root; leaf_id = r.leafId }` then `apply_entry_to_pane(tab_id, ts, leaf_id, …)`.
- [ ] **Step 5.14:** `process_file_content` (`1046-1069`): signature `(…, leaf_id: string, …)`; same `escalateForImport`-or-new-tab resolution; on new tab `return process_file_content(tm.active_tab_id, content, filename, nts.active_leaf_id, …)`.
- [ ] **Step 5.15:** `import_many` (`1077-1114`): signature `(…, leaf_id: string)`; `ts.active_leaf_id = leaf_id`; rest unchanged.
- [ ] **Step 5.16:** `select_library_entry` (`1116-1125`): `apply_entry_to_pane(tab_id, ts, ts.active_leaf_id, entry)`.
- [ ] **Step 5.17:** `remove_library_entry` (`1128-1141`): `const leaf = findLeafById(ts.root, ts.active_leaf_id); if (leaf) Object.assign(leaf.content.pane, create_empty_pane())`.
- [ ] **Step 5.18:** `create_on_file_drop` (`1151-1162`) + `create_on_file_load` (`1164-1226`): signature `(tab_id, leaf_id: string)`; `find_import_target_pane`→`escalateForImport`-or-new-tab; `new_ts.panes[0]`→`leaves(new_ts.root)[0].content.pane`; `ts.panes[target].*`→`targetLeaf.content.pane.*`; `ts.active_pane=target`→`ts.active_leaf_id=leaf.id`.
- [ ] **Step 5.19:** keyboard dep wiring (`1330`): pass `ts.active_leaf_id` (Task 10 changes the dep signature).
- [ ] **Step 5.20:** `show_lab_link` (`1341-1350`): `const first = leaves(ts.root)[0]; return !!first && !pane_has_content(first.content.pane)`.
- [ ] **Step 5.21:** SSE injectors (`1369-1379`, `1427-1428`, `1501-1514`): `const first = leaves(ts.root)[0]; if (!first) return false; first.content.pane.structure = clone_structure(struct); …`. Guards `ts.panes?.[0]` → `!!leaves(ts.root)[0]`.
- [ ] **Step 5.22:** `on_save_workflow` Sidebar prop (`1608-1611`): `const leaf = findLeafById(ts.root, ts.active_leaf_id); const pane = leaf?.content.pane; return pane?.mode==='workflow' ? (pane.workflow_id ?? null) : null`.

- [ ] **Step 5.23: Commit (WIP)**

```bash
git add desktop/App.svelte
git commit -m "refactor(app): migrate pane logic/effects/injectors to leaf ids (WIP)"
```

---

## Task 6: `desktop/lib/resize-handlers.ts` — per-split ratio

**Files:** Modify `desktop/lib/resize-handlers.ts` (whole file, 67 lines).

- [ ] **Step 6.1:** Replace `ResizeDeps` and the two handlers with a single split-aware drag:

```ts
import type { StructureTabState } from '../pane-utils'
import { findSplit, setRatio } from '../pane-tree'

export interface ResizeDepsMin {
  tab_states: Record<string, StructureTabState>
  set_is_panel_resizing: (v: boolean) => void
}

export function on_split_drag(
  deps: ResizeDepsMin, e: MouseEvent, split_id: string, dir: 'h' | 'v', tab_id: string,
  on_start: () => void, on_end: () => void,
) {
  const ts = deps.tab_states[tab_id]
  if (!ts) return
  const node = findSplit(ts.root, split_id)
  if (!node) return
  const container = (e.target as HTMLElement).parentElement // the .split flex container
  if (!container) return
  e.preventDefault()
  deps.set_is_panel_resizing(true)
  on_start()
  const start = dir === 'h' ? e.clientX : e.clientY
  const start_ratio = node.ratio
  function on_move(ev: MouseEvent) {
    const rect = container!.getBoundingClientRect()
    const total = dir === 'h' ? rect.width : rect.height
    const delta = ((dir === 'h' ? ev.clientX : ev.clientY) - start) / total
    ts!.root = setRatio(ts!.root, split_id, start_ratio + delta)
  }
  function on_up() {
    window.removeEventListener('mousemove', on_move)
    window.removeEventListener('mouseup', on_up)
    deps.set_is_panel_resizing(false)
    on_end()
  }
  window.addEventListener('mousemove', on_move)
  window.addEventListener('mouseup', on_up)
}
```

(`setRatio` already clamps 0.2..0.8. The quad center handle / `on_center_mousedown` is dropped — spec §6.5.)

- [ ] **Step 6.2:** In App (`Step 4.7`) wire `start_split_resize` to call `on_split_drag` with a `resize_deps_min = { tab_states, set_is_panel_resizing: (v) => is_panel_resizing = v }`.

- [ ] **Step 6.3: Commit (WIP)**

```bash
git add desktop/lib/resize-handlers.ts desktop/App.svelte
git commit -m "refactor(resize): per-SplitNode ratio drag (drop quad center handle)"
```

---

## Task 7: `desktop/lib/pane-manager.ts` — close lifecycle via `removeLeaf`

**Files:** Modify `desktop/lib/pane-manager.ts`.

- [ ] **Step 7.1:** Imports: from `../pane-utils` drop `LayoutType` + `layout_panel_count` (keep `create_empty_pane`, `pane_has_content`); add `import { leafCount, leaves, removeLeaf, findLeafById } from '../pane-tree'`.
- [ ] **Step 7.2:** `handle_unload(deps, tab_id, leaf_id: string)` (`21-43`): `const leaf = findLeafById(ts.root, leaf_id); if (!leaf) return; const pane = leaf.content.pane;` workflow-unsaved or content → `ts.close_confirm_leaf_id = leaf_id; return`; else `close_panel(deps, tab_id, leaf_id)`.
- [ ] **Step 7.3:** `close_panel(deps, tab_id, leaf_id: string)` (`45-84`): replace whole body:

```ts
const ts = deps.tab_states[tab_id]
if (!ts) return
ts.close_confirm_leaf_id = null
if (leafCount(ts.root) <= 1) {
  const leaf = findLeafById(ts.root, leaf_id)
  if (leaf) Object.assign(leaf.content.pane, create_empty_pane())
  deps.update_tab_label(tab_id)
  return
}
ts.root = removeLeaf(ts.root, leaf_id)
if (!findLeafById(ts.root, ts.active_leaf_id)) ts.active_leaf_id = leaves(ts.root)[0].id
deps.update_tab_label(tab_id)
```

- [ ] **Step 7.4:** `save_and_close_panel(deps, tab_id, leaf_id: string)` (`101-…`): `const leaf = findLeafById(ts.root, leaf_id); const pane = leaf?.content.pane; if (!pane) return;` forward `leaf_id` to both `close_panel` calls; `exp.close_after = { tab_id, leaf_id }`; `ts.close_confirm_leaf_id = null`.
- [ ] **Step 7.5:** `init_close_save_target` unchanged (takes a `PaneState`); caller passes the resolved `pane`.

- [ ] **Step 7.6: Commit (WIP)**

```bash
git add desktop/lib/pane-manager.ts
git commit -m "refactor(pane-manager): close/unload via removeLeaf + close_confirm_leaf_id"
```

---

## Task 8: `desktop/lib/tab-manager.svelte.ts`

**Files:** Modify `desktop/lib/tab-manager.svelte.ts`.

- [ ] **Step 8.1:** Imports: drop `LayoutType`, `layout_panel_count`; add `import { leaves, matchesPreset, type PresetId } from '../pane-tree'` (and `create_empty_leaf` if used for resets — but resets reuse `create_tab_state().root`).
- [ ] **Step 8.2:** `tabs_with_badges` (`46-56`): `const badge = leaves(ts.root).filter(l => pane_has_content(l.content.pane)).length`.
- [ ] **Step 8.3:** `active_layout` (`58-63`): `return matchesPreset(ts.root)` (returns `PresetId | null`).
- [ ] **Step 8.4:** `pending_layout_change` (`66`) + setter (`259-260`): retype `new_layout: LayoutType` → `new_layout: PresetId`.
- [ ] **Step 8.5:** Extract `function reset_ts_to_empty(ts, tab) { const r = create_tab_state(); ts.root = r.root; ts.active_leaf_id = r.active_leaf_id; ts.close_confirm_leaf_id = null; ts.library = []; ts.active_library_id = null; tab.label = 'Structure' }`. Use it in both `request_close_tab` (`139-146`) and `close_tab` (`164-172`) reset branches; for the loaded-count guard use `leaves(ts.root).filter(l => pane_has_content(l.content.pane)).length`.
- [ ] **Step 8.6:** `update_tab_label` (`208-233`): `const pane = leaves(ts.root).map(l => l.content.pane).find(p => p.structure)`; workflow check `leaves(ts.root).some(l => l.content.pane.mode==='workflow')`.
- [ ] **Step 8.7:** Update the `tab_states` doc comment (`251-253`) example to `ts.root` / `findLeafById(...).content.pane`.

- [ ] **Step 8.8: Commit (WIP)**

```bash
git add desktop/lib/tab-manager.svelte.ts
git commit -m "refactor(tab-manager): badges/active_layout/reset/label over tree"
```

---

## Task 9: `desktop/lib/layout-manager.ts` — preset applier

**Files:** Modify `desktop/lib/layout-manager.ts`.

- [ ] **Step 9.1:** Imports: drop `LayoutType`, `layout_panel_count`; add `import { buildPreset, leaves, matchesPreset, type PresetId } from '../pane-tree'`.
- [ ] **Step 9.2:** `handle_layout_change(deps, preset: PresetId)`: early-return if `matchesPreset(ts.root) === preset`; compute `filled = leaves(ts.root).map(l => l.content.pane).filter(pane_has_content)` and target leaf count from the preset (single=1,splitH/V=2,quad=4). If `filled.length > target` → `deps.set_pending_layout_change({ tab_id, new_layout: preset, lost_count: filled.length - target }); return`. Else apply (Step 9.4).
- [ ] **Step 9.3:** `confirm_layout_change`: read `preset` from pending; apply with truncation.
- [ ] **Step 9.4:** Apply helper:

```ts
function apply_preset(ts, preset: PresetId, filled: PaneState[]) {
  const root = buildPreset(preset)
  const slots = leaves(root)
  for (let i = 0; i < slots.length && i < filled.length; i++) slots[i].content.pane = filled[i]
  ts.root = root
  ts.active_leaf_id = slots[0].id
  ts.close_confirm_leaf_id = null
}
```

(Drops `col_split/row_split=50` — ratios default 0.5 in `buildPreset`. `active_pane` clamp → `active_leaf_id = slots[0].id`.)

- [ ] **Step 9.5: Commit (WIP)**

```bash
git add desktop/lib/layout-manager.ts
git commit -m "refactor(layout-manager): preset apply via buildPreset over tree"
```

---

## Task 10: `desktop/lib/keyboard-shortcuts.ts`

**Files:** Modify `desktop/lib/keyboard-shortcuts.ts`.

- [ ] **Step 10.1:** Imports: drop `LayoutType`, `layout_panel_count`; add `import { leafCount, leaves } from '../pane-tree'`.
- [ ] **Step 10.2:** `KeyboardShortcutDeps` (`18-24`): `handle_open_file`/`handle_unload` second param `pane_idx: number` → `leaf_id: string`; retype `get_pending_layout_change.new_layout` to `PresetId` (or delete if layout-manager keeps confirm).
- [ ] **Step 10.3:** Ctrl+O (`72-75`): `deps.handle_open_file(active_tab_id, ts.active_leaf_id)`.
- [ ] **Step 10.4:** Ctrl+W (`76-84`): `if (leafCount(ts.root) > 1) deps.handle_unload(active_tab_id, ts.active_leaf_id) else deps.request_close_tab(active_tab_id)`.
- [ ] **Step 10.5:** Escape (`85-98`): `if (ts.close_confirm_leaf_id !== null) { ts.close_confirm_leaf_id = null; return }`.
- [ ] **Step 10.6:** Digit 1-4 (`103-108`): `const ids = leaves(ts.root).map(l => l.id); if (idx < ids.length) ts.active_leaf_id = ids[idx]`.

- [ ] **Step 10.7: Commit (WIP)**

```bash
git add desktop/lib/keyboard-shortcuts.ts
git commit -m "refactor(keyboard): leaf-id active + leafCount/leaves"
```

---

## Task 11: `desktop/lib/popout-manager.ts`

**Files:** Modify `desktop/lib/popout-manager.ts`.

- [ ] **Step 11.1:** Add `import { findLeafById, leaves } from '../pane-tree'`.
- [ ] **Step 11.2:** `load_popout_structure` (`72-78`): `const leaf = findLeafById(ts.root, ts.active_leaf_id) ?? leaves(ts.root)[0]; if (!leaf) return; const pane = leaf.content.pane; pane.structure = structure; pane.source_filename = filename; pane.modified = false; update_tab_label(active_tab_id)`.
- [ ] **Step 11.3:** `popout_pane(tab_id, leaf_id: string, tab_states, is_tauri)` (`85-94`): `const leaf = findLeafById(ts.root, leaf_id); if (!leaf) return; const pane = leaf.content.pane;` rest unchanged.

- [ ] **Step 11.4: Commit (WIP)**

```bash
git add desktop/lib/popout-manager.ts
git commit -m "refactor(popout): resolve leaf by id"
```

---

## Task 12: `desktop/lib/drag-drop-handlers.ts`

**Files:** Modify `desktop/lib/drag-drop-handlers.ts`.

- [ ] **Step 12.1:** `DragDropDeps`: `process_file_content`/`import_many` 4th/3rd param → `leaf_id: string`; `get/set_drag_target_pane` → `string | null`.
- [ ] **Step 12.2:** Add `import { findFirstEmptyLeaf } from '../pane-tree'`.
- [ ] **Step 12.3:** `get_pane_from_event` (`63-71`) → returns `string`:

```ts
export function get_pane_from_event(deps: DragDropDeps, event: DragEvent): string {
  const ts = deps.get_active_ts()
  if (!ts) return ''
  const el = (event.target as HTMLElement).closest('[data-leaf-id]')
  if (el) return el.getAttribute('data-leaf-id') || ts.active_leaf_id
  return findFirstEmptyLeaf(ts.root)?.id ?? ts.active_leaf_id
}
```

- [ ] **Step 12.4:** `handle_dragover` (`90-99`): types propagate (no logic change).
- [ ] **Step 12.5:** `handle_drop` (`105-138`, `168-179`): rename `pane_idx`→`target_leaf_id`; `ts.active_pane = pane_idx` → `ts.active_leaf_id = target_leaf_id` (all 4 sites); pass `target_leaf_id` to `process_file_content`/`import_many`.

- [ ] **Step 12.6: Commit (WIP)**

```bash
git add desktop/lib/drag-drop-handlers.ts
git commit -m "refactor(drag-drop): leaf-id targets + [data-leaf-id]"
```

---

## Task 13: `desktop/lib/close-all-helper.ts` + `CloseAllEntry`

**Files:** Modify `desktop/lib/close-all-helper.ts`, `desktop/state/modal-state.svelte` (CloseAllEntry).

- [ ] **Step 13.1:** `CloseAllEntry` in `modal-state.svelte`: `pane_idx: number` → `leaf_id: string`.
- [ ] **Step 13.2:** Imports: drop `layout_panel_count`; add `import { leaves } from '../pane-tree'`.
- [ ] **Step 13.3:** `build_close_all_entries` (`30-32`): `for (const leaf of leaves(ts.root)) { const pane = leaf.content.pane; if (!pane_has_content(pane)) continue; … entries.push({ …, leaf_id: leaf.id, … }) }`.
- [ ] **Step 13.4:** `execute_close_all_saves` (`68-73`): `const leaf = leaves(ts.root).find(l => l.id === entry.leaf_id); const pane = leaf?.content.pane; if (!pane) continue`.
- [ ] **Step 13.5:** reset-to-empty (`108-120`): `const r = create_tab_state(); ts.root = r.root; ts.active_leaf_id = r.active_leaf_id; ts.close_confirm_leaf_id = null` (drop layout/active_pane/col_split/row_split). Import `create_tab_state` from `../pane-utils`.
- [ ] **Step 13.6:** Update the close-all dialog UI that reads `entry.pane_idx` → `entry.leaf_id` (grep for `pane_idx` in `desktop/components/`).

- [ ] **Step 13.7: Commit (WIP)**

```bash
git add desktop/lib/close-all-helper.ts desktop/state/modal-state.svelte desktop/components
git commit -m "refactor(close-all): CloseAllEntry.leaf_id + leaves iteration"
```

---

## Task 14: `export-handlers.ts` + `export-state` + `modal-state` field renames

**Files:** Modify `desktop/lib/export-handlers.ts`, `desktop/state/export-state.svelte.ts`, `desktop/state/modal-state.svelte`.

- [ ] **Step 14.1:** `export-state.svelte.ts`: `close_after` type `{ tab_id; pane_idx: number }` → `{ tab_id; leaf_id: string }`.
- [ ] **Step 14.2:** `export-handlers.ts`: `ExportHandlerDeps.close_panel` param `pane_idx: number` → `leaf_id: string`; the deferred-close call (`85-89`) `deps.close_panel(exp.close_after.tab_id, exp.close_after.leaf_id)`.
- [ ] **Step 14.3:** `modal-state.svelte`: `import_target_pane: number` → `import_target_leaf: string` (and any other UI reading it — grep `import_target_pane`).

- [ ] **Step 14.4: Commit (WIP)**

```bash
git add desktop/lib/export-handlers.ts desktop/state/export-state.svelte.ts desktop/state/modal-state.svelte
git commit -m "refactor(export/modal-state): close_after.leaf_id + import_target_leaf"
```

---

## Task 15: `desktop/lib/sidebar-handlers.ts`

**Files:** Modify `desktop/lib/sidebar-handlers.ts`.

- [ ] **Step 15.1:** `process_file_content` dep (`18`): 4th param → `leaf_id: string`.
- [ ] **Step 15.2:** Add `import { findFirstEmptyLeaf } from '../pane-tree'`.
- [ ] **Step 15.3:** Both selection blocks (`34-41`, `79-83`): `const empty = findFirstEmptyLeaf(ts.root); const target = empty ? empty.id : ts.active_leaf_id;` pass `target` (string). Keep the terminal-tab early-returns. (Preserve the no-split fallback semantics — these handlers don't auto-split.)

- [ ] **Step 15.4: Commit (WIP)**

```bash
git add desktop/lib/sidebar-handlers.ts
git commit -m "refactor(sidebar-handlers): findFirstEmptyLeaf target"
```

---

## Task 16: Verification gate + mobile safety + manual smoke (build goes GREEN)

**Files:** none (verification + any residual fixes).

- [ ] **Step 16.1:** Resolve all remaining type errors:

Run: `pnpm check 2>&1 | tail -60`
Expected: 0 errors. Fix any stragglers (grep the repo for leftover `\.panes\b`, `\.active_pane`, `\.col_split`, `\.row_split`, `close_confirm_pane`, `layout_panel_count`, `get_grid_style`, `get_pane_position`, `get_visible_panes`, `find_import_target_pane`, `[data-pane]`, `LayoutType` — all must be gone from `desktop/`).

Run: `grep -rn "\.panes\b\|active_pane\|col_split\|row_split\|close_confirm_pane\|layout_panel_count\|get_grid_style\|get_pane_position\|get_visible_panes\|find_import_target_pane\|data-pane\b\|LayoutType" desktop`
Expected: NO output.

- [ ] **Step 16.2:** Unit tests:

Run: `pnpm test`
Expected: PASS, including `tests/desktop/pane-tree.test.ts`; no regressions vs the pre-refactor count.

- [ ] **Step 16.3:** Mobile safety:

Run: `git diff --name-only main...HEAD -- src/lib/mobile`
Expected: NO output (zero mobile files touched — spec D8).

Run: `pnpm check 2>&1 | grep -i mobile`
Expected: NO new mobile errors.

- [ ] **Step 16.4:** Manual smoke (desktop dev — `pnpm desktop:serve`, open http://127.0.0.1:3100/). Confirm each:
  - Open one structure → single pane fills (landing → viewer).
  - Open a 2nd file → splits left|right (splitH); 3rd → 3 leaves (left-1 / right-2, NO empty cell — §6.5); 4th → 4 leaves; 5th → new tab.
  - Drag a divider → that split resizes; double-click → resets 50/50; independent quad dividers (§6.5) move separately.
  - Click a pane → active highlight; digit keys 1-4 select leaves; close (X) on a pane → collapses, sibling fills; close last → returns to landing (tab survives).
  - Pane popout button → opens a draggable window with that structure.
  - Layout preset buttons (single/splitH/splitV/quad) still switch and highlight (`matchesPreset`).
  - Tab badge shows populated-leaf count on inactive tabs.
  - 3D canvas resizes correctly on split/resize (no zero-size/blank canvas) — the cross-tab `is_active` guard still holds (exactly one viewer active).

- [ ] **Step 16.5:** Final review + commit:

Run: `git diff --stat main...HEAD`

```bash
git add -A
git commit -m "refactor(pane-tree): green — unified recursive pane tree replaces quad grid (subproject 1)"
```

---

## Self-review notes (author)

- **Spec coverage:** model (§4) → Task 1; `StructureTabState` reshape (§6.1) → Task 2; recursive render + verbatim chrome (§5) → Tasks 3–4; parity checklist (§6.2: open-file escalation, popout, badge, close-collapse, divider, is_active, layout toggle, keyboard) → Tasks 5/7/8/9/10/12; two visible deltas (§6.5) → escalation in Task 1/5, independent dividers in Tasks 3/6 (center handle dropped); mobile (§3 D8) → Steps 2.1 + 16.3.
- **`PaneState` unchanged** — only its container changes; all `pane.*` field names preserved.
- **`clone_structure` on every structure assignment** preserved (memory: structure-must-clone-on-assign).
- **`is_active` exactly-one-active invariant** preserved via `ts.active_leaf_id === leaf.id && tab.id === tm.active_tab_id` (memory: cross-tab bleed guard).
- **Reactivity:** structural ops reassign `ts.root` (new object); leaf content edits mutate the live `$state` proxy node (`findLeafById(...).content.pane.X = …`), matching the existing deep-mutation pattern; old `ts.panes=[...]` nudges dropped.
- **Build-red window** (Tasks 2–15) is inherent to an atomic model swap; `pane-tree.test.ts` stays green throughout; full green at Task 16.

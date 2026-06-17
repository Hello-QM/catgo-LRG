# Pane-Tree Flat Keyed Render Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make pane splits / layout changes stop remounting leaf content, so a split no longer restarts the terminal (or resets 3D viewers).

**Architecture:** Replace `PaneTree.svelte`'s recursive `<svelte:self>` with one flat, `leaf.id`-keyed list of absolutely-positioned slots whose rects are computed from the tree by a pure `compute_pane_layout`. Keyed slots keep the same component instance across restructures — only the CSS rect changes — so no unmount → no `pty_session.kill()` → no restart.

**Tech Stack:** SvelteKit 2 / Svelte 5 runes, TypeScript, vitest. Style by hand: single quotes, **no semicolons**, 2-space indent. **Never run `deno fmt`.**

**Spec:** `docs/superpowers/specs/2026-06-16-pane-tree-flat-keyed-render-design.md`

**Confirmed current code (do not re-derive):**
- `PaneTree.svelte` props today: `node: PaneNode | undefined` + `multi, active_leaf_id, drag_target_leaf, close_confirm_leaf_id, active_split_id, maximized_leaf_id, leaf_body, terminal_body, header, banner, on_activate, on_split_mousedown(e,split_id,dir), on_split_dblclick(split_id)`.
- App renders it (App.svelte ~1854): `<PaneTree node={ts.root} {multi} {active_leaf_id} ... maximized_leaf_id={ts.maximized_leaf_id} {active_split_id} ... on_split_mousedown={(e, sid, dir) => start_split_resize(e, sid, dir, tab.id)} on_split_dblclick={...} />`.
- `pane-tree.ts` types: `LeafNode = { kind:'leaf', id, content }`, `SplitNode = { kind:'split', id, direction:'h'|'v', ratio, children:[PaneNode,PaneNode] }`, `PaneNode = SplitNode|LeafNode`.
- `pane-utils.ts` exports `create_empty_pane()` (a valid `PaneState`).
- `resize-handlers.ts` `on_split_drag` converts px delta → ratio using `(e.target).parentElement` as the container and `setRatio(ts.root, split_id, start_ratio + delta)`.

---

## Task 1: Pure layout function (`pane-layout.ts`)

**Files:**
- Create: `desktop/pane-layout.ts`
- Test: `tests/vitest/pane-layout.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/vitest/pane-layout.test.ts
import { describe, it, expect } from 'vitest'
import { compute_pane_layout } from '../../desktop/pane-layout'
import type { LeafNode, SplitNode, PaneNode } from '../../desktop/pane-tree'
import { create_empty_pane } from '../../desktop/pane-utils'

function leaf(id: string): LeafNode {
  return { kind: 'leaf', id, content: { type: 'structure', pane: create_empty_pane() } }
}
function split(id: string, direction: 'h' | 'v', ratio: number, a: PaneNode, b: PaneNode): SplitNode {
  return { kind: 'split', id, direction, ratio, children: [a, b] }
}
function box(layout: ReturnType<typeof compute_pane_layout>, id: string) {
  return layout.leaves.find((l) => l.leaf.id === id)?.rect
}

describe('compute_pane_layout', () => {
  it('single leaf fills the whole area, no dividers', () => {
    const l = compute_pane_layout(leaf('a'), null)
    expect(box(l, 'a')).toEqual({ x: 0, y: 0, w: 100, h: 100 })
    expect(l.dividers).toEqual([])
  })

  it('splitH at 0.5 → side-by-side halves + one vertical divider with span 100', () => {
    const l = compute_pane_layout(split('s', 'h', 0.5, leaf('a'), leaf('b')), null)
    expect(box(l, 'a')).toEqual({ x: 0, y: 0, w: 50, h: 100 })
    expect(box(l, 'b')).toEqual({ x: 50, y: 0, w: 50, h: 100 })
    expect(l.dividers).toEqual([{ split_id: 's', dir: 'h', rect: { x: 50, y: 0, w: 0, h: 100 }, span: 100 }])
  })

  it('splitV at 0.5 → stacked halves + one horizontal divider', () => {
    const l = compute_pane_layout(split('s', 'v', 0.5, leaf('a'), leaf('b')), null)
    expect(box(l, 'a')).toEqual({ x: 0, y: 0, w: 100, h: 50 })
    expect(box(l, 'b')).toEqual({ x: 0, y: 50, w: 100, h: 50 })
    expect(l.dividers).toEqual([{ split_id: 's', dir: 'v', rect: { x: 0, y: 50, w: 100, h: 0 }, span: 100 }])
  })

  it('asymmetric splitH respects the ratio', () => {
    const l = compute_pane_layout(split('s', 'h', 0.3, leaf('a'), leaf('b')), null)
    expect(box(l, 'a')).toEqual({ x: 0, y: 0, w: 30, h: 100 })
    expect(box(l, 'b')).toEqual({ x: 30, y: 0, w: 70, h: 100 })
  })

  it('quad (h-split of two v-splits) → 4 quadrants + 3 dividers', () => {
    const col0 = split('c0', 'v', 0.5, leaf('a'), leaf('b'))
    const col1 = split('c1', 'v', 0.5, leaf('c'), leaf('d'))
    const l = compute_pane_layout(split('root', 'h', 0.5, col0, col1), null)
    expect(box(l, 'a')).toEqual({ x: 0, y: 0, w: 50, h: 50 })
    expect(box(l, 'b')).toEqual({ x: 0, y: 50, w: 50, h: 50 })
    expect(box(l, 'c')).toEqual({ x: 50, y: 0, w: 50, h: 50 })
    expect(box(l, 'd')).toEqual({ x: 50, y: 50, w: 50, h: 50 })
    expect(l.dividers).toContainEqual({ split_id: 'root', dir: 'h', rect: { x: 50, y: 0, w: 0, h: 100 }, span: 100 })
    expect(l.dividers).toContainEqual({ split_id: 'c0', dir: 'v', rect: { x: 0, y: 50, w: 50, h: 0 }, span: 50 })
    expect(l.dividers).toContainEqual({ split_id: 'c1', dir: 'v', rect: { x: 50, y: 50, w: 50, h: 0 }, span: 50 })
    expect(l.dividers).toHaveLength(3)
  })

  it('maximize → maximized leaf fills, sibling collapses to 0, no dividers', () => {
    const l = compute_pane_layout(split('s', 'h', 0.5, leaf('a'), leaf('b')), 'a')
    expect(box(l, 'a')).toEqual({ x: 0, y: 0, w: 100, h: 100 })
    expect(box(l, 'b')).toEqual({ x: 0, y: 0, w: 0, h: 0 })
    expect(l.dividers).toEqual([])
  })

  it('undefined root → empty layout', () => {
    expect(compute_pane_layout(undefined, null)).toEqual({ leaves: [], dividers: [] })
  })
})
```

- [ ] **Step 2: Run it, confirm FAIL** — `pnpm vitest run tests/vitest/pane-layout.test.ts` (module not found).

- [ ] **Step 3: Implement `desktop/pane-layout.ts`** exactly:

```ts
/**
 * Pure geometry for the flat pane renderer: turns the pane tree into a flat list
 * of absolutely-positioned leaf boxes + divider boxes (all in % of the
 * container). No DOM. Lets PaneTree render leaves as one keyed list so they
 * never remount when the tree restructures.
 */
import type { PaneNode } from './pane-tree'
import type { LeafNode } from './pane-tree'

export interface Rect { x: number; y: number; w: number; h: number }
export interface LeafBox { leaf: LeafNode; rect: Rect }
/** `span` = the split's own extent (%) along the drag axis (width for 'h',
 *  height for 'v') — the resize handler needs it to convert px → ratio. */
export interface DividerBox { split_id: string; dir: 'h' | 'v'; rect: Rect; span: number }
export interface PaneLayout { leaves: LeafBox[]; dividers: DividerBox[] }

function leaf_ids(node: PaneNode | undefined): string[] {
  if (!node) return []
  if (node.kind === 'leaf') return [node.id]
  if (!node.children) return []
  return [...leaf_ids(node.children[0]), ...leaf_ids(node.children[1])]
}

export function compute_pane_layout(
  root: PaneNode | undefined,
  maximized_leaf_id: string | null,
): PaneLayout {
  const leaves: LeafBox[] = []
  const dividers: DividerBox[] = []

  function walk(node: PaneNode | undefined, rect: Rect): void {
    if (!node) return
    if (node.kind === 'leaf') {
      leaves.push({ leaf: node, rect })
      return
    }
    if (!node.children) return
    const [c0, c1] = node.children
    if (maximized_leaf_id) {
      // The child subtree holding the maximized leaf takes the full rect; the
      // other collapses to zero size but its leaves stay mounted (keep-warm).
      const zero = { ...rect, w: 0, h: 0 }
      if (leaf_ids(c0).includes(maximized_leaf_id)) { walk(c0, rect); walk(c1, zero) }
      else if (leaf_ids(c1).includes(maximized_leaf_id)) { walk(c0, zero); walk(c1, rect) }
      else { walk(c0, zero); walk(c1, zero) }
      return
    }
    if (node.direction === 'h') {
      const w0 = rect.w * node.ratio
      walk(c0, { x: rect.x, y: rect.y, w: w0, h: rect.h })
      walk(c1, { x: rect.x + w0, y: rect.y, w: rect.w - w0, h: rect.h })
      dividers.push({ split_id: node.id, dir: 'h', rect: { x: rect.x + w0, y: rect.y, w: 0, h: rect.h }, span: rect.w })
    } else {
      const h0 = rect.h * node.ratio
      walk(c0, { x: rect.x, y: rect.y, w: rect.w, h: h0 })
      walk(c1, { x: rect.x, y: rect.y + h0, w: rect.w, h: rect.h - h0 })
      dividers.push({ split_id: node.id, dir: 'v', rect: { x: rect.x, y: rect.y + h0, w: rect.w, h: 0 }, span: rect.h })
    }
  }

  walk(root, { x: 0, y: 0, w: 100, h: 100 })
  return { leaves, dividers }
}
```

- [ ] **Step 4: Run it, confirm PASS** — `pnpm vitest run tests/vitest/pane-layout.test.ts` (7 passed). Fix the implementation (not the tests) if any fail.

- [ ] **Step 5: Commit**

```bash
git add desktop/pane-layout.ts tests/vitest/pane-layout.test.ts
git commit -m "feat(pane-tree): pure compute_pane_layout for flat keyed render"
```

---

## Task 2: Flat-render `PaneTree.svelte` + App prop rename

**Files:**
- Modify (rewrite): `desktop/PaneTree.svelte`
- Modify: `desktop/App.svelte` (the `<PaneTree node={ts.root} ...>` call site → `root={ts.root}`)

These change together (the prop rename is a compile gate). Acceptance = `pnpm check` 0 errors.

- [ ] **Step 1: Rewrite `desktop/PaneTree.svelte`** to exactly this:

```svelte
<script lang="ts">
  import type { PaneNode, LeafNode } from './pane-tree'
  import { compute_pane_layout } from './pane-layout'
  import type { Snippet } from 'svelte'

  interface Props {
    root: PaneNode | undefined
    multi: boolean // leafCount(root) > 1 — gates per-leaf header chrome
    active_leaf_id: string
    drag_target_leaf: string | null
    close_confirm_leaf_id: string | null
    active_split_id: string | null
    maximized_leaf_id: string | null
    leaf_body: Snippet<[LeafNode]>
    terminal_body: Snippet<[LeafNode]>
    header: Snippet<[LeafNode]>
    banner: Snippet<[LeafNode]>
    on_activate: (leaf_id: string) => void
    on_split_mousedown: (e: MouseEvent, split_id: string, dir: 'h' | 'v') => void
    on_split_dblclick: (split_id: string) => void
  }
  let { root, multi, active_leaf_id, drag_target_leaf, close_confirm_leaf_id, active_split_id, maximized_leaf_id, leaf_body, terminal_body, header, banner, on_activate, on_split_mousedown, on_split_dblclick }: Props = $props()

  let layout = $derived(compute_pane_layout(root, maximized_leaf_id))
</script>

<div class="pane-tree-root">
  {#each layout.leaves as { leaf, rect } (leaf.id)}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div
      class="pane"
      class:active={active_leaf_id === leaf.id}
      class:dragover={drag_target_leaf === leaf.id}
      class:warn-glow={close_confirm_leaf_id === leaf.id}
      class:maximized-hidden={!!maximized_leaf_id && rect.w === 0}
      data-leaf-id={leaf.id}
      style={`left:${rect.x}%; top:${rect.y}%; width:${rect.w}%; height:${rect.h}%`}
      role="button"
      tabindex="0"
      onclick={() => on_activate(leaf.id)}
      onkeydown={(e) => { if (e.key === 'Enter') on_activate(leaf.id) }}
    >
      {#if multi || leaf.content.type === 'terminal'}
        <!-- A lone terminal leaf still needs its header (Directory Sync / popout /
             close); a lone structure leaf has its own in-viewer toolbar instead. -->
        <div class="panel-header">{@render header(leaf)}</div>
      {/if}
      {@render banner(leaf)}
      <div class="panel-content">
        {#if leaf.content.type === 'terminal'}
          {@render terminal_body(leaf)}
        {:else}
          {@render leaf_body(leaf)}
        {/if}
      </div>
    </div>
  {/each}

  {#if !maximized_leaf_id}
    {#each layout.dividers as d (d.split_id)}
      <div
        class="grid-divider {d.dir === 'h' ? 'grid-divider-col' : 'grid-divider-row'}"
        class:active={active_split_id === d.split_id}
        data-split-span={d.span}
        style={`left:${d.rect.x}%; top:${d.rect.y}%; ${d.dir === 'h' ? `height:${d.rect.h}%` : `width:${d.rect.w}%`}`}
        onmousedown={(e) => on_split_mousedown(e, d.split_id, d.dir)}
        ondblclick={() => on_split_dblclick(d.split_id)}
        role="separator"
        aria-orientation={d.dir === 'h' ? 'vertical' : 'horizontal'}
      ></div>
    {/each}
  {/if}
</div>

<style>
  .pane-tree-root { position: relative; width: 100%; height: 100%; min-width: 0; min-height: 0; overflow: hidden; }

  /* Absolutely-positioned leaf slots (left/top/width/height set inline as %).
     Keyed by leaf.id in the {#each}, so they never remount on restructure. */
  .pane { position: absolute; overflow: hidden; background: var(--surface-bg, var(--page-bg)); cursor: pointer; display: flex; flex-direction: column; }
  .pane.warn-glow { box-shadow: inset 0 0 0 2px rgba(245, 158, 11, 0.5); }
  /* Keep-warm while maximized: hide but stay mounted (NOT display:none). */
  .pane.maximized-hidden { visibility: hidden; pointer-events: none; }

  .pane:hover :global(.panel-popout-btn),
  .pane:hover :global(.panel-maximize-btn),
  .pane:hover :global(.panel-close-btn),
  .pane:hover :global(.panel-type-btn) { opacity: 1; }
  .pane.dragover::after {
    content: '';
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 100000005;
    box-shadow: inset 0 0 0 3px #22c55e;
  }
  .pane.dragover :global(.import-card.add-own-card) {
    border-color: #22c55e;
    background: rgba(34, 197, 94, 0.15);
    color: #22c55e;
  }
  .pane.dragover :global(.import-card.add-own-card .import-title) { color: #22c55e; }

  /* Absolutely-positioned dividers, centered on the split seam via negative margin. */
  .grid-divider { position: absolute; background: var(--border-color, rgba(128, 128, 128, 0.2)); transition: background 0.15s; z-index: 2; }
  .grid-divider-col { width: 6px; margin-left: -3px; cursor: col-resize; }
  .grid-divider-row { height: 6px; margin-top: -3px; cursor: row-resize; }
  .grid-divider:hover, .grid-divider.active { background: var(--accent-color, #3b82f6); }

  .panel-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    min-height: 28px;
    background: var(--page-bg, #0f1520);
    border-bottom: 1px solid var(--border-color, rgba(128, 128, 128, 0.15));
    font-size: 11px;
    user-select: none;
    flex: 0 0 auto;
  }

  /* Content area — height:0 / flex:1 is load-bearing for the WebGL canvas */
  .panel-content { flex: 1; min-height: 0; position: relative; overflow: hidden; height: 0; }
</style>
```

- [ ] **Step 2: Update the App call site.** In `desktop/App.svelte` find `<PaneTree` (~line 1854). Change the first prop `node={ts.root}` to `root={ts.root}`. Leave every other prop unchanged.

- [ ] **Step 3: Type-check** — `pnpm check 2>&1 | tail -3` → **0 errors** (304 warnings expected). The only expected error if mis-edited is "Object literal may only specify known properties" on `node`/`root` — fix by ensuring App passes `root=` and PaneTree declares `root`.

- [ ] **Step 4: Commit**

```bash
git add desktop/PaneTree.svelte desktop/App.svelte
git commit -m "refactor(pane-tree): flat keyed render — leaves never remount on split"
```

---

## Task 3: Correct nested-split resize (`resize-handlers.ts`)

**Files:**
- Modify: `desktop/lib/resize-handlers.ts`

Context: the divider is now an absolute child of `.pane-tree-root` (not a `.split` flex container), so `parentElement.getBoundingClientRect()` is the **whole tree**. Use the divider's `data-split-span` (% extent of the split along the drag axis, set in Task 2) to convert px → ratio correctly for nested splits.

- [ ] **Step 1: Edit `on_split_drag`.** Replace the body from `const container = ...` through the end of `on_move` with:

```ts
  const root_el = (e.target as HTMLElement).parentElement // .pane-tree-root
  if (!root_el) return
  const span_pct = parseFloat((e.target as HTMLElement).dataset.splitSpan ?? '100') || 100
  e.preventDefault()
  deps.set_is_panel_resizing(true)
  on_start()
  const start = dir === 'h' ? e.clientX : e.clientY
  const start_ratio = node.ratio
  function on_move(ev: MouseEvent) {
    const rect = root_el!.getBoundingClientRect()
    // The split occupies `span_pct`% of the root along the drag axis.
    const total = (dir === 'h' ? rect.width : rect.height) * (span_pct / 100)
    const delta = total > 0 ? ((dir === 'h' ? ev.clientX : ev.clientY) - start) / total : 0
    ts!.root = setRatio(ts!.root, split_id, start_ratio + delta)
  }
```

(The `on_up` listener teardown and the `window.addEventListener` lines stay unchanged.)

- [ ] **Step 2: Type-check** — `pnpm check 2>&1 | tail -3` → **0 errors**.

- [ ] **Step 3: Commit**

```bash
git add desktop/lib/resize-handlers.ts
git commit -m "fix(pane-tree): divider drag uses split span for correct nested resize"
```

---

## Task 4: Acceptance — terminal survives a split (browser, live stack)

**Files:** none (verification).

Dev stack must be running (`pnpm desktop:serve`, :3186). Drive it (Playwright MCP or manual):

- [ ] **Step 1:** Open a Terminal (landing "Terminal" card). Wait for the prompt.
- [ ] **Step 2:** Run a command that leaves visible scrollback, e.g. type `echo SPLIT_SURVIVES_MARKER` + Enter.
- [ ] **Step 3:** Split via the tab-bar layout button → "Side by Side".
- [ ] **Step 4: Assert no remount** — the terminal pane still shows the **same** prompt and `SPLIT_SURVIVES_MARKER` in its scrollback (not a fresh shell), and the cwd is unchanged. Programmatic check (page.evaluate): the `.xterm-rows` text still contains `SPLIT_SURVIVES_MARKER` after the split.
- [ ] **Step 5:** Maximize the terminal leaf and restore — still the same scrollback (no remount). Collapse the sibling (close it) — terminal unchanged.
- [ ] **Step 6:** Confirm `pnpm check` is 0 errors and `pnpm vitest run tests/vitest/pane-layout.test.ts` passes.

If the marker is gone after the split, the leaf remounted — investigate the `{#each ... (leaf.id)}` keying (the leaf id must be stable across the split; `splitLeaf` keeps the original leaf's id, so the key must match).

---

## Final verification

- [ ] `pnpm check` → 0 errors.
- [ ] `pnpm vitest run` → all pass (the 2 pre-existing XRD/RDF numerical failures are unrelated and may flake).
- [ ] Merge to `feat/pane-tree-core` (fast-forward from the worktree branch).

## Notes / invariants

- Keep-warm uses `visibility:hidden`, never `display:none`.
- No `src/lib/mobile/*` edits.
- The `:global(.panel-*)` and `.panel-header`/`.panel-content` CSS must stay (header/banner snippets render in App's scope and rely on them).
- Removed CSS: `.split`, `.split.h`, `.split.v`, `.split-child`, and the old flex-`.grid-divider` rules — replaced by absolute positioning above.

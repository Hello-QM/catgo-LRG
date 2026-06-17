# Pane-Tree Flat Keyed Render — Design Spec

**Date:** 2026-06-16
**Status:** Approved (design); ready for implementation plan
**Branch target:** `feat/pane-tree-core`

## Goal

Stop pane splits / layout changes from **remounting** leaf content. Today, splitting a terminal restarts its shell (the PTY is killed on unmount); 3D viewers similarly lose state. Make every leaf's component instance **survive** any tree restructure (split, collapse, resize, maximize) so terminals keep running (scrollback + shell) and viewers keep their WebGL state.

## Root cause (current)

`desktop/PaneTree.svelte` renders the tree **recursively** via nested `<svelte:self node={s.children[i]}>`. When the tree restructures (e.g. a single terminal leaf becomes `split(terminalLeaf, emptyLeaf)`), that leaf moves from being rendered at the root to being rendered by a *different* child `<svelte:self>` instance at a new DOM position. Svelte destroys the old subtree and creates a new one → `TerminalPanel`'s cleanup runs `pty_session.kill()` (`TerminalPanel.svelte:687-689`) → the shell dies → the new instance spawns a fresh PTY. Net effect: the terminal "restarts".

## Approach

Render all leaves as **one flat keyed list** of absolutely-positioned slots, with each slot's rect computed from the tree. Keyed by `leaf.id`, so Svelte preserves the **same component instance** across restructures — only the slot's CSS rect updates. No remount → no `kill()` → no restart. This is the keep-warm architecture the pane-tree always intended.

## Components

### 1. `desktop/pane-layout.ts` (new, pure, unit-tested)

```ts
import type { PaneNode } from './pane-tree'
import type { LeafNode } from './pane-tree'

export interface Rect { x: number; y: number; w: number; h: number } // percentages 0..100
export interface LeafBox { leaf: LeafNode; rect: Rect }
export interface DividerBox { split_id: string; dir: 'h' | 'v'; rect: Rect }
export interface PaneLayout { leaves: LeafBox[]; dividers: DividerBox[] }

/** Panes are sized by exact ratio percentages; a divider is emitted at each
 *  split boundary and given a fixed 6px thickness in CSS, centered on the seam
 *  via a negative margin (-3px). So the divider overlays the boundary without
 *  any %-gap subtraction — no container-size dependence in the layout math. */
export function compute_pane_layout(
  root: PaneNode | undefined,
  maximized_leaf_id: string | null,
): PaneLayout
```

Algorithm:
- Recurse with an accumulating `Rect` starting at `{0,0,100,100}`.
- **Leaf:** push `{ leaf, rect }`.
- **Split (dir 'h' = side-by-side):** child0 = `{x, y, w*ratio, h}`, child1 = `{x + w*ratio, y, w*(1-ratio), h}`; emit a divider at the boundary `{ x: x + w*ratio, y, w: 0, h }` tagged `dir:'h'` (CSS gives it a fixed px width, centered on the boundary). `dir 'v' = stacked`: split along `h` analogously.
- **Maximize:** if `maximized_leaf_id` is set, the box containing it gets the **full** parent rect and the sibling subtree collapses to `w:0`/`h:0` (its leaves still emitted, at 0 size, so they stay mounted = keep-warm). Dividers are omitted while maximized.
- Guard `!root` → empty layout. Guard `!node.children` (transient) → treat as no-op.

### 2. `desktop/PaneTree.svelte` (rewrite)

Props change: `node: PaneNode` → **`root: PaneNode | undefined`** (App passes the whole tree). All other props unchanged (`multi`, `active_leaf_id`, `drag_target_leaf`, `close_confirm_leaf_id`, `active_split_id`, `maximized_leaf_id`, the four snippets, `on_activate`, `on_split_mousedown`, `on_split_dblclick`).

```svelte
{@const layout = compute_pane_layout(root, maximized_leaf_id)}
<div class="pane-tree-root">
  {#each layout.leaves as { leaf, rect } (leaf.id)}
    <div
      class="pane"
      class:active={active_leaf_id === leaf.id}
      class:dragover={drag_target_leaf === leaf.id}
      class:warn-glow={close_confirm_leaf_id === leaf.id}
      class:maximized-hidden={!!maximized_leaf_id && rect.w === 0}
      data-leaf-id={leaf.id}
      style="left:{rect.x}%; top:{rect.y}%; width:{rect.w}%; height:{rect.h}%"
      role="button" tabindex="0"
      onclick={() => on_activate(leaf.id)}
      onkeydown={(e) => { if (e.key === 'Enter') on_activate(leaf.id) }}
    >
      {#if multi || leaf.content.type === 'terminal'}
        <div class="panel-header">{@render header(leaf)}</div>
      {/if}
      {@render banner(leaf)}
      <div class="panel-content">
        {#if leaf.content.type === 'terminal'}{@render terminal_body(leaf)}
        {:else}{@render leaf_body(leaf)}{/if}
      </div>
    </div>
  {/each}
  {#if !maximized_leaf_id}
    {#each layout.dividers as d (d.split_id)}
      <div
        class="grid-divider {d.dir === 'h' ? 'grid-divider-col' : 'grid-divider-row'}"
        class:active={active_split_id === d.split_id}
        style="left:{d.rect.x}%; top:{d.rect.y}%; {d.dir === 'h' ? `height:${d.rect.h}%` : `width:${d.rect.w}%`}"
        onmousedown={(e) => on_split_mousedown(e, d.split_id, d.dir)}
        ondblclick={() => on_split_dblclick(d.split_id)}
        role="separator" aria-orientation={d.dir === 'h' ? 'vertical' : 'horizontal'}
      ></div>
    {/each}
  {/if}
</div>
```

CSS: `.pane-tree-root { position:relative; width:100%; height:100% }`. `.pane { position:absolute; overflow:hidden; … }` (move from the old `.split-child`/`.pane` rules). `.grid-divider-col { position:absolute; width:6px; margin-left:-3px; cursor:col-resize }` (centered on the boundary via the negative margin), `.grid-divider-row { position:absolute; height:6px; margin-top:-3px; cursor:row-resize }`. `.maximized-hidden { visibility:hidden }` (keep-warm — NOT `display:none`). Keep the existing `:global(.panel-*)` hover rules.

### 3. `desktop/lib/resize-handlers.ts`

The divider drag converts px-delta → ratio. Today it divides by the whole container size (`total`), which is slightly off for nested splits. Concrete change: inside `on_split_drag`, after reading the `.pane-tree-root` rect, recompute `compute_pane_layout(ts.root, null)`, find the divider with this `split_id`, and take its split extent along the drag axis: `split_extent_px = (dir === 'h' ? rect.width * split_w/100 : rect.height * split_h/100)` where `split_w/h` come from the split's own bounding rect (the union of its two child boxes). Then `delta = (px moved) / split_extent_px`. (`setRatio(ts.root, split_id, start_ratio + delta)` is unchanged.)

### 4. `desktop/App.svelte`

`<PaneTree root={ts.root} … />` (was `node={ts.root}`). No other change — snippets, handlers, and `maximized_leaf_id` flow through unchanged.

## Invariants preserved

- Keep-warm uses `visibility:hidden`, never `display:none` (WebGL/PTY stay live).
- `is_active` exactly-one-leaf-active unchanged (App owns `active_leaf_id`).
- `clone_structure` on assignment unchanged (App owns pane content).
- No `src/lib/mobile/*` edits (mobile doesn't use the desktop PaneTree).
- Project style by hand (single-quote, no-semicolon, 2-space); never run `deno fmt`.

## Error handling / edge cases

- `root` undefined or transient childless split → empty/partial layout, no crash (the prior null-deref guards become moot since there's no `<svelte:self>` re-eval, but `compute_pane_layout` still guards).
- Maximize toggles only change rects → no remount.
- A leaf removed (close) → it drops out of the keyed `{#each}` → its component unmounts normally (TerminalPanel `kill()` fires — correct, the shell really is closed). Splitting/collapsing that keeps the leaf → component persists.
- CAP (≤4 leaves) unchanged (App enforces).

## Testing

- **Unit (vitest)** `tests/vitest/pane-layout.test.ts`: `compute_pane_layout` for
  - single leaf → one box `{0,0,100,100}`, no dividers;
  - splitH ratio 0.5 → two boxes `{0,0,50,100}` / `{50,0,50,100}` + one `dir:'h'` divider at x=50;
  - splitV → stacked boxes + `dir:'v'` divider;
  - quad (h-split of two v-splits) → 4 boxes + 3 dividers;
  - nested asymmetric ratios → exact rects;
  - maximize → maximized leaf full rect, siblings `w:0`/`h:0`, no dividers.
- **Acceptance (browser, live stack)**: open terminal → `echo MARKER` (scrollback) → split (Side by Side) → assert the terminal pane's **same** xterm/PTY persists: prompt + `MARKER` still visible, shell alive (run another command). Then collapse the sibling and maximize → still no remount.

## File summary

| File | Change |
|---|---|
| `desktop/pane-layout.ts` | **new** — pure `compute_pane_layout` (+ types) |
| `desktop/PaneTree.svelte` | **rewrite** — flat keyed render, `root` prop, absolute slots + dividers |
| `desktop/lib/resize-handlers.ts` | divider drag uses the split's sub-rect size |
| `desktop/App.svelte` | `<PaneTree root={ts.root} …>` (was `node=`) |
| `tests/vitest/pane-layout.test.ts` | **new** — layout unit tests |

## Out of scope

- Animated transitions between layouts (rects snap; can add CSS transitions later).
- Drag-to-reorder leaves between slots (separate feature).
- Mobile pane system (untouched).

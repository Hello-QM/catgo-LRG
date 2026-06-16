# Leaf Maximize / Zoom (Subproject 4) Implementation Plan

> **For agentic workers:** Implement task-by-task; keep the build green (this subproject is additive).

**Goal:** Maximize/zoom ANY leaf (structure or terminal) to fill the tab's workspace, with a header button + Esc to restore. This is the generalized "terminal fullscreen" the user asked for.

**Architecture:** A `maximized_leaf_id: string | null` field on `StructureTabState`. When set, `PaneTree` collapses every split that does NOT contain the maximized leaf to `flex-basis:0` (and hides the dividers), so only the maximized leaf is visible — all other leaves stay **mounted** (warm canvas/PTY, never `display:none`). Esc / a restore button clears it. Per spec D3 the tab bar + sidebar stay. **D8: no `Structure.svelte`/mobile edit.**

**Tech Stack:** Svelte 5 runes, TypeScript, Vitest. No formatter — write single-quote/no-semicolon/2-space by hand; never run `deno fmt`.

---

## Task 1: `maximized_leaf_id` state field

**Files:** Modify `desktop/pane-utils.ts`.

- [ ] **Step 1.1:** Add `maximized_leaf_id: string | null` to the `StructureTabState` interface (after `close_confirm_leaf_id`).
- [ ] **Step 1.2:** In `create_tab_state()` AND `create_terminal_tab_state()`, add `maximized_leaf_id: null` to the returned object.
- [ ] **Step 1.3: Commit** `git add desktop/pane-utils.ts && git commit -m "feat(maximize): maximized_leaf_id on StructureTabState"`. (`pnpm check` may show downstream usage gaps only once PaneTree expects the prop — fine; field add itself is clean.)

## Task 2: `subtreeContains` helper + test (pane-tree.ts)

**Files:** Modify `desktop/pane-tree.ts`, `tests/desktop/pane-tree.test.ts`.

- [ ] **Step 2.1: Failing test** — append to `tests/desktop/pane-tree.test.ts`:

```ts
import { subtreeContains } from '../../desktop/pane-tree'
describe('subtreeContains', () => {
  it('true iff the leaf is somewhere in the node subtree', () => {
    const a = create_empty_leaf(); const b = create_empty_leaf(); const c = create_empty_leaf()
    const root = split('S1', 'h', 0.5, split('S2', 'v', 0.5, a, b), c)
    expect(subtreeContains(root, a.id)).toBe(true)
    expect(subtreeContains((root as SplitNode).children[1], a.id)).toBe(false)
    expect(subtreeContains((root as SplitNode).children[1], c.id)).toBe(true)
    expect(subtreeContains(root, 'nope')).toBe(false)
  })
})
```

- [ ] **Step 2.2: Run, fail.** `pnpm exec vitest run tests/desktop/pane-tree.test.ts`.
- [ ] **Step 2.3: Implement** in `desktop/pane-tree.ts`:

```ts
export function subtreeContains(node: PaneNode, leafId: string): boolean {
  return findLeafById(node, leafId) !== null
}
```

- [ ] **Step 2.4: Run, pass. Commit** `git add desktop/pane-tree.ts tests/desktop/pane-tree.test.ts && git commit -m "feat(maximize): subtreeContains helper"`.

## Task 3: PaneTree renders the maximized leaf

**Files:** Modify `desktop/PaneTree.svelte`.

- [ ] **Step 3.1:** Add `maximized_leaf_id: string | null` to the `Props` interface and the `$props()` destructure; forward it on BOTH `<svelte:self>` recursion calls (like the other props).
- [ ] **Step 3.2:** Import `subtreeContains` from `'./pane-tree'`. In the `split` branch, compute per-child flex-basis honoring maximize:

```svelte
{#if node.kind === 'split'}
  {@const s = node as SplitNode}
  {@const max0 = maximized_leaf_id ? subtreeContains(s.children[0], maximized_leaf_id) : null}
  {@const max1 = maximized_leaf_id ? subtreeContains(s.children[1], maximized_leaf_id) : null}
  {@const basis0 = maximized_leaf_id ? (max0 ? '100%' : '0%') : `calc(${s.ratio * 100}% - 3px)`}
  {@const basis1 = maximized_leaf_id ? (max1 ? '100%' : '0%') : `calc(${(1 - s.ratio) * 100}% - 3px)`}
  <div class="split {s.direction === 'h' ? 'h' : 'v'}" class:maximizing={!!maximized_leaf_id}>
    <div class="split-child" style={`flex-basis:${basis0}`}>
      <svelte:self node={s.children[0]} {maximized_leaf_id} ...all other props... />
    </div>
    {#if !maximized_leaf_id}
      <div class="grid-divider ..." ...existing divider...></div>
    {/if}
    <div class="split-child" style={`flex-basis:${basis1}`}>
      <svelte:self node={s.children[1]} {maximized_leaf_id} ...all other props... />
    </div>
  </div>
{:else}
  ...leaf branch unchanged...
{/if}
```

(Keep the existing divider markup; just wrap it in `{#if !maximized_leaf_id}`. The `0%` basis children stay mounted with zero size → warm.)

- [ ] **Step 3.3:** Add CSS so a zero-basis child fully collapses: ensure `.split-child { overflow: hidden }` (already present) and the `0%` basis works (flex-shrink already 0 via `flex: 0 0 auto`; with basis `0%` the child is zero-size). No extra CSS strictly needed; the `.maximizing` class is available for any tweak.
- [ ] **Step 3.4: Commit** `git add desktop/PaneTree.svelte && git commit -m "feat(maximize): PaneTree collapses non-maximized splits (warm off-screen)"`.

## Task 4: App handlers + header button + Esc + stale-clamp

**Files:** Modify `desktop/App.svelte`, `desktop/lib/keyboard-shortcuts.ts`, `desktop/lib/pane-manager.ts`.

- [ ] **Step 4.1:** In App, pass `maximized_leaf_id={ts.maximized_leaf_id}` to `<PaneTree>`.
- [ ] **Step 4.2:** Add a `toggle_maximize(tab_id, leaf_id)` function:

```ts
function toggle_maximize(tab_id: string, leaf_id: string) {
  const ts = tab_states[tab_id]
  if (!ts) return
  ts.maximized_leaf_id = ts.maximized_leaf_id === leaf_id ? null : leaf_id
  if (ts.maximized_leaf_id) ts.active_leaf_id = leaf_id
}
```

- [ ] **Step 4.3:** In the `header` snippet (both structure and terminal arms), add a maximize button (between popout and close), shown only when `multi`:

```svelte
<button class="panel-maximize-btn" onclick={(e) => { e.stopPropagation(); toggle_maximize(tab.id, leaf.id) }}
  title={ts.maximized_leaf_id === leaf.id ? t(`app.restore_pane`) : t(`app.maximize_pane`)}>
  <!-- maximize/restore icon: a simple corner-expand SVG; swap path when maximized -->
  {#if ts.maximized_leaf_id === leaf.id}
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 9H5V5M15 9h4V5M9 15H5v4M15 15h4v4"/></svg>
  {:else}
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 8V4h4M20 8V4h-4M4 16v4h4M20 16v4h-4"/></svg>
  {/if}
</button>
```

Add i18n keys `app.maximize_pane` / `app.restore_pane` to BOTH `src/lib/i18n/en/app.ts` and `src/lib/i18n/zh/app.ts` (keep en/zh parity). Add a `.panel-maximize-btn` CSS rule mirroring `.panel-popout-btn` (hover-reveal). The header chrome (and its `multi` gate) already shows the popout/close — when a leaf is maximized, `multi` is still true (leafCount unchanged), so the button stays visible to restore.

- [ ] **Step 4.4: Esc to restore** — in `desktop/lib/keyboard-shortcuts.ts`, in the Escape handler, BEFORE the close-confirm clear, add: if the active tab's `ts.maximized_leaf_id` is set, clear it and return. Guard it the same as other Esc uses (no modal / editor open — reuse the existing guards in that handler).

```ts
if (event.key === `Escape`) {
  const ts = deps.get_active_ts()
  if (ts?.maximized_leaf_id) { ts.maximized_leaf_id = null; return }
  // ...existing close-confirm / pending-layout handling...
}
```

- [ ] **Step 4.5: Stale clamp** — in `desktop/lib/pane-manager.ts` `close_panel` and App's `close_terminal_leaf`, after `removeLeaf`, add: `if (ts.maximized_leaf_id && !findLeafById(ts.root, ts.maximized_leaf_id)) ts.maximized_leaf_id = null`. (Prevents a dangling maximize → blank render.) Also clear it in `tab-manager`'s `reset_ts_to_empty`.
- [ ] **Step 4.6: Commit** `git add desktop/ src/lib/i18n && git commit -m "feat(maximize): header button + Esc restore + stale clamp + i18n"`.

## Task 5: Verify + invariant test

- [ ] **Step 5.1:** `pnpm check 2>&1 | tail -3` → **0 errors**.
- [ ] **Step 5.2:** `pnpm exec vitest run tests/desktop/pane-tree.test.ts` → green.
- [ ] **Step 5.3: D8** — `git diff --name-only feat/pane-tree-core...HEAD -- src/lib/mobile src/lib/structure/Structure.svelte` → empty (this subproject must not touch them).
- [ ] **Step 5.4: Manual smoke** (`pnpm desktop:serve`): split into 2–4 leaves (mix structure + terminal); click maximize on one → it fills the workspace, others hidden but warm; restore via button or Esc; maximize a terminal → fills; restore → terminal still alive + responsive (PTY warm); maximize then close the maximized leaf → no blank (stale clamp); structure tabs unaffected when nothing maximized.
- [ ] **Step 5.5: Commit** any fixes.

## Notes
- Invariants: maximize never mutates the tree (only the scalar `ts.maximized_leaf_id`), so clone-on-assign + reactivity are trivially safe. `is_active` unchanged (maximized leaf is set active).
- Keep-warm: zero-basis children stay mounted; viewer `ResizeObserver` + xterm `FitAddon` tolerate zero size and re-fit on restore.
- D8: all changes in `desktop/` + `src/lib/i18n` (desktop-rendered) — no `Structure.svelte`/mobile edit.

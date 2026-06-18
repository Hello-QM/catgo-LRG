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
    leaf_body: Snippet<[LeafNode]>     // App renders the viewer/landing for a structure leaf
    terminal_body: Snippet<[LeafNode]> // App renders the TerminalPanel for a terminal leaf
    header: Snippet<[LeafNode]>        // App renders the dot+label+popout+close buttons
    banner: Snippet<[LeafNode]>        // App renders the close-confirm banner
    on_activate: (leaf_id: string) => void
    on_split_mousedown: (e: MouseEvent, split_id: string, dir: 'h' | 'v') => void
    on_split_dblclick: (split_id: string) => void
  }
  let { root, multi, active_leaf_id, drag_target_leaf, close_confirm_leaf_id, active_split_id, maximized_leaf_id, leaf_body, terminal_body, header, banner, on_activate, on_split_mousedown, on_split_dblclick }: Props = $props()

  // Flat layout: every leaf is one keyed slot positioned by a computed rect.
  // Keyed by leaf.id, so a leaf keeps its component instance when the tree
  // restructures (split / collapse / resize / maximize) — no remount, so a
  // terminal's PTY and a viewer's WebGL state survive layout changes.
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

  /* Pane state visuals that cross the App<->PaneTree scope boundary: .pane lives
     here, but its header buttons / import cards render via App-defined snippets,
     so the descendant parts need :global(). */
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

  /* Panel header flex container (its dot/label/buttons render via App snippets,
     styled by App's scoped CSS). */
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

  /* NOTE: .panel-dot/.panel-label/.panel-*-btn/.panel-close-banner/.banner-*
     rules are supplied by App.svelte's global <style> (the header/banner snippets
     render in App's scope); keep them in App.svelte. */
</style>

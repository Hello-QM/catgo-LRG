<script lang="ts">
  import type { PaneNode, LeafNode, SplitNode } from './pane-tree'
  import { subtreeContains } from './pane-tree'
  import type { Snippet } from 'svelte'

  interface Props {
    node: PaneNode
    multi: boolean // leafCount(root) > 1 — gates per-leaf header chrome
    active_leaf_id: string
    drag_target_leaf: string | null
    close_confirm_leaf_id: string | null
    active_split_id: string | null
    maximized_leaf_id: string | null // when set, only the subtree holding it is visible (others stay warm at 0 size)
    leaf_body: Snippet<[LeafNode]>     // App renders the viewer/landing for a structure leaf
    terminal_body: Snippet<[LeafNode]> // App renders the TerminalPanel for a terminal leaf
    header: Snippet<[LeafNode]>        // App renders the dot+label+popout+close buttons
    banner: Snippet<[LeafNode]>        // App renders the close-confirm banner
    on_activate: (leaf_id: string) => void
    on_split_mousedown: (e: MouseEvent, split_id: string, dir: 'h' | 'v') => void
    on_split_dblclick: (split_id: string) => void
  }
  let { node, multi, active_leaf_id, drag_target_leaf, close_confirm_leaf_id, active_split_id, maximized_leaf_id, leaf_body, terminal_body, header, banner, on_activate, on_split_mousedown, on_split_dblclick }: Props = $props()
</script>

{#if node.kind === 'split'}
  {@const s = node as SplitNode}
  {@const max0 = maximized_leaf_id ? subtreeContains(s.children[0], maximized_leaf_id) : null}
  {@const max1 = maximized_leaf_id ? subtreeContains(s.children[1], maximized_leaf_id) : null}
  {@const basis0 = maximized_leaf_id ? (max0 ? '100%' : '0%') : `calc(${s.ratio * 100}% - 3px)`}
  {@const basis1 = maximized_leaf_id ? (max1 ? '100%' : '0%') : `calc(${(1 - s.ratio) * 100}% - 3px)`}
  <div class="split {s.direction === 'h' ? 'h' : 'v'}" class:maximizing={!!maximized_leaf_id}>
    <div class="split-child" style={`flex-basis:${basis0}`}>
      <svelte:self node={s.children[0]} {multi} {active_leaf_id} {drag_target_leaf} {close_confirm_leaf_id} {active_split_id} {maximized_leaf_id} {leaf_body} {terminal_body} {header} {banner} {on_activate} {on_split_mousedown} {on_split_dblclick} />
    </div>
    {#if !maximized_leaf_id}
      <div
        class="grid-divider {s.direction === 'h' ? 'grid-divider-col' : 'grid-divider-row'}"
        class:active={active_split_id === s.id}
        onmousedown={(e) => on_split_mousedown(e, s.id, s.direction)}
        ondblclick={() => on_split_dblclick(s.id)}
        role="separator"
        aria-orientation={s.direction === 'h' ? 'vertical' : 'horizontal'}
      ></div>
    {/if}
    <div class="split-child" style={`flex-basis:${basis1}`}>
      <svelte:self node={s.children[1]} {multi} {active_leaf_id} {drag_target_leaf} {close_confirm_leaf_id} {active_split_id} {maximized_leaf_id} {leaf_body} {terminal_body} {header} {banner} {on_activate} {on_split_mousedown} {on_split_dblclick} />
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
    <div class="panel-content">
      {#if leaf.content.type === 'terminal'}
        {@render terminal_body(leaf)}
      {:else}
        {@render leaf_body(leaf)}
      {/if}
    </div>
  </div>
{/if}

<style>
  /* Split container geometry — moves grid-container -> flex splits */
  .split { display: flex; width: 100%; height: 100%; min-width: 0; min-height: 0; }
  .split.h { flex-direction: row; }
  .split.v { flex-direction: column; }
  .split-child { position: relative; min-width: 0; min-height: 0; overflow: hidden; flex: 0 0 auto; }

  /* Resize dividers — var names match App.svelte exactly */
  .grid-divider { background: var(--border-color, rgba(128, 128, 128, 0.2)); transition: background 0.15s; z-index: 1; flex: 0 0 auto; }
  .grid-divider-col { width: 6px; cursor: col-resize; }
  .grid-divider-row { height: 6px; cursor: row-resize; }
  .grid-divider:hover, .grid-divider.active { background: var(--accent-color, #3b82f6); }

  /* Pane wrapper — var names match App.svelte exactly */
  .pane { position: relative; overflow: hidden; background: var(--surface-bg, var(--page-bg)); cursor: pointer; display: flex; flex-direction: column; width: 100%; height: 100%; }
  .pane.warn-glow { box-shadow: inset 0 0 0 2px rgba(245, 158, 11, 0.5); }

  /* Pane state visuals that cross the App<->PaneTree scope boundary: .pane lives
     here, but its header buttons / import cards render via App-defined snippets,
     so the descendant parts need :global(). (moved verbatim from App.svelte) */
  .pane:hover :global(.panel-popout-btn),
  .pane:hover :global(.panel-maximize-btn),
  .pane:hover :global(.panel-close-btn) { opacity: 1; }
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

  /* Panel header flex container (its dot/label/buttons render via App snippets,
     styled by App's scoped CSS). Moved verbatim from App.svelte. */
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
  }

  /* Content area — height:0 is load-bearing for the WebGL canvas */
  .panel-content { flex: 1; min-height: 0; position: relative; overflow: hidden; height: 0; }

  /* NOTE: .panel-header/.panel-dot/.panel-label/.panel-*-btn/.panel-close-banner/.banner-*
     rules are supplied by App.svelte's global <style> (the header/banner snippets render
     in App's scope); keep them in App.svelte. Only split/pane/divider/content geometry
     lives here. */
</style>

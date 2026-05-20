<script lang="ts">
  import type { PymatgenStructure } from '$lib'
  import StructurePreview from '$lib/structure/StructurePreview.svelte'
  import MultiStructurePreview from './MultiStructurePreview.svelte'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'

  load_i18n_module('workflow')

  let {
    upstream_structure_json,
    upstream_structures_json = null,
    initial_selected,
    readonly_selection = false,
    on_expand,
    on_multi_selection_change,
  }: {
    upstream_structure_json: string | null
    upstream_structures_json?: string[] | null
    initial_selected?: number[]
    readonly_selection?: boolean
    on_expand?: () => void
    on_multi_selection_change?: (selected: Set<number>) => void
  } = $props()

  // Convert saved selection array to Set for MultiStructurePreview
  let saved_selection = $derived(
    initial_selected && initial_selected.length > 0
      ? new Set<number>(initial_selected)
      : undefined
  )

  let use_multi = $derived(
    upstream_structures_json != null && upstream_structures_json.length > 1
  )

  let structure = $derived.by(() => {
    if (!upstream_structure_json) return null
    try { return JSON.parse(upstream_structure_json) as PymatgenStructure }
    catch { return null }
  })
</script>

{#if use_multi && upstream_structures_json}
  <MultiStructurePreview
    structures_json={upstream_structures_json}
    selected_indices={saved_selection ?? new Set<number>()}
    hide_selection={readonly_selection}
    {on_expand}
    on_selection_change={readonly_selection ? undefined : on_multi_selection_change}
  />
{:else}
  <div class="calc-preview">
    <div class="preview-viewport">
      {#if structure}
        <StructurePreview {structure} />
        {#if on_expand}
          <button class="viewport-expand-btn" onclick={on_expand} title={t('workflow.calc_open_full_viewer')}>&#x26F6;</button>
        {/if}
      {:else}
        <div class="preview-msg">
          <span class="msg-icon">&#x1F517;</span>
          <span>{t('workflow.calc_connect_structure_input')}</span>
        </div>
      {/if}
    </div>
    {#if structure}
      <div class="preview-info">
        <span>{t('common.structure')} &middot; {t('common.atoms_count', { n: structure.sites?.length ?? 0 })}</span>
      </div>
    {/if}
  </div>
{/if}

<style>
  .calc-preview {
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    border-radius: 6px;
    overflow: hidden;
    margin: 4px 12px 8px;
    background: var(--dialog-bg, light-dark(#fff, #1c1d21));
  }
  .preview-viewport {
    height: 220px;
    position: relative;
    background: #111;
    overflow: visible;
  }
  .preview-viewport :global(.structure-canvas-container) {
    overflow: visible !important;
  }
  .viewport-expand-btn {
    position: absolute; top: 6px; right: 6px; z-index: 10;
    background: rgba(0,0,0,0.5); border: 1px solid rgba(255,255,255,0.2);
    color: #ccc; cursor: pointer; border-radius: 4px;
    padding: 2px 6px; font-size: 14px; line-height: 1; transition: all 0.15s;
  }
  .viewport-expand-btn:hover {
    background: rgba(0,0,0,0.8);
    border-color: var(--accent-color, #4fc3f7); color: #fff;
  }
  .preview-msg {
    height: 100%; display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    gap: 8px; color: var(--text-color-dim, light-dark(#9ca3af, #666)); font-size: 11px;
  }
  .preview-msg .msg-icon { font-size: 20px; opacity: 0.5; }
  .preview-info {
    padding: 3px 8px; font-size: 10px;
    color: var(--text-color-dim, light-dark(#9ca3af, #999));
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255,255,255,0.05)));
  }
</style>

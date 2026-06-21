<script lang="ts">
  import type { PymatgenStructure } from '$lib/structure'
  import StructurePreview from '$lib/structure/StructurePreview.svelte'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'

  load_i18n_module('workflow')

  interface Props {
    structures_json: string[]
    selected_indices?: Set<number>
    on_selection_change?: (selected: Set<number>) => void
    on_expand?: () => void
    height?: number
    /** Hide all selection UI (checkboxes, grid, etc.) — browse only */
    hide_selection?: boolean
  }

  let {
    structures_json,
    selected_indices = $bindable(new Set<number>()),
    on_selection_change,
    on_expand,
    height = 220,
    hide_selection = false,
  }: Props = $props()

  // Parse all structure JSON strings into PymatgenStructure objects
  let structures = $state<(PymatgenStructure | null)[]>([])

  // Use $effect + JSON.stringify to track deep changes in the array prop
  $effect(() => {
    const json_str = JSON.stringify(structures_json)
    const parsed = (JSON.parse(json_str) as string[]).map((s: string) => {
      try {
        return JSON.parse(s) as PymatgenStructure
      } catch {
        return null
      }
    })
    structures = parsed

    // Default: select all structures
    if (selected_indices.size === 0 && parsed.length > 0) {
      const all = new Set<number>(parsed.map((_, i) => i))
      selected_indices = all
      on_selection_change?.(all)
    }
  })

  let current_frame = $state(0)

  let current_structure = $derived(
    structures[current_frame] ?? null
  )

  let total = $derived(structures.length)

  let selected_count = $derived(selected_indices.size)

  let all_selected = $derived(selected_count === total && total > 0)

  let current_is_selected = $derived(selected_indices.has(current_frame))

  // Frame description: element composition summary
  const frame_description = $derived.by(() => {
    const s = current_structure
    if (!s?.sites?.length) return ''
    const counts: Record<string, number> = {}
    for (const site of s.sites) {
      const el = (site as any).species?.[0]?.element ?? (site as any).label?.replace(/\d+$/, '') ?? '?'
      counts[el] = (counts[el] || 0) + 1
    }
    return Object.entries(counts).map(([el, n]) => `${el}${n > 1 ? n : ''}`).join(' ')
  })

  function toggle_current() {
    const next = new Set(selected_indices)
    if (next.has(current_frame)) {
      next.delete(current_frame)
    } else {
      next.add(current_frame)
    }
    selected_indices = next
    on_selection_change?.(next)
  }

  function toggle_all() {
    let next: Set<number>
    if (all_selected) {
      next = new Set()
    } else {
      next = new Set(structures.map((_, i) => i))
    }
    selected_indices = next
    on_selection_change?.(next)
  }

  function select_range(from: number, to: number) {
    const next = new Set(selected_indices)
    for (let i = from; i <= to; i++) next.add(i)
    selected_indices = next
    on_selection_change?.(next)
  }

  function invert_selection() {
    const next = new Set<number>()
    for (let i = 0; i < total; i++) {
      if (!selected_indices.has(i)) next.add(i)
    }
    selected_indices = next
    on_selection_change?.(next)
  }

  function toggle_index(idx: number) {
    const next = new Set(selected_indices)
    if (next.has(idx)) next.delete(idx)
    else next.add(idx)
    selected_indices = next
    on_selection_change?.(next)
  }

  // Shift+click range selection for chip grid
  let last_clicked_idx = $state(-1)

  function chip_click(idx: number, e: MouseEvent) {
    if (e.shiftKey && last_clicked_idx >= 0) {
      // Range select between last click and this click
      const lo = Math.min(last_clicked_idx, idx)
      const hi = Math.max(last_clicked_idx, idx)
      const next = new Set(selected_indices)
      for (let i = lo; i <= hi; i++) next.add(i)
      selected_indices = next
      on_selection_change?.(next)
    } else {
      toggle_index(idx)
    }
    last_clicked_idx = idx
    current_frame = idx
  }

  let show_grid = $state(false)

  function go_prev() {
    if (current_frame > 0) current_frame--
  }

  function go_next() {
    if (current_frame < total - 1) current_frame++
  }

  // Clamp current_frame when structures change
  $effect(() => {
    if (current_frame >= total && total > 0) {
      current_frame = total - 1
    } else if (total === 0) {
      current_frame = 0
    }
  })
</script>

<div class="multi-preview">
  <!-- Header with selection controls -->
  {#if !hide_selection}
  <div class="header-bar">
    <span class="structure-count">{t('workflow.batch_selected_count', { selected: selected_count, total })}</span>
    <div class="header-actions">
      <button class="toggle-all-btn" onclick={toggle_all}>{all_selected ? t('common.deselect_all') : t('common.select_all')}</button>
      <button class="toggle-all-btn" onclick={invert_selection}>{t('workflow.multi_preview_invert')}</button>
      <button class="toggle-all-btn" onclick={() => show_grid = !show_grid}>{show_grid ? t('workflow.multi_preview_hide') : t('workflow.multi_preview_grid')}</button>
    </div>
  </div>
  {/if}

  <!-- Chip grid for quick multi-select -->
  {#if !hide_selection && show_grid}
    <div class="chip-grid">
      {#each structures as _, idx}
        <button
          class="chip"
          class:chip-selected={selected_indices.has(idx)}
          class:chip-current={idx === current_frame}
          onclick={(e) => chip_click(idx, e)}
          title={t('workflow.multi_preview_click_toggle_shift_range')}
        >{idx + 1}</button>
      {/each}
    </div>
    <div class="chip-hint">{t('workflow.multi_preview_click_toggle_shift_range')}</div>
  {/if}

  <!-- 3D Preview -->
  <div class="preview-viewport" style:height="{height}px">
    {#if current_structure}
      <StructurePreview structure={current_structure} />
      {#if on_expand}
        <button class="viewport-expand-btn" onclick={on_expand} title={t('workflow.calc_open_full_viewer')}>&#x26F6;</button>
      {/if}
    {:else}
      <div class="preview-msg">
        <span class="msg-icon">&#x1F50D;</span>
        <span>{t('workflow.multi_preview_no_structure_at_frame', { n: current_frame })}</span>
      </div>
    {/if}
  </div>

  <!-- Frame controls -->
  <div class="frame-controls">
    <button class="frame-btn" onclick={go_prev} disabled={current_frame === 0} title={t('workflow.multi_preview_previous_structure')}>&lsaquo;</button>
    <input
      type="range"
      class="frame-slider"
      min="0"
      max={Math.max(0, total - 1)}
      bind:value={current_frame}
    />
    <button class="frame-btn" onclick={go_next} disabled={current_frame >= total - 1} title={t('workflow.multi_preview_next_structure')}>&rsaquo;</button>
    <span class="frame-label">{current_frame + 1}/{total}</span>
  </div>

  <!-- Frame info: composition -->
  {#if frame_description}
    <div class="frame-desc">#{current_frame + 1}: {frame_description} · {t('common.atoms_count', { n: current_structure?.sites?.length ?? 0 })}</div>
  {/if}

  <!-- Selection checkbox for current frame -->
  {#if !hide_selection}
    <label class="include-checkbox" class:unchecked={!current_is_selected}>
      <input type="checkbox" checked={current_is_selected} onchange={toggle_current} />
      <span>{t('workflow.multi_preview_include_in_calculation')}</span>
    </label>
    {#if selected_count < total}
      <div class="selection-hint">{t('workflow.multi_preview_selection_hint', { selected: selected_count, total })}</div>
    {/if}
  {/if}
</div>

<style>
  .multi-preview {
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    border-radius: 6px;
    overflow: hidden;
    margin: 4px 12px 8px;
    background: var(--dialog-bg, light-dark(#fff, #1c1d21));
  }

  .header-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 8px;
    font-size: 10px;
    color: var(--text-color-dim, light-dark(#9ca3af, #999));
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255,255,255,0.05)));
    border-bottom: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
  }

  .structure-count {
    font-weight: 500;
  }

  .header-actions {
    display: flex;
    gap: 6px;
  }
  .toggle-all-btn {
    background: none;
    border: none;
    color: var(--accent-color, #4fc3f7);
    cursor: pointer;
    font-size: 10px;
    padding: 0 2px;
    text-decoration: underline;
  }
  .toggle-all-btn:hover {
    opacity: 0.8;
  }

  .chip-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 2px;
    padding: 6px 8px;
    max-height: 120px;
    overflow-y: auto;
    border-bottom: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
  }
  .chip {
    min-width: 26px;
    height: 20px;
    padding: 0 4px;
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    border-radius: 3px;
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255,255,255,0.05)));
    color: var(--text-color-dim, light-dark(#9ca3af, #666));
    font-size: 9px;
    font-family: monospace;
    cursor: pointer;
    transition: all 0.1s;
  }
  .chip:hover {
    border-color: var(--accent-color, #4fc3f7);
  }
  .chip-selected {
    background: var(--accent-color, #4fc3f7);
    color: #fff;
    border-color: var(--accent-color, #4fc3f7);
  }
  .chip-current {
    outline: 2px solid var(--accent-color, #4fc3f7);
    outline-offset: -1px;
  }
  .chip-hint {
    padding: 2px 8px;
    font-size: 9px;
    color: var(--text-color-dim, light-dark(#b0b0b0, #666));
    font-style: italic;
    border-bottom: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
  }

  .preview-viewport {
    border-radius: 6px;
    overflow: hidden;
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

  .frame-controls {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    border-top: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
  }

  .frame-btn {
    background: none;
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    color: var(--text-color, light-dark(#333, #ccc));
    cursor: pointer;
    border-radius: 3px;
    padding: 0 6px;
    font-size: 14px;
    line-height: 1.4;
    min-width: 22px;
    text-align: center;
  }
  .frame-btn:hover:not(:disabled) {
    background: var(--input-bg, light-dark(rgba(0,0,0,0.05), rgba(255,255,255,0.1)));
  }
  .frame-btn:disabled {
    opacity: 0.3;
    cursor: default;
  }

  .frame-slider {
    flex: 1;
    height: 4px;
    accent-color: var(--accent-color, #4fc3f7);
    cursor: pointer;
  }

  .frame-label {
    font-size: 10px;
    color: var(--text-color-dim, light-dark(#9ca3af, #999));
    min-width: 36px;
    text-align: right;
    white-space: nowrap;
  }

  .frame-desc {
    font-size: 11px; color: var(--text-color, #333); padding: 2px 0;
    font-family: monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .include-checkbox {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 8px;
    font-size: 11px;
    color: var(--text-color, light-dark(#333, #ccc));
    cursor: pointer;
    border-top: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
  }
  .include-checkbox input[type="checkbox"] {
    accent-color: var(--accent-color, #4fc3f7);
    cursor: pointer;
  }
  .include-checkbox.unchecked {
    opacity: 0.5;
  }
  .selection-hint {
    padding: 4px 8px;
    font-size: 9px;
    color: #f59e0b;
    background: rgba(245, 158, 11, 0.06);
    border-top: 1px solid rgba(245, 158, 11, 0.15);
  }
</style>

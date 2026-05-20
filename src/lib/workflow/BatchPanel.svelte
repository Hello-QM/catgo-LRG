<script lang="ts">
  /**
   * BatchPanel — multi-structure batch configuration for calculation nodes.
   *
   * Shows when a calc node's upstream provides multiple structures.
   * Handles: structure browsing with composition labels, selection,
   * per-structure MAGMOM/KPOINTS overrides, INCAR editor trigger, HPC concurrency.
   */
  import type { PymatgenStructure } from '$lib/structure'
  import StructurePreview from '$lib/structure/StructurePreview.svelte'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'

  load_i18n_module('workflow')

  interface Props {
    structures_json: string[]
    node_params: Record<string, unknown>
    onparams_change: (params: Record<string, unknown>) => void
    on_edit_incar?: (frame_idx: number) => void  // Open VASP editor for this frame
  }

  let { structures_json, node_params, onparams_change, on_edit_incar }: Props = $props()

  // ─── Parse structures ───
  let structures = $state<(PymatgenStructure | null)[]>([])
  $effect(() => {
    try {
      structures = structures_json.map(s => {
        try { return (typeof s === 'string' ? JSON.parse(s) : s) as PymatgenStructure }
        catch { return null }
      })
    } catch { structures = [] }
  })

  // ─── Frame navigation ───
  let frame_idx = $state(0)
  $effect(() => {
    if (frame_idx >= structures.length) frame_idx = Math.max(0, structures.length - 1)
  })
  const current_structure = $derived(structures[frame_idx] ?? null)

  // ─── Frame composition label ───
  function get_composition(s: PymatgenStructure | null): string {
    if (!s?.sites?.length) return '—'
    const counts: Record<string, number> = {}
    for (const site of s.sites) {
      const el = (site as any).species?.[0]?.element ?? (site as any).label?.replace(/\d+$/, '') ?? '?'
      counts[el] = (counts[el] || 0) + 1
    }
    return Object.entries(counts).map(([el, n]) => `${el}${n > 1 ? n : ''}`).join('')
  }

  const frame_compositions = $derived(structures.map(s => get_composition(s)))
  const current_composition = $derived(frame_compositions[frame_idx] ?? '—')
  const atom_count = $derived(current_structure?.sites?.length ?? 0)

  // ─── Selection state ───
  let selected = $state(new Set<number>())
  $effect(() => {
    const saved = node_params.selected_structures
    if (Array.isArray(saved) && saved.length > 0) {
      selected = new Set(saved.map(Number))
    } else {
      selected = new Set(structures.map((_, i) => i))
    }
  })

  function toggle_selection(idx: number) {
    const next = new Set(selected)
    if (next.has(idx)) next.delete(idx)
    else next.add(idx)
    selected = next
    onparams_change({ ...node_params, selected_structures: [...next] })
  }

  function select_all() {
    selected = new Set(structures.map((_, i) => i))
    onparams_change({ ...node_params, selected_structures: [...selected] })
  }

  function select_none() {
    selected = new Set()
    onparams_change({ ...node_params, selected_structures: [] })
  }

  // ─── Per-structure param overrides ───
  let overrides = $derived.by<Record<string, Record<string, unknown>>>(() => {
    const raw = node_params.param_overrides
    if (!raw) return {}
    if (typeof raw === 'string') { try { return JSON.parse(raw) } catch { return {} } }
    return raw as Record<string, Record<string, unknown>>
  })

  const frame_overrides = $derived(overrides[String(frame_idx)] || {})
  const has_frame_overrides = $derived(Object.keys(frame_overrides).length > 0)
  const n_overrides = $derived(Object.keys(overrides).length)

  function set_override(idx: number, key: string, value: string) {
    const current = { ...overrides }
    const fk = String(idx)
    if (!value && current[fk]) {
      const { [key]: _, ...rest } = current[fk]
      if (Object.keys(rest).length === 0) delete current[fk]
      else current[fk] = rest
    } else if (value) {
      current[fk] = { ...(current[fk] || {}), [key]: value }
    }
    onparams_change({ ...node_params, param_overrides: current })
  }

  function clear_frame_overrides() {
    const current = { ...overrides }
    delete current[String(frame_idx)]
    onparams_change({ ...node_params, param_overrides: current })
  }

  // ─── Batch settings ───
  const max_parallel = $derived(Number(node_params.max_parallel) || 4)

  // ─── Derived stats ───
  const n_selected = $derived(selected.size)
  const n_total = $derived(structures.length)
</script>

<div class="batch-panel">
  <!-- ═══ Selection header ═══ -->
  <div class="bp-header">
    <span class="bp-count">{t('workflow.batch_selected_count', { selected: n_selected, total: n_total })}</span>
    <div class="bp-actions">
      <button class="bp-link" onclick={select_all}>{t('common.select_all')}</button>
      <button class="bp-link" onclick={select_none}>{t('common.deselect_all')}</button>
    </div>
  </div>

  <!-- ═══ 3D Preview ═══ -->
  <div class="bp-preview">
    {#key frame_idx}
      {#if current_structure}
        <StructurePreview structure={current_structure} />
      {:else}
        <div class="bp-empty">{t('workflow.we_no_structures')}</div>
      {/if}
    {/key}
  </div>

  <!-- ═══ Frame controls ═══ -->
  <div class="bp-controls">
    <button class="bp-nav" onclick={() => frame_idx = Math.max(0, frame_idx - 1)} disabled={frame_idx <= 0}>‹</button>
    <input type="range" class="bp-slider" min={0} max={Math.max(0, n_total - 1)} bind:value={frame_idx} />
    <button class="bp-nav" onclick={() => frame_idx = Math.min(n_total - 1, frame_idx + 1)} disabled={frame_idx >= n_total - 1}>›</button>
    <span class="bp-frame-num">{frame_idx + 1}/{n_total}</span>
  </div>

  <!-- ═══ Frame info ═══ -->
  <div class="bp-frame-info">
    <span class="bp-composition">{current_composition}</span>
    <span class="bp-atom-count">{t('common.atoms_count', { n: atom_count })}</span>
  </div>

  <!-- ═══ Selection checkbox ═══ -->
  <label class="bp-checkbox">
    <input type="checkbox" checked={selected.has(frame_idx)} onchange={() => toggle_selection(frame_idx)} />
    <span>{t('workflow.batch_include_in_batch', { n: frame_idx + 1 })}</span>
  </label>

  <!-- ═══ Structure list (compact) ═══ -->
  <div class="bp-list-section">
    <div class="bp-list">
      {#each structures as _, i}
        <button
          class="bp-list-item"
          class:active={i === frame_idx}
          class:deselected={!selected.has(i)}
          onclick={() => frame_idx = i}
        >
          <input type="checkbox" checked={selected.has(i)}
            onclick={(e: Event) => e.stopPropagation()}
            onchange={() => toggle_selection(i)} />
          <span class="bp-list-idx">#{i + 1}</span>
          <span class="bp-list-comp">{frame_compositions[i]}</span>
          {#if overrides[String(i)]}
            <span class="bp-override-dot" title={t('workflow.batch_has_custom_parameters')}></span>
          {/if}
        </button>
      {/each}
    </div>
  </div>

  <!-- ═══ Per-frame overrides ═══ -->
  <div class="bp-section">
    <div class="bp-section-title">
      {t('workflow.batch_overrides_for', { n: frame_idx + 1 })}
      {#if has_frame_overrides}<span class="bp-badge">{t('workflow.batch_custom')}</span>{/if}
    </div>

    <!-- MAGMOM -->
    <div class="bp-override-row">
      <label class="bp-override-key">MAGMOM</label>
      <input class="bp-override-input"
        placeholder={String(node_params.MAGMOM ?? 'auto')}
        value={frame_overrides.MAGMOM ?? ''}
        onchange={(e) => set_override(frame_idx, 'MAGMOM', (e.target as HTMLInputElement).value)} />
    </div>

    <!-- KPOINTS: 3 separate inputs for a, b, c -->
    {#if true}
    {@const kp_default = String(node_params.KPOINTS ?? '4x4x1').replace(/[×x,]/g, ' ').trim().split(/\s+/)}
    {@const kp_override = String(frame_overrides.KPOINTS ?? '').replace(/[×x,]/g, ' ').trim().split(/\s+/)}
    {@const kp_vals = [kp_override[0] || '', kp_override[1] || '', kp_override[2] || '']}
    <div class="bp-override-row">
      <label class="bp-override-key">KPOINTS</label>
      <div class="bp-kpoints-grid">
        {#each ['a', 'b', 'c'] as axis, i}
          <input class="bp-kpt-input" type="number" min="1" max="20"
            placeholder={kp_default[i] ?? (i === 2 ? '1' : '4')}
            value={kp_vals[i]}
            onchange={(e) => {
              const v = [...kp_vals]
              v[i] = (e.target as HTMLInputElement).value
              const combined = v.some(x => x) ? v.map((x, j) => x || kp_default[j] || '4').join('x') : ''
              set_override(frame_idx, 'KPOINTS', combined)
            }} />
        {/each}
      </div>
    </div>
    {/if}

    <!-- Edit INCAR button -->
    {#if on_edit_incar}
      <button class="bp-incar-btn" onclick={() => on_edit_incar?.(frame_idx)}>
        {t('workflow.batch_edit_incar_for', { n: frame_idx + 1 })}
      </button>
    {/if}

    {#if has_frame_overrides}
      <button class="bp-link bp-clear" onclick={clear_frame_overrides}>{t('common.reset')}</button>
    {/if}

    {#if n_overrides > 0}
      <div class="bp-override-summary">{t('workflow.batch_structures_with_custom_params', { n: n_overrides })}</div>
    {/if}
  </div>

  <!-- ═══ HPC settings ═══ -->
  <div class="bp-section">
    <div class="bp-setting">
      <label title={t('workflow.batch_concurrent_jobs_help')}>
        {t('workflow.batch_concurrent_jobs')}
      </label>
      <input type="number" class="bp-num-input" min={1} max={50}
        value={max_parallel}
        onchange={(e) => onparams_change({ ...node_params, max_parallel: Math.max(1, Math.min(50, Number((e.target as HTMLInputElement).value))) })} />
    </div>
    <div class="bp-setting-hint">{t('workflow.batch_concurrent_jobs_hint')}</div>
  </div>
</div>

<style>
  .batch-panel { display: flex; flex-direction: column; gap: 6px; padding: 8px 0; }

  /* Header */
  .bp-header { display: flex; justify-content: space-between; align-items: center; padding: 0 4px; }
  .bp-count { font-size: 13px; font-weight: 500; color: var(--text-color, #333); }
  .bp-actions { display: flex; gap: 8px; }
  .bp-link { background: none; border: none; color: var(--accent-color, #3b82f6); cursor: pointer; font-size: 12px; padding: 0; text-decoration: underline; }

  /* Preview */
  .bp-preview { height: 180px; border-radius: 6px; overflow: hidden; background: var(--input-bg, #f5f5f5); position: relative; }
  .bp-empty { display: flex; align-items: center; justify-content: center; height: 100%; color: var(--text-color-dim, #999); font-size: 12px; }

  /* Frame controls */
  .bp-controls { display: flex; align-items: center; gap: 4px; }
  .bp-nav { background: var(--input-bg, #f0f0f0); border: 1px solid var(--dialog-border, rgba(0,0,0,0.08)); border-radius: 4px; width: 26px; height: 26px; cursor: pointer; font-size: 14px; display: flex; align-items: center; justify-content: center; color: var(--text-color, #333); }
  .bp-nav:disabled { opacity: 0.3; cursor: default; }
  .bp-slider { flex: 1; height: 4px; accent-color: var(--accent-color, #3b82f6); }
  .bp-frame-num { font-size: 11px; color: var(--text-color-dim, #999); min-width: 36px; text-align: right; }

  /* Frame info */
  .bp-frame-info { display: flex; justify-content: space-between; align-items: center; padding: 0 2px; }
  .bp-composition { font-size: 12px; font-family: monospace; font-weight: 500; color: var(--text-color, #333); }
  .bp-atom-count { font-size: 11px; color: var(--text-color-dim, #999); }

  /* Checkbox */
  .bp-checkbox { display: flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer; padding: 2px 0; }
  .bp-checkbox input { accent-color: var(--accent-color, #3b82f6); }

  /* Structure list */
  .bp-list-section { max-height: 150px; overflow-y: auto; border: 1px solid var(--dialog-border, rgba(0,0,0,0.06)); border-radius: 6px; }
  .bp-list { display: flex; flex-direction: column; }
  .bp-list-item { display: flex; align-items: center; gap: 6px; padding: 3px 8px; border: none; background: none; cursor: pointer; font-size: 11px; text-align: left; color: var(--text-color, #333); border-bottom: 1px solid var(--dialog-border, rgba(0,0,0,0.03)); }
  .bp-list-item:last-child { border-bottom: none; }
  .bp-list-item.active { background: color-mix(in srgb, var(--accent-color, #3b82f6) 10%, transparent); }
  .bp-list-item.deselected { opacity: 0.4; }
  .bp-list-item input { accent-color: var(--accent-color, #3b82f6); width: 14px; height: 14px; }
  .bp-list-idx { font-weight: 500; min-width: 24px; color: var(--text-color-dim, #999); }
  .bp-list-comp { font-family: monospace; flex: 1; }
  .bp-override-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent-color, #3b82f6); flex-shrink: 0; }

  /* Sections */
  .bp-section { border-top: 1px solid var(--dialog-border, rgba(0,0,0,0.06)); padding-top: 8px; display: flex; flex-direction: column; gap: 4px; }
  .bp-section-title { font-size: 11px; font-weight: 600; color: var(--text-color-dim, #666); text-transform: uppercase; letter-spacing: 0.3px; display: flex; align-items: center; gap: 6px; }
  .bp-badge { font-size: 9px; background: var(--accent-color, #3b82f6); color: white; border-radius: 3px; padding: 1px 4px; text-transform: none; letter-spacing: 0; }

  /* Override rows */
  .bp-override-row { display: flex; align-items: center; gap: 8px; }
  .bp-override-key { font-size: 11px; font-family: monospace; min-width: 64px; color: var(--text-color, #333); }
  .bp-override-input { flex: 1; font-size: 11px; padding: 3px 6px; border: 1px solid var(--dialog-border, rgba(0,0,0,0.1)); border-radius: 4px; background: var(--input-bg, #fff); color: var(--text-color, #333); font-family: monospace; }
  .bp-override-input::placeholder { color: var(--text-color-dim, #bbb); }
  .bp-kpoints-grid { display: flex; gap: 4px; flex: 1; }
  .bp-kpt-input { width: 0; flex: 1; font-size: 11px; padding: 3px 4px; border: 1px solid var(--dialog-border, rgba(0,0,0,0.1)); border-radius: 4px; background: var(--input-bg, #fff); color: var(--text-color, #333); font-family: monospace; text-align: center; }
  .bp-kpt-input::placeholder { color: var(--text-color-dim, #bbb); }
  .bp-kpt-input::-webkit-inner-spin-button { opacity: 0.3; }
  .bp-override-summary { font-size: 10px; color: var(--accent-color, #3b82f6); }
  .bp-clear { font-size: 11px; margin-top: 2px; }

  .bp-incar-btn { font-size: 11px; padding: 4px 8px; border: 1px solid var(--dialog-border, rgba(0,0,0,0.1)); border-radius: 4px; background: var(--input-bg, #f5f5f5); color: var(--text-color, #333); cursor: pointer; text-align: center; }
  .bp-incar-btn:hover { background: var(--dialog-border, rgba(0,0,0,0.06)); }

  /* HPC settings */
  .bp-setting { display: flex; align-items: center; justify-content: space-between; }
  .bp-setting label { font-size: 12px; color: var(--text-color, #333); cursor: help; }
  .bp-num-input { width: 52px; font-size: 12px; padding: 3px 4px; border: 1px solid var(--dialog-border, rgba(0,0,0,0.1)); border-radius: 4px; background: var(--input-bg, #fff); color: var(--text-color, #333); text-align: center; }
  .bp-setting-hint { font-size: 10px; color: var(--text-color-dim, #999); }
</style>

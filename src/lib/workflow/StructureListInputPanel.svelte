<script lang="ts">
  import '$lib/dialog-shared.css'
  import type { PymatgenStructure } from '$lib'
  import type { NodeDefinition } from './workflow-types'
  import { STATUS_COLORS } from './workflow-types'
  import { parse_any_structure } from '$lib/structure/parse'
  import StructurePreview from '$lib/structure/StructurePreview.svelte'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'

  load_i18n_module('common')
  load_i18n_module('workflow')

  let {
    node,
    definition,
    status,
    onparams_change,
  }: {
    node: { id: string; type: string; params: Record<string, unknown> }
    definition: NodeDefinition
    status?: string
    onparams_change?: (params: Record<string, unknown>) => void
  } = $props()

  // ─── Local state ───
  let show_help = $state(false)
  let uploading = $state(false)
  let upload_error = $state<string | null>(null)
  let file_input_el = $state<HTMLInputElement | null>(null)

  // ─── Derived state ───
  const status_color = $derived(status ? STATUS_COLORS[status] ?? `#475569` : null)

  const structures = $derived.by(() => {
    const json_str = node.params.structures_json as string | undefined
    if (!json_str) return [] as PymatgenStructure[]
    try { return JSON.parse(json_str) as PymatgenStructure[] } catch { return [] as PymatgenStructure[] }
  })

  const count = $derived(structures.length)

  // Frame slider for preview
  let frame_idx = $state(0)

  // Clamp frame_idx when count changes
  $effect(() => {
    if (frame_idx >= count && count > 0) frame_idx = count - 1
    if (count === 0) frame_idx = 0
  })

  const current_structure = $derived(count > 0 ? structures[frame_idx] ?? null : null)

  const current_info = $derived.by(() => {
    if (!current_structure) return null
    const sites = current_structure.sites ?? []
    const species_counts: Record<string, number> = {}
    for (const site of sites) {
      const sp = site.species as Array<{ element: string }> | undefined
      const el = sp?.[0]?.element ?? (site.label as string) ?? `?`
      species_counts[el] = (species_counts[el] ?? 0) + 1
    }
    const formula = Object.entries(species_counts)
      .map(([el, n]) => (n === 1 ? el : `${el}${n}`))
      .join(``)
    return { formula, n_atoms: sites.length }
  })

  // ─── Helpers ───
  function update_params(structures_arr: PymatgenStructure[]) {
    onparams_change?.({
      ...node.params,
      structures_json: JSON.stringify(structures_arr),
      count: structures_arr.length,
    })
  }

  async function handle_files(files: FileList | null) {
    if (!files || files.length === 0) return
    uploading = true
    upload_error = null

    const new_structures: PymatgenStructure[] = [...structures]
    const errors: string[] = []

    for (const file of Array.from(files)) {
      try {
        const text = await file.text()
        const parsed = parse_any_structure(text, file.name)
        if (parsed) {
          new_structures.push(parsed as PymatgenStructure)
        } else {
          errors.push(file.name)
        }
      } catch {
        errors.push(file.name)
      }
    }

    if (new_structures.length > structures.length) {
      update_params(new_structures)
      // Jump to first newly added structure
      frame_idx = structures.length
    }

    if (errors.length > 0) {
      upload_error = t('workflow.structure_list_failed_parse', { files: errors.join(`, `) })
    }

    uploading = false
  }

  function handle_upload_click() {
    file_input_el?.click()
  }

  function handle_file_change(e: Event) {
    const input = e.target as HTMLInputElement
    handle_files(input.files)
    // Reset so same files can be re-selected
    input.value = ``
  }

  function clear_all() {
    update_params([])
    frame_idx = 0
    upload_error = null
  }

  function remove_current() {
    if (count === 0) return
    const new_structures = structures.filter((_, i) => i !== frame_idx)
    update_params(new_structures)
    if (frame_idx >= new_structures.length && new_structures.length > 0) {
      frame_idx = new_structures.length - 1
    }
  }
</script>

<div class="config-panel dialog-modal">
  <!-- Header -->
  <div class="panel-header">
    <div class="header-row">
      <div class="node-icon" style="background:{definition.color}20;border-color:{definition.color}50">
        {definition.icon}
      </div>
      <div class="header-info">
        <div class="node-label">{definition.label}</div>
        <div class="node-id">{node.id.slice(0, 16)}</div>
      </div>
      <button
        class="help-btn"
        class:active={show_help}
        onclick={() => show_help = !show_help}
        title={t('workflow.config_toggle_help')}
      >?</button>
    </div>
    {#if show_help}
      <div class="node-desc">{definition.description}</div>
    {/if}
    {#if status && status_color}
      <div
        class="status-badge"
        style="background:{status_color}15;border-color:{status_color}40;color:{status_color}"
      >
        <span class="status-dot" style="background:{status_color}"></span>
        {status}
      </div>
    {/if}
  </div>

  <!-- Display Name -->
  <div class="label-row">
    <label class="field-label">{t('workflow.config_display_name')}</label>
    <input
      type="text"
      class="field-input"
      placeholder={definition.label}
      value={node.params.label ?? ``}
      oninput={(e) => onparams_change?.({ ...node.params, label: e.currentTarget.value || undefined })}
    />
  </div>

  <!-- Upload Section -->
  <div class="upload-section">
    <div class="section-label">{t('workflow.structure_list_upload_structures')}</div>
    <input
      bind:this={file_input_el}
      type="file"
      multiple
      accept=".xyz,.cif,.poscar,.vasp,.pdb,.mol2,.data,.lammps,.lmp,.json,.yaml,.yml,.inp,.restart,.xml"
      onchange={handle_file_change}
      style="display:none"
    />
    <button class="action-btn import-btn" onclick={handle_upload_click} disabled={uploading}>
      {uploading ? t('workflow.structure_list_parsing') : t('workflow.structure_list_upload_files')}
    </button>
    <div class="upload-hint">
      {t('workflow.structure_list_supported_formats')}
    </div>
    {#if upload_error}
      <div class="upload-error">{upload_error}</div>
    {/if}
  </div>

  <!-- Status -->
  <div class="count-section">
    <div class="count-badge" class:has-structures={count > 0}>
      <span class="count-number">{count}</span>
      <span class="count-text">{t('workflow.structure_list_loaded_count', { n: count })}</span>
    </div>
    {#if count > 0}
      <div class="count-actions">
        <button class="small-btn remove-btn" onclick={remove_current} title={t('workflow.structure_list_remove_current')}>
          {t('workflow.structure_list_remove_n', { n: frame_idx + 1 })}
        </button>
        <button class="small-btn clear-btn" onclick={clear_all} title={t('workflow.structure_list_remove_all')}>
          {t('common.clear_all')}
        </button>
      </div>
    {/if}
  </div>

  <!-- Preview with frame slider -->
  {#if count > 0}
    <div class="preview-section">
      <div class="frame-controls">
        <button
          class="frame-btn"
          disabled={frame_idx <= 0}
          onclick={() => frame_idx = Math.max(0, frame_idx - 1)}
        >&lsaquo;</button>
        <input
          type="range"
          class="frame-slider"
          min={0}
          max={Math.max(0, count - 1)}
          bind:value={frame_idx}
        />
        <button
          class="frame-btn"
          disabled={frame_idx >= count - 1}
          onclick={() => frame_idx = Math.min(count - 1, frame_idx + 1)}
        >&rsaquo;</button>
      </div>
      <div class="frame-label">
        {t('workflow.structure_list_structure_n_of_total', { n: frame_idx + 1, total: count })}
        {#if current_info}
          &middot; {current_info.formula} &middot; {t('workflow.structure_panel_atoms_count', { n: current_info.n_atoms })}
        {/if}
      </div>
      {#if current_structure}
        <div class="preview-viewport">
          {#key frame_idx}
            <StructurePreview structure={current_structure} />
          {/key}
        </div>
      {/if}
    </div>
  {/if}

  <!-- Inputs / Outputs -->
  <div class="io-section">
    <div class="section-label">{t('workflow.config_inputs_outputs')}</div>
    <div class="io-row">
      <div class="io-col">
        <span class="io-heading">{t('common.input')}</span>
        <span class="io-item io-none">{t('workflow.node_none')}</span>
      </div>
      <div class="io-arrow">&rarr;</div>
      <div class="io-col">
        <span class="io-heading">{t('common.output')}</span>
        {#each definition.outputs as out}
          <span class="io-item">{out}</span>
        {/each}
      </div>
    </div>
  </div>

  <!-- Reset -->
  <div class="footer-actions">
    <button class="reset-btn" onclick={() => {
      onparams_change?.({ ...definition.default_params })
      frame_idx = 0
      upload_error = null
    }}>
      {t('workflow.config_reset_to_defaults')}
    </button>
  </div>
</div>

<style>
  .config-panel {
    display: flex;
    flex-direction: column;
    gap: 0;
    height: 100%;
    overflow-y: auto;
    color: var(--text-color, light-dark(#374151, #eee));
    font-family: 'SF Mono', 'Cascadia Code', 'JetBrains Mono', monospace;
    font-size: 12px;
    background: var(--dialog-bg, light-dark(#fff, #1c1d21));
  }

  /* ─── Header ─── */
  .panel-header {
    padding: 12px;
    border-bottom: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
  }
  .header-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }
  .node-icon {
    width: 34px;
    height: 34px;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 18px;
    border: 1px solid;
    flex-shrink: 0;
  }
  .header-info { flex: 1; min-width: 0; }
  .node-label {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-color, light-dark(#1f2937, #eee));
  }
  .node-id {
    font-size: 9px;
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
    margin-top: 1px;
  }
  .help-btn {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255, 255, 255, 0.05)));
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
    font-size: 11px;
    font-weight: 700;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: all 0.15s;
    font-family: inherit;
  }
  .help-btn:hover,
  .help-btn.active {
    background: light-dark(rgba(0,0,0,0.06), #1a3050);
    border-color: var(--accent-color, light-dark(#4f46e5, #3b82f6));
    color: var(--accent-color, light-dark(#4f46e5, #3b82f6));
  }
  .node-desc {
    font-size: 10px;
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
    line-height: 1.5;
  }
  .status-badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 3px 8px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 600;
    border: 1px solid;
    margin-top: 8px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .status-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  /* ─── Display Name ─── */
  .label-row {
    padding: 6px 12px;
    border-bottom: 1px solid var(--border-color, light-dark(#e5e7eb, #2d333b));
  }
  .label-row .field-label {
    display: block;
    font-size: 10px;
    font-weight: 600;
    color: var(--text-color-muted, light-dark(#6b7280, #768390));
    margin-bottom: 3px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .label-row .field-input {
    width: 100%;
    box-sizing: border-box;
    padding: 4px 8px;
    font-size: 11px;
    font-family: inherit;
    border: 1px solid var(--border-color, light-dark(#d1d5db, #373e47));
    border-radius: 4px;
    background: var(--input-bg, light-dark(#f9fafb, #22272e));
    color: var(--text-color, light-dark(#374151, #adbac7));
  }

  /* ─── Upload Section ─── */
  .upload-section {
    padding: 10px 12px;
    border-bottom: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
  }
  .section-label {
    font-size: 9px;
    font-weight: 700;
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
    text-transform: uppercase;
    letter-spacing: 1.5px;
    margin-bottom: 8px;
  }
  .upload-hint {
    font-size: 9px;
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
    margin-top: 6px;
    line-height: 1.4;
  }
  .upload-error {
    font-size: 10px;
    color: var(--error-color, light-dark(#dc2626, #ef4444));
    margin-top: 6px;
    padding: 4px 6px;
    background: light-dark(rgba(220,38,38,0.08), rgba(239,68,68,0.1));
    border-radius: 4px;
  }

  /* ─── Count Section ─── */
  .count-section {
    padding: 10px 12px;
    border-bottom: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .count-badge {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border-radius: 6px;
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255,255,255,0.05)));
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #3a3a3a));
  }
  .count-badge.has-structures {
    background: color-mix(in srgb, #10b981 12%, transparent);
    border-color: color-mix(in srgb, #10b981 30%, transparent);
  }
  .count-number {
    font-size: 16px;
    font-weight: 700;
    color: var(--text-color, light-dark(#374151, #eee));
  }
  .has-structures .count-number {
    color: #10b981;
  }
  .count-text {
    font-size: 10px;
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
  }
  .count-actions {
    display: flex;
    gap: 4px;
  }
  .small-btn {
    padding: 3px 8px;
    font-size: 9px;
    font-family: inherit;
    border-radius: 4px;
    cursor: pointer;
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255,255,255,0.05)));
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
    transition: all 0.15s;
  }
  .small-btn:hover {
    background: var(--dialog-border, light-dark(#d1d5db, #404040));
  }
  .clear-btn:hover {
    border-color: #ef4444;
    color: #ef4444;
  }

  /* ─── Preview Section ─── */
  .preview-section {
    margin: 4px 12px 8px;
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    border-radius: 6px;
    overflow: hidden;
  }
  .frame-controls {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 8px;
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255,255,255,0.05)));
    border-bottom: 1px solid var(--dialog-border, light-dark(#d1d5db, #3a3a3a));
  }
  .frame-btn {
    width: 24px;
    height: 24px;
    border-radius: 4px;
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255,255,255,0.05)));
    color: var(--text-color, light-dark(#374151, #eee));
    cursor: pointer;
    font-size: 14px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    font-family: inherit;
    transition: all 0.15s;
  }
  .frame-btn:hover:not(:disabled) {
    background: var(--dialog-border, light-dark(#d1d5db, #404040));
    border-color: var(--accent-color, light-dark(#4f46e5, #3b82f6));
  }
  .frame-btn:disabled {
    opacity: 0.3;
    cursor: default;
  }
  .frame-slider {
    flex: 1;
    height: 4px;
    accent-color: var(--accent-color, #3b82f6);
  }
  .frame-label {
    padding: 3px 8px;
    font-size: 10px;
    color: var(--text-color-dim, light-dark(#9ca3af, #999));
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255,255,255,0.05)));
    border-bottom: 1px solid var(--dialog-border, light-dark(#d1d5db, #3a3a3a));
    text-align: center;
  }
  .preview-viewport {
    height: 220px;
    position: relative;
    background: #111;
  }

  /* ─── Action Buttons ─── */
  .action-btn {
    width: 100%;
    padding: 6px 10px;
    border-radius: 5px;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    font-family: inherit;
    transition: all 0.15s;
    text-align: center;
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255, 255, 255, 0.05)));
    color: var(--text-color, light-dark(#374151, #eee));
  }
  .action-btn:hover:not(:disabled) {
    background: var(--dialog-border, light-dark(#d1d5db, #404040));
    border-color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
  }
  .action-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .import-btn {
    background: color-mix(in srgb, var(--accent-color, #3b82f6) 12%, transparent);
    border-color: color-mix(in srgb, var(--accent-color, #3b82f6) 30%, transparent);
    color: var(--accent-color, light-dark(#4f46e5, #3b82f6));
  }
  .import-btn:hover:not(:disabled) {
    background: color-mix(in srgb, var(--accent-color, #3b82f6) 20%, transparent);
  }

  /* ─── IO Section ─── */
  .io-section {
    padding: 10px 12px;
    border-top: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255, 255, 255, 0.05)));
  }
  .io-row {
    display: flex;
    align-items: flex-start;
    gap: 8px;
  }
  .io-col {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .io-heading {
    font-size: 9px;
    font-weight: 700;
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
    letter-spacing: 1px;
    margin-bottom: 2px;
  }
  .io-item {
    font-size: 10px;
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
    padding: 1px 6px;
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255, 255, 255, 0.05)));
    border-radius: 3px;
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #3a3a3a));
    display: inline-block;
    margin-bottom: 2px;
  }
  .io-item.io-none {
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
    font-style: italic;
    border-color: transparent;
    background: none;
  }
  .io-arrow {
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
    font-size: 14px;
    padding-top: 14px;
    flex-shrink: 0;
  }

  /* ─── Footer ─── */
  .footer-actions {
    padding: 10px 12px;
    border-top: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
  }
  .reset-btn {
    width: 100%;
    padding: 5px 10px;
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255, 255, 255, 0.05)));
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    border-radius: 5px;
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
    font-size: 11px;
    font-family: inherit;
    cursor: pointer;
    transition: all 0.15s;
  }
  .reset-btn:hover {
    background: light-dark(rgba(0,0,0,0.08), #1a2540);
    border-color: var(--accent-hover-color, light-dark(#3730a3, #2563eb));
    color: var(--text-color, light-dark(#374151, #eee));
  }
</style>

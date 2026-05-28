<script lang="ts">
  import '$lib/dialog-shared.css'
  import type { PymatgenStructure } from '$lib'
  import type { NodeDefinition } from './workflow-types'
  import { STATUS_COLORS } from './workflow-types'
  import { validate_frame_selection, parse_frame_selection } from './frame-selection'
  import StructurePreview from '$lib/structure/StructurePreview.svelte'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'

  load_i18n_module('common')
  load_i18n_module('workflow')

  let {
    node,
    definition,
    status,
    onparams_change,
    onimport,
    onedit_3d,
  }: {
    node: { id: string; type: string; params: Record<string, unknown> }
    definition: NodeDefinition
    status?: string
    onparams_change?: (params: Record<string, unknown>) => void
    onimport?: () => void
    onedit_3d?: () => void
  } = $props()

  // ─── Local state ───
  let show_help = $state(false)

  // ─── Derived state ───
  const status_color = $derived(status ? STATUS_COLORS[status] ?? `#475569` : null)
  const has_structure = $derived(!!node.params.structure_json)
  const n_frames = $derived((node.params.n_frames as number) ?? 0)
  const is_trajectory = $derived(n_frames > 1)
  const frame_selection_str = $derived((node.params.frame_selection as string) ?? ``)

  let frame_error = $state<string | null>(null)

  // ─── Extract structure preview info from structure_json ───
  const preview = $derived.by(() => {
    const json_str = node.params.structure_json as string | undefined
    if (!json_str) return null
    try {
      const data = JSON.parse(json_str) as Record<string, unknown>
      const lattice = data.lattice as Record<string, unknown> | undefined
      const sites = (data.sites as unknown[]) ?? []
      const matrix = lattice?.matrix as number[][] | undefined

      let a = 0, b = 0, c = 0, alpha = 90, beta = 90, gamma = 90
      if (matrix && matrix.length === 3) {
        const vec_len = (v: number[]) => Math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2)
        const dot = (u: number[], v: number[]) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2]
        const angle = (u: number[], v: number[]) =>
          Math.acos(Math.max(-1, Math.min(1, dot(u, v) / (vec_len(u) * vec_len(v))))) * 180 / Math.PI
        a = vec_len(matrix[0])
        b = vec_len(matrix[1])
        c = vec_len(matrix[2])
        alpha = angle(matrix[1], matrix[2])
        beta = angle(matrix[0], matrix[2])
        gamma = angle(matrix[0], matrix[1])
      } else if (lattice) {
        a = (lattice.a as number) ?? 0
        b = (lattice.b as number) ?? 0
        c = (lattice.c as number) ?? 0
        alpha = (lattice.alpha as number) ?? 90
        beta = (lattice.beta as number) ?? 90
        gamma = (lattice.gamma as number) ?? 90
      }

      const species_counts: Record<string, number> = {}
      for (const site of sites) {
        const s = site as Record<string, unknown>
        const sp = s.species as Array<{ element: string }> | undefined
        const el = sp?.[0]?.element ?? (s.label as string) ?? `?`
        species_counts[el] = (species_counts[el] ?? 0) + 1
      }
      const formula = Object.entries(species_counts)
        .map(([el, n]) => (n === 1 ? el : `${el}${n}`))
        .join(``)

      return {
        formula: formula || (data.formula as string) || `Unknown`,
        n_atoms: sites.length,
        lattice: lattice ? {
          a: +a.toFixed(4), b: +b.toFixed(4), c: +c.toFixed(4),
          alpha: +alpha.toFixed(2), beta: +beta.toFixed(2), gamma: +gamma.toFixed(2),
        } : null,
      }
    } catch {
      return null
    }
  })

  // ─── Parsed structure for 3D preview ───
  const preview_structure = $derived.by(() => {
    const json_str = node.params.structure_json as string | undefined
    if (!json_str) return null
    try { return JSON.parse(json_str) as PymatgenStructure } catch { return null }
  })

  // ─── Output type auto-detection ───
  const output_type = $derived.by(() => {
    if (!is_trajectory) return `structure`
    if (!frame_selection_str.trim()) return `trajectory` // empty = all frames
    const indices = parse_frame_selection(frame_selection_str, n_frames)
    return indices.length === 1 ? `structure` : `trajectory`
  })

  // ─── Helpers ───
  function update_param(key: string, value: unknown) {
    onparams_change?.({ ...node.params, [key]: value })
  }

  function handle_frame_input(e: Event) {
    const val = (e.target as HTMLInputElement).value
    const err = validate_frame_selection(val, n_frames)
    frame_error = err
    if (!err) {
      update_param(`frame_selection`, val)
    }
  }

  function reset_to_defaults() {
    onparams_change?.({ ...definition.default_params })
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

  <!-- Structure Info -->
  <div class="info-area">
    {#if has_structure && preview}
      <div class="struct-section">
        <div class="section-label">{t('common.structure')}</div>
        <div class="info-grid">
          <div class="info-item formula-item">
            <span class="info-label">{t('common.formula')}</span>
            <span class="info-value formula-value">{preview.formula}</span>
          </div>
          <div class="info-item">
            <span class="info-label">{t('common.atoms')}</span>
            <span class="info-value">{preview.n_atoms}</span>
          </div>
          {#if preview.lattice}
            <div class="info-item">
              <span class="info-label">a</span>
              <span class="info-value">{preview.lattice.a} &#197;</span>
            </div>
            <div class="info-item">
              <span class="info-label">b</span>
              <span class="info-value">{preview.lattice.b} &#197;</span>
            </div>
            <div class="info-item">
              <span class="info-label">c</span>
              <span class="info-value">{preview.lattice.c} &#197;</span>
            </div>
            <div class="info-item">
              <span class="info-label">&alpha;</span>
              <span class="info-value">{preview.lattice.alpha}&deg;</span>
            </div>
            <div class="info-item">
              <span class="info-label">&beta;</span>
              <span class="info-value">{preview.lattice.beta}&deg;</span>
            </div>
            <div class="info-item">
              <span class="info-label">&gamma;</span>
              <span class="info-value">{preview.lattice.gamma}&deg;</span>
            </div>
          {/if}
        </div>
      </div>

      <!-- Frame Selector (multi-frame only) -->
      {#if is_trajectory}
        <div class="frame-section">
          <div class="section-label">{t('common.trajectory')}</div>
          <div class="frame-count">{t('workflow.structure_panel_frames_loaded', { n: n_frames })}</div>
          <div class="frame-field">
            <label class="field-label" for="frame-sel">{t('workflow.structure_panel_frame_selection')}</label>
            <input
              id="frame-sel"
              class="field-input"
              type="text"
              placeholder={t('workflow.structure_panel_frame_placeholder')}
              value={frame_selection_str}
              oninput={handle_frame_input}
            />
            {#if frame_error}
              <div class="frame-error">{frame_error}</div>
            {/if}
            <div class="output-type">
              {t('common.output')}: <strong>{output_type === `structure` ? t('common.structure') : t('common.trajectory')}</strong>
              {#if frame_selection_str.trim()}
                ({t('workflow.structure_panel_frame_count', { n: parse_frame_selection(frame_selection_str, n_frames).length })})
              {:else}
                ({t('workflow.structure_panel_all_frames', { n: n_frames })})
              {/if}
            </div>
          </div>
        </div>
      {/if}
    {:else}
      <div class="empty-struct">
        <div class="empty-icon">&#128196;</div>
        <div class="empty-text">{t('workflow.structure_panel_no_structure')}</div>
        <div class="empty-hint">{t('workflow.structure_panel_click_import')}</div>
      </div>
    {/if}
  </div>

  <!-- 3D Preview -->
  {#if preview_structure}
    <div class="preview-section">
      <div class="preview-viewport">
        <StructurePreview structure={preview_structure} />
      </div>
      <div class="preview-bar">
        <span>{preview?.formula ?? ``} &middot; {t('workflow.structure_panel_atoms_count', { n: preview?.n_atoms ?? 0 })}</span>
        {#if onedit_3d}
          <button class="preview-expand" onclick={() => onedit_3d?.()} title={t('workflow.calc_open_full_viewer')}>&#x26F6;</button>
        {/if}
      </div>
    </div>
  {/if}

  <!-- Action Buttons -->
  <div class="actions-section">
    <button class="action-btn import-btn" onclick={() => onimport?.()}>
      {has_structure ? t('workflow.structure_panel_reimport_structure') : t('workflow.structure_panel_import_structure')}
    </button>
    {#if has_structure}
      <button class="action-btn edit3d-btn" onclick={() => onedit_3d?.()}>
        {t('workflow.structure_panel_edit_3d')}
      </button>
    {/if}
  </div>

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
    <button class="reset-btn" onclick={reset_to_defaults}>
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

  /* ─── Info Area ─── */
  .info-area {
    flex: 1;
    padding: 0;
  }

  .section-label {
    font-size: 9px;
    font-weight: 700;
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
    text-transform: uppercase;
    letter-spacing: 1.5px;
    margin-bottom: 8px;
  }

  .struct-section {
    padding: 10px 12px;
    border-bottom: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
  }

  .info-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
  }
  .info-item {
    display: flex;
    flex-direction: column;
    gap: 1px;
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255, 255, 255, 0.05)));
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #3a3a3a));
    border-radius: 5px;
    padding: 4px 6px;
  }
  .info-item.formula-item {
    grid-column: span 2;
  }
  .info-label {
    font-size: 9px;
    font-weight: 700;
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
    text-transform: uppercase;
    letter-spacing: 0.8px;
  }
  .info-value {
    font-size: 11px;
    color: var(--text-color, light-dark(#374151, #eee));
  }
  .formula-value {
    font-weight: 700;
    color: var(--accent-color, light-dark(#4f46e5, #3b82f6));
    font-size: 13px;
  }

  /* ─── Frame Section ─── */
  .frame-section {
    padding: 10px 12px;
    border-bottom: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
  }
  .frame-count {
    font-size: 11px;
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
    margin-bottom: 8px;
  }
  .frame-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .field-label {
    font-size: 11px;
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
    font-weight: 500;
  }
  .field-input {
    width: 100%;
    padding: 4px 6px;
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255, 255, 255, 0.05)));
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    border-radius: 4px;
    color: var(--text-color, light-dark(#374151, #eee));
    font-size: 12px;
    font-family: inherit;
    outline: none;
    box-sizing: border-box;
    transition: border-color 0.15s;
  }
  .field-input:focus {
    border-color: var(--accent-color, light-dark(#4f46e5, #3b82f6));
  }
  .frame-error {
    font-size: 10px;
    color: var(--error-color, light-dark(#dc2626, #ef4444));
  }
  .output-type {
    font-size: 10px;
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
    margin-top: 2px;
  }
  .output-type strong {
    color: var(--accent-color, light-dark(#4f46e5, #3b82f6));
    text-transform: uppercase;
    font-size: 9px;
    letter-spacing: 0.5px;
  }

  /* ─── Empty state ─── */
  .empty-struct {
    padding: 24px 12px;
    text-align: center;
  }
  .empty-icon {
    font-size: 28px;
    opacity: 0.4;
    margin-bottom: 8px;
  }
  .empty-text {
    font-size: 12px;
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
    font-weight: 600;
    margin-bottom: 4px;
  }
  .empty-hint {
    font-size: 10px;
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
  }

  /* ─── 3D Preview ─── */
  .preview-section {
    margin: 4px 12px 8px;
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    border-radius: 6px;
    overflow: hidden;
  }
  .preview-viewport {
    height: 220px;
    position: relative;
    background: #111;
  }
  .preview-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 3px 8px;
    font-size: 10px;
    color: var(--text-color-dim, light-dark(#9ca3af, #999));
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255,255,255,0.05)));
  }
  .preview-expand {
    background: none;
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
    cursor: pointer;
    border-radius: 3px;
    padding: 1px 5px;
    font-size: 0.8rem;
    line-height: 1;
  }
  .preview-expand:hover {
    background: color-mix(in srgb, var(--accent-color, light-dark(#4f46e5, #4fc3f7)) 20%, transparent);
    border-color: var(--accent-color, light-dark(#4f46e5, #4fc3f7));
  }

  /* ─── Action Buttons ─── */
  .actions-section {
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    border-bottom: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
  }
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
  .action-btn:hover {
    background: var(--dialog-border, light-dark(#d1d5db, #404040));
    border-color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
  }
  .import-btn {
    background: color-mix(in srgb, var(--accent-color, #3b82f6) 12%, transparent);
    border-color: color-mix(in srgb, var(--accent-color, #3b82f6) 30%, transparent);
    color: var(--accent-color, light-dark(#4f46e5, #3b82f6));
  }
  .import-btn:hover {
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

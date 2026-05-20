<script lang="ts">
  import { DraggablePane } from '$lib'
  import { API_BASE } from '$lib/api/config'
  import FileSourceDialog from '$lib/electronic/FileSourceDialog.svelte'
  import { download } from '$lib/io/fetch'
  import type { AnyStructure, PymatgenStructure } from '$lib/structure/index'
  import PluginResultPane from '$lib/structure/PluginResultPane.svelte'
  import { parse_structure_file } from '$lib/structure/parse'
  import type { Hkl, RadiationKey, XrdPattern } from '$lib/xrd'
  import { WAVELENGTHS } from '$lib/xrd/calc-xrd'
  import { onMount, type Snippet } from 'svelte'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'

  // Lazy-load structure translations
  load_i18n_module('structure')

  export type AnalysisTab = 'electronic' | 'md' | 'phase' | 'structure_analysis' | 'spectrum' | 'vibration' | string

  const static_tab_defs: { id: AnalysisTab; label: () => string }[] = [
    { id: 'electronic', label: () => t('structure.electronic') },
    { id: 'md', label: () => t('structure.md') },
    { id: 'phase', label: () => t('structure.phase') },
    { id: 'structure_analysis', label: () => t('structure.structure_tab') },
    { id: 'spectrum', label: () => t('structure.spectrum') },
    { id: 'vibration', label: () => t('structure.vibration') },
  ]

  interface PluginTabDef {
    id: string
    label: string
    analyzer_id: string
    output_type: string
  }

  let plugin_tab_defs = $state<PluginTabDef[]>([])
  let tab_defs = $derived([...static_tab_defs, ...plugin_tab_defs.map(p => ({ id: p.id, label: () => p.label }))])

  onMount(async () => {
    try {
      const resp = await fetch(`${API_BASE}/plugins/analyzers`)
      if (!resp.ok) return
      const data = await resp.json()
      plugin_tab_defs = (data.analyzers || [])
        .filter((a: any) => a.enabled !== false)
        .map((a: any) => ({
          id: `plugin_${a.analyzer_id}`,
          label: a.display_name || a.analyzer_id,
          analyzer_id: a.analyzer_id,
          output_type: a.output_type || `json`,
        }))
    } catch (e) {
      console.warn(`[AnalysisPane] Failed to load plugin analyzers:`, e)
    }
  })

  const radiation_groups: { label: string; keys: RadiationKey[] }[] = [
    { label: `Cu`, keys: [`CuKa`, `CuKa1`, `CuKa2`, `CuKb1`] },
    { label: `Mo`, keys: [`MoKa`, `MoKa1`, `MoKa2`, `MoKb1`] },
    { label: `Cr`, keys: [`CrKa`, `CrKa1`, `CrKa2`, `CrKb1`] },
    { label: `Fe`, keys: [`FeKa`, `FeKa1`, `FeKa2`, `FeKb1`] },
    { label: `Co`, keys: [`CoKa`, `CoKa1`, `CoKa2`, `CoKb1`] },
    { label: `Ag`, keys: [`AgKa`, `AgKa1`, `AgKa2`, `AgKb1`] },
  ]

  interface PinnedXrdPattern {
    id: string
    label: string
    pattern: XrdPattern
    radiation: RadiationKey
    color: string
    visible: boolean
  }

  let {
    show = $bindable(false),
    active_tab = $bindable<AnalysisTab>('electronic'),
    max_height = '',
    structure = undefined,
    // XRD state — computed in Structure.svelte, displayed here as controls
    xrd_radiation = $bindable<RadiationKey>(`CuKa`),
    xrd_pattern = null,
    xrd_loading = false,
    xrd_error = undefined,
    // Pinned XRD comparison
    pinned_xrd_patterns = [],
    on_pin_current = undefined,
    on_unpin = undefined,
    on_toggle_pinned = undefined,
    on_structure_import = undefined,
    children,
  }: {
    show?: boolean
    active_tab?: AnalysisTab
    max_height?: string
    structure?: AnyStructure
    xrd_radiation?: RadiationKey
    xrd_pattern?: XrdPattern | null
    xrd_loading?: boolean
    xrd_error?: string | undefined
    pinned_xrd_patterns?: PinnedXrdPattern[]
    on_pin_current?: () => void
    on_unpin?: (id: string) => void
    on_toggle_pinned?: (id: string) => void
    on_structure_import?: (structure: AnyStructure) => void
    children?: Snippet
  } = $props()

  // Structure import dialog for Spectrum tab
  let show_structure_dialog = $state(false)
  let import_error = $state(``)

  async function handle_structure_file(file: File) {
    import_error = ``
    try {
      const text = await file.text()
      const parsed = parse_structure_file(text, file.name)
      if (!parsed) throw new Error(`Could not parse structure from ${file.name}`)
      on_structure_import?.(parsed)
    } catch (e: any) {
      import_error = e.message || `Failed to parse structure`
    }
  }

  async function handle_structure_remote(session_id: string, path: string) {
    import_error = ``
    try {
      const resp = await fetch(`${API_BASE}/hpc/download?session_id=${encodeURIComponent(session_id)}&remote_path=${encodeURIComponent(path)}`)
      if (!resp.ok) throw new Error(`Download failed: ${resp.statusText}`)
      const text = await resp.text()
      const filename = path.split(`/`).pop() || `structure`
      const parsed = parse_structure_file(text, filename)
      if (!parsed) throw new Error(`Could not parse structure from ${filename}`)
      on_structure_import?.(parsed)
    } catch (e: any) {
      import_error = e.message || `Failed to load structure`
    }
  }

  let has_lattice = $derived(
    !!structure && `lattice` in structure && !!(structure as PymatgenStructure).lattice,
  )

  function format_hkl(hkl: Hkl): string {
    return hkl.map((v) => {
      if (v < 0) {
        const digits = String(Math.abs(v))
        return digits.split(``).map((d) => `${d}\u0305`).join(``)
      }
      return `${v}`
    }).join(``)
  }

  // --- Export helpers ---
  function export_csv() {
    if (!xrd_pattern) return
    const { x, y, hkls, d_hkls } = xrd_pattern
    const header = `2theta,intensity,d_spacing,hkl`
    const rows = x.map((angle, idx) => {
      const d = d_hkls?.[idx]?.toFixed(4) ?? ``
      const hkl_str = hkls?.[idx]
        ?.map((h) => `(${h.hkl.join(` `)})`)
        .join(`; `) ?? ``
      return `${angle.toFixed(4)},${y[idx].toFixed(4)},${d},"${hkl_str}"`
    })
    const csv = [header, ...rows].join(`\n`)
    download(csv, `xrd_pattern_${xrd_radiation}.csv`, `text/csv`)
  }

  function export_json() {
    if (!xrd_pattern) return
    const data = {
      radiation: xrd_radiation,
      wavelength: WAVELENGTHS[xrd_radiation],
      two_theta: xrd_pattern.x,
      intensity: xrd_pattern.y,
      d_spacings: xrd_pattern.d_hkls,
      hkls: xrd_pattern.hkls,
    }
    const json = JSON.stringify(data, null, 2)
    download(json, `xrd_pattern_${xrd_radiation}.json`, `application/json`)
  }
</script>

<DraggablePane
  bind:show
  show_toggle={false}
  close_on_click_outside={false}
  max_width="24em"
  max_height={max_height || ``}
  pane_props={{ class: 'analysis-pane' }}
>
  <h4 class="pane-title">{t('structure.analysis')}</h4>
  <div class="tab-bar">
    {#each tab_defs as tab}
      <button
        class:active={active_tab === tab.id}
        onclick={() => active_tab = tab.id}
        title={tab.label()}
      >
        {tab.label()}
      </button>
    {/each}
  </div>
  <div class="pane-content">
    {#if active_tab === 'spectrum'}
      <!-- XRD 始终用 AnalysisPane 内部 UI，不被 children 覆盖 -->
      <section class="spectrum-section">
        <h5>{t('structure.xrd_pattern')}</h5>

        {#if !structure}
          <p class="warning">{t('structure.xrd_no_structure')}</p>
          {#if on_structure_import}
            <button class="import-structure-btn" onclick={() => show_structure_dialog = true}>{t('structure.import_structure')}</button>
          {/if}
          {#if import_error}<p class="error-msg">{import_error}</p>{/if}
        {:else if !has_lattice}
          <p class="warning">{t('structure.xrd_requires_lattice')}</p>
        {:else}
          <label class="setting-row">
            <span>{t('structure.radiation')}</span>
            <select bind:value={xrd_radiation}>
              {#each radiation_groups as group}
                <optgroup label={group.label}>
                  {#each group.keys as key}
                    <option value={key}>{key} ({WAVELENGTHS[key].toFixed(4)} &#197;)</option>
                  {/each}
                </optgroup>
              {/each}
            </select>
          </label>

          {#if xrd_error}
            <p class="error-msg">{xrd_error}</p>
          {:else if xrd_loading}
            <p class="hint">{t('structure.xrd_computing')}</p>
          {:else if xrd_pattern && xrd_pattern.x.length > 0}
            <p class="hint">{t('structure.xrd_computed', { n: xrd_pattern.x.length })}</p>

            <div class="export-row">
              <button onclick={export_csv} title={t('structure.export_csv_title')}>
                {t('structure.export_csv')}
              </button>
              <button onclick={export_json} title={t('structure.export_json_title')}>
                {t('structure.export_json')}
              </button>
              {#if on_pin_current}
                <button
                  onclick={on_pin_current}
                  disabled={!xrd_pattern}
                  title={t('structure.pin_title')}
                  class="pin-btn"
                >
                  {t('structure.pin')}
                </button>
              {/if}
            </div>
          {:else}
            <p class="hint">{t('structure.no_xrd_peaks')}</p>
          {/if}
        {/if}

        {#if pinned_xrd_patterns.length > 0}
          <div class="pinned-section">
            <h6 class="pinned-title">{t('structure.pinned_patterns', { n: pinned_xrd_patterns.length })}</h6>
            <ul class="pinned-list">
              {#each pinned_xrd_patterns as pinned (pinned.id)}
                <li class="pinned-item" class:dimmed={!pinned.visible}>
                  <span class="color-dot" style="background: {pinned.color}"></span>
                  <span class="pinned-label" title={pinned.label}>{pinned.label}</span>
                  <button
                    class="pinned-action"
                    onclick={() => on_toggle_pinned?.(pinned.id)}
                    title={pinned.visible ? t('common.hide') : t('common.show')}
                  >{pinned.visible ? '👁' : '👁‍🗨'}</button>
                  <button
                    class="pinned-action remove"
                    onclick={() => on_unpin?.(pinned.id)}
                    title={t('common.remove')}
                  >×</button>
                </li>
              {/each}
            </ul>
          </div>
        {/if}
      </section>
    {:else if children}
      {@render children()}
    {:else}
      {#if active_tab === 'electronic'}
        <section class="module-placeholder">
          <h5>{t('structure.electronic_structure')}</h5>
          <ul>
            <li>{t('structure.band_structure')}</li>
            <li>{t('structure.dos')}</li>
            <li>{t('structure.charge_density')}</li>
            <li>{t('structure.orbital_analysis')}</li>
          </ul>
        </section>
      {:else if active_tab === 'md'}
        <section class="module-placeholder">
          <h5>{t('structure.molecular_dynamics')}</h5>
          <ul>
            <li>{t('structure.rdf')}</li>
            <li>{t('structure.msd')}</li>
            <li>{t('structure.diffusion_coef')}</li>
            <li>{t('structure.vacf')}</li>
            <li>{t('structure.temperature_profile')}</li>
          </ul>
        </section>
      {:else if active_tab === 'phase'}
        <section class="module-placeholder">
          <h5>{t('structure.phase_analysis')}</h5>
          <ul>
            <li>{t('structure.phase_diagram')}</li>
            <li>{t('structure.convex_hull')}</li>
            <li>{t('structure.stability_analysis')}</li>
            <li>{t('structure.formation_energy')}</li>
          </ul>
        </section>
      {:else if active_tab === 'structure_analysis'}
        <section class="module-placeholder">
          <h5>{t('structure.structure_analysis')}</h5>
          <ul>
            <li>{t('structure.symmetry_analysis')}</li>
            <li>{t('structure.coordination_env')}</li>
            <li>{t('structure.voronoi')}</li>
            <li>{t('structure.bond_valence')}</li>
          </ul>
        </section>
      {/if}

      {#if typeof active_tab === 'string' && active_tab.startsWith('plugin_')}
        {@const plugin_info = plugin_tab_defs.find(t => t.id === active_tab)}
        {#if plugin_info}
          <PluginResultPane
            analyzer_id={plugin_info.analyzer_id}
            output_type={plugin_info.output_type}
            display_name={plugin_info.label}
            {structure}
          />
        {/if}
      {/if}
    {/if}
  </div>
</DraggablePane>

<FileSourceDialog
  bind:show={show_structure_dialog}
  file_types={[`.cif`, `.vasp`, `.poscar`, `.xyz`, `.json`, `.pdb`]}
  title={t('structure.import_structure_xrd')}
  description={t('structure.import_structure_desc')}
  onfile={handle_structure_file}
  onremote_path={handle_structure_remote}
  onclose={() => show_structure_dialog = false}
/>

<style>
  .tab-bar {
    grid-template-columns: repeat(auto-fill, minmax(4.5em, 1fr));
  }
  .spectrum-section {
    padding: 8px;
    background: var(--pane-card-bg, rgba(255, 255, 255, 0.04));
    border-radius: 6px;
  }
  .spectrum-section h5 {
    margin: 0 0 8px;
    font-size: 0.85em;
    font-weight: 600;
    color: var(--text-color, #fff);
  }
  .setting-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 8px;
    font-size: 0.8em;
    color: var(--text-color, #fff);
  }
  .setting-row select {
    flex: 1;
    max-width: 65%;
    padding: 3px 6px;
    border-radius: 4px;
    border: 1px solid var(--pane-input-border);
    background: var(--pane-input-bg);
    color: var(--text-color);
    font-size: 0.85em;
  }
  .export-row {
    display: flex;
    gap: 6px;
    margin-top: 6px;
  }
  .export-row button {
    flex: 1;
    padding: 5px 8px;
    border: 1px solid var(--border-color);
    background: var(--pane-btn-bg);
    color: var(--text-color);
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.78em;
    transition: background 0.15s;
  }
  .export-row button:hover {
    background: var(--pane-btn-bg-hover);
  }
  .export-row button:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .pin-btn {
    flex: 0 0 auto !important;
    background: rgba(78, 121, 167, 0.3) !important;
    border-color: rgba(78, 121, 167, 0.5) !important;
  }
  .pin-btn:hover:not(:disabled) {
    background: rgba(78, 121, 167, 0.5) !important;
  }
  .pinned-section {
    margin-top: 10px;
    padding-top: 8px;
    border-top: var(--pane-border);
  }
  .pinned-title {
    margin: 0 0 6px;
    font-size: 0.78em;
    font-weight: 600;
    color: var(--text-color-muted, rgba(255, 255, 255, 0.6));
  }
  .pinned-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .pinned-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 4px;
    border-radius: 4px;
    font-size: 0.78em;
    color: var(--text-color, #fff);
    transition: opacity 0.15s;
  }
  .pinned-item.dimmed {
    opacity: 0.4;
  }
  .pinned-item:hover {
    background: var(--pane-bg-hover);
  }
  .color-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .pinned-label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pinned-action {
    background: transparent;
    border: none;
    color: var(--text-color-muted, rgba(255, 255, 255, 0.5));
    cursor: pointer;
    padding: 1px 3px;
    font-size: 0.85em;
    border-radius: 3px;
    line-height: 1;
  }
  .pinned-action:hover {
    color: var(--text-color);
    background: var(--pane-bg-hover);
  }
  .pinned-action.remove:hover {
    color: var(--error-color);
    background: color-mix(in srgb, var(--error-color) 15%, transparent);
  }
  .warning {
    font-size: 0.8em;
    color: var(--text-color-muted, rgba(255, 255, 255, 0.6));
    margin: 8px 0;
    line-height: 1.4;
  }
  .import-structure-btn {
    padding: 4px 12px;
    background: var(--accent-color, #3b82f6);
    color: #fff;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.82em;
    margin-top: 4px;
  }
  .import-structure-btn:hover { opacity: 0.85; }
  .error-msg {
    font-size: 0.8em;
    color: var(--error-color);
    margin: 8px 0;
    line-height: 1.4;
  }
  .hint {
    font-size: 0.8em;
    color: var(--text-color-muted, rgba(255, 255, 255, 0.6));
    margin: 8px 0;
  }
</style>

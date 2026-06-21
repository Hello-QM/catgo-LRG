<script lang="ts">
  import { untrack } from 'svelte'
  import { Spinner } from '$lib'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'
  import {
    upload_cohpcar,
    get_cohp_data,
    upload_icohplist,
    cleanup_cohp_session,
    load_from_remote as cohp_load_remote,
  } from '$lib/api/cohp'
  import { register_analysis_session, unregister_analysis_session } from '$lib/chat/analysis-session-store.svelte'
  import FileSourceDialog from './FileSourceDialog.svelte'
  import { PALETTE_PRESETS, PALETTE_ORDER, PALETTE_LABEL_KEY, apply_palette } from './palettes'
  import type {
    COHPBondInfo,
    COHPSessionInfo,
    CohpViewState,
  } from './cohp_types'

  load_i18n_module('structure')
  load_i18n_module('common')

  let {
    cohp_state = $bindable(),
  }: {
    cohp_state: CohpViewState
  } = $props()

  // State
  let session = $state<COHPSessionInfo | null>(null)

  // Register/unregister analysis session for AI tool access
  $effect(() => {
    if (session) {
      const { session_id, all_bonds, efermi } = session
      untrack(() => register_analysis_session({
        type: `cohp`,
        session_id,
        label: t('structure.cohp_session_label', { n: all_bonds?.length ?? 0 }),
        meta: { efermi, nbonds: all_bonds?.length },
        created_at: Date.now(),
      }))
    } else {
      untrack(() => unregister_analysis_session(`cohp`))
    }
  })

  let uploading = $state(false)
  let loading_data = $state(false)
  let error_msg = $state(``)
  let show_file_dialog = $state(false)

  // Bond selection
  let selected_bond_indices: number[] = $state([])

  // Orbital options
  let include_orbitals = $state(false)
  let aggregate_orbitals = $state(false)
  let orbital_filter = $state<string>(`all`)

  // Display option local state for range inputs
  let x_range_min = $state(``)
  let x_range_max = $state(``)
  let y_range_min = $state(``)
  let y_range_max = $state(``)

  // Sync range inputs → cohp_state
  $effect(() => {
    const min = parseFloat(x_range_min)
    const max = parseFloat(x_range_max)
    cohp_state.x_range = !isNaN(min) && !isNaN(max) ? [min, max] : null
  })
  $effect(() => {
    const min = parseFloat(y_range_min)
    const max = parseFloat(y_range_max)
    cohp_state.y_range = !isNaN(min) && !isNaN(max) ? [min, max] : null
  })

  async function handle_upload(event: Event) {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return

    uploading = true
    error_msg = ``
    try {
      session = await upload_cohpcar(file)
      selected_bond_indices = []
      cohp_state.cohp_result = null
      cohp_state.icohp_entries = null
    } catch (e: any) {
      error_msg = e.message || t('structure.dos_upload_failed')
    } finally {
      uploading = false
    }
  }

  async function handle_drop(event: DragEvent) {
    event.preventDefault()
    const file = event.dataTransfer?.files[0]
    if (!file) return

    uploading = true
    error_msg = ``
    try {
      session = await upload_cohpcar(file)
      selected_bond_indices = []
      cohp_state.cohp_result = null
      cohp_state.icohp_entries = null
    } catch (e: any) {
      error_msg = e.message || t('structure.dos_upload_failed')
    } finally {
      uploading = false
    }
  }

  async function handle_icohp_upload(event: Event) {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return

    error_msg = ``
    try {
      const result = await upload_icohplist(file)
      cohp_state.icohp_entries = result.entries
    } catch (e: any) {
      error_msg = e.message || t('structure.cohp_icohplist_upload_failed')
    }
  }

  function toggle_bond(bond_index: number) {
    if (selected_bond_indices.includes(bond_index)) {
      selected_bond_indices = selected_bond_indices.filter((i) => i !== bond_index)
    } else {
      selected_bond_indices = [...selected_bond_indices, bond_index]
    }
  }

  function select_all_bonds() {
    if (!session) return
    selected_bond_indices = session.bonds.map((b) => b.bond_index)
  }

  function deselect_all_bonds() {
    selected_bond_indices = []
  }

  async function load_cohp_data() {
    if (!session || selected_bond_indices.length === 0) return
    loading_data = true
    error_msg = ``
    try {
      const orb_filter = orbital_filter === `all` ? null : [orbital_filter]
      const result = await get_cohp_data(
        session.session_id,
        selected_bond_indices,
        {
          include_orbitals: include_orbitals && !aggregate_orbitals,
          orbital_filter: orb_filter ?? undefined,
          aggregate_orbitals,
        },
      )
      cohp_state.cohp_result = result
    } catch (e: any) {
      error_msg = e.message || t('structure.cohp_load_failed')
    } finally {
      loading_data = false
    }
  }

  function close_session() {
    if (session) cleanup_cohp_session(session.session_id)
    session = null
    cohp_state.cohp_result = null
    cohp_state.icohp_entries = null
    selected_bond_indices = []
  }

  // Cleanup on component destroy
  $effect(() => {
    const sid = session?.session_id
    return () => {
      if (sid) cleanup_cohp_session(sid)
    }
  })
</script>

<div class="cohp-analysis">
  <!-- File Upload -->
  {#if !session}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="upload-zone"
      role="region"
      ondragover={(e) => e.preventDefault()}
      ondrop={handle_drop}
    >
      {#if uploading}
        <Spinner />
        <span>{t('structure.cohp_parsing')}</span>
      {:else}
        <p>{t('structure.dos_drop_prefix')} <code>COHPCAR.lobster</code> {t('structure.dos_drop_suffix')} {t('common.or')}</p>
        <div class="source-buttons">
          <label class="upload-btn">
            {t('structure.browse_local')}
            <input type="file" accept=".lobster,.txt" onchange={handle_upload} hidden />
          </label>
          <button class="upload-btn remote-btn" onclick={() => show_file_dialog = true}>
            {t('structure.dos_browse_remote_workflow')}
          </button>
        </div>
      {/if}
    </div>
  {:else}
    <!-- Session Info -->
    <div class="info-bar">
      <span title={t('structure.dos_spin')}>{session.nspin > 1 ? t('structure.dos_spin_pol') : t('structure.dos_non_spin')}</span>
      <span title={t('structure.cohp_energy_points')}>{t('structure.cohp_points_count', { n: session.npoints })}</span>
      <span title={t('structure.cohp_bonds')}>{t('structure.cohp_bonds_count', { n: session.bonds.length })}</span>
      <span title={t('structure.cohp_energy_range')}>{session.emin.toFixed(1)}~{session.emax.toFixed(1)} eV</span>
      <button class="btn-small danger" title={t('structure.dos_close_session')} onclick={close_session}>
        &times;
      </button>
    </div>

    <!-- Bond Selection -->
    <details open>
      <summary>{t('structure.cohp_bonds_selected', { selected: selected_bond_indices.length, total: session.bonds.length })}</summary>
      <div class="bond-actions">
        <button class="btn-tiny" onclick={select_all_bonds}>{t('common.select_all')}</button>
        <button class="btn-tiny" onclick={deselect_all_bonds}>{t('common.clear')}</button>
      </div>
      <div class="bond-list">
        {#each session.bonds as bond}
          <label class="bond-item">
            <input
              type="checkbox"
              checked={selected_bond_indices.includes(bond.bond_index)}
              onchange={() => toggle_bond(bond.bond_index)}
            />
            <span class="bond-label">{bond.label}</span>
            <span class="bond-detail">{bond.distance.toFixed(3)} A</span>
          </label>
        {/each}
      </div>
    </details>

    <!-- Orbital Options -->
    <details>
      <summary>{t('structure.cohp_orbital_options')}</summary>
      <div class="display-opts">
        <label class="checkbox-label">
          <input type="checkbox" bind:checked={include_orbitals} />
          {t('structure.cohp_show_individual_orbitals')}
        </label>
        <label class="checkbox-label">
          <input type="checkbox" bind:checked={aggregate_orbitals} />
          {t('structure.cohp_aggregate_orbitals')}
        </label>
        {#if include_orbitals || aggregate_orbitals}
          <label>
            {t('structure.cohp_orbital_filter')}
            <select bind:value={orbital_filter}>
              <option value="all">{t('structure.cohp_all_orbitals')}</option>
              <option value="s-s">s-s</option>
              <option value="s-p">s-p</option>
              <option value="s-d">s-d</option>
              <option value="p-p">p-p</option>
              <option value="p-d">p-d</option>
              <option value="d-d">d-d</option>
            </select>
          </label>
        {/if}
      </div>
    </details>

    <!-- Display Options -->
    <details>
      <summary>{t('structure.dos_display_options')}</summary>
      <div class="display-opts">
        <label class="checkbox-label">
          <input type="checkbox" bind:checked={cohp_state.show_fermi_line} />
          {t('structure.dos_fermi_level_line')}
        </label>
        <label class="checkbox-label">
          <input type="checkbox" bind:checked={cohp_state.show_fill} />
          {t('structure.dos_fill_under_curves')}
        </label>
        {#if cohp_state.show_fill}
          <div class="range-row">
            <span>{t('structure.cohp_fill_opacity')}</span>
            <input
              type="range"
              bind:value={cohp_state.fill_opacity}
              min="0" max="1" step="0.05"
              class="slider-input"
            />
            <span class="slider-val">{cohp_state.fill_opacity.toFixed(2)}</span>
          </div>
        {/if}
        <label class="checkbox-label">
          <input type="checkbox" bind:checked={cohp_state.invert_cohp} />
          {t('structure.cohp_invert')}
        </label>

        <hr class="section-divider" />

        {#if session && session.nspin > 1}
          <label>
            {t('structure.cohp_spin_handling')}
            <select bind:value={cohp_state.spin_mode}>
              <option value="separate">{t('structure.cohp_spin_separate')}</option>
              <option value="summed">{t('structure.cohp_spin_summed')}</option>
            </select>
          </label>
          {#if cohp_state.spin_mode === `separate`}
            <label class="checkbox-label">
              <input type="checkbox" bind:checked={cohp_state.show_spin_down} />
              {t('structure.dos_show_spin_down')}
            </label>
          {/if}
        {/if}

        <label>
          {t('structure.dos_orientation')}
          <select bind:value={cohp_state.orientation}>
            <option value="horizontal">{t('structure.cohp_energy_on_y_standard')}</option>
            <option value="vertical">{t('structure.dos_energy_on_x')}</option>
          </select>
        </label>
        <div class="range-row">
          <span>{t('structure.dos_x_range')}</span>
          <input type="text" placeholder={t('structure.dos_min')} bind:value={x_range_min} class="range-input" />
          <input type="text" placeholder={t('structure.dos_max')} bind:value={x_range_max} class="range-input" />
        </div>
        <div class="range-row">
          <span>{t('structure.dos_y_range')}</span>
          <input type="text" placeholder={t('structure.dos_min')} bind:value={y_range_min} class="range-input" />
          <input type="text" placeholder={t('structure.dos_max')} bind:value={y_range_max} class="range-input" />
        </div>

        <hr class="section-divider" />

        <label class="checkbox-label">
          <input type="checkbox" bind:checked={cohp_state.legend_visible} />
          {t('structure.dos_show_legend')}
        </label>
        <label class="checkbox-label">
          <input type="checkbox" bind:checked={cohp_state.show_gridlines} />
          {t('structure.dos_show_gridlines')}
        </label>
        <label class="checkbox-label">
          <input type="checkbox" bind:checked={cohp_state.show_axis_lines} />
          {t('structure.dos_show_axis_lines')}
        </label>
        <div class="range-row">
          <span>{t('structure.dos_axis_width')}</span>
          <input
            type="number"
            bind:value={cohp_state.axis_line_width}
            min="0.5" max="5" step="0.5"
            class="range-input"
          />
        </div>
        <div class="range-row">
          <span>{t('structure.dos_tick_length')}</span>
          <input
            type="number"
            bind:value={cohp_state.tick_length}
            min="0" max="15" step="1"
            class="range-input"
          />
        </div>
        <div class="range-row">
          <span>{t('structure.dos_tick_width')}</span>
          <input
            type="number"
            bind:value={cohp_state.tick_width}
            min="0.5" max="5" step="0.5"
            class="range-input"
          />
        </div>
        <div class="range-row">
          <span>{t('structure.dos_title_size')}</span>
          <input
            type="number"
            bind:value={cohp_state.title_size}
            min="6" max="24" step="1"
            class="range-input"
          />
        </div>
        <div class="range-row">
          <span>{t('structure.dos_font_size')}</span>
          <input
            type="number"
            bind:value={cohp_state.font_size}
            min="6" max="24" step="1"
            class="range-input"
          />
        </div>
      </div>
    </details>

    <!-- Series Visibility -->
    {#if cohp_state.cohp_result && cohp_state.cohp_result.series.length > 0}
      <details>
        <summary>{t('structure.dos_series_visibility')}</summary>
        <div class="display-opts">
          {#each cohp_state.cohp_result.series as s}
            <label class="checkbox-label">
              <input
                type="checkbox"
                checked={!cohp_state.hidden_series.includes(s.label)}
                onchange={(e) => {
                  const checked = (e.target as HTMLInputElement).checked
                  if (checked) {
                    cohp_state.hidden_series = cohp_state.hidden_series.filter((l) => l !== s.label)
                  } else {
                    cohp_state.hidden_series = [...cohp_state.hidden_series, s.label]
                  }
                }}
              />
              {s.label}
            </label>
          {/each}
        </div>
      </details>
    {/if}

    <!-- Line Styles -->
    {#if cohp_state.cohp_result && cohp_state.cohp_result.series.length > 0}
      <details>
        <summary>{t('structure.dos_line_styles')}</summary>
        <div class="line-styles">
          <div class="line-style-row">
            <span class="group-label">{t('structure.palette_label')}</span>
            <select
              onchange={(e) => {
                if (!cohp_state.cohp_result) return
                const preset = (e.target as HTMLSelectElement).value as keyof typeof PALETTE_PRESETS
                const labels = cohp_state.cohp_result.series.map((s) => s.label)
                const assigned = apply_palette(labels, preset)
                const next = { ...cohp_state.line_styles }
                for (const [label, color] of Object.entries(assigned)) {
                  next[label] = { ...next[label], color }
                }
                cohp_state.line_styles = next
              }}
            >
              {#each PALETTE_ORDER as name}
                <option value={name}>{t(PALETTE_LABEL_KEY[name])}</option>
              {/each}
            </select>
          </div>
          {#each cohp_state.cohp_result.series as s, idx}
            <div class="line-style-group">
              <span class="group-label">{s.label}</span>
              <div class="line-style-row">
                <input
                  type="color"
                  value={cohp_state.line_styles[s.label]?.color ?? PALETTE_PRESETS.default[idx % PALETTE_PRESETS.default.length]}
                  class="color-input"
                  title={t('structure.cohp_line_color')}
                  oninput={(e) => {
                    const target = e.target as HTMLInputElement
                    cohp_state.line_styles = { ...cohp_state.line_styles, [s.label]: { ...cohp_state.line_styles[s.label], color: target.value } }
                  }}
                />
                <select
                  value={cohp_state.line_styles[s.label]?.dash ?? `solid`}
                  onchange={(e) => {
                    const target = e.target as HTMLSelectElement
                    cohp_state.line_styles = { ...cohp_state.line_styles, [s.label]: { ...cohp_state.line_styles[s.label], dash: target.value } }
                  }}
                >
                  <option value="solid">{t('structure.dos_line_solid')}</option>
                  <option value="dash">{t('structure.dos_line_dashed')}</option>
                  <option value="dot">{t('structure.dos_line_dotted')}</option>
                  <option value="dashdot">{t('structure.dos_line_dashdot')}</option>
                </select>
                <input
                  type="number"
                  value={cohp_state.line_styles[s.label]?.width ?? 1.5}
                  min="0.5"
                  max="5"
                  step="0.5"
                  class="width-input"
                  title={t('structure.cohp_line_width')}
                  onchange={(e) => {
                    const target = e.target as HTMLInputElement
                    cohp_state.line_styles = { ...cohp_state.line_styles, [s.label]: { ...cohp_state.line_styles[s.label], width: parseFloat(target.value) } }
                  }}
                />
                {#if cohp_state.show_fill}
                  <input
                    type="color"
                    value={cohp_state.line_styles[s.label]?.fill_color ?? cohp_state.line_styles[s.label]?.color ?? PALETTE_PRESETS.default[idx % PALETTE_PRESETS.default.length]}
                    class="color-input"
                    title={t('structure.cohp_fill_color')}
                    oninput={(e) => {
                      const target = e.target as HTMLInputElement
                      cohp_state.line_styles = { ...cohp_state.line_styles, [s.label]: { ...cohp_state.line_styles[s.label], fill_color: target.value } }
                    }}
                  />
                {/if}
              </div>
            </div>
          {/each}
        </div>
      </details>
    {/if}

    <!-- Load Data Button -->
    <button
      class="btn-compute"
      onclick={load_cohp_data}
      disabled={loading_data || selected_bond_indices.length === 0}
    >
      {#if loading_data}
        <Spinner /> {t('common.loading')}
      {:else}
        {t('structure.cohp_load_cohp')}
      {/if}
    </button>

    <!-- ICOHPLIST Upload -->
    <details>
      <summary>{t('structure.cohp_icohp_values')}</summary>
      <div class="icohp-section">
        {#if !cohp_state.icohp_entries}
          <label class="upload-btn-small">
            {t('structure.cohp_upload_icohplist')}
            <input type="file" accept=".lobster,.txt" onchange={handle_icohp_upload} hidden />
          </label>
        {:else}
          <table class="icohp-table">
            <thead>
              <tr>
                <th>{t('structure.cohp_bond')}</th>
                <th>d (A)</th>
                <th>ICOHP (eV)</th>
              </tr>
            </thead>
            <tbody>
              {#each cohp_state.icohp_entries.filter((e) => e.is_total) as entry}
                <tr>
                  <td>{entry.label}</td>
                  <td>{entry.distance.toFixed(3)}</td>
                  <td class="mono">{entry.total.toFixed(4)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </div>
    </details>
  {/if}

  {#if error_msg}
    <div class="error-msg">{error_msg}</div>
  {/if}
</div>

<FileSourceDialog
  bind:show={show_file_dialog}
  file_types={['.lobster', '.txt']}
  title={t('structure.cohp_load_cohpcar')}
  description={t('structure.cohp_load_cohpcar_desc')}
  onfile={async (file) => {
    uploading = true
    error_msg = ''
    try {
      session = await upload_cohpcar(file)
      selected_bond_indices = []
      cohp_state.cohp_result = null
      cohp_state.icohp_entries = null
    } catch (e: any) {
      error_msg = e.message || t('structure.dos_upload_failed')
    } finally {
      uploading = false
    }
  }}
  onremote_path={async (session_id, path) => {
    uploading = true
    error_msg = ''
    try {
      session = await cohp_load_remote(session_id, path)
      selected_bond_indices = []
      cohp_state.cohp_result = null
      cohp_state.icohp_entries = null
    } catch (e: any) {
      error_msg = e.message || t('structure.dos_remote_load_failed')
    } finally {
      uploading = false
    }
  }}
  onclose={() => show_file_dialog = false}
/>

<style>
  .cohp-analysis {
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 0.82em;
  }
  .upload-zone {
    border: 2px dashed light-dark(rgba(0, 0, 0, 0.2), rgba(255, 255, 255, 0.2));
    border-radius: 8px;
    padding: 20px;
    text-align: center;
    color: var(--text-color-muted, rgba(255, 255, 255, 0.6));
    cursor: pointer;
  }
  .upload-zone:hover { border-color: var(--accent-color, #007acc); }
  .upload-zone p { margin: 0 0 8px; }
  .upload-zone code { background: light-dark(rgba(0, 0, 0, 0.06), rgba(255, 255, 255, 0.1)); padding: 2px 5px; border-radius: 3px; }
  .upload-btn {
    display: inline-block; padding: 5px 14px;
    background: var(--accent-color, #007acc); color: white;
    border-radius: 4px; cursor: pointer; font-size: 0.9em;
  }
  .upload-btn-small {
    display: inline-block; padding: 4px 10px;
    background: light-dark(rgba(0, 0, 0, 0.06), rgba(255, 255, 255, 0.1)); color: var(--text-color, #fff);
    border: 1px solid light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15));
    border-radius: 4px; cursor: pointer; font-size: 0.85em;
  }
  .upload-btn-small:hover { background: light-dark(rgba(0, 0, 0, 0.12), rgba(255, 255, 255, 0.2)); }
  .info-bar {
    display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
    padding: 4px 6px; background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.04));
    border-radius: 4px; font-size: 0.85em;
    color: var(--text-color-muted, rgba(255, 255, 255, 0.7));
  }
  .info-bar span { padding: 1px 4px; background: light-dark(rgba(0, 0, 0, 0.06), rgba(255, 255, 255, 0.06)); border-radius: 3px; }
  details { background: light-dark(rgba(0, 0, 0, 0.02), rgba(255, 255, 255, 0.03)); border-radius: 6px; padding: 6px 8px; }
  summary { cursor: pointer; font-weight: 600; font-size: 0.88em; color: var(--text-color, #fff); user-select: none; }
  .bond-actions { display: flex; gap: 6px; margin: 4px 0; }
  .bond-list { display: flex; flex-direction: column; gap: 2px; max-height: 200px; overflow-y: auto; }
  .bond-item {
    display: flex; align-items: center; gap: 6px; padding: 3px 4px;
    border-radius: 3px; cursor: pointer; font-size: 0.9em;
  }
  .bond-item:hover { background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.05)); }
  .bond-label { font-weight: 500; color: var(--text-color, #fff); }
  .bond-detail { font-size: 0.85em; color: var(--text-color-muted, rgba(255, 255, 255, 0.5)); margin-left: auto; }
  .display-opts { display: flex; flex-direction: column; gap: 5px; margin-top: 6px; }
  .display-opts label { font-size: 0.85em; color: var(--text-color-muted, rgba(255, 255, 255, 0.7)); }
  .display-opts select { padding: 3px 5px; background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.08)); border: 1px solid light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15)); border-radius: 4px; color: var(--text-color, #fff); font-size: 0.9em; margin-top: 2px; }
  .checkbox-label { display: flex; align-items: center; gap: 5px; font-size: 0.85em; color: var(--text-color-muted, rgba(255, 255, 255, 0.7)); cursor: pointer; }
  .range-row { display: flex; align-items: center; gap: 4px; font-size: 0.85em; color: var(--text-color-muted, rgba(255, 255, 255, 0.6)); }
  .range-input { width: 55px; padding: 2px 4px; background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.08)); border: 1px solid light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15)); border-radius: 3px; color: var(--text-color, #fff); font-size: 0.9em; }
  .line-styles { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
  .line-style-group { display: flex; flex-direction: column; gap: 2px; }
  .line-style-group .group-label { font-size: 0.85em; font-weight: 500; color: var(--text-color, #fff); }
  .line-style-row { display: flex; align-items: center; gap: 4px; font-size: 0.85em; }
  .line-style-row select { padding: 2px 4px; background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.08)); border: 1px solid light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15)); border-radius: 3px; color: var(--text-color, #fff); font-size: 0.85em; }
  .width-input { width: 45px; padding: 2px 4px; background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.08)); border: 1px solid light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15)); border-radius: 3px; color: var(--text-color, #fff); font-size: 0.85em; }
  .color-input { width: 28px; height: 22px; padding: 0; border: 1px solid light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15)); border-radius: 3px; cursor: pointer; background: transparent; }
  .slider-input { flex: 1; accent-color: var(--accent-color, #007acc); }
  .slider-val { font-size: 0.85em; color: var(--text-color-muted, rgba(255, 255, 255, 0.5)); min-width: 30px; text-align: right; }
  .btn-compute { padding: 6px 12px; background: #2563eb; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 0.9em; display: flex; align-items: center; justify-content: center; gap: 6px; }
  .btn-compute:hover:not(:disabled) { background: #1d4ed8; }
  .btn-compute:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-small { padding: 3px 8px; background: light-dark(rgba(0, 0, 0, 0.06), rgba(255, 255, 255, 0.1)); border: 1px solid light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15)); border-radius: 3px; color: var(--text-color, #fff); cursor: pointer; font-size: 0.85em; }
  .btn-small:hover { background: light-dark(rgba(0, 0, 0, 0.12), rgba(255, 255, 255, 0.2)); }
  .btn-small.danger { color: var(--error-color, #f55); }
  .btn-tiny { padding: 2px 6px; background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.08)); border: 1px solid light-dark(rgba(0, 0, 0, 0.1), rgba(255, 255, 255, 0.1)); border-radius: 3px; color: var(--text-color-muted, rgba(255, 255, 255, 0.5)); cursor: pointer; font-size: 0.8em; }
  .btn-tiny:hover { background: light-dark(rgba(0, 0, 0, 0.1), rgba(255, 255, 255, 0.15)); color: var(--text-color, #fff); }
  .icohp-section { margin-top: 6px; }
  .icohp-table { width: 100%; border-collapse: collapse; font-size: 0.9em; }
  .icohp-table th { text-align: left; padding: 3px 6px; border-bottom: 1px solid light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15)); color: var(--text-color-muted, rgba(255, 255, 255, 0.6)); font-weight: 600; }
  .icohp-table td { padding: 3px 6px; border-bottom: 1px solid light-dark(rgba(0, 0, 0, 0.06), rgba(255, 255, 255, 0.05)); }
  .icohp-table .mono { font-family: monospace; color: var(--text-color, #fff); }
  .error-msg { padding: 5px 8px; background: light-dark(rgba(220, 38, 38, 0.1), rgba(255, 60, 60, 0.15)); border: 1px solid light-dark(rgba(220, 38, 38, 0.25), rgba(255, 60, 60, 0.3)); border-radius: 4px; color: var(--error-color, #f88); font-size: 0.85em; }
  .section-divider { border: none; border-top: 1px solid light-dark(rgba(0, 0, 0, 0.08), rgba(255, 255, 255, 0.08)); margin: 4px 0; }
  .source-buttons { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
  .remote-btn { background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.08)); border: 1px solid light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15)); }
  .remote-btn:hover { background: light-dark(rgba(0, 0, 0, 0.1), rgba(255, 255, 255, 0.15)); }
</style>

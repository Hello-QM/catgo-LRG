<script lang="ts">
  import { untrack } from 'svelte'
  import { Spinner } from '$lib'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'
  import {
    upload_band_vasprun,
    get_band_data,
    get_band_projections,
    select_band_atoms,
    cleanup_band_session,
    load_band_from_directory,
  } from '$lib/api/bands'
  import { register_analysis_session, unregister_analysis_session } from '$lib/chat/analysis-session-store.svelte'
  import FileSourceDialog from './FileSourceDialog.svelte'
  import type {
    BandSessionInfo,
    BandProjectionGroup,
    BandViewState,
  } from './band_types'
  import type { PymatgenStructure } from '$lib/structure'

  load_i18n_module('structure')
  load_i18n_module('common')

  let {
    on_structure_loaded = (_s: PymatgenStructure) => {},
    band_state = $bindable(),
  }: {
    on_structure_loaded?: (s: PymatgenStructure) => void
    band_state: BandViewState
  } = $props()

  // State
  let session = $state<BandSessionInfo | null>(null)

  // Register/unregister analysis session for AI tool access
  $effect(() => {
    if (session) {
      const { session_id, elements, efermi, is_metal, band_gap } = session
      untrack(() => register_analysis_session({
        type: `bands`,
        session_id,
        label: `Bands (${elements?.join(`, `) ?? t('structure.dos_uploaded')})`,
        meta: { elements, efermi, is_metal, band_gap },
        created_at: Date.now(),
      }))
    } else {
      untrack(() => unregister_analysis_session(`bands`))
    }
  })

  let uploading = $state(false)
  let loading_bands = $state(false)
  let loading_projections = $state(false)
  let error_msg = $state(``)

  // Projection groups
  let proj_groups: BandProjectionGroup[] = $state([])

  // New group form
  let selection_mode = $state<`element` | `index`>(`element`)
  let new_element = $state(``)
  let new_index_spec = $state(``)
  let new_orbital = $state(`d`)
  let new_label = $state(``)

  // File inputs
  let kpoints_file = $state<File | null>(null)
  let show_file_dialog = $state(false)
  // Set when a line-mode band vasprun was uploaded without the required KPOINTS;
  // drives a friendly reminder + highlights the KPOINTS field instead of dumping
  // the raw pymatgen error.
  let kpoints_needed = $state(false)

  /** Map an upload error to a user-facing message (friendly KPOINTS hint). */
  function upload_error_message(e: any): string {
    const raw = e?.message ?? ``
    if (/KPOINTS not found|symmetry lines/i.test(raw)) {
      kpoints_needed = true
      return t('structure.band_kpoints_required')
    }
    kpoints_needed = false
    return raw || t('structure.dos_upload_failed')
  }

  // Derived
  let unique_elements: string[] = $derived(
    session ? [...new Set(session.elements)] : []
  )

  async function handle_upload(event: Event) {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return

    uploading = true
    error_msg = ``
    try {
      session = await upload_band_vasprun(file, kpoints_file ?? undefined)
      kpoints_needed = false
      proj_groups = []
      band_state.band_data = null
      band_state.projections = null
      if (session.structure) {
        on_structure_loaded(session.structure as PymatgenStructure)
      }
    } catch (e: any) {
      error_msg = upload_error_message(e)
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
      session = await upload_band_vasprun(file, kpoints_file ?? undefined)
      kpoints_needed = false
      proj_groups = []
      band_state.band_data = null
      band_state.projections = null
      if (session.structure) {
        on_structure_loaded(session.structure as PymatgenStructure)
      }
    } catch (e: any) {
      error_msg = upload_error_message(e)
    } finally {
      uploading = false
    }
  }

  async function handle_remote_path(hpc_session_id: string, path: string) {
    uploading = true
    error_msg = ''
    try {
      session = await load_band_from_directory(hpc_session_id, path)
      proj_groups = []
      band_state.band_data = null
      band_state.projections = null
      if (session?.structure) {
        on_structure_loaded(session.structure as PymatgenStructure)
      }
    } catch (e: any) {
      error_msg = e.message || t('structure.dos_remote_load_failed')
    } finally {
      uploading = false
    }
  }

  async function load_bands() {
    if (!session) return
    loading_bands = true
    error_msg = ``
    try {
      const [emin, emax] = band_state.energy_range
      band_state.band_data = await get_band_data(session.session_id, { emin, emax })
      band_state.projections = null
    } catch (e: any) {
      error_msg = e.message || t('structure.band_load_failed')
    } finally {
      loading_bands = false
    }
  }

  async function add_group() {
    if (!session) return
    error_msg = ``
    try {
      let atoms: number[]
      if (selection_mode === `element`) {
        if (!new_element) return
        atoms = await select_band_atoms(session.session_id, { elements: [new_element] })
      } else {
        if (!new_index_spec.trim()) return
        atoms = await select_band_atoms(session.session_id, { index_spec: new_index_spec.trim() })
      }

      if (atoms.length === 0) {
        error_msg = t('structure.band_no_atoms_found')
        return
      }

      const sel_label = selection_mode === `element` ? new_element : `[${new_index_spec}]`
      const label = new_label || `${sel_label}-${new_orbital}`

      proj_groups = [...proj_groups, { atoms, channels: new_orbital, label }]
      new_label = ``
    } catch (e: any) {
      error_msg = e.message
    }
  }

  function remove_group(idx: number) {
    proj_groups = proj_groups.filter((_, i) => i !== idx)
  }

  async function load_projections() {
    if (!session || proj_groups.length === 0) return
    loading_projections = true
    error_msg = ``
    try {
      const [emin, emax] = band_state.energy_range
      const result = await get_band_projections(session.session_id, proj_groups, { emin, emax })
      band_state.band_data = result  // BandProjectionResponse extends BandDataResponse
      band_state.projections = result.projections
    } catch (e: any) {
      error_msg = e.message || t('structure.band_projection_failed')
    } finally {
      loading_projections = false
    }
  }

  function close_session() {
    if (session) cleanup_band_session(session.session_id)
    session = null
    band_state.band_data = null
    band_state.projections = null
    proj_groups = []
  }

  // Cleanup on destroy
  $effect(() => {
    const sid = session?.session_id
    return () => {
      if (sid) cleanup_band_session(sid)
    }
  })
</script>

<div class="band-analysis">
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
        <span>{t('structure.band_parsing')}</span>
      {:else}
        <p>{t('structure.dos_drop_prefix')} <code>vasprun.xml</code> {t('structure.dos_drop_suffix')} {t('common.or')}</p>
        <div class="source-buttons">
          <label class="upload-btn">
            {t('structure.browse_local')}
            <input type="file" accept=".xml" onchange={handle_upload} hidden />
          </label>
          <button class="upload-btn remote-btn" onclick={() => show_file_dialog = true}>
            {t('structure.browse_remote')}
          </button>
        </div>
        <p class="kpoints-hint">{t('structure.band_kpoints_hint')}</p>
        <div class="kpoints-row" class:needs-kpoints={kpoints_needed}>
          <label class="kpoints-label">
            {t('structure.band_kpoints_optional')}
            <input
              type="file"
              accept="KPOINTS,*"
              onchange={(e) => { kpoints_file = (e.target as HTMLInputElement).files?.[0] ?? null }}
            />
          </label>
        </div>
      {/if}
    </div>
  {:else}
    <!-- Session Info -->
    <div class="info-bar">
      <span title={t('structure.elements_label')}>{session.ion_types.join(`, `)}</span>
      <span title={t('structure.dos_kpoints')}>{session.nkpts}k</span>
      <span title={t('structure.dos_bands')}>{session.nbands}b</span>
      <span title={t('structure.dos_spin')}>{session.nspin > 1 ? t('structure.dos_spin_pol') : t('structure.dos_non_spin')}</span>
      <span title={t('structure.band_metal_status')}>{session.is_metal ? t('structure.band_metal') : t('structure.band_semicond')}</span>
      {#if session.band_gap}
        <span title={t('structure.band_gap')}>{session.band_gap.energy.toFixed(3)} eV</span>
      {/if}
      <button class="btn-small danger" title={t('structure.dos_close_session')} onclick={close_session}>
        &times;
      </button>
    </div>

    <!-- Load Bands -->
    <button
      class="btn-compute"
      onclick={load_bands}
      disabled={loading_bands}
    >
      {#if loading_bands}
        <Spinner /> {t('common.loading')}
      {:else}
        {t('structure.band_load_bands')}
      {/if}
    </button>

    <!-- Projection Groups -->
    <details>
      <summary>{t('structure.band_fat_projections', { n: proj_groups.length })}</summary>

      <div class="tab-bar">
        <button
          class="tab-btn"
          class:active={selection_mode === `element`}
          onclick={() => selection_mode = `element`}
        >{t('structure.dos_element')}</button>
        <button
          class="tab-btn"
          class:active={selection_mode === `index`}
          onclick={() => selection_mode = `index`}
        >{t('structure.dos_index')}</button>
      </div>

      <div class="group-form">
        {#if selection_mode === `element`}
          <select bind:value={new_element}>
            <option value="">{t('structure.dos_element')}</option>
            {#each unique_elements as el}
              <option value={el}>{el}</option>
            {/each}
          </select>
        {:else}
          <input
            type="text"
            placeholder="1-5,8-10"
            bind:value={new_index_spec}
            class="index-input"
            title={t('structure.dos_index_title_short')}
          />
        {/if}

        <select bind:value={new_orbital}>
          <option value="s">s</option>
          <option value="p">p</option>
          <option value="d">d</option>
          <option value="f">f</option>
          <option value="s,p">s+p</option>
          <option value="s,p,d">s+p+d</option>
          <option value="dxy">dxy</option>
          <option value="dyz">dyz</option>
          <option value="dz2">dz2</option>
          <option value="dxz">dxz</option>
          <option value="dx2-y2">dx2-y2</option>
        </select>

        <input
          type="text"
          placeholder={t('common.label')}
          bind:value={new_label}
          class="label-input"
        />

        <button
          class="btn-small"
          onclick={add_group}
          disabled={selection_mode === `element` ? !new_element : !new_index_spec.trim()}
        >+</button>
      </div>

      {#if proj_groups.length > 0}
        <ul class="group-list">
          {#each proj_groups as g, i}
            <li>
              <span class="group-label">{g.label}</span>
              <span class="group-detail">
                {t('structure.dos_group_detail', { atoms: g.atoms.length, channels: g.channels })}
              </span>
              <button class="btn-tiny" onclick={() => remove_group(i)}>&times;</button>
            </li>
          {/each}
        </ul>

        <button
          class="btn-compute"
          onclick={load_projections}
          disabled={loading_projections}
        >
          {#if loading_projections}
            <Spinner /> {t('structure.computing')}
          {:else}
            {t('structure.band_load_projections')}
          {/if}
        </button>
      {/if}
    </details>

    <!-- Display Options -->
    <details>
      <summary>{t('structure.dos_display_options')}</summary>
      <div class="display-opts">
        <label class="checkbox-label">
          <input type="checkbox" bind:checked={band_state.show_fermi_line} />
          {t('structure.dos_fermi_level_line')}
        </label>
        <label class="checkbox-label">
          <input type="checkbox" bind:checked={band_state.show_band_gap} />
          {t('structure.band_gap_annotation')}
        </label>
        <label class="checkbox-label">
          <input type="checkbox" bind:checked={band_state.show_spin_down} />
          {t('structure.dos_show_spin_down')}
        </label>
        <div class="range-row">
          <span>{t('structure.band_e_min_ev')}</span>
          <input
            type="number"
            bind:value={band_state.energy_range[0]}
            step="0.5"
            class="range-input"
          />
        </div>
        <div class="range-row">
          <span>{t('structure.band_e_max_ev')}</span>
          <input
            type="number"
            bind:value={band_state.energy_range[1]}
            step="0.5"
            class="range-input"
          />
        </div>
        <div class="range-row">
          <span>{t('structure.band_fat_scale')}</span>
          <input
            type="number"
            bind:value={band_state.fat_band_scale}
            min="1" max="50" step="1"
            class="range-input"
          />
        </div>

        <hr class="section-divider" />

        <label class="checkbox-label">
          <input type="checkbox" bind:checked={band_state.legend_visible} />
          {t('structure.dos_show_legend')}
        </label>
        <label class="checkbox-label">
          <input type="checkbox" bind:checked={band_state.show_gridlines} />
          {t('structure.dos_show_gridlines')}
        </label>
        <label class="checkbox-label">
          <input type="checkbox" bind:checked={band_state.show_axis_lines} />
          {t('structure.dos_show_axis_lines')}
        </label>
        <div class="range-row">
          <span>{t('structure.dos_axis_width')}</span>
          <input
            type="number"
            bind:value={band_state.axis_line_width}
            min="0.5" max="5" step="0.5"
            class="range-input"
          />
        </div>
        <div class="range-row">
          <span>{t('structure.dos_tick_length')}</span>
          <input
            type="number"
            bind:value={band_state.tick_length}
            min="0" max="15" step="1"
            class="range-input"
          />
        </div>
        <div class="range-row">
          <span>{t('structure.dos_tick_width')}</span>
          <input
            type="number"
            bind:value={band_state.tick_width}
            min="0.5" max="5" step="0.5"
            class="range-input"
          />
        </div>
        <div class="range-row">
          <span>{t('structure.dos_title_size')}</span>
          <input
            type="number"
            bind:value={band_state.title_size}
            min="6" max="24" step="1"
            class="range-input"
          />
        </div>
        <div class="range-row">
          <span>{t('structure.dos_font_size')}</span>
          <input
            type="number"
            bind:value={band_state.font_size}
            min="6" max="24" step="1"
            class="range-input"
          />
        </div>
      </div>
    </details>
  {/if}

  {#if error_msg}
    <div class="error-msg">{error_msg}</div>
  {/if}
</div>

<FileSourceDialog
  bind:show={show_file_dialog}
  file_types={['.xml']}
  title={t('structure.band_load_structure')}
  description={t('structure.band_load_structure_desc')}
  onfile={async (file) => {
    uploading = true
    error_msg = ''
    try {
      session = await upload_band_vasprun(file, kpoints_file ?? undefined)
      kpoints_needed = false
      proj_groups = []
      band_state.band_data = null
      band_state.projections = null
      if (session.structure) {
        on_structure_loaded(session.structure as PymatgenStructure)
      }
    } catch (e: any) {
      error_msg = upload_error_message(e)
    } finally {
      uploading = false
    }
  }}
  onremote_path={handle_remote_path}
  onclose={() => show_file_dialog = false}
/>

<style>
  .band-analysis {
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
  .kpoints-hint {
    margin: 10px 0 2px;
    font-size: 0.8em;
    line-height: 1.35;
    color: var(--text-color-muted, rgba(255, 255, 255, 0.6));
  }
  .kpoints-row { margin-top: 4px; }
  .kpoints-row.needs-kpoints {
    border: 1px solid var(--error-color, #f88);
    border-radius: 4px;
    padding: 4px 6px;
    background: light-dark(rgba(220, 38, 38, 0.06), rgba(255, 60, 60, 0.1));
    animation: kpoints-pulse 1.2s ease-in-out 2;
  }
  .kpoints-row.needs-kpoints .kpoints-label { color: var(--error-color, #f88); }
  @keyframes kpoints-pulse {
    0%, 100% { box-shadow: 0 0 0 0 transparent; }
    50% { box-shadow: 0 0 0 3px var(--error-color, rgba(255, 136, 136, 0.45)); }
  }
  .kpoints-label { font-size: 0.85em; color: var(--text-color-muted, rgba(255, 255, 255, 0.5)); }
  .kpoints-label input { font-size: 0.85em; margin-left: 4px; }
  .info-bar {
    display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
    padding: 4px 6px; background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.04));
    border-radius: 4px; font-size: 0.85em;
    color: var(--text-color-muted, rgba(255, 255, 255, 0.7));
  }
  .info-bar span { padding: 1px 4px; background: light-dark(rgba(0, 0, 0, 0.06), rgba(255, 255, 255, 0.06)); border-radius: 3px; }
  .tab-bar { display: flex; gap: 2px; margin: 6px 0 4px; }
  .tab-btn {
    padding: 2px 10px; background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.06));
    border: 1px solid light-dark(rgba(0, 0, 0, 0.1), rgba(255, 255, 255, 0.1)); border-radius: 3px 3px 0 0;
    color: var(--text-color-muted, rgba(255, 255, 255, 0.5)); cursor: pointer; font-size: 0.85em;
  }
  .tab-btn.active { background: light-dark(rgba(0, 0, 0, 0.08), rgba(255, 255, 255, 0.12)); color: var(--text-color, #fff); border-bottom-color: transparent; }
  details { background: light-dark(rgba(0, 0, 0, 0.02), rgba(255, 255, 255, 0.03)); border-radius: 6px; padding: 6px 8px; }
  summary { cursor: pointer; font-weight: 600; font-size: 0.88em; color: var(--text-color, #fff); user-select: none; }
  .group-form { display: flex; gap: 4px; margin-top: 6px; align-items: center; flex-wrap: wrap; }
  .group-form select, .group-form input {
    padding: 3px 5px; background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.08));
    border: 1px solid light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15)); border-radius: 4px;
    color: var(--text-color, #fff); font-size: 0.9em;
  }
  .group-form select { min-width: 60px; }
  .label-input { width: 60px; }
  .index-input { width: 80px; }
  .group-list { list-style: none; padding: 0; margin: 6px 0; }
  .group-list li { display: flex; align-items: center; gap: 6px; padding: 3px 0; border-bottom: 1px solid light-dark(rgba(0, 0, 0, 0.06), rgba(255, 255, 255, 0.05)); }
  .group-label { font-weight: 500; color: var(--text-color, #fff); }
  .group-detail { font-size: 0.85em; color: var(--text-color-muted, rgba(255, 255, 255, 0.5)); flex: 1; }
  .display-opts { display: flex; flex-direction: column; gap: 5px; margin-top: 6px; }
  .display-opts label { font-size: 0.85em; color: var(--text-color-muted, rgba(255, 255, 255, 0.7)); }
  .checkbox-label { display: flex; align-items: center; gap: 5px; font-size: 0.85em; color: var(--text-color-muted, rgba(255, 255, 255, 0.7)); cursor: pointer; }
  .range-row { display: flex; align-items: center; gap: 4px; font-size: 0.85em; color: var(--text-color-muted, rgba(255, 255, 255, 0.6)); }
  .range-input { width: 55px; padding: 2px 4px; background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.08)); border: 1px solid light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15)); border-radius: 3px; color: var(--text-color, #fff); font-size: 0.9em; }
  .btn-compute { padding: 6px 12px; background: #2563eb; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 0.9em; display: flex; align-items: center; justify-content: center; gap: 6px; }
  .btn-compute:hover:not(:disabled) { background: #1d4ed8; }
  .btn-compute:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-small { padding: 3px 8px; background: light-dark(rgba(0, 0, 0, 0.06), rgba(255, 255, 255, 0.1)); border: 1px solid light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15)); border-radius: 3px; color: var(--text-color, #fff); cursor: pointer; font-size: 0.85em; }
  .btn-small:hover { background: light-dark(rgba(0, 0, 0, 0.12), rgba(255, 255, 255, 0.2)); }
  .btn-small.danger { color: var(--error-color, #f55); }
  .btn-tiny { padding: 1px 5px; background: transparent; border: none; color: var(--text-color-muted, rgba(255, 255, 255, 0.4)); cursor: pointer; font-size: 1em; }
  .btn-tiny:hover { color: var(--error-color, #f55); }
  .error-msg { padding: 5px 8px; background: light-dark(rgba(220, 38, 38, 0.1), rgba(255, 60, 60, 0.15)); border: 1px solid light-dark(rgba(220, 38, 38, 0.25), rgba(255, 60, 60, 0.3)); border-radius: 4px; color: var(--error-color, #f88); font-size: 0.85em; }
  .section-divider { border: none; border-top: 1px solid light-dark(rgba(0, 0, 0, 0.08), rgba(255, 255, 255, 0.08)); margin: 4px 0; }
  .source-buttons { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
  .remote-btn { background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.08)); border: 1px solid light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15)); }
  .remote-btn:hover { background: light-dark(rgba(0, 0, 0, 0.1), rgba(255, 255, 255, 0.15)); }
</style>

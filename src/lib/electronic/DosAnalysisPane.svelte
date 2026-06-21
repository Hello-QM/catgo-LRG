<script lang="ts">
  import { untrack } from 'svelte'
  import { Spinner } from '$lib'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'
  import {
    upload_h5,
    upload_procar,
    compute_pdos,
    compute_total_dos,
    compute_dband,
    select_atoms,
    cleanup_session,
    load_from_remote as dos_load_remote,
    load_from_directory as dos_load_directory,
  } from '$lib/api/dos'
  import { register_analysis_session, unregister_analysis_session } from '$lib/chat/analysis-session-store.svelte'
  import FileSourceDialog from './FileSourceDialog.svelte'
  import { PALETTE_PRESETS, PALETTE_ORDER, PALETTE_LABEL_KEY, apply_palette } from './palettes'
  import type {
    DOSGroup,
    DOSSessionInfo,
    DosViewState,
  } from './types'
  import type { PymatgenStructure } from '$lib/structure'

  load_i18n_module('structure')
  load_i18n_module('common')

  let {
    on_structure_loaded = (_s: PymatgenStructure) => {},
    initial_session = null,
    dos_state = $bindable(),
  }: {
    on_structure_loaded?: (s: PymatgenStructure) => void
    initial_session?: DOSSessionInfo | null
    dos_state: DosViewState
  } = $props()

  // When an external session is passed in (e.g. from file open), adopt it
  $effect(() => {
    if (initial_session && initial_session !== session) {
      session = initial_session
      groups = []
      dos_state.dos_result = null
      dos_state.dband_result = null
    }
  })

  // State
  let session = $state<DOSSessionInfo | null>(null)

  // Register/unregister analysis session for AI tool access
  // Must untrack the register/unregister calls — they read+write analysis_sessions
  // ($state array), which would re-trigger this effect in an infinite loop.
  $effect(() => {
    if (session) {
      const { session_id, elements, efermi, nions } = session
      untrack(() => register_analysis_session({
        type: `dos`,
        session_id,
        label: `DOS (${elements?.join(`, `) ?? t('structure.dos_uploaded')})`,
        meta: { elements, efermi, nions },
        created_at: Date.now(),
      }))
    } else {
      untrack(() => unregister_analysis_session(`dos`))
    }
  })

  let uploading = $state(false)
  let computing = $state(false)
  let error_msg = $state(``)
  let dband_computing = $state(false)
  let show_dband = $state(false)
  let show_file_dialog = $state(false)
  let remote_loading = $state(false)

  // PROCAR companion file dialog
  let show_procar_dialog = $state(false)
  let procar_pending = $state<File | null>(null)
  let outcar_file = $state<File | null>(null)
  let poscar_file = $state<File | null>(null)

  // PDOS groups
  let groups: DOSGroup[] = $state([])

  // Parameters
  let sigma = $state(0.05)
  let emin = $state(-8.0)
  let emax = $state(6.0)
  let ngrid = $state(2000)
  let include_total = $state(true)

  // New group form state
  let selection_mode = $state<`element` | `index`>(`element`)
  let new_element = $state(``)
  let new_index_spec = $state(``)
  let new_orbital = $state(`d`)
  let new_orbital_custom = $state(``)
  let new_label = $state(``)
  let new_normalize = $state(false)

  // Display option local state for range inputs (string → parsed in $effect)
  let x_range_min = $state(``)
  let x_range_max = $state(``)
  let y_range_min = $state(``)
  let y_range_max = $state(``)

  // Sync range inputs → dos_state
  $effect(() => {
    const min = parseFloat(x_range_min)
    const max = parseFloat(x_range_max)
    dos_state.x_range = !isNaN(min) && !isNaN(max) ? [min, max] : null
  })
  $effect(() => {
    const min = parseFloat(y_range_min)
    const max = parseFloat(y_range_max)
    dos_state.y_range = !isNaN(min) && !isNaN(max) ? [min, max] : null
  })

  // D-band form
  let dband_sel_mode = $state<`element` | `index`>(`element`)
  let dband_element = $state(``)
  let dband_index_spec = $state(``)
  let dband_occupied_only = $state(true)

  // Derived
  let unique_elements: string[] = $derived(
    session ? [...new Set(session.elements)] : []
  )

  $effect(() => {
    if (selection_mode === `element` && !new_element && unique_elements.length > 0) {
      new_element = unique_elements[0]
    }
  })

  function get_orbital_value(): string {
    return new_orbital === `custom` ? new_orbital_custom : new_orbital
  }

  function parse_index_spec(spec: string, nions: number): number[] {
    const atoms = new Set<number>()
    for (const raw_part of spec.split(`,`)) {
      const part = raw_part.trim()
      if (!part) continue

      const range = part.match(/^(\d+)\s*-\s*(\d+)$/)
      if (range) {
        const start = Number.parseInt(range[1], 10)
        const end = Number.parseInt(range[2], 10)
        const lo = Math.min(start, end)
        const hi = Math.max(start, end)
        for (let one_based = lo; one_based <= hi; one_based += 1) {
          const idx = one_based - 1
          if (idx >= 0 && idx < nions) atoms.add(idx)
        }
        continue
      }

      if (/^\d+$/.test(part)) {
        const idx = Number.parseInt(part, 10) - 1
        if (idx >= 0 && idx < nions) atoms.add(idx)
      }
    }
    return [...atoms].sort((a, b) => a - b)
  }

  function select_atoms_locally(opts: { elements?: string[]; index_spec?: string }): number[] {
    if (!session) return []

    const selections: number[] = []
    if (opts.elements?.length) {
      const wanted = new Set(opts.elements.map((el) => el.trim()).filter(Boolean))
      session.elements.forEach((el, idx) => {
        if (wanted.has(String(el).trim())) selections.push(idx)
      })
    }

    if (opts.index_spec?.trim()) {
      selections.push(...parse_index_spec(opts.index_spec, session.nions))
    }

    return [...new Set(selections)].sort((a, b) => a - b)
  }

  async function resolve_atoms(opts: { elements?: string[]; index_spec?: string }): Promise<number[]> {
    if (!session) return []
    try {
      const atoms = await select_atoms(session.session_id, opts)
      if (atoms.length > 0) return atoms
    } catch (e) {
      console.warn(`DOS atom selection endpoint failed; falling back to local selection`, e)
    }
    return select_atoms_locally(opts)
  }

  function format_num(value: number | null | undefined, digits: number, suffix = ``): string {
    return typeof value === `number` && Number.isFinite(value)
      ? `${value.toFixed(digits)}${suffix}`
      : `—`
  }

  function format_percent(value: number | null | undefined, digits: number): string {
    return typeof value === `number` && Number.isFinite(value)
      ? `${(value * 100).toFixed(digits)}%`
      : `—`
  }

  function format_range(
    lower: number | null | undefined,
    upper: number | null | undefined,
    digits: number,
    suffix = ``,
  ): string {
    return typeof lower === `number` && Number.isFinite(lower) &&
      typeof upper === `number` && Number.isFinite(upper)
      ? `${lower.toFixed(digits)} ~ ${upper.toFixed(digits)}${suffix}`
      : `—`
  }

  function is_procar(f: File): boolean {
    return f.name.toUpperCase().startsWith(`PROCAR`)
  }
  function is_outcar(f: File): boolean {
    return f.name.toUpperCase().startsWith(`OUTCAR`)
  }
  function is_poscar(f: File): boolean {
    const n = f.name.toUpperCase()
    return n.startsWith(`POSCAR`) || n.startsWith(`CONTCAR`)
  }

  /** Open PROCAR companion dialog (or upload H5 directly). */
  function open_procar_dialog(procar: File, outcar?: File | null, poscar?: File | null) {
    procar_pending = procar
    outcar_file = outcar ?? null
    poscar_file = poscar ?? null
    show_procar_dialog = true
  }

  async function handle_remote_path(hpc_session_id: string, path: string) {
    uploading = true
    error_msg = ''
    try {
      // Use from-directory for directories (auto-detects PROCAR+OUTCAR+CONTCAR or vaspout.h5)
      // Use from-remote for single h5 files
      const lower = path.toLowerCase()
      if (lower.endsWith('.h5') || lower.endsWith('.hdf5')) {
        session = await dos_load_remote(hpc_session_id, path)
      } else {
        // Treat as directory or let from-directory handle it
        session = await dos_load_directory(hpc_session_id, path)
      }
      groups = []
      dos_state.dos_result = null
      dos_state.dband_result = null
      if (session?.structure) {
        on_structure_loaded(session.structure as PymatgenStructure)
      }
    } catch (e: any) {
      error_msg = e.message || t('structure.dos_remote_load_failed')
    } finally {
      uploading = false
    }
  }

  async function do_h5_upload(file: File) {
    uploading = true
    error_msg = ``
    try {
      session = await upload_h5(file)
      groups = []
      dos_state.dos_result = null
      dos_state.dband_result = null
      if (session.structure) {
        on_structure_loaded(session.structure as PymatgenStructure)
      }
    } catch (e: any) {
      error_msg = e.message || t('structure.dos_upload_failed')
    } finally {
      uploading = false
    }
  }

  async function handle_upload(event: Event) {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return

    if (is_procar(file)) {
      open_procar_dialog(file)
    } else {
      await do_h5_upload(file)
    }
  }

  async function handle_drop(event: DragEvent) {
    event.preventDefault()
    const files = event.dataTransfer?.files
    if (!files?.length) return

    const file_list = Array.from(files)
    const procar = file_list.find(is_procar)

    if (procar) {
      // Auto-identify companion files from the dropped set
      open_procar_dialog(
        procar,
        file_list.find(is_outcar),
        file_list.find(is_poscar),
      )
      return
    }

    // Single H5 file
    await do_h5_upload(file_list[0])
  }

  async function submit_procar_upload() {
    if (!procar_pending) return
    show_procar_dialog = false
    uploading = true
    error_msg = ``
    try {
      session = await upload_procar(procar_pending, outcar_file, poscar_file)
      groups = []
      dos_state.dos_result = null
      dos_state.dband_result = null
      if (session.structure) {
        on_structure_loaded(session.structure as PymatgenStructure)
      }
    } catch (e: any) {
      error_msg = e.message || t('structure.dos_upload_failed')
    } finally {
      uploading = false
      procar_pending = null
      outcar_file = null
      poscar_file = null
    }
  }

  function cancel_procar_dialog() {
    show_procar_dialog = false
    procar_pending = null
    outcar_file = null
    poscar_file = null
  }

  async function build_current_group(): Promise<DOSGroup | null> {
    if (!session) return null
    let atoms: number[]
    if (selection_mode === `element`) {
      if (!new_element) return null
      atoms = await resolve_atoms({ elements: [new_element] })
    } else {
      if (!new_index_spec.trim()) return null
      atoms = await resolve_atoms({ index_spec: new_index_spec.trim() })
    }

    if (atoms.length === 0) {
      error_msg = t('structure.dos_no_atoms_selection')
      return null
    }

    const orb = get_orbital_value()
    const sel_label = selection_mode === `element` ? new_element : `[${new_index_spec}]`
    const label = new_label || `${sel_label}-${orb}`

    return {
      atoms,
      channels: orb,
      label,
      normalize: new_normalize,
    }
  }

  async function add_group() {
    error_msg = ``

    try {
      const group = await build_current_group()
      if (!group) return

      groups = [...groups, group]
      new_label = ``
      error_msg = ``
    } catch (e: any) {
      error_msg = e.message
    }
  }

  function remove_group(idx: number) {
    groups = groups.filter((_, i) => i !== idx)
  }

  async function run_compute() {
    if (!session) return
    computing = true
    error_msg = ``
    try {
      let compute_groups = groups
      if (compute_groups.length === 0) {
        const group = await build_current_group()
        if (!group) return
        compute_groups = [group]
        groups = [group]
        new_label = ``
      }

      const params = { sigma, emin, emax, ngrid }
      const pdos = await compute_pdos(session.session_id, compute_groups, params)

      if (include_total) {
        const total = await compute_total_dos(session.session_id, params)
        pdos.series = [...total.series, ...pdos.series]
      }

      dos_state.dos_result = pdos
    } catch (e: any) {
      error_msg = e.message || t('structure.dos_computation_failed')
    } finally {
      computing = false
    }
  }

  async function run_dband() {
    if (!session) return
    dband_computing = true
    error_msg = ``
    try {
      let atoms: number[]
      if (dband_sel_mode === `element`) {
        if (!dband_element) return
        atoms = await resolve_atoms({ elements: [dband_element] })
      } else {
        if (!dband_index_spec.trim()) return
        atoms = await resolve_atoms({ index_spec: dband_index_spec.trim() })
      }

      if (atoms.length === 0) {
        error_msg = t('structure.dos_no_atoms_dband')
        dband_computing = false
        return
      }

      dos_state.dband_result = await compute_dband(session.session_id, atoms, {
        sigma,
        occupied_only_center: dband_occupied_only,
      })
    } catch (e: any) {
      error_msg = e.message
    } finally {
      dband_computing = false
    }
  }

  function close_session() {
    if (session) cleanup_session(session.session_id)
    session = null
    dos_state.dos_result = null
    dos_state.dband_result = null
    groups = []
  }

  // Cleanup on component destroy
  $effect(() => {
    const sid = session?.session_id
    return () => {
      if (sid) cleanup_session(sid)
    }
  })
</script>

<div class="dos-analysis">
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
        <span>{t('structure.dos_parsing_file')}</span>
      {:else}
        <p>{t('structure.dos_drop_prefix')} <code>vaspout.h5</code> {t('common.or')} <code>PROCAR</code> {t('structure.dos_drop_suffix')} {t('common.or')}</p>
        <div class="source-buttons">
          <label class="upload-btn">
            {t('structure.browse_local')}
            <input type="file" onchange={handle_upload} hidden />
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
      <span title={t('structure.elements_label')}>{session.ion_types.join(`, `)}</span>
      <span title={t('common.atoms')}>{t('structure.dos_ions_count', { n: session.nions })}</span>
      <span title={t('structure.dos_kpoints')}>{session.nkpts}k</span>
      <span title={t('structure.dos_bands')}>{session.nbands}b</span>
      <span title={t('structure.dos_spin')}>{session.nspin > 1 ? t('structure.dos_spin_pol') : t('structure.dos_non_spin')}</span>
      <button class="btn-small danger" title={t('structure.dos_close_session')} onclick={close_session}>
        &times;
      </button>
    </div>

    <!-- Group Builder -->
    <details open>
      <summary>{t('structure.dos_pdos_groups', { n: groups.length })}</summary>

      <!-- Selection mode tabs -->
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
            title={t('structure.dos_index_title')}
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
          <option value="custom">{t('structure.dos_custom_orbital')}</option>
        </select>

        {#if new_orbital === `custom`}
          <input
            type="text"
            placeholder="dxy,dz2"
            bind:value={new_orbital_custom}
            class="orbital-input"
            title={t('structure.dos_orbital_title')}
          />
        {/if}

        <input
          type="text"
          placeholder={t('common.label')}
          bind:value={new_label}
          class="label-input"
        />

        <label class="norm-toggle" title={t('structure.dos_per_atom_normalization')}>
          <input type="checkbox" bind:checked={new_normalize} />
          {t('structure.dos_norm_short')}
        </label>

        <button
          class="btn-small"
          onclick={add_group}
          disabled={selection_mode === `element` ? !new_element : !new_index_spec.trim()}
        >+</button>
      </div>

      {#if groups.length > 0}
        <ul class="group-list">
          {#each groups as g, i}
            <li>
              <span class="group-label">{g.label}</span>
              <span class="group-detail">
                {t('structure.dos_group_detail', { atoms: g.atoms.length, channels: g.channels })}{g.normalize ? ` (${t('structure.dos_norm_short')})` : ``}
              </span>
              <button class="btn-tiny" onclick={() => remove_group(i)}>&times;</button>
            </li>
          {/each}
        </ul>
      {/if}
    </details>

    <!-- Parameters -->
    <details>
      <summary>{t('structure.dos_parameters')}</summary>
      <div class="param-grid">
        <label>
          {t('structure.dos_sigma_ev')}
          <input type="number" bind:value={sigma} step="0.01" min="0.001" max="1" />
        </label>
        <label>
          {t('structure.dos_e_min_ev')}
          <input type="number" bind:value={emin} step="0.5" />
        </label>
        <label>
          {t('structure.dos_e_max_ev')}
          <input type="number" bind:value={emax} step="0.5" />
        </label>
        <label>
          {t('structure.dos_grid_pts')}
          <input type="number" bind:value={ngrid} step="100" min="100" max="10000" />
        </label>
        <label class="checkbox-label">
          <input type="checkbox" bind:checked={include_total} />
          {t('structure.dos_include_total')}
        </label>
      </div>
    </details>

    <!-- Display Options -->
    <details>
      <summary>{t('structure.dos_display_options')}</summary>
      <div class="display-opts">
        <label class="checkbox-label">
          <input type="checkbox" bind:checked={dos_state.show_fermi_line} />
          {t('structure.dos_fermi_level_line')}
        </label>
        <label class="checkbox-label">
          <input type="checkbox" bind:checked={dos_state.show_fill} />
          {t('structure.dos_fill_under_curves')}
        </label>
        <label class="checkbox-label">
          <input type="checkbox" bind:checked={dos_state.show_spin_down} />
          {t('structure.dos_show_spin_down')}
        </label>
        <label class="checkbox-label">
          <input type="checkbox" bind:checked={dos_state.show_dband_line} />
          {t('structure.dos_dband_center_line')}
        </label>
        <label>
          {t('structure.dos_orientation')}
          <select bind:value={dos_state.orientation}>
            <option value="vertical">{t('structure.dos_energy_on_x')}</option>
            <option value="horizontal">{t('structure.dos_energy_on_y')}</option>
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
          <input type="checkbox" bind:checked={dos_state.legend_visible} />
          {t('structure.dos_show_legend')}
        </label>
        <label class="checkbox-label">
          <input type="checkbox" bind:checked={dos_state.show_gridlines} />
          {t('structure.dos_show_gridlines')}
        </label>
        <label class="checkbox-label">
          <input type="checkbox" bind:checked={dos_state.show_axis_lines} />
          {t('structure.dos_show_axis_lines')}
        </label>
        <div class="range-row">
          <span>{t('structure.dos_axis_width')}</span>
          <input
            type="number"
            bind:value={dos_state.axis_line_width}
            min="0.5" max="5" step="0.5"
            class="range-input"
          />
        </div>
        <div class="range-row">
          <span>{t('structure.dos_tick_length')}</span>
          <input
            type="number"
            bind:value={dos_state.tick_length}
            min="0" max="15" step="1"
            class="range-input"
          />
        </div>
        <div class="range-row">
          <span>{t('structure.dos_tick_width')}</span>
          <input
            type="number"
            bind:value={dos_state.tick_width}
            min="0.5" max="5" step="0.5"
            class="range-input"
          />
        </div>
        <div class="range-row">
          <span>{t('structure.dos_title_size')}</span>
          <input
            type="number"
            bind:value={dos_state.title_size}
            min="6" max="24" step="1"
            class="range-input"
          />
        </div>
        <div class="range-row">
          <span>{t('structure.dos_font_size')}</span>
          <input
            type="number"
            bind:value={dos_state.font_size}
            min="6" max="24" step="1"
            class="range-input"
          />
        </div>
      </div>
    </details>

    <!-- Series Visibility -->
    {#if dos_state.dos_result && dos_state.dos_result.series.length > 0}
      <details>
        <summary>{t('structure.dos_series_visibility')}</summary>
        <div class="display-opts">
          {#each dos_state.dos_result.series as s}
            <label class="checkbox-label">
              <input
                type="checkbox"
                checked={!dos_state.hidden_series.includes(s.label)}
                onchange={(e) => {
                  const checked = (e.target as HTMLInputElement).checked
                  if (checked) {
                    dos_state.hidden_series = dos_state.hidden_series.filter((l) => l !== s.label)
                  } else {
                    dos_state.hidden_series = [...dos_state.hidden_series, s.label]
                  }
                }}
              />
              {s.label}
            </label>
          {/each}
        </div>
      </details>
    {/if}

    <!-- Line style overrides per group -->
    {#if groups.length > 0}
      <details>
        <summary>{t('structure.dos_line_styles')}</summary>
        <div class="line-styles">
          <div class="line-style-row">
            <span class="group-label">{t('structure.palette_label')}</span>
            <select
              onchange={(e) => {
                const preset = (e.target as HTMLSelectElement).value as keyof typeof PALETTE_PRESETS
                const assigned = apply_palette(groups.map((g) => g.label), preset)
                const next = { ...dos_state.line_styles }
                for (const [label, color] of Object.entries(assigned)) {
                  next[label] = { ...next[label], color }
                }
                dos_state.line_styles = next
              }}
            >
              {#each PALETTE_ORDER as name}
                <option value={name}>{t(PALETTE_LABEL_KEY[name])}</option>
              {/each}
            </select>
          </div>
          {#each groups as g, gi}
            <div class="line-style-row">
              <span class="group-label">{g.label}</span>
              <input
                type="color"
                value={dos_state.line_styles[g.label]?.color ?? PALETTE_PRESETS.default[gi % PALETTE_PRESETS.default.length]}
                class="color-input"
                oninput={(e) => {
                  const target = e.target as HTMLInputElement
                  dos_state.line_styles = { ...dos_state.line_styles, [g.label]: { ...dos_state.line_styles[g.label], color: target.value } }
                }}
              />
              <select
                value={dos_state.line_styles[g.label]?.dash ?? `solid`}
                onchange={(e) => {
                  const target = e.target as HTMLSelectElement
                  dos_state.line_styles = { ...dos_state.line_styles, [g.label]: { ...dos_state.line_styles[g.label], dash: target.value } }
                }}
              >
                <option value="solid">{t('structure.dos_line_solid')}</option>
                <option value="dash">{t('structure.dos_line_dashed')}</option>
                <option value="dot">{t('structure.dos_line_dotted')}</option>
                <option value="dashdot">{t('structure.dos_line_dashdot')}</option>
              </select>
              <input
                type="number"
                value={dos_state.line_styles[g.label]?.width ?? 1.5}
                min="0.5"
                max="5"
                step="0.5"
                class="width-input"
                onchange={(e) => {
                  const target = e.target as HTMLInputElement
                  dos_state.line_styles = { ...dos_state.line_styles, [g.label]: { ...dos_state.line_styles[g.label], width: parseFloat(target.value) } }
                }}
              />
              {#if dos_state.show_fill}
                <input
                  type="color"
                  value={dos_state.line_styles[g.label]?.fill_color ?? dos_state.line_styles[g.label]?.color ?? PALETTE_PRESETS.default[gi % PALETTE_PRESETS.default.length]}
                  class="color-input"
                  title={t('structure.cohp_fill_color')}
                  oninput={(e) => {
                    const target = e.target as HTMLInputElement
                    dos_state.line_styles = { ...dos_state.line_styles, [g.label]: { ...dos_state.line_styles[g.label], fill_color: target.value } }
                  }}
                />
              {/if}
            </div>
          {/each}
        </div>
      </details>
    {/if}

    <!-- Compute -->
    <button
      class="btn-compute"
      onclick={run_compute}
      disabled={computing || (groups.length === 0 && (selection_mode === `element` ? !new_element : !new_index_spec.trim()))}
    >
      {#if computing}
        <Spinner /> {t('structure.computing')}
      {:else}
        {t('structure.dos_compute_pdos')}
      {/if}
    </button>

    <!-- D-band Analysis -->
    <details bind:open={show_dband}>
      <summary>{t('structure.dos_dband_analysis')}</summary>
      <div class="tab-bar">
        <button
          class="tab-btn"
          class:active={dband_sel_mode === `element`}
          onclick={() => dband_sel_mode = `element`}
        >{t('structure.dos_element')}</button>
        <button
          class="tab-btn"
          class:active={dband_sel_mode === `index`}
          onclick={() => dband_sel_mode = `index`}
        >{t('structure.dos_index')}</button>
      </div>
      <div class="dband-form">
        {#if dband_sel_mode === `element`}
          <select bind:value={dband_element}>
            <option value="">{t('structure.dos_element')}</option>
            {#each unique_elements as el}
              <option value={el}>{el}</option>
            {/each}
          </select>
        {:else}
          <input
            type="text"
            placeholder="1-5,8-10"
            bind:value={dband_index_spec}
            class="index-input"
            title={t('structure.dos_index_title_short')}
          />
        {/if}
        <label class="checkbox-label">
          <input type="checkbox" bind:checked={dband_occupied_only} />
          {t('structure.dos_occupied_only')}
        </label>
        <button
          class="btn-small"
          onclick={run_dband}
          disabled={dband_computing || (dband_sel_mode === `element` ? !dband_element : !dband_index_spec.trim())}
        >
          {#if dband_computing}
            <Spinner />
          {:else}
            {t('structure.dos_analyze')}
          {/if}
        </button>
      </div>

      {#if dos_state.dband_result}
        <table class="dband-table">
          <tbody>
            <tr><td>{t('structure.dos_center_abs')}</td><td>{format_num(dos_state.dband_result.center_abs, 4, ` eV`)}</td></tr>
            <tr><td>{t('structure.dos_center_rel_ef')}</td><td>{format_num(dos_state.dband_result.center_rel, 4, ` eV`)}</td></tr>
            <tr><td>{t('structure.dos_width_rms')}</td><td>{format_num(dos_state.dband_result.width, 4, ` eV`)}</td></tr>
            <tr><td>{t('structure.dos_variance')}</td><td>{format_num(dos_state.dband_result.variance, 4, ` eV²`)}</td></tr>
            <tr><td>n<sub>d</sub></td><td>{format_num(dos_state.dband_result.n_d, 3)}</td></tr>
            <tr><td>{t('structure.dos_total_d_weight')}</td><td>{format_num(dos_state.dband_result.total_d_weight, 3)}</td></tr>
            <tr><td>{t('structure.dos_filling')}</td><td>{format_percent(dos_state.dband_result.filling_fraction, 1)}</td></tr>
            <tr><td>{t('structure.dos_skewness')}</td><td>{format_num(dos_state.dband_result.skewness, 4)}</td></tr>
            <tr><td>{t('structure.dos_kurtosis')}</td><td>{format_num(dos_state.dband_result.kurtosis, 4)}</td></tr>
            <tr>
              <td>{t('structure.dos_band_edges')}</td>
              <td>{format_range(dos_state.dband_result.lower_edge, dos_state.dband_result.upper_edge, 2, ` eV`)}</td>
            </tr>
          </tbody>
        </table>
      {/if}
    </details>
  {/if}

  {#if error_msg}
    <div class="error-msg">{error_msg}</div>
  {/if}
</div>

<FileSourceDialog
  bind:show={show_file_dialog}
  file_types={['.h5', '.hdf5', 'PROCAR']}
  title={t('structure.dos_load_data')}
  description={t('structure.dos_load_data_desc')}
  onfile={async (file) => {
    if (is_procar(file)) {
      open_procar_dialog(file)
    } else {
      await do_h5_upload(file)
    }
  }}
  onremote_path={handle_remote_path}
  onclose={() => show_file_dialog = false}
/>

{#if show_procar_dialog}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="procar-backdrop" onclick={cancel_procar_dialog}>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="procar-modal" onclick={(e) => e.stopPropagation()}>
      <div class="procar-header">
        <h3>{t('structure.dos_upload_procar')}</h3>
        <button class="close-btn" onclick={cancel_procar_dialog}>&times;</button>
      </div>

      <div class="procar-body">
        <!-- PROCAR (always present) -->
        <div class="file-slot done">
          <span class="slot-label">PROCAR</span>
          <span class="slot-file">{procar_pending?.name}</span>
        </div>

        <!-- OUTCAR slot -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="file-slot"
          class:done={outcar_file}
          ondragover={(e) => e.preventDefault()}
          ondrop={(e) => {
            e.preventDefault()
            e.stopPropagation()
            const f = e.dataTransfer?.files[0]
            if (f) outcar_file = f
          }}
        >
          <span class="slot-label">OUTCAR</span>
          {#if outcar_file}
            <span class="slot-file">
              {outcar_file.name}
              <button class="btn-tiny" onclick={() => outcar_file = null}>&times;</button>
            </span>
          {:else}
            <label class="slot-browse">
              {t('structure.dos_drop_or_browse')}
              <input type="file" onchange={(e) => {
                const f = (e.target as HTMLInputElement).files?.[0]
                if (f) outcar_file = f
              }} hidden />
            </label>
          {/if}
          {#if !outcar_file}
            <span class="slot-warn">{t('structure.dos_without_outcar')}</span>
          {/if}
        </div>

        <!-- POSCAR slot -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="file-slot"
          class:done={poscar_file}
          ondragover={(e) => e.preventDefault()}
          ondrop={(e) => {
            e.preventDefault()
            e.stopPropagation()
            const f = e.dataTransfer?.files[0]
            if (f) poscar_file = f
          }}
        >
          <span class="slot-label">POSCAR / CONTCAR</span>
          {#if poscar_file}
            <span class="slot-file">
              {poscar_file.name}
              <button class="btn-tiny" onclick={() => poscar_file = null}>&times;</button>
            </span>
          {:else}
            <label class="slot-browse">
              {t('structure.dos_drop_or_browse')}
              <input type="file" onchange={(e) => {
                const f = (e.target as HTMLInputElement).files?.[0]
                if (f) poscar_file = f
              }} hidden />
            </label>
          {/if}
          {#if !poscar_file}
            <span class="slot-warn">{t('structure.dos_without_poscar')}</span>
          {/if}
        </div>
      </div>

      <div class="procar-footer">
        <button class="btn-cancel" onclick={submit_procar_upload}>
          {t('structure.dos_skip_procar_only')}
        </button>
        <button class="btn-upload" onclick={submit_procar_upload}>
          {t('common.upload')}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .dos-analysis {
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
  .orbital-input { width: 70px; }
  .norm-toggle { display: flex; align-items: center; gap: 3px; font-size: 0.85em; color: var(--text-color-muted, rgba(255, 255, 255, 0.6)); cursor: pointer; }
  .group-list { list-style: none; padding: 0; margin: 6px 0 0; }
  .group-list li { display: flex; align-items: center; gap: 6px; padding: 3px 0; border-bottom: 1px solid light-dark(rgba(0, 0, 0, 0.06), rgba(255, 255, 255, 0.05)); }
  .group-label { font-weight: 500; color: var(--text-color, #fff); }
  .group-detail { font-size: 0.85em; color: var(--text-color-muted, rgba(255, 255, 255, 0.5)); flex: 1; }
  .param-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 6px; }
  .param-grid label { display: flex; flex-direction: column; gap: 2px; font-size: 0.85em; color: var(--text-color-muted, rgba(255, 255, 255, 0.7)); }
  .param-grid input[type="number"] {
    padding: 3px 5px; background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.08));
    border: 1px solid light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15)); border-radius: 4px;
    color: var(--text-color, #fff); font-size: 0.95em; width: 100%; box-sizing: border-box;
  }
  .checkbox-label { flex-direction: row !important; align-items: center; gap: 5px !important; grid-column: span 2; display: flex; font-size: 0.85em; color: var(--text-color-muted, rgba(255, 255, 255, 0.7)); cursor: pointer; }
  .display-opts { display: flex; flex-direction: column; gap: 5px; margin-top: 6px; }
  .display-opts label { font-size: 0.85em; color: var(--text-color-muted, rgba(255, 255, 255, 0.7)); }
  .display-opts select { padding: 3px 5px; background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.08)); border: 1px solid light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15)); border-radius: 4px; color: var(--text-color, #fff); font-size: 0.9em; margin-top: 2px; }
  .range-row { display: flex; align-items: center; gap: 4px; font-size: 0.85em; color: var(--text-color-muted, rgba(255, 255, 255, 0.6)); }
  .range-input { width: 55px; padding: 2px 4px; background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.08)); border: 1px solid light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15)); border-radius: 3px; color: var(--text-color, #fff); font-size: 0.9em; }
  .line-styles { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; }
  .line-style-row { display: flex; align-items: center; gap: 4px; font-size: 0.85em; }
  .line-style-row .group-label { min-width: 60px; font-size: 0.9em; }
  .line-style-row select { padding: 2px 4px; background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.08)); border: 1px solid light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15)); border-radius: 3px; color: var(--text-color, #fff); font-size: 0.85em; }
  .width-input { width: 45px; padding: 2px 4px; background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.08)); border: 1px solid light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15)); border-radius: 3px; color: var(--text-color, #fff); font-size: 0.85em; }
  .color-input { width: 28px; height: 22px; padding: 0; border: 1px solid light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15)); border-radius: 3px; cursor: pointer; background: transparent; }
  .btn-compute { padding: 6px 12px; background: #2563eb; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 0.9em; display: flex; align-items: center; justify-content: center; gap: 6px; }
  .btn-compute:hover:not(:disabled) { background: #1d4ed8; }
  .btn-compute:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-small { padding: 3px 8px; background: light-dark(rgba(0, 0, 0, 0.06), rgba(255, 255, 255, 0.1)); border: 1px solid light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15)); border-radius: 3px; color: var(--text-color, #fff); cursor: pointer; font-size: 0.85em; }
  .btn-small:hover { background: light-dark(rgba(0, 0, 0, 0.12), rgba(255, 255, 255, 0.2)); }
  .btn-small.danger { color: var(--error-color, #f55); }
  .btn-tiny { padding: 1px 5px; background: transparent; border: none; color: var(--text-color-muted, rgba(255, 255, 255, 0.4)); cursor: pointer; font-size: 1em; }
  .btn-tiny:hover { color: var(--error-color, #f55); }
  .dband-form { display: flex; gap: 6px; align-items: center; margin-top: 6px; flex-wrap: wrap; }
  .dband-form select, .dband-form input[type="text"] { padding: 3px 5px; background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.08)); border: 1px solid light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15)); border-radius: 4px; color: var(--text-color, #fff); font-size: 0.9em; }
  .dband-table { width: 100%; margin-top: 6px; border-collapse: collapse; font-size: 0.9em; }
  .dband-table td { padding: 3px 6px; border-bottom: 1px solid light-dark(rgba(0, 0, 0, 0.06), rgba(255, 255, 255, 0.05)); }
  .dband-table td:first-child { color: var(--text-color-muted, rgba(255, 255, 255, 0.6)); width: 40%; }
  .dband-table td:last-child { color: var(--text-color, #fff); font-family: monospace; }
  .error-msg { padding: 5px 8px; background: light-dark(rgba(220, 38, 38, 0.1), rgba(255, 60, 60, 0.15)); border: 1px solid light-dark(rgba(220, 38, 38, 0.25), rgba(255, 60, 60, 0.3)); border-radius: 4px; color: var(--error-color, #f88); font-size: 0.85em; }
  .section-divider { border: none; border-top: 1px solid light-dark(rgba(0, 0, 0, 0.08), rgba(255, 255, 255, 0.08)); margin: 4px 0; }
  .source-buttons { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
  .remote-btn { background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.08)); border: 1px solid light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15)); }
  .remote-btn:hover { background: light-dark(rgba(0, 0, 0, 0.1), rgba(255, 255, 255, 0.15)); }

  /* PROCAR companion file dialog */
  .procar-backdrop {
    position: fixed; inset: 0; z-index: 1000;
    background: rgba(0, 0, 0, 0.5); backdrop-filter: blur(2px);
    display: flex; align-items: center; justify-content: center;
    padding: 16px;
    overflow: auto;
    box-sizing: border-box;
  }
  .procar-modal {
    background: light-dark(#fff, #1e1e2e); border-radius: 10px;
    width: min(420px, calc(100vw - 32px));
    max-height: calc(100vh - 32px);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    min-width: 0;
    box-sizing: border-box;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    border: 1px solid light-dark(rgba(0, 0, 0, 0.1), rgba(255, 255, 255, 0.1));
  }
  .procar-header {
    display: flex; align-items: center; justify-content: space-between;
    gap: 8px;
    padding: 10px 14px; border-bottom: 1px solid light-dark(rgba(0, 0, 0, 0.08), rgba(255, 255, 255, 0.08));
    min-width: 0;
    flex-shrink: 0;
  }
  .procar-header h3 { margin: 0; font-size: 0.95em; color: var(--text-color, #fff); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .close-btn { background: none; border: none; color: var(--text-color-muted, rgba(255, 255, 255, 0.5)); font-size: 1.3em; cursor: pointer; padding: 0 4px; flex-shrink: 0; }
  .close-btn:hover { color: var(--text-color, #fff); }
  .procar-body { padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; overflow-y: auto; min-height: 0; min-width: 0; }
  .file-slot {
    padding: 8px 10px; border-radius: 6px;
    background: light-dark(rgba(0, 0, 0, 0.03), rgba(255, 255, 255, 0.04));
    border: 1px dashed light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15));
    display: flex; flex-direction: column; gap: 4px;
    min-width: 0;
  }
  .file-slot.done {
    border-style: solid;
    border-color: light-dark(rgba(34, 197, 94, 0.4), rgba(34, 197, 94, 0.3));
    background: light-dark(rgba(34, 197, 94, 0.05), rgba(34, 197, 94, 0.06));
  }
  .slot-label { font-size: 0.8em; font-weight: 600; color: var(--text-color-muted, rgba(255, 255, 255, 0.6)); }
  .slot-file { font-size: 0.85em; color: var(--text-color, #fff); display: flex; align-items: center; gap: 6px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .slot-browse {
    font-size: 0.82em; color: var(--accent-color, #007acc); cursor: pointer;
    text-decoration: underline; text-underline-offset: 2px;
  }
  .slot-browse:hover { opacity: 0.8; }
  .slot-warn {
    font-size: 0.78em; color: light-dark(#b45309, #fbbf24); font-style: italic;
  }
  .procar-footer {
    display: flex; justify-content: flex-end; gap: 8px;
    padding: 10px 14px; border-top: 1px solid light-dark(rgba(0, 0, 0, 0.08), rgba(255, 255, 255, 0.08));
    flex-wrap: wrap;
    flex-shrink: 0;
  }
  .btn-cancel {
    padding: 5px 12px; border-radius: 4px; cursor: pointer; font-size: 0.85em;
    background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.08));
    border: 1px solid light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15));
    color: var(--text-color-muted, rgba(255, 255, 255, 0.7));
  }
  .btn-upload {
    padding: 5px 14px; border-radius: 4px; cursor: pointer; font-size: 0.85em;
    background: var(--accent-color, #007acc); color: white; border: none;
  }
</style>

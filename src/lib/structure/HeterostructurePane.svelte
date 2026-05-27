<script lang="ts">
  import type { PymatgenStructure, AnyStructure } from '$lib/structure'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'
  import { structure_to_extxyz_str } from '$lib/structure/export'
  import { download } from '$lib/io/fetch'
  import { DraggablePane } from '$lib'
  import type { ComponentProps } from 'svelte'
  import {
    searchHeterostructureMatches,
    buildHeterostructure,
    buildHeterostructureManual,
    buildHeterostructureIntermat,
    downloadRegistryCandidates,
    searchLateralMatches,
    buildLateralInterface,
    type HeterostructureSearchParams,
    type HeterostructureBuildParams,
    type HeterostructureMatch,
    type HeterostructureTermination,
    type IntermatBuildParams,
    type IntermatBuildResult,
    type LateralSearchParams,
    type LateralMatch,
    type LateralBuildResult,
    gridScanHeterostructure,
    type GridScanParams,
    type GridScanResult,
  } from '$lib/api/heterostructure'
  import { parse_structure_file, parsed_to_pymatgen } from '$lib/structure/parse'
  import { SERVER_URL } from '$lib/api/config'

  load_i18n_module('structure')

  type Mode = `slab` | `bulk` | `lateral`

  let {
    structure = $bindable(),
    pane_open = $bindable(false),
    server_url = SERVER_URL,
    show_toggle = true,
    embedded = false,
    on_push_undo,
    on_structure_change,
    on_save_to_database,
    on_export_to_hpc,
    pane_props = {},
    toggle_props = {},
  }: {
    structure?: PymatgenStructure
    pane_open?: boolean
    server_url?: string
    show_toggle?: boolean
    embedded?: boolean
    on_push_undo?: () => void
    on_structure_change?: (structure: AnyStructure) => void
    on_save_to_database?: (structure: Record<string, unknown>) => void
    on_export_to_hpc?: (structure: Record<string, unknown>) => void
    pane_props?: ComponentProps<typeof DraggablePane>[`pane_props`]
    toggle_props?: ComponentProps<typeof DraggablePane>[`toggle_props`]
  } = $props()

  // -- Mode --
  let mode = $state<Mode>(`slab`)

  // -- Film structure --
  let film_structure = $state<PymatgenStructure | null>(null)
  let film_filename = $state<string | null>(null)
  let film_error = $state<string | null>(null)
  let film_input_mode = $state<`upload` | `paste`>(`upload`)
  let film_paste_text = $state(``)

  // -- Miller indices (bulk mode) --
  let sub_h = $state(0)
  let sub_k = $state(0)
  let sub_l = $state(1)
  let film_h = $state(0)
  let film_k = $state(0)
  let film_l = $state(1)

  // -- Slab mode: ZSL search params --
  let max_area = $state(400)
  let max_area_ratio_tol = $state(0.09)
  let max_length_tol = $state(0.03)
  let max_angle_tol = $state(0.01)
  let show_advanced = $state(false)

  // -- Slab mode: build params --
  let gap = $state(2.0)
  let vacuum_slab = $state(20.0)
  let twist_angle = $state(0.0)

  // -- Registry candidates --
  let candidates_mode = $state<`auto` | `grid` | `step`>(`auto`)
  let grid_n = $state(4)           // for 'grid' mode
  let step_angstrom = $state(0.5)  // for 'step' mode, Å
  let candidate_target_z = $state(0.0)  // 0 = auto (vacuum=20), >0 = fixed total c-axis (Å)
  let candidate_fmt = $state(`cif`)
  let candidate_status = $state<`idle` | `generating` | `done` | `error`>(`idle`)

  // -- Slab mode: manual transform --
  let slab_manual = $state(false)
  let sub_t00 = $state(1), sub_t01 = $state(0), sub_t10 = $state(0), sub_t11 = $state(1)
  let film_t00 = $state(1), film_t01 = $state(0), film_t10 = $state(0), film_t11 = $state(1)

  // -- Bulk mode (intermat) params --
  let im_sub_thickness = $state(16.0)
  let im_film_thickness = $state(16.0)
  let im_separation = $state(2.5)
  let im_vacuum = $state(8.0)
  let im_max_area = $state(300)
  let im_ltol = $state(0.08)
  let im_atol = $state(1.0)
  let im_area_ratio_tol = $state(1.0)
  let im_apply_strain = $state(false)
  let im_disp_intvl = $state(0.0)
  let im_show_advanced = $state(false)
  let im_result = $state<IntermatBuildResult | null>(null)

  // -- Lateral mode --
  let lat_interface_axis = $state(0) // 0=a, 1=b
  let lat_max_length = $state(100.0)
  let lat_max_strain = $state(5.0)
  let lat_width_A = $state(1)
  let lat_width_B = $state(1)
  let lat_buffer = $state(0.0)
  let lat_vacuum = $state(20.0)
  let lat_matches = $state<LateralMatch[]>([])
  let lat_selected_idx = $state<number | null>(null)
  let lat_result = $state<LateralBuildResult | null>(null)
  let lat_selected = $derived(lat_selected_idx !== null ? lat_matches[lat_selected_idx] : null)

  // -- Grid Scan (inside slab mode, after build) --
  let gs_n_grid_x = $state(6)
  let gs_n_grid_y = $state(6)
  let gs_symprec = $state(0.1)
  let gs_result = $state<GridScanResult | null>(null)
  let gs_selected_idx = $state<number | null>(null)
  let gs_scanning = $state(false)
  // Saved from build result: original film + how many substrate atoms
  let gs_film_snapshot = $state<PymatgenStructure | null>(null)
  let gs_n_atoms_substrate = $state(0)

  // -- Shared state --
  let original_substrate = $state<PymatgenStructure | undefined>(undefined)
  let search_status = $state<`idle` | `searching` | `done` | `error`>(`idle`)
  let build_status = $state<`idle` | `building` | `done` | `error`>(`idle`)
  let error_message = $state<string | null>(null)
  let result_message = $state<string | null>(null)
  let matches = $state<HeterostructureMatch[]>([])
  let terminations = $state<HeterostructureTermination[]>([])
  let selected_match_idx = $state<number | null>(null)
  let selected_term_idx = $state(0)

  let selected_match = $derived(
    selected_match_idx !== null ? matches[selected_match_idx] : null,
  )

  let can_build = $derived(!!structure && !!film_structure)

  async function handle_film_upload(event: Event) {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return

    film_error = null
    film_structure = null
    film_filename = file.name

    try {
      const text = await file.text()
      const parsed = parse_structure_file(text, file.name)
      if (!parsed) {
        film_error = `Could not parse structure from file`
        return
      }
      film_structure = parsed_to_pymatgen(parsed)
    } catch (err) {
      film_error = err instanceof Error ? err.message : String(err)
    }
  }

  function handle_film_paste() {
    if (!film_paste_text.trim()) return
    film_error = null
    film_structure = null
    film_filename = `pasted`
    try {
      const parsed = parse_structure_file(film_paste_text, `POSCAR`)
      if (!parsed) {
        film_error = `Could not parse structure from pasted text`
        return
      }
      film_structure = parsed_to_pymatgen(parsed)
    } catch (err) {
      film_error = err instanceof Error ? err.message : String(err)
    }
  }

  function swap_structures() {
    if (!structure || !film_structure) return
    const tmp = structure
    structure = film_structure
    film_structure = tmp
    on_structure_change?.(structure)
  }

  // -- Slab mode: ZSL search --
  async function do_search() {
    if (!structure || !film_structure) return

    error_message = null
    result_message = null
    matches = []
    terminations = []
    selected_match_idx = null
    original_substrate = structure
    search_status = `searching`
    build_status = `idle`

    try {
      const params: HeterostructureSearchParams = {
        mode: `slab`,
        max_area,
        max_area_ratio_tol,
        max_length_tol,
        max_angle_tol,
      }

      const result = await searchHeterostructureMatches(
        structure,
        film_structure,
        params,
        server_url,
      )

      matches = result.matches
      terminations = result.terminations
      search_status = `done`
      result_message = result.message
    } catch (err) {
      search_status = `error`
      error_message = err instanceof Error ? err.message : String(err)
    }
  }

  // -- Slab mode: build from selected ZSL match --
  async function do_build_slab() {
    if (!structure || !film_structure || !selected_match) return

    on_push_undo?.()
    error_message = null
    build_status = `building`

    try {
      const build_params: HeterostructureBuildParams = {
        gap,
        vacuum: vacuum_slab,
        twist_angle,
      }

      const search_params: HeterostructureSearchParams = {
        mode: `slab`,
        max_area,
        max_area_ratio_tol,
        max_length_tol,
        max_angle_tol,
      }

      // Save film snapshot for grid scan symmetry analysis
      gs_film_snapshot = film_structure

      const result = await buildHeterostructure(
        structure,
        film_structure,
        selected_match,
        0,
        build_params,
        search_params,
        server_url,
      )

      gs_n_atoms_substrate = result.n_atoms_substrate
      structure = result.structure
      on_structure_change?.(result.structure)
      build_status = `done`
      result_message = result.message
    } catch (err) {
      build_status = `error`
      error_message = err instanceof Error ? err.message : String(err)
    }
  }

  // -- Registry candidates: download zip --
  async function do_download_candidates() {
    const sub = original_substrate ?? structure
    if (!sub || !film_structure || !selected_match) return

    candidate_status = `generating`
    error_message = null

    try {
      const search_params: HeterostructureSearchParams = {
        mode: `slab`,
        max_area,
        max_area_ratio_tol,
        max_length_tol,
        max_angle_tol,
      }

      const eff_n_shift = candidates_mode === `grid` ? grid_n : 0
      const eff_step = candidates_mode === `step` ? step_angstrom : 0.0

      await downloadRegistryCandidates(
        sub,
        film_structure,
        selected_match,
        eff_n_shift,
        gap,
        vacuum_slab,
        candidate_fmt,
        search_params,
        eff_step,
        candidate_target_z,
        server_url,
      )

      candidate_status = `done`
    } catch (err) {
      candidate_status = `error`
      error_message = err instanceof Error ? err.message : String(err)
    }
  }

  // -- Slab mode: manual transform build --
  async function do_build_manual() {
    if (!structure || !film_structure) return

    on_push_undo?.()
    error_message = null
    build_status = `building`

    try {
      // Save film snapshot for grid scan symmetry analysis
      gs_film_snapshot = film_structure

      const result = await buildHeterostructureManual(
        structure,
        film_structure,
        [[sub_t00, sub_t01], [sub_t10, sub_t11]],
        [[film_t00, film_t01], [film_t10, film_t11]],
        gap,
        vacuum_slab,
        twist_angle,
        [0, 0],
        server_url,
      )

      gs_n_atoms_substrate = result.n_atoms_substrate
      structure = result.structure
      on_structure_change?.(result.structure)
      build_status = `done`
      result_message = result.message
    } catch (err) {
      build_status = `error`
      error_message = err instanceof Error ? err.message : String(err)
    }
  }

  // -- Bulk mode: intermat one-step generate --
  async function do_build_bulk() {
    if (!structure || !film_structure) return

    on_push_undo?.()
    error_message = null
    im_result = null
    build_status = `building`

    try {
      const params: IntermatBuildParams = {
        substrate_miller: [sub_h, sub_k, sub_l],
        film_miller: [film_h, film_k, film_l],
        substrate_thickness: im_sub_thickness,
        film_thickness: im_film_thickness,
        separation: im_separation,
        vacuum: im_vacuum,
        max_area: im_max_area,
        ltol: im_ltol,
        atol: im_atol,
        max_area_ratio_tol: im_area_ratio_tol,
        apply_strain: im_apply_strain,
        disp_intvl: im_disp_intvl,
      }

      const result = await buildHeterostructureIntermat(
        structure,
        film_structure,
        params,
        server_url,
      )

      im_result = result
      structure = result.structure
      on_structure_change?.(result.structure)
      build_status = `done`
      result_message = result.message
    } catch (err) {
      build_status = `error`
      error_message = err instanceof Error ? err.message : String(err)
    }
  }

  // -- Lateral mode handlers --
  async function do_search_lateral() {
    if (!structure || !film_structure) return

    search_status = `searching`
    error_message = null
    result_message = null
    lat_matches = []
    lat_selected_idx = null
    lat_result = null

    try {
      const params: LateralSearchParams = {
        interface_axis: lat_interface_axis,
        max_length: lat_max_length,
        max_strain: lat_max_strain,
      }
      const result = await searchLateralMatches(structure, film_structure, params, server_url)
      lat_matches = result.matches
      result_message = result.message
      search_status = `done`
    } catch (err) {
      error_message = err instanceof Error ? err.message : String(err)
      search_status = `error`
    }
  }

  async function do_build_lateral() {
    if (!structure || !film_structure || !lat_selected) return

    on_push_undo?.()
    build_status = `building`
    error_message = null
    result_message = null

    try {
      const params = {
        width_A: lat_width_A,
        width_B: lat_width_B,
        buffer: lat_buffer,
        vacuum: lat_vacuum,
      }
      const search_params: LateralSearchParams = {
        interface_axis: lat_interface_axis,
        max_length: lat_max_length,
        max_strain: lat_max_strain,
      }
      const result = await buildLateralInterface(
        structure, film_structure, lat_selected, params, search_params, server_url,
      )
      lat_result = result
      structure = result.structure
      on_structure_change?.(result.structure)
      result_message = result.message
      build_status = `done`
    } catch (err) {
      error_message = err instanceof Error ? err.message : String(err)
      build_status = `error`
    }
  }

  async function do_grid_scan() {
    if (!structure || !gs_film_snapshot || !gs_n_atoms_substrate) return

    error_message = null
    result_message = null
    gs_result = null
    gs_selected_idx = null
    gs_scanning = true

    try {
      const params: GridScanParams = {
        n_grid_x: gs_n_grid_x,
        n_grid_y: gs_n_grid_y,
        symprec: gs_symprec,
      }
      const result = await gridScanHeterostructure(
        structure, gs_film_snapshot, gs_n_atoms_substrate, params, server_url,
      )
      gs_result = result
      result_message = result.message
    } catch (err) {
      error_message = err instanceof Error ? err.message : String(err)
    } finally {
      gs_scanning = false
    }
  }

  function apply_grid_scan_entry(idx: number) {
    if (!gs_result || idx >= gs_result.entries.length) return
    on_push_undo?.()
    structure = gs_result.entries[idx].structure
    on_structure_change?.(gs_result.entries[idx].structure)
    gs_selected_idx = idx
  }

  function gs_build_trajectory_content(): string {
    if (!gs_result || gs_result.entries.length === 0) return ``
    return gs_result.entries
      .map((entry) => {
        const struct_with_meta = {
          ...entry.structure,
          shift_fx: entry.shift_frac[0],
          shift_fy: entry.shift_frac[1],
        }
        return structure_to_extxyz_str(struct_with_meta as AnyStructure)
      })
      .join(`\n`)
  }

  function gs_export_file() {
    const content = gs_build_trajectory_content()
    if (!content) return
    download(content, `grid_scan_${gs_result!.n_irreducible}shifts.extxyz`, `text/plain`)
  }

  function gs_save_to_database() {
    if (!gs_result || !on_save_to_database) return
    for (const entry of gs_result.entries) {
      on_save_to_database(entry.structure as unknown as Record<string, unknown>)
    }
    result_message = `Saved ${gs_result.entries.length} structures to database`
  }

  function gs_export_to_hpc() {
    if (!gs_result || !on_export_to_hpc) return
    // Pass the first structure to trigger the HPC export dialog;
    // the parent (desktop app) handles showing the file picker
    on_export_to_hpc(gs_result.entries[0].structure as unknown as Record<string, unknown>)
  }

  function format_transformation(t: number[][]): string {
    return `[${t[0].join(`,`)}]×[${t[1].join(`,`)}]`
  }
</script>

{#snippet pane_content()}
  <h4>{t('structure.heterostructure')}</h4>

  <!-- Mode tabs -->
  <div class="mode-tabs">
    <button
      type="button"
      class="mode-tab"
      class:active={mode === 'slab'}
      onclick={() => (mode = 'slab')}
    >{t('structure.heterostructure_mode_slab')}</button>
    <button
      type="button"
      class="mode-tab"
      class:active={mode === 'bulk'}
      onclick={() => (mode = 'bulk')}
    >{t('structure.heterostructure_mode_bulk')}</button>
    <button
      type="button"
      class="mode-tab"
      class:active={mode === 'lateral'}
      onclick={() => (mode = 'lateral')}
    >{t('structure.heterostructure_mode_lateral')}</button>
  </div>

  {#if mode === 'slab'}
    <div class="hint">{t('structure.heterostructure_hint_slab')}</div>
  {:else if mode === 'bulk'}
    <div class="hint">{t('structure.heterostructure_hint_bulk')}</div>
  {:else}
    <div class="hint">{t('structure.heterostructure_hint_lateral')}</div>
  {/if}

  <!-- Substrate info -->
  <fieldset class="struct-fieldset">
    <legend>{t('structure.heterostructure_substrate_loaded')}</legend>
    {#if structure}
      <div class="struct-info">
        {structure.sites.length} atoms
      </div>
      {#if mode === 'bulk'}
        <div class="miller-row">
          <span class="miller-label">Miller (hkl):</span>
          <input type="number" class="miller-input" bind:value={sub_h} min={-9} max={9} />
          <input type="number" class="miller-input" bind:value={sub_k} min={-9} max={9} />
          <input type="number" class="miller-input" bind:value={sub_l} min={-9} max={9} />
        </div>
      {/if}
    {:else}
      <div class="hint">Load a structure first to use as substrate.</div>
    {/if}
  </fieldset>

  <!-- Film input -->
  <fieldset class="struct-fieldset">
    <legend>{t('structure.heterostructure_film')}</legend>
    <div class="film-input-toggle">
      <button type="button" class:active={film_input_mode === 'upload'} onclick={() => (film_input_mode = 'upload')}>{t('structure.heterostructure_upload')}</button>
      <button type="button" class:active={film_input_mode === 'paste'} onclick={() => (film_input_mode = 'paste')}>{t('structure.heterostructure_paste')}</button>
    </div>
    {#if film_input_mode === 'upload'}
      <div class="file-upload-row">
        <label class="upload-btn">
          Upload structure file
          <input type="file" accept=".cif,.poscar,.vasp,.xyz,.json" onchange={handle_film_upload} hidden />
        </label>
        {#if film_filename && film_filename !== 'pasted'}
          <span class="filename">{film_filename}</span>
        {/if}
      </div>
    {:else}
      <div class="paste-section">
        <textarea
          bind:value={film_paste_text}
          placeholder="Paste POSCAR, CIF, or XYZ content here..."
          rows={6}
          spellcheck="false"
        ></textarea>
        <button type="button" class="parse-btn" onclick={handle_film_paste} disabled={!film_paste_text.trim()}>
          Parse
        </button>
      </div>
    {/if}
    {#if film_error}
      <div class="parse-error">{film_error}</div>
    {/if}
    {#if film_structure}
      <div class="struct-info">
        {film_structure.sites.length} atoms
      </div>
      {#if mode === 'bulk'}
        <div class="miller-row">
          <span class="miller-label">Miller (hkl):</span>
          <input type="number" class="miller-input" bind:value={film_h} min={-9} max={9} />
          <input type="number" class="miller-input" bind:value={film_k} min={-9} max={9} />
          <input type="number" class="miller-input" bind:value={film_l} min={-9} max={9} />
        </div>
      {/if}
    {/if}
  </fieldset>

  <!-- Swap button -->
  {#if structure && film_structure}
    <div class="swap-row">
      <button type="button" class="swap-btn" onclick={swap_structures}>
        Swap substrate / film
      </button>
    </div>
  {/if}

  {#if mode === 'slab'}
    <!-- ==================== SLAB MODE ==================== -->

    <!-- Auto / Manual toggle -->
    <label class="checkbox-row">
      <input type="checkbox" bind:checked={slab_manual} />
      <span>Manual lattice transform (skip ZSL search)</span>
    </label>

    {#if !slab_manual}
      <!-- Auto: ZSL search -->
      <fieldset class="search-fieldset">
        <legend>Lattice Match Search</legend>
        <div class="search-params">
          <label>
            <span>Max area (Å²)</span>
            <input type="number" bind:value={max_area} min={10} max={5000} step={50} />
          </label>
        </div>

        <details bind:open={show_advanced}>
          <summary>Advanced</summary>
          <div class="advanced-params">
            <label>
              <span>Area ratio tol</span>
              <input type="number" bind:value={max_area_ratio_tol} min={0.001} max={1} step={0.01} />
            </label>
            <label>
              <span>Length tol</span>
              <input type="number" bind:value={max_length_tol} min={0.001} max={0.5} step={0.01} />
            </label>
            <label>
              <span>Angle tol</span>
              <input type="number" bind:value={max_angle_tol} min={0.001} max={0.5} step={0.01} />
            </label>
          </div>
        </details>

        <div class="controls">
          <button
            type="button"
            onclick={do_search}
            disabled={search_status === `searching` || !can_build}
            class="primary"
          >
            {search_status === `searching` ? `Searching...` : `Search Matches`}
          </button>
        </div>
      </fieldset>

      <!-- Results table -->
      {#if matches.length > 0}
        <div class="results-section">
          <div class="results-header">{matches.length} lattice matches found</div>
          <div class="results-table-wrapper">
            <table class="results-table">
              <thead>
                <tr>
                  <th></th>
                  <th>Area (Å²)</th>
                  <th>Strain %</th>
                  <th>Atoms</th>
                  <th>Sub. cell</th>
                  <th>Film cell</th>
                </tr>
              </thead>
              <tbody>
                {#each matches as match, idx}
                  <tr
                    class:selected={selected_match_idx === idx}
                    onclick={() => (selected_match_idx = idx)}
                  >
                    <td><input type="radio" checked={selected_match_idx === idx} /></td>
                    <td>{match.match_area.toFixed(1)}</td>
                    <td>{match.strain.toFixed(2)}</td>
                    <td title="{match.n_atoms_substrate} sub + {match.n_atoms_film} film">{match.n_atoms_substrate + match.n_atoms_film}</td>
                    <td class="mono">{format_transformation(match.substrate_transformation)}</td>
                    <td class="mono">{format_transformation(match.film_transformation)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        </div>

        <!-- Build from selected match -->
        {#if selected_match}
          <div class="build-section">
            <div class="build-info">
              Selected: area = {selected_match.match_area.toFixed(1)} Å², strain = {selected_match.strain.toFixed(2)}%
            </div>
            <div class="build-params">
              <label>
                <span>Gap (Å)</span>
                <input type="number" bind:value={gap} min={0.5} max={10} step={0.1} />
              </label>
              <label>
                <span>Vacuum (Å)</span>
                <input type="number" bind:value={vacuum_slab} min={0} max={60} step={1} />
              </label>
              <label>
                <span>Twist angle (°)</span>
                <input type="number" bind:value={twist_angle} min={0} max={180} step={0.5} />
              </label>
            </div>
            <div class="controls">
              <button
                type="button"
                onclick={do_build_slab}
                disabled={build_status === `building`}
                class="primary build-btn"
              >
                {build_status === `building` ? `Building...` : `Build Heterostructure`}
              </button>
            </div>

            <!-- Registry candidates batch download -->
            <details class="candidates-section">
              <summary>Registry Candidates</summary>
              <div class="build-params">
                <label>
                  <span>Mode</span>
                  <select bind:value={candidates_mode}>
                    <option value="auto">Auto (surface atoms)</option>
                    <option value="grid">N×N grid</option>
                    <option value="step">Step (Å)</option>
                  </select>
                </label>
                {#if candidates_mode === `grid`}
                  <label>
                    <span>Grid size</span>
                    <select bind:value={grid_n}>
                      <option value={3}>3×3</option>
                      <option value={4}>4×4</option>
                      <option value={5}>5×5</option>
                      <option value={6}>6×6</option>
                      <option value={8}>8×8</option>
                    </select>
                  </label>
                {:else if candidates_mode === `step`}
                  <label>
                    <span>Step (Å)</span>
                    <input
                      type="number"
                      bind:value={step_angstrom}
                      min="0.1"
                      max="10"
                      step="0.1"
                      style="width:5em"
                    />
                  </label>
                {/if}
                <label>
                  <span>Z (Å)</span>
                  <input
                    type="number"
                    bind:value={candidate_target_z}
                    min={0}
                    max={200}
                    step={0.5}
                    placeholder="auto"
                    style="width:5em"
                  />
                </label>
                <label>
                  <span>Format</span>
                  <select bind:value={candidate_fmt}>
                    <option value="cif">CIF</option>
                    <option value="poscar">POSCAR</option>
                    <option value="xyz">XYZ</option>
                    <option value="extxyz">ExtXYZ</option>
                  </select>
                </label>
              </div>
              <div class="controls">
                <button
                  type="button"
                  onclick={do_download_candidates}
                  disabled={candidate_status === `generating`}
                  class="build-btn"
                >
                  {candidate_status === `generating`
                    ? `Generating...`
                    : candidates_mode === `auto`
                      ? `Download candidates (auto)`
                      : candidates_mode === `step`
                        ? `Download candidates (${step_angstrom} Å step)`
                        : `Download ${grid_n}×${grid_n} candidates`}
                </button>
              </div>
            </details>
          </div>
        {/if}
      {/if}
    {:else}
      <!-- Manual transform mode -->
      <fieldset class="search-fieldset">
        <legend>Manual Supercell Transforms</legend>
        <div class="transform-section">
          <div class="transform-group">
            <span class="transform-title">Substrate 2×2</span>
            <div class="matrix-row">
              <input type="number" class="matrix-input" bind:value={sub_t00} />
              <input type="number" class="matrix-input" bind:value={sub_t01} />
            </div>
            <div class="matrix-row">
              <input type="number" class="matrix-input" bind:value={sub_t10} />
              <input type="number" class="matrix-input" bind:value={sub_t11} />
            </div>
          </div>
          <div class="transform-group">
            <span class="transform-title">Film 2×2</span>
            <div class="matrix-row">
              <input type="number" class="matrix-input" bind:value={film_t00} />
              <input type="number" class="matrix-input" bind:value={film_t01} />
            </div>
            <div class="matrix-row">
              <input type="number" class="matrix-input" bind:value={film_t10} />
              <input type="number" class="matrix-input" bind:value={film_t11} />
            </div>
          </div>
        </div>
        <div class="build-params">
          <label>
            <span>Gap (Å)</span>
            <input type="number" bind:value={gap} min={0.5} max={10} step={0.1} />
          </label>
          <label>
            <span>Vacuum (Å)</span>
            <input type="number" bind:value={vacuum_slab} min={0} max={60} step={1} />
          </label>
          <label>
            <span>Twist angle (°)</span>
            <input type="number" bind:value={twist_angle} min={0} max={180} step={0.5} />
          </label>
        </div>
        <div class="controls">
          <button
            type="button"
            onclick={do_build_manual}
            disabled={build_status === `building` || !can_build}
            class="primary build-btn"
          >
            {build_status === `building` ? `Building...` : `Build (Manual)`}
          </button>
        </div>
      </fieldset>
    {/if}

    <!-- Grid Scan: available after build (shifts film atoms in the built heterostructure) -->
    {#if build_status === 'done' && structure && gs_film_snapshot && gs_n_atoms_substrate > 0}
      <details class="grid-scan-section">
        <summary>Stacking Grid Scan</summary>
        <div class="build-params">
          <label>
            <span>Grid N<sub>x</sub></span>
            <input type="number" bind:value={gs_n_grid_x} min={2} max={30} step={1} />
          </label>
          <label>
            <span>Grid N<sub>y</sub></span>
            <input type="number" bind:value={gs_n_grid_y} min={2} max={30} step={1} />
          </label>
          <label>
            <span>Sym. tol. (Å)</span>
            <input type="number" bind:value={gs_symprec} min={0.001} max={1} step={0.01} />
          </label>
        </div>
        <div class="controls" style="margin-top: 6pt">
          <button
            type="button"
            onclick={do_grid_scan}
            disabled={gs_scanning}
            class="primary"
          >
            {gs_scanning ? `Scanning...` : `Run Grid Scan`}
          </button>
          <span class="hint" style="margin-left: 6pt">
            {gs_n_grid_x * gs_n_grid_y} points
          </span>
        </div>

        {#if gs_result}
          <div class="im-results" style="margin-top: 6pt">
            <div class="im-results-grid">
              <span class="im-label">Sym. ops:</span>
              <span class="im-value">{gs_result.n_symmetry_ops} ({gs_result.reduction_ratio.toFixed(0)}× zone reduction)</span>
              <span class="im-label">Structures:</span>
              <span class="im-value">{gs_result.n_irreducible}</span>
            </div>
            <div class="hint" style="margin-top: 2pt">{gs_result.message}</div>
          </div>

          <div class="results-table-wrapper" style="margin-top: 4pt">
            <table class="results-table">
              <thead>
                <tr><th></th><th>f<sub>x</sub></th><th>f<sub>y</sub></th><th>Atoms</th></tr>
              </thead>
              <tbody>
                {#each gs_result.entries as entry, idx}
                  <tr
                    class:selected={gs_selected_idx === idx}
                    onclick={() => apply_grid_scan_entry(idx)}
                  >
                    <td><input type="radio" checked={gs_selected_idx === idx} /></td>
                    <td>{entry.shift_frac[0].toFixed(3)}</td>
                    <td>{entry.shift_frac[1].toFixed(3)}</td>
                    <td>{entry.n_atoms}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>

          <div class="controls" style="margin-top: 6pt; flex-wrap: wrap; gap: 4pt">
            <button type="button" onclick={gs_export_file}>
              Export .extxyz
            </button>
            {#if on_save_to_database}
              <button type="button" onclick={gs_save_to_database}>
                Save to Database
              </button>
            {/if}
            {#if on_export_to_hpc}
              <button type="button" onclick={gs_export_to_hpc}>
                Export to HPC
              </button>
            {/if}
          </div>
        {/if}
      </details>
    {/if}

  {:else if mode === 'bulk'}
    <!-- ==================== BULK MODE (intermat) ==================== -->
    <fieldset class="search-fieldset">
      <legend>Interface Parameters</legend>
      <div class="build-params">
        <label>
          <span>Sub. thickness (Å)</span>
          <input type="number" bind:value={im_sub_thickness} min={2} max={100} step={1} />
        </label>
        <label>
          <span>Film thickness (Å)</span>
          <input type="number" bind:value={im_film_thickness} min={2} max={100} step={1} />
        </label>
        <label>
          <span>Separation (Å)</span>
          <input type="number" bind:value={im_separation} min={0.5} max={10} step={0.1} />
        </label>
        <label>
          <span>Vacuum (Å)</span>
          <input type="number" bind:value={im_vacuum} min={0} max={60} step={1} />
        </label>
        <label>
          <span>Max area (Å²)</span>
          <input type="number" bind:value={im_max_area} min={10} max={5000} step={50} />
        </label>
        <label>
          <span>Disp. scan interval</span>
          <input type="number" bind:value={im_disp_intvl} min={0} max={1} step={0.05} />
        </label>
      </div>

      <label class="checkbox-row">
        <input type="checkbox" bind:checked={im_apply_strain} />
        <span>Apply strain (film → substrate lattice)</span>
      </label>

      <details bind:open={im_show_advanced}>
        <summary>Advanced tolerances</summary>
        <div class="advanced-params">
          <label>
            <span>Length tol</span>
            <input type="number" bind:value={im_ltol} min={0.001} max={0.5} step={0.01} />
          </label>
          <label>
            <span>Angle tol (°)</span>
            <input type="number" bind:value={im_atol} min={0.01} max={10} step={0.1} />
          </label>
          <label>
            <span>Area ratio tol</span>
            <input type="number" bind:value={im_area_ratio_tol} min={0.01} max={2} step={0.1} />
          </label>
        </div>
      </details>

      <div class="controls">
        <button
          type="button"
          onclick={do_build_bulk}
          disabled={build_status === `building` || !can_build}
          class="primary build-btn"
        >
          {build_status === `building` ? `Generating...` : `Generate Interface`}
        </button>
      </div>
    </fieldset>

    <!-- Intermat results -->
    {#if im_result}
      <div class="im-results">
        <div class="im-results-header">Mismatch Info</div>
        <div class="im-results-grid">
          <span class="im-label">Mismatch u:</span>
          <span class="im-value">{im_result.mismatch_u.toFixed(2)}%</span>
          <span class="im-label">Mismatch v:</span>
          <span class="im-value">{im_result.mismatch_v.toFixed(2)}%</span>
          <span class="im-label">Mismatch angle:</span>
          <span class="im-value">{im_result.mismatch_angle.toFixed(2)}°</span>
          <span class="im-label">Strain (VM):</span>
          <span class="im-value">{im_result.strain.toFixed(2)}%</span>
          <span class="im-label">Area (sub/film):</span>
          <span class="im-value">{im_result.area_substrate.toFixed(1)} / {im_result.area_film.toFixed(1)} Å²</span>
          <span class="im-label">Atoms:</span>
          <span class="im-value">{im_result.n_atoms} ({im_result.n_atoms_substrate} sub + {im_result.n_atoms_film} film)</span>
        </div>
      </div>
    {/if}
  {:else if mode === 'lateral'}
    <!-- ==================== LATERAL MODE ==================== -->

    <fieldset class="search-fieldset">
      <legend>1D Edge Match Search</legend>

      <div class="search-params">
        <label>
          <span>Interface axis</span>
          <div class="radio-row">
            <label><input type="radio" bind:group={lat_interface_axis} value={0} /> a</label>
            <label><input type="radio" bind:group={lat_interface_axis} value={1} /> b</label>
          </div>
        </label>
        <label>
          <span>Max edge length (Å)</span>
          <input type="number" bind:value={lat_max_length} min={5} max={500} step={10} />
        </label>
        <label>
          <span>Max strain (%)</span>
          <input type="number" bind:value={lat_max_strain} min={0.1} max={20} step={0.5} />
        </label>
      </div>

      <div class="controls">
        <button
          type="button"
          onclick={do_search_lateral}
          disabled={search_status === `searching` || !can_build}
          class="primary"
        >
          {search_status === `searching` ? `Searching...` : `Search Matches`}
        </button>
      </div>
    </fieldset>

    <!-- Lateral results table -->
    {#if lat_matches.length > 0}
      <div class="results-section">
        <div class="results-header">{lat_matches.length} lateral matches found</div>
        <div class="results-table-wrapper">
          <table class="results-table">
            <thead>
              <tr>
                <th></th>
                <th>n₁</th>
                <th>n₂</th>
                <th>Edge A (Å)</th>
                <th>Edge B (Å)</th>
                <th>Strain %</th>
                <th>Atoms</th>
              </tr>
            </thead>
            <tbody>
              {#each lat_matches as match, idx}
                <tr
                  class:selected={lat_selected_idx === idx}
                  onclick={() => (lat_selected_idx = idx)}
                >
                  <td><input type="radio" checked={lat_selected_idx === idx} /></td>
                  <td>{match.n1}</td>
                  <td>{match.n2}</td>
                  <td>{match.edge_length_A.toFixed(2)}</td>
                  <td>{match.edge_length_B.toFixed(2)}</td>
                  <td>{match.strain_percent.toFixed(2)}</td>
                  <td title="{match.n_atoms_A} A + {match.n_atoms_B} B">{match.n_atoms_A + match.n_atoms_B}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </div>

      <!-- Build from selected lateral match -->
      {#if lat_selected}
        <div class="build-section">
          <div class="build-info">
            Selected: n₁={lat_selected.n1}, n₂={lat_selected.n2}, strain={lat_selected.strain_percent.toFixed(2)}%
          </div>
          <div class="build-params">
            <label>
              <span>Width A (repeats)</span>
              <input type="number" bind:value={lat_width_A} min={1} max={10} step={1} />
            </label>
            <label>
              <span>Width B (repeats)</span>
              <input type="number" bind:value={lat_width_B} min={1} max={10} step={1} />
            </label>
            <label>
              <span>Buffer (Å)</span>
              <input type="number" bind:value={lat_buffer} min={0} max={10} step={0.5} />
            </label>
            <label>
              <span>Vacuum (Å)</span>
              <input type="number" bind:value={lat_vacuum} min={0} max={60} step={1} />
            </label>
          </div>
          <div class="controls">
            <button
              type="button"
              onclick={do_build_lateral}
              disabled={build_status === `building`}
              class="primary build-btn"
            >
              {build_status === `building` ? `Building...` : `Build Lateral Heterostructure`}
            </button>
          </div>
        </div>
      {/if}
    {/if}

    <!-- Lateral build result info -->
    {#if lat_result}
      <div class="im-results">
        <div class="results-header">Lateral Interface Info</div>
        <div class="im-results-grid">
          <span class="im-label">Interface length:</span>
          <span class="im-value">{lat_result.interface_length.toFixed(2)} Å</span>
          <span class="im-label">Strain:</span>
          <span class="im-value">{lat_result.strain.toFixed(2)}%</span>
          <span class="im-label">Atoms:</span>
          <span class="im-value">{lat_result.n_atoms} ({lat_result.n_atoms_A} A + {lat_result.n_atoms_B} B)</span>
        </div>
      </div>
    {/if}
  {/if}

  {#if error_message}
    <div class="error">{error_message}</div>
  {/if}

  {#if result_message && (search_status === `done` || build_status === `done`)}
    <div class="success">{result_message}</div>
  {/if}
{/snippet}

{#if !embedded}
  <DraggablePane
    bind:show={pane_open}
    open_icon="Cross"
    closed_icon="Layers"
    show_toggle={show_toggle && !embedded}
    pane_props={{ ...pane_props, class: `heterostructure-pane ${pane_props?.class ?? ``}` }}
    toggle_props={{
      title: pane_open ? `` : t('structure.heterostructure_builder'),
      ...toggle_props,
      class: `heterostructure-toggle ${toggle_props?.class ?? ``}`,
    }}
  >
    {@render pane_content()}
  </DraggablePane>
{:else}
  {@render pane_content()}
{/if}

<style>
  h4 {
    margin: 0 0 6pt;
  }

  .mode-tabs {
    display: flex;
    gap: 0;
    margin-bottom: 8pt;
    border: 1px solid var(--border-color, #ccc);
    border-radius: 3pt;
    overflow: hidden;
  }

  .mode-tab {
    flex: 1;
    padding: 4pt 6pt;
    border: none;
    background: var(--bg-secondary, #f5f5f5);
    cursor: pointer;
    font-size: 0.85em;
    color: var(--text-secondary, #666);
    transition: background 0.15s, color 0.15s;
  }

  .mode-tab:not(:last-child) {
    border-right: 1px solid var(--border-color, #ccc);
  }

  .mode-tab:hover:not(.active) {
    background: var(--bg-hover, #eee);
  }

  .mode-tab.active {
    background: var(--accent-color, #2196f3);
    color: white;
    font-weight: 600;
  }

  .hint {
    color: var(--text-secondary, #888);
    font-size: 0.9em;
    margin-bottom: 6pt;
  }

  .struct-fieldset,
  .search-fieldset {
    border: 1px solid var(--border-color, #ddd);
    border-radius: 3pt;
    padding: 6pt;
    margin-bottom: 8pt;
  }

  .struct-fieldset legend,
  .search-fieldset legend {
    font-size: 0.85em;
    font-weight: 600;
    color: var(--text-secondary, #555);
    padding: 0 4pt;
  }

  .struct-info {
    font-size: 0.9em;
    color: var(--text-secondary, #666);
    margin-bottom: 4pt;
  }

  .miller-row {
    display: flex;
    align-items: center;
    gap: 4pt;
  }

  .miller-label {
    font-size: 0.85em;
    color: var(--text-secondary, #666);
    min-width: 70pt;
  }

  .miller-input {
    width: 40pt;
    padding: 2pt 4pt;
    text-align: center;
    font-family: monospace;
  }

  .file-upload-row {
    display: flex;
    align-items: center;
    gap: 8pt;
    margin-bottom: 4pt;
  }

  .upload-btn {
    padding: 3pt 8pt;
    border: 1px solid var(--accent-color, #2196f3);
    border-radius: 3pt;
    background: transparent;
    color: var(--accent-color, #2196f3);
    cursor: pointer;
    font-size: 0.9em;
  }

  .upload-btn:hover {
    background: rgba(33, 150, 243, 0.1);
  }

  .filename {
    font-size: 0.85em;
    color: var(--text-secondary, #666);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .film-input-toggle {
    display: flex;
    gap: 0;
    margin-bottom: 6pt;
    border: 1px solid var(--border-color, #ccc);
    border-radius: 3pt;
    overflow: hidden;
  }
  .film-input-toggle button {
    flex: 1;
    padding: 2pt 6pt;
    border: none;
    background: var(--bg-secondary, #f5f5f5);
    cursor: pointer;
    font-size: 0.8em;
  }
  .film-input-toggle button.active {
    background: var(--accent-color, #2196f3);
    color: white;
  }
  .paste-section textarea {
    width: 100%;
    padding: 4pt;
    font-family: monospace;
    font-size: 0.85em;
    resize: vertical;
    min-height: 80px;
    box-sizing: border-box;
  }
  .parse-btn {
    padding: 2pt 8pt;
    border: 1px solid var(--accent-color, #2196f3);
    border-radius: 3pt;
    background: transparent;
    color: var(--accent-color, #2196f3);
    cursor: pointer;
    font-size: 0.85em;
    margin-top: 4pt;
  }
  .parse-btn:hover:not(:disabled) {
    background: rgba(33, 150, 243, 0.1);
  }
  .parse-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .parse-error {
    color: #c62828;
    font-size: 0.85em;
    margin: 2pt 0;
  }

  .swap-row {
    display: flex;
    justify-content: center;
    margin-bottom: 8pt;
  }

  .swap-btn {
    padding: 2pt 10pt;
    border: 1px solid var(--border-color, #ccc);
    border-radius: 3pt;
    background: var(--bg-secondary, #f5f5f5);
    cursor: pointer;
    font-size: 0.85em;
  }

  .swap-btn:hover {
    background: var(--bg-hover, #eee);
  }

  .checkbox-row {
    display: flex;
    align-items: center;
    gap: 6pt;
    margin: 4pt 0 8pt;
    font-size: 0.85em;
    color: var(--text-secondary, #666);
    cursor: pointer;
    flex-direction: row;
  }

  .checkbox-row input[type='checkbox'] {
    width: auto;
  }

  .radio-row {
    display: flex;
    gap: 10pt;
    font-size: 0.9em;
  }
  .radio-row label {
    display: flex;
    align-items: center;
    gap: 3pt;
    cursor: pointer;
  }

  .search-params {
    margin-bottom: 6pt;
  }

  .search-params label,
  .advanced-params label,
  .build-params label {
    display: flex;
    flex-direction: column;
    gap: 2pt;
    margin-bottom: 4pt;
  }

  .search-params label span,
  .advanced-params label span,
  .build-params label span {
    color: var(--text-secondary, #666);
    font-size: 0.8em;
  }

  .search-params input,
  .advanced-params input,
  .build-params input {
    width: 100%;
    padding: 3pt 4pt;
    font-family: monospace;
    font-size: 0.9em;
  }

  .advanced-params {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 6pt;
    margin-top: 6pt;
  }

  .controls {
    display: flex;
    gap: 6pt;
    margin: 6pt 0;
  }

  .controls button.primary {
    padding: 4pt 8pt;
    background: var(--accent-color, #2196f3);
    color: white;
    border: none;
    border-radius: 3pt;
    flex: 1;
    cursor: pointer;
  }

  .controls button.primary:hover:not(:disabled) {
    background: var(--accent-color-dark, #1976d2);
  }

  .controls button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .controls button.build-btn {
    background: #4caf50;
  }

  .controls button.build-btn:hover:not(:disabled) {
    background: #388e3c;
  }

  .results-section {
    margin: 8pt 0;
  }

  .results-header {
    font-size: 0.9em;
    color: var(--text-secondary, #555);
    margin-bottom: 4pt;
  }

  .results-table-wrapper {
    max-height: 200px;
    overflow-y: auto;
    border: 1px solid var(--border-color, #ddd);
    border-radius: 3pt;
  }

  .results-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.85em;
  }

  .results-table th {
    position: sticky;
    top: 0;
    background: var(--bg-secondary, #f5f5f5);
    padding: 3pt 4pt;
    text-align: left;
    border-bottom: 1px solid var(--border-color, #ddd);
  }

  .results-table td {
    padding: 2pt 4pt;
    border-bottom: 1px solid var(--border-color, #eee);
  }

  .results-table td.mono {
    font-family: monospace;
    font-size: 0.85em;
  }

  .results-table tr {
    cursor: pointer;
  }

  .results-table tr:hover {
    background: rgba(33, 150, 243, 0.08);
  }

  .results-table tr.selected {
    background: rgba(33, 150, 243, 0.15);
  }

  .build-section {
    margin: 8pt 0;
    padding: 6pt;
    background: rgba(76, 175, 80, 0.06);
    border-radius: 3pt;
  }

  .build-info {
    font-size: 0.9em;
    margin-bottom: 6pt;
    color: var(--text-secondary, #555);
  }

  .build-params {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6pt;
    margin-bottom: 4pt;
  }

  .transform-section {
    display: flex;
    gap: 12pt;
    margin-bottom: 8pt;
  }

  .transform-group {
    flex: 1;
  }

  .transform-title {
    display: block;
    font-size: 0.8em;
    color: var(--text-secondary, #666);
    margin-bottom: 4pt;
  }

  .matrix-row {
    display: flex;
    gap: 4pt;
    margin-bottom: 2pt;
  }

  .matrix-input {
    width: 50pt;
    padding: 3pt 4pt;
    text-align: center;
    font-family: monospace;
    font-size: 0.9em;
  }

  .im-results {
    margin: 8pt 0;
    padding: 6pt;
    background: rgba(33, 150, 243, 0.06);
    border-radius: 3pt;
  }

  .im-results-header {
    font-size: 0.9em;
    font-weight: 600;
    color: var(--text-secondary, #555);
    margin-bottom: 4pt;
  }

  .im-results-grid {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 2pt 8pt;
    font-size: 0.85em;
  }

  .im-label {
    color: var(--text-secondary, #666);
  }

  .im-value {
    font-family: monospace;
  }

  .error {
    margin: 4pt 0;
    padding: 4pt 6pt;
    background: rgba(244, 67, 54, 0.1);
    border-radius: 3pt;
  }

  .success {
    margin: 4pt 0;
    padding: 4pt 6pt;
    background: rgba(76, 175, 80, 0.1);
    border-radius: 3pt;
    color: #2e7d32;
  }
</style>

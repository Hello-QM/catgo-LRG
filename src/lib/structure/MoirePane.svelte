<script lang="ts">
  import type { PymatgenStructure, Site } from '$lib/structure'
  import type { AtomColorConfig } from '$lib/structure/atom-properties'
  import { DraggablePane } from '$lib'
  import type { ComponentProps } from 'svelte'
  import {
    searchMoireAngles,
    buildMoireBilayer,
    type MoireLayerInput,
    type MoireAngleSearchParams,
    type MoireBuildParams,
    type MoireCandidate,
    type MoireAngleSearchResult,
    type StrainLayer,
  } from '$lib/api/moire'
  import { SERVER_URL } from '$lib/api/config'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'

  load_i18n_module('structure')

  let {
    structure = $bindable(),
    pane_open = $bindable(false),
    atom_color_config = $bindable<Partial<AtomColorConfig>>({}),
    server_url = SERVER_URL,
    show_toggle = true,
    embedded = false,
    on_push_undo,
    on_structure_change,
    pane_props = {},
    toggle_props = {},
  }: {
    structure?: PymatgenStructure
    pane_open?: boolean
    atom_color_config?: Partial<AtomColorConfig>
    server_url?: string
    show_toggle?: boolean
    embedded?: boolean
    on_push_undo?: () => void
    on_structure_change?: (structure: PymatgenStructure) => void
    pane_props?: ComponentProps<typeof DraggablePane>[`pane_props`]
    toggle_props?: ComponentProps<typeof DraggablePane>[`toggle_props`]
  } = $props()

  // Color function for layer-based coloring: Layer A vs Layer B
  const layer_color_fn = (site: Site) => String(site.properties?.layer ?? `A`)

  // -- Input mode --
  let has_lattice = $derived(
    !!(structure && `lattice` in structure && (structure as any).lattice?.matrix),
  )
  let input_mode = $state<`structure` | `manual`>(`manual`)
  // Auto-select structure mode when a periodic structure is loaded, fall back to manual otherwise
  $effect(() => {
    if (has_lattice && input_mode === `manual`) input_mode = `structure`
    else if (!has_lattice && input_mode === `structure`) input_mode = `manual`
  })
  let is_homobilayer = $state(true)

  // -- Layer A parameters (Twister format: celldm + dimensionless vectors + basis) --
  let celldm_a = $state(`2.46 2.46 25.0`)
  let a1_str = $state(`0.5 0.8660254 0.0`)
  let a2_str = $state(`-0.5 0.8660254 0.0`)
  let elements_a_str = $state(`C C`)
  let basis_a_str = $state(`0.0 0.0\n0.333333 0.333333`)

  // -- Layer B parameters (for heterobilayer) --
  let celldm_b = $state(`3.301 3.301 25.0`)
  let b1_str = $state(`0.5 0.8660254 0.0`)
  let b2_str = $state(`-0.5 0.8660254 0.0`)
  let elements_b_str = $state(`Mo S S`)
  let basis_b_str = $state(`0.0 0.0\n0.333333 0.333333\n0.666667 0.666667`)

  // -- Presets --
  type Preset = {
    name: string
    celldm: string
    v1: string
    v2: string
    elements: string
    basis: string
  }

  const presets: Preset[] = [
    {
      name: `Graphene`,
      celldm: `2.46 2.46 25.0`,
      v1: `0.5 0.8660254 0.0`,
      v2: `-0.5 0.8660254 0.0`,
      elements: `C C`,
      basis: `0.0 0.0\n0.333333 0.333333`,
    },
    {
      name: `hBN`,
      celldm: `2.512 2.512 25.0`,
      v1: `0.5 0.8660254 0.0`,
      v2: `-0.5 0.8660254 0.0`,
      elements: `B N`,
      basis: `0.0 0.0\n0.333333 0.333333`,
    },
    {
      name: `MoS₂`,
      celldm: `3.160 3.160 25.0`,
      v1: `0.5 0.8660254 0.0`,
      v2: `-0.5 0.8660254 0.0`,
      elements: `Mo S S`,
      basis: `0.0 0.0\n0.333333 0.333333\n0.333333 0.333333`,
    },
    {
      name: `WS₂`,
      celldm: `3.153 3.153 25.0`,
      v1: `0.5 0.8660254 0.0`,
      v2: `-0.5 0.8660254 0.0`,
      elements: `W S S`,
      basis: `0.0 0.0\n0.333333 0.333333\n0.333333 0.333333`,
    },
  ]

  function apply_preset(preset: Preset, layer: `a` | `b`) {
    if (layer === `a`) {
      celldm_a = preset.celldm
      a1_str = preset.v1
      a2_str = preset.v2
      elements_a_str = preset.elements
      basis_a_str = preset.basis
    } else {
      celldm_b = preset.celldm
      b1_str = preset.v1
      b2_str = preset.v2
      elements_b_str = preset.elements
      basis_b_str = preset.basis
    }
  }

  // -- Search parameters (defaults tuned for iconic TBG θ≈21.79° √7×√7 supercell) --
  let angle_min = $state(20.0)
  let angle_max = $state(25.0)
  let angle_step = $state(0.01)
  let max_index = $state(12)
  let mismatch_threshold = $state(0.01)
  let max_atoms = $state(500)
  let strain_layer = $state<StrainLayer>(`both`)
  let apply_strain = $state(true)
  let show_search_advanced = $state(false)

  // -- Build parameters (graphene interlayer distance) --
  let translate_z = $state(3.35)
  let vacuum = $state(15.0)

  // -- State --
  let search_status = $state<`idle` | `searching` | `done` | `error`>(`idle`)
  let build_status = $state<`idle` | `building` | `done` | `error`>(`idle`)
  let error_message = $state<string | null>(null)
  let result_message = $state<string | null>(null)
  let candidates = $state<MoireCandidate[]>([])
  let selected_idx = $state<number | null>(null)

  let selected_candidate = $derived(
    selected_idx !== null ? candidates[selected_idx] : null,
  )

  function parse_vec(s: string): [number, number] {
    const parts = s.trim().split(/\s+/).map(Number)
    return [parts[0], parts[1]]
  }

  function parse_celldm(s: string): number[] {
    return s.trim().split(/\s+/).map(Number)
  }

  function build_layer_input_manual(
    celldm_str: string,
    v1_str: string,
    v2_str: string,
    elems_str: string,
    basis_raw: string,
  ): MoireLayerInput {
    const cdm = parse_celldm(celldm_str)
    const v1 = parse_vec(v1_str)
    const v2 = parse_vec(v2_str)
    // Scale by celldm (Twister convention: vectors are dimensionless, celldm scales them)
    const vectors: [number, number][] = [
      [v1[0] * cdm[0], v1[1] * cdm[1]],
      [v2[0] * cdm[0], v2[1] * cdm[1]],
    ]
    const elems = elems_str.trim().split(/\s+/)
    const coords = basis_raw
      .trim()
      .split(`\n`)
      .map((line) => {
        const [x, y] = line.trim().split(/\s+/).map(Number)
        return [x, y] as [number, number]
      })
    return { lattice_vectors: vectors, elements: elems, basis_coords: coords }
  }

  function build_layer_a(): MoireLayerInput {
    if (input_mode === `structure` && structure) {
      return { structure }
    }
    return build_layer_input_manual(celldm_a, a1_str, a2_str, elements_a_str, basis_a_str)
  }

  function build_layer_b(): MoireLayerInput | null {
    if (is_homobilayer) return null
    if (input_mode === `structure`) {
      // For heterobilayer with structure mode, layer B must use manual input
      return build_layer_input_manual(celldm_b, b1_str, b2_str, elements_b_str, basis_b_str)
    }
    return build_layer_input_manual(celldm_b, b1_str, b2_str, elements_b_str, basis_b_str)
  }

  async function do_search() {
    if (input_mode === `structure` && !has_lattice) {
      error_message = t('structure.moire_err_needs_periodic')
      return
    }

    error_message = null
    result_message = null
    candidates = []
    selected_idx = null
    search_status = `searching`
    build_status = `idle`

    try {
      const layer_a = build_layer_a()
      const layer_b = build_layer_b()

      const params: MoireAngleSearchParams = {
        angle_min,
        angle_max,
        angle_step,
        max_index,
        mismatch_threshold,
        max_atoms,
        strain_layer,
        apply_strain,
      }

      const result: MoireAngleSearchResult = await searchMoireAngles(
        layer_a,
        layer_b,
        params,
        server_url,
      )

      candidates = result.candidates
      search_status = `done`
      result_message = result.message
    } catch (err) {
      search_status = `error`
      error_message = err instanceof Error ? err.message : String(err)
    }
  }

  async function do_build() {
    if (!selected_candidate) return

    on_push_undo?.()
    error_message = null
    build_status = `building`

    try {
      const layer_a = build_layer_a()
      const layer_b = build_layer_b()

      const params: MoireBuildParams = { translate_z, vacuum }

      const result = await buildMoireBilayer(
        layer_a,
        selected_candidate,
        layer_b,
        params,
        server_url,
      )

      structure = result.structure
      on_structure_change?.(result.structure)
      build_status = `done`
      result_message = result.message

      // Switch to layer-based coloring so the two layers are visually distinct
      atom_color_config = {
        mode: `custom`,
        color_fn: layer_color_fn,
        scale: `interpolateCool`,
        scale_type: `categorical`,
      }
    } catch (err) {
      build_status = `error`
      error_message = err instanceof Error ? err.message : String(err)
    }
  }
</script>

{#snippet pane_content()}
  <h4>{t('structure.moire_bilayer')}</h4>

  <!-- Input mode -->
  <div class="input-mode">
    <div class="mode-row">
      <label class="radio-row">
        <input type="radio" bind:group={input_mode} value="structure" disabled={!has_lattice} />
        <span>{t('structure.moire_use_loaded')}{!has_lattice ? t('structure.moire_needs_periodic') : ``}</span>
      </label>
      <label class="radio-row">
        <input type="radio" bind:group={input_mode} value="manual" />
        <span>{t('structure.moire_manual_input')}</span>
      </label>
    </div>
    <label class="checkbox-row">
      <input type="checkbox" bind:checked={is_homobilayer} />
      <span>{t('structure.moire_homobilayer')}</span>
    </label>
  </div>

  <!-- Layer A input -->
  {#if input_mode === `manual`}
    <fieldset class="layer-fieldset">
      <legend>{t('structure.moire_layer_a')} {is_homobilayer ? t('structure.moire_both_layers') : t('structure.moire_bottom')}</legend>
      <div class="preset-row">
        {#each presets as p}
          <button type="button" class="preset-btn" onclick={() => apply_preset(p, `a`)}>{p.name}</button>
        {/each}
      </div>
      <label>
        <span>{t('structure.moire_celldm')}</span>
        <input type="text" bind:value={celldm_a} placeholder="2.46 2.46 25.0" />
      </label>
      <div class="vec-row">
        <label>
          <span>{t('structure.moire_a1')}</span>
          <input type="text" bind:value={a1_str} placeholder="0.5 0.866 0.0" />
        </label>
        <label>
          <span>{t('structure.moire_a2')}</span>
          <input type="text" bind:value={a2_str} placeholder="-0.5 0.866 0.0" />
        </label>
      </div>
      <label>
        <span>{t('structure.moire_elements')}</span>
        <input type="text" bind:value={elements_a_str} placeholder="C C" />
      </label>
      <label>
        <span>{t('structure.moire_basis')}</span>
        <textarea bind:value={basis_a_str} rows={3} placeholder="0.0 0.0&#10;0.333 0.333"></textarea>
      </label>
    </fieldset>
  {/if}

  <!-- Layer B input (heterobilayer only) -->
  {#if !is_homobilayer}
    <fieldset class="layer-fieldset">
      <legend>{t('structure.moire_layer_b_top')}</legend>
      <div class="preset-row">
        {#each presets as p}
          <button type="button" class="preset-btn" onclick={() => apply_preset(p, `b`)}>{p.name}</button>
        {/each}
      </div>
      <label>
        <span>{t('structure.moire_celldm')}</span>
        <input type="text" bind:value={celldm_b} placeholder="3.301 3.301 25.0" />
      </label>
      <div class="vec-row">
        <label>
          <span>{t('structure.moire_b1')}</span>
          <input type="text" bind:value={b1_str} placeholder="0.5 0.866 0.0" />
        </label>
        <label>
          <span>{t('structure.moire_b2')}</span>
          <input type="text" bind:value={b2_str} placeholder="-0.5 0.866 0.0" />
        </label>
      </div>
      <label>
        <span>{t('structure.moire_elements')}</span>
        <input type="text" bind:value={elements_b_str} placeholder="Mo S S" />
      </label>
      <label>
        <span>{t('structure.moire_basis')}</span>
        <textarea bind:value={basis_b_str} rows={3} placeholder="0.0 0.0&#10;0.333 0.333&#10;0.667 0.667"></textarea>
      </label>
    </fieldset>
  {/if}

  <!-- Search parameters -->
  <fieldset class="search-fieldset">
    <legend>{t('structure.moire_angle_search')}</legend>
    <div class="search-params">
      <label>
        <span>{t('structure.moire_theta_min')}</span>
        <input type="number" bind:value={angle_min} min={0} max={180} step={0.1} />
      </label>
      <label>
        <span>{t('structure.moire_theta_max')}</span>
        <input type="number" bind:value={angle_max} min={0} max={180} step={0.1} />
      </label>
      <label>
        <span>{t('structure.moire_step')}</span>
        <input type="number" bind:value={angle_step} min={0.001} max={10} step={0.01} />
      </label>
      <label>
        <span>{t('structure.moire_max_atoms')}</span>
        <input type="number" bind:value={max_atoms} min={10} max={100000} step={100} />
      </label>
    </div>

    <details bind:open={show_search_advanced}>
      <summary>{t('structure.moire_advanced')}</summary>
      <div class="advanced-params">
        <label>
          <span>{t('structure.moire_max_index')}</span>
          <input type="number" bind:value={max_index} min={1} max={50} step={1} />
        </label>
        <label>
          <span>{t('structure.moire_mismatch_threshold')}</span>
          <input type="number" bind:value={mismatch_threshold} min={0.0001} max={1} step={0.01} />
        </label>
        <label>
          <span>{t('structure.moire_strain_layer')}</span>
          <select bind:value={strain_layer}>
            <option value="both">{t('structure.moire_strain_both')}</option>
            <option value="top">{t('structure.moire_strain_top')}</option>
            <option value="bottom">{t('structure.moire_strain_bottom')}</option>
          </select>
        </label>
        <label class="checkbox-row">
          <input type="checkbox" bind:checked={apply_strain} />
          <span>{t('structure.moire_apply_strain')}</span>
        </label>
      </div>
    </details>

    <div class="controls">
      <button
        type="button"
        onclick={do_search}
        disabled={search_status === `searching` || (input_mode === `structure` && !has_lattice)}
        class="primary"
      >
        {search_status === `searching` ? t('structure.moire_searching') : t('structure.moire_search_angles')}
      </button>
    </div>
  </fieldset>

  <!-- Results table -->
  {#if candidates.length > 0}
    <div class="results-section">
      <div class="results-header">{t('structure.moire_candidates_found', { n: candidates.length })}</div>
      <div class="results-table-wrapper">
        <table class="results-table">
          <thead>
            <tr>
              <th></th>
              <th>{t('structure.moire_th_theta')}</th>
              <th>{t('structure.moire_th_atoms')}</th>
              <th>{t('structure.moire_th_mismatch')}</th>
              <th>{t('structure.moire_th_strain')}</th>
            </tr>
          </thead>
          <tbody>
            {#each candidates as cand, idx}
              <tr
                class:selected={selected_idx === idx}
                onclick={() => (selected_idx = idx)}
              >
                <td><input type="radio" checked={selected_idx === idx} /></td>
                <td>{cand.angle.toFixed(2)}</td>
                <td>{cand.n_atoms}</td>
                <td>{cand.mismatch.toFixed(4)}</td>
                <td>{cand.strain_percent !== null ? cand.strain_percent.toFixed(3) : `—`}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Build section -->
    {#if selected_candidate}
      <div class="build-section">
        <div class="build-info">
          {t('structure.moire_selected', { angle: selected_candidate.angle.toFixed(2), atoms: selected_candidate.n_atoms })}
        </div>
        <div class="build-params">
          <label>
            <span>{t('structure.moire_interlayer_dist')}</span>
            <input type="number" bind:value={translate_z} min={1} max={20} step={0.05} />
          </label>
          <label>
            <span>{t('structure.moire_vacuum')}</span>
            <input type="number" bind:value={vacuum} min={0} max={50} step={1} />
          </label>
        </div>
        <div class="controls">
          <button
            type="button"
            onclick={do_build}
            disabled={build_status === `building`}
            class="primary build-btn"
          >
            {build_status === `building` ? t('structure.moire_building') : t('structure.moire_build_bilayer')}
          </button>
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
    pane_props={{ ...pane_props, class: `moire-pane ${pane_props?.class ?? ``}` }}
    toggle_props={{
      title: pane_open ? `` : t('structure.moire_builder_title'),
      ...toggle_props,
      class: `moire-toggle ${toggle_props?.class ?? ``}`,
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

  .input-mode {
    margin-bottom: 8pt;
  }

  .mode-row {
    display: flex;
    gap: 10pt;
    margin-bottom: 4pt;
  }

  .radio-row,
  .checkbox-row {
    display: flex;
    align-items: center;
    gap: 4pt;
    cursor: pointer;
    font-size: 0.9em;
  }

  .layer-fieldset,
  .search-fieldset {
    border: 1px solid var(--border-color, #ddd);
    border-radius: 3pt;
    padding: 6pt;
    margin-bottom: 8pt;
  }

  .layer-fieldset legend,
  .search-fieldset legend {
    font-size: 0.85em;
    font-weight: 600;
    color: var(--text-secondary, #555);
    padding: 0 4pt;
  }

  .preset-row {
    display: flex;
    gap: 4pt;
    margin-bottom: 6pt;
    flex-wrap: wrap;
  }

  .preset-btn {
    padding: 2pt 6pt;
    font-size: 0.8em;
    border: 1px solid var(--border-color, #ccc);
    border-radius: 3pt;
    background: var(--bg-secondary, #f5f5f5);
    cursor: pointer;
  }

  .preset-btn:hover {
    background: var(--accent-color, #2196f3);
    color: white;
    border-color: var(--accent-color, #2196f3);
  }

  .layer-fieldset label,
  .search-params label,
  .advanced-params label,
  .build-params label {
    display: flex;
    flex-direction: column;
    gap: 2pt;
    margin-bottom: 4pt;
  }

  .layer-fieldset label span,
  .search-params label span,
  .advanced-params label span,
  .build-params label span {
    color: var(--text-secondary, #666);
    font-size: 0.8em;
  }

  .layer-fieldset input[type='text'],
  .layer-fieldset textarea,
  .search-params input,
  .advanced-params input,
  .advanced-params select,
  .build-params input {
    width: 100%;
    padding: 3pt 4pt;
    font-family: monospace;
    font-size: 0.9em;
  }

  .layer-fieldset textarea {
    resize: vertical;
    min-height: 40px;
  }

  .vec-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6pt;
  }

  .search-params {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6pt;
    margin-bottom: 6pt;
  }

  .advanced-params {
    display: grid;
    grid-template-columns: 1fr 1fr;
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

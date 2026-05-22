<script lang="ts">
  import type { PymatgenStructure } from '$lib/structure'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'
  import { DraggablePane } from '$lib'
  import type { ComponentProps } from 'svelte'
  import {
    getNanotubeInfo,
    buildNanotube,
    type NanotubeLayerInput,
    type NanotubeInfoResult,
  } from '$lib/api/nanotube'
  import { SERVER_URL } from '$lib/api/config'

  load_i18n_module('structure')

  let {
    structure = $bindable(),
    pane_open = $bindable(false),
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
    server_url?: string
    show_toggle?: boolean
    embedded?: boolean
    on_push_undo?: () => void
    on_structure_change?: (structure: PymatgenStructure) => void
    pane_props?: ComponentProps<typeof DraggablePane>[`pane_props`]
    toggle_props?: ComponentProps<typeof DraggablePane>[`toggle_props`]
  } = $props()

  // -- Input mode --
  let input_mode = $state<`structure` | `manual`>(structure ? `structure` : `manual`)

  // -- Material parameters --
  let lattice_a1 = $state(`2.46 0.0`)
  let lattice_a2 = $state(`1.23 2.1304`)
  let elements_str = $state(`C C`)
  let basis_str = $state(`0.0 0.0\n0.333333 0.333333`)
  let z_coords_str = $state(`0.0 0.0`)

  // -- Presets --
  type Preset = {
    name: string
    a1: string
    a2: string
    elements: string
    basis: string
    z_coords: string
  }

  const presets: Preset[] = [
    {
      name: `Graphene`,
      a1: `2.46 0.0`,
      a2: `1.23 2.1304`,
      elements: `C C`,
      basis: `0.0 0.0\n0.333333 0.333333`,
      z_coords: `0.0 0.0`,
    },
    {
      name: `hBN`,
      a1: `2.512 0.0`,
      a2: `1.256 2.1754`,
      elements: `B N`,
      basis: `0.0 0.0\n0.333333 0.333333`,
      z_coords: `0.0 0.0`,
    },
    {
      name: `MoS₂`,
      a1: `3.16 0.0`,
      a2: `1.58 2.7362`,
      elements: `Mo S S`,
      basis: `0.0 0.0\n0.333333 0.333333\n0.333333 0.333333`,
      z_coords: `0.0 1.569 -1.569`,
    },
    {
      name: `WS₂`,
      a1: `3.153 0.0`,
      a2: `1.5765 2.7301`,
      elements: `W S S`,
      basis: `0.0 0.0\n0.333333 0.333333\n0.333333 0.333333`,
      z_coords: `0.0 1.571 -1.571`,
    },
  ]

  function apply_preset(preset: Preset) {
    lattice_a1 = preset.a1
    lattice_a2 = preset.a2
    elements_str = preset.elements
    basis_str = preset.basis
    z_coords_str = preset.z_coords
  }

  // -- Nanotube parameters --
  let chiral_n = $state(8)
  let chiral_m = $state(0)
  let NL = $state(1)
  let vacuum = $state(15.0)
  let n_walls = $state(1)
  let interlayer_spacing = $state(3.4)

  // -- State --
  let info_status = $state<`idle` | `loading` | `done` | `error`>(`idle`)
  let build_status = $state<`idle` | `building` | `done` | `error`>(`idle`)
  let error_message = $state<string | null>(null)
  let info_result = $state<NanotubeInfoResult | null>(null)
  let result_message = $state<string | null>(null)

  let chirality_label = $derived(
    chiral_m === 0 ? `zigzag` : chiral_n === chiral_m ? `armchair` : `chiral`,
  )

  function parse_vec2(s: string): [number, number] {
    const parts = s.trim().split(/\s+/).map(Number)
    return [parts[0] ?? 0, parts[1] ?? 0]
  }

  function build_layer_input(): NanotubeLayerInput {
    if (input_mode === `structure` && structure) {
      return { structure }
    }
    const a1 = parse_vec2(lattice_a1)
    const a2 = parse_vec2(lattice_a2)
    const elems = elements_str.trim().split(/\s+/)
    const coords = basis_str
      .trim()
      .split(`\n`)
      .map((line) => {
        const [x, y] = line.trim().split(/\s+/).map(Number)
        return [x ?? 0, y ?? 0] as [number, number]
      })
    const z_vals = z_coords_str
      .trim()
      .split(/\s+/)
      .map(Number)
    return {
      lattice_vectors: [a1, a2],
      elements: elems,
      basis_coords: coords,
      z_coords: z_vals.length === elems.length ? z_vals : elems.map(() => 0),
    }
  }

  async function do_info() {
    error_message = null
    info_result = null
    info_status = `loading`

    try {
      const layer = build_layer_input()
      info_result = await getNanotubeInfo(layer, { n: chiral_n, m: chiral_m, NL }, server_url)
      info_status = `done`
    } catch (err) {
      info_status = `error`
      error_message = err instanceof Error ? err.message : String(err)
    }
  }

  async function do_build() {
    on_push_undo?.()
    error_message = null
    result_message = null
    build_status = `building`

    try {
      const layer = build_layer_input()
      const result = await buildNanotube(
        layer,
        { n: chiral_n, m: chiral_m, NL, vacuum, n_walls, interlayer_spacing },
        server_url,
      )

      structure = result.structure
      on_structure_change?.(result.structure)
      build_status = `done`
      result_message = result.message
    } catch (err) {
      build_status = `error`
      error_message = err instanceof Error ? err.message : String(err)
    }
  }
</script>

{#snippet pane_content()}
  <h4>{t('structure.nanotube_builder')}</h4>

  <!-- Input mode -->
  <div class="input-mode">
    <label class="radio-row">
      <input type="radio" bind:group={input_mode} value="structure" disabled={!structure} />
      <span>{t('structure.nanotube_use_loaded_structure')}</span>
    </label>
    <label class="radio-row">
      <input type="radio" bind:group={input_mode} value="manual" />
      <span>{t('structure.nanotube_manual_input')}</span>
    </label>
  </div>

  <!-- Material input -->
  {#if input_mode === `manual`}
    <fieldset class="layer-fieldset">
      <legend>{t('structure.nanotube_2d_material')}</legend>
      <div class="preset-row">
        {#each presets as p}
          <button type="button" class="preset-btn" onclick={() => apply_preset(p)}>{p.name}</button>
        {/each}
      </div>
      <div class="vec-row">
        <label>
          <span>a1 (Å)</span>
          <input type="text" bind:value={lattice_a1} placeholder="2.46 0.0" />
        </label>
        <label>
          <span>a2 (Å)</span>
          <input type="text" bind:value={lattice_a2} placeholder="1.23 2.13" />
        </label>
      </div>
      <label>
        <span>{t('structure.nanotube_elements_space_separated')}</span>
        <input type="text" bind:value={elements_str} placeholder="C C" />
      </label>
      <label>
        <span>{t('structure.nanotube_basis_positions_fractional')}</span>
        <textarea bind:value={basis_str} rows={3} placeholder="0.0 0.0&#10;0.333 0.333"></textarea>
      </label>
      <label>
        <span>{t('structure.nanotube_z_offsets_relative')}</span>
        <input type="text" bind:value={z_coords_str} placeholder="0.0 0.0" />
      </label>
    </fieldset>
  {/if}

  <!-- Chiral indices -->
  <fieldset class="params-fieldset">
    <legend>{t('structure.nanotube_chiral_indices')}</legend>
    <div class="chiral-row">
      <label>
        <span>n</span>
        <input type="number" bind:value={chiral_n} min={0} max={100} step={1} />
      </label>
      <label>
        <span>m</span>
        <input type="number" bind:value={chiral_m} min={0} max={100} step={1} />
      </label>
      <label>
        <span>NL ({t('structure.nanotube_repeats').toLowerCase()})</span>
        <input type="number" bind:value={NL} min={1} max={50} step={1} />
      </label>
    </div>
    <div class="chirality-badge">
      ({chiral_n},{chiral_m}) <span class="chirality-type">{chirality_label}</span>
    </div>
    <div class="controls">
      <button
        type="button"
        onclick={do_info}
        disabled={info_status === `loading` || (chiral_n === 0 && chiral_m === 0)}
        class="info-btn"
      >
        {info_status === `loading` ? t('structure.computing') : t('structure.preview_info')}
      </button>
    </div>
  </fieldset>

  <!-- Info result -->
  {#if info_result}
    <div class="info-section">
      <div class="info-grid">
        <div class="info-item">
          <span class="info-label">{t('structure.nanotube_diameter')}</span>
          <span class="info-value">{info_result.diameter.toFixed(2)} Å</span>
        </div>
        <div class="info-item">
          <span class="info-label">{t('structure.nanotube_circumference')}</span>
          <span class="info-value">{info_result.circumference.toFixed(2)} Å</span>
        </div>
        <div class="info-item">
          <span class="info-label">{t('structure.nanotube_chiral_angle')}</span>
          <span class="info-value">{info_result.chiral_angle_deg.toFixed(2)}°</span>
        </div>
        <div class="info-item">
          <span class="info-label">{t('structure.nanotube_t_vector')}</span>
          <span class="info-value">{info_result.trans_length.toFixed(2)} Å</span>
        </div>
        <div class="info-item">
          <span class="info-label">{t('structure.nanotube_tube_length')}</span>
          <span class="info-value">{info_result.tube_length.toFixed(2)} Å</span>
        </div>
        <div class="info-item">
          <span class="info-label">{t('structure.nanotube_est_atoms')}</span>
          <span class="info-value">{info_result.n_atoms_estimate}</span>
        </div>
      </div>
    </div>
  {/if}

  <!-- Build section -->
  <fieldset class="build-fieldset">
    <legend>{t('structure.nanotube_build')}</legend>
    <div class="build-grid">
      <label>
        <span>{t('structure.nanotube_walls')}</span>
        <input type="number" bind:value={n_walls} min={1} max={10} step={1} />
      </label>
      <label>
        <span>{t('structure.nanotube_spacing')}</span>
        <input type="number" bind:value={interlayer_spacing} min={2} max={10} step={0.1}
          disabled={n_walls <= 1} />
      </label>
      <label>
        <span>Vacuum (Å)</span>
        <input type="number" bind:value={vacuum} min={5} max={100} step={1} />
      </label>
    </div>
    {#if n_walls > 1}
      <div class="mwnt-hint">
        {n_walls}-wall nanotube, interlayer spacing {interlayer_spacing} Å.
        Outer wall indices will be auto-selected.
      </div>
    {/if}
    <div class="controls">
      <button
        type="button"
        onclick={do_build}
        disabled={build_status === `building` || (chiral_n === 0 && chiral_m === 0)}
        class="primary build-btn"
      >
        {build_status === `building` ? t('structure.building') : n_walls > 1 ? t('structure.build_mwnt') : t('structure.build_nanotube')}
      </button>
    </div>
  </fieldset>

  {#if error_message}
    <div class="error">{error_message}</div>
  {/if}

  {#if result_message && build_status === `done`}
    <div class="success">{result_message}</div>
  {/if}
{/snippet}

{#if !embedded}
  <DraggablePane
    bind:show={pane_open}
    open_icon="Cross"
    closed_icon="Orbit"
    show_toggle={show_toggle && !embedded}
    pane_props={{ ...pane_props, class: `nanotube-pane ${pane_props?.class ?? ``}` }}
    toggle_props={{
      title: pane_open ? `` : t('structure.nanotube_builder'),
      ...toggle_props,
      class: `nanotube-toggle ${toggle_props?.class ?? ``}`,
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
    display: flex;
    gap: 10pt;
    margin-bottom: 8pt;
  }

  .radio-row {
    display: flex;
    align-items: center;
    gap: 4pt;
    cursor: pointer;
    font-size: 0.9em;
  }

  .layer-fieldset,
  .params-fieldset,
  .build-fieldset {
    border: 1px solid var(--border-color, #ddd);
    border-radius: 3pt;
    padding: 6pt;
    margin-bottom: 8pt;
  }

  .layer-fieldset legend,
  .params-fieldset legend,
  .build-fieldset legend {
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
  .params-fieldset label,
  .build-fieldset label {
    display: flex;
    flex-direction: column;
    gap: 2pt;
    margin-bottom: 4pt;
  }

  .layer-fieldset label span,
  .params-fieldset label span,
  .build-fieldset label span {
    color: var(--text-secondary, #666);
    font-size: 0.8em;
  }

  .layer-fieldset input[type='text'],
  .layer-fieldset textarea,
  .params-fieldset input,
  .build-fieldset input {
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

  .build-grid {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 6pt;
    margin-bottom: 4pt;
  }

  .mwnt-hint {
    font-size: 0.78em;
    color: var(--text-secondary, #888);
    margin-bottom: 4pt;
  }

  .chiral-row {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 6pt;
    margin-bottom: 4pt;
  }

  .chirality-badge {
    font-size: 0.9em;
    color: var(--text-secondary, #555);
    margin-bottom: 4pt;
  }

  .chirality-type {
    font-weight: 600;
    color: var(--accent-color, #2196f3);
  }

  .controls {
    display: flex;
    gap: 6pt;
    margin: 6pt 0;
  }

  .controls button {
    padding: 4pt 8pt;
    border: 1px solid var(--border-color, #ccc);
    border-radius: 3pt;
    cursor: pointer;
    flex: 1;
  }

  .controls button.info-btn {
    background: var(--btn-bg);
    color: var(--btn-color);
  }

  .controls button.info-btn:hover:not(:disabled) {
    background: var(--btn-bg-hover);
  }

  .controls button.primary {
    background: var(--accent-color, #2196f3);
    color: white;
    border: none;
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

  .info-section {
    margin: 8pt 0;
    padding: 6pt;
    background: rgba(33, 150, 243, 0.06);
    border-radius: 3pt;
  }

  .info-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 4pt;
  }

  .info-item {
    display: flex;
    justify-content: space-between;
    font-size: 0.85em;
  }

  .info-label {
    color: var(--text-secondary, #666);
  }

  .info-value {
    font-weight: 500;
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

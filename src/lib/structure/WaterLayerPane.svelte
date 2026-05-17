<script lang="ts">
  import type { PymatgenStructure } from '$lib/structure'
  import { DraggablePane } from '$lib'
  import type { ComponentProps } from 'svelte'
  import { addWaterLayer, type WaterLayerParams, type WaterLayerResult } from '$lib/api/water-layer'
  import { SERVER_URL } from '$lib/api/config'

  // __CATGO_VSCODE_EXTENSION__ is a vite `define` token; its type lives in
  // src/app.d.ts (declare global) — an in-component `declare const` is a
  // modifier svelte-check rejects here.
  const is_vscode_extension = typeof __CATGO_VSCODE_EXTENSION__ !== `undefined` && __CATGO_VSCODE_EXTENSION__

  let {
    structure = $bindable(),
    pane_open = $bindable(false),
    server_url = SERVER_URL,
    on_push_undo,
    on_structure_change,
    pane_props = {},
    toggle_props = {},
    embedded = false,
  }: {
    structure?: PymatgenStructure
    pane_open?: boolean
    server_url?: string
    on_push_undo?: () => void
    on_structure_change?: (structure: PymatgenStructure) => void
    pane_props?: ComponentProps<typeof DraggablePane>[`pane_props`]
    toggle_props?: ComponentProps<typeof DraggablePane>[`toggle_props`]
    embedded?: boolean
  } = $props()

  // Region parameters
  let z_start = $state(0.0)
  let z_end = $state(15.0)
  let min_distance = $state(2.0)

  // Equilibration
  let equilibrate = $state(false)
  let equil_steps = $state(1000)
  let equil_temperature = $state(300.0)

  let status = $state<'idle' | 'running' | 'complete' | 'error'>(`idle`)
  let error_message = $state<string | null>(null)
  let result_message = $state<string | null>(null)
  let c_axis_warning = $state<string | null>(null)

  // Derived: current c-axis z-height
  let c_z_height = $derived.by(() => {
    if (!structure?.lattice) return 0
    return structure.lattice.matrix[2][2]
  })

  // Derived: check if z_end exceeds c-axis
  let exceeds_c_axis = $derived(z_end > c_z_height && c_z_height > 0)

  // Estimate water molecules (~0.997 g/cm³ from pre-equilibrated box)
  let estimated_n_water = $derived.by(() => {
    if (!structure?.lattice) return 0
    const mat = structure.lattice.matrix
    const a_vec = mat[0]
    const b_vec = mat[1]
    const cross_z = a_vec[0] * b_vec[1] - a_vec[1] * b_vec[0]
    const cross_y = a_vec[2] * b_vec[0] - a_vec[0] * b_vec[2]
    const cross_x = a_vec[1] * b_vec[2] - a_vec[2] * b_vec[1]
    const xy_area = Math.sqrt(cross_x ** 2 + cross_y ** 2 + cross_z ** 2)

    const water_height = z_end - z_start
    if (water_height <= 0) return 0

    const density = 0.997 // g/cm³, matches OpenMM pre-equilibrated water box
    const molecular_weight = 18.015
    const avogadro = 6.022e23
    const volume_cm3 = xy_area * water_height * 1e-24
    return Math.round((density * volume_cm3 * avogadro) / molecular_weight)
  })

  async function add_water() {
    if (!structure) {
      error_message = `No structure loaded`
      return
    }
    if (z_start >= z_end) {
      error_message = `z_start must be less than z_end`
      return
    }

    on_push_undo?.()
    status = `running`
    error_message = null
    result_message = null
    c_axis_warning = null

    try {
      const params: WaterLayerParams = {
        z_start,
        z_end,
        min_distance,
        equilibrate,
        equil_steps: equilibrate ? equil_steps : undefined,
        equil_temperature: equilibrate ? equil_temperature : undefined,
      }

      const result: WaterLayerResult = await addWaterLayer(structure, params, server_url)

      if (result.n_water_molecules === 0) {
        status = `error`
        error_message = result.message
        return
      }

      console.log(`[WaterLayerPane] result.structure.sites: ${result.structure?.sites?.length}, O: ${result.structure?.sites?.filter(s => s.species?.[0]?.element === 'O').length}`)
      structure = result.structure
      on_structure_change?.(result.structure)
      status = `complete`
      result_message = result.message

      if (result.c_axis_adjusted) {
        c_axis_warning = `c-axis was expanded to ${result.new_c_length.toFixed(1)} Å to accommodate z_end`
      }
    } catch (err) {
      status = `error`
      error_message = err instanceof Error ? err.message : String(err)
    }
  }
</script>

{#snippet pane_content()}
  <h4>Water Layer</h4>

  <div class="region-params">
    <label>
      <span>z start (Å)</span>
      <input type="number" bind:value={z_start} min={0} step={0.5} />
    </label>
    <label>
      <span>z end (Å)</span>
      <input type="number" bind:value={z_end} min={0} step={0.5} />
    </label>
  </div>

  {#if exceeds_c_axis}
    <div class="warning">
      z_end ({z_end.toFixed(1)} Å) exceeds c-axis height ({c_z_height.toFixed(1)} Å). c-axis will be auto-expanded.
    </div>
  {/if}

  <div class="primary-params">
    <label>
      <span>Min distance (Å)</span>
      <input type="number" bind:value={min_distance} min={1.0} max={5.0} step={0.1} />
    </label>
  </div>

  {#if estimated_n_water > 0}
    <div class="estimate">
      ~{estimated_n_water} water molecules ({estimated_n_water * 3} atoms) before overlap removal
    </div>
  {/if}

  {#if !is_vscode_extension}
    <div class="equilibrate-section">
      <label class="checkbox-row">
        <input type="checkbox" bind:checked={equilibrate} />
        <span>Equilibrate with TIP4P (LAMMPS)</span>
      </label>

      {#if equilibrate}
        <div class="equil-params">
          <label>
            <span>Temperature (K)</span>
            <input type="number" bind:value={equil_temperature} min={1} max={1000} step={10} />
          </label>
          <label>
            <span>MD steps</span>
            <input type="number" bind:value={equil_steps} min={100} max={50000} step={100} />
          </label>
        </div>
      {/if}
    </div>
  {:else}
    <div class="equilibrate-section">
      <span class="hint">Equilibration unavailable in the VS Code extension (runs locally without LAMMPS).</span>
    </div>
  {/if}

  <div class="controls">
    <button
      type="button"
      onclick={add_water}
      disabled={status === `running` || !structure || z_start >= z_end}
      class="primary"
    >
      {status === `running`
        ? equilibrate ? `Packing & equilibrating...` : `Filling water...`
        : `Fill Water`}
    </button>
  </div>

  {#if error_message}
    <div class="error">{error_message}</div>
  {/if}

  {#if c_axis_warning}
    <div class="warning">{c_axis_warning}</div>
  {/if}

  {#if result_message && status === `complete`}
    <div class="success">{result_message}</div>
  {/if}
{/snippet}

{#if !embedded}
  <DraggablePane
    bind:show={pane_open}
    open_icon="Cross"
    closed_icon="Molecule"
    show_toggle={!embedded}
    pane_props={{ ...pane_props, class: `water-layer-pane ${pane_props?.class ?? ``}` }}
    toggle_props={{
      title: pane_open ? `` : `Add Water Layer`,
      ...toggle_props,
      class: `water-layer-toggle ${toggle_props?.class ?? ``}`,
    }}
  >
    {@render pane_content()}
  </DraggablePane>
{:else}
  {@render pane_content()}
{/if}

<style>
  .region-params,
  .primary-params {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6pt;
    margin-bottom: 8pt;
  }

  .region-params label,
  .primary-params label,
  .equil-params label {
    display: flex;
    flex-direction: column;
    gap: 2pt;
  }

  .region-params label span,
  .primary-params label span,
  .equil-params label span {
    color: var(--text-secondary, #666);
    font-size: 0.85em;
  }

  .region-params input[type='number'],
  .primary-params input[type='number'],
  .equil-params input[type='number'] {
    width: 100%;
    padding: 3pt 4pt;
  }

  .estimate {
    margin: 4pt 0 8pt;
    padding: 4pt 6pt;
    background: rgba(33, 150, 243, 0.1);
    border-radius: 3pt;
    font-size: 0.9em;
    color: var(--text-secondary, #555);
  }

  .equilibrate-section {
    margin: 6pt 0;
  }

  .checkbox-row {
    display: flex;
    align-items: center;
    gap: 4pt;
    cursor: pointer;
  }

  .equil-params {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6pt;
    margin-top: 6pt;
  }

  .controls {
    display: flex;
    gap: 6pt;
    margin: 8pt 0;
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

  .error {
    margin: 4pt 0;
    padding: 4pt 6pt;
    background: rgba(244, 67, 54, 0.1);
    border-radius: 3pt;
  }

  .warning {
    margin: 4pt 0;
    padding: 4pt 6pt;
    background: rgba(255, 152, 0, 0.15);
    border-radius: 3pt;
    font-size: 0.9em;
    color: #e65100;
  }

  .success {
    margin: 4pt 0;
    padding: 4pt 6pt;
    background: rgba(76, 175, 80, 0.1);
    border-radius: 3pt;
    color: #2e7d32;
  }
</style>

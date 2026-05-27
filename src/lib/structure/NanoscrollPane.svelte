<script lang="ts">
  import type { PymatgenStructure } from '$lib/structure'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'
  import { DraggablePane } from '$lib'
  import { tooltip } from 'svelte-multiselect/attachments'
  import type { ComponentProps } from 'svelte'
  import { build_nanoscroll, type NanoscrollInfo } from './ferrox-wasm'

  load_i18n_module('structure')

  let {
    structure = $bindable(),
    pane_open = $bindable(false),
    show_toggle = true,
    embedded = false,
    on_push_undo,
    on_structure_change,
    pane_props = {},
    toggle_props = {},
  }: {
    structure?: PymatgenStructure
    pane_open?: boolean
    show_toggle?: boolean
    embedded?: boolean
    on_push_undo?: () => void
    on_structure_change?: (structure: PymatgenStructure) => void
    pane_props?: ComponentProps<typeof DraggablePane>[`pane_props`]
    toggle_props?: ComponentProps<typeof DraggablePane>[`toggle_props`]
  } = $props()

  // -- Nanoscroll parameters (every one has a default value) --
  let turns = $state(6)
  let inner_radius = $state(25.0)
  let interlayer_gap = $state(3.3)
  let length = $state(12.0)
  let roll_dir = $state<`a1` | `a2`>(`a1`)

  // -- State --
  let build_status = $state<`idle` | `building` | `done` | `error`>(`idle`)
  let error_message = $state<string | null>(null)
  let info_result = $state<NanoscrollInfo | null>(null)

  async function do_build() {
    if (!structure) return
    on_push_undo?.()
    error_message = null
    info_result = null
    build_status = `building`

    try {
      const result = await build_nanoscroll(structure, {
        turns,
        inner_radius,
        interlayer_gap,
        length,
        roll_dir,
      })
      if (`error` in result) {
        build_status = `error`
        error_message = result.error
        return
      }
      structure = result.ok.structure as PymatgenStructure
      info_result = result.ok.info
      on_structure_change?.(result.ok.structure as PymatgenStructure)
      build_status = `done`
    } catch (err) {
      build_status = `error`
      error_message = err instanceof Error ? err.message : String(err)
    }
  }
</script>

{#snippet pane_content()}
  <h4>{t('structure.nanoscroll_builder')}</h4>

  <!-- Monolayer source -->
  <fieldset class="params-fieldset">
    <legend>{t('structure.nanoscroll_monolayer_source')}</legend>
    <p
      class="source-note"
      {@attach tooltip({ content: t('structure.nanoscroll_tip_monolayer') })}
    >
      {#if structure}
        {t('structure.nanoscroll_use_loaded_structure')}
      {:else}
        {t('structure.nanoscroll_no_structure')}
      {/if}
    </p>
  </fieldset>

  <!-- Spiral parameters -->
  <fieldset class="params-fieldset">
    <legend>{t('structure.nanoscroll')}</legend>
    <div class="params-grid">
      <label {@attach tooltip({ content: t('structure.nanoscroll_tip_inner_radius') })}>
        <span>{t('structure.nanoscroll_inner_radius')}</span>
        <input type="number" bind:value={inner_radius} min={1} max={500} step={0.5} />
      </label>
      <label {@attach tooltip({ content: t('structure.nanoscroll_tip_turns') })}>
        <span>{t('structure.nanoscroll_turns')}</span>
        <input type="number" bind:value={turns} min={1} max={100} step={1} />
      </label>
      <label {@attach tooltip({ content: t('structure.nanoscroll_tip_interlayer_gap') })}>
        <span>{t('structure.nanoscroll_interlayer_gap')}</span>
        <input type="number" bind:value={interlayer_gap} min={0} max={20} step={0.05} />
      </label>
      <label {@attach tooltip({ content: t('structure.nanoscroll_tip_length') })}>
        <span>{t('structure.nanoscroll_length')}</span>
        <input type="number" bind:value={length} min={1} max={500} step={0.5} />
      </label>
      <label
        class="roll-dir"
        {@attach tooltip({ content: t('structure.nanoscroll_tip_roll_dir') })}
      >
        <span>{t('structure.nanoscroll_roll_dir')}</span>
        <select bind:value={roll_dir}>
          <option value="a1">a1</option>
          <option value="a2">a2</option>
        </select>
      </label>
    </div>
    <div class="controls">
      <button
        type="button"
        onclick={do_build}
        disabled={build_status === `building` || !structure}
        class="primary build-btn"
      >
        {build_status === `building` ? t('structure.building') : t('structure.nanoscroll_build')}
      </button>
    </div>
  </fieldset>

  <!-- Info result -->
  {#if info_result}
    <div class="info-section">
      {#if info_result.warning}
        <div class="strain-warning">⚠ {info_result.warning}</div>
      {/if}
      <div class="info-grid">
        <div class="info-item">
          <span class="info-label">{t('structure.nanoscroll_outer_radius')}</span>
          <span class="info-value">{info_result.outer_radius.toFixed(2)} Å</span>
        </div>
        <div class="info-item">
          <span class="info-label">{t('structure.nanoscroll_arc_length')}</span>
          <span class="info-value">{info_result.arc_length.toFixed(1)} Å</span>
        </div>
        <div class="info-item">
          <span class="info-label">{t('structure.nanoscroll_thickness')}</span>
          <span class="info-value">{info_result.monolayer_thickness.toFixed(2)} Å</span>
        </div>
        <div class="info-item">
          <span class="info-label">{t('structure.nanoscroll_strain')}</span>
          <span class="info-value">{(info_result.max_local_strain * 100).toFixed(1)}%</span>
        </div>
        <div class="info-item">
          <span class="info-label">{t('structure.nanoscroll_supercell')}</span>
          <span class="info-value">{info_result.supercell[0]}×{info_result.supercell[1]}</span>
        </div>
        <div class="info-item">
          <span class="info-label">{t('structure.nanoscroll_n_atoms')}</span>
          <span class="info-value">{info_result.n_atoms}</span>
        </div>
      </div>
    </div>
  {/if}

  {#if error_message}
    <div class="error">{error_message}</div>
  {/if}
{/snippet}

{#if !embedded}
  <DraggablePane
    bind:show={pane_open}
    open_icon="Cross"
    closed_icon="Orbit"
    show_toggle={show_toggle && !embedded}
    pane_props={{ ...pane_props, class: `nanoscroll-pane ${pane_props?.class ?? ``}` }}
    toggle_props={{
      title: pane_open ? `` : t('structure.nanoscroll_builder'),
      ...toggle_props,
      class: `nanoscroll-toggle ${toggle_props?.class ?? ``}`,
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

  .params-fieldset {
    border: 1px solid var(--border-color, #ddd);
    border-radius: 3pt;
    padding: 6pt;
    margin-bottom: 8pt;
  }

  .params-fieldset legend {
    font-size: 0.85em;
    font-weight: 600;
    color: var(--text-secondary, #555);
    padding: 0 4pt;
  }

  .source-note {
    margin: 0;
    font-size: 0.85em;
    color: var(--text-secondary, #666);
  }

  .params-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6pt;
    margin-bottom: 4pt;
  }

  .params-fieldset label {
    display: flex;
    flex-direction: column;
    gap: 2pt;
    margin-bottom: 4pt;
  }

  .params-fieldset label span {
    color: var(--text-secondary, #666);
    font-size: 0.8em;
  }

  .params-fieldset input,
  .params-fieldset select {
    width: 100%;
    padding: 3pt 4pt;
    font-family: monospace;
    font-size: 0.9em;
  }

  .controls {
    display: flex;
    gap: 6pt;
    margin: 6pt 0 0;
  }

  .controls button {
    padding: 4pt 8pt;
    border: 1px solid var(--border-color, #ccc);
    border-radius: 3pt;
    cursor: pointer;
    flex: 1;
  }

  .controls button.primary {
    background: var(--accent-color, #2196f3);
    color: white;
    border: none;
  }

  .controls button.build-btn {
    background: #4caf50;
  }

  .controls button.build-btn:hover:not(:disabled) {
    background: #388e3c;
  }

  .controls button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .info-section {
    margin: 8pt 0;
    padding: 6pt;
    background: rgba(33, 150, 243, 0.06);
    border-radius: 3pt;
  }

  .strain-warning {
    margin-bottom: 6pt;
    padding: 4pt 6pt;
    font-size: 0.82em;
    background: rgba(255, 152, 0, 0.14);
    border-left: 3px solid #ff9800;
    border-radius: 2pt;
    color: #b26a00;
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
</style>

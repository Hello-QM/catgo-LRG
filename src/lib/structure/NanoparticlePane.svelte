<script lang="ts">
  import type { PymatgenStructure } from '$lib/structure'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'
  import { DraggablePane } from '$lib'
  import type { ComponentProps } from 'svelte'
  import { buildNanoparticle, type NanoparticleShape } from '$lib/api/nanoparticle'
  import { normalize_pymatgen_frame_structure } from '$lib/trajectory/parsers/json'
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

  // -- Parameters --
  let element = $state(`Au`)
  let shape = $state<NanoparticleShape>(`wulff`)
  let lattice = $state<`fcc` | `bcc` | `sc` | `hcp`>(`fcc`)
  let size = $state(100)
  let surfaces_str = $state(`111;100;110`)
  let energies_str = $state(`1.0,1.1,1.2`)
  let rounding = $state<`closest` | `above` | `below`>(`closest`)
  let length = $state(6)
  let cutoff = $state(2)
  let shells = $state(3)
  let deca_p = $state(3)
  let deca_q = $state(3)
  let deca_r = $state(0)
  let vacuum = $state(10)

  // -- Status --
  let build_status = $state<`idle` | `building` | `done` | `error`>(`idle`)
  let error_message = $state<string | null>(null)
  let result_message = $state<string | null>(null)

  function parse_surfaces(raw: string): number[][] {
    return raw
      .split(`;`)
      .map((tok) => tok.trim())
      .filter(Boolean)
      .map((tok) =>
        (tok.includes(`,`) ? tok.split(`,`) : tok.split(``)).map((c) => Number(c)),
      )
  }

  async function do_build() {
    on_push_undo?.()
    error_message = null
    result_message = null
    build_status = `building`
    try {
      const params: Parameters<typeof buildNanoparticle>[0] = { element: element.trim(), shape, vacuum }
      if (shape === `wulff`) {
        params.structure = lattice
        params.size = size
        params.surfaces = parse_surfaces(surfaces_str)
        params.energies = energies_str.split(`,`).map((x) => Number(x)).filter((x) => !isNaN(x))
        params.rounding = rounding
      } else if (shape === `octahedron`) {
        params.length = length
        params.cutoff = cutoff
      } else if (shape === `icosahedron`) {
        params.shells = shells
      } else if (shape === `decahedron`) {
        params.p = deca_p
        params.q = deca_q
        params.r = deca_r
      }
      const result = await buildNanoparticle(params, server_url)
      const normalized = normalize_pymatgen_frame_structure(result.structure) as PymatgenStructure
      structure = normalized
      on_structure_change?.(normalized)
      build_status = `done`
      result_message = result.message
    } catch (err) {
      build_status = `error`
      error_message = err instanceof Error ? err.message : String(err)
    }
  }
</script>

{#snippet pane_content()}
  <h4 class="np-title">{t('structure.nanoparticle_builder')}</h4>

  <fieldset class="np-fieldset">
    <legend>{t('structure.nanoparticle_element')}</legend>
    <div class="np-row">
      <input class="np-input" type="text" bind:value={element} placeholder="Au" />
      <label class="np-field">
        {t('structure.nanoparticle_shape')}
        <select bind:value={shape}>
          <option value="wulff">{t('structure.np_shape_wulff')}</option>
          <option value="octahedron">{t('structure.np_shape_octahedron')}</option>
          <option value="icosahedron">{t('structure.np_shape_icosahedron')}</option>
          <option value="decahedron">{t('structure.np_shape_decahedron')}</option>
        </select>
      </label>
    </div>
  </fieldset>

  <fieldset class="np-fieldset">
    <legend>{t('structure.nanoparticle_params')}</legend>
    {#if shape === `wulff`}
      <div class="np-row">
        <label class="np-field">
          {t('structure.np_lattice')}
          <select bind:value={lattice}>
            <option value="fcc">fcc</option>
            <option value="bcc">bcc</option>
            <option value="sc">sc</option>
            <option value="hcp">hcp</option>
          </select>
        </label>
        <label class="np-field">
          {t('structure.np_size')}
          <input class="np-num" type="number" min={1} bind:value={size} />
        </label>
        <label class="np-field">
          {t('structure.np_rounding')}
          <select bind:value={rounding}>
            <option value="closest">closest</option>
            <option value="above">above</option>
            <option value="below">below</option>
          </select>
        </label>
      </div>
      <label class="np-field np-wide">
        {t('structure.np_surfaces')}
        <input class="np-input" type="text" bind:value={surfaces_str} placeholder="111;100;110" />
      </label>
      <label class="np-field np-wide">
        {t('structure.np_energies')}
        <input class="np-input" type="text" bind:value={energies_str} placeholder="1.0,1.1,1.2" />
      </label>
    {:else if shape === `octahedron`}
      <div class="np-row">
        <label class="np-field">
          {t('structure.np_length')}
          <input class="np-num" type="number" min={2} bind:value={length} />
        </label>
        <label class="np-field">
          {t('structure.np_cutoff')}
          <input class="np-num" type="number" min={0} bind:value={cutoff} />
        </label>
      </div>
    {:else if shape === `icosahedron`}
      <label class="np-field">
        {t('structure.np_shells')}
        <input class="np-num" type="number" min={1} bind:value={shells} />
      </label>
    {:else if shape === `decahedron`}
      <div class="np-row">
        <label class="np-field">p<input class="np-num" type="number" min={1} bind:value={deca_p} /></label>
        <label class="np-field">q<input class="np-num" type="number" min={1} bind:value={deca_q} /></label>
        <label class="np-field">r<input class="np-num" type="number" min={0} bind:value={deca_r} /></label>
      </div>
    {/if}
    <label class="np-field">
      {t('structure.np_vacuum')}
      <input class="np-num" type="number" min={0} step={0.5} bind:value={vacuum} />
    </label>
  </fieldset>

  <button class="np-build" onclick={do_build} disabled={build_status === `building` || !element.trim()}>
    {build_status === `building` ? t('structure.generating') : t('structure.nanoparticle_build')}
  </button>

  {#if error_message}
    <div class="np-error">{error_message}</div>
  {/if}
  {#if result_message}
    <div class="np-success">{result_message}</div>
  {/if}
{/snippet}

{#if !embedded}
  <DraggablePane
    bind:show={pane_open}
    open_icon="Cross"
    closed_icon="Orbit"
    show_toggle={show_toggle && !embedded}
    pane_props={{ ...pane_props, class: `nanoparticle-pane ${pane_props?.class ?? ``}` }}
    toggle_props={{
      title: pane_open ? `` : t('structure.nanoparticle_builder'),
      ...toggle_props,
      class: `nanoparticle-toggle ${toggle_props?.class ?? ``}`,
    }}
  >
    {@render pane_content()}
  </DraggablePane>
{:else}
  {@render pane_content()}
{/if}

<style>
  .np-title {
    margin: 0 0 6pt;
    font-size: 0.95em;
  }
  .np-fieldset {
    border: 1px solid var(--border-color, #ddd);
    border-radius: 3pt;
    padding: 6pt;
    margin-bottom: 8pt;
  }
  .np-fieldset legend {
    font-size: 0.85em;
    font-weight: 600;
  }
  .np-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8pt;
    margin-bottom: 6pt;
  }
  .np-field {
    display: flex;
    flex-direction: column;
    gap: 2pt;
    font-size: 0.85em;
  }
  .np-wide {
    width: 100%;
  }
  .np-input {
    width: 100%;
    box-sizing: border-box;
  }
  .np-num {
    width: 5em;
  }
  .np-build {
    width: 100%;
    padding: 6pt;
    font-weight: 600;
    cursor: pointer;
  }
  .np-build:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .np-error {
    color: var(--error-color, #d33);
    font-size: 0.85em;
    margin-top: 6pt;
    word-break: break-word;
  }
  .np-success {
    color: var(--success-color, #2a2);
    font-size: 0.85em;
    margin-top: 6pt;
  }
</style>

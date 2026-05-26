<script lang="ts">
  import type { ComponentProps } from 'svelte'
  import type { AnyStructure, PymatgenStructure } from '$lib/structure'
  import Select from 'svelte-multiselect'
  import type { ObjectOption } from 'svelte-multiselect'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'
  import { DraggablePane } from '$lib'
  import { SERVER_URL } from '$lib/api/config'
  import {
    buildReticular,
    listPresets,
    listTopologies,
    listBuildingBlocks,
    getTopology,
    type PresetInfo,
    type TopologyDetail,
  } from '$lib/api/reticular'

  load_i18n_module(`structure`)

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
    on_structure_change?: (structure: AnyStructure) => void
    pane_props?: ComponentProps<typeof DraggablePane>[`pane_props`]
    toggle_props?: ComponentProps<typeof DraggablePane>[`toggle_props`]
  } = $props()

  // -- Mode --
  let mode = $state<`preset` | `advanced`>(`preset`)

  // -- Status --
  let build_status = $state<`idle` | `building` | `done` | `error`>(`idle`)
  let error_message = $state<string | null>(null)
  let result_message = $state<string | null>(null)

  // -- Preset mode --
  let presets = $state<PresetInfo[]>([])
  let selected_preset = $state<ObjectOption[]>([])
  let preset_options = $derived(
    presets.map((p): ObjectOption => ({ label: `${p.label} (${p.topology})`, value: p.id })),
  )

  // -- Advanced mode --
  let topo_search = $state(``)
  let topo_options = $state<ObjectOption[]>([])
  let selected_topology = $state<ObjectOption[]>([])
  let topo_detail = $state<TopologyDetail | null>(null)

  // Building-block options pool (shared across all BB selects).
  let bb_search = $state(``)
  let bb_options = $state<ObjectOption[]>([])

  // Assignments: node_type -> bb id, "i,j" -> bb id.
  let node_assignment = $state<Record<number, ObjectOption[]>>({})
  let edge_assignment = $state<Record<string, ObjectOption[]>>({})

  // Load presets once.
  $effect(() => {
    listPresets(server_url)
      .then((p) => (presets = p))
      .catch((err) => (error_message = err instanceof Error ? err.message : String(err)))
  })

  // Refresh topology options as the user types (advanced mode).
  $effect(() => {
    const q = topo_search
    if (mode !== `advanced`) return
    let cancelled = false
    listTopologies(q, server_url)
      .then((list) => {
        if (cancelled) return
        topo_options = list.map((x): ObjectOption => ({ label: x.name, value: x.name }))
      })
      .catch((err) => {
        if (!cancelled) error_message = err instanceof Error ? err.message : String(err)
      })
    return () => {
      cancelled = true
    }
  })

  // Refresh building-block options as the user types.
  $effect(() => {
    const q = bb_search
    if (mode !== `advanced` || !topo_detail) return
    let cancelled = false
    listBuildingBlocks(q, server_url)
      .then((list) => {
        if (cancelled) return
        bb_options = list.map((x): ObjectOption => ({ label: x.name, value: x.name }))
      })
      .catch((err) => {
        if (!cancelled) error_message = err instanceof Error ? err.message : String(err)
      })
    return () => {
      cancelled = true
    }
  })

  async function on_topology_selected() {
    const name = String(selected_topology[0]?.value ?? ``)
    if (!name) {
      topo_detail = null
      return
    }
    error_message = null
    try {
      topo_detail = await getTopology(name, server_url)
      node_assignment = {}
      edge_assignment = {}
    } catch (err) {
      error_message = err instanceof Error ? err.message : String(err)
      topo_detail = null
    }
  }

  function bb_id(sel: ObjectOption[] | undefined): string | undefined {
    const v = sel?.[0]?.value
    return v == null ? undefined : String(v)
  }

  function collect_node_bbs(): Record<number, string> {
    const out: Record<number, string> = {}
    for (const nt of topo_detail?.node_types ?? []) {
      const id = bb_id(node_assignment[nt])
      if (id) out[nt] = id
    }
    return out
  }

  function collect_edge_bbs(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const et of topo_detail?.edge_types ?? []) {
      const key = et.join(`,`)
      const id = bb_id(edge_assignment[key])
      if (id) out[key] = id
    }
    return out
  }

  async function do_build() {
    on_push_undo?.()
    error_message = null
    result_message = null
    build_status = `building`
    try {
      const body =
        mode === `preset`
          ? { mode, preset: String(selected_preset[0]?.value ?? ``) }
          : {
              mode,
              topology: String(selected_topology[0]?.value ?? ``),
              node_bbs: collect_node_bbs(),
              edge_bbs: collect_edge_bbs(),
            }
      const result = await buildReticular(body, server_url)
      structure = result.structure
      on_structure_change?.(result.structure)
      build_status = `done`
      result_message = result.message
    } catch (err) {
      build_status = `error`
      error_message = err instanceof Error ? err.message : String(err)
    }
  }

  let can_build = $derived(
    mode === `preset`
      ? selected_preset.length > 0
      : selected_topology.length > 0 && topo_detail != null,
  )
</script>

{#snippet pane_content()}
  <h4>{t(`structure.reticular_builder`)}</h4>

  <!-- Mode tabs -->
  <div class="mode-tabs">
    <button
      type="button"
      class:active={mode === `preset`}
      onclick={() => (mode = `preset`)}
    >
      {t(`structure.reticular_mode_preset`)}
    </button>
    <button
      type="button"
      class:active={mode === `advanced`}
      onclick={() => (mode = `advanced`)}
    >
      {t(`structure.reticular_mode_advanced`)}
    </button>
  </div>

  {#if mode === `preset`}
    <p class="hint">{t(`structure.reticular_hint_preset`)}</p>
    <label class="field">
      <span>{t(`structure.reticular_preset`)}</span>
      <Select
        options={preset_options}
        maxSelect={1}
        bind:selected={selected_preset}
        placeholder={t(`structure.reticular_preset`)}
        liOptionStyle="padding: 3pt 6pt;"
        ulSelectedStyle="display: contents;"
        inputStyle="min-width: 0;"
        style="min-width: 0;"
      />
    </label>
  {:else}
    <p class="hint">{t(`structure.reticular_hint_advanced`)}</p>
    <label class="field">
      <span>{t(`structure.reticular_topology`)}</span>
      <Select
        options={topo_options}
        maxSelect={1}
        bind:selected={selected_topology}
        bind:searchText={topo_search}
        onadd={on_topology_selected}
        onremove={on_topology_selected}
        placeholder={t(`structure.reticular_topology`)}
        liOptionStyle="padding: 3pt 6pt;"
        ulSelectedStyle="display: contents;"
        inputStyle="min-width: 0;"
        style="min-width: 0;"
      />
    </label>

    {#if topo_detail}
      <fieldset class="bb-fieldset">
        <legend>{t(`structure.reticular_node_bb`)}</legend>
        {#each topo_detail.node_types as nt, i (nt)}
          <label class="field">
            <span>node {nt} (cn {topo_detail.node_cn[i]})</span>
            <Select
              options={bb_options}
              maxSelect={1}
              bind:selected={node_assignment[nt]}
              bind:searchText={bb_search}
              placeholder={t(`structure.reticular_node_bb`)}
              liOptionStyle="padding: 3pt 6pt;"
              ulSelectedStyle="display: contents;"
              inputStyle="min-width: 0;"
              style="min-width: 0;"
            />
          </label>
        {/each}
      </fieldset>

      <fieldset class="bb-fieldset">
        <legend>{t(`structure.reticular_edge_bb`)}</legend>
        {#each topo_detail.edge_types as et (et.join(`,`))}
          <label class="field">
            <span>edge {et.join(`–`)}</span>
            <Select
              options={bb_options}
              maxSelect={1}
              bind:selected={edge_assignment[et.join(`,`)]}
              bind:searchText={bb_search}
              placeholder={t(`structure.reticular_edge_bb`)}
              liOptionStyle="padding: 3pt 6pt;"
              ulSelectedStyle="display: contents;"
              inputStyle="min-width: 0;"
              style="min-width: 0;"
            />
          </label>
        {/each}
      </fieldset>
    {/if}
  {/if}

  <div class="controls">
    <button
      type="button"
      onclick={do_build}
      disabled={build_status === `building` || !can_build}
      class="primary build-btn"
    >
      {build_status === `building` ? t(`structure.building`) : t(`structure.reticular_build`)}
    </button>
  </div>

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
    pane_props={{ ...pane_props, class: `reticular-pane ${pane_props?.class ?? ``}` }}
    toggle_props={{
      title: pane_open ? `` : t(`structure.reticular_builder`),
      ...toggle_props,
      class: `reticular-toggle ${toggle_props?.class ?? ``}`,
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
    gap: 4pt;
    margin-bottom: 8pt;
  }

  .mode-tabs button {
    flex: 1;
    padding: 4pt 8pt;
    border: 1px solid var(--border-color, #ccc);
    border-radius: 3pt;
    background: var(--bg-secondary, #f5f5f5);
    cursor: pointer;
    font-size: 0.9em;
  }

  .mode-tabs button.active {
    background: var(--accent-color, #2196f3);
    color: white;
    border-color: var(--accent-color, #2196f3);
  }

  .hint {
    font-size: 0.8em;
    color: var(--text-secondary, #888);
    margin: 0 0 8pt;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 2pt;
    margin-bottom: 6pt;
  }

  .field span {
    color: var(--text-secondary, #666);
    font-size: 0.8em;
  }

  .bb-fieldset {
    border: 1px solid var(--border-color, #ddd);
    border-radius: 3pt;
    padding: 6pt;
    margin-bottom: 8pt;
  }

  .bb-fieldset legend {
    font-size: 0.85em;
    font-weight: 600;
    color: var(--text-secondary, #555);
    padding: 0 4pt;
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

  .controls button.primary {
    background: var(--accent-color, #2196f3);
    color: white;
    border: none;
  }

  .controls button.primary:hover:not(:disabled) {
    background: var(--accent-color-dark, #1976d2);
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

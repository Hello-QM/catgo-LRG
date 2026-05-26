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
    type BuildingBlockInfo,
  } from '$lib/api/reticular'
  import { searchMofs, getMofStructure, MOFDB_DATABASES, type MofHit } from '$lib/api/mofdb'

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
  let mode = $state<`preset` | `advanced` | `search`>(`preset`)

  // -- Status --
  let build_status = $state<`idle` | `building` | `done` | `error`>(`idle`)
  let error_message = $state<string | null>(null)
  let result_message = $state<string | null>(null)

  // -- Search mode (MOFX-DB) --
  let search_name = $state(``)
  let search_database = $state(``) // empty = all databases
  let search_status = $state<`idle` | `searching` | `done` | `error`>(`idle`)
  let search_hits = $state<MofHit[]>([])
  let search_count = $state(0)

  async function do_search() {
    search_status = `searching`
    error_message = null
    try {
      const res = await searchMofs(
        { name: search_name || undefined, database: search_database || undefined, limit: 50 },
        server_url,
      )
      search_hits = res.hits
      search_count = res.count
      search_status = `done`
    } catch (err) {
      search_status = `error`
      error_message = err instanceof Error ? err.message : String(err)
    }
  }

  async function load_hit(hit: MofHit) {
    on_push_undo?.()
    error_message = null
    try {
      // Round-trip key is (name, database) — NOT an id/mofid.
      const res = await getMofStructure(hit.name, hit.database, server_url)
      structure = res.structure
      on_structure_change?.(res.structure)
      result_message = `Loaded ${res.name}`
    } catch (err) {
      error_message = err instanceof Error ? err.message : String(err)
    }
  }

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

  // Building-block pool (raw enriched BBs, shared across all BB selects).
  // Each slot derives its own connection-compatible, richly-labelled options
  // from this pool via `bb_options_for(cn)`.
  let bb_search = $state(``)
  let bb_pool = $state<BuildingBlockInfo[]>([])

  function bb_options_for(cn: number): ObjectOption[] {
    return bb_pool
      .filter((b) => b.n_connection_points === cn)
      .map((b): ObjectOption => ({
        label: `${b.name} — ${b.formula} (${b.n_connection_points}-c)`,
        value: b.name,
      }))
  }

  // Distinct node connection numbers present in the current topology, sorted.
  // Building blocks are assigned BY connection number, not per node/edge type:
  // one selector per distinct node cn, plus a single selector for all edges
  // (edges are always 2-connected).
  let node_cns = $derived(
    topo_detail ? Array.from(new Set(topo_detail.node_cn)).sort((a, b) => a - b) : [],
  )
  let has_edges = $derived((topo_detail?.edge_types?.length ?? 0) > 0)

  // selected BB per node cn group, and a single edge BB (all edges are 2-connected)
  let node_bb_by_cn = $state<Record<number, ObjectOption[]>>({})
  let edge_bb = $state<ObjectOption[]>([])

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
    listBuildingBlocks(q, undefined, server_url)
      .then((list) => {
        if (cancelled) return
        bb_pool = list
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
      const detail = await getTopology(name, server_url)
      // Pre-seed every cn slot with an empty array BEFORE topo_detail is set, so
      // each per-cn <Select bind:selected> never binds `undefined`
      // (svelte-multiselect's `selected` has a fallback and rejects undefined).
      const cns = Array.from(new Set(detail.node_cn))
      node_bb_by_cn = Object.fromEntries(cns.map((cn) => [cn, []]))
      edge_bb = []
      topo_detail = detail
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
    if (!topo_detail) return out
    topo_detail.node_types.forEach((nt, i) => {
      const cn = topo_detail!.node_cn[i]
      const id = bb_id(node_bb_by_cn[cn])
      if (id) out[nt] = id
    })
    return out
  }

  function collect_edge_bbs(): Record<string, string> {
    const out: Record<string, string> = {}
    if (!topo_detail) return out
    const id = bb_id(edge_bb)
    if (id) {
      for (const et of topo_detail.edge_types) out[et.join(`,`)] = id
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
              // build button is hidden in `search` mode, so this branch is only
              // ever reached in `advanced` mode — narrow accordingly for the API
              mode: `advanced` as const,
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
      : selected_topology.length > 0 &&
          topo_detail != null &&
          node_cns.length > 0 &&
          node_cns.every((cn) => (node_bb_by_cn[cn]?.length ?? 0) > 0),
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
    <button type="button" class:active={mode === `search`} onclick={() => (mode = `search`)}>
      {t(`structure.reticular_mode_search`)}
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
  {:else if mode === `advanced`}
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
        <p class="hint">Search by element (e.g. "Cu", "Zn") or formula. Only connection-compatible building blocks are shown.</p>
        {#each node_cns as cn (cn)}
          <label class="field">
            <span>{cn}-connected node</span>
            <Select
              options={bb_options_for(cn)}
              maxSelect={1}
              bind:selected={node_bb_by_cn[cn]}
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

      {#if has_edges}
        <fieldset class="bb-fieldset">
          <legend>{t(`structure.reticular_edge_bb`)}</legend>
          <label class="field">
            <span>2-connected edge</span>
            <Select
              options={bb_options_for(2)}
              maxSelect={1}
              bind:selected={edge_bb}
              bind:searchText={bb_search}
              placeholder={t(`structure.reticular_edge_bb`)}
              liOptionStyle="padding: 3pt 6pt;"
              ulSelectedStyle="display: contents;"
              inputStyle="min-width: 0;"
              style="min-width: 0;"
            />
          </label>
        </fieldset>
      {/if}
    {/if}
  {:else if mode === `search`}
    <p class="hint">{t(`structure.reticular_hint_search`)}</p>
    <label class="field">
      <span>{t(`structure.reticular_search_name`)}</span>
      <input type="text" bind:value={search_name} placeholder="ABAVIJ_clean / hMOF-5 …" />
    </label>
    <p class="hint">{t(`structure.reticular_search_name_hint`)}</p>
    <label class="field">
      <span>{t(`structure.reticular_search_database`)}</span>
      <select bind:value={search_database}>
        <option value="">—</option>
        {#each MOFDB_DATABASES as db (db)}
          <option value={db}>{db}</option>
        {/each}
      </select>
    </label>
    <button type="button" class="primary" onclick={do_search} disabled={search_status === `searching`}>
      {search_status === `searching` ? `…` : t(`structure.reticular_search_button`)}
    </button>

    {#if search_status === `done`}
      <p class="hint">{search_count} {t(`structure.reticular_search_count`)}</p>
      {#if search_hits.length === 0}
        <p class="hint">{t(`structure.reticular_search_no_results`)}</p>
      {/if}
      <ul class="mof-results">
        {#each search_hits as hit (`${hit.database}/${hit.name}`)}
          <li class="mof-hit">
            <div class="mof-hit-info">
              <strong>{hit.name}</strong>
              <small>{hit.database}{hit.elements.length ? ` · ${hit.elements.join(`, `)}` : ``}</small>
            </div>
            <button type="button" onclick={() => load_hit(hit)}>
              {t(`structure.reticular_search_load`)}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}

  {#if mode !== `search`}
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
  {/if}

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

  .mof-results { list-style: none; margin: 0.5em 0 0; padding: 0; max-height: 16em; overflow-y: auto; }
  .mof-hit { display: flex; align-items: center; justify-content: space-between; gap: 0.5em; padding: 0.25em 0; border-bottom: 1px solid var(--border-color, #8884); }
  .mof-hit-info { display: flex; flex-direction: column; min-width: 0; }
  .mof-hit-info small { opacity: 0.7; }
</style>

<script lang="ts">
  import type { PymatgenStructure } from '$lib/structure'
  import type { ElementSymbol } from '$lib'
  import { PeriodicTable } from '$lib/periodic-table'
  import { combinatorial_substitution } from '$lib/api/build'
  import type { TrajectoryType } from '$lib/trajectory'
  import { normalize_pymatgen_frame_structure } from '$lib/trajectory/parsers/json'

  let {
    structure = $bindable<PymatgenStructure | undefined>(),
    selected_sites = [],
    on_push_undo,
    on_trajectory_created,
    // PT state exposed to parent for the separate window panel
    pt_highlight_symbols = $bindable<string[]>([]),
    pt_group_label = $bindable(''),
    // PT window state — when closed, show a reopen button
    pt_window_open = false,
    on_reopen_pt,
  }: {
    structure?: PymatgenStructure
    selected_sites?: number[]
    on_push_undo?: () => void
    on_trajectory_created?: (traj: TrajectoryType) => void
    pt_highlight_symbols?: string[]
    pt_group_label?: string
    pt_window_open?: boolean
    on_reopen_pt?: () => void
  } = $props()

  // --- Exported functions for PT panel interaction ---
  export function toggle_element(sym: string) {
    const g = groups[active_group_idx]
    if (!g) return
    if (g.replacement_elements.includes(sym)) {
      g.replacement_elements = g.replacement_elements.filter((e) => e !== sym)
    } else {
      g.replacement_elements = [...g.replacement_elements, sym]
    }
    groups = [...groups]
  }

  export function add_element(sym: string) {
    const g = groups[active_group_idx]
    if (!g || g.replacement_elements.includes(sym)) return
    g.replacement_elements = [...g.replacement_elements, sym]
    groups = [...groups]
  }

  // --- Group model ---
  type SelectionMode = `by_element` | `by_indices`
  type SubGroup = {
    id: number
    selection_mode: SelectionMode
    target_element: string
    captured_indices: number[]
    replacement_elements: string[]
  }

  let next_id = $state(1)
  let groups = $state<SubGroup[]>([
    { id: 0, selection_mode: `by_element`, target_element: ``, captured_indices: [], replacement_elements: [] },
  ])
  let active_group_idx = $state(0)
  let show_help = $state(false)

  // --- Generation settings ---
  let max_structures = $state(500)

  // --- Status ---
  let status = $state<`idle` | `running` | `complete` | `error`>(`idle`)
  let error_message = $state<string | null>(null)
  let result_structures = $state<Record<string, unknown>[]>([])
  let result_labels = $state<string[]>([])
  let result_capped = $state(false)
  let result_total = $state(0)

  // --- Derived: elements in structure ---
  let structure_elements = $derived.by(() => {
    if (!structure?.sites) return []
    const elems = new Set<string>()
    for (const s of structure.sites) {
      if (s.species[0]) elems.add(s.species[0].element)
    }
    return [...elems].sort()
  })

  // Auto-select first element for groups that have empty target_element
  $effect(() => {
    if (structure_elements.length > 0) {
      for (const g of groups) {
        if (!g.target_element) g.target_element = structure_elements[0]
      }
    }
  })

  // Update PT state for parent split-view panel
  $effect(() => {
    const g = groups[active_group_idx]
    pt_highlight_symbols = g?.replacement_elements ?? []
    pt_group_label = `Group ${active_group_idx + 1}`
  })

  // Resolve target indices for a group
  function resolve_targets(g: SubGroup): number[] {
    if (!structure?.sites) return []
    if (g.selection_mode === `by_element` && g.target_element) {
      return structure.sites
        .map((s, i) => (s.species[0]?.element === g.target_element ? i : -1))
        .filter((i) => i >= 0)
    }
    return g.captured_indices
  }

  // Combinatorial count: product of replacement counts across all valid groups
  let valid_groups = $derived(
    groups.filter((g) => resolve_targets(g).length > 0 && g.replacement_elements.length > 0),
  )

  let combo_count = $derived.by(() => {
    if (valid_groups.length === 0) return 0
    return valid_groups.reduce((acc, g) => acc * g.replacement_elements.length, 1)
  })

  let will_cap = $derived(combo_count > max_structures)

  // --- Group actions ---
  function add_group() {
    groups = [
      ...groups,
      {
        id: next_id++,
        selection_mode: `by_element`,
        target_element: structure_elements[0] || ``,
        captured_indices: [],
        replacement_elements: [],
      },
    ]
    active_group_idx = groups.length - 1
  }

  function remove_group(idx: number) {
    if (groups.length <= 1) return
    groups = groups.filter((_, i) => i !== idx)
    if (active_group_idx >= groups.length) active_group_idx = groups.length - 1
  }

  function remove_replacement(group_idx: number, sym: string) {
    const g = groups[group_idx]
    g.replacement_elements = g.replacement_elements.filter((e) => e !== sym)
    groups = [...groups]
  }

  // --- Generate ---
  async function generate() {
    if (!structure || valid_groups.length === 0) {
      error_message = `Add at least one group with targets and replacement elements`
      return
    }
    on_push_undo?.()
    status = `running`
    error_message = null

    try {
      const result = await combinatorial_substitution({
        structure: structure as unknown as Record<string, unknown>,
        groups: valid_groups.map((g) => ({
          target_indices: resolve_targets(g),
          replacement_elements: g.replacement_elements,
        })),
        max_structures,
      })
      result_structures = result.structures
      result_labels = result.labels
      result_total = combo_count
      result_capped = result.count < combo_count
      status = `complete`
    } catch (err) {
      status = `error`
      error_message = err instanceof Error ? err.message : String(err)
    }
  }

  function open_as_trajectory() {
    if (result_structures.length === 0) return
    // `combinatorial_substitution` returns raw `pymatgen.Structure.as_dict()`
    // payloads with `@class`, `@module`, `charge`, `oxidation_state: null`,
    // etc. Feeding those straight into Trajectory turns each frame into a
    // deep reactive proxy with extra slots; combined with per-frame element
    // changes from substitution, the trajectory-bond-cache + position-cache
    // pipeline re-clears + re-writes connectivity every flush and overflows
    // Svelte 5's effect guard under the VS Code webview. Rebuild via
    // `create_structure` (the same path extxyz uses) so the resulting
    // trajectory matches the well-behaved on-disk format.
    const frames = result_structures.map((s, i) => {
      const normalized = normalize_pymatgen_frame_structure(
        s as Record<string, unknown>,
      )
      return {
        structure: (normalized ?? s) as unknown as PymatgenStructure,
        step: i,
        metadata: { label: result_labels[i] || `Structure ${i + 1}` },
      }
    })
    on_trajectory_created?.({
      frames,
      total_frames: frames.length,
      metadata: {
        source_format: `doping_substitution`,
        frame_count: frames.length,
      },
    } as TrajectoryType)
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="doping-pane">
  <div class="dp-title-row">
    <button class="dp-help-btn" onclick={() => show_help = !show_help} title="How to use">?</button>
  </div>

  <!-- Inline periodic table -->
  {#if groups[active_group_idx]}
    {@const ag = groups[active_group_idx]}
    <div class="dp-pt-container" role="presentation" onclick={(event) => {
      const tile = (event.target as HTMLElement).closest(`.element-tile`)
      if (tile) {
        const sym_el = tile.querySelector(`.symbol`)
        const sym = sym_el?.textContent?.trim() ?? ``
        if (sym) toggle_element(sym)
      }
    }}>
      <PeriodicTable
        active_element={null}
        active_elements={ag.replacement_elements as ElementSymbol[]}
        tile_props={{ show_symbol: true, show_number: false, show_name: false }}
        gap="0.5cqw"
        show_color_bar={false}
      />
    </div>
  {/if}

  {#if show_help}
    <div class="dp-help-box">
      <strong>Combinatorial Doping</strong>
      <ol>
        <li>Each <b>Group</b> defines one substitution site. Choose target atoms by element or by selecting atoms in the 3D viewer.</li>
        <li>In the <b>Periodic Table</b> window, click elements to add replacement candidates (shown as green chips). Drag across elements for quick multi-select.</li>
        <li>Add more groups to substitute multiple sites simultaneously.</li>
        <li>Click <b>Generate Structures</b> to create all combinatorial substitutions, then <b>Open as Trajectory</b> to browse them.</li>
      </ol>
      <button class="dp-help-close" onclick={() => show_help = false}>Got it</button>
    </div>
  {/if}

  <!-- Groups -->
  {#each groups as group, gi (group.id)}
    {@const targets = resolve_targets(group)}
    <section
      class="dp-group"
      class:active={gi === active_group_idx}
      onclick={() => (active_group_idx = gi)}
    >
      <div class="dp-group-header">
        <span class="dp-group-title">Group {gi + 1}</span>
        {#if groups.length > 1}
          <button class="dp-group-close" onclick={(e) => { e.stopPropagation(); remove_group(gi) }}>&times;</button>
        {/if}
      </div>

      <!-- Target -->
      <div class="dp-mode-row">
        <label class="dp-radio">
          <input
            type="radio"
            checked={group.selection_mode === `by_element`}
            onchange={() => { group.selection_mode = `by_element`; groups = [...groups] }}
          />
          By Element
        </label>
        <label class="dp-radio">
          <input
            type="radio"
            checked={group.selection_mode === `by_indices`}
            onchange={() => { group.selection_mode = `by_indices`; groups = [...groups] }}
          />
          By Selection
        </label>
      </div>

      {#if group.selection_mode === `by_element`}
        <select
          class="dp-select"
          value={group.target_element}
          onchange={(e) => { group.target_element = e.currentTarget.value; groups = [...groups] }}
        >
          {#each structure_elements as el}
            <option value={el}>{el}</option>
          {/each}
        </select>
        <div class="dp-hint">
          {targets.length} {group.target_element} atom{targets.length !== 1 ? `s` : ``}
        </div>
      {:else}
        {#if group.captured_indices.length > 0}
          <div class="dp-hint">
            {group.captured_indices.length} captured: {group.captured_indices.slice(0, 8).join(`, `)}{group.captured_indices.length > 8 ? `...` : ``}
          </div>
          <button
            class="dp-capture-btn"
            onclick={(e) => { e.stopPropagation(); group.captured_indices = []; groups = [...groups] }}
          >Clear</button>
        {:else}
          <div class="dp-hint">
            {selected_sites.length > 0
              ? `${selected_sites.length} in viewer: ${selected_sites.slice(0, 6).join(`, `)}${selected_sites.length > 6 ? `...` : ``}`
              : `Click atoms in the 3D viewer`}
          </div>
          <button
            class="dp-capture-btn"
            disabled={selected_sites.length === 0}
            onclick={(e) => { e.stopPropagation(); group.captured_indices = [...selected_sites]; groups = [...groups] }}
          >Capture Selection ({selected_sites.length})</button>
        {/if}
      {/if}

      <!-- Replacement chips -->
      <div class="dp-chips">
        {#each group.replacement_elements as el}
          <span class="dp-chip">
            {el}
            <button class="dp-chip-x" onclick={(e) => { e.stopPropagation(); remove_replacement(gi, el) }}>&times;</button>
          </span>
        {/each}
        {#if group.replacement_elements.length === 0}
          <span class="dp-hint">Select elements in periodic table</span>
        {/if}
      </div>
    </section>
  {/each}

  <button class="dp-add-group-btn" onclick={add_group}>+ Add Group</button>

  <!-- Preview -->
  {#if combo_count > 0}
    <section class="dp-section">
      <h5 class="dp-label">Preview</h5>
      <div class="dp-preview">
        {valid_groups.map((g) => g.replacement_elements.length).join(` \u00d7 `)}
        = <strong>{combo_count.toLocaleString()}</strong> structures
      </div>
      {#if will_cap}
        <div class="dp-warning">Capped at {max_structures} structures</div>
      {/if}
      <div class="dp-max-row">
        <span class="dp-hint">Max:</span>
        <input type="number" class="dp-input-num" bind:value={max_structures} min={1} max={10000} />
      </div>
    </section>
  {/if}

  <!-- Actions -->
  <section class="dp-section">
    {#if error_message}
      <div class="dp-error">{error_message}</div>
    {/if}

    <button
      class="dp-btn-generate"
      onclick={generate}
      disabled={status === `running` || valid_groups.length === 0}
    >
      {status === `running` ? `Generating...` : `Generate Structures`}
    </button>

    {#if status === `complete` && result_structures.length > 0}
      <div class="dp-result">
        {result_structures.length}{result_capped ? `/${result_total.toLocaleString()}` : ``} structures generated
      </div>
      <button class="dp-btn-traj" onclick={open_as_trajectory}>
        Open as Trajectory
      </button>
    {/if}
  </section>
</div>

<style>
  .doping-pane {
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 0.85em;
    min-width: 0;
  }

  .dp-title-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  /* ─── Inline periodic table container ─── */
  .dp-pt-container {
    margin-bottom: 6px;
    padding: 4px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 6px;
    background: rgba(0, 0, 0, 0.12);
    container-type: inline-size;
    cursor: pointer;
    overflow-x: auto;
    overflow-y: hidden;
  }

  .dp-open-pt-btn {
    padding: 6px 14px;
    background: var(--accent-color, #3b82f6);
    border: none;
    border-radius: 6px;
    color: white;
    font-size: 0.85em;
    font-weight: 600;
    cursor: pointer;
    flex: 1;
    text-align: center;
  }
  .dp-open-pt-btn:hover {
    filter: brightness(1.1);
  }

  .dp-help-btn {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    border: 1px solid var(--border-color);
    background: none;
    color: var(--text-color-muted, #94a3b8);
    font-size: 0.8em;
    font-weight: 700;
    cursor: pointer;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    margin-left: auto;
  }
  .dp-help-btn:hover {
    border-color: var(--accent-color, #3b82f6);
    color: var(--accent-color, #3b82f6);
  }

  .dp-help-box {
    background: var(--input-bg, rgba(0, 0, 0, 0.15));
    border: 1px solid var(--border-color);
    border-radius: 6px;
    padding: 10px 12px;
    font-size: 0.8em;
    color: var(--text-color, #e0e0e0);
    line-height: 1.5;
  }
  .dp-help-box ol {
    margin: 6px 0 8px;
    padding-left: 18px;
  }
  .dp-help-box li {
    margin-bottom: 4px;
  }
  .dp-help-close {
    padding: 3px 10px;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    background: none;
    color: var(--text-color-muted, #94a3b8);
    font-size: 0.85em;
    cursor: pointer;
  }
  .dp-help-close:hover {
    border-color: var(--accent-color, #3b82f6);
    color: var(--accent-color, #3b82f6);
  }

  .dp-group {
    display: flex;
    flex-direction: column;
    gap: 4px;
    border: 1px solid var(--border-color);
    border-radius: 6px;
    padding: 8px;
    cursor: pointer;
    transition: border-color 0.15s;
  }
  .dp-group.active {
    border-color: var(--accent-color, #3b82f6);
  }

  .dp-group-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .dp-group-title {
    font-size: 0.75em;
    font-weight: 600;
    color: var(--text-color-muted, #94a3b8);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .dp-group-close {
    background: none;
    border: none;
    color: var(--text-color-dim, #64748b);
    cursor: pointer;
    font-size: 1.2em;
    line-height: 1;
    padding: 0 4px;
  }
  .dp-group-close:hover {
    color: var(--error-color, #ef4444);
  }

  .dp-capture-btn {
    padding: 3px 10px;
    border: 1px solid var(--accent-color, #3b82f6);
    border-radius: 4px;
    background: none;
    color: var(--accent-color, #3b82f6);
    font-size: 0.75em;
    cursor: pointer;
    align-self: flex-start;
  }
  .dp-capture-btn:hover:not(:disabled) {
    background: color-mix(in srgb, var(--accent-color, #3b82f6) 10%, transparent);
  }
  .dp-capture-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .dp-section {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .dp-label {
    font-size: 0.75em;
    font-weight: 600;
    color: var(--text-color-muted, #94a3b8);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin: 0;
  }

  .dp-mode-row {
    display: flex;
    gap: 12px;
  }

  .dp-radio {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 0.85em;
    color: var(--text-color, #e0e0e0);
    cursor: pointer;
  }

  .dp-radio input {
    margin: 0;
  }

  .dp-select {
    padding: 4px 8px;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    background: var(--input-bg, rgba(0, 0, 0, 0.15));
    color: var(--text-color, #e0e0e0);
    font-size: 0.85em;
  }

  .dp-hint {
    font-size: 0.75em;
    color: var(--text-color-dim, #64748b);
  }

  .dp-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    align-items: center;
  }

  .dp-chip {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 1px 7px;
    background: #10b981;
    color: white;
    border-radius: 10px;
    font-size: 0.75em;
    font-weight: 600;
  }

  .dp-chip-x {
    background: none;
    border: none;
    color: rgba(255, 255, 255, 0.7);
    cursor: pointer;
    padding: 0 2px;
    font-size: 1.1em;
    line-height: 1;
  }
  .dp-chip-x:hover {
    color: white;
  }

  .dp-add-group-btn {
    padding: 4px 12px;
    border: 1px dashed var(--border-color);
    border-radius: 6px;
    background: none;
    color: var(--text-color-muted, #94a3b8);
    font-size: 0.8em;
    cursor: pointer;
    align-self: flex-start;
  }
  .dp-add-group-btn:hover {
    border-color: var(--accent-color, #3b82f6);
    color: var(--accent-color, #3b82f6);
  }

  .dp-preview {
    font-size: 0.85em;
    color: var(--text-color, #e0e0e0);
  }

  .dp-warning {
    font-size: 0.75em;
    color: var(--warning-color, #f59e0b);
  }

  .dp-max-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .dp-input-num {
    width: 80px;
    padding: 2px 6px;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    background: var(--input-bg, rgba(0, 0, 0, 0.15));
    color: var(--text-color, #e0e0e0);
    font-size: 0.85em;
  }

  .dp-error {
    font-size: 0.8em;
    color: var(--error-color, #ef4444);
  }

  .dp-btn-generate {
    padding: 6px 14px;
    background: var(--accent-color, #3b82f6);
    border: none;
    border-radius: 6px;
    color: white;
    font-size: 0.85em;
    font-weight: 600;
    cursor: pointer;
  }
  .dp-btn-generate:hover:not(:disabled) {
    filter: brightness(1.1);
  }
  .dp-btn-generate:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .dp-result {
    font-size: 0.8em;
    color: var(--text-color-muted, #94a3b8);
  }

  .dp-btn-traj {
    padding: 6px 14px;
    background: none;
    border: 1px solid var(--accent-color, #3b82f6);
    border-radius: 6px;
    color: var(--accent-color, #3b82f6);
    font-size: 0.85em;
    font-weight: 600;
    cursor: pointer;
  }
  .dp-btn-traj:hover {
    background: color-mix(in srgb, var(--accent-color, #3b82f6) 10%, transparent);
  }
</style>

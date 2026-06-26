<script lang="ts">
  import type { PymatgenStructure } from '$lib/structure'
  import type { ElementSymbol } from '$lib'
  import { PeriodicTable } from '$lib/periodic-table'
  import DesktopRequiredNotice from '$lib/DesktopRequiredNotice.svelte'
  import { combinatorial_substitution, random_substitution } from '$lib/api/build'
  import type { RandomSubstitutionParams } from '$lib/api/build'
  import type { TrajectoryType } from '$lib/trajectory'
  import { normalize_pymatgen_frame_structure } from '$lib/trajectory/parsers/json'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'

  // Lazy-load structure translations
  load_i18n_module('structure')

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
    if (pane_mode === `random`) {
      toggle_random_dopant(sym)
      return
    }
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
    if (pane_mode === `random`) {
      if (!rnd_dopants.some((d) => d.element === sym)) toggle_random_dopant(sym)
      return
    }
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

  // --- Pane mode: combinatorial product vs. concentration-based random doping ---
  type PaneMode = `combinatorial` | `random`
  let pane_mode = $state<PaneMode>(`combinatorial`)

  // --- Random doping state ---
  type RandomDopantRow = { id: number; element: string; count: number; percent: number }
  let rnd_target_mode = $state<SelectionMode>(`by_element`)
  let rnd_host_element = $state(``)
  let rnd_captured_indices = $state<number[]>([])
  let rnd_dopants = $state<RandomDopantRow[]>([])
  let rnd_input_style = $state<`count` | `percent`>(`count`)
  let rnd_n_samples = $state(10)
  let rnd_dedup = $state(true)
  let rnd_seed = $state<number | null>(null) // null = fresh random each run
  let rnd_next_id = $state(1)

  // Candidate site pool for random mode (by host element or captured indices)
  let rnd_pool = $derived.by(() => {
    if (!structure?.sites) return [] as number[]
    if (rnd_target_mode === `by_element` && rnd_host_element) {
      return structure.sites
        .map((s, i) => (s.species[0]?.element === rnd_host_element ? i : -1))
        .filter((i) => i >= 0)
    }
    return rnd_captured_indices
  })
  let rnd_pool_size = $derived(rnd_pool.length)
  let rnd_total_replace = $derived(rnd_dopants.reduce((a, d) => a + (d.count || 0), 0))
  let rnd_valid = $derived(
    rnd_pool_size > 0 && rnd_total_replace > 0 && rnd_total_replace <= rnd_pool_size,
  )

  // Default the random host element to the first element present
  $effect(() => {
    if (structure_elements.length > 0 && !rnd_host_element) {
      rnd_host_element = structure_elements[0]
    }
  })

  // Keep count/percent columns consistent when the pool size changes (e.g. host
  // element switched). The active input style is authoritative for re-derivation.
  $effect(() => {
    const size = rnd_pool_size
    if (size <= 0) return
    let changed = false
    const next = rnd_dopants.map((d) => {
      if (rnd_input_style === `percent`) {
        const count = Math.round((d.percent / 100) * size)
        if (count !== d.count) { changed = true; return { ...d, count } }
      } else {
        const percent = +((d.count / size) * 100).toFixed(1)
        if (percent !== d.percent) { changed = true; return { ...d, percent } }
      }
      return d
    })
    if (changed) rnd_dopants = next
  })

  function toggle_random_dopant(sym: string) {
    if (rnd_dopants.some((d) => d.element === sym)) {
      rnd_dopants = rnd_dopants.filter((d) => d.element !== sym)
    } else {
      const percent = rnd_pool_size > 0 ? +((1 / rnd_pool_size) * 100).toFixed(1) : 0
      rnd_dopants = [...rnd_dopants, { id: rnd_next_id++, element: sym, count: 1, percent }]
    }
  }

  function set_dopant_count(id: number, value: number) {
    const count = Math.max(0, Math.floor(value || 0))
    rnd_dopants = rnd_dopants.map((d) =>
      d.id === id
        ? { ...d, count, percent: rnd_pool_size > 0 ? +((count / rnd_pool_size) * 100).toFixed(1) : 0 }
        : d,
    )
  }

  function set_dopant_percent(id: number, value: number) {
    const percent = Math.max(0, value || 0)
    const count = rnd_pool_size > 0 ? Math.round((percent / 100) * rnd_pool_size) : 0
    rnd_dopants = rnd_dopants.map((d) => (d.id === id ? { ...d, percent, count } : d))
  }

  function remove_dopant(id: number) {
    rnd_dopants = rnd_dopants.filter((d) => d.id !== id)
  }

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
    if (pane_mode === `random`) {
      pt_highlight_symbols = rnd_dopants.map((d) => d.element)
      pt_group_label = t('structure.random_dopants_label')
      return
    }
    const g = groups[active_group_idx]
    pt_highlight_symbols = g?.replacement_elements ?? []
    pt_group_label = t('structure.group_n', { n: active_group_idx + 1 })
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
      error_message = t('structure.doping_err_no_group')
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

  // --- Generate (random concentration mode) ---
  async function generate_random() {
    if (!structure || !rnd_valid) {
      error_message = t('structure.random_err_invalid')
      return
    }
    on_push_undo?.()
    status = `running`
    error_message = null

    try {
      const params: RandomSubstitutionParams = {
        structure: structure as unknown as Record<string, unknown>,
        dopants: rnd_dopants
          .filter((d) => d.count > 0)
          .map((d) => ({ element: d.element, count: d.count })),
        n_samples: rnd_n_samples,
        deduplicate: rnd_dedup,
        seed: rnd_seed == null || Number.isNaN(rnd_seed) ? null : rnd_seed,
      }
      if (rnd_target_mode === `by_element`) params.host_element = rnd_host_element
      else params.target_indices = [...rnd_captured_indices]

      const result = await random_substitution(params)
      result_structures = result.structures
      result_labels = result.labels
      result_total = result.count
      result_capped = false
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
    <div class="dp-mode-toggle">
      <button
        class="dp-mode-tab"
        class:active={pane_mode === `combinatorial`}
        onclick={() => (pane_mode = `combinatorial`)}
      >{t('structure.mode_combinatorial')}</button>
      <button
        class="dp-mode-tab"
        class:active={pane_mode === `random`}
        onclick={() => (pane_mode = `random`)}
      >{t('structure.mode_random')}</button>
    </div>
    <button class="dp-help-btn" onclick={() => show_help = !show_help} title={t('structure.how_to_use')}>?</button>
  </div>

  <!-- Inline periodic table (shared by both modes) -->
  {#if structure}
    {@const pt_active = pane_mode === `random`
      ? rnd_dopants.map((d) => d.element)
      : (groups[active_group_idx]?.replacement_elements ?? [])}
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
        active_elements={pt_active as ElementSymbol[]}
        tile_props={{ show_symbol: true, show_number: false, show_name: false }}
        gap="0.5cqw"
        show_color_bar={false}
      />
    </div>
  {/if}

  {#if show_help}
    <div class="dp-help-box">
      {#if pane_mode === `random`}
        <strong>{t('structure.mode_random')}</strong>
        <ol>
          <li>{@html t('structure.random_help_1')}</li>
          <li>{@html t('structure.random_help_2')}</li>
          <li>{@html t('structure.random_help_3')}</li>
        </ol>
      {:else}
        <strong>{t('structure.combinatorial_doping')}</strong>
        <ol>
          <li>{@html t('structure.doping_help_1')}</li>
          <li>{@html t('structure.doping_help_2')}</li>
          <li>{@html t('structure.doping_help_3')}</li>
          <li>{@html t('structure.doping_help_4')}</li>
        </ol>
      {/if}
      <button class="dp-help-close" onclick={() => show_help = false}>{t('structure.got_it')}</button>
    </div>
  {/if}

  <!-- Groups (combinatorial mode) -->
  {#if pane_mode === `combinatorial`}
  {#each groups as group, gi (group.id)}
    {@const targets = resolve_targets(group)}
    <section
      class="dp-group"
      class:active={gi === active_group_idx}
      onclick={() => (active_group_idx = gi)}
    >
      <div class="dp-group-header">
        <span class="dp-group-title">{t('structure.group_n', { n: gi + 1 })}</span>
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
          {t('structure.by_element')}
        </label>
        <label class="dp-radio">
          <input
            type="radio"
            checked={group.selection_mode === `by_indices`}
            onchange={() => { group.selection_mode = `by_indices`; groups = [...groups] }}
          />
          {t('structure.by_selection')}
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
          {t('structure.n_atoms', { n: targets.length, el: group.target_element, s: targets.length !== 1 ? 's' : '' })}
        </div>
      {:else}
        {#if group.captured_indices.length > 0}
          <div class="dp-hint">
            {t('structure.n_captured', { n: group.captured_indices.length })} {group.captured_indices.slice(0, 8).join(`, `)}{group.captured_indices.length > 8 ? `...` : ``}
          </div>
          <button
            class="dp-capture-btn"
            onclick={(e) => { e.stopPropagation(); group.captured_indices = []; groups = [...groups] }}
          >{t('common.clear')}</button>
        {:else}
          <div class="dp-hint">
            {selected_sites.length > 0
              ? `${t('structure.n_in_viewer', { n: selected_sites.length })} ${selected_sites.slice(0, 6).join(`, `)}${selected_sites.length > 6 ? `...` : ``}`
              : t('structure.click_atoms_in_viewer')}
          </div>
          <button
            class="dp-capture-btn"
            disabled={selected_sites.length === 0}
            onclick={(e) => { e.stopPropagation(); group.captured_indices = [...selected_sites]; groups = [...groups] }}
          >{t('structure.capture_selection', { n: selected_sites.length })}</button>
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
          <span class="dp-hint">{t('structure.select_elements_in_pt')}</span>
        {/if}
      </div>
    </section>
  {/each}

  <button class="dp-add-group-btn" onclick={add_group}>{t('structure.add_group')}</button>
  {/if}

  <!-- Random concentration mode -->
  {#if pane_mode === `random`}
    <section class="dp-group active">
      <!-- Host pool selection -->
      <div class="dp-mode-row">
        <label class="dp-radio">
          <input
            type="radio"
            checked={rnd_target_mode === `by_element`}
            onchange={() => (rnd_target_mode = `by_element`)}
          />
          {t('structure.by_element')}
        </label>
        <label class="dp-radio">
          <input
            type="radio"
            checked={rnd_target_mode === `by_indices`}
            onchange={() => (rnd_target_mode = `by_indices`)}
          />
          {t('structure.by_selection')}
        </label>
      </div>

      {#if rnd_target_mode === `by_element`}
        <select
          class="dp-select"
          value={rnd_host_element}
          onchange={(e) => (rnd_host_element = e.currentTarget.value)}
        >
          {#each structure_elements as el}
            <option value={el}>{el}</option>
          {/each}
        </select>
        <div class="dp-hint">
          {t('structure.random_pool', { n: rnd_pool_size, el: rnd_host_element })}
        </div>
      {:else}
        {#if rnd_captured_indices.length > 0}
          <div class="dp-hint">
            {t('structure.n_captured', { n: rnd_captured_indices.length })} {rnd_captured_indices.slice(0, 8).join(`, `)}{rnd_captured_indices.length > 8 ? `...` : ``}
          </div>
          <button class="dp-capture-btn" onclick={() => (rnd_captured_indices = [])}>{t('common.clear')}</button>
        {:else}
          <div class="dp-hint">
            {selected_sites.length > 0
              ? `${t('structure.n_in_viewer', { n: selected_sites.length })} ${selected_sites.slice(0, 6).join(`, `)}${selected_sites.length > 6 ? `...` : ``}`
              : t('structure.click_atoms_in_viewer')}
          </div>
          <button
            class="dp-capture-btn"
            disabled={selected_sites.length === 0}
            onclick={() => (rnd_captured_indices = [...selected_sites])}
          >{t('structure.capture_selection', { n: selected_sites.length })}</button>
        {/if}
      {/if}

      <!-- Dopant rows: element + count/percent -->
      <div class="dp-input-style-row">
        <span class="dp-hint">{t('structure.amount_by')}</span>
        <button class="dp-style-tab" class:active={rnd_input_style === `count`} onclick={() => (rnd_input_style = `count`)}>{t('structure.by_count')}</button>
        <button class="dp-style-tab" class:active={rnd_input_style === `percent`} onclick={() => (rnd_input_style = `percent`)}>{t('structure.by_percent')}</button>
      </div>

      {#if rnd_dopants.length === 0}
        <span class="dp-hint">{t('structure.random_pick_dopants')}</span>
      {/if}
      {#each rnd_dopants as d (d.id)}
        <div class="dp-dopant-row">
          <span class="dp-chip">{d.element}</span>
          {#if rnd_input_style === `count`}
            <input
              type="number" class="dp-input-num" min={0} max={rnd_pool_size}
              value={d.count}
              oninput={(e) => set_dopant_count(d.id, e.currentTarget.valueAsNumber)}
            />
            <span class="dp-hint">{t('structure.atoms_unit')} ({rnd_pool_size > 0 ? d.percent : 0}%)</span>
          {:else}
            <input
              type="number" class="dp-input-num" min={0} max={100} step={0.1}
              value={d.percent}
              oninput={(e) => set_dopant_percent(d.id, e.currentTarget.valueAsNumber)}
            />
            <span class="dp-hint">% (= {d.count} {t('structure.atoms_unit')})</span>
          {/if}
          <button class="dp-chip-x dp-dopant-remove" onclick={() => remove_dopant(d.id)}>&times;</button>
        </div>
      {/each}

      <!-- Sample settings -->
      <div class="dp-max-row">
        <span class="dp-hint">{t('structure.random_n_samples')}</span>
        <input type="number" class="dp-input-num" bind:value={rnd_n_samples} min={1} max={500} />
      </div>
      <div class="dp-max-row">
        <label class="dp-radio">
          <input type="checkbox" bind:checked={rnd_dedup} />
          {t('structure.random_dedup')}
        </label>
      </div>
      <div class="dp-max-row">
        <span class="dp-hint">{t('structure.random_seed')}</span>
        <input type="number" class="dp-input-num" bind:value={rnd_seed} placeholder={t('structure.random_seed_ph')} />
      </div>
    </section>
  {/if}

  <!-- Preview -->
  {#if pane_mode === `combinatorial` && combo_count > 0}
    <section class="dp-section">
      <h5 class="dp-label">{t('common.preview')}</h5>
      <div class="dp-preview">
        {valid_groups.map((g) => g.replacement_elements.length).join(` \u00d7 `)}
        = <strong>{combo_count.toLocaleString()}</strong> {t('structure.structures')}
      </div>
      {#if will_cap}
        <div class="dp-warning">{t('structure.capped_at_n', { n: max_structures })}</div>
      {/if}
      <div class="dp-max-row">
        <span class="dp-hint">{t('structure.max_label')}</span>
        <input type="number" class="dp-input-num" bind:value={max_structures} min={1} max={10000} />
      </div>
    </section>
  {/if}

  {#if pane_mode === `random` && rnd_total_replace > 0}
    <section class="dp-section">
      <h5 class="dp-label">{t('common.preview')}</h5>
      <div class="dp-preview">
        {@html t('structure.random_preview', {
          replace: rnd_total_replace,
          pool: rnd_pool_size,
          remain: Math.max(0, rnd_pool_size - rnd_total_replace),
          el: rnd_target_mode === `by_element` ? rnd_host_element : t('structure.random_pool_generic'),
        })}
      </div>
      {#if rnd_total_replace > rnd_pool_size}
        <div class="dp-warning">{t('structure.random_over_pool', { replace: rnd_total_replace, pool: rnd_pool_size })}</div>
      {/if}
    </section>
  {/if}

  <!-- Actions -->
  <section class="dp-section">
    <DesktopRequiredNotice error={error_message} />

    <button
      class="dp-btn-generate"
      onclick={pane_mode === `random` ? generate_random : generate}
      disabled={status === `running` || (pane_mode === `random` ? !rnd_valid : valid_groups.length === 0)}
    >
      {status === `running` ? t('structure.generating') : t('structure.generate_structures')}
    </button>

    {#if status === `complete` && result_structures.length > 0}
      <div class="dp-result">
        {t('structure.n_structures_generated', { current: result_structures.length, total_part: result_capped ? `/${result_total.toLocaleString()}` : `` })}
      </div>
      <button class="dp-btn-traj" onclick={open_as_trajectory}>
        {t('structure.open_as_trajectory')}
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

  /* ─── Mode toggle (Combinatorial / Random) ─── */
  .dp-mode-toggle {
    display: flex;
    gap: 2px;
    padding: 2px;
    border: 1px solid var(--border-color);
    border-radius: 6px;
    background: var(--input-bg, rgba(0, 0, 0, 0.15));
  }
  .dp-mode-tab {
    padding: 3px 10px;
    border: none;
    border-radius: 4px;
    background: none;
    color: var(--text-color-muted, #94a3b8);
    font-size: 0.8em;
    font-weight: 600;
    cursor: pointer;
  }
  .dp-mode-tab.active {
    background: var(--accent-color, #3b82f6);
    color: white;
  }

  /* ─── Random mode: count/percent toggle + dopant rows ─── */
  .dp-input-style-row {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 4px;
  }
  .dp-style-tab {
    padding: 2px 8px;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    background: none;
    color: var(--text-color-muted, #94a3b8);
    font-size: 0.75em;
    cursor: pointer;
  }
  .dp-style-tab.active {
    border-color: var(--accent-color, #3b82f6);
    color: var(--accent-color, #3b82f6);
  }
  .dp-dopant-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .dp-dopant-remove {
    color: var(--text-color-dim, #64748b);
    margin-left: auto;
  }
  .dp-dopant-remove:hover {
    color: var(--error-color, #ef4444);
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

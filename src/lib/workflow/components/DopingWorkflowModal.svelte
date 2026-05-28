<script lang="ts">
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'
  import type { PymatgenStructure, ElementSymbol } from '$lib'
  import { PeriodicTable } from '$lib/periodic-table'
  import { combinatorial_substitution } from '$lib/api/build'
  import type { TrajectoryType } from '$lib/trajectory'

  load_i18n_module(`workflow`)

  let {
    show = $bindable(false),
    structure = $bindable<PymatgenStructure | null>(null),
    onclose,
    onsave,
  }: {
    show?: boolean
    structure?: PymatgenStructure | null
    onclose?: () => void
    onsave?: (data: { structure_json: string; trajectory?: TrajectoryType }) => void
  } = $props()

  // ─── Structure component (lazy loaded) ───
  let StructureComponent: typeof import('$lib/structure/Structure.svelte').default | null = $state(null)
  let selected_sites = $state<number[]>([])

  // ─── Periodic table brush-select (drag to select multiple elements) ───
  import type { ChemicalElement } from '$lib'
  let pt_active_element = $state<ChemicalElement | null>(null)
  let pt_is_selecting = $state(false)
  let pt_drag_started_on: string | null = null
  let pt_drag_visited_other = false
  let pt_drag_start_added = false

  function pt_pointerdown() {
    pt_is_selecting = true
    pt_drag_visited_other = false
    pt_drag_start_added = false
    pt_drag_started_on = pt_active_element?.symbol ?? null
  }
  function pt_pointerup() {
    pt_is_selecting = false
    if (!pt_drag_visited_other && pt_drag_started_on) {
      toggle_element(pt_drag_started_on)
    }
    pt_drag_started_on = null
    pt_drag_visited_other = false
    pt_drag_start_added = false
  }
  // Track hover during drag to add elements
  $effect(() => {
    if (pt_is_selecting && pt_active_element) {
      const sym = pt_active_element.symbol
      if (sym !== pt_drag_started_on) {
        if (!pt_drag_start_added && pt_drag_started_on) {
          pt_drag_start_added = true
          // Add the starting element (don't toggle, always add)
          const g = groups[active_group_idx]
          if (g && !g.replacement_elements.includes(pt_drag_started_on)) {
            g.replacement_elements = [...g.replacement_elements, pt_drag_started_on]
            groups = [...groups]
          }
        }
        pt_drag_visited_other = true
        // Add the hovered element
        const g = groups[active_group_idx]
        if (g && !g.replacement_elements.includes(sym)) {
          g.replacement_elements = [...g.replacement_elements, sym]
          groups = [...groups]
        }
      }
    }
  })

  $effect(() => {
    if (show && !StructureComponent) {
      import('$lib/structure/Structure.svelte').then(mod => {
        StructureComponent = mod.default
      })
    }
  })

  // ─── Doping state ───
  type SelectionMode = 'by_element' | 'by_indices'
  interface SubGroup {
    id: number
    selection_mode: SelectionMode
    target_element: string
    captured_indices: number[]
    replacement_elements: string[]
  }

  let groups = $state<SubGroup[]>([{ id: 1, selection_mode: 'by_element', target_element: '', captured_indices: [], replacement_elements: [] }])
  let active_group_idx = $state(0)
  let max_structures = $state(50)
  let generating = $state(false)
  let gen_error = $state('')
  let result_count = $state(0)

  // Generated variants
  interface Variant {
    structure: any
    label: string
  }
  let variants = $state<Variant[]>([])
  let active_variant_idx = $state(-1)  // -1 = original structure
  let original_structure = $state<PymatgenStructure | null>(null)

  // The displayed structure switches between original and selected variant
  const display_structure = $derived(
    active_variant_idx >= 0 && active_variant_idx < variants.length
      ? variants[active_variant_idx].structure as PymatgenStructure
      : structure
  )

  let group_counter = 1

  // Elements in the structure
  const structure_elements = $derived.by(() => {
    if (!structure?.sites) return [] as string[]
    const els = new Set<string>()
    for (const site of structure.sites) {
      const sp = (site as any).species?.[0]?.element ?? (site as any).label ?? ''
      if (sp) els.add(sp)
    }
    return [...els].sort()
  })

  // Auto-set first target_element
  $effect(() => {
    if (structure_elements.length > 0 && groups[0] && !groups[0].target_element) {
      groups[0].target_element = structure_elements[0]
      groups = [...groups]
    }
  })

  // ─── Auto-capture: when selected_sites changes, update active group ───
  // Track previous selection to detect actual clicks (not reactive re-fires)
  let prev_selected_len = 0
  $effect(() => {
    const sites = selected_sites  // read dependency
    const len = sites.length
    if (len === prev_selected_len) return  // no actual change
    prev_selected_len = len

    // Use untrack to read groups without creating circular dependency
    const idx = active_group_idx
    const g = $state.snapshot(groups)[idx]
    if (!g || !structure?.sites || len === 0) return

    if (g.selection_mode === 'by_indices') {
      // Auto-capture clicked atoms into the group
      groups[idx].captured_indices = [...sites]
      groups = [...groups]
    } else if (g.selection_mode === 'by_element') {
      // In "By Element" mode, clicking an atom switches the dropdown to that element
      const last_idx = sites[len - 1]
      const site = (structure.sites as any[])[last_idx]
      const el = site?.species?.[0]?.element ?? site?.label ?? ''
      if (el && el !== g.target_element && structure_elements.includes(el)) {
        groups[idx].target_element = el
        groups = [...groups]
      }
    }
  })

  // ─── Highlight target atoms in the viewer ───
  const highlight_indices = $derived.by(() => {
    const g = groups[active_group_idx]
    if (!g) return [] as number[]
    return resolve_targets(g)
  })

  function toggle_element(sym: string) {
    const g = groups[active_group_idx]
    if (!g) return
    if (g.replacement_elements.includes(sym)) {
      g.replacement_elements = g.replacement_elements.filter(e => e !== sym)
    } else {
      g.replacement_elements = [...g.replacement_elements, sym]
    }
    groups = [...groups]
  }

  function add_group() {
    group_counter++
    groups = [...groups, { id: group_counter, selection_mode: 'by_element', target_element: structure_elements[0] ?? '', captured_indices: [], replacement_elements: [] }]
    active_group_idx = groups.length - 1
  }

  function remove_group(idx: number) {
    groups = groups.filter((_, i) => i !== idx)
    if (active_group_idx >= groups.length) active_group_idx = Math.max(0, groups.length - 1)
  }

  function resolve_targets(g: SubGroup): number[] {
    if (!structure?.sites) return []
    if (g.selection_mode === 'by_element') {
      return structure.sites
        .map((s: any, i: number) => (s.species?.[0]?.element ?? s.label) === g.target_element ? i : -1)
        .filter((i: number) => i >= 0)
    }
    return g.captured_indices
  }

  // Combinatorial count
  const combo_count = $derived(
    groups.reduce((acc, g) => acc * (g.replacement_elements.length || 0), groups.length > 0 ? 1 : 0)
  )

  async function generate_structures() {
    if (!structure || generating) return
    generating = true
    gen_error = ''
    result_count = 0
    variants = []
    active_variant_idx = -1
    original_structure = structure
    try {
      const valid_groups = groups
        .filter(g => (g.selection_mode === 'by_element' ? g.target_element : g.captured_indices.length > 0) && g.replacement_elements.length > 0)
        .map(g => ({
          target_indices: resolve_targets(g),
          replacement_elements: g.replacement_elements,
        }))
      if (valid_groups.length === 0) throw new Error(t(`workflow.doping_select_targets_first`))

      const result = await combinatorial_substitution({
        structure: structure as any,
        groups: valid_groups,
        max_structures,
      })

      result_count = result.count
      variants = result.structures.map((s: any, i: number) => ({
        structure: s,
        label: result.labels?.[i] || t(`workflow.doping_variant_n`, { n: i + 1 }),
      }))
      // Auto-select first variant
      if (variants.length > 0) active_variant_idx = 0
    } catch (err) {
      gen_error = String(err)
    } finally {
      generating = false
    }
  }

  function save_all() {
    if (variants.length === 0 || !onsave) return
    const frames = variants.map((v, i) => ({
      structure: v.structure,
      step: i,
      metadata: { label: v.label },
    }))
    onsave({
      structure_json: JSON.stringify(variants[0].structure),
      trajectory: { frames, total_frames: frames.length } as TrajectoryType,
    })
  }

  function handle_close() {
    show = false
    onclose?.()
  }
</script>

{#if show}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="dw-overlay" onclick={handle_close}>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="dw-modal" onclick={(e) => e.stopPropagation()}>
      <!-- Header -->
      <div class="dw-header">
        <h3 class="dw-title">{t(`workflow.doping_editor`)}</h3>
        <div class="dw-header-actions">
          <button class="dw-gen-btn" onclick={generate_structures} disabled={generating || combo_count === 0}>
            {generating ? t(`workflow.generating`) : t(`workflow.doping_generate_structures`, { n: combo_count })}
          </button>
          {#if variants.length > 0}
            <button class="dw-save-btn" onclick={save_all}>
              {t(`workflow.doping_save_all_close`, { n: variants.length })}
            </button>
          {/if}
          <button class="dw-close-btn" onclick={handle_close}>&times;</button>
        </div>
      </div>

      <!-- Body: side-by-side layout -->
      <div class="dw-body">
        <!-- Left panel: sticky PT + scrollable groups + variants -->
        <div class="dw-left">
          <!-- Periodic table (sticky at top) -->
          <div class="dw-pt-section">
            <div class="dw-section-label">{t(`workflow.doping_dopants_for_group`, { n: active_group_idx + 1 })}</div>
            {#if groups[active_group_idx]}
              {@const ag = groups[active_group_idx]}
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div class="dw-pt-container" role="presentation"
                onpointerdown={pt_pointerdown}
                onpointerup={pt_pointerup}
                onpointerleave={pt_pointerup}
                style="user-select: none;"
              >
                <PeriodicTable
                  bind:active_element={pt_active_element}
                  active_elements={ag.replacement_elements as ElementSymbol[]}
                  tile_props={{ show_symbol: true, show_number: false, show_name: false }}
                  gap="0.4cqw"
                  show_color_bar={false}
                />
              </div>
              {#if ag.replacement_elements.length > 0}
                <div class="dw-selected-els">
                  {ag.replacement_elements.join(', ')}
                </div>
              {/if}
            {/if}
          </div>

          <!-- Scrollable middle: groups + config -->
          <div class="dw-scrollable">
            <!-- Groups (collapsible: inactive groups show summary only) -->
            {#each groups as group, gi (group.id)}
              {@const targets = resolve_targets(group)}
              {@const is_active = gi === active_group_idx}
              <div class="dw-group" class:active={is_active} onclick={() => active_group_idx = gi}>
                <div class="dw-group-header">
                  <span class="dw-group-title">{t(`workflow.doping_group_n`, { n: gi + 1 })}</span>
                  <span class="dw-group-summary">
                    {#if !is_active}
                      {group.selection_mode === 'by_element' ? group.target_element : t(`workflow.ads_sites_shown`, { n: group.captured_indices.length })}
                      → {group.replacement_elements.length > 0 ? group.replacement_elements.join(', ') : t(`workflow.none`)}
                    {/if}
                  </span>
                  {#if groups.length > 1}
                    <button class="dw-group-remove" onclick={(e) => { e.stopPropagation(); remove_group(gi) }}>&times;</button>
                  {/if}
                </div>

                {#if is_active}
                  <div class="dw-group-body">
                    <div class="dw-group-mode">
                      <label><input type="radio" checked={group.selection_mode === 'by_element'} onchange={() => { group.selection_mode = 'by_element'; groups = [...groups] }} /> {t(`workflow.doping_all_of_element`)}</label>
                      <label><input type="radio" checked={group.selection_mode === 'by_indices'} onchange={() => { group.selection_mode = 'by_indices'; groups = [...groups] }} /> {t(`workflow.doping_pick_specific_atoms`)}</label>
                    </div>

                    {#if group.selection_mode === 'by_element'}
                      <select class="dw-select" value={group.target_element} onchange={(e) => { group.target_element = e.currentTarget.value; groups = [...groups] }}>
                        {#each structure_elements as el}
                          <option value={el}>{el} ({structure?.sites?.filter((s: any) => (s.species?.[0]?.element ?? s.label) === el).length ?? 0})</option>
                        {/each}
                      </select>
                      <div class="dw-hint">{t(`workflow.doping_targets_hint`, { n: targets.length, element: group.target_element })}</div>
                    {:else}
                      {#if group.captured_indices.length > 0}
                        <div class="dw-hint">{t(`workflow.doping_atoms_selected`, { n: group.captured_indices.length, sites: group.captured_indices.slice(0, 6).join(', ') })}{group.captured_indices.length > 6 ? '...' : ''}</div>
                        <button class="dw-small-btn danger" onclick={(e) => { e.stopPropagation(); group.captured_indices = []; selected_sites = []; groups = [...groups] }}>{t(`workflow.clear_selection`)}</button>
                      {:else}
                        <div class="dw-hint dw-hint-action">{t(`workflow.doping_click_atoms_hint`)}</div>
                      {/if}
                    {/if}

                    {#if group.replacement_elements.length > 0}
                      <div class="dw-chips">
                        {#each group.replacement_elements as el}
                          <span class="dw-chip">{el}<button onclick={(e) => { e.stopPropagation(); group.replacement_elements = group.replacement_elements.filter(x => x !== el); groups = [...groups] }}>&times;</button></span>
                        {/each}
                      </div>
                    {:else}
                      <div class="dw-hint dw-hint-action">{t(`workflow.doping_pick_replacements_hint`)}</div>
                    {/if}
                  </div>
                {/if}
              </div>
            {/each}

            <button class="dw-add-group" onclick={add_group}>{t(`workflow.doping_add_group`)}</button>

            <!-- Config -->
            <div class="dw-config">
              <div class="dw-config-row">
                <label>{t(`workflow.doping_max_structures`)}</label>
                <input type="number" class="dw-num-input" bind:value={max_structures} min={1} max={500} />
              </div>
              {#if combo_count > 0}
                <div class="dw-combo-count">{t(`workflow.doping_configurations`, { n: combo_count })}</div>
              {/if}
              {#if gen_error}
                <div class="dw-error">{gen_error}</div>
              {/if}
            </div>

            <!-- Variants (appears after generation) -->
            {#if variants.length > 0}
              <div class="dw-variants-section">
                <div class="dw-variants-header">
                  <span class="dw-variants-title">{t(`workflow.doping_structures_count`, { n: variants.length })}</span>
                </div>
                <div class="dw-variants-list">
                  <button
                    class="dw-variant-item dw-variant-original"
                    class:active={active_variant_idx === -1}
                    onclick={() => active_variant_idx = -1}
                  >
                    {t(`workflow.doping_original_undoped`)}
                  </button>
                  {#each variants as variant, i}
                    <button
                      class="dw-variant-item"
                      class:active={active_variant_idx === i}
                      onclick={() => active_variant_idx = i}
                    >
                      <span class="dw-variant-num">{i + 1}</span>
                      <span class="dw-variant-label">{variant.label}</span>
                    </button>
                  {/each}
                </div>
              </div>
            {/if}
          </div>
        </div>

        <!-- Right panel: 3D structure viewer + variants panel -->
        <div class="dw-right">
          {#if StructureComponent && display_structure}
            <StructureComponent
              structure={display_structure}
              bind:selected_sites={selected_sites}
              hide_extra_tools={true}
              show_controls={true}
              fullscreen_toggle={false}
              show_image_atoms={false}
              style="--struct-height: 100%; --struct-width: 100%; border-radius: 0;"
            />
          {:else}
            <div class="dw-loading">{t(`workflow.loading_3d_viewer`)}</div>
          {/if}

        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  .dw-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.75); z-index: 9999;
    display: flex; align-items: center; justify-content: center;
  }
  .dw-modal {
    width: 96vw; height: 94vh;
    background: var(--dialog-bg, var(--surface-bg, #fff));
    border: 1px solid var(--dialog-border, rgba(0,0,0,0.12));
    border-radius: 10px;
    display: flex; flex-direction: column;
    overflow: hidden;
    box-shadow: 0 20px 60px rgba(0,0,0,0.2);
    color: var(--text-color, #1a1a1a);
  }
  .dw-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 16px;
    border-bottom: 1px solid var(--dialog-border, rgba(0,0,0,0.08));
    flex-shrink: 0;
  }
  .dw-title {
    margin: 0; font-size: 15px; font-weight: 600; color: #e2e8f0;
  }
  .dw-header-actions { display: flex; gap: 8px; align-items: center; }
  .dw-gen-btn {
    padding: 6px 16px; border-radius: 6px; font-size: 12px; font-weight: 600;
    background: rgba(59,130,246,0.15); border: 1px solid rgba(59,130,246,0.3);
    color: #60a5fa; cursor: pointer; transition: all 0.15s; font-family: inherit;
  }
  .dw-gen-btn:hover:not(:disabled) { background: rgba(59,130,246,0.25); }
  .dw-gen-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .dw-save-btn {
    padding: 6px 16px; border-radius: 6px; font-size: 12px; font-weight: 600;
    background: #059669; border: none; color: white; cursor: pointer;
    transition: all 0.15s; font-family: inherit;
  }
  .dw-save-btn:hover:not(:disabled) { background: #047857; }
  .dw-save-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .dw-close-btn {
    width: 30px; height: 30px; border-radius: 6px; border: none;
    background: transparent; color: #94a3b8; font-size: 18px;
    cursor: pointer; display: flex; align-items: center; justify-content: center;
  }
  .dw-close-btn:hover { background: var(--dialog-border, rgba(0,0,0,0.08)); color: var(--text-color, inherit); }

  /* Side-by-side body */
  .dw-body {
    flex: 1; display: flex; min-height: 0;
  }

  /* Left panel */
  .dw-left {
    width: 420px; flex-shrink: 0;
    display: flex; flex-direction: column;
    border-right: 1px solid var(--dialog-border, rgba(0,0,0,0.08));
    overflow-y: auto; overflow-x: hidden;
    background: rgba(0,0,0,0.15);
    scrollbar-width: thin;
  }
  .dw-section-label {
    font-size: 10px; font-weight: 600; color: #64748b;
    text-transform: uppercase; letter-spacing: 0.5px;
    padding: 8px 12px 4px;
  }
  .dw-pt-section {
    border-bottom: 1px solid var(--dialog-border, rgba(0,0,0,0.06));
    padding-bottom: 6px;
    flex-shrink: 0;
    position: sticky;
    top: 0;
    z-index: 2;
    background: var(--input-bg, rgba(0, 0, 0, 0.04));
    backdrop-filter: blur(8px);
  }
  .dw-scrollable {
    flex: 1;
    overflow-y: auto;
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    scrollbar-width: thin;
  }
  .dw-pt-container {
    padding: 4px 8px;
    container-type: inline-size;
    cursor: pointer;
  }
  .dw-selected-els {
    padding: 2px 12px 4px;
    font-size: 10px; color: #10b981; font-weight: 500;
  }

  /* Groups */
  .dw-group {
    padding: 8px 10px; border: 2px solid var(--dialog-border, rgba(0,0,0,0.06));
    border-radius: 8px; background: var(--input-bg, rgba(0,0,0,0.02));
    cursor: pointer; transition: all 0.15s;
  }
  .dw-group.active {
    border-color: #10b981;
    background: rgba(5, 150, 105, 0.08);
    box-shadow: 0 0 0 1px rgba(5, 150, 105, 0.2), inset 0 0 0 1px rgba(5, 150, 105, 0.1);
  }
  .dw-group-header {
    display: flex; align-items: center; gap: 6px;
  }
  .dw-group.active .dw-group-header { margin-bottom: 6px; }
  .dw-group-title {
    font-size: 11px; font-weight: 700; color: #64748b; text-transform: uppercase;
    flex-shrink: 0;
  }
  .dw-group.active .dw-group-title { color: #10b981; }
  .dw-group-summary {
    flex: 1; font-size: 10px; color: #475569;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .dw-group-body { /* expanded content of active group */ }
  .dw-group-remove {
    background: none; border: none; color: #475569; cursor: pointer; font-size: 14px; padding: 0 4px;
  }
  .dw-group-remove:hover { color: #ef4444; }
  .dw-group-mode { display: flex; gap: 12px; font-size: 11px; color: #94a3b8; margin-bottom: 4px; }
  .dw-group-mode label { display: flex; align-items: center; gap: 4px; cursor: pointer; }
  .dw-select {
    width: 100%; padding: 4px 8px; border-radius: 4px; font-size: 11px; font-family: inherit;
    background: var(--input-bg, rgba(0,0,0,0.03)); border: 1px solid var(--dialog-border, rgba(0,0,0,0.1)); color: inherit;
  }
  .dw-hint { font-size: 10px; color: #64748b; margin: 2px 0; }
  .dw-hint-action { color: #94a3b8; font-style: italic; }
  .dw-small-btn {
    padding: 3px 10px; border-radius: 4px; font-size: 10px; font-family: inherit;
    background: rgba(59,130,246,0.1); border: 1px solid rgba(59,130,246,0.2);
    color: #60a5fa; cursor: pointer; margin-top: 2px;
  }
  .dw-small-btn.danger {
    background: rgba(239,68,68,0.1); border-color: rgba(239,68,68,0.2); color: #f87171;
  }
  .dw-small-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .dw-chips { display: flex; flex-wrap: wrap; gap: 3px; margin-top: 4px; }
  .dw-chip {
    display: inline-flex; align-items: center; gap: 3px;
    padding: 2px 6px; background: rgba(5,150,105,0.15);
    border: 1px solid rgba(5,150,105,0.3); border-radius: 4px;
    font-size: 10px; font-weight: 600; color: #10b981;
  }
  .dw-chip button {
    background: none; border: none; color: #64748b; cursor: pointer; font-size: 11px; padding: 0;
  }
  .dw-chip button:hover { color: #ef4444; }
  .dw-add-group {
    padding: 6px; border: 1px dashed rgba(5,150,105,0.3); border-radius: 5px;
    background: transparent; color: #10b981; font-size: 10px; font-weight: 500;
    cursor: pointer; font-family: inherit;
  }
  .dw-add-group:hover { background: rgba(5,150,105,0.06); }

  /* Config */
  .dw-config {
    padding: 6px 0;
    border-top: 1px solid var(--dialog-border, rgba(0,0,0,0.04));
  }
  .dw-config-row { display: flex; align-items: center; justify-content: space-between; font-size: 11px; color: #94a3b8; }
  .dw-num-input {
    width: 70px; padding: 3px 6px; border-radius: 4px; font-size: 11px;
    background: var(--input-bg, rgba(0,0,0,0.03)); border: 1px solid var(--dialog-border, rgba(0,0,0,0.1)); color: inherit;
    font-family: inherit;
  }
  .dw-combo-count { font-size: 11px; color: #f59e0b; font-weight: 500; margin-top: 4px; text-align: center; }
  .dw-error { font-size: 10px; color: #ef4444; margin-top: 4px; padding: 4px 8px; background: rgba(239,68,68,0.1); border-radius: 4px; }

  /* Right panel */
  .dw-right {
    flex: 1; position: relative; min-width: 0;
    --struct-height: 100%;
    --struct-width: 100%;
  }
  .dw-loading {
    display: flex; align-items: center; justify-content: center;
    height: 100%; color: #64748b;
  }

  /* ─── Variants section (in left panel) ─── */
  .dw-variants-section {
    border-top: 2px solid rgba(59, 130, 246, 0.2);
    margin-top: 4px;
    padding-top: 2px;
    background: rgba(59, 130, 246, 0.03);
    border-radius: 6px;
  }
  .dw-variants-header {
    display: flex;
    align-items: center;
    padding: 6px 8px 4px;
  }
  .dw-variants-title {
    font-size: 10px;
    font-weight: 700;
    color: #60a5fa;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .dw-variants-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 0 6px 6px;
    max-height: 280px;
    overflow-y: auto;
    scrollbar-width: thin;
  }
  .dw-variant-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 8px;
    border-radius: 5px;
    border: 1px solid transparent;
    background: var(--input-bg, rgba(0,0,0,0.02));
    color: #78859b;
    font-size: 10px;
    font-family: inherit;
    cursor: pointer;
    transition: all 0.12s;
    text-align: left;
    width: 100%;
    flex-shrink: 0;
  }
  .dw-variant-item:hover {
    background: rgba(59, 130, 246, 0.08);
    color: #e2e8f0;
  }
  .dw-variant-item.active {
    background: rgba(59, 130, 246, 0.15);
    border-color: rgba(59, 130, 246, 0.4);
    color: #60a5fa;
    font-weight: 600;
  }
  .dw-variant-original {
    font-style: italic;
    color: #64748b;
    border-bottom: 1px solid var(--dialog-border, rgba(0,0,0,0.04));
    margin-bottom: 2px;
    padding-bottom: 6px;
  }
  .dw-variant-num {
    width: 20px; height: 20px;
    display: flex; align-items: center; justify-content: center;
    border-radius: 4px;
    background: rgba(59, 130, 246, 0.1);
    font-size: 9px; font-weight: 700;
    flex-shrink: 0;
    color: #60a5fa;
  }
  .dw-variant-item.active .dw-variant-num {
    background: rgba(59, 130, 246, 0.25);
  }
  .dw-variant-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }
</style>

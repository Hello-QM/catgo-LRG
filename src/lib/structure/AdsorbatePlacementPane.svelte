<script lang="ts">
  import type { Crystal, PymatgenStructure, AnyStructure, Vec3 } from '$lib/structure'
  import { DraggablePane } from '$lib'
  import type { ComponentProps } from 'svelte'
  import type { AdsorptionSite } from './ferrox-wasm-types'
  import {
    ADSORBATE_PRESETS, ADSORBATE_PRESET_GROUPS,
    type AdsorbatePreset,
    preset_to_structure,
    place_adsorbate_local,
  } from '$lib/api/adsorbate'
  import { optimize_structure_uff, is_ok } from './ferrox-wasm'
  import {
    optimizeStructure,
    type CalculatorType,
    type OptimizationConfig,
  } from '$lib/api/compute'
  import {
    search_pubchem_compounds,
    fetch_pubchem_compound,
    extract_atoms_from_pubchem,
  } from '$lib/api/pubchem'
  import { atomic_number_to_symbol } from '$lib/composition/parse'
  import { SERVER_URL } from '$lib/api/config'
  // PymatgenMolecule no longer needed — preview uses PymatgenStructure with fake lattice
  import { DEFAULTS } from '$lib/settings'
  import { Canvas } from '@threlte/core'
  import { SvelteMap } from 'svelte/reactivity'
  import StructureScene from './StructureScene.svelte'

  let {
    structure = $bindable(),
    pane_open = $bindable(false),
    adsorption_sites = [],
    placement_mode_active = $bindable(false),
    on_push_undo,
    on_structure_change,
    on_placement_mode_change,
    on_open_optimizer,
    last_placed_adsorbate_indices = $bindable<number[]>([]),
    server_url = SERVER_URL,
    embedded = false,
    pane_props = {},
    toggle_props = {},
  }: {
    structure?: AnyStructure
    pane_open?: boolean
    adsorption_sites?: AdsorptionSite[]
    placement_mode_active?: boolean
    on_push_undo?: () => void
    on_structure_change?: (structure: AnyStructure) => void
    on_placement_mode_change?: (active: boolean) => void
    on_open_optimizer?: (mobile_indices: number[]) => void
    last_placed_adsorbate_indices?: number[]
    server_url?: string
    embedded?: boolean
    pane_props?: ComponentProps<typeof DraggablePane>[`pane_props`]
    toggle_props?: ComponentProps<typeof DraggablePane>[`toggle_props`]
  } = $props()

  // Adsorbate source type
  type SourceType = 'preset' | 'xyz' | 'pubchem'
  let source_type = $state<SourceType>('preset')

  // Preset state
  let selected_preset_idx = $state(0)

  // Custom XYZ state
  let xyz_text = $state(`C 0.000 0.000 0.000\nO 0.000 0.000 1.128`)
  let xyz_parse_error = $state<string | null>(null)

  // PubChem state
  let pubchem_query = $state(``)
  let pubchem_searching = $state(false)
  let pubchem_results = $state<{ cid: number; formula: string; name?: string }[]>([])
  let pubchem_selected_cid = $state<number | null>(null)
  let pubchem_loading = $state(false)
  let pubchem_error = $state<string | null>(null)

  // Common state for all source types
  // Unified atom list: the "active adsorbate" regardless of source
  type AdsorbateAtom = { symbol: string; position: [number, number, number] }
  let custom_atoms = $state<AdsorbateAtom[]>([])
  let binding_atom_indices = $state<number[]>([0])
  let height_offset = $state(0.0)
  let auto_rotate = $state(true)

  // Force field selection for quick optimize
  type ForceFieldOption = 'uff' | CalculatorType
  let selected_ff = $state<ForceFieldOption>('uff')

  // Status
  let is_placing = $state(false)
  let is_optimizing = $state(false)
  let error_message = $state<string | null>(null)
  let success_message = $state<string | null>(null)

  // Derive the active atom list based on source type
  let active_atoms = $derived.by((): AdsorbateAtom[] => {
    if (source_type === `preset`) {
      const preset = ADSORBATE_PRESETS[selected_preset_idx]
      return preset ? preset.atoms.map((a) => ({ symbol: a.symbol, position: a.position })) : []
    }
    // For xyz and pubchem, use custom_atoms
    return custom_atoms
  })

  // Reset binding atoms when source or preset changes
  $effect(() => {
    if (source_type === `preset`) {
      const preset = ADSORBATE_PRESETS[selected_preset_idx]
      if (preset) binding_atom_indices = [preset.default_binding_index]
    } else {
      // For custom sources, filter out invalid indices
      const valid = binding_atom_indices.filter((i) => i < custom_atoms.length)
      if (valid.length === 0 && custom_atoms.length > 0) {
        binding_atom_indices = [0]
      } else if (valid.length !== binding_atom_indices.length) {
        binding_atom_indices = valid
      }
    }
  })

  // Parse XYZ text into atoms whenever it changes
  $effect(() => {
    if (source_type !== `xyz`) return
    const result = parse_xyz_text(xyz_text)
    if (result.error) {
      xyz_parse_error = result.error
      custom_atoms = []
    } else {
      xyz_parse_error = null
      custom_atoms = result.atoms
    }
  })

  function parse_xyz_text(text: string): { atoms: AdsorbateAtom[]; error: string | null } {
    const lines = text.trim().split(`\n`).filter((l) => l.trim())
    if (lines.length === 0) return { atoms: [], error: `No atoms defined` }

    const atoms: AdsorbateAtom[] = []
    for (let i = 0; i < lines.length; i++) {
      const parts = lines[i].trim().split(/\s+/)
      if (parts.length < 4) {
        return { atoms: [], error: `Line ${i + 1}: need "Element x y z"` }
      }
      const [symbol, xs, ys, zs] = parts
      const x = parseFloat(xs)
      const y = parseFloat(ys)
      const z = parseFloat(zs)
      if (!symbol.match(/^[A-Z][a-z]?$/) || isNaN(x) || isNaN(y) || isNaN(z)) {
        return { atoms: [], error: `Line ${i + 1}: invalid format` }
      }
      atoms.push({ symbol, position: [x, y, z] })
    }
    return { atoms, error: null }
  }

  // PubChem search
  let search_timer: ReturnType<typeof setTimeout> | null = null

  function on_pubchem_input() {
    if (search_timer) clearTimeout(search_timer)
    pubchem_error = null
    if (!pubchem_query.trim()) {
      pubchem_results = []
      return
    }
    search_timer = setTimeout(do_pubchem_search, 400)
  }

  async function do_pubchem_search() {
    if (!pubchem_query.trim()) return
    pubchem_searching = true
    pubchem_error = null
    try {
      const resp = await search_pubchem_compounds(pubchem_query.trim())
      pubchem_results = resp.compounds.slice(0, 8)
    } catch (err) {
      pubchem_error = err instanceof Error ? err.message : String(err)
      pubchem_results = []
    } finally {
      pubchem_searching = false
    }
  }

  async function select_pubchem_compound(cid: number) {
    pubchem_selected_cid = cid
    pubchem_loading = true
    pubchem_error = null
    try {
      const compound = await fetch_pubchem_compound(cid)
      if (!compound) {
        pubchem_error = `No 3D structure available for CID ${cid}`
        return
      }
      const { atoms } = extract_atoms_from_pubchem(compound)
      if (atoms.length === 0) {
        pubchem_error = `No atoms in PubChem compound`
        return
      }
      custom_atoms = atoms.map((a) => ({
        symbol: atomic_number_to_symbol[a.number] || `X`,
        position: [a.x, a.y, a.z] as [number, number, number],
      }))
      binding_atom_indices = [0]
    } catch (err) {
      pubchem_error = err instanceof Error ? err.message : String(err)
    } finally {
      pubchem_loading = false
    }
  }

  /** Build a PymatgenStructure from the active atom list. */
  function atoms_to_structure(atoms: AdsorbateAtom[]): PymatgenStructure {
    return {
      sites: atoms.map((atom) => ({
        species: [{ element: atom.symbol, occu: 1, oxidation_state: 0 }],
        abc: atom.position as [number, number, number],
        xyz: atom.position as [number, number, number],
        label: atom.symbol,
        properties: {},
      })),
      lattice: {
        matrix: [[10, 0, 0], [0, 10, 0], [0, 0, 10]],
        pbc: [false, false, false],
        a: 10, b: 10, c: 10,
        alpha: 90, beta: 90, gamma: 90,
        volume: 1000,
      },
    } as PymatgenStructure
  }

  function toggle_placement_mode() {
    placement_mode_active = !placement_mode_active
    on_placement_mode_change?.(placement_mode_active)
  }

  /** Called when a site is clicked in the 3D scene during placement mode. */
  export async function handle_site_click(site: AdsorptionSite) {
    if (!structure || is_placing || active_atoms.length === 0) return

    is_placing = true
    error_message = null
    success_message = null

    try {
      const slab = structure as PymatgenStructure
      const atoms = source_type === `preset`
        ? ADSORBATE_PRESETS[selected_preset_idx].atoms.map((a) => ({ symbol: a.symbol, position: a.position }))
        : active_atoms

      const result = place_adsorbate_local(
        slab,
        atoms,
        binding_atom_indices,
        site.position,
        site.normal,
        height_offset,
        auto_rotate,
      )

      on_push_undo?.()
      on_structure_change?.(result.structure)
      last_placed_adsorbate_indices = result.adsorbate_indices
      success_message = result.message

      // Auto-disable placement mode after placing
      placement_mode_active = false
      on_placement_mode_change?.(false)
    } catch (err) {
      error_message = err instanceof Error ? err.message : String(err)
    } finally {
      is_placing = false
    }
  }

  const FF_LABELS: Record<ForceFieldOption, string> = {
    uff: `UFF (local)`,
    emt: `EMT`,
    xtb: `xTB`,
    mace: `MACE`,
    chgnet: `CHGNet`,
    m3gnet: `M3GNet`,
  }

  async function quick_optimize() {
    if (!structure || last_placed_adsorbate_indices.length === 0) return

    is_optimizing = true
    error_message = null

    try {
      if (selected_ff === `uff`) {
        // Local WASM UFF
        const result = await optimize_structure_uff(structure as any, {
          max_steps: 50,
          fmax: 0.5,
          mobile_indices: last_placed_adsorbate_indices,
        })

        if (is_ok(result)) {
          on_push_undo?.()
          on_structure_change?.(result.ok.structure as unknown as AnyStructure)
          success_message = `UFF optimization complete`
        } else {
          error_message = `UFF optimization failed`
        }
      } else {
        // Server-side calculator
        const config: OptimizationConfig = {
          calculator: selected_ff,
          fmax: 0.5,
          steps: 50,
          optimize_cell: false,
          mobile_indices: last_placed_adsorbate_indices,
        }

        const result = await optimizeStructure(structure as AnyStructure, config)

        if (result.success && result.structure) {
          on_push_undo?.()
          on_structure_change?.(result.structure)
          success_message = `${FF_LABELS[selected_ff]} optimization complete`
        } else {
          error_message = result.message || `${FF_LABELS[selected_ff]} optimization failed`
        }
      }
    } catch (err) {
      error_message = err instanceof Error ? err.message : String(err)
    } finally {
      is_optimizing = false
    }
  }

  let can_place = $derived(active_atoms.length > 0 && adsorption_sites.length > 0)

  // Preview molecule for 3D visualization (no lattice → no unit cell box)
  let preview_molecule = $derived.by(() => {
    if (active_atoms.length === 0) return null
    return {
      sites: active_atoms.map((atom) => ({
        species: [{ element: atom.symbol, occu: 1, oxidation_state: 0 }],
        abc: atom.position,
        xyz: atom.position,
        label: atom.symbol,
        properties: {},
      })) as any,
    }
  })

  // Preview scene state
  let preview_width = $state(0)
  let preview_height = $state(0)
  let preview_selected = $state<number[]>([])
  let preview_hidden: any = $state(new Set<string>())
  // Destructure out keys from DEFAULTS.structure that are not StructureScene props
  const {
    show_image_atoms: _a,
    atom_color_mode: _b,
    atom_color_scale: _c,
    atom_color_scale_type: _d,
    show_gizmo: _e,
    show_cell: _f,
    show_cell_vectors: _g,
    cell_edge_opacity: _h,
    cell_surface_opacity: _i,
    cell_edge_color: _j,
    cell_surface_color: _k,
    cell_edge_width: _l,
    fullscreen_toggle: _m,
    keyboard_movement_step: _n,
    frozen_atom_indicator: _o,
    force_shaft_radius: _p,
    force_arrow_head_radius: _q,
    force_arrow_head_length: _r,
    ...preview_scene_defaults
  } = DEFAULTS.structure
  let preview_scene_props = {
    ...preview_scene_defaults,
    auto_rotate: 0,
    rotation_damping: 0,
    camera_position: [0, 0, 0] as [number, number, number],
    show_cell: false,
    show_cell_vectors: false,
    show_gizmo: false,
  }
  let preview_site_radii = new SvelteMap<number, number>()
</script>

{#snippet pane_content()}
  <h4>Adsorbate Placement</h4>

  {#if adsorption_sites.length === 0}
    <div class="hint">Find adsorption sites first to enable placement.</div>
  {:else}
    <!-- Source type tabs -->
    <div class="source-tabs">
      <button
        type="button"
        class="tab"
        class:active={source_type === 'preset'}
        onclick={() => (source_type = 'preset')}
      >Preset</button>
      <button
        type="button"
        class="tab"
        class:active={source_type === 'xyz'}
        onclick={() => (source_type = 'xyz')}
      >Custom XYZ</button>
      <button
        type="button"
        class="tab"
        class:active={source_type === 'pubchem'}
        onclick={() => (source_type = 'pubchem')}
      >PubChem</button>
    </div>

    <!-- Preset source -->
    {#if source_type === 'preset'}
      <div class="section">
        <select bind:value={selected_preset_idx}>
          {#each ADSORBATE_PRESET_GROUPS as group}
            <optgroup label={group.label}>
              {#each group.presets as preset}
                {@const flat_idx = ADSORBATE_PRESETS.indexOf(preset)}
                <option value={flat_idx}>{preset.display_formula ?? preset.formula} — {preset.name}</option>
              {/each}
            </optgroup>
          {/each}
        </select>
      </div>

    <!-- Custom XYZ source -->
    {:else if source_type === 'xyz'}
      <div class="section">
        <label class="section-label">
          Atoms (one per line: Element x y z)
        </label>
        <textarea
          class="xyz-input"
          bind:value={xyz_text}
          rows={4}
          spellcheck="false"
          placeholder="C 0.000 0.000 0.000&#10;O 0.000 0.000 1.128"
        ></textarea>
        {#if xyz_parse_error}
          <div class="parse-error">{xyz_parse_error}</div>
        {:else if custom_atoms.length > 0}
          <div class="parse-ok">{custom_atoms.length} atom{custom_atoms.length > 1 ? `s` : ``} parsed</div>
        {/if}
      </div>

    <!-- PubChem source -->
    {:else if source_type === 'pubchem'}
      <div class="section">
        <label class="section-label">Search by name or formula</label>
        <input
          type="text"
          class="pubchem-input"
          bind:value={pubchem_query}
          oninput={on_pubchem_input}
          placeholder="e.g. ethanol, CH3OH, aspirin..."
        />
        {#if pubchem_searching}
          <div class="hint">Searching...</div>
        {/if}
        {#if pubchem_error}
          <div class="parse-error">{pubchem_error}</div>
        {/if}
        {#if pubchem_results.length > 0}
          <div class="pubchem-results">
            {#each pubchem_results as compound}
              <button
                type="button"
                class="pubchem-item"
                class:selected={pubchem_selected_cid === compound.cid}
                class:loading={pubchem_loading && pubchem_selected_cid === compound.cid}
                onclick={() => select_pubchem_compound(compound.cid)}
                disabled={pubchem_loading}
              >
                <span class="formula">{compound.formula}</span>
                {#if compound.name}
                  <span class="name">{compound.name}</span>
                {/if}
              </button>
            {/each}
          </div>
        {/if}
        {#if custom_atoms.length > 0 && source_type === 'pubchem'}
          <div class="parse-ok">
            Loaded: {custom_atoms.length} atoms
            ({[...new Set(custom_atoms.map((a) => a.symbol))].join(`, `)})
          </div>
        {/if}
      </div>
    {/if}

    <!-- Molecule preview -->
    {#if preview_molecule && preview_molecule.sites.length > 0}
      <div
        class="preview-container"
        bind:clientWidth={preview_width}
        bind:clientHeight={preview_height}
      >
        {#if typeof WebGLRenderingContext !== 'undefined'}
          <Canvas {...{rendererParameters: { alpha: true }} as any}>
            <StructureScene
              structure={preview_molecule}
              {...preview_scene_props}
              site_radius_overrides={preview_site_radii}
              width={preview_width}
              height={preview_height}
              show_site_indices={true}
              active_sites={binding_atom_indices}
              active_highlight_color="#ff6b35"
              bind:selected_sites={preview_selected}
              bind:hidden_elements={preview_hidden}
            />
          </Canvas>
        {/if}
      </div>
    {/if}

    <!-- Binding atom selector (for all sources with >1 atom) -->
    {#if active_atoms.length > 1}
      <div class="section">
        <label class="section-label">
          Binding atom{binding_atom_indices.length > 1 ? `s (multi-dentate)` : ``}
          <span class="dentate-hint">click to toggle, multi-select for polydentate</span>
        </label>
        <div class="atom-badges">
          {#each active_atoms as atom, idx}
            <button
              type="button"
              class="atom-badge"
              class:selected={binding_atom_indices.includes(idx)}
              onclick={() => {
                if (binding_atom_indices.includes(idx)) {
                  // Deselect, but keep at least one
                  if (binding_atom_indices.length > 1) {
                    binding_atom_indices = binding_atom_indices.filter((i) => i !== idx)
                  }
                } else {
                  binding_atom_indices = [...binding_atom_indices, idx]
                }
              }}
              title={`${atom.symbol} (#${idx + 1})${binding_atom_indices.includes(idx) ? ` — binding` : ``}`}
            >
              {atom.symbol}<sub>{idx + 1}</sub>
            </button>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Controls -->
    <div class="section controls-row">
      <label class="height-label">
        <span>Height offset (Å)</span>
        <input
          type="range"
          min={-2}
          max={5}
          step={0.1}
          bind:value={height_offset}
        />
        <span class="val">{height_offset.toFixed(1)}</span>
      </label>
      <label class="checkbox-label">
        <input type="checkbox" bind:checked={auto_rotate} />
        Auto-rotate
      </label>
    </div>

    <!-- Place button -->
    <div class="section">
      <button
        type="button"
        class="place-btn"
        class:active={placement_mode_active}
        onclick={toggle_placement_mode}
        disabled={is_placing || !can_place}
      >
        {#if is_placing}
          Placing...
        {:else if placement_mode_active}
          Click a site to place (ESC to cancel)
        {:else}
          Enable placement mode
        {/if}
      </button>
    </div>

    {#if error_message}
      <div class="error">{error_message}</div>
    {/if}

    {#if success_message}
      <div class="success">{success_message}</div>
    {/if}

    <!-- Post-placement actions -->
    {#if last_placed_adsorbate_indices.length > 0}
      <div class="section post-placement">
        <label class="section-label">Post-placement</label>
        <div class="ff-row">
          <select class="ff-select" bind:value={selected_ff}>
            {#each Object.entries(FF_LABELS) as [key, label]}
              <option value={key}>{label}</option>
            {/each}
          </select>
          <button
            type="button"
            class="optimize-btn"
            onclick={quick_optimize}
            disabled={is_optimizing}
          >
            {is_optimizing ? `Optimizing...` : `Quick Optimize`}
          </button>
          {#if on_open_optimizer}
            <button
              type="button"
              class="optimize-btn full"
              onclick={() => on_open_optimizer?.(last_placed_adsorbate_indices)}
            >
              Full Optimize...
            </button>
          {/if}
        </div>
        <div class="hint">
          {last_placed_adsorbate_indices.length} adsorbate atom{last_placed_adsorbate_indices.length > 1 ? `s` : ``} placed
          (indices {last_placed_adsorbate_indices.join(`, `)}) — only adsorbate moves
        </div>
      </div>
    {/if}
  {/if}
{/snippet}

{#if !embedded}
  <DraggablePane
    bind:show={pane_open}
    open_icon="Cross"
    closed_icon="Atom"
    show_toggle={!embedded}
    pane_props={{ ...pane_props, class: `adsorbate-placement-pane ${pane_props?.class ?? ``}` }}
    toggle_props={{
      title: pane_open ? `` : `Place Adsorbate`,
      ...toggle_props,
      class: `adsorbate-placement-toggle ${toggle_props?.class ?? ``}`,
    }}
  >
    {@render pane_content()}
  </DraggablePane>
{:else}
  {@render pane_content()}
{/if}

<style>
  h4 {
    margin: 0 0 8px;
  }

  .section {
    margin-bottom: 8px;
  }

  select, .pubchem-input {
    width: 100%;
    padding: 4px 6px;
  }

  /* Source type tabs */
  .source-tabs {
    display: flex;
    gap: 2px;
    margin-bottom: 8px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.15);
    padding-bottom: 4px;
  }

  .tab {
    padding: 4px 8px;
    border: 1px solid transparent;
    border-radius: 4px 4px 0 0;
    background: transparent;
    color: var(--text-color, white);
    cursor: pointer;
    font-size: 0.85em;
  }

  .tab:hover {
    background: var(--btn-bg-hover, rgba(255, 255, 255, 0.15));
  }

  .tab.active {
    color: white;
    background: var(--accent-color, #007acc);
    font-weight: 500;
  }

  /* XYZ textarea */
  .xyz-input {
    width: 100%;
    font-family: monospace;
    font-size: 0.85em;
    padding: 4px 6px;
    resize: vertical;
    min-height: 60px;
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 4px;
    background: rgba(0, 0, 0, 0.2);
    color: inherit;
  }

  .parse-error {
    color: #ef4444;
    font-size: 0.85em;
    margin-top: 2px;
  }

  .parse-ok {
    color: var(--success-color, #22c55e);
    font-size: 0.85em;
    margin-top: 2px;
  }

  /* PubChem results */
  .pubchem-results {
    max-height: 150px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-top: 4px;
  }

  .pubchem-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 6px;
    background: var(--btn-bg, rgba(255, 255, 255, 0.1));
    border: 1px solid transparent;
    border-radius: 4px;
    cursor: pointer;
    text-align: left;
  }

  .pubchem-item:hover:not(:disabled) {
    background: var(--btn-bg-hover, rgba(255, 255, 255, 0.15));
  }

  .pubchem-item.selected {
    border-color: var(--accent-color, #007acc);
    background: rgba(0, 122, 204, 0.15);
  }

  .pubchem-item.loading {
    opacity: 0.6;
  }

  .pubchem-item .formula {
    font-weight: 500;
    min-width: 50px;
  }

  .pubchem-item .name {
    opacity: 0.6;
    font-size: 0.85em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Molecule preview */
  .preview-container {
    width: 100%;
    height: 200px;
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 4px;
    overflow: hidden;
    margin-bottom: 8px;
    background: rgba(0, 0, 0, 0.3);
    position: relative;
  }

  :global(.preview-container canvas) {
    position: absolute !important;
    top: 0;
    left: 0;
    width: 100% !important;
    height: 100% !important;
  }

  .dentate-hint {
    display: block;
    font-size: 0.8em;
    opacity: 0.5;
    font-weight: normal;
  }

  /* Atom badges */
  .atom-badges {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }

  .atom-badge {
    padding: 3px 8px;
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 4px;
    background: var(--btn-bg, rgba(255, 255, 255, 0.1));
    cursor: pointer;
    font-weight: 500;
  }

  .atom-badge:hover {
    background: var(--btn-bg-hover, rgba(255, 255, 255, 0.15));
  }

  .atom-badge.selected {
    border-color: var(--accent-color, #007acc);
    background: rgba(0, 122, 204, 0.15);
    color: var(--accent-color, #007acc);
  }

  .controls-row {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .height-label {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .height-label span:first-child {
    opacity: 0.6;
    font-size: 0.85em;
    min-width: 90px;
  }

  .height-label input[type='range'] {
    flex: 1;
  }

  .height-label .val {
    min-width: 30px;
    text-align: right;
    font-family: monospace;
  }

  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
  }

  .place-btn {
    width: 100%;
    padding: 6px 10px;
    border: 1px solid var(--accent-color, #007acc);
    border-radius: 4px;
    background: transparent;
    color: var(--accent-color, #007acc);
    cursor: pointer;
    font-weight: 500;
  }

  .place-btn:hover:not(:disabled) {
    background: rgba(0, 122, 204, 0.1);
  }

  .place-btn.active {
    background: var(--accent-color, #007acc);
    color: white;
    animation: pulse-border 1.5s infinite;
  }

  .place-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  @keyframes pulse-border {
    0%, 100% {
      box-shadow: 0 0 0 0 rgba(0, 122, 204, 0.4);
    }
    50% {
      box-shadow: 0 0 0 4px rgba(0, 122, 204, 0);
    }
  }

  .error {
    margin: 4px 0;
    padding: 4px 6px;
    background: rgba(239, 68, 68, 0.1);
    border-radius: 4px;
    color: #ef4444;
  }

  .success {
    margin: 4px 0;
    padding: 4px 6px;
    background: rgba(34, 197, 94, 0.1);
    border-radius: 4px;
    color: var(--success-color, #22c55e);
  }

  .post-placement {
    border-top: 1px solid rgba(255, 255, 255, 0.15);
    padding-top: 8px;
  }

  .ff-row {
    display: flex;
    gap: 4px;
    margin-bottom: 4px;
    align-items: center;
  }

  .ff-select {
    width: auto;
    min-width: 90px;
    padding: 4px 6px;
    font-size: 0.85em;
  }

  .optimize-btn {
    padding: 4px 10px;
    border: 1px solid var(--success-color, #22c55e);
    border-radius: 4px;
    background: transparent;
    color: var(--success-color, #22c55e);
    cursor: pointer;
  }

  .optimize-btn:hover:not(:disabled) {
    background: rgba(34, 197, 94, 0.1);
  }

  .optimize-btn.full {
    border-color: var(--accent-color, #007acc);
    color: var(--accent-color, #007acc);
  }

  .optimize-btn.full:hover:not(:disabled) {
    background: rgba(0, 122, 204, 0.1);
  }

  .optimize-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>

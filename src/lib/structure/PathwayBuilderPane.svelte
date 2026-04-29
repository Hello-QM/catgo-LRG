<script lang="ts">
  import type { ElementSymbol } from '$lib'
  import type { PymatgenStructure, AnyStructure } from '$lib/structure'
  import { delete_atoms } from '$lib/structure/atom-manipulation'
  import type { TrajectoryType, TrajectoryFrame } from '$lib/trajectory'
  import type { AnchoredAtom, PathwayStep, ReactionPathway, PathwayPreset } from './pathway-types'
  import { PATHWAY_PRESETS } from './pathway-presets'
  import { apply_adsorbates_to_surface, capture_adsorbate_atoms, generate_pathway_trajectory } from './pathway-builder'

  let {
    structure = $bindable<PymatgenStructure | undefined>(),
    selected_sites = [],
    on_push_undo,
    on_trajectory_created,
  }: {
    structure?: PymatgenStructure
    selected_sites?: number[]
    on_push_undo?: () => void
    on_trajectory_created?: (traj: TrajectoryType) => void
  } = $props()

  // --- Surfaces ---
  let surfaces = $state<AnyStructure[]>([])
  let surfaces_loaded = $derived(surfaces.length > 0)

  function use_current_surface() {
    if (!structure) return
    surfaces = [{ ...structure }]
    n_surface_atoms = structure.sites.length
  }

  function reset_surfaces() {
    surfaces = []
    n_surface_atoms = 0
  }

  function load_surfaces_from_trajectory(traj: TrajectoryType) {
    surfaces = traj.frames.map((f) => f.structure)
    if (surfaces.length > 0) {
      n_surface_atoms = surfaces[0].sites.length
    }
  }

  // --- Pathways ---
  let pathways = $state<ReactionPathway[]>([])
  let active_pathway_idx = $state(0)
  let active_pathway = $derived(pathways[active_pathway_idx])
  let next_pathway_id = $state(1)

  function add_empty_pathway() {
    const id = `pathway_${next_pathway_id++}`
    pathways = [
      ...pathways,
      {
        id,
        name: `Pathway ${pathways.length + 1}`,
        steps: [{ id: `${id}_s0`, name: `*`, adsorbate_atoms: [] }],
      },
    ]
    active_pathway_idx = pathways.length - 1
  }

  function load_preset(preset: PathwayPreset) {
    const id = `preset_${preset.id}_${next_pathway_id++}`
    const steps: PathwayStep[] = preset.steps.map((s, i) => ({
      id: `${id}_s${i}`,
      name: s.name,
      description: s.description,
      adsorbate_atoms: [],
    }))
    pathways = [...pathways, { id, name: preset.name, steps }]
    active_pathway_idx = pathways.length - 1
  }

  function remove_pathway(idx: number) {
    pathways = pathways.filter((_, i) => i !== idx)
    if (active_pathway_idx >= pathways.length) {
      active_pathway_idx = Math.max(0, pathways.length - 1)
    }
  }

  // --- Steps ---
  let active_step_idx = $state(0)
  let active_step = $derived(active_pathway?.steps[active_step_idx])

  function add_step() {
    if (!active_pathway) return
    const id = `${active_pathway.id}_s${active_pathway.steps.length}`
    active_pathway.steps = [
      ...active_pathway.steps,
      { id, name: `Step ${active_pathway.steps.length}`, adsorbate_atoms: [] },
    ]
    pathways = [...pathways] // trigger reactivity
    active_step_idx = active_pathway.steps.length - 1
  }

  function remove_step(idx: number) {
    if (!active_pathway) return
    active_pathway.steps = active_pathway.steps.filter((_, i) => i !== idx)
    pathways = [...pathways]
    if (active_step_idx >= active_pathway.steps.length) {
      active_step_idx = Math.max(0, active_pathway.steps.length - 1)
    }
  }

  // --- Build Mode ---
  let n_surface_atoms = $state(0)
  let building = $state(false)
  let building_step_idx = $state(-1)
  let pre_build_structure: AnyStructure | null = null

  function enter_build_mode(step_idx: number) {
    if (!structure || !active_pathway) return

    // Ensure clean surface (remove any previous adsorbates)
    const clean = n_surface_atoms > 0 && structure.sites.length > n_surface_atoms
      ? delete_atoms(structure, Array.from({ length: structure.sites.length - n_surface_atoms }, (_, i) => n_surface_atoms + i))
      : structure

    // If step has saved adsorbates, apply them as starting point
    const step = active_pathway.steps[step_idx]
    if (step.adsorbate_atoms.length > 0) {
      const with_adsorbates = apply_adsorbates_to_surface(clean, step.adsorbate_atoms)
      on_push_undo?.()
      structure = with_adsorbates as PymatgenStructure
    } else {
      on_push_undo?.()
      structure = clean as PymatgenStructure
    }

    pre_build_structure = clean
    building = true
    building_step_idx = step_idx
  }

  function save_step() {
    if (!building || !structure || !active_pathway) return

    const atoms = capture_adsorbate_atoms(structure, n_surface_atoms)
    const step = active_pathway.steps[building_step_idx]
    if (step) {
      step.adsorbate_atoms = atoms
      step.name = step.name // keep user's name
      pathways = [...pathways]
    }

    // Restore clean surface
    if (pre_build_structure) {
      structure = pre_build_structure as PymatgenStructure
    }
    building = false
    building_step_idx = -1
    pre_build_structure = null
  }

  function cancel_build() {
    if (pre_build_structure) {
      structure = pre_build_structure as PymatgenStructure
    }
    building = false
    building_step_idx = -1
    pre_build_structure = null
  }

  // --- Generation ---
  let gen_error = $state(``)

  function generate() {
    if (surfaces.length === 0) {
      gen_error = `No surfaces loaded. Click "Use Current" or load a trajectory.`
      return
    }
    if (pathways.length === 0) {
      gen_error = `No pathways defined. Add a pathway or load a preset.`
      return
    }

    gen_error = ``
    try {
      const traj = generate_pathway_trajectory(surfaces, pathways)
      on_trajectory_created?.(traj)
    } catch (err) {
      gen_error = err instanceof Error ? err.message : String(err)
    }
  }

  // --- Preview ---
  let total_frames = $derived.by(() => {
    const n = Math.max(surfaces.length, 1)
    let total_steps = 0
    for (const p of pathways) total_steps += p.steps.length
    return n * total_steps
  })

  // --- Preset dropdown ---
  let show_preset_menu = $state(false)
  let preset_categories = $derived.by(() => {
    const cats = new Map<string, PathwayPreset[]>()
    for (const p of PATHWAY_PRESETS) {
      if (!cats.has(p.category)) cats.set(p.category, [])
      cats.get(p.category)!.push(p)
    }
    return cats
  })

  // --- Step name editing ---
  let editing_step_name = $state(-1)

  // --- Pathway name editing ---
  let editing_pathway_name = $state(-1)

  // Auto-init surfaces from current structure
  $effect(() => {
    if (structure && surfaces.length === 0) {
      n_surface_atoms = structure.sites.length
    }
  })
</script>

<div class="pathway-builder">
  <!-- Surfaces Section -->
  <section class="section">
    <h5>Surfaces</h5>
    {#if surfaces_loaded}
      <div class="info-row">
        <span>{surfaces.length} surface{surfaces.length > 1 ? `s` : ``} ({n_surface_atoms} atoms)</span>
        <button class="small" onclick={use_current_surface}>Recapture</button>
        <button class="small" onclick={reset_surfaces}>Clear</button>
      </div>
    {:else}
      <div class="info-row">
        <span class="muted">No surfaces loaded</span>
      </div>
      <div class="button-row">
        <button onclick={use_current_surface}>Use Current Structure</button>
      </div>
    {/if}
    <p class="hint">Load a trajectory of slab variants for multi-surface screening.</p>
  </section>

  <!-- Pathways Section -->
  <section class="section">
    <h5>Pathways</h5>
    {#if pathways.length > 0}
      <div class="pathway-tabs">
        {#each pathways as pw, idx}
          <div class="pathway-tab" class:active={idx === active_pathway_idx}>
            {#if editing_pathway_name === idx}
              <input
                type="text"
                bind:value={pw.name}
                onblur={() => { editing_pathway_name = -1; pathways = [...pathways] }}
                onkeydown={(e) => { if (e.key === `Enter`) editing_pathway_name = -1 }}
                class="name-input"
              />
            {:else}
              <button
                class="tab-btn"
                onclick={() => { active_pathway_idx = idx; active_step_idx = 0 }}
                ondblclick={() => editing_pathway_name = idx}
                title="Double-click to rename"
              >
                {pw.name}
                <span class="badge">{pw.steps.length}</span>
              </button>
            {/if}
            <button class="remove-btn" onclick={() => remove_pathway(idx)} title="Remove pathway">×</button>
          </div>
        {/each}
      </div>
    {/if}
    <div class="button-row">
      <button onclick={add_empty_pathway}>+ New</button>
      <div class="dropdown-wrapper">
        <button onclick={() => show_preset_menu = !show_preset_menu}>
          Presets ▾
        </button>
        {#if show_preset_menu}
          <div class="dropdown-menu">
            {#each preset_categories as [cat, presets]}
              <div class="dropdown-category">{cat}</div>
              {#each presets as preset}
                <button
                  class="dropdown-item"
                  onclick={() => { load_preset(preset); show_preset_menu = false }}
                >
                  {preset.name}
                </button>
              {/each}
            {/each}
          </div>
        {/if}
      </div>
    </div>
  </section>

  <!-- Steps Section (for active pathway) -->
  {#if active_pathway}
    <section class="section">
      <h5>Steps — {active_pathway.name}</h5>
      <div class="step-list">
        {#each active_pathway.steps as step, idx}
          <div class="step-row" class:active={idx === active_step_idx} class:building={building && building_step_idx === idx}>
            <button
              class="step-btn"
              onclick={() => { if (!building) active_step_idx = idx }}
              disabled={building}
            >
              {#if editing_step_name === idx}
                <input
                  type="text"
                  bind:value={step.name}
                  onblur={() => { editing_step_name = -1; pathways = [...pathways] }}
                  onkeydown={(e) => { if (e.key === `Enter`) editing_step_name = -1 }}
                  onclick={(e) => e.stopPropagation()}
                  class="name-input"
                />
              {:else}
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <span class="step-name" ondblclick={() => editing_step_name = idx}>
                  {step.name}
                </span>
              {/if}
              <span class="atom-count">
                {step.adsorbate_atoms.length > 0
                  ? `${step.adsorbate_atoms.length} atom${step.adsorbate_atoms.length > 1 ? `s` : ``}`
                  : step.name === `*` ? `clean` : `empty`}
              </span>
            </button>
            {#if !building && active_pathway.steps.length > 1}
              <button class="remove-btn" onclick={() => remove_step(idx)} title="Remove step">×</button>
            {/if}
          </div>
        {/each}
      </div>

      {#if !building}
        <div class="button-row">
          <button onclick={add_step}>+ Step</button>
          <button
            class="primary"
            onclick={() => enter_build_mode(active_step_idx)}
            disabled={!structure}
          >
            Build Step
          </button>
        </div>
      {:else}
        <div class="build-status">
          <span class="build-label">Building: {active_pathway.steps[building_step_idx]?.name}</span>
          <p class="hint">Add atoms in the 3D view, then save.</p>
          <div class="button-row">
            <button class="primary" onclick={save_step}>Save Step</button>
            <button onclick={cancel_build}>Cancel</button>
          </div>
        </div>
      {/if}
    </section>
  {/if}

  <!-- Generate Section -->
  <section class="section">
    <h5>Generate</h5>
    <div class="info-row">
      <span>
        {Math.max(surfaces.length, 1)} surface{surfaces.length > 1 ? `s` : ``}
        × {pathways.length} pathway{pathways.length > 1 ? `s` : ``}
        = {total_frames} frames
      </span>
    </div>
    {#if gen_error}
      <p class="error">{gen_error}</p>
    {/if}
    <button
      class="primary generate-btn"
      onclick={generate}
      disabled={pathways.length === 0 || building}
    >
      Generate Trajectory
    </button>
  </section>
</div>

<style>
  .pathway-builder {
    display: flex;
    flex-direction: column;
    gap: 0.5em;
    font-size: 0.85em;
  }

  .section {
    border-bottom: 1px solid rgba(128, 128, 128, 0.2);
    padding-bottom: 0.5em;
  }

  h5 {
    margin: 0 0 0.3em;
    font-size: 0.9em;
    font-weight: 600;
    color: var(--text-color, #333);
  }

  .info-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.5em;
  }

  .muted {
    color: #888;
    font-style: italic;
  }

  .hint {
    color: #888;
    font-size: 0.8em;
    margin: 0.2em 0 0;
  }

  .button-row {
    display: flex;
    gap: 0.4em;
    margin-top: 0.3em;
    flex-wrap: wrap;
  }

  button {
    padding: 0.25em 0.6em;
    border: 1px solid rgba(128, 128, 128, 0.3);
    border-radius: 4px;
    background: var(--bg-color, white);
    cursor: pointer;
    font-size: 0.85em;
  }

  button:hover:not(:disabled) {
    background: rgba(128, 128, 128, 0.1);
  }

  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  button.primary {
    background: var(--accent-color, #6366f1);
    color: white;
    border-color: transparent;
  }

  button.primary:hover:not(:disabled) {
    opacity: 0.9;
  }

  button.small {
    font-size: 0.75em;
    padding: 0.15em 0.4em;
  }

  /* Pathway tabs */
  .pathway-tabs {
    display: flex;
    flex-direction: column;
    gap: 0.2em;
  }

  .pathway-tab {
    display: flex;
    align-items: center;
    gap: 0.2em;
  }

  .pathway-tab .tab-btn {
    flex: 1;
    text-align: left;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .pathway-tab.active .tab-btn {
    background: rgba(99, 102, 241, 0.1);
    border-color: var(--accent-color, #6366f1);
  }

  .badge {
    background: rgba(128, 128, 128, 0.2);
    border-radius: 8px;
    padding: 0 0.4em;
    font-size: 0.8em;
    min-width: 1.2em;
    text-align: center;
  }

  .remove-btn {
    padding: 0.1em 0.35em;
    font-size: 0.9em;
    line-height: 1;
    color: #888;
    border: none;
    background: none;
  }

  .remove-btn:hover {
    color: #e55;
    background: rgba(255, 0, 0, 0.05) !important;
  }

  /* Steps */
  .step-list {
    display: flex;
    flex-direction: column;
    gap: 0.15em;
    max-height: 12em;
    overflow-y: auto;
  }

  .step-row {
    display: flex;
    align-items: center;
    gap: 0.2em;
  }

  .step-btn {
    flex: 1;
    display: flex;
    justify-content: space-between;
    align-items: center;
    text-align: left;
  }

  .step-row.active .step-btn {
    background: rgba(99, 102, 241, 0.1);
    border-color: var(--accent-color, #6366f1);
  }

  .step-row.building .step-btn {
    background: rgba(245, 158, 11, 0.15);
    border-color: #f59e0b;
  }

  .step-name {
    font-weight: 500;
  }

  .atom-count {
    color: #888;
    font-size: 0.8em;
  }

  .name-input {
    width: 100%;
    padding: 0.15em 0.3em;
    border: 1px solid var(--accent-color, #6366f1);
    border-radius: 3px;
    font-size: inherit;
  }

  /* Build mode */
  .build-status {
    background: rgba(245, 158, 11, 0.08);
    border: 1px solid rgba(245, 158, 11, 0.3);
    border-radius: 4px;
    padding: 0.5em;
    margin-top: 0.3em;
  }

  .build-label {
    font-weight: 600;
    color: #b45309;
  }

  /* Generate */
  .generate-btn {
    width: 100%;
    padding: 0.4em;
    margin-top: 0.3em;
  }

  .error {
    color: #dc2626;
    font-size: 0.8em;
    margin: 0.2em 0;
  }

  /* Dropdown */
  .dropdown-wrapper {
    position: relative;
  }

  .dropdown-menu {
    position: absolute;
    top: 100%;
    left: 0;
    z-index: 10;
    background: var(--bg-color, white);
    border: 1px solid rgba(128, 128, 128, 0.3);
    border-radius: 4px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    min-width: 10em;
    max-height: 15em;
    overflow-y: auto;
    padding: 0.2em 0;
  }

  .dropdown-category {
    padding: 0.3em 0.6em 0.1em;
    font-size: 0.75em;
    font-weight: 600;
    color: #888;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .dropdown-item {
    display: block;
    width: 100%;
    text-align: left;
    border: none;
    border-radius: 0;
    padding: 0.3em 0.8em;
  }

  .dropdown-item:hover {
    background: rgba(99, 102, 241, 0.1) !important;
  }
</style>

<script lang="ts">
  import type { PymatgenStructure, AnyStructure } from '$lib'
  import { STATIC_ONLY } from '$lib/api/config'
  import { DraggablePane, Icon } from '$lib'
  import { export_structure_as_extxyz, structure_to_extxyz_str } from './export'
  import { download } from '$lib/io/fetch'
  import {
    fetchCalculators,
    connectOptimizationWS,
    checkServerHealth,
    type CalculatorType,
    type CalculatorInfo,
    type CalculatorParams,
    type ServerOptimizerType,
    type SellaParams,
    type IRCParams,
    type XTBMethod,
    type OptimizationProgress,
    type WSConnection,
  } from '$lib/api/compute'
  import { optimize_structure_uff, optimize_structure_vsepr, is_ok } from './ferrox-wasm'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'
  import type { VSEPROptimizerConfig } from './ferrox-wasm-types'
  import type { ComponentProps } from 'svelte'
  import type { HTMLAttributes } from 'svelte/elements'

  load_i18n_module('structure')

  let {
    structure = $bindable(),
    pane_open = $bindable(false),
    toggle_props = {},
    pane_props = {},
    on_push_undo,
    on_structure_change,
    selected_indices = [],
    ...rest
  }: Omit<HTMLAttributes<HTMLDivElement>, 'onclose'> & {
    structure?: AnyStructure
    pane_open?: boolean
    toggle_props?: ComponentProps<typeof DraggablePane>['toggle_props']
    pane_props?: ComponentProps<typeof DraggablePane>['pane_props']
    on_push_undo?: () => void
    on_structure_change?: (structure: AnyStructure) => void
    /** Indices of selected atoms to optimize (if empty, all atoms are optimized) */
    selected_indices?: number[]
    max_height?: string
  } = $props()

  // Optimizer type: 'local' (UFF/WASM) or 'server' (ASE calculators)
  type OptimizerType = 'local' | 'server'
  let optimizer_type = $state<OptimizerType>('local')

  // Local optimizer method: 'uff' or 'vsepr'
  let local_method = $state<'uff' | 'vsepr'>('uff')

  // Server connection state
  let server_available = $state(false)
  let server_checking = $state(false)

  // Calculator options (only used for server mode)
  let calculators = $state<Record<string, CalculatorInfo>>({})
  let calculators_loading = $state(false) // Start as false - only set true when actually loading
  let calculators_error = $state<string | null>(null)
  let server_checked = $state(false) // Track if we've checked the server for this session

  // Optimization settings
  let calculator = $state<CalculatorType>(`emt`)
  let fmax = $state(0.05)
  let max_steps = $state(100)
  let snapshot_interval = $state(1)
  let optimize_cell = $state(false)

  // xTB-specific settings
  let xtb_method = $state<XTBMethod>('GFN2-xTB')
  let xtb_electronic_temperature = $state(300) // Kelvin. Bump to 1500+ for d-metal slabs that fail SCF
  let xtb_max_iterations = $state(250) // Max SCF iterations per step

  // MACE-specific settings
  let mace_model = $state<'small' | 'medium' | 'large' | 'custom'>('medium')
  let mace_model_path = $state<string>('')
  let mace_device = $state<'cpu' | 'cuda'>('cpu')

  // VSEPR-specific settings
  let vsepr_iterations = $state(1500)
  let vsepr_force_constant = $state(0.15)

  // Server optimizer method (BFGS, Sella minimization, Sella TS search, IRC)
  let server_method = $state<ServerOptimizerType>('bfgs')

  // Sella parameters
  let sella_delta0 = $state<number | undefined>(undefined)

  // IRC parameters
  let irc_dx = $state<number | undefined>(undefined)

  // Fragment extraction mode (when atoms are selected)
  let extract_fragment = $state(true) // Default to true - extract as isolated molecule

  // Progress state
  type OptStatus = 'idle' | 'connecting' | 'running' | 'complete' | 'error' | 'cancelled'
  let status = $state<OptStatus>(`idle`)
  let progress = $state<OptimizationProgress | null>(null)
  let error_message = $state<string | null>(null)
  let ws_connection = $state<WSConnection | null>(null)

  // Wall-clock tracking so the user can see the current step isn't hung.
  // `started_at` is set when an optimization begins; `last_progress_at` is bumped
  // every progress message; `now_tick` is updated every ~500 ms while running so
  // the template re-renders the elapsed labels.
  let started_at = $state<number | null>(null)
  let last_progress_at = $state<number | null>(null)
  let now_tick = $state(0)
  $effect(() => {
    if (status !== `running` && status !== `connecting`) return
    const id = setInterval(() => { now_tick = Date.now() }, 500)
    return () => clearInterval(id)
  })
  function fmt_elapsed(ms: number): string {
    const s = Math.max(0, Math.floor(ms / 1000))
    if (s < 60) return `${s}s`
    const m = Math.floor(s / 60)
    const r = s % 60
    return `${m}m${r.toString().padStart(2, '0')}s`
  }

  // Energy history for chart
  let energy_history = $state<{ step: number; energy: number; fmax: number }[]>([])

  // Trajectory frames for export (all optimization steps)
  // Each frame can optionally carry energy/fmax from the optimization history
  type TrajectoryFrame = { structure: AnyStructure; energy?: number; fmax?: number; step?: number }
  let trajectory_frames = $state.raw<TrajectoryFrame[]>([])

  // Check server and fetch calculators when server mode is selected (only once per session)
  $effect(() => {
    if (pane_open && optimizer_type === 'server' && !server_checked) {
      server_checked = true
      // Use setTimeout to allow pane to render before starting network requests
      setTimeout(() => check_server_and_fetch_calculators(), 50)
    }
  })

  // Retry server check when backend becomes reachable (VS Code extension: server starts async)
  $effect(() => {
    const on_ready = () => {
      if (optimizer_type === 'server') {
        server_checked = true
        check_server_and_fetch_calculators()
      }
    }
    if (typeof globalThis !== 'undefined') {
      globalThis.addEventListener(`catgo-server-ready`, on_ready)
      return () => globalThis.removeEventListener(`catgo-server-ready`, on_ready)
    }
  })

  // Helper function to compute mobile indices from selective_dynamics and selection
  // Returns indices of atoms that are allowed to move during optimization
  function compute_mobile_indices(): number[] | undefined {
    if (!structure?.sites) return undefined

    // Get atoms that are NOT frozen (selective_dynamics all false means frozen)
    const unfrozen_indices: number[] = []
    structure.sites.forEach((site, idx) => {
      const sd = site.properties?.selective_dynamics as [boolean, boolean, boolean] | undefined
      // Atom is unfrozen if: no selective_dynamics set, OR at least one direction is true
      const is_unfrozen = !sd || sd[0] || sd[1] || sd[2]
      if (is_unfrozen) unfrozen_indices.push(idx)
    })

    // If all atoms are unfrozen and no selection, return undefined (optimize all)
    if (unfrozen_indices.length === structure.sites.length && selected_indices.length === 0) {
      return undefined
    }

    // If user has selected specific atoms, intersect with unfrozen atoms
    if (selected_indices.length > 0) {
      const unfrozen_set = new Set(unfrozen_indices)
      return selected_indices.filter(idx => unfrozen_set.has(idx))
    }

    // Otherwise return all unfrozen atoms
    return unfrozen_indices
  }

  // Local optimization function (UFF or VSEPR)
  async function start_local_optimization() {
    if (!structure) return

    on_push_undo?.()
    status = 'running'
    error_message = null
    energy_history = []
    trajectory_frames = []

    try {
      if (local_method === 'vsepr') {
        // VSEPR optimization - fire-and-forget, no step-by-step progress
        const mobile_indices = compute_mobile_indices()
        const result = await optimize_structure_vsepr(
          structure as any,
          {
            iterations: vsepr_iterations,
            force_constant: vsepr_force_constant,
            mobile_indices,
            snapshot_interval,
          }
        )

        if (is_ok(result)) {
          structure = result.ok.structure as AnyStructure
          on_structure_change?.(structure)
          // Build trajectory from VSEPR result (initial + final)
          const vsepr_traj = (result.ok.trajectory ?? []).map((s, i) => ({
            structure: s as AnyStructure,
            step: i === 0 ? 0 : result.ok.iterations ?? vsepr_iterations,
          }))
          trajectory_frames = vsepr_traj.length > 0 ? vsepr_traj : [{ structure, step: 0 }]
          // Show iterations in progress
          progress = {
            step: result.ok.iterations ?? vsepr_iterations,
            energy: 0,
            fmax: 0,
            converged: true,
            structure,
          } as any
          status = 'complete'
        } else {
          error_message = result.error
          status = 'error'
        }
      } else {
        // UFF optimization
        const mobile_indices = compute_mobile_indices()
        const result = await optimize_structure_uff(structure as any, {
          max_steps,
          fmax,
          mobile_indices,
          snapshot_interval,
        })

        if (is_ok(result)) {
          const opt_result = result.ok

          // Build energy history from per-step data
          if (opt_result.history?.length) {
            energy_history = opt_result.history.map(s => ({
              step: s.step,
              energy: s.energy,
              fmax: s.fmax,
            }))
          } else {
            energy_history = [{
              step: opt_result.iterations ?? 0,
              energy: opt_result.final_energy,
              fmax: opt_result.final_fmax,
            }]
          }

          // Update progress display
          progress = {
            step: opt_result.iterations ?? 0,
            energy: opt_result.final_energy,
            fmax: opt_result.final_fmax,
            converged: opt_result.converged,
            structure: opt_result.structure as AnyStructure,
          } as any

          // Update structure
          structure = opt_result.structure as AnyStructure
          on_structure_change?.(structure)
          // Build trajectory from snapshots, pairing with energy/fmax from history
          const traj_structs = opt_result.trajectory ?? []
          const hist = opt_result.history ?? []
          // History entries at snapshot intervals correspond 1:1 with trajectory frames
          // Filter history to only snapshot steps (step 0, snapshot_interval, 2*snapshot_interval, ...)
          const snapshot_history = hist.filter((_, i) => i === 0 || i % (snapshot_interval || 1) === 0 || hist[i]?.converged)
          trajectory_frames = traj_structs.map((s, i) => ({
            structure: s as AnyStructure,
            energy: snapshot_history[i]?.energy,
            fmax: snapshot_history[i]?.fmax,
            step: snapshot_history[i]?.step ?? i,
          }))
          if (trajectory_frames.length === 0) trajectory_frames = [{ structure, energy: opt_result.final_energy, fmax: opt_result.final_fmax, step: 0 }]

          status = 'complete'
        } else {
          error_message = result.error
          status = 'error'
        }
      }
    } catch (err) {
      error_message = err instanceof Error ? err.message : `${local_method.toUpperCase()} optimization failed`
      status = 'error'
    }
  }

  // Note: WebSocket cleanup happens automatically when connection completes/errors
  // Manual cleanup on pane close removed to avoid race conditions

  async function check_server_and_fetch_calculators() {
    server_checking = true
    calculators_loading = true
    calculators_error = null

    try {
      // First check if server is available
      server_available = await checkServerHealth()
      if (!server_available) {
        calculators_error = t('structure.compute_server_not_available')
        calculators_loading = false
        server_checking = false
        return
      }

      // Fetch calculators
      const data = await fetchCalculators()
      calculators = data
      calculators_loading = false

      // Select first available calculator
      const available = Object.entries(data).find(([_, info]) => info.available)
      if (available) calculator = available[0] as CalculatorType
    } catch (err) {
      calculators_error = err instanceof Error ? err.message : t('structure.failed_connect_server')
      calculators_loading = false
    }
    server_checking = false
  }

  function start_optimization() {
    if (!structure) return

    on_push_undo?.()
    status = `connecting`
    error_message = null
    energy_history = []
    trajectory_frames = [] // Clear trajectory
    started_at = Date.now()
    last_progress_at = started_at
    now_tick = started_at

    // Build calculator-specific params
    let calculator_params: CalculatorParams | undefined = undefined
    if (calculator === 'xtb') {
      calculator_params = {
        xtb: {
          method: xtb_method,
          electronic_temperature: xtb_electronic_temperature,
          max_iterations: xtb_max_iterations,
        },
      }
    } else if (calculator === 'mace') {
      calculator_params = {
        mace: {
          model: mace_model,
          model_path: mace_model === 'custom' ? mace_model_path : undefined,
          device: mace_device,
        }
      }
    }

    // Compute mobile indices considering both selective_dynamics and selection
    const mobile_indices = compute_mobile_indices()

    // Build Sella/IRC params if applicable
    const sella_params: SellaParams | undefined =
      (server_method === 'sella_min' || server_method === 'sella_ts') && sella_delta0 !== undefined
        ? { delta0: sella_delta0 }
        : undefined
    const irc_params: IRCParams | undefined =
      server_method === 'irc' && irc_dx !== undefined
        ? { dx: irc_dx }
        : undefined

    ws_connection = connectOptimizationWS(
      structure,
      { calculator, calculator_params, optimizer: server_method, sella_params, irc_params, fmax, steps: max_steps, optimize_cell, mobile_indices, extract_fragment: (mobile_indices && selected_indices.length > 0) ? extract_fragment : undefined },
      {
        onConnected: () => {
          status = `running`
        },
        onProgress: (p) => {
          status = `running`
          progress = p
          last_progress_at = Date.now()
          energy_history = [
            ...energy_history,
            { step: p.step, energy: p.energy, fmax: p.fmax },
          ]
          // Collect trajectory frames when structure is included
          if (p.structure) {
            trajectory_frames = [...trajectory_frames, {
              structure: p.structure as AnyStructure,
              energy: p.energy,
              fmax: p.fmax,
              step: p.step,
            }]
          }
        },
        onComplete: (result) => {
          status = `complete`
          progress = result
          if (result.structure) {
            // Add final frame with energy
            trajectory_frames = [...trajectory_frames, {
              structure: result.structure as AnyStructure,
              energy: result.energy,
              fmax: result.fmax,
              step: result.step,
            }]
            structure = result.structure
            on_structure_change?.(result.structure)
          }
          ws_connection = null
        },
        onError: (err) => {
          status = `error`
          error_message = err.message
          ws_connection = null
        },
        onCancel: () => {
          status = `cancelled`
          ws_connection = null
        },
        onDisconnected: () => {
          if (status === `connecting` || status === `running`) {
            status = `error`
            error_message = t('structure.connection_lost')
          }
          ws_connection = null
        },
      },
    )
  }

  function cancel_optimization() {
    ws_connection?.cancel()
  }

  function reset_state() {
    status = `idle`
    progress = null
    error_message = null
    energy_history = []
    trajectory_frames = []
  }

  // Export all trajectory frames as multi-frame extXYZ
  function export_trajectory() {
    if (trajectory_frames.length === 0) return

    // Combine all frames into a multi-frame extXYZ file
    // Embed energy/fmax/step into structure metadata for extXYZ comment line
    const content = trajectory_frames
      .map((frame) => {
        const struct_with_meta = {
          ...frame.structure,
          energy: frame.energy,
          fmax: frame.fmax,
          step: frame.step,
        }
        return structure_to_extxyz_str(struct_with_meta as AnyStructure)
      })
      .join(`\n`)

    const filename = `optimization_trajectory_${trajectory_frames.length}frames.extxyz`
    download(content, filename, `text/plain`)
  }

  function retry_connection() {
    calculators_loading = true
    check_server_and_fetch_calculators()
  }

  let has_lattice = $derived(!!structure && 'lattice' in structure && !!structure.lattice)

  // d-block transition metals (groups 3-12). xtb/tblite SCF struggles on large
  // systems containing these due to dense d-manifolds and smearing instabilities.
  const D_BLOCK_ELEMENTS = new Set([
    'Sc','Ti','V','Cr','Mn','Fe','Co','Ni','Cu','Zn',
    'Y','Zr','Nb','Mo','Tc','Ru','Rh','Pd','Ag','Cd',
    'La','Hf','Ta','W','Re','Os','Ir','Pt','Au','Hg',
  ])
  let atom_count = $derived(structure?.sites?.length ?? 0)
  let has_d_metal = $derived.by(() => {
    if (!structure?.sites) return false
    for (const site of structure.sites) {
      for (const sp of site.species ?? []) {
        if (D_BLOCK_ELEMENTS.has(sp.element)) return true
      }
    }
    return false
  })
  let show_xtb_slow_hint = $derived(
    calculator === 'xtb' && atom_count > 50 && has_d_metal
  )

  // Count atoms that are frozen via selective_dynamics
  let frozen_atom_count = $derived(() => {
    if (!structure?.sites) return 0
    return structure.sites.filter(site => {
      const sd = site.properties?.selective_dynamics as [boolean, boolean, boolean] | undefined
      // Atom is frozen if selective_dynamics is set AND all directions are false
      return sd && !sd[0] && !sd[1] && !sd[2]
    }).length
  })

  let can_start_local = $derived(structure && status === 'idle')
  let can_start_server = $derived(
    structure &&
      status === `idle` &&
      !calculators_loading &&
      server_available &&
      calculators[calculator]?.available,
  )
  let can_start = $derived(
    optimizer_type === 'local' ? can_start_local : can_start_server
  )
  let is_running = $derived(status === `connecting` || status === `running`)

  // Wrapper function to start optimization based on type
  function handle_start_optimization() {
    if (optimizer_type === 'local') {
      start_local_optimization()
    } else {
      start_optimization()
    }
  }

  // Format numbers for display
  function fmt(val: number, decimals: number = 4): string {
    return val.toFixed(decimals)
  }

  // Energy chart scaling
  let chart_min = $derived(
    energy_history.length > 0 ? Math.min(...energy_history.map((h) => h.energy)) : 0,
  )
  let chart_max = $derived(
    energy_history.length > 0 ? Math.max(...energy_history.map((h) => h.energy)) : 1,
  )
  let chart_range = $derived(chart_max - chart_min || 1)
</script>

<DraggablePane
  bind:show={pane_open}
  max_width="20em"
  close_on_click_outside={false}
  toggle_props={{
    class: `optimization-pane-toggle`,
    title: pane_open ? t('structure.close_structure_optimizer') : t('structure.open_structure_optimizer'),
    ...toggle_props,
  }}
  open_icon="Cross"
  closed_icon="Zap"
  pane_props={{ ...pane_props, class: `optimization-pane ${pane_props?.class ?? ``}` }}
  {...rest}
>
  <h4>{t('structure.structure_optimization')}</h4>

  {#if !structure}
    <p class="warning">{t('structure.no_structure_optimize')}</p>
  {:else}
    <!-- Optimizer Type Selection -->
    <section>
      <label class="section-label">{t('structure.optimizer')}</label>
      <select bind:value={optimizer_type} disabled={is_running}>
        <option value="local">{t('structure.local_wasm')}</option>
        {#if !STATIC_ONLY}
        <option value="server">{t('structure.server_ml_potentials')}</option>
        {/if}
      </select>
      {#if optimizer_type === 'local'}
        <label class="setting-row" style="margin-top: 6px">
          <span>{t('structure.method')}</span>
          <select bind:value={local_method} disabled={is_running}>
            <option value="uff">{t('structure.uff_force_field')}</option>
            <option value="vsepr">{t('structure.vsepr_geometry')}</option>
          </select>
        </label>
        <p class="hint">
          {#if local_method === 'uff'}
            {t('structure.uff_hint')}
          {:else}
            {t('structure.vsepr_hint')}
          {/if}
        </p>
        {#if frozen_atom_count() > 0 || selected_indices.length > 0}
          <div class="selected-atoms-info">
            {#if frozen_atom_count() > 0}
              <div><strong>🔒 {t('structure.atoms_frozen', { n: frozen_atom_count() })}</strong> (selective dynamics)</div>
            {/if}
            {#if selected_indices.length > 0}
              <div><strong>{selected_indices.length} atoms selected</strong> - only these will move.</div>
            {/if}
          </div>
        {/if}
      {:else}
        <p class="hint">
          {t('structure.ml_potentials_need_server')}
        </p>
        {#if frozen_atom_count() > 0}
          <div class="selected-atoms-info">
            <div><strong>🔒 {t('structure.atoms_frozen', { n: frozen_atom_count() })}</strong> (selective dynamics)</div>
          </div>
        {/if}
        {#if selected_indices.length > 0}
          <div class="selected-atoms-info">
            <strong>{t('structure.atoms_selected', { n: selected_indices.length })}</strong>
            <label class="checkbox-row fragment-toggle">
              <input type="checkbox" bind:checked={extract_fragment} disabled={is_running} />
              <span>{t('structure.extract_as_isolated_molecule')}</span>
            </label>
            <p class="hint fragment-hint">
              {#if extract_fragment}
                {t('structure.selected_atoms_extract_hint')}
              {:else}
                {t('structure.selected_atoms_fixed_hint')}
              {/if}
            </p>
          </div>
        {/if}
      {/if}
    </section>

    {#if optimizer_type === 'server'}
      {#if calculators_loading || server_checking}
        <p class="loading">{t('structure.connecting_compute_server')}</p>
      {:else if calculators_error}
        <div class="error-box">
          <p class="error">{calculators_error}</p>
          <button class="secondary-btn" onclick={retry_connection}>{t('structure.retry_connection')}</button>
        </div>
      {:else if server_available}
        <!-- Calculator Selection (Server mode only) -->
        <section>
          <label class="section-label">{t('structure.calculator')}</label>
          <select bind:value={calculator} disabled={is_running}>
            {#each Object.entries(calculators) as [key, info]}
              <option value={key} disabled={!info.available}>
                {info.name}
                {info.available ? `` : `(${t('structure.unavailable')})`}
              </option>
            {/each}
          </select>
          {#if calculators[calculator]?.description}
            <p class="hint">{calculators[calculator].description}</p>
          {/if}
        </section>

        <!-- Server Optimizer Method -->
        <section>
          <label class="section-label">{t('structure.optimizer_method')}</label>
          <select bind:value={server_method} disabled={is_running}>
            <option value="bfgs">BFGS (Minimization)</option>
            <option value="sella_min">Sella Minimize</option>
            <option value="sella_ts">Sella TS Search</option>
            <option value="irc">IRC (Reaction Path)</option>
          </select>
          <p class="hint">
            {#if server_method === 'bfgs'}
              Standard quasi-Newton minimizer for finding local energy minima.
            {:else if server_method === 'sella_min'}
              Sella minimizer (order=0) — alternative to BFGS with trust-radius control.
            {:else if server_method === 'sella_ts'}
              TS Search finds transition states (saddle points) on the potential energy surface.
            {:else}
              IRC traces the minimum energy path from a transition state toward reactants/products.
            {/if}
          </p>

          {#if server_method === 'sella_min' || server_method === 'sella_ts'}
            <div class="param-row">
              <span>{t('structure.trust_radius')}</span>
              <input
                type="number"
                step="0.01"
                min="0.01"
                max="1.0"
                bind:value={sella_delta0}
                disabled={is_running}
                placeholder="auto"
              />
            </div>
            <p class="hint">{t('structure.trust_radius_hint')}</p>
          {/if}

          {#if server_method === 'irc'}
            <div class="param-row">
              <span>{t('structure.step_size_dx')}</span>
              <input
                type="number"
                step="0.01"
                min="0.01"
                max="1.0"
                bind:value={irc_dx}
                disabled={is_running}
                placeholder="auto"
              />
            </div>
            <p class="hint">{t('structure.irc_step_size_hint')}</p>
          {/if}
        </section>

        <!-- xTB Method Selection -->
        {#if calculator === 'xtb' && calculators['xtb']?.available}
        <section>
          <label class="section-label">{t('structure.xtb_method')}</label>
          <select bind:value={xtb_method} disabled={is_running}>
            <option value="GFN2-xTB">GFN2-xTB (most accurate)</option>
            <option value="GFN1-xTB">GFN1-xTB (faster)</option>
            <option value="GFN0-xTB">GFN0-xTB (fastest TB)</option>
            <option value="GFN-FF">GFN-FF (force field)</option>
            <option value="IPEA1-xTB">IPEA1-xTB (IP/EA optimized)</option>
          </select>
          <p class="hint">
            {#if xtb_method === 'GFN2-xTB'}
              Recommended for most structures. Anisotropic electrostatics + D4 dispersion.
            {:else if xtb_method === 'GFN1-xTB'}
              Faster calculations with isotropic electrostatics.
            {:else if xtb_method === 'GFN0-xTB'}
              Fastest tight-binding method, less accurate.
            {:else if xtb_method === 'GFN-FF'}
              Force field approximation. Very fast, good for pre-optimization.
            {:else}
              Specialized for ionization potentials and electron affinities.
            {/if}
          </p>
          <div class="xtb-advanced">
            <label class="xtb-advanced-row">
              <span>{t('structure.electronic_temperature')}</span>
              <input
                type="number"
                bind:value={xtb_electronic_temperature}
                min="0"
                max="5000"
                step="50"
                disabled={is_running}
              />
            </label>
            <label class="xtb-advanced-row">
              <span>{t('structure.max_scf_iterations')}</span>
              <input
                type="number"
                bind:value={xtb_max_iterations}
                min="50"
                max="2000"
                step="50"
                disabled={is_running}
              />
            </label>
            <p class="hint">
              Defaults 300 K / 250 iters work for molecules and clean crystals. Bump both
              (e.g. 1500 K / 500) if SCF fails to converge on transition-metal slabs — but note
              higher values slow every step substantially.
            </p>
          </div>
          {#if show_xtb_slow_hint}
            <p class="slow-hint">
              This structure has {atom_count} atoms including d-block transition metals.
              xtb/tblite SCF is typically <strong>minutes per step</strong> here; consider
              <strong>MACE</strong> or <strong>CHGNet</strong> for much faster optimization.
            </p>
          {/if}
        </section>
        {/if}

        <!-- MACE Settings -->
        {#if calculator === 'mace' && calculators['mace']?.available}
        <section>
          <label class="section-label">{t('structure.mace_model')}</label>
          <select bind:value={mace_model} disabled={is_running}>
            <option value="small">Small (fastest)</option>
            <option value="medium">Medium (balanced)</option>
            <option value="large">Large (most accurate)</option>
            <option value="custom">Custom Model</option>
          </select>
          {#if mace_model === 'custom'}
            <label class="section-label" style="margin-top: 8px">{t('structure.model_path')}</label>
            <input
              type="text"
              bind:value={mace_model_path}
              placeholder="/path/to/your/model.model"
              disabled={is_running}
              class="model-path-input"
            />
            <p class="hint">
              Path to your custom MACE model file (.model)
            </p>
          {:else}
            <p class="hint">
              {#if mace_model === 'small'}
                Fastest MACE-MP model, good for quick tests.
              {:else if mace_model === 'medium'}
                Balanced accuracy and speed for general use.
              {:else}
                Most accurate MACE-MP model, slower.
              {/if}
            </p>
          {/if}

          <label class="section-label" style="margin-top: 8px">{t('structure.device')}</label>
          <select bind:value={mace_device} disabled={is_running}>
            <option value="cpu">CPU</option>
            <option value="cuda">GPU (CUDA)</option>
          </select>
        </section>
        {/if}
      {:else}
        <!-- Server not yet checked or not available -->
        <div class="error-box">
          <p class="hint">{t('structure.server_not_connected_hint')}</p>
          <button class="secondary-btn" onclick={retry_connection}>{t('structure.check_server')}</button>
        </div>
      {/if}
    {/if}

    <!-- Settings (show for local mode, or server mode when connected) -->
    {#if optimizer_type === 'local' || (optimizer_type === 'server' && server_available && !calculators_loading)}
    <section>
      {#if optimizer_type === 'local' && local_method === 'vsepr'}
        <label class="section-label">{t('structure.vsepr_settings')}</label>
        <div class="param-row">
          <span>{t('structure.iterations')}</span>
          <input
            type="number"
            step="100"
            min="100"
            max="10000"
            bind:value={vsepr_iterations}
            disabled={is_running}
          />
        </div>
        <div class="param-row">
          <span>{t('structure.force_constant')}</span>
          <input
            type="number"
            step="0.01"
            min="0.01"
            max="1.0"
            bind:value={vsepr_force_constant}
            disabled={is_running}
          />
        </div>
      {:else}
        <label class="section-label">{t('structure.convergence_settings')}</label>
        <div class="param-row">
          <span>fmax (eV/A)</span>
          <input
            type="number"
            step="0.01"
            min="0.001"
            max="1"
            bind:value={fmax}
            disabled={is_running}
          />
        </div>
        <div class="param-row">
          <span>{t('structure.max_steps')}</span>
          <input
            type="number"
            step="10"
            min="1"
            max="1000"
            bind:value={max_steps}
            disabled={is_running}
          />
        </div>
        {#if optimizer_type === 'local' && local_method === 'uff'}
          <div class="param-row">
            <span>{t('structure.snapshot_interval')}</span>
            <input
              type="number"
              step="1"
              min="1"
              max="100"
              bind:value={snapshot_interval}
              disabled={is_running}
              title={t('structure.snapshot_interval_title')}
            />
          </div>
        {/if}
        {#if has_lattice && optimizer_type === 'server'}
          <label class="checkbox-row">
            <input type="checkbox" bind:checked={optimize_cell} disabled={is_running} />
            <span>{t('structure.optimize_cell_parameters')}</span>
          </label>
        {/if}
      {/if}
    </section>
    {/if}

    <!-- Loading Calculator Message (Server mode only) -->
    {#if optimizer_type === 'server' && status === `connecting`}
      <p class="loading">
        {t('structure.loading_calculator', { name: calculators[calculator]?.name || calculator })}
        <br />
        <span class="hint">{t('structure.ml_potentials_may_take_moment')}</span>
      </p>
    {/if}

    <!-- VSEPR running indicator -->
    {#if optimizer_type === 'local' && local_method === 'vsepr' && status === 'running'}
      <p class="loading">{t('structure.optimizing_vsepr')}</p>
    {/if}

    <!-- Progress Display -->
    {#if progress}
      <section class="progress-section">
        <label class="section-label">{t('structure.progress')}</label>
        <div class="progress-bar-container">
          <div class="progress-bar" style:width="{(progress.step / ((optimizer_type === 'local' && local_method === 'vsepr') ? vsepr_iterations : max_steps)) * 100}%"></div>
        </div>
        <div class="stats-grid">
          <div class="stat">
            <span class="stat-label">{t('structure.step')}</span>
            <span class="stat-value">{progress.step} / {(optimizer_type === 'local' && local_method === 'vsepr') ? vsepr_iterations : max_steps}</span>
          </div>
          <div class="stat">
            <span class="stat-label">{t('structure.energy')}</span>
            <span class="stat-value">{fmt(progress.energy)} eV</span>
          </div>
          <div class="stat">
            <span class="stat-label">fmax</span>
            <span class="stat-value" class:converged={progress.fmax <= fmax}>
              {fmt(progress.fmax)} eV/A
            </span>
          </div>
        </div>
        {#if started_at !== null && last_progress_at !== null}
          {@const now = status === `running` || status === `connecting` ? Math.max(now_tick, last_progress_at) : last_progress_at}
          <div class="timing-row">
            <span>{t('structure.this_step', { time: fmt_elapsed(now - last_progress_at) })}</span>
            <span>{t('structure.total_time', { time: fmt_elapsed(now - started_at) })}</span>
          </div>
        {/if}

        {#if energy_history.length > 1}
          <!-- Mini energy chart -->
          <div class="energy-chart">
            <svg viewBox="0 0 200 50" preserveAspectRatio="none">
              <polyline
                fill="none"
                stroke="var(--accent-color, #007acc)"
                stroke-width="2"
                points={energy_history
                  .map(
                    (h, i) =>
                      `${(i / (energy_history.length - 1)) * 200},${50 - ((h.energy - chart_min) / chart_range) * 40 - 5}`,
                  )
                  .join(` `)}
              />
            </svg>
            <div class="chart-labels">
              <span>{fmt(chart_max, 2)}</span>
              <span>{fmt(chart_min, 2)}</span>
            </div>
          </div>
        {/if}
      </section>
    {/if}

    <!-- Status Messages -->
    {#if status === `complete`}
      {#if optimizer_type === 'local' && local_method === 'vsepr'}
        <p class="success">{t('structure.vsepr_complete')}</p>
      {:else}
        <p class="success">
          {progress?.converged ? t('structure.converged') : t('structure.max_steps_reached')}
          {#if progress}
            - {t('structure.final_energy', { energy: fmt(progress.energy) })}
          {/if}
        </p>
      {/if}
      <div class="export-buttons">
        <button
          class="save-btn"
          onclick={() => export_structure_as_extxyz(structure)}
          title={t('structure.save_final_title')}
        >
          <Icon icon="Export" style="width: 14px; height: 14px" />
          {t('structure.save_final')}
        </button>
        {#if trajectory_frames.length > 1}
          <button
            class="save-btn trajectory"
            onclick={export_trajectory}
            title={t('structure.save_trajectory_title', { n: trajectory_frames.length })}
          >
            <Icon icon="Export" style="width: 14px; height: 14px" />
            {t('structure.save_trajectory_frames', { n: trajectory_frames.length })}
          </button>
        {/if}
      </div>
    {:else if status === `error`}
      <p class="error">{error_message}</p>
    {:else if status === `cancelled`}
      <p class="warning">{t('structure.optimization_cancelled')}</p>
    {/if}

    <!-- Action Buttons -->
    {#if optimizer_type === 'local' || (optimizer_type === 'server' && server_available && !calculators_loading)}
    <div class="button-group">
      {#if is_running}
        <button class="cancel-btn" onclick={optimizer_type === 'server' ? cancel_optimization : undefined} disabled={optimizer_type === 'local'}>
          <Icon icon="Cross" style="width: 14px; height: 14px" />
          {optimizer_type === 'local' ? t('structure.running') : t('common.cancel')}
        </button>
      {:else if status !== `idle`}
        <button class="secondary-btn" onclick={reset_state}> {t('common.reset')} </button>
        <button class="apply-btn" onclick={() => { reset_state(); handle_start_optimization() }}>
          {t('structure.run_again')}
        </button>
      {:else}
        <button class="apply-btn" onclick={handle_start_optimization} disabled={!can_start}>
          <Icon icon="Zap" style="width: 14px; height: 14px" />
          {t('structure.optimize')}
        </button>
      {/if}
    </div>
    {/if}
  {/if}
</DraggablePane>

<style>
  .error-box {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .loading {
    opacity: 0.6;
    margin: 0;
  }

  select {
    width: 100%;
    padding: 6px 8px;
    border: 1px solid light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15));
    background: light-dark(rgba(0, 0, 0, 0.04), rgba(0, 0, 0, 0.2));
    color: inherit;
    border-radius: 4px;
  }

  .model-path-input {
    width: 100%;
    padding: 6px 8px;
    border: 1px solid light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15));
    background: light-dark(rgba(0, 0, 0, 0.04), rgba(0, 0, 0, 0.2));
    color: inherit;
    border-radius: 4px;
    font-family: monospace;
  }
  .model-path-input::placeholder {
    opacity: 0.6;
  }

  .setting-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .setting-row span {
    white-space: nowrap;
  }

  .param-row {
    margin-bottom: 6px;
  }
  .param-row input {
    width: 5em;
    padding: 4px 8px;
    border: 1px solid light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15));
    background: light-dark(rgba(0, 0, 0, 0.04), rgba(0, 0, 0, 0.2));
    color: inherit;
    border-radius: 4px;
    text-align: right;
  }

  .checkbox-row input {
    margin: 0;
  }

  .xtb-advanced {
    margin-top: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .xtb-advanced-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .xtb-advanced-row span {
    font-size: 0.85em;
    opacity: 0.85;
  }
  .xtb-advanced-row input {
    width: 6em;
    padding: 4px 8px;
    border: 1px solid light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15));
    background: light-dark(rgba(0, 0, 0, 0.04), rgba(0, 0, 0, 0.2));
    color: inherit;
    border-radius: 4px;
    text-align: right;
  }

  .timing-row {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    margin-top: 6px;
    font-size: 0.8em;
    opacity: 0.75;
    font-variant-numeric: tabular-nums;
  }
  .timing-row strong {
    font-weight: 600;
    opacity: 1;
  }

  .slow-hint {
    margin-top: 8px;
    padding: 6px 8px;
    font-size: 0.8em;
    line-height: 1.4;
    border-radius: 4px;
    background: light-dark(rgba(240, 180, 40, 0.12), rgba(240, 180, 40, 0.18));
    border: 1px solid light-dark(rgba(240, 180, 40, 0.35), rgba(240, 180, 40, 0.45));
    color: inherit;
  }
  .slow-hint strong {
    font-weight: 600;
  }

  .selected-atoms-info {
    background: var(--surface-bg, rgba(255, 255, 255, 0.05));
    border-radius: 4px;
    padding: 8px;
    margin-top: 6px;
  }
  .fragment-toggle {
    margin-top: 6px;
  }
  .fragment-hint {
    margin-top: 4px;
  }

  .progress-section {
    background: var(--surface-bg, rgba(255, 255, 255, 0.05));
    border-radius: 4px;
    padding: 8px;
  }

  .progress-bar-container {
    height: 6px;
    background: light-dark(rgba(0, 0, 0, 0.1), rgba(255, 255, 255, 0.15));
    border-radius: 4px;
    overflow: hidden;
    margin-bottom: 8px;
  }
  .progress-bar {
    height: 100%;
    background: var(--accent-color, #007acc);
    transition: width 0.1s ease-out;
  }

  .stats-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 4px;
  }
  .stat {
    text-align: center;
  }
  .stat-label {
    display: block;
    font-size: 0.85em;
    color: var(--text-color-dim);
  }
  .stat-value {
    font-size: 0.9em;
    font-weight: 500;
  }
  .stat-value.converged {
    color: var(--success-color, #22c55e);
  }

  .energy-chart {
    height: 50px;
    margin-top: 8px;
    background: light-dark(rgba(0, 0, 0, 0.04), rgba(0, 0, 0, 0.2));
    border-radius: 4px;
    overflow: hidden;
    position: relative;
  }
  .energy-chart svg {
    width: 100%;
    height: 100%;
  }
  .chart-labels {
    position: absolute;
    top: 2px;
    right: 4px;
    bottom: 2px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    font-size: 0.75em;
    color: var(--text-color-dim);
    pointer-events: none;
  }

  .save-btn {
    flex: 1;
    padding: 8px 12px;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    transition:
      background 0.15s,
      opacity 0.15s;
  }

  .export-buttons {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 8px;
  }

  .save-btn {
    background: var(--success-color, #22c55e);
    color: white;
  }
  .save-btn:hover {
    filter: brightness(1.1);
  }
  .save-btn.trajectory {
    background: var(--accent-color, #007acc);
  }
</style>

<script lang="ts">
  import '$lib/dialog-shared.css'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'
  import { STATUS_COLORS } from './workflow-types'
  import type { StepInfo } from './workflow-types'
  import type { ConvergencePoint } from '$lib/api/workflow'
  import BatchStatusSection from './BatchStatusSection.svelte'
  import * as api from '$lib/api/workflow'
  import { download } from '$lib/io/fetch'
  import { API_BASE } from '$lib/api/config'
  import UvVisPlot from './UvVisPlot.svelte'
  import ConvergencePlot from './ConvergencePlot.svelte'
  import VaspMonitorPlot from './VaspMonitorPlot.svelte'
  import Trajectory from '$lib/trajectory/Trajectory.svelte'
  import IrcPathPlot from './IrcPathPlot.svelte'
  import ImageEnergyProfile from './ImageEnergyProfile.svelte'
  import ImageEnergyTable from './ImageEnergyTable.svelte'
  import { hpc_session_store, refresh_hpc_sessions } from '$lib/hpc-sessions.svelte'
  import StepFileTree from './StepFileTree.svelte'
  import ForceViewerControls from './ForceViewerControls.svelte'
  import type { StepForces, VaspFrequencyData, GibbsResult } from '$lib/api/workflow'
  import GibbsCalculator from './GibbsCalculator.svelte'
  import VibrationModeSelector from './VibrationModeSelector.svelte'
  import BatchStatusPanel from './BatchStatusPanel.svelte'
  import EnergyDiagramPlot from './EnergyDiagramPlot.svelte'
  import SurfaceEnergyPlot from './SurfaceEnergyPlot.svelte'
  import WulffPlot from './WulffPlot.svelte'
  import WulffShape3D from './WulffShape3D.svelte'
  import CoverageDependencePlot from './CoverageDependencePlot.svelte'
  import NEBPathPlot from './NEBPathPlot.svelte'
  import { lazy_load_plotly, base_layout, base_config } from './plotly-utils'
  import { pending_open_structure } from './workflow-state.svelte'
  import { NODE_DEFINITIONS } from './node-definitions'
  import type { TaskRef } from '$lib/api/task-adapter'
  import * as adapter from '$lib/api/task-adapter'
  import { normalize_status, is_valid_task_id } from '$lib/api/task-adapter'
  import { get_v2_task, get_v2_task_result, type V2Task } from '$lib/api/workflow-v2'
  import ResultsPlot from './ResultsPlot.svelte'
  // Static imports for the View Structure click handler — using a dynamic
  // import here would code-split the parsers into a chunk that can fail to
  // load on production builds with strict CSP, silently swallowing clicks.
  import { parse_poscar, parse_xyz } from '$lib/structure/parse'

  let {
    // ========== EXISTING STEP-BASED PROPS ==========
    node_id,
    node_type,
    node_label,
    workflow_id,
    status,
    node_params,
    onview_file,
    onload_structure,
    ondownload,
    onload_forces,
    onplay_vibration,
    onstop_vibration,
    onstatus_sync,
    node_statuses,

    // ========== NEW: TASK-BASED PROPS ==========
    mode = 'step' as 'step' | 'task',
    task_id = undefined as string | undefined,
    onconfirm = undefined as (() => void) | undefined,

    // ========== RETAINED: ORCA MONITORING PROP ==========
    step_message = undefined as string | undefined,

    // ========== ORCA RESULT DISPLAY ==========
    task_results = {} as Record<string, any>,
  }: {
    // ========== EXISTING TYPES ==========
    node_id: string
    node_type: string
    node_label: string
    workflow_id: string
    status?: string
    node_params?: Record<string, unknown>
    onview_file?: (node_id: string, filename: string) => void
    onload_structure?: (node_id: string, filename: string) => void
    ondownload?: (node_id: string, filename: string) => void
    onload_forces?: (frames: StepForces[]) => void
    onplay_vibration?: (data: { eigenvector: number[][]; base_positions: number[][]; amplitude: number }) => void
    onstop_vibration?: () => void
    /** Called when DB status differs from prop status (e.g., DB says completed but prop says running) */
    onstatus_sync?: (node_id: string, db_status: string) => void
    /** All node statuses — used to detect fan-out sub-steps keyed as {node_id}__sub_N */
    node_statuses?: Record<string, string>

    // ========== NEW: TASK TYPES ==========
    /** 'step': Traditional step-based workflow. 'task': Task-based workflow with review gates */
    mode?: 'step' | 'task'
    /** Task ID for task-based workflows. Used to load V2Task metadata */
    task_id?: string
    /** Callback fired when user confirms task (PENDING_REVIEW → QUEUED) */
    onconfirm?: () => void

    // ========== ORCA MONITORING TYPE ==========
    /** Live ORCA stage message (orca_freq, orca_irc only). Updated via WebSocket during execution */
    step_message?: string

    // ========== ORCA RESULT DISPLAY ==========
    /** Task results from backend (task_id -> parsed result data) */
    task_results?: Record<string, any>
  } = $props()

  let step_info = $state<StepInfo | null>(null)
  let convergence = $state<{ points: ConvergencePoint[]; converged: boolean; message?: string; convergence_thresholds?: { max_grad: number; rms_grad: number }; image_energies?: Record<string, Array<[number, number]>> } | null>(null)
  interface FileEntry { name: string; size: string; modified: string; is_dir: boolean; permissions?: string }

  // Module-level cache: survives component remounts (tab switches)
  const _files_cache = new Map<string, { files: FileEntry[]; work_dir: string }>()

  let files = $state<FileEntry[]>(_files_cache.get(node_id)?.files ?? [])
  let work_dir = $state(_files_cache.get(node_id)?.work_dir ?? ``)
  let loading = $state(false)
  let fetch_error = $state<string | null>(null)
  let ssh_unavailable = $state(false)
  let view_structure_error = $state<string | null>(null)

  // Derive whether to show results
  let results_data = $derived(task_results[node_id])
  let show_results = $derived(status === 'COMPLETED' && results_data)

  let eos_plot_div: HTMLDivElement | undefined = $state()
  let _Plotly: any = $state(null)

  $effect(() => {
    if (typeof window !== `undefined` && !_Plotly) {
      lazy_load_plotly().then((p) => { _Plotly = p })
    }
  })

  $effect(() => {
    if (!_Plotly || !eos_plot_div) return
    const cs = cached_summary as any
    const se = cs.summary ?? cs
    if (se.analysis_type !== 'eos' || !se.data_points?.length) {
      _Plotly.purge(eos_plot_div); return
    }
    const traces: any[] = [{
      x: se.data_points.map((p: any) => p.volume),
      y: se.data_points.map((p: any) => p.energy),
      mode: 'markers', type: 'scatter', name: t('workflow.nsp_calculated'),
      marker: { size: 8, color: '#3b82f6' },
    }]
    if (se.fit_curve?.volumes?.length) {
      traces.push({
        x: se.fit_curve.volumes, y: se.fit_curve.energies,
        mode: 'lines', type: 'scatter', name: t('workflow.nsp_eos_fit'),
        line: { color: '#ef4444', width: 2 },
      })
    }
    const ac = 'var(--text-color, #374151)'
    _Plotly.react(eos_plot_div, traces, base_layout({
      height: 280,
      xaxis: { title: t('workflow.nsp_volume_axis'), showgrid: true, gridcolor: 'rgba(128,128,128,0.15)', color: ac },
      yaxis: { title: t('workflow.nsp_energy_axis'), showgrid: true, gridcolor: 'rgba(128,128,128,0.15)', color: ac },
    }), base_config())
    return () => { if (eos_plot_div && _Plotly) _Plotly.purge(eos_plot_div) }
  })

  // Engine task state
  let engine_task = $state<V2Task | null>(null)
  let engine_result = $state<Record<string, unknown> | null>(null)
  let confirming_task = $state(false)
  let rejecting_task = $state(false)

  // Derived TaskRef for adapter calls.
  // In step mode, if we have an engine_task (e.g. for PENDING_REVIEW confirm),
  // use task mode with the engine task's namespaced id (#227: task ids are
  // {workflow_id}:{node_id}, so never pass the bare node_id as a task_id).
  const task_ref = $derived<TaskRef>(
    mode === 'task' && task_id
      ? { mode: 'task', task_id }
      : engine_task
        ? { mode: 'task', task_id: engine_task.id }   // was: node_id
        : { mode: 'step', workflow_id, node_id }
  )

  // Effective values (engine task overrides props if available)
  const effective_node_type = $derived(
    mode === 'task' && engine_task ? engine_task.task_type : node_type
  )
  const effective_node_label = $derived(
    mode === 'task' && engine_task
      ? (engine_task.name ?? engine_task.task_type)
      : node_label
  )
  const effective_status = $derived(
    engine_task
      ? normalize_status(engine_task.status)
      : status
  )
  const effective_node_params = $derived.by(() => {
    if (mode === 'task' && engine_task?.params_json) {
      try { return JSON.parse(engine_task.params_json) } catch { return {} }
    }
    return node_params ?? {}
  })
  const effective_id = $derived(mode === 'task' ? task_id ?? '' : node_id)

  // ========== PHASE DETECTION ==========
  // Determine which workflow phase we're in based on status + mode

  /**
   * Review phase: User reviewing parameters before HPC submission
   * Active when engine_task.status='PENDING_REVIEW' (task mode) OR
   * when step status is 'pending_review' (step mode — engine task
   * auto-fetched below).
   */
  const in_review_phase = $derived(
    engine_task?.status === 'PENDING_REVIEW' ||
    (mode === 'step' && effective_status === 'pending_review')
  )

  /**
   * Execution phase: Workflow running on HPC
   * Active when: status in [queued, running]
   * Both modes display live monitoring in this phase
   */
  const in_execution_phase = $derived(
    status === 'running' || status === 'queued' ||
    effective_status === 'running' || effective_status === 'queued'
  )

  /**
   * Completion phase: Workflow finished (successfully or failed)
   * Active when: status in [completed, failed, not_converged]
   */
  const in_completion_phase = $derived(
    status === 'completed' || status === 'failed' || status === 'not_converged' ||
    effective_status === 'completed' || effective_status === 'failed' || effective_status === 'not_converged'
  )

  /**
   * Show review gate: Only in review phase
   * This is the "Review Required" banner with Confirm button
   */
  const show_review_gate = $derived(in_review_phase)

  /**
   * Show live monitoring: In execution phase and have real-time data
   * Works in both 'step' and 'task' modes
   */
  const show_live_monitoring = $derived(
    in_execution_phase && (step_message !== undefined || convergence !== null)
  )

  /**
   * Show task metadata: In task mode, after confirmation
   * Displays engine_task information (non-editable during execution)
   */
  const show_task_metadata = $derived(
    mode === 'task' && engine_task !== null && !in_review_phase
  )

  const VASP_KEYS = new Set([
    'ENCUT', 'EDIFF', 'EDIFFG', 'NSW', 'IBRION', 'ISIF', 'ISMEAR', 'SIGMA',
    'PREC', 'ALGO', 'LREAL', 'LWAVE', 'LCHARG', 'NELM', 'NELMIN', 'NCORE',
    'KPAR', 'ISPIN', 'MAGMOM', 'LDAU', 'LDAUU', 'LDAUJ', 'LDAUL', 'IVDW',
    'GGA', 'METAGGA', 'LASPH', 'LORBIT', 'NEDOS', 'EMIN', 'EMAX',
  ])

  // Params whose node-def `show_if` does NOT match the current params (e.g. a
  // VASP-only `kpoints`/`ENCUT` on an MLP node) are baked in by default_params
  // but irrelevant to the chosen software, so hide them from the readout. Keys
  // not present in the schema (custom params) are always kept.
  // Keys whose node-def show_if fails for the given params (e.g. VASP-only
  // kpoints/ENCUT on an MLP node). Shared by the params readout and the
  // pending-review gate so both hide the same irrelevant params.
  function compute_hidden_param_keys(
    node_type: string,
    node_params: Record<string, unknown>,
  ): Set<string> {
    const schema = NODE_DEFINITIONS[node_type]?.param_schema ?? []
    const hidden = new Set<string>()
    for (const param of schema) {
      if (!param.show_if) continue
      const conditions = Array.isArray(param.show_if) ? param.show_if : [param.show_if]
      const visible = conditions.every(cond =>
        cond.values.map(v => String(v)).includes(String(node_params[cond.key] ?? ``)))
      if (!visible) hidden.add(param.key)
    }
    return hidden
  }

  const _irrelevant_param_keys = $derived.by(() =>
    compute_hidden_param_keys(effective_node_type, effective_node_params))

  const vasp_param_entries = $derived.by(() => {
    const entries: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(effective_node_params)) {
      if (k === 'structure' || k === 'structure_json') continue
      if (_irrelevant_param_keys.has(k)) continue
      if (VASP_KEYS.has(k.toUpperCase())) entries[k] = v
    }
    return entries
  })

  const non_vasp_param_entries = $derived.by(() => {
    const entries: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(effective_node_params)) {
      if (k === 'structure' || k === 'structure_json') continue
      if (_irrelevant_param_keys.has(k)) continue
      if (!VASP_KEYS.has(k.toUpperCase())) entries[k] = v
    }
    return entries
  })

  // Restore cache when node_id changes (component reuse)
  $effect(() => {
    const cached = _files_cache.get(effective_id)
    if (cached) {
      files = cached.files
      work_dir = cached.work_dir
    }
  })
  // IRC trajectory: DON'T store in $state — causes infinite Plotly reactivity loop
  // Instead, load on-demand and pass directly to Trajectory component
  let irc_trajectory_content: string | null = null  // Normal variable, NOT $state
  let irc_trajectory_loaded = $state(false)
  let irc_trajectory_loading = $state(false)
  let irc_trajectory_data_url = $state<string | null>(null)

  // Retry from here
  let retry_loading = $state(false)
  let retry_message = $state(``)

  // NEB-TS tab switching
  let neb_active_tab = $state<'summary' | 'energies'>('summary')

  async function retry_from_here() {
    retry_loading = true
    retry_message = ``
    try {
      const res = await fetch(`${API_BASE}/workflow/${workflow_id}/steps/${node_id}/retry`, { method: `POST` })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }))
        retry_message = t('workflow.nsp_err_msg', { msg: err.detail || res.statusText })
        return
      }
      const data = await res.json()
      retry_message = t('workflow.nsp_retry_success', { count: data.reset_nodes.length })
      // Notify parent to refresh statuses
      if (onstatus_sync) onstatus_sync(node_id, `pending`)
    } catch (e: any) {
      retry_message = t('workflow.nsp_err_msg', { msg: e.message })
    } finally {
      retry_loading = false
    }
  }

  // VASP frequency data
  let vasp_freq_data = $state<VaspFrequencyData | null>(null)
  let vasp_freq_loading = $state(false)

  // Polling control (shared with StepFileTree via $bindable)
  let poll_enabled = $state(true)
  let poll_interval_ms = $state(15_000)

  // Directory expansion (shared with StepFileTree via $bindable)
  let expanded_dirs = $state<Record<string, FileEntry[]>>({})

  // Legacy VASP-only types (pre-migration) + unified types with software=vasp
  const VASP_ONLY_TYPES = new Set([
    `vasp_relax`, `vasp_static`, `vasp_md`, `bulk_opt`, `slab_relax`,
    `slab_gen`, `adsorbate_place`,
  ])
  // Unified types that can be VASP depending on software param
  const UNIFIED_CALC_TYPES = new Set([
    `geo_opt`, `single_point`, `cell_opt`, `md`, `freq`,
  ])

  const is_vasp = $derived(
    VASP_ONLY_TYPES.has(effective_node_type) ||
    (UNIFIED_CALC_TYPES.has(effective_node_type) && effective_node_params?.software === `vasp`)
  )
  const MLP_TYPES = new Set([`mlp_relax`, `mlp_md`])
  const is_mlp = $derived(
    MLP_TYPES.has(effective_node_type) ||
    (UNIFIED_CALC_TYPES.has(effective_node_type) && effective_node_params?.software === `mlp`)
  )

  // MLP subset that actually writes an ASE optimizer log (opt.log / neb.log).
  // mlp_vibrations runs finite-difference displacements — no iteration log.
  // mlp_single_point does one force/energy call — also no log.
  // Anything outside this set should NOT call get_mlp_progress or show
  // the "Optimizer Steps" / "NEB Iterations" counter.
  const MLP_OPTIMIZER_TYPES = new Set([`mlp_relax`, `mlp_md`, `mlp_neb`])
  const is_mlp_live = $derived(
    MLP_OPTIMIZER_TYPES.has(effective_node_type) ||
    ([`geo_opt`, `cell_opt`, `md`, `ts_search`].includes(effective_node_type) &&
      effective_node_params?.software === `mlp`)
  )
  // Node types that have ionic convergence (geo_opt family).
  // `ts_search` is included so MLP NEB nodes show their live CI-NEB
  // progress plot; the MLP variants `mlp_relax` / `mlp_neb` cover the
  // resolved-type path used by the V2 engine task view. Both read the
  // same ConvergencePoint shape the backend emits from ASE's opt.log
  // / neb.log, so the existing plot component handles them natively.
  const GEO_OPT_TYPES = new Set([
    `geo_opt`, `cell_opt`, `vasp_relax`, `bulk_opt`, `slab_relax`,
    `ts_search`, `mlp_relax`, `mlp_neb`,
  ])
  const has_convergence_goal = $derived(GEO_OPT_TYPES.has(effective_node_type))

  let has_batch_data = $state(false)

  // Only poll batch-summary for node types that use batch_subtasks (HPC batch execution).
  // Sub-graph nodes inside Map (Parallel) don't have batch_subtasks entries.
  const BATCH_NODE_TYPES = new Set([`geo_opt`, `single_point`, `cell_opt`, `md`, `freq`, `ts_search`])
  $effect(() => {
    if (!workflow_id || !node_id || !BATCH_NODE_TYPES.has(node_type)) return
    has_batch_data = false
    fetch(`${API_BASE}/workflow/${workflow_id}/steps/${node_id}/batch-summary`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { has_batch_data = !!(data && data.total > 0) })
      .catch(() => { has_batch_data = false })
  })

  const is_batch_node = $derived(
    node_type === `batch_adsorbate_place` || has_batch_data
  )

  // Fan-out sub-step detection from node_statuses record
  const sub_step_prefix = $derived(`${node_id}__sub_`)
  const sub_steps = $derived.by(() => {
    if (!node_statuses) return []
    const prefix = sub_step_prefix
    const entries: { index: number; status: string }[] = []
    for (const [key, st] of Object.entries(node_statuses)) {
      if (key.startsWith(prefix)) {
        const idx = parseInt(key.slice(prefix.length), 10)
        if (!isNaN(idx)) entries.push({ index: idx, status: st as string })
      }
    }
    entries.sort((a, b) => a.index - b.index)
    return entries
  })
  const sub_step_counts = $derived.by(() => {
    const c = { total: 0, completed: 0, running: 0, pending: 0, failed: 0 }
    for (const s of sub_steps) {
      c.total++
      if (s.status === `completed`) c.completed++
      else if (s.status === `running` || s.status === `queued` || s.status === `submitting`) c.running++
      else if (s.status === `failed`) c.failed++
      else c.pending++
    }
    return c
  })
  let sub_steps_expanded = $state(false)
  const SUB_STEP_COLLAPSE_THRESHOLD = 10

  // Display status: use status directly (DB now stores not_converged)
  // For completed geo_opt, validate with convergence data as extra check
  const display_status = $derived.by(() => {
    if (effective_status === `completed` && has_convergence_goal) {
      // Live convergence data available — validate
      if (convergence?.points.length && !is_actually_converged) return `not_converged`
    }
    return effective_status
  })
  const display_status_color = $derived(
    display_status ? STATUS_COLORS[display_status] ?? `#475569` : null
  )

  // HPC connection info: which cluster this step ran on
  // Match by session_id first; fall back to host match; then active-session fallback
  const hpc_sid = $derived(step_info?.hpc_session_id ?? (node_params?.hpc_session_id as string) ?? null)
  const hpc_host = $derived(step_info?.hpc_host ?? null)
  // Bug 5 fix: determine HPC step by node type, not just step_info fields
  // Calculator nodes (VASP/ORCA/CP2K etc.) inherently need HPC
  const HPC_NODE_TYPES = new Set([
    `vasp_relax`, `vasp_static`, `vasp_md`, `bulk_opt`, `slab_relax`,
    `geo_opt`, `single_point`, `cell_opt`, `md`, `freq`,
    `neb`, `ts_search`, `irc`, `uv_vis`, `tddft`,
  ])
  const is_hpc_step = $derived(
    HPC_NODE_TYPES.has(node_type) ||
    !!node_params?.software ||
    !!hpc_sid || !!step_info?.work_dir
  )
  const hpc_session = $derived.by(() => {
    const sessions = hpc_session_store.sessions
    // 1. Exact session_id match
    if (hpc_sid) {
      const exact = sessions.find(s => s.session_id === hpc_sid)
      if (exact) return exact
    }
    // 2. Match by host (handles reconnection with new session_id)
    if (hpc_host) {
      const byHost = sessions.find(s => `${s.username}@${s.host}` === hpc_host)
      if (byHost) return byHost
    }
    // 3. Bug 5 fix: for HPC node types, use any active session (not just single)
    if (is_hpc_step && sessions.length >= 1) {
      return sessions[0]
    }
    return null
  })
  // ssh_unavailable overrides session store — if API returns 503, connection is dead
  const hpc_connected = $derived(!!hpc_session && !ssh_unavailable)
  const hpc_label = $derived(hpc_session ? `${hpc_session.username}@${hpc_session.host}` : null)

  // Parse cached result_json from step_info (available even without SSH)
  interface CachedSummary {
    // VASP fields
    energy?: number
    max_force?: number
    converged?: boolean
    n_steps?: number
    has_contcar?: boolean
    extraction_error?: string
    validation_errors?: string[]
    // MLP/local fields
    contcar?: string
    stdout?: string
    work_dir?: string
    // ORCA fields
    energy_eh?: number
    energy_ev?: number
    max_gradient?: number
    rms_gradient?: number
    frequencies?: Array<{ index: number; frequency_cm: number; imaginary: boolean; ir_intensity_km_mol?: number }>
    num_imaginary?: number
    zpe_kj_mol?: number
    enthalpy_eh?: number
    entropy_j_mol_k?: number
    gibbs_eh?: number
    neb_converged?: boolean
    ts_converged?: boolean
    activation_barrier_kcal_mol?: number
    ts_imaginary_frequency?: number
    path_summary?: { images: Array<{ image: string; de_kcal_mol: number; is_ts?: boolean }> }
    irc_converged?: boolean
    forward_converged?: boolean
    backward_converged?: boolean
    convergence_thresholds?: { max_grad: number; rms_grad: number }
    forward_endpoint?: { final_energy: number }
    backward_endpoint?: { final_energy: number }
    reaction_coordinate_data?: { energy_range_kcal_mol: number }
    // UV-Vis fields
    transitions?: Array<{ state: number; wavelength_nm: number; oscillator_strength: number; energy_ev: number }>
    n_transitions?: number
    lowest_excitation_ev?: number
    lowest_excitation_nm?: number
    brightest_wavelength_nm?: number
    brightest_oscillator_strength?: number
    warnings?: string[]
    convergence_points?: Array<{ step: number; energy: number; [key: string]: unknown }>
    // Free energy correction fields
    G?: number
    E_DFT?: number
    ZPE?: number
    TS?: number
    temperature?: number
    // Batch results
    results?: Array<{ index?: number; label?: string; result?: { energy?: number; structure?: unknown }; status?: string; error?: string; work_dir?: string }>
    // MLP / HPC output structure string
    structure?: string
    // Energy diagram Plotly data
    plotly_data?: { traces: any[]; layout: any; annotations: any[] }
    // Gibbs energy node fields
    gibbs?: number | GibbsResult
    zpe?: number
    g_corr?: number
    h_corr?: number
    ts_correction?: number
    phase?: string
    n_real_freqs?: number
    n_imag_freqs?: number
    // C2: TS validation fields from mlp_vibrations
    imag_modes_cm?: number[]
    dominant_imag_freq_cm?: number | null
    is_valid_ts?: boolean
    n_nontrivial_imag?: number
    mode?: string
    // Energy comparison fields
    entries?: Array<{ rank: number; step_id: string; energy_eV: number; relative_meV_per_atom?: number }>
    n_compared?: number
    // Condition check fields
    condition_met?: boolean
    check_type?: string
    value?: number
    threshold?: number
    operator?: string
    // Pick best fields
    best_step_id?: string
    best_energy_eV?: number
    // Surface energy fields
    analysis_type?: string
    gamma_eV_per_A2?: number
    gamma_J_per_m2?: number
    surface_area_A2?: number
    slope_eV_per_atom?: number
    r_squared?: number
    per_facet?: Record<string, {
      gamma_eV_per_A2?: number
      gamma_J_per_m2?: number
      surface_area_A2?: number
      slope_eV_per_atom?: number
      r_squared?: number
      n_points?: number
      error?: string
    }>
    facet_summary?: string
    // Lineage — structure history breadcrumb
    _lineage?: Array<{ action: string; timestamp?: string }>
    // Convergence monitoring data (for live NEB/IRC/etc. monitoring)
    convergence_data?: {
      iteration?: number
      software?: string
      calc_type?: string
      points?: Array<{ step: number; energy: number; [key: string]: unknown }>
      converged?: boolean
      message?: string
      image_energies?: Record<number, Array<[number, number]>>
    }
  }
  /** Parse outputs_json from a V2 task_results row and merge into base object */
  function _merge_outputs_json(base: Record<string, any>): Record<string, any> {
    let merged: Record<string, any> = base
    if (typeof base.outputs_json === 'string' && base.outputs_json !== '{}') {
      try {
        const outputs = JSON.parse(base.outputs_json)
        if (outputs && typeof outputs === 'object') {
          merged = { ...base, ...outputs }
        }
      } catch { /* ignore malformed outputs_json */ }
    }
    // V2 engine writes output geometries (e.g. NEB-TS converged XYZ) to the
    // `structure_json` column rather than embedding them in outputs_json.
    // Surface it under the `structure` key the UI consults.
    if (!merged.structure && typeof merged.structure_json === 'string' && merged.structure_json.trim().length > 0) {
      merged = { ...merged, structure: merged.structure_json }
    }
    return merged
  }

  const cached_summary = $derived.by<CachedSummary>(() => {
    // Primary: step_info.result_json (V1 workflow_steps or V2 task mode)
    if (step_info?.result_json) {
      try {
        return _merge_outputs_json(JSON.parse(step_info.result_json))
      } catch (e) { console.warn(`[NodeStatusPanel] Failed to parse result_json for ${node_id}:`, e) }
    }
    // Fallback: V2 engine task_results (polled via workflow-execution, passed as task_results prop).
    // V2 engine never writes to workflow_steps, so result_json is empty for V2 tasks.
    // task_results[node_id] has the raw DB row with outputs_json containing rich data
    // (path_summary, neb_converged, frequencies, IRC convergence, etc.)
    if (results_data && typeof results_data === 'object') {
      return _merge_outputs_json(results_data)
    }
    return {}
  })

  // Check if this is an ORCA node (software backend)
  const is_orca = $derived(effective_node_params?.software === `orca`)

  // ORCA stage message: forwarded from WebSocket broadcast via step_message prop
  // Used by orca_freq (stage labels), orca_irc (phase + step counts), and orca_uvvis (excited states count)
  // Must be defined AFTER is_orca since it depends on it
  const orca_stage_message = $derived(
    (node_type === `orca_freq` || node_type === `orca_irc` || node_type === `uvvis` || node_type === `orca_uvvis` ||
     (node_type === `irc` && is_orca)) &&
    (status === `running` || status === `queued`)
      ? (step_message ?? null)
      : null
  )

  // Derived convergence info — use live data when available, cached data as fallback
  const nsw = $derived(Number(effective_node_params?.NSW) || 0)
  const ediffg = $derived(Number(effective_node_params?.EDIFFG) || 0)
  const current_step = $derived(convergence?.points.length ?? cached_summary.n_steps ?? 0)
  const latest = $derived(convergence && convergence.points.length > 0 ? convergence.points[convergence.points.length - 1] : null)

  // Client-side convergence validation: check actual forces/energy vs EDIFFG
  // VASP's "reached required accuracy" (server converged flag) is authoritative —
  // it accounts for selective dynamics (frozen atoms excluded from force check).
  // Client-side force/energy comparison is a fallback when the flag is unavailable.
  const is_actually_converged = $derived.by(() => {
    if (!is_vasp) return convergence?.converged ?? false
    if (!latest) return cached_summary.converged ?? false
    // Trust VASP's own convergence marker first
    if (convergence?.converged) return true
    if (ediffg < 0) {
      // Force-based: max_force must be < |EDIFFG|
      return latest.max_force > 0 && latest.max_force < Math.abs(ediffg)
    } else if (ediffg > 0) {
      // Energy-based: |dE| must be < EDIFFG
      return Math.abs(latest.dE) < ediffg
    }
    // No EDIFFG set — trust server
    return convergence?.converged ?? false
  })

  // Effective work_dir: from file listing or step_info DB field
  const effective_work_dir = $derived(work_dir || step_info?.work_dir || ``)

  // Reset convergence only when switching to a different node
  $effect(() => {
    const _id = node_id  // only depends on node_id
    void _id
    convergence = null
    vasp_freq_data = null
  })

  // Fetch data when node_id, status, or workflow_id changes
  let fetch_gen = 0
  $effect(() => {
    // Access reactive deps
    const _id = node_id
    const _status = status
    const _wf = workflow_id
    const _tid = task_id
    const _mode = mode
    if (_mode === 'task' && _tid) {
      const gen = ++fetch_gen
      fetch_data(gen)
      return
    }
    if (!_wf || !_id) return
    // Reset stale data from previously selected node
    files = _files_cache.get(_id)?.files ?? []
    work_dir = _files_cache.get(_id)?.work_dir ?? ``
    const gen = ++fetch_gen
    fetch_data(gen)
  })

  // When SSH becomes unavailable, refresh HPC session store to update badge
  $effect(() => {
    if (ssh_unavailable) refresh_hpc_sessions()
  })

  // Auto-refresh for running nodes
  $effect(() => {
    if (effective_status !== `running` && effective_status !== `queued`) return
    if (!poll_enabled) return
    const ms = poll_interval_ms
    const interval = setInterval(() => {
      const gen = ++fetch_gen
      fetch_data(gen)
    }, ms)
    return () => clearInterval(interval)
  })

  function manual_refresh() {
    const gen = ++fetch_gen
    fetch_data(gen)
  }

  let conv_loading = $state(false)
  let files_loading = $state(false)

  async function fetch_data(gen: number) {
    loading = true
    fetch_error = null
    ssh_unavailable = false

    const has_run = effective_status === `running` || effective_status === `queued` || effective_status === `completed` || effective_status === `not_converged` || effective_status === `failed` || effective_status === `pending_review` || effective_status === `retrying`

    // Engine task branch: load task metadata from V2 API
    if (mode === 'task' && task_id) {
      try {
        const data = await get_v2_task(task_id)
        if (gen !== fetch_gen) return
        engine_task = data.task
        step_info = {
          id: task_id,
          node_type: data.task.task_type,
          label: data.task.name ?? data.task.task_type,
          status: normalize_status(data.task.status) as any,
          config_json: data.task.params_json ?? '{}',
          hpc_job_id: data.task.hpc_job_id ?? undefined,
          work_dir: data.task.work_dir ?? undefined,
          started_at: data.task.created_at ?? undefined,
          result_json: null as any,
          error_message: data.task.error_message ?? undefined,
        } as StepInfo
        if (data.task.status === 'COMPLETED') {
          try {
            engine_result = await get_v2_task_result(task_id)
            if (engine_result) {
              step_info = { ...step_info, result_json: JSON.stringify(engine_result) } as StepInfo
            }
          } catch { engine_result = null }
        }
      } catch (err) {
        if (gen !== fetch_gen) return
        fetch_error = String(err)
      } finally {
        if (gen === fetch_gen) loading = false
      }
    } else {
      // Phase 1: Fast DB query — get step_info immediately (V1 path)
      try {
        const steps = await api.list_steps(workflow_id)
        if (gen !== fetch_gen) return
        step_info = steps?.find(s => s.id === node_id) ?? null
        // Sync DB status → parent if it's more advanced than the WebSocket-driven prop
        // (e.g., DB says "completed" but WS missed the event, prop still says "running")
        if (step_info?.status && status && step_info.status !== status) {
          const TERMINAL = new Set([`completed`, `not_converged`, `failed`])
          if (TERMINAL.has(step_info.status) && !TERMINAL.has(status)) {
            onstatus_sync?.(node_id, step_info.status)
          }
        }
      } catch (err) {
        if (gen !== fetch_gen) return
        fetch_error = String(err)
      } finally {
        if (gen === fetch_gen) loading = false
      }

      // In step mode, fetch/refresh the V2 engine task when it's relevant:
      // - pending_review: need confirm/reject buttons
      // - engine_task already loaded: keep it in sync (e.g. after confirmation)
      if (effective_status === 'pending_review' || status === 'pending_review' || engine_task) {
        try {
          const data = await get_v2_task(engine_task?.id ?? `${workflow_id}:${node_id}`)
          if (gen === fetch_gen) engine_task = data.task
        } catch {
          // Engine task not found — may be a V1-only workflow
          if (gen === fetch_gen && effective_status !== 'pending_review') engine_task = null
        }
      }
    }

    // Phase 2: Slow HPC calls — fire independently, update UI as each completes
    if (!has_run) return

    // Convergence (VASP / ORCA / MLP) — independent. is_mlp_live excludes
    // mlp_vibrations and mlp_single_point (no optimizer log).
    if (is_vasp || is_orca || is_mlp_live) {
      conv_loading = true
      const conv_promise = is_mlp_live
        ? adapter.get_mlp_progress(task_ref)
        : is_orca
        ? (effective_status === `running` || effective_status === `queued` || effective_status === `retrying`)
          ? adapter.get_orca_progress(task_ref)
          : (effective_status === `completed` || effective_status === `not_converged` || effective_status === `failed`)
          ? adapter.get_step_results(task_ref)
          : null
        : adapter.get_convergence(task_ref)

      if (conv_promise) {
        conv_promise.then(data => {
          if (gen !== fetch_gen || !data) return
          // Stale-while-revalidate: don't replace a populated convergence
          // plot with an empty-or-smaller response unless we detect a
          // genuine restart. Transient backend issues (log rotation, disk
          // flush mid-read, brief permission flip) would otherwise cause
          // the chart to unmount for one poll cycle — a visible ~500 ms
          // flicker on the 15 s tick.
          const new_points = data.points ?? []
          const cur_n = convergence?.points?.length ?? 0
          const cur_first = convergence?.points?.[0]
          const new_first = new_points[0]
          // Restart heuristic: new response has points AND the first-point
          // identity differs from what we're showing. This catches Reset
          // + Run where the new optimizer starts from step 0/1 and emits
          // a different energy than the previous run's step 0. Without
          // this check, the previous run's longer point list would lock
          // the chart on stale data until the new run surpassed it.
          const is_restart = (
            cur_n > 0
            && new_points.length > 0
            && cur_first != null
            && new_first != null
            && (cur_first.step !== new_first.step
                || Math.abs(cur_first.energy - new_first.energy) > 1e-6)
          )
          if (is_restart) {
            // Accept the new (shorter) series — user re-ran the step.
            convergence = { points: new_points, converged: data.converged ?? false, message: (data as any).message, convergence_thresholds: (data as any).convergence_thresholds, image_energies: (data as any).image_energies }
          } else if (new_points.length === 0 && cur_n > 0) {
            // Keep points; update converged/message metadata only.
            convergence = {
              points: convergence!.points,
              converged: data.converged ?? convergence!.converged,
              message: (data as any).message ?? convergence!.message,
              convergence_thresholds: (data as any).convergence_thresholds ?? (convergence as any)?.convergence_thresholds,
              image_energies: (data as any).image_energies ?? (convergence as any)?.image_energies,
            }
          } else if (new_points.length >= cur_n || cur_n === 0) {
            convergence = { points: new_points, converged: data.converged ?? false, message: (data as any).message, convergence_thresholds: (data as any).convergence_thresholds, image_energies: (data as any).image_energies }
          }
          // else: fewer points than we have but nonzero AND first-point
          // identity matches — probably a parse race. Keep current; next
          // tick will catch up.
          // Only mark SSH unavailable for connection errors, not missing files (e.g. OSZICAR not yet written)
          const err_msg = (data as any).error
          if (err_msg && !data.points?.length && /503|ssh|connect|session|unavailable/i.test(err_msg)) ssh_unavailable = true
          // Sync status based on convergence data
          if (data.points?.length > 0 && effective_status !== `failed`) {
            const job_done = data.converged || (nsw > 0 && data.points.length >= nsw)
            if (job_done) {
              const correct_status = has_convergence_goal && !data.converged
                ? `not_converged` : `completed`
              if (effective_status !== correct_status) {
                onstatus_sync?.(node_id, correct_status)
              }
            }
          }
        }).catch((e) => {
          console.warn(`[NodeStatusPanel] Convergence fetch failed for ${effective_id}:`, e)
        }).finally(() => { if (gen === fetch_gen) conv_loading = false })
      } else {
        conv_loading = false
      }
    }

    // Files — cache results so they survive tab switches (component remounts)
    files_loading = true
    adapter.get_files(task_ref).then(data => {
      if (gen !== fetch_gen) return
      if (data?.files?.length > 0) {
        files = data.files.map((f: any) => ({
          name: f.name,
          size: f.size,
          modified: f.modified,
          is_dir: f.is_dir,
          permissions: f.permissions,
        }))
        work_dir = data.work_dir ?? ``
        // Cache for remounts
        _files_cache.set(effective_id, { files, work_dir })
      } else if (data?.files?.length === 0 && (data as any).error) {
        ssh_unavailable = true
      } else if (data?.files?.length === 0) {
        // Node has no files — clear any stale cached data from previously selected node
        files = []
        work_dir = ``
        _files_cache.delete(effective_id)
      }
    }).catch((e) => {
      console.debug(`[NodeStatusPanel] Step files fetch failed (SSH may be unavailable):`, e)
      if (gen === fetch_gen) ssh_unavailable = true
    }).finally(() => { if (gen === fetch_gen) files_loading = false })

    // VASP frequency data — only for completed freq nodes
    if (effective_node_type === `freq` && is_vasp && effective_status === `completed` && !vasp_freq_data) {
      vasp_freq_loading = true
      adapter.get_frequencies(task_ref).then((data: any) => {
        if (gen === fetch_gen && data?.success) vasp_freq_data = data
      }).catch((e) => {
        console.warn(`[NodeStatusPanel] VASP frequency fetch failed for ${effective_id}:`, e)
      }).finally(() => { if (gen === fetch_gen) vasp_freq_loading = false })
    }
  }

  async function load_irc_trajectory() {
    irc_trajectory_loading = true
    try {
      const data = await api.get_irc_trajectory(workflow_id, node_id)
      // Store content temporarily (not in $state) to create data URL
      irc_trajectory_content = data.content
      // Create data URL directly — avoid storing in $state to prevent infinite Plotly loop
      irc_trajectory_data_url = `data:chemical/x-xyz;base64,${btoa(irc_trajectory_content)}`
      irc_trajectory_loaded = true
    } catch (err) {
      fetch_error = t('workflow.nsp_err_failed_load_irc', { err: String(err) })
    } finally {
      irc_trajectory_loading = false
    }
  }

  function format_time(iso?: string): string {
    if (!iso) return `—`
    try {
      const d = new Date(iso)
      return d.toLocaleString(undefined, { month: `short`, day: `numeric`, hour: `2-digit`, minute: `2-digit`, second: `2-digit` })
    } catch { return iso }
  }

  function format_energy(v: number | undefined): string {
    if (v === undefined || v === null) return '—'
    return v.toFixed(6)
  }

  function format_force(v: number): string {
    return v.toFixed(4)
  }

  function notify_job_event(new_status: string, label: string) {
    if (document.hasFocus()) return
    if (!('Notification' in window)) return
    if (Notification.permission === 'default') {
      Notification.requestPermission()
      return
    }
    if (Notification.permission !== 'granted') return

    const title = new_status === 'completed'
      ? `Job completed: ${label}`
      : `Job failed: ${label}`
    new Notification(title, {
      body: `CatGo workflow node "${label}" ${new_status}`,
      tag: `catgo-${effective_id}`,
    })
  }

  let prev_status = $state<string | null>(null)
  $effect(() => {
    const cur = effective_status
    if (prev_status && cur !== prev_status) {
      if (cur === 'completed' || cur === 'failed' || cur === 'not_converged') {
        notify_job_event(cur, effective_node_label)
      }
    }
    prev_status = cur ?? null
  })

  $effect(() => {
    load_i18n_module('workflow')
  })
</script>

<div class="status-panel dialog-modal">
  <!-- Header -->
  <div class="sp-header">
    <div class="sp-node-label">{effective_node_label}</div>
    <div class="sp-node-id">{effective_id.slice(0, 16)}</div>
    {#if display_status && display_status_color}
      <div class="sp-status-badge" style="background:{display_status_color}15;border-color:{display_status_color}40;color:{display_status_color}">
        <span class="sp-status-dot" class:running={effective_status === `running` || effective_status === `retrying`} style="background:{display_status_color}"></span>
        {display_status === `retrying` ? t('workflow.nsp_status_retrying_conn') : display_status}
      </div>
    {/if}
    {#if hpc_sid}
      <div class="sp-hpc-badge" class:connected={hpc_connected} class:disconnected={!hpc_connected}
           title={hpc_connected ? `${t('workflow.nsp_hpc_connected')}: ${hpc_label}` : `${t('workflow.nsp_hpc_not_connected')} — ${t('workflow.nsp_hpc_connect_hint')}`}>
        <span class="sp-hpc-dot"></span>
        {#if hpc_connected}
          {hpc_label}
        {:else}
          {t('workflow.nsp_hpc_not_connected')}
        {/if}
      </div>
    {/if}
  </div>

  {#if show_review_gate}
    <!-- ========== REVIEW PHASE ========== -->
    <div class="sp-section" style="background:rgba(245,158,11,0.1);border:1px solid #f59e0b;border-radius:8px;padding:12px;margin:8px 0;">
      <div style="color:#f59e0b;font-weight:600;margin-bottom:8px;">{t('workflow.nsp_review_required')}</div>
      <div style="color:var(--text-color-dim,#aaa);font-size:12px;margin-bottom:10px;">
        {t('workflow.nsp_review_hint')}
      </div>

      <!-- Parameter Review Section -->
      <div style="background:rgba(0,0,0,0.2);border-radius:6px;padding:10px;margin-bottom:10px;">
        <div style="font-size:12px;color:#ccc;margin-bottom:8px;">
          <strong>{t('workflow.nsp_params_to_review')}</strong>
        </div>
        {#if engine_task?.params_json}
          {@const params = (() => {
            try { return JSON.parse(engine_task.params_json) }
            catch { return {} }
          })()}
          {@const review_hidden = compute_hidden_param_keys(effective_node_type, params)}
          <div style="font-size:11px;color:#aaa;">
            {#each Object.entries(params) as [key, value]}
              {#if key !== 'structure' && key !== 'structure_json' && !review_hidden.has(key)}
                <div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.1);">
                  <span>{key}:</span>
                  <span style="color:#fff;font-weight:500;">
                    {typeof value === 'object' ? JSON.stringify(value) : value}
                  </span>
                </div>
              {/if}
            {/each}
          </div>
        {/if}
      </div>

      <!-- Confirm/Reject Actions -->
      <div style="display:flex;gap:8px;">
        <button
          style="background:#f59e0b;color:#000;border:none;border-radius:6px;padding:6px 16px;font-weight:600;cursor:pointer;flex:1;"
          onclick={async () => {
            const effective_tid = task_ref.mode === 'task' ? task_ref.task_id : null
            if (!is_valid_task_id(effective_tid)) {
              fetch_error = 'Invalid task ID'
              console.error('Task ID validation failed:', effective_tid)
              return
            }
            confirming_task = true
            try {
              await adapter.confirm(task_ref)
              // Optimistic update: clear stale engine_task so review banner hides immediately
              if (engine_task) {
                engine_task = { ...engine_task, status: 'READY' }
              }
              onconfirm?.()

              // Trust WebSocket to deliver status update
              // Only manually fetch if WebSocket doesn't arrive within 3 seconds
              await new Promise(r => setTimeout(r, 3000))

              // Always re-fetch engine_task after confirmation to get authoritative state
              const gen = ++fetch_gen
              await fetch_data(gen)
            } catch (e) {
              console.error('Confirmation failed:', e)
              fetch_error = String(e)
            } finally {
              confirming_task = false  // ✅ ALWAYS reset, even on success
            }
          }}
          disabled={confirming_task}
        >
          {confirming_task ? t('workflow.nsp_confirming') : t('workflow.nsp_confirm_submit')}
        </button>
        <button
          style="background:rgba(239,68,68,0.3);color:#ef4444;border:1px solid #ef4444;border-radius:6px;padding:6px 16px;font-weight:600;cursor:pointer;flex:1;"
          onclick={async () => {
            const effective_tid = task_ref.mode === 'task' ? task_ref.task_id : null
            if (!is_valid_task_id(effective_tid)) {
              fetch_error = 'Invalid task ID'
              console.error('Task ID validation failed:', effective_tid)
              return
            }
            if (rejecting_task) return  // ✅ Prevent double-click

            rejecting_task = true
            try {
              await adapter.reject(task_ref)
              fetch_error = null  // ✅ Clear previous errors

              // Wait for WebSocket or manual refresh
              await new Promise(r => setTimeout(r, 2000))
              if (!engine_task || engine_task.status !== 'PENDING_REVIEW') {
                // Task was successfully rejected
                const gen = ++fetch_gen
                await fetch_data(gen)
              }
            } catch (e) {
              console.error('Rejection failed:', e)
              fetch_error = `Rejection failed: ${e}`
            } finally {
              rejecting_task = false  // ✅ ALWAYS reset
            }
          }}
          disabled={rejecting_task}
        >
          {rejecting_task ? t('workflow.nsp_rejecting') : t('workflow.nsp_reject')}
        </button>
      </div>
    </div>
  {/if}

  {#if is_batch_node}
    <BatchStatusPanel {workflow_id} step_id={node_id} {status} />
  {/if}

  {#if sub_steps.length > 0}
    {@const batch_results = (() => {
      const results_arr = cached_summary.results as { index?: number; label?: string; result?: { energy?: number; structure?: unknown }; status?: string; error?: string; work_dir?: string }[] | undefined
      return sub_steps.map(sub => {
        const r = results_arr?.find(r => r.index === sub.index)
        return {
          index: sub.index,
          status: sub.status,
          label: r?.label,
          composition: r?.label,
          energy: r?.result?.energy as number | undefined,
          max_force: (r?.result as any)?.max_force as number | undefined,
          job_id: (cached_summary as any).job_id as string | undefined,
          work_dir: r?.work_dir as string | undefined,
          error: r?.error as string | undefined,
        }
      })
    })()}
    <div class="sp-section">
      <div class="sp-section-title">{t('workflow.nsp_batch_execution')}</div>
      <BatchStatusSection
        sub_steps={batch_results}
        {workflow_id}
        {node_id}
        onview_file={(work_dir) => {
          if (onview_file) onview_file(node_id, work_dir)
        }}
      />
    </div>
  {:else if Array.isArray((cached_summary as any).results) && (cached_summary as any).results.length > 0}
    {@const batch_results = ((cached_summary as any).results as any[]).map((r: any, idx: number) => ({
      index: r.index ?? idx,
      status: r.status ?? `completed`,
      label: r.label,
      composition: r.label,
      energy: (r.result?.energy ?? r.energy) as number | undefined,
      max_force: undefined as number | undefined,
      job_id: undefined as string | undefined,
      work_dir: (r.work_dir || r.result?.work_dir) as string | undefined,
      error: r.error as string | undefined,
      contcar: (r.result?.contcar) as string | undefined,
    }))}
    <div class="sp-section">
      <div class="sp-section-title">{t('workflow.nsp_batch_results')}</div>
      <BatchStatusSection
        sub_steps={batch_results}
        {workflow_id}
        {node_id}
        onview_file={(work_dir) => {
          if (onview_file) onview_file(node_id, work_dir)
        }}
      />
    </div>
  {/if}

  {#if (cached_summary as any).table}
    {@const agg_table = (cached_summary as any).table as Record<string, (number | string | null)[]>}
    {@const agg_labels = (agg_table[`label`] as string[] | undefined) ?? (cached_summary as any).labels as string[] ?? []}
    {@const agg_row_count = agg_labels.length || Math.max(0, ...Object.values(agg_table).map((col: any) => col?.length ?? 0))}
    {@const agg_columns = Object.keys(agg_table).filter(k => k !== `label` && k !== `index`)}
    <div class="sp-section">
      <div class="sp-section-title">{t('workflow.nsp_aggregate_results', { n: agg_labels.length })}</div>
      <div style="overflow-x: auto; font-size: 11px;">
        <table style="width: 100%; border-collapse: collapse;">
          <thead>
            <tr style="border-bottom: 1px solid var(--dialog-border, #404040);">
              <th style="text-align: left; padding: 4px 6px; color: var(--text-color-muted);">{t('workflow.editor_edge_label')}</th>
              {#each agg_columns as col}
                <th style="text-align: right; padding: 4px 6px; color: var(--text-color-muted);">{col}</th>
              {/each}
            </tr>
          </thead>
          <tbody>
            {#each agg_labels as label, i}
              <tr style="border-bottom: 1px solid var(--dialog-border, #333);">
                <td style="padding: 3px 6px; white-space: nowrap;">{label}</td>
                {#each agg_columns as col}
                  <td style="text-align: right; padding: 3px 6px; font-variant-numeric: tabular-nums;">
                    {typeof agg_table[col]?.[i] === `number` ? (agg_table[col][i] as number).toFixed(4) : agg_table[col]?.[i] ?? `—`}
                  </td>
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if (cached_summary as any).statistics}
        {@const stats = (cached_summary as any).statistics as Record<string, { min?: number; max?: number; mean?: number }>}
        <div style="margin-top: 8px; font-size: 10px; color: var(--text-color-dim);">
          {#each Object.entries(stats) as [key, s]}
            {#if s.min !== undefined}
              <div>{key}: min={s.min?.toFixed(4)}, max={s.max?.toFixed(4)}, mean={s.mean?.toFixed(4)}</div>
            {/if}
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  {#if loading && !step_info}
    <div class="sp-loading">{t('workflow.nsp_loading')}</div>
  {:else if !step_info && !effective_status}
    <div class="sp-empty">
      <div class="sp-empty-icon">📊</div>
      {#if hpc_sid && !hpc_connected}
        <div class="sp-empty-text">{t('workflow.nsp_hpc_not_connected')}</div>
        <div class="sp-empty-hint">{t('workflow.nsp_hpc_connect_hint')}</div>
      {:else}
        <div class="sp-empty-text">{t('workflow.nsp_no_data')}</div>
        <div class="sp-empty-hint">{t('workflow.nsp_run_hint')}</div>
      {/if}
    </div>
  {:else}
    <div class="sp-body">
      <!-- Execution Info -->
      {#if step_info}
        <div class="sp-section">
          <div class="sp-section-title">{t('workflow.nsp_execution')}</div>
          <div class="sp-info-grid">
            {#if step_info.hpc_job_id}
              <div class="sp-info-row">
                <span class="sp-info-label">{t('workflow.nsp_job_id')}</span>
                <span class="sp-info-value mono">{step_info.hpc_job_id}</span>
              </div>
            {/if}
            <div class="sp-info-row">
              <span class="sp-info-label">{t('workflow.nsp_started')}</span>
              <span class="sp-info-value">{format_time(step_info.started_at)}</span>
            </div>
            {#if status !== `running` && status !== `queued`}
              <div class="sp-info-row">
                <span class="sp-info-label">{t('workflow.nsp_completed')}</span>
                <span class="sp-info-value">{format_time(step_info.completed_at)}</span>
              </div>
            {/if}
            {#if effective_work_dir}
              <div class="sp-info-row">
                <span class="sp-info-label">{t('workflow.nsp_work_dir')}</span>
                <span class="sp-info-value mono truncate" title={effective_work_dir}>{effective_work_dir}</span>
              </div>
            {/if}
          </div>
        </div>
      {/if}

      <!-- Ionic Step Progress -->
      {#if is_vasp && nsw > 0 && current_step > 0}
        <div class="sp-section">
          <div class="sp-section-title">{t('workflow.nsp_ionic_steps')}</div>
          <div class="sp-progress-row">
            <span class="sp-progress-text">{current_step} / {nsw}</span>
            <span class="sp-progress-pct">{Math.round(current_step / nsw * 100)}%</span>
          </div>
          <div class="sp-progress-track">
            <div class="sp-progress-fill" style="width:{Math.min(current_step / nsw * 100, 100)}%"></div>
          </div>
        </div>
      {/if}

      <!-- ========== TASK METADATA (EXECUTION PHASE) ========== -->
      {#if show_task_metadata}
        <div class="sp-section" style="border:1px solid rgba(100,200,255,0.3);border-radius:8px;padding:12px;margin:8px 0;background:rgba(100,200,255,0.05);">
          <div style="font-size:12px;color:#64c8ff;font-weight:600;margin-bottom:8px;">{t('workflow.nsp_task_info')}</div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:11px;">
            {#if engine_task?.task_type}
              <div>
                <span style="color:#aaa;">{t('workflow.nsp_task_type')}</span>
                <div style="color:#fff;font-weight:500;">{engine_task.task_type}</div>
              </div>
            {/if}

            {#if engine_task?.hpc_job_id}
              <div>
                <span style="color:#aaa;">{t('workflow.nsp_task_hpc_job_id')}</span>
                <div style="color:#fff;font-family:monospace;">{engine_task.hpc_job_id}</div>
              </div>
            {/if}

            {#if engine_task?.work_dir}
              <div>
                <span style="color:#aaa;">{t('workflow.nsp_task_work_dir')}</span>
                <div style="color:#fff;font-family:monospace;font-size:10px;">{engine_task.work_dir}</div>
              </div>
            {/if}

            {#if engine_task?.created_at}
              <div>
                <span style="color:#aaa;">{t('workflow.nsp_task_created')}</span>
                <div style="color:#fff;">{new Date(engine_task.created_at).toLocaleString()}</div>
              </div>
            {/if}
          </div>
        </div>
      {/if}

      <!-- MLP: ionic-step counter mirroring the VASP block above. Uses the
           step's own max_steps target; labels match "N / max_steps" so a
           user glancing at a running NEB can see "187 / 500". Gated on
           is_mlp_live so freq (mlp_vibrations) and single-point nodes —
           which don't have iteration logs — never render this. -->
      {#if is_mlp_live && current_step > 0}
        {@const mlp_max = Number(effective_node_params?.max_steps) || 0}
        <div class="sp-section">
          <div class="sp-section-title">{effective_node_type === `ts_search` || effective_node_type === `mlp_neb` ? t('workflow.nsp_neb_iterations') : t('workflow.nsp_optimizer_steps')}</div>
          <div class="sp-progress-row">
            <span class="sp-progress-text">{current_step}{mlp_max > 0 ? ` / ${mlp_max}` : ``}</span>
            {#if mlp_max > 0}
              <span class="sp-progress-pct">{Math.round(current_step / mlp_max * 100)}%</span>
            {/if}
          </div>
          {#if mlp_max > 0}
            <div class="sp-progress-track">
              <div class="sp-progress-fill" style="width:{Math.min(current_step / mlp_max * 100, 100)}%"></div>
            </div>
          {/if}
        </div>
      {/if}

      <!-- Convergence loading indicator -->
      {#if conv_loading && !latest && !cached_summary.convergence_points?.length}
        <div class="sp-section">
          <div class="sp-section-title">{t('workflow.nsp_convergence')}</div>
          <div class="sp-inline-loading">{t('workflow.nsp_fetching_hpc')}</div>
        </div>
      {/if}

      <!-- MLP progress status message. Shown when the endpoint returned
           an informative message but no plottable points (e.g. log not
           created yet, HPC mode not wired, parser couldn't read log).
           Without this, the panel silently shows "Started" with no clue
           why the plot is empty. -->
      {#if is_mlp_live && !latest && convergence?.message}
        <div class="sp-section">
          <div class="sp-section-title">{t('workflow.nsp_live_progress')}</div>
          <div class="sp-inline-loading">{convergence.message}</div>
        </div>
      {/if}

      <!-- Energy & Force Convergence (live data from SSH) -->
      {#if latest}
        <div class="sp-section">
          <div class="sp-section-title">{is_orca && (status === `running` || status === `queued`) ? t('workflow.nsp_live_monitoring') : t('workflow.nsp_convergence')}</div>
          <div class="sp-info-grid">
            <div class="sp-info-row">
              <span class="sp-info-label">{is_orca ? t('workflow.nsp_energy_eh') : t('workflow.nsp_energy_ev')}</span>
              <span class="sp-info-value mono">{format_energy(latest.energy)}</span>
            </div>
            <div class="sp-info-row">
              <span class="sp-info-label">{(node_type === `irc` || node_type === `orca_irc`) ? t('workflow.nsp_de_kcal') : `d${is_vasp ? t('workflow.nsp_de_ev') : t('workflow.nsp_de_eh')}`}</span>
              <span class="sp-info-value mono" class:sp-positive={latest.dE > 0} class:sp-negative={latest.dE < 0}>
                {latest.dE >= 0 ? `+` : ``}{format_energy(latest.dE)}
              </span>
            </div>
            {#if (latest as any).max_gradient > 0}
              <div class="sp-info-row">
                <span class="sp-info-label">{t('workflow.nsp_max_grad')}</span>
                <span class="sp-info-value mono">{format_force((latest as any).max_gradient)}</span>
              </div>
            {/if}
            {#if (latest as any).rms_gradient > 0}
              <div class="sp-info-row">
                <span class="sp-info-label">{t('workflow.nsp_rms_grad')}</span>
                <span class="sp-info-value mono">{format_force((latest as any).rms_gradient)}</span>
              </div>
            {/if}
            {#if latest.max_force > 0}
              <div class="sp-info-row">
                <span class="sp-info-label">{is_orca ? t('workflow.nsp_max_gradient') : t('workflow.nsp_max_force')}</span>
                <span class="sp-info-value mono">{format_force(latest.max_force)}</span>
              </div>
              {#if is_vasp && ediffg < 0}
                <div class="sp-info-row">
                  <span class="sp-info-label">{t('workflow.nsp_target_ediffg')}</span>
                  <span class="sp-info-value mono">{format_force(Math.abs(ediffg))}</span>
                </div>
              {/if}
            {/if}
            {#if latest.rms_force > 0}
              <div class="sp-info-row">
                <span class="sp-info-label">{is_orca ? t('workflow.nsp_rms_gradient') : t('workflow.nsp_rms_force')}</span>
                <span class="sp-info-value mono">{format_force(latest.rms_force)}</span>
              </div>
            {/if}
            {#if is_orca && latest.max_step && latest.max_step > 0}
              <div class="sp-info-row">
                <span class="sp-info-label">{t('workflow.nsp_max_step')}</span>
                <span class="sp-info-value mono">{format_force(latest.max_step)}</span>
              </div>
            {/if}
            {#if is_orca && latest.rms_step && latest.rms_step > 0}
              <div class="sp-info-row">
                <span class="sp-info-label">{t('workflow.nsp_rms_step')}</span>
                <span class="sp-info-value mono">{format_force(latest.rms_step)}</span>
              </div>
            {/if}
          </div>

          <!-- Convergence chart -->
          {#if convergence && convergence.points.length >= 2}
            <div class="sp-convergence-chart">
              {#if node_type === `irc` || node_type === `orca_irc`}
                <IrcPathPlot
                  points={convergence.points as any}
                  convergence_thresholds={convergence.convergence_thresholds ?? { max_grad: 0.002, rms_grad: 0.0005 }}
                />
              {:else if is_vasp}
                <VaspMonitorPlot
                  points={convergence.points}
                  running={status === `running` || status === `queued`}
                  {ediffg}
                />
              {:else}
                <ConvergencePlot
                  points={convergence.points}
                  {is_orca}
                  running={status === `running` || status === `queued`}
                />
              {/if}
            </div>
          {/if}

          <!-- NEB per-image energies (live, from ORCA.interp) -->
          {#if (node_type === `ts_search` || node_type === `orca_neb_ts`) && is_orca && convergence?.image_energies && Object.keys(convergence.image_energies).length > 0}
            <div style="margin-top:8px">
              <ImageEnergyProfile image_energies={convergence.image_energies} />
              <div style="margin-top:8px">
                <ImageEnergyTable image_energies={convergence.image_energies} />
              </div>
            </div>
          {/if}

          <!-- Convergence flag (client-side validated) -->
          <!-- Freq nodes compute a Hessian, not an iterative optimization, so a
               convergence verdict is meaningless — suppress the flag entirely. -->
          {#if node_type === `freq` || node_type === `orca_freq`}
            {''}
          {:else if is_actually_converged}
            <div class="sp-conv-flag converged">{t('workflow.nsp_converged')}</div>
          {:else if status === `completed` || status === `not_converged` || status === `failed`}
            <div class="sp-conv-flag not-converged">{t('workflow.nsp_not_converged')}</div>
            <!-- Convergence failure guidance -->
            {#if is_vasp && convergence && convergence.points.length > 0}
              {@const last_p = convergence.points[convergence.points.length - 1]}
              <div class="sp-guidance">
                <div class="sp-guidance-title">{t('workflow.nsp_analysis')}</div>
                {#if ediffg < 0 && last_p.max_force > 0}
                  <div class="sp-guidance-reason">
                    {t('workflow.nsp_max_force_gt_target', { max_force: last_p.max_force.toFixed(4), target: Math.abs(ediffg).toFixed(4) })}
                  </div>
                {:else if ediffg > 0}
                  <div class="sp-guidance-reason">
                    {t('workflow.nsp_de_gt_target', { de: Math.abs(last_p.dE).toFixed(6), target: ediffg.toFixed(6) })}
                  </div>
                {/if}
                {#if nsw > 0 && convergence.points.length >= nsw}
                  <div class="sp-guidance-reason">
                    {t('workflow.nsp_reached_nsw_limit', { n: nsw })}
                  </div>
                {/if}
                <div class="sp-guidance-title" style="margin-top:6px">{t('workflow.nsp_suggestions')}</div>
                <ul class="sp-guidance-list">
                  {#if nsw > 0 && convergence.points.length >= nsw}
                    <li>{t('workflow.nsp_suggest_nsw', { nsw: nsw * 2 })}</li>
                  {/if}
                  {#if ediffg < 0 && last_p.max_force > 0 && last_p.max_force < Math.abs(ediffg) * 2}
                    <li>{t('workflow.nsp_suggest_ediffg_close', { ediffg: ediffg * 0.8 })}</li>
                  {:else if ediffg < 0 && last_p.max_force > Math.abs(ediffg) * 5}
                    <li>{t('workflow.nsp_suggest_far')}</li>
                  {/if}
                  <li>{t('workflow.nsp_suggest_opt')}</li>
                  <li>{t('workflow.nsp_suggest_potim')}</li>
                </ul>
              </div>
            {/if}
          {/if}
        </div>

        <!-- Force Visualization (VASP nodes with convergence data) -->
        {#if is_vasp && hpc_connected && (status === `completed` || status === `running`)}
          <div class="sp-section">
            <ForceViewerControls
              {workflow_id}
              {node_id}
              total_steps={convergence?.points.length ?? 0}
              {onload_forces}
            />
          </div>
        {/if}
      {:else if is_vasp && cached_summary.energy !== undefined}
        <!-- Fallback: cached results from DB (no SSH needed) -->
        <div class="sp-section">
          <div class="sp-section-title">{t('workflow.nsp_results_cached')}</div>
          <div class="sp-info-grid">
            <div class="sp-info-row">
              <span class="sp-info-label">{t('workflow.nsp_energy_ev')}</span>
              <span class="sp-info-value mono">{format_energy(cached_summary.energy!)}</span>
            </div>
            {#if cached_summary.max_force !== undefined && cached_summary.max_force! > 0}
              <div class="sp-info-row">
                <span class="sp-info-label">{t('workflow.nsp_max_force')}</span>
                <span class="sp-info-value mono">{format_force(cached_summary.max_force!)}</span>
              </div>
            {/if}
            {#if cached_summary.n_steps !== undefined}
              <div class="sp-info-row">
                <span class="sp-info-label">{t('workflow.nsp_ionic_steps')}</span>
                <span class="sp-info-value mono">{cached_summary.n_steps}{nsw > 0 ? ` / ${nsw}` : ``}</span>
              </div>
            {/if}
          </div>

          {#if cached_summary.converged === true}
            <div class="sp-conv-flag converged">{t('workflow.nsp_converged')}</div>
          {:else if cached_summary.converged === false}
            <div class="sp-conv-flag not-converged">{t('workflow.nsp_not_converged')}</div>
          {/if}

          {#if ssh_unavailable}
            <div class="sp-ssh-hint">{t('workflow.nsp_hpc_detail_hint')}</div>
          {/if}
        </div>
      {:else if is_vasp && (status === `completed` || status === `not_converged` || status === `failed`) && cached_summary.extraction_error}
        <!-- Extraction failed — VASP likely failed -->
        <div class="sp-section">
          <div class="sp-section-title">{t('workflow.nsp_results')}</div>
          <div class="sp-warn-box">{t('workflow.nsp_no_vasp_output')}</div>
          {#if ssh_unavailable}
            <div class="sp-ssh-hint">{t('workflow.nsp_hpc_inspect_hint')}</div>
          {/if}
        </div>
      {:else if is_orca && (cached_summary.energy_eh !== undefined || cached_summary.energy !== undefined || cached_summary.irc_converged !== undefined || cached_summary.transitions !== undefined || cached_summary.neb_converged !== undefined) && status !== `running` && status !== `queued`}
        <div class="sp-section">
          <div class="sp-section-title">{t('workflow.nsp_results_cached')}</div>
          <div class="sp-info-grid">
            <!-- Energy for all ORCA types except IRC (which has no single-point energy) -->
            {#if node_type !== `irc` && node_type !== `orca_irc`}
            <div class="sp-info-row">
              <span class="sp-info-label">{t('workflow.nsp_energy_eh')}</span>
              <span class="sp-info-value mono">{format_energy(cached_summary.energy_eh ?? cached_summary.energy)}</span>
            </div>
            <div class="sp-info-row">
              <span class="sp-info-label">{t('workflow.nsp_energy_ev')}</span>
              <span class="sp-info-value mono">
                {format_energy(cached_summary.energy_ev ?? ((cached_summary.energy_eh ?? cached_summary.energy ?? 0) * 27.2114))}
              </span>
            </div>
            {/if}

            <!-- geo_opt (ORCA) -->
            {#if node_type === `geo_opt` && is_orca}
              {#if cached_summary.n_steps}<div class="sp-info-row">
                <span class="sp-info-label">{t('workflow.nsp_opt_cycles')}</span>
                <span class="sp-info-value mono">{cached_summary.n_steps}</span>
              </div>{/if}
              {#if cached_summary.max_gradient != null}<div class="sp-info-row">
                <span class="sp-info-label">{t('workflow.nsp_max_gradient')}</span>
                <span class="sp-info-value mono">{cached_summary.max_gradient.toFixed(6)}</span>
              </div>{/if}
              {#if cached_summary.rms_gradient != null}<div class="sp-info-row">
                <span class="sp-info-label">{t('workflow.nsp_rms_gradient')}</span>
                <span class="sp-info-value mono">{cached_summary.rms_gradient.toFixed(6)}</span>
              </div>{/if}
              {#if cached_summary.converged === true}
                <div class="sp-conv-flag converged">{t('workflow.nsp_converged')}</div>
              {:else if cached_summary.converged === false}
                <div class="sp-conv-flag not-converged">{t('workflow.nsp_not_converged')}</div>
              {/if}
            {/if}

            <!-- single_point (ORCA) - convergence_points shows one point -->
            {#if node_type === `single_point` && is_orca}
              {#if cached_summary.converged === true}
                <div class="sp-conv-flag converged">{t('workflow.nsp_converged')}</div>
              {:else if cached_summary.converged === false}
                <div class="sp-conv-flag not-converged">{t('workflow.nsp_not_converged')}</div>
              {/if}
            {/if}

            <!-- freq (ORCA) -->
            {#if node_type === `orca_freq`}
              {#if status === `running` && orca_stage_message}
                <div class="orca-stage-label">{orca_stage_message}</div>
              {/if}
              {#if (cached_summary.num_imaginary ?? 0) > 0}
                <div class="imag-freq-warning">
                  {t('workflow.nsp_imag_freq_warn', { n: cached_summary.num_imaginary ?? 0 })}
                </div>
              {/if}
              {#if cached_summary.num_imaginary !== undefined}<div class="sp-info-row">
                <span class="sp-info-label">{t('workflow.nsp_imaginary_modes')}</span>
                <span class="sp-info-value mono">{cached_summary.num_imaginary}</span>
              </div>{/if}
              {#if cached_summary.zpe_kj_mol != null || cached_summary.gibbs_eh != null}
                <div class="thermo-table">
                  <div class="thermo-title">{t('workflow.nsp_thermochemistry')}</div>
                  <table>
                    {#if cached_summary.zpe_kj_mol != null}
                      <tr><td>{t('workflow.nsp_zpe')}</td><td>{cached_summary.zpe_kj_mol.toFixed(2)} kJ/mol</td></tr>
                    {/if}
                    {#if cached_summary.enthalpy_eh != null}
                      <tr><td>{t('workflow.nsp_enthalpy')}</td><td>{(cached_summary.enthalpy_eh * 2625.5).toFixed(2)} kJ/mol</td></tr>
                    {/if}
                    {#if cached_summary.entropy_j_mol_k != null}
                      <tr><td>{t('workflow.nsp_entropy')}</td><td>{(cached_summary.entropy_j_mol_k / 1000).toFixed(4)} kJ/(mol·K)</td></tr>
                    {/if}
                    {#if cached_summary.gibbs_eh != null}
                      <tr><td>{t('workflow.nsp_gibbs_corr')}</td><td>{(cached_summary.gibbs_eh * 2625.5).toFixed(2)} kJ/mol</td></tr>
                    {/if}
                  </table>
                </div>
              {/if}
              {#if cached_summary.frequencies?.length}
                <div class="sp-info-label" style="margin-top:6px">{t('workflow.nsp_freq_first_10')}</div>
                <div class="sp-freq-table">
                  {#each cached_summary.frequencies.filter(f => f.frequency_cm > 1.0).slice(0, 10) as f}
                    <div class="sp-freq-row" class:sp-freq-imag={f.imaginary}>
                      <span>{f.index}:</span>
                      <span class="mono">{f.frequency_cm.toFixed(1)}{f.imaginary ? ` i` : ``}</span>
                    </div>
                  {/each}
                </div>
              {/if}
            {/if}

            <!-- freq (VASP) -->
            {#if node_type === `freq` && is_vasp}
              {#if vasp_freq_loading}
                <div class="sp-info-row"><span class="sp-info-label">{t('workflow.nsp_loading')}</span></div>
              {:else if vasp_freq_data?.success}
                <div class="sp-info-row">
                  <span class="sp-info-label">{t('workflow.nsp_imaginary_modes')}</span>
                  <span class="sp-info-value mono" class:sp-freq-imag={vasp_freq_data.num_imaginary! > 0}>{vasp_freq_data.num_imaginary}</span>
                </div>
                {#if vasp_freq_data.imag_freqs?.length}
                  <div class="sp-info-label" style="margin-top:4px">{t('workflow.nsp_freq_imaginary')}</div>
                  <div class="sp-freq-table">
                    {#each vasp_freq_data.imag_freqs as f}
                      <div class="sp-freq-row sp-freq-imag">
                        <span>{f.index}:</span>
                        <span class="mono">{f.frequency_cm.toFixed(1)} i</span>
                      </div>
                    {/each}
                  </div>
                {/if}
                {#if vasp_freq_data.real_freqs?.length}
                  <div class="sp-info-label" style="margin-top:4px">{t('workflow.nsp_freq_real')}</div>
                  <div class="sp-freq-table">
                    {#each vasp_freq_data.real_freqs.slice(0, 15) as f}
                      <div class="sp-freq-row">
                        <span>{f.index}:</span>
                        <span class="mono">{f.frequency_cm.toFixed(1)}</span>
                      </div>
                    {/each}
                    {#if vasp_freq_data.real_freqs.length > 15}
                      <div class="sp-freq-row" style="color: #94a3b8; font-style: italic">
                        {t('workflow.nsp_freq_more', { n: vasp_freq_data.real_freqs.length - 15 })}
                      </div>
                    {/if}
                  </div>
                {/if}

                <!-- Pre-computed Gibbs result (from workflow params) -->
                {#if cached_summary.gibbs}
                  {@const g = cached_summary.gibbs as GibbsResult}
                  <div class="gibbs-auto-section">
                    <div class="gibbs-auto-title">
                      {t('workflow.nsp_gibbs_auto_title', { mode: g.mode === 'gas' ? t('workflow.nsp_gibbs_mode_gas') : t('workflow.nsp_gibbs_mode_adsorbed'), temp: g.temperature })}
                    </div>
                    <div class="sp-info-row">
                      <span class="sp-info-label">{t('workflow.nsp_gibbs_corr')}</span>
                      <span class="sp-info-value mono" style="color: #22c55e; font-weight: 600">{g.g_corr_ev.toFixed(6)} eV</span>
                    </div>
                    <div class="sp-info-row">
                      <span class="sp-info-label">{t('workflow.nsp_zpe')}</span>
                      <span class="sp-info-value mono">{g.zpe_ev.toFixed(6)} eV</span>
                    </div>
                    <div class="sp-info-row">
                      <span class="sp-info-label">{t('workflow.nsp_enthalpy')}</span>
                      <span class="sp-info-value mono">{g.h_corr_ev.toFixed(6)} eV</span>
                    </div>
                    {#if g.mode === 'adsorbed' && g.ts_vib_ev !== undefined}
                      <div class="sp-info-row">
                        <span class="sp-info-label">T×S_vib</span>
                        <span class="sp-info-value mono">{g.ts_vib_ev.toFixed(6)} eV</span>
                      </div>
                    {/if}
                    {#if g.mode === 'gas' && g.ts_total_ev !== undefined}
                      <div class="sp-info-row">
                        <span class="sp-info-label">T×S_total</span>
                        <span class="sp-info-value mono">{g.ts_total_ev.toFixed(6)} eV</span>
                      </div>
                    {/if}
                    <div class="gibbs-auto-hint">{t('workflow.nsp_gibbs_formula_hint')}</div>
                  </div>
                {/if}

                <!-- Interactive Gibbs Calculator (recalculate with different params) -->
                <GibbsCalculator
                  {workflow_id}
                  step_id={node_id}
                />

                <!-- Vibration Mode Selector -->
                {#if vasp_freq_data.eigenvectors?.length && vasp_freq_data.positions?.length}
                  <VibrationModeSelector
                    real_freqs={vasp_freq_data.real_freqs ?? []}
                    imag_freqs={vasp_freq_data.imag_freqs ?? []}
                    eigenvectors={vasp_freq_data.eigenvectors}
                    positions={vasp_freq_data.positions}
                    {onplay_vibration}
                    {onstop_vibration}
                  />
                {/if}
              {:else if vasp_freq_data && !vasp_freq_data.success}
                <div class="sp-info-row"><span class="sp-info-label" style="color:#ef4444">{vasp_freq_data.message ?? t('workflow.nsp_failed_load_freq')}</span></div>
              {/if}
            {/if}

            <!-- ts_search (ORCA) and orca_neb_ts (NEB) -->
            {#if (node_type === `ts_search` || node_type === `orca_neb_ts`) && is_orca}
              {#if cached_summary.activation_barrier_kcal_mol != null}<div class="sp-info-row">
                <span class="sp-info-label">{t('workflow.nsp_activation_barrier')}</span>
                <span class="sp-info-value mono">{cached_summary.activation_barrier_kcal_mol.toFixed(2)} kcal/mol</span>
              </div>{/if}
              {#if cached_summary.ts_imaginary_frequency != null}<div class="sp-info-row">
                <span class="sp-info-label">{t('workflow.nsp_ts_imag_freq')}</span>
                <span class="sp-info-value mono">{cached_summary.ts_imaginary_frequency.toFixed(1)} cm⁻¹</span>
              </div>{/if}
              {#if cached_summary.neb_converged}<div class="sp-conv-flag converged">{t('workflow.nsp_neb_converged')}</div>{/if}
              {#if cached_summary.ts_converged}<div class="sp-conv-flag converged">{t('workflow.nsp_ts_converged')}</div>{/if}
              {@const live_image_energies = convergence?.image_energies
                ?? cached_summary.convergence_data?.image_energies}
              {@const has_path_summary = !!cached_summary.path_summary?.images?.length}
              {@const has_image_energies = !!live_image_energies && Object.keys(live_image_energies).length > 0}
              {@const effective_neb_tab = (neb_active_tab === 'summary' && !has_path_summary && has_image_energies) ? 'energies' : neb_active_tab}
              {#if has_path_summary || has_image_energies}
                <div style="margin-top:8px">
                  <div class="neb-tabs">
                    {#if has_path_summary}
                      <button
                        class="neb-tab"
                        class:active={effective_neb_tab === 'summary'}
                        onclick={() => (neb_active_tab = 'summary')}
                      >
                        {t('workflow.we_summary')}
                      </button>
                    {/if}
                    <button
                      class="neb-tab"
                      class:active={effective_neb_tab === 'energies'}
                      onclick={() => (neb_active_tab = 'energies')}
                      disabled={!has_image_energies}
                    >
                      {t('workflow.nsp_path_energies')}
                    </button>
                  </div>

                  {#if effective_neb_tab === 'summary' && has_path_summary}
                    <div class="neb-tab-content">
                      <NEBPathPlot path_summary={cached_summary.path_summary} />
                      <details>
                        <summary class="sp-info-label" style="margin-top:6px">{t('workflow.nsp_path_summary_table')}</summary>
                        <div class="sp-neb-table">
                          {#each cached_summary.path_summary?.images ?? [] as img}
                            <div class="sp-neb-row" class:sp-neb-ts={img.is_ts}>
                              <span class="mono">{img.image}</span>
                              <span class="mono">{img.de_kcal_mol.toFixed(2)} kcal/mol</span>
                            </div>
                          {/each}
                        </div>
                      </details>
                    </div>
                  {:else if effective_neb_tab === 'energies' && has_image_energies}
                    <div class="neb-tab-content">
                      <ImageEnergyProfile
                        image_energies={live_image_energies}
                      />
                      <div style="margin-top:16px">
                        <ImageEnergyTable
                          image_energies={live_image_energies}
                        />
                      </div>
                    </div>
                  {/if}
                </div>
                <!-- NEB Energy Pathway Plot -->
                <NEBPathPlot
                  energies_ev={(cached_summary as any).energies_ev}
                  path_summary={cached_summary.path_summary}
                />
              {/if}
            {/if}

            <!-- irc (ORCA) -->
            {#if (node_type === `irc` || node_type === `orca_irc`) && is_orca}
              {#if cached_summary.irc_converged === true}
                <div class="sp-conv-flag converged">{t('workflow.nsp_irc_converged')}</div>
              {:else if cached_summary.irc_converged === false}
                <div class="sp-conv-flag not-converged">{t('workflow.nsp_irc_not_converged')}</div>
              {/if}
              {#if cached_summary.forward_converged === false}
                <div class="sp-info-row">
                  <span class="sp-info-label" style="color:#ef4444">{t('workflow.nsp_forward_arm')}</span>
                  <span class="sp-info-value" style="color:#ef4444">{t('workflow.nsp_did_not_converge')}</span>
                </div>
              {/if}
              {#if cached_summary.backward_converged === false}
                <div class="sp-info-row">
                  <span class="sp-info-label" style="color:#ef4444">{t('workflow.nsp_backward_arm')}</span>
                  <span class="sp-info-value" style="color:#ef4444">{t('workflow.nsp_did_not_converge')}</span>
                </div>
              {/if}
              {#if cached_summary.forward_endpoint?.final_energy !== undefined}<div class="sp-info-row">
                <span class="sp-info-label">{t('workflow.nsp_forward_endpoint')}</span>
                <span class="sp-info-value mono">{format_energy(cached_summary.forward_endpoint!.final_energy)} Eh</span>
              </div>{/if}
              {#if cached_summary.backward_endpoint?.final_energy !== undefined}<div class="sp-info-row">
                <span class="sp-info-label">{t('workflow.nsp_backward_endpoint')}</span>
                <span class="sp-info-value mono">{format_energy(cached_summary.backward_endpoint!.final_energy)} Eh</span>
              </div>{/if}
              {#if cached_summary.reaction_coordinate_data?.energy_range_kcal_mol !== undefined}<div class="sp-info-row">
                <span class="sp-info-label">{t('workflow.nsp_path_range')}</span>
                <span class="sp-info-value mono">{cached_summary.reaction_coordinate_data!.energy_range_kcal_mol.toFixed(2)} kcal/mol</span>
              </div>{/if}
              {#if status === `completed` || status === `not_converged` || status === `failed`}
                <div class="sp-info-row">
                  <button
                    class="sp-trajectory-button"
                    onclick={load_irc_trajectory}
                    disabled={irc_trajectory_loading || irc_trajectory_loaded}
                  >
                    {irc_trajectory_loading ? t('workflow.nsp_loading') : irc_trajectory_loaded ? t('workflow.nsp_loaded') : t('workflow.nsp_view_trajectory')}
                  </button>
                </div>
              {/if}
            {/if}

          </div>
        </div>

        <!-- Convergence plot for completed opt/sp/freq jobs -->
        {#if ((node_type === `geo_opt` || node_type === `single_point` || node_type === `freq`) && is_orca) && cached_summary.convergence_points?.length}
          <div class="sp-section">
            <div class="sp-section-title">{t('workflow.nsp_energy_convergence')}</div>
            <ConvergencePlot
              points={cached_summary.convergence_points as unknown as ConvergencePoint[]}
              is_orca={true}
            />
          </div>
        {/if}

        <!-- IRC path plots (energy profile + gradient convergence) -->
        {#if (node_type === `irc` || node_type === `orca_irc`) && is_orca && cached_summary.convergence_points?.length}
          <div class="sp-section">
            <div class="sp-section-title">{t('workflow.nsp_irc_path')}</div>
            <IrcPathPlot
              points={cached_summary.convergence_points}
              convergence_thresholds={cached_summary.convergence_thresholds ?? { max_grad: 0.002, rms_grad: 0.0005 }}
            />
          </div>
        {/if}

        <!-- IRC trajectory viewer — only render when explicitly loaded -->
        {#if (node_type === `irc` || node_type === `orca_irc`) && is_orca && irc_trajectory_data_url}
          <div class="sp-section">
            <div class="sp-section-title">{t('workflow.nsp_path_visualization')}</div>
            <div class="sp-trajectory-viewer">
              <Trajectory
                data_url={irc_trajectory_data_url}
              />
            </div>
          </div>
        {/if}

        {#if cached_summary.warnings?.length}
          <div class="sp-section">
            <div class="sp-section-title">{t('workflow.we_warnings')}</div>
            {#each cached_summary.warnings! as w}
              <div class="sp-warn-box">{w}</div>
            {/each}
          </div>
        {/if}

      {:else if is_orca && status === `running`}
        <div class="sp-section">
          <div class="sp-section-title">{t('workflow.nsp_live_monitoring')}</div>
          {#if node_type === `irc` || node_type === `orca_irc`}
            {@const live_irc_points = (convergence && convergence.points.length >= 2)
              ? convergence.points
              : (cached_summary.convergence_points && cached_summary.convergence_points.length >= 2
                  ? cached_summary.convergence_points
                  : null)}
            {@const live_irc_thresholds = convergence?.convergence_thresholds
              ?? cached_summary.convergence_thresholds
              ?? { max_grad: 0.002, rms_grad: 0.0005 }}
            {#if live_irc_points}
              <IrcPathPlot
                points={live_irc_points as unknown as Array<{ step: number | string; [key: string]: unknown }>}
                convergence_thresholds={live_irc_thresholds}
              />
            {:else}
              <div class="sp-ssh-hint">
                {orca_stage_message ?? (loading ? t('workflow.nsp_fetching_irc') : convergence?.message || t('workflow.nsp_irc_in_progress'))}
              </div>
            {/if}
          {:else if node_type === `uvvis`}
            <div class="sp-ssh-hint">
              {loading ? t('workflow.nsp_fetching_tddft') : (orca_stage_message ?? (convergence?.message || t('workflow.nsp_computing_excited')))}
            </div>
          {:else if node_type === `orca_neb_ts` || (node_type === `ts_search` && is_orca)}
            <div class="sp-ssh-hint">
              {loading ? t('workflow.nsp_fetching_neb') : convergence?.message || t('workflow.nsp_neb_in_progress')}
            </div>
          {:else}
            <!-- Default for opt/sp/freq -->
            {#if latest}
              <ConvergencePlot
                points={convergence?.points ?? []}
                is_orca={true}
                running={status === `running` || status === `queued`}
              />
            {:else}
              <div class="sp-ssh-hint">
                {loading ? t('workflow.nsp_fetching_live') : t('workflow.nsp_no_conv_data')}
              </div>
            {/if}
          {/if}
        </div>

      {:else if is_orca && (status === `completed` || status === `not_converged` || status === `failed`)}
        <div class="sp-section">
          <div class="sp-section-title">{t('workflow.nsp_results')}</div>
          <div class="sp-warn-box">{t('workflow.nsp_no_orca_output')}</div>
        </div>

      {:else if is_mlp && (status === `completed` || status === `failed`)}
        <div class="sp-section">
          <div class="sp-section-title">{t('workflow.nsp_results')}</div>
          <div class="sp-info-grid">
            {#if cached_summary.energy !== undefined}
              <div class="sp-info-row sp-energy-highlight">
                <span class="sp-info-label">{t('workflow.nsp_energy_ev')}</span>
                <span class="sp-info-value mono">{format_energy(cached_summary.energy!)}</span>
              </div>
            {/if}
            {#if cached_summary.work_dir}
              <div class="sp-info-row">
                <span class="sp-info-label">{t('workflow.nsp_work_dir')}</span>
                <span class="sp-info-value mono truncate" title={cached_summary.work_dir}>{cached_summary.work_dir}</span>
              </div>
            {/if}
            <!-- NEB results for MLP TS Search -->
            {#if node_type === `ts_search` && is_mlp}
              {#if cached_summary.activation_barrier_kcal_mol !== undefined}
                <div class="sp-info-row sp-energy-highlight">
                  <span class="sp-info-label">{t('workflow.nsp_activation_barrier')}</span>
                  <span class="sp-info-value mono">{cached_summary.activation_barrier_kcal_mol!.toFixed(2)} kcal/mol</span>
                </div>
              {/if}
              {#if cached_summary.neb_converged}<div class="sp-conv-flag converged">{t('workflow.nsp_neb_converged')}</div>{/if}
              {#if cached_summary.path_summary?.images?.length}
                <div class="sp-info-label" style="margin-top:6px">{t('workflow.nsp_neb_images')}</div>
                <div class="sp-neb-table">
                  {#each cached_summary.path_summary.images as img}
                    <div class="sp-neb-row" class:sp-neb-ts={img.is_ts}>
                      <span class="mono">{img.image}</span>
                      <span class="mono">{img.de_kcal_mol.toFixed(2)} kcal/mol</span>
                    </div>
                  {/each}
                </div>
              {/if}
              <!-- NEB Energy Pathway Plot (reactive $effect in script) -->
              {#if (cached_summary as any).energies_ev?.length > 1 || cached_summary.path_summary?.images?.length}
                <NEBPathPlot
                  energies_ev={(cached_summary as any).energies_ev}
                  path_summary={cached_summary.path_summary}
                />
              {/if}
            {/if}
            <!-- MLP Frequency table -->
            {#if node_type === `freq` && is_mlp}
              {@const mlp_freq = cached_summary as any}
              {#if mlp_freq.is_valid_ts !== undefined}<div class="sp-info-row">
                <span class="sp-info-label">{t('workflow.nsp_ts_validation')}</span>
                {#if mlp_freq.is_valid_ts}
                  <span class="sp-info-value mono" style="color: #22c55e" title={t('workflow.nsp_validation_desc_valid')}>
                    {t('workflow.nsp_valid_ts', { freq: mlp_freq.dominant_imag_freq_cm != null ? Math.abs(mlp_freq.dominant_imag_freq_cm).toFixed(1) + ' cm⁻¹ i' : '' })}
                  </span>
                {:else}
                  <span class="sp-info-value mono" style="color: #f59e0b" title={t('workflow.nsp_validation_desc_invalid')}>
                    {t('workflow.nsp_invalid_ts', { n: mlp_freq.n_nontrivial_imag ?? 0 })}
                  </span>
                {/if}
              </div>{/if}
              {#if mlp_freq.n_imag_freqs !== undefined}<div class="sp-info-row">
                <span class="sp-info-label">{t('workflow.nsp_imaginary_modes')}</span>
                <span class="sp-info-value mono" style="color: {mlp_freq.n_imag_freqs > 0 ? '#f59e0b' : '#22c55e'}">{mlp_freq.n_imag_freqs}</span>
              </div>{/if}
              {#if mlp_freq.zpe !== undefined}<div class="sp-info-row">
                <span class="sp-info-label">{t('workflow.nsp_zpe')} (eV)</span>
                <span class="sp-info-value mono">{Number(mlp_freq.zpe).toFixed(4)}</span>
              </div>{/if}
              {#if mlp_freq.n_frequencies !== undefined}<div class="sp-info-row">
                <span class="sp-info-label">{t('workflow.nsp_total_modes')}</span>
                <span class="sp-info-value mono">{mlp_freq.n_frequencies}</span>
              </div>{/if}
              {#if mlp_freq.frequencies?.length}
                <div class="sp-info-label" style="margin-top:6px">{t('workflow.nsp_frequencies_cm')}</div>
                <div class="sp-freq-table">
                  {#each (mlp_freq.frequencies as number[]).filter((f: number) => Math.abs(f) > 1.0).slice(0, 20) as f, i}
                    <div class="sp-freq-row" class:sp-freq-imag={f < 0}>
                      <span>{i}:</span>
                      <span class="mono">{Math.abs(f).toFixed(1)}{f < 0 ? ` i` : ``}</span>
                    </div>
                  {/each}
                </div>
              {/if}
            {/if}
          </div>
          {#if cached_summary.stdout}
            <details class="sp-stdout-details">
              <summary>{t('workflow.nsp_calc_log')}</summary>
              <pre class="sp-stdout-pre">{cached_summary.stdout}</pre>
            </details>
          {/if}
        </div>

        <!-- Output files: MLP / VASP write CONTCAR (POSCAR); ORCA writes XYZ -->
        {@const mlp_contcar = cached_summary.contcar || cached_summary.structure}
        {@const mlp_contcar_is_xyz = !!mlp_contcar && /^\s*\d+\s*$/.test(mlp_contcar.split(/\r?\n/, 1)[0] ?? '')}
        {@const mlp_contcar_filename = mlp_contcar_is_xyz ? 'output.xyz' : 'CONTCAR'}
        {#if mlp_contcar || cached_summary.work_dir}
          <div class="sp-section">
            <div class="sp-section-title">{t('workflow.nsp_output_files')}</div>
            <div class="sp-file-list">
              {#if mlp_contcar}
                <button class="sp-file-btn" onclick={() => {
                  download(mlp_contcar!, mlp_contcar_filename, 'text/plain')
                }}>
                  <span class="sp-file-icon">📄</span>
                  <span class="sp-file-name">{mlp_contcar_filename}</span>
                  <span class="sp-file-desc">{t('workflow.nsp_optimized_structure')}</span>
                </button>
              {/if}
              {#if cached_summary.stdout}
                <button class="sp-file-btn" onclick={() => {
                  download(cached_summary.stdout!, 'output.log', 'text/plain')
                }}>
                  <span class="sp-file-icon">📋</span>
                  <span class="sp-file-name">output.log</span>
                  <span class="sp-file-desc">{t('workflow.nsp_calc_log')}</span>
                </button>
              {/if}
              {#if mlp_contcar}
                <button class="sp-file-btn sp-file-load" onclick={() => {
                  view_structure_error = null
                  try {
                    if (!mlp_contcar || mlp_contcar.trim().length === 0) {
                    view_structure_error = t('workflow.nsp_err_empty_struct')
                      return
                    }
                    const parsed = mlp_contcar_is_xyz ? parse_xyz(mlp_contcar) : parse_poscar(mlp_contcar)
                    if (!parsed) {
                      const preview = mlp_contcar.slice(0, 80).replace(/\n/g, '\\n')
                      view_structure_error = t('workflow.nsp_err_parse_struct', { type: mlp_contcar_is_xyz ? 'XYZ' : 'POSCAR', preview })
                      console.error(`[NodeStatusPanel] parser returned null for ${mlp_contcar_is_xyz ? 'XYZ' : 'POSCAR'} payload of ${mlp_contcar.length} bytes`)
                      return
                    }
                    pending_open_structure.structure = parsed
                    pending_open_structure.label = node_label
                    pending_open_structure.seq++
                    console.info(`[NodeStatusPanel] View Structure: opened ${parsed.sites?.length ?? 0} sites in new tab`)
                  } catch (err) {
                    console.error(`[NodeStatusPanel] View Structure failed:`, err)
                    view_structure_error = t('workflow.nsp_err_failed_load_struct', { err: err instanceof Error ? err.message : String(err) })
                  }
                }}>
                  <span class="sp-file-icon">🔬</span>
                  <span class="sp-file-name">{t('workflow.nsp_view_structure')}</span>
                  <span class="sp-file-desc">{t('workflow.nsp_open_structure_hint')}</span>
                </button>
                {#if view_structure_error}
                  <div class="sp-error-box" style="margin-top: 6px; padding: 8px; font-size: 13px; line-height: 1.4; background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.4); border-radius: 4px; color: #ef4444;" role="alert">{view_structure_error}</div>
                {/if}
              {/if}
            </div>
          </div>
        {/if}
      {/if}

      <!-- Validation warnings -->
      {#if cached_summary.validation_errors?.length}
        <div class="sp-section">
          <div class="sp-section-title">{t('workflow.we_warnings')}</div>
          {#each cached_summary.validation_errors! as err}
            <div class="sp-warn-box">{err}</div>
          {/each}
        </div>
      {/if}

      <!-- Auto-retry continuation badge (Prompt 37) -->
      {#if step_info?.error_message?.includes('Auto-continuing')}
        <div class="sp-section">
          <div class="sp-continuation-badge">
            {t('workflow.nsp_auto_continuing')}
          </div>
          <div class="sp-info-grid">
            <div class="sp-info-row">
              <span class="sp-info-label">{t('workflow.nsp_attempt')}</span>
              <span class="sp-info-value mono">
                {step_info.error_message.match(/\((\d+\/\d+)\)/)?.[1] ?? '?'}
              </span>
            </div>
          </div>
        </div>
      {/if}

      <!-- Error Message (hide stale errors from previous job runs) -->
      {#if step_info?.error_message && status !== `running` && status !== `queued`}
        {@const current_job = step_info.hpc_job_id}
        {@const error_mentions_other_job = current_job && /job\s+(\d+)/i.test(step_info.error_message) && !step_info.error_message.includes(current_job)}
        {#if !error_mentions_other_job}
          <div class="sp-section">
            <div class="sp-section-title">{t('workflow.we_error')}</div>
            <div class="sp-error-box">{step_info.error_message}</div>
          </div>
        {/if}
      {/if}

      <!-- Rerun from here: resets this node + all downstream to pending -->
      {#if status === `failed` || status === `not_converged`}
        <div class="sp-section">
          <button
            class="sp-retry-button"
            disabled={retry_loading}
            onclick={retry_from_here}
          >
            {retry_loading ? t('workflow.nsp_resetting') : t('workflow.nsp_rerun')}
          </button>
          {#if retry_message}
            <div class="sp-retry-message">{retry_message}</div>
          {/if}
        </div>
      {/if}

      {#if mode === 'task' && engine_task && !['COMPLETED', 'FAILED', 'CANCELLED'].includes(engine_task.status)}
        <div class="sp-section">
          <button class="sp-retry-button" style="border-color:#ef4444;color:#ef4444;" onclick={async () => {
            try {
              await adapter.cancel(task_ref)
              const gen = ++fetch_gen
              fetch_data(gen)
            } catch (e) { fetch_error = String(e) }
          }}>
            {t('workflow.nsp_cancel_task')}
          </button>
        </div>
      {/if}

      <!-- Free Energy Correction results (Prompt 29) -->
      {#if node_type === `free_energy` && cached_summary.G !== undefined}
        <div class="sp-section">
          <div class="sp-section-title">{t('workflow.nsp_free_energy_corr')}</div>
          <div class="sp-info-grid">
            <div class="sp-info-row">
              <span class="sp-info-label">G (Gibbs)</span>
              <span class="sp-info-value mono">{cached_summary.G!.toFixed(4)} eV</span>
            </div>
            {#if cached_summary.E_DFT !== undefined}
              <div class="sp-info-row">
                <span class="sp-info-label">E_DFT</span>
                <span class="sp-info-value mono">{cached_summary.E_DFT!.toFixed(4)} eV</span>
              </div>
            {/if}
            {#if cached_summary.ZPE !== undefined}
              <div class="sp-info-row">
                <span class="sp-info-label">ZPE</span>
                <span class="sp-info-value mono">{cached_summary.ZPE!.toFixed(4)} eV</span>
              </div>
            {/if}
            {#if cached_summary.TS !== undefined}
              <div class="sp-info-row">
                <span class="sp-info-label">T×S</span>
                <span class="sp-info-value mono">{cached_summary.TS!.toFixed(4)} eV</span>
              </div>
            {/if}
            {#if cached_summary.temperature !== undefined}
              <div class="sp-info-row">
                <span class="sp-info-label">{t('workflow.nsp_temperature')}</span>
                <span class="sp-info-value mono">{cached_summary.temperature} K</span>
              </div>
            {/if}
          </div>

          <!-- Energy Diagram (Plotly) -->
          {#if cached_summary.plotly_data}
            <div class="sp-diagram-section">
              <EnergyDiagramPlot plotly_data={cached_summary.plotly_data} height={350} />
            </div>
          {/if}
        </div>
      {/if}

      <!-- Gibbs Energy node results -->
      {#if node_type === `gibbs_energy` && cached_summary.gibbs !== undefined}
        <div class="sp-section">
          <div class="sp-section-title">{t('workflow.nsp_gibbs_free_energy')}</div>

          <!-- Formula display -->
          <div class="sp-formula-box">
            <span class="sp-formula">{t('workflow.nsp_gibbs_formula_hint')}</span>
          </div>

          <div class="sp-info-grid">
            <div class="sp-info-row">
              <span class="sp-info-label">{t('workflow.nsp_gibbs_free_energy')}</span>
              <span class="sp-info-value mono sp-highlight">{(cached_summary.gibbs as number).toFixed(4)} eV</span>
            </div>
            {#if cached_summary.energy !== undefined}
              <div class="sp-info-row">
                <span class="sp-info-label">{t('workflow.nsp_energy_ev')}</span>
                <span class="sp-info-value mono">{cached_summary.energy!.toFixed(4)} eV</span>
              </div>
            {/if}
            {#if cached_summary.zpe !== undefined}
              <div class="sp-info-row">
                <span class="sp-info-label">{t('workflow.nsp_zpe')}</span>
                <span class="sp-info-value mono">+{cached_summary.zpe!.toFixed(4)} eV</span>
              </div>
            {/if}
            {#if cached_summary.ts_correction !== undefined}
              <div class="sp-info-row">
                <span class="sp-info-label">T×S</span>
                <span class="sp-info-value mono">-{cached_summary.ts_correction!.toFixed(4)} eV</span>
              </div>
            {/if}
            {#if cached_summary.g_corr !== undefined}
              <div class="sp-info-row">
                <span class="sp-info-label">{t('workflow.nsp_gibbs_corr')}</span>
                <span class="sp-info-value mono">{cached_summary.g_corr! >= 0 ? `+` : ``}{cached_summary.g_corr!.toFixed(4)} eV</span>
              </div>
            {/if}
          </div>

          <div class="sp-info-grid" style="margin-top: 6px; opacity: 0.8;">
            {#if cached_summary.temperature !== undefined}
              <div class="sp-info-row">
                <span class="sp-info-label">{t('workflow.nsp_temperature')}</span>
                <span class="sp-info-value mono">{cached_summary.temperature} K</span>
              </div>
            {/if}
            {#if cached_summary.phase}
              <div class="sp-info-row">
                <span class="sp-info-label">{t('workflow.nsp_phase')}</span>
                <span class="sp-info-value mono">
                  {cached_summary.phase === `adsorbed` ? t('workflow.nsp_phase_adsorbed') : t('workflow.nsp_phase_gas')}
                </span>
              </div>
            {/if}
            {#if cached_summary.n_real_freqs !== undefined}
              <div class="sp-info-row">
                <span class="sp-info-label">{t('workflow.nsp_frequencies')}</span>
                <span class="sp-info-value mono">
                  {#if cached_summary.n_imag_freqs}
                    {t('workflow.nsp_freqs_real_imag', { real: cached_summary.n_real_freqs, imag: cached_summary.n_imag_freqs })}
                  {:else}
                    {t('workflow.nsp_freqs_real_only', { real: cached_summary.n_real_freqs })}
                  {/if}
                </span>
              </div>
            {/if}
          </div>
        </div>
      {/if}

      <!-- Surface Energy results -->
      {#if node_type === `surface_energy`}
        {@const se = (cached_summary as any).summary ?? cached_summary}
        {#if se.analysis_type === `surface_energy`}
        <div class="sp-section">
          <div class="sp-section-title">{t('workflow.nsp_surface_energy')}</div>

          {#if se.per_facet}
            {@const facets = Object.keys(se.per_facet).sort()}
            <table class="sp-energy-table">
              <thead><tr><th>{t('workflow.nsp_facet')}</th><th>{t('workflow.nsp_gamma_j_m2')}</th><th>{t('workflow.nsp_gamma_ev_a2')}</th><th>{t('workflow.nsp_r_squared')}</th><th>{t('workflow.nsp_points')}</th></tr></thead>
              <tbody>
                {#each facets as fk}
                  {@const fd = se.per_facet[fk]}
                  <tr>
                    <td>({fk})</td>
                    <td class="mono" style="color: #22c55e; font-weight: 600">{fd.gamma_J_per_m2?.toFixed(4) ?? '—'}</td>
                    <td class="mono">{fd.gamma_eV_per_A2?.toFixed(6) ?? '—'}</td>
                    <td class="mono">{fd.r_squared?.toFixed(4) ?? '—'}</td>
                    <td class="mono">{fd.n_points ?? '—'}</td>
                  </tr>
                {/each}
              </tbody>
            </table>

            {#if facets.length >= 2}
              <div style="margin-top: 8px; font-size: 11px; opacity: 0.7;">
                {t('workflow.nsp_energy_ordering')} {facets
                  .filter(f => se.per_facet[f]?.gamma_J_per_m2 != null)
                  .sort((a: string, b: string) => se.per_facet[a].gamma_J_per_m2 - se.per_facet[b].gamma_J_per_m2)
                  .map((f: string) => `(${f})`)
                  .join(' < ')}
              </div>
            {/if}

            <!-- Per-facet linear fit plot -->
            <SurfaceEnergyPlot per_facet={se.per_facet} />

          {:else if se.gamma_J_per_m2 !== undefined}
            <div class="sp-info-grid">
              <div class="sp-info-row">
                <span class="sp-info-label">γ</span>
                <span class="sp-info-value mono sp-highlight">{se.gamma_J_per_m2.toFixed(4)} J/m²</span>
              </div>
              <div class="sp-info-row">
                <span class="sp-info-label">γ</span>
                <span class="sp-info-value mono">{se.gamma_eV_per_A2?.toFixed(6)} eV/Å²</span>
              </div>
              <div class="sp-info-row">
                <span class="sp-info-label">{t('workflow.nsp_r_squared')}</span>
                <span class="sp-info-value mono">{se.r_squared?.toFixed(4)}</span>
              </div>
              <div class="sp-info-row">
                <span class="sp-info-label">{t('workflow.nsp_slope_e_atom')}</span>
                <span class="sp-info-value mono">{se.slope_eV_per_atom?.toFixed(6)} eV</span>
              </div>
              <div class="sp-info-row">
                <span class="sp-info-label">{t('workflow.nsp_area')}</span>
                <span class="sp-info-value mono">{se.surface_area_A2?.toFixed(2)} Å²</span>
              </div>
            </div>
          {/if}
        </div>
        {/if}
      {/if}

      <!-- Wulff Construction results -->
      {#if node_type === `wulff_construction`}
        {@const wf = (cached_summary as any).summary ?? cached_summary}
        {#if wf.analysis_type === `wulff_construction`}
        <div class="sp-section">
          <div class="sp-section-title">{t('workflow.nsp_wulff_construction')}</div>

          {#if wf.facet_table}
            <table class="sp-energy-table">
              <thead><tr><th>{t('workflow.nsp_facet')}</th><th>{t('workflow.nsp_area_percent')}</th><th>{t('workflow.nsp_gamma_j_m2')}</th></tr></thead>
              <tbody>
                {#each wf.facet_table as row}
                  <tr>
                    <td>({row.facet})</td>
                    <td class="mono" style="color: #22c55e; font-weight: 600">{row.area_percent?.toFixed(1)}%</td>
                    <td class="mono">{row.gamma_J_per_m2?.toFixed(4) ?? '—'}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {/if}

          <div class="sp-info-grid" style="margin-top: 8px;">
            {#if wf.dominant_facet}
              <div class="sp-info-row">
                <span class="sp-info-label">{t('workflow.nsp_dominant_facet')}</span>
                <span class="sp-info-value mono sp-highlight">({wf.dominant_facet})</span>
              </div>
            {/if}
            {#if wf.weighted_surface_energy_J_per_m2 !== undefined}
              <div class="sp-info-row">
                <span class="sp-info-label">{t('workflow.nsp_weighted_gamma')}</span>
                <span class="sp-info-value mono">{wf.weighted_surface_energy_J_per_m2.toFixed(4)} J/m²</span>
              </div>
            {/if}
            {#if wf.effective_radius_A !== undefined}
              <div class="sp-info-row">
                <span class="sp-info-label">{t('workflow.nsp_eff_radius')}</span>
                <span class="sp-info-value mono">{wf.effective_radius_A.toFixed(2)} Å</span>
              </div>
            {/if}
            {#if wf.volume_A3 !== undefined}
              <div class="sp-info-row">
                <span class="sp-info-label">{t('workflow.nsp_volume')}</span>
                <span class="sp-info-value mono">{wf.volume_A3.toFixed(2)} Å³</span>
              </div>
            {/if}
          </div>

          <!-- Wulff area fraction bar chart -->
          {#if wf.facet_table && wf.facet_table.length > 0}
            <WulffPlot
              facet_table={wf.facet_table}
              dominant_facet={wf.dominant_facet}
              weighted_surface_energy_J_per_m2={wf.weighted_surface_energy_J_per_m2}
            />
          {/if}
          {#if wf.wulff_facets_3d?.length}
            <div class="sp-section-title" style="margin-top: 12px">{t('workflow.nsp_3d_np_shape')}</div>
            <WulffShape3D facets_3d={wf.wulff_facets_3d} />
          {/if}
        </div>
        {/if}
      {/if}

      <!-- Adsorption Energy results -->
      {#if node_type === `adsorption_energy`}
        {@const ae = (cached_summary as any).summary ?? cached_summary}
        {#if ae.analysis_type === `adsorption_energy`}
        <div class="sp-section">
          <div class="sp-section-title">{t('workflow.nsp_adsorption_energy')}</div>
          <div class="sp-info-grid">
            <div class="sp-info-row">
              <span class="sp-info-label">E<sub>ads</sub></span>
              <span class="sp-info-value mono sp-highlight" style="color: {ae.E_ads_eV < 0 ? '#22c55e' : '#ef4444'}; font-weight: 600; font-size: 14px;">
                {ae.E_ads_eV.toFixed(4)} eV
              </span>
            </div>
            <div class="sp-info-row">
              <span class="sp-info-label">{t('workflow.nsp_binding')}</span>
              <span class="sp-info-value mono">
                {ae.binding === 'exothermic' ? t('workflow.nsp_binding_exothermic') : t('workflow.nsp_binding_endothermic')}
              </span>
            </div>
          </div>

          <div class="sp-info-grid" style="margin-top: 8px; opacity: 0.8;">
            <div class="sp-info-row">
              <span class="sp-info-label">E(slab+ads)</span>
              <span class="sp-info-value mono">{ae.E_slab_adsorbate_eV.toFixed(4)} eV {ae.n_atoms_slab_adsorbate ? `(${t('workflow.we_atoms_count', { n: ae.n_atoms_slab_adsorbate })})` : ''}</span>
            </div>
            <div class="sp-info-row">
              <span class="sp-info-label">E(clean slab)</span>
              <span class="sp-info-value mono">{ae.E_clean_slab_eV.toFixed(4)} eV {ae.n_atoms_clean_slab ? `(${t('workflow.we_atoms_count', { n: ae.n_atoms_clean_slab })})` : ''}</span>
            </div>
            {#if ae.E_reference_eV !== undefined}
              <div class="sp-info-row">
                <span class="sp-info-label">E(ref) × {ae.reference_coefficient}</span>
                <span class="sp-info-value mono">{(ae.reference_coefficient * ae.E_reference_eV).toFixed(4)} eV {ae.n_atoms_reference ? `(${t('workflow.we_atoms_count', { n: ae.n_atoms_reference })})` : ''}</span>
              </div>
            {/if}
          </div>

          {#if ae.E_ads_ZPE_eV !== undefined}
          <div class="sp-info-grid" style="margin-top: 12px;">
            <div class="sp-section-title" style="font-size: 12px; margin-bottom: 4px;">{t('workflow.nsp_zpe_correction')}</div>
            <div class="sp-info-row">
              <span class="sp-info-label">E<sub>ads</sub> (ZPE)</span>
              <span class="sp-info-value mono sp-highlight" style="color: {ae.E_ads_ZPE_eV < 0 ? '#22c55e' : '#ef4444'}; font-weight: 600; font-size: 14px;">
                {ae.E_ads_ZPE_eV.toFixed(4)} eV
              </span>
            </div>
            <div class="sp-info-row">
              <span class="sp-info-label">ΔZPE</span>
              <span class="sp-info-value mono">{ae.dZPE_eV?.toFixed(4) ?? 'N/A'} eV</span>
            </div>
            {#if ae.ZPE_slab_adsorbate_eV !== undefined}
              <div class="sp-info-row">
                <span class="sp-info-label">ZPE(slab+ads)</span>
                <span class="sp-info-value mono">{ae.ZPE_slab_adsorbate_eV.toFixed(4)} eV</span>
              </div>
            {/if}
            {#if ae.ZPE_clean_slab_eV !== undefined}
              <div class="sp-info-row">
                <span class="sp-info-label">ZPE(slab)</span>
                <span class="sp-info-value mono">{ae.ZPE_clean_slab_eV.toFixed(4)} eV</span>
              </div>
            {/if}
            {#if ae.ZPE_reference_eV !== undefined}
              <div class="sp-info-row">
                <span class="sp-info-label">ZPE(ref) × {ae.reference_coefficient ?? 0.5}</span>
                <span class="sp-info-value mono">{((ae.reference_coefficient ?? 0.5) * ae.ZPE_reference_eV).toFixed(4)} eV</span>
              </div>
            {/if}
            {#if ae.binding_zpe}
              <div class="sp-info-row">
                <span class="sp-info-label">{t('workflow.nsp_binding_zpe')}</span>
                <span class="sp-info-value mono">
                  {ae.binding_zpe === 'exothermic' ? t('workflow.nsp_binding_exothermic') : t('workflow.nsp_binding_endothermic_zpe')}
                </span>
              </div>
            {/if}
          </div>
          {/if}
        </div>
        {/if}
      {/if}

      <!-- Coverage Analysis results -->
      {#if node_type === `coverage_analysis`}
        {@const ca = (cached_summary as any).summary ?? cached_summary}
        {#if ca.analysis_type === `coverage_analysis`}
        <div class="sp-section">
          <div class="sp-section-title">{t('workflow.nsp_coverage_analysis')}</div>
          {#if ca.fit}
            <div class="sp-info-grid">
              <div class="sp-info-row">
                <span class="sp-info-label">{t('workflow.nsp_slope')}</span>
                <span class="sp-info-value mono">{ca.fit.slope?.toFixed(3)} eV/ML</span>
              </div>
              <div class="sp-info-row">
                <span class="sp-info-label">{t('workflow.nsp_intercept_zero')}</span>
                <span class="sp-info-value mono sp-highlight">{ca.fit.intercept?.toFixed(3)} eV</span>
              </div>
              <div class="sp-info-row">
                <span class="sp-info-label">{t('workflow.nsp_r_squared')}</span>
                <span class="sp-info-value mono">{ca.fit.r_squared?.toFixed(4)}</span>
              </div>
            </div>
          {/if}
          {#if ca.coverages?.length}
            <table class="sp-energy-table" style="margin-top: 8px">
              <thead><tr><th>{t('workflow.nsp_theta_ml')}</th><th>{t('workflow.nsp_n_ads')}</th><th>{t('workflow.nsp_e_ads_per_h')}</th></tr></thead>
              <tbody>
                {#each ca.coverages as theta, i}
                  <tr>
                    <td class="mono">{theta.toFixed(3)}</td>
                    <td class="mono">{ca.adsorbate_counts?.[i] ?? '\u2014'}</td>
                    <td class="mono" style="color: {ca.e_ads_per_h?.[i] < 0 ? '#22c55e' : '#ef4444'}">{ca.e_ads_per_h?.[i]?.toFixed(4) ?? '\u2014'}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {/if}
          <CoverageDependencePlot
            coverages={ca.coverages}
            e_ads_per_h={ca.e_ads_per_h}
            fit={ca.fit}
            fit_curve={ca.fit_curve}
            species={ca.species}
          />
        </div>
        {/if}
      {/if}

      <!-- EOS Analysis results -->
      {#if node_type === `eos_analysis`}
        {@const eos = (cached_summary as any).summary ?? cached_summary}
        {#if eos.analysis_type === `eos` && eos.data_points?.length}
        <div class="sp-section">
          <div class="sp-section-title">{t('workflow.nsp_eos')}</div>
          {#if eos.V0}
            <div class="sp-info-grid">
              <div class="sp-info-row">
                <span class="sp-info-label">V&sub;0</span>
                <span class="sp-info-value mono">{eos.V0.toFixed(2)} &Aring;&sup3;</span>
              </div>
              <div class="sp-info-row">
                <span class="sp-info-label">E&sub;0</span>
                <span class="sp-info-value mono sp-highlight">{eos.E0.toFixed(4)} eV</span>
              </div>
              {#if eos.B0}
                <div class="sp-info-row">
                  <span class="sp-info-label">B&sub;0</span>
                  <span class="sp-info-value mono">{eos.B0.toFixed(1)} GPa</span>
                </div>
              {/if}
            </div>
          {/if}
          <div class="sp-inline-plot" bind:this={eos_plot_div}></div>
        </div>
        {/if}
      {/if}

      <!-- Energy Comparison results (Prompt 29) -->
      {#if node_type === `energy_compare` && cached_summary.entries?.length}
        <div class="sp-section">
          <div class="sp-section-title">
            {t('workflow.nsp_energy_compare')} ({t('workflow.we_n_structures', { n: cached_summary.n_compared ?? cached_summary.entries!.length })})
          </div>
          <table class="sp-energy-table">
            <thead>
              <tr>
                <th>{t('workflow.nsp_rank')}</th>
                <th>{t('workflow.nsp_step')}</th>
                <th>{t('workflow.nsp_energy_ev')}</th>
                <th>{t('workflow.nsp_relative_energy')}</th>
              </tr>
            </thead>
            <tbody>
              {#each cached_summary.entries! as entry}
                <tr class:sp-best-row={entry.rank === 1}>
                  <td>{entry.rank}</td>
                  <td>{entry.step_id.slice(0, 8)}</td>
                  <td class="mono">{entry.energy_eV.toFixed(4)}</td>
                  <td class="mono">{entry.relative_meV_per_atom?.toFixed(1) ?? '—'}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}

      <!-- Condition Check results (Prompt 29) -->
      {#if cached_summary.condition_met !== undefined}
        <div class="sp-section">
          <div class="sp-section-title">{t('workflow.nsp_condition_check')}</div>
          <div class="sp-info-grid">
            <div class="sp-info-row">
              <span class="sp-info-label">{t('workflow.nsp_result')}</span>
              <span class="sp-info-value">
                {cached_summary.condition_met ? t('workflow.nsp_condition_met') : t('workflow.nsp_condition_not_met')}
              </span>
            </div>
            {#if cached_summary.check_type}
              <div class="sp-info-row">
                <span class="sp-info-label">{cached_summary.check_type}</span>
                <span class="sp-info-value mono">{cached_summary.value} {cached_summary.operator} {cached_summary.threshold}</span>
              </div>
            {/if}
          </div>
        </div>
      {/if}

      <!-- Pick Best results (Prompt 29) -->
      {#if node_type === `pick_best` && cached_summary.best_energy_eV !== undefined}
        <div class="sp-section">
          <div class="sp-section-title">{t('workflow.nsp_best_structure')}</div>
          <div class="sp-info-grid">
            {#if cached_summary.best_step_id}
              <div class="sp-info-row">
                <span class="sp-info-label">{t('workflow.nsp_best_step')}</span>
                <span class="sp-info-value mono">{cached_summary.best_step_id.slice(0, 8)}</span>
              </div>
            {/if}
            <div class="sp-info-row">
              <span class="sp-info-label">{t('workflow.we_energy')}</span>
              <span class="sp-info-value mono">{cached_summary.best_energy_eV!.toFixed(4)} eV</span>
            </div>
          </div>
        </div>
      {/if}

      <!-- UV-Vis results stats (separate since UV-Vis doesn't have energy_eh) -->
      {#if is_orca && node_type === `uvvis` && cached_summary.transitions?.length && (status === `completed` || status === `not_converged` || status === `failed`)}
        <div class="sp-section">
          <div class="sp-section-title">{t('workflow.nsp_results_cached')}</div>
          <div class="sp-info-grid">
            {#if cached_summary.lowest_excitation_nm !== undefined}<div class="sp-info-row">
              <span class="sp-info-label">{t('workflow.nsp_lowest_excitation')}</span>
              <span class="sp-info-value mono">{cached_summary.lowest_excitation_nm!.toFixed(1)} nm ({cached_summary.lowest_excitation_ev!.toFixed(3)} eV)</span>
            </div>{/if}
            {#if cached_summary.brightest_wavelength_nm !== undefined}<div class="sp-info-row">
              <span class="sp-info-label">{t('workflow.nsp_brightest_peak')}</span>
              <span class="sp-info-value mono">{cached_summary.brightest_wavelength_nm!.toFixed(1)} nm (f={cached_summary.brightest_oscillator_strength!.toFixed(4)})</span>
            </div>{/if}
            <div class="sp-info-row">
              <span class="sp-info-label">{t('workflow.nsp_transitions_count')}</span>
              <span class="sp-info-value mono">{cached_summary.n_transitions}</span>
            </div>
          </div>
        </div>
      {/if}

      <!-- UV-Vis absorption spectrum chart -->
      {#if node_type === `uvvis` && cached_summary.transitions?.length && status !== `running`}
        <div class="sp-section">
          <div class="sp-section-title">{t('workflow.nsp_absorption_spectrum')}</div>
          <UvVisPlot transitions={cached_summary.transitions!} />
        </div>
      {/if}

      {#if mode === 'task' && engine_result && !cached_summary.energy && !cached_summary.energy_eh}
        {@const result_entries = Object.entries(engine_result).filter(([k, v]) =>
          v !== null && v !== undefined && k !== 'task_id' && k !== 'workflow_id' && k !== 'structure_json' && k !== 'outputs_json'
        )}
        {#if result_entries.length > 0}
          <div class="sp-section">
            <div class="sp-section-title">{t('workflow.we_result')}</div>
            <div class="sp-info-grid">
              {#each result_entries as [k, v]}
                <div class="sp-info-row">
                  <span class="sp-info-label">{k}</span>
                  <span class="sp-info-value mono">{typeof v === 'number' ? v.toFixed(6) : String(v).slice(0, 80)}</span>
                </div>
              {/each}
            </div>
          </div>
        {/if}
      {/if}

      <!-- ORCA Task Results Display -->
      {#if show_results}
        <div class="results-section">
          {#if results_data.type === 'orca_freq'}
            <div class="sp-section">
              <div class="sp-section-title">{t('workflow.nsp_vibrational_frequencies')}</div>

              <!-- Frequency spectrum plot -->
              <ResultsPlot
                {...({
                  frequencies: results_data.frequencies,
                  intensities: results_data.intensities,
                  type: `ir_spectrum`,
                } as any)}
              />

              <!-- Frequency table -->
              <div class="frequencies-table">
                <h4>{t('workflow.nsp_frequency_details')}</h4>
                <table>
                  <thead>
                    <tr>
                      <th>{t('workflow.nsp_mode')}</th>
                      <th>{t('workflow.nsp_frequencies_cm')}</th>
                      <th>{t('workflow.nsp_type')}</th>
                      <th>{t('workflow.nsp_ir_intensity')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {#each results_data.frequencies as freq, i}
                      <tr>
                        <td>{i + 1}</td>
                        <td>{freq.toFixed(2)}</td>
                        <td>
                          {#if Array.isArray(results_data.intensities) && results_data.intensities[i]}
                            {t('workflow.nsp_freq_type_real')}
                          {:else}
                            {t('workflow.nsp_freq_type_imag')}
                          {/if}
                        </td>
                        <td>
                          {#if Array.isArray(results_data.intensities) && results_data.intensities[i]}
                            {results_data.intensities[i].toFixed(2)}
                          {:else}
                            —
                          {/if}
                        </td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>

              <!-- Thermochemistry if available -->
              {#if results_data.thermochemistry}
                <div class="thermochemistry">
                  <h4>{t('workflow.nsp_thermochemistry')}</h4>
                  <dl>
                    {#if results_data.thermochemistry.zero_point_energy !== undefined}
                      <dt>{t('workflow.nsp_zero_point_energy')}</dt>
                      <dd>{results_data.thermochemistry.zero_point_energy.toFixed(6)} eV</dd>
                    {/if}
                    {#if results_data.thermochemistry.enthalpy !== undefined}
                      <dt>{t('workflow.nsp_enthalpy')}</dt>
                      <dd>{results_data.thermochemistry.enthalpy.toFixed(6)} eV</dd>
                    {/if}
                    {#if results_data.thermochemistry.entropy !== undefined}
                      <dt>{t('workflow.nsp_entropy')}</dt>
                      <dd>{results_data.thermochemistry.entropy.toFixed(6)} J/(mol·K)</dd>
                    {/if}
                    {#if results_data.thermochemistry.gibbs_free_energy !== undefined}
                      <dt>{t('workflow.nsp_gibbs_free_energy')}</dt>
                      <dd>{results_data.thermochemistry.gibbs_free_energy.toFixed(6)} eV</dd>
                    {/if}
                  </dl>
                </div>
              {/if}
            </div>
          {/if}

          {#if results_data.type === 'orca_irc'}
            <div class="sp-section">
              <div class="sp-section-title">{t('workflow.nsp_irc_reaction_path')}</div>

              <!-- IRC energy profile plot -->
              <ResultsPlot
                {...({
                  energies: results_data.energies,
                  forward_steps: results_data.forward_steps,
                  backward_steps: results_data.backward_steps,
                  type: `irc_energy_profile`,
                } as any)}
              />

              <!-- IRC statistics -->
              <div class="irc-statistics">
                <h4>{t('workflow.nsp_path_statistics')}</h4>
                <dl>
                  <dt>{t('workflow.nsp_forward_steps')}</dt>
                  <dd>{results_data.forward_steps}</dd>
                  <dt>{t('workflow.nsp_backward_steps')}</dt>
                  <dd>{results_data.backward_steps}</dd>
                  <dt>{t('workflow.nsp_total_points')}</dt>
                  <dd>{results_data.energies?.length || 0}</dd>
                </dl>
              </div>
            </div>
          {/if}

          {#if results_data.error}
            <div class="sp-section">
              <div class="sp-error-box">
                <strong>{t('workflow.nsp_err_result_parsing')}</strong>
                <p>{results_data.error}</p>
              </div>
            </div>
          {/if}
        </div>
      {/if}

      {#if Object.keys(vasp_param_entries).length > 0}
        <div class="sp-section">
          <div class="sp-section-title">{t('workflow.nsp_vasp_parameters')}</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:2px 12px;font-size:11px;">
            {#each Object.entries(vasp_param_entries) as [key, value]}
              <div style="color:var(--text-color-dim,#888);padding:2px 0;">{key}</div>
              <div style="color:var(--text-color,#e5e5e5);font-family:monospace;padding:2px 0;">{String(value)}</div>
            {/each}
          </div>
        </div>
      {/if}
      {#if Object.keys(non_vasp_param_entries).length > 0}
        <div class="sp-section">
          <div class="sp-section-title">{t('workflow.nsp_other_parameters')}</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:2px 12px;font-size:11px;">
            {#each Object.entries(non_vasp_param_entries) as [key, value]}
              <div style="color:var(--text-color-dim,#888);padding:2px 0;">{key}</div>
              <div style="color:var(--text-color,#e5e5e5);font-family:monospace;padding:2px 0;">{typeof value === 'object' ? JSON.stringify(value).slice(0,60) : String(value)}</div>
            {/each}
          </div>
        </div>
      {/if}

      <!-- Structure History (Lineage) -->
      {#if cached_summary._lineage?.length}
        <div class="sp-section">
          <div class="sp-section-title">{t('workflow.nsp_structure_history')}</div>
          <div class="sp-lineage">
            {#each cached_summary._lineage as step, i}
              <span class="sp-lineage-step" title={step.timestamp ?? ``}>
                {step.action}
              </span>
              {#if i < cached_summary._lineage!.length - 1}
                <span class="sp-lineage-arrow">&rarr;</span>
              {/if}
            {/each}
          </div>
        </div>
      {/if}

      <!-- Output Files (Artifacts) -->
      {#if files.length > 0 || effective_status === `running` || effective_status === `queued`}
        <div class="sp-section">
          <StepFileTree
            {files}
            work_dir={effective_work_dir}
            status={effective_status}
            node_id={effective_id}
            {workflow_id}
            bind:poll_enabled
            bind:poll_interval_ms
            bind:expanded_dirs
            {onview_file}
            {onload_structure}
            {ondownload}
            onrefresh={manual_refresh}
          />
        </div>
      {/if}
    </div>
  {/if}

  {#if fetch_error}
    <div class="sp-fetch-error">{fetch_error}</div>
  {/if}
</div>

<style>
  .status-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow-y: auto;
    color: var(--text-color, light-dark(#374151, #eee));
    font-family: 'SF Mono', 'Cascadia Code', 'JetBrains Mono', monospace;
    font-size: 12px;
    background: var(--dialog-bg, light-dark(#fff, #1c1d21));
  }

  .sp-header {
    padding: 14px 12px;
    border-bottom: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    background: var(--dialog-bg, light-dark(#fff, #1c1d21));
  }
  .sp-node-label {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-color, light-dark(#1f2937, #eee));
  }
  .sp-node-id {
    font-size: 9px;
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
    margin-top: 1px;
  }
  .sp-status-badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 3px 8px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 600;
    border: 1px solid;
    margin-top: 8px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .sp-status-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .sp-status-dot.running {
    animation: pulse-dot 1.5s ease-in-out infinite;
  }
  @keyframes pulse-dot {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }

  .sp-hpc-badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 3px 8px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 500;
    border: 1px solid;
    margin-top: 4px;
    font-family: var(--font-mono, monospace);
  }
  .sp-hpc-badge.connected {
    background: #34d39915;
    border-color: #34d39940;
    color: #34d399;
  }
  .sp-hpc-badge.disconnected {
    background: #f59e0b15;
    border-color: #f59e0b40;
    color: #f59e0b;
  }
  .sp-hpc-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .sp-hpc-badge.connected .sp-hpc-dot { background: #34d399; }
  .sp-hpc-badge.disconnected .sp-hpc-dot { background: #f59e0b; }

  .sp-loading {
    padding: 24px 12px;
    text-align: center;
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
    font-size: 11px;
  }
  .sp-inline-loading {
    font-size: 10px;
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
    padding: 4px 0;
  }
  .sp-empty {
    padding: 32px 12px;
    text-align: center;
  }
  .sp-empty-icon { font-size: 24px; margin-bottom: 8px; }
  .sp-empty-text {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
  }
  .sp-empty-hint {
    font-size: 10px;
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
    margin-top: 4px;
  }

  .sp-body {
    flex: 1;
  }

  .sp-section {
    padding: 10px 12px;
    border-bottom: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
  }
  .sp-section + .sp-section {
    border-top: none;
  }
  .sp-section-title {
    font-size: 9px;
    font-weight: 700;
    color: var(--accent-color, light-dark(#6366f1, #60a5fa));
    text-transform: uppercase;
    letter-spacing: 1.5px;
    margin-bottom: 8px;
  }

  .sp-info-grid {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .sp-info-row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    padding: 3px 6px;
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.02);
    gap: 8px;
  }
  .sp-info-label {
    font-size: 10px;
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
    flex-shrink: 0;
  }
  .sp-info-value {
    font-size: 11px;
    color: var(--text-color, light-dark(#374151, #e2e8f0));
    text-align: right;
    font-weight: 500;
    min-width: 0;
  }
  .sp-info-value.mono {
    font-family: 'SF Mono', 'Cascadia Code', monospace;
  }
  .sp-info-value.truncate {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sp-positive { color: #ef4444; }
  .sp-negative { color: #22c55e; }

  /* Formula display box */
  .sp-formula-box {
    background: rgba(5, 150, 105, 0.08);
    border: 1px solid rgba(5, 150, 105, 0.25);
    border-radius: 6px;
    padding: 6px 10px;
    margin-bottom: 8px;
    text-align: center;
  }
  .sp-formula {
    font-family: 'SF Mono', 'Cascadia Code', monospace;
    font-size: 12px;
    font-weight: 600;
    color: var(--text-color, light-dark(#059669, #34d399));
    letter-spacing: 0.5px;
  }
  .sp-highlight {
    color: var(--accent-color, light-dark(#059669, #34d399)) !important;
    font-weight: 700 !important;
  }

  /* Progress bar */
  .sp-progress-row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: 4px;
  }
  .sp-progress-text {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-color, light-dark(#374151, #eee));
  }
  .sp-progress-pct {
    font-size: 11px;
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
  }
  .sp-progress-track {
    height: 4px;
    background: var(--dialog-border, light-dark(#d1d5db, #404040));
    border-radius: 2px;
    overflow: hidden;
  }
  .sp-progress-fill {
    height: 100%;
    background: #3b82f6;
    border-radius: 2px;
    transition: width 0.3s;
  }

  /* Convergence flag */
  .sp-conv-flag {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 600;
    margin-top: 8px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .sp-conv-flag.converged {
    background: rgba(34, 197, 94, 0.12);
    border: 1px solid rgba(34, 197, 94, 0.3);
    color: #22c55e;
  }
  .sp-conv-flag.converged::before { content: '\2714 '; }
  .sp-conv-flag.not-converged {
    background: rgba(245, 158, 11, 0.12);
    border: 1px solid rgba(245, 158, 11, 0.3);
    color: #f59e0b;
  }
  .sp-conv-flag.not-converged::before { content: '\26A0 '; }

  /* Convergence failure guidance */
  .sp-guidance {
    margin-top: 8px;
    padding: 8px 10px;
    font-size: 11px;
    background: var(--hover-bg, light-dark(#f9fafb, #1e1f23));
    border-radius: 4px;
    border: 1px solid var(--dialog-border, light-dark(#e5e7eb, #333));
  }
  .sp-guidance-title {
    font-size: 10px;
    font-weight: 600;
    color: var(--text-color-dim, light-dark(#6b7280, #9ca3af));
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .sp-guidance-reason {
    margin-top: 4px;
    padding: 3px 6px;
    font-size: 11px;
    font-family: 'SF Mono', 'Monaco', monospace;
    background: rgba(245, 158, 11, 0.08);
    border-radius: 3px;
    color: var(--text-color, light-dark(#374151, #eee));
  }
  .sp-guidance-list {
    margin: 4px 0 0 0;
    padding-left: 16px;
    font-size: 10px;
    color: var(--text-color-dim, light-dark(#6b7280, #9ca3af));
    line-height: 1.6;
  }

  /* Convergence chart */
  .sp-convergence-chart {
    margin-top: 12px;
    padding: 8px 0;
    border-top: 1px solid var(--dialog-border, light-dark(#e5e7eb, #404040));
  }

  /* Retry button */
  .sp-retry-button {
    width: 100%;
    padding: 6px 12px;
    border: 1px solid rgba(59, 130, 246, 0.4);
    border-radius: 4px;
    background: rgba(59, 130, 246, 0.1);
    color: #3b82f6;
    font-size: 12px;
    cursor: pointer;
    transition: background 0.15s;
  }
  .sp-retry-button:hover:not(:disabled) {
    background: rgba(59, 130, 246, 0.2);
  }
  .sp-retry-button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .sp-retry-message {
    margin-top: 4px;
    font-size: 11px;
    color: var(--text-secondary, #666);
  }

  /* Energy highlight */
  .sp-energy-highlight {
    background: rgba(34, 197, 94, 0.06) !important;
    border: 1px solid rgba(34, 197, 94, 0.15);
    border-radius: 5px;
  }
  .sp-energy-highlight .sp-info-value {
    color: #22c55e;
    font-size: 12px;
    font-weight: 600;
  }

  /* Output file list */
  .sp-file-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .sp-file-btn {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 10px;
    border-radius: 5px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.02);
    color: inherit;
    cursor: pointer;
    transition: all 0.15s;
    text-align: left;
    font-family: inherit;
  }
  .sp-file-btn:hover {
    background: rgba(255, 255, 255, 0.06);
    border-color: rgba(255, 255, 255, 0.15);
  }
  .sp-file-btn.sp-file-load {
    border-color: rgba(59, 130, 246, 0.2);
    background: rgba(59, 130, 246, 0.05);
  }
  .sp-file-btn.sp-file-load:hover {
    background: rgba(59, 130, 246, 0.12);
    border-color: rgba(59, 130, 246, 0.35);
  }
  .sp-file-icon {
    font-size: 14px;
    flex-shrink: 0;
  }
  .sp-file-name {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-color, #e2e8f0);
  }
  .sp-file-desc {
    font-size: 9px;
    color: var(--text-color-muted, #64748b);
    margin-left: auto;
  }

  /* Error box */
  .sp-error-box {
    padding: 8px;
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.25);
    border-radius: 4px;
    color: #ef4444;
    font-size: 11px;
    line-height: 1.4;
    max-height: 120px;
    overflow-y: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* (File tree styles moved to StepFileTree.svelte) */

  .sp-ssh-hint {
    margin-top: 6px;
    padding: 4px 8px;
    font-size: 10px;
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
    font-style: italic;
  }

  .sp-warn-box {
    padding: 6px 8px;
    background: rgba(245, 158, 11, 0.1);
    border: 1px solid rgba(245, 158, 11, 0.25);
    border-radius: 4px;
    color: #f59e0b;
    font-size: 11px;
    line-height: 1.4;
    margin-bottom: 4px;
  }

  .sp-stdout-details { margin-top: 8px; }
  .sp-stdout-details summary {
    cursor: pointer; font-size: 11px; color: #60a5fa;
    font-weight: 500; padding: 4px 8px;
    border-radius: 4px; background: rgba(59, 130, 246, 0.06);
    border: 1px solid rgba(59, 130, 246, 0.15);
    transition: all 0.15s;
  }
  .sp-stdout-details summary:hover {
    background: rgba(59, 130, 246, 0.12);
  }
  .sp-stdout-details[open] summary {
    border-radius: 4px 4px 0 0;
    border-bottom-color: transparent;
  }
  .sp-stdout-pre {
    margin: 0; padding: 8px 10px;
    background: rgba(0,0,0,0.35); border-radius: 0 0 4px 4px;
    border: 1px solid rgba(59, 130, 246, 0.15); border-top: none;
    font-size: 10px; line-height: 1.5; color: #cbd5e1;
    white-space: pre-wrap; word-break: break-all;
    max-height: 200px; overflow-y: auto;
  }

  .sp-fetch-error {
    padding: 8px 12px;
    font-size: 10px;
    color: #ef4444;
    text-align: center;
  }

  /* ORCA-specific result tables */
  .sp-freq-table {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-top: 4px;
    max-height: 150px;
    overflow-y: auto;
  }
  .sp-freq-row {
    display: flex;
    gap: 8px;
    font-size: 10px;
    padding: 1px 4px;
    font-family: 'SF Mono', 'Monaco', monospace;
  }
  .sp-freq-imag {
    color: #ef4444;
  }
  .gibbs-auto-section {
    margin-top: 8px;
    padding: 6px 8px;
    border: 1px solid light-dark(#d1fae5, #065f46);
    border-radius: 6px;
    background: light-dark(#f0fdf4, rgba(6, 95, 70, 0.1));
  }
  .gibbs-auto-title {
    font-size: 10px;
    font-weight: 600;
    color: #22c55e;
    margin-bottom: 4px;
  }
  .gibbs-auto-hint {
    margin-top: 4px;
    font-size: 9px;
    color: light-dark(#9ca3af, #6b7280);
    font-style: italic;
  }

  .sp-neb-table {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-top: 4px;
    max-height: 130px;
    overflow-y: auto;
  }
  .sp-neb-row {
    display: flex;
    justify-content: space-between;
    font-size: 10px;
    padding: 1px 4px;
    font-family: 'SF Mono', 'Monaco', monospace;
  }
  .sp-neb-ts {
    font-weight: 700;
    color: #f59e0b;
  }
  .sp-inline-plot {
    width: 100%;
    min-height: 200px;
    margin-top: 8px;
  }
  .sp-plot-export {
    display: flex;
    gap: 4px;
    justify-content: flex-end;
    padding: 2px 0;
  }
  .sp-export-btn {
    font-size: 10px;
    padding: 2px 8px;
    border-radius: 4px;
    border: 1px solid rgba(128, 128, 128, 0.3);
    background: rgba(128, 128, 128, 0.1);
    color: var(--text-color, #ccc);
    cursor: pointer;
  }
  .sp-export-btn:hover {
    background: rgba(128, 128, 128, 0.25);
  }

  .sp-trajectory-button {
    padding: 6px 12px;
    background: #3b82f6;
    color: white;
    border: none;
    border-radius: 4px;
    font-size: 11px;
    cursor: pointer;
    font-weight: 600;
    transition: background 0.2s;
  }
  .sp-trajectory-button:hover:not(:disabled) {
    background: #2563eb;
  }
  .sp-trajectory-button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .sp-trajectory-viewer {
    height: 400px;
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    border-radius: 4px;
    overflow: hidden;
    background: var(--dialog-bg, light-dark(#f9fafb, #1a1b1e));
  }

  /* Auto-retry continuation badge (Prompt 37) */
  .sp-continuation-badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 4px 10px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 600;
    background: rgba(59, 130, 246, 0.12);
    border: 1px solid rgba(59, 130, 246, 0.3);
    color: #3b82f6;
    margin-bottom: 6px;
  }

  .sp-diagram-section {
    margin-top: 8px;
    border-top: 1px solid var(--dialog-border, light-dark(#e5e7eb, #333));
    padding-top: 8px;
  }

  /* Energy comparison table (Prompt 29) */
  .sp-energy-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 10px;
    margin-top: 4px;
  }
  .sp-energy-table th {
    text-align: left;
    padding: 4px 6px;
    font-weight: 600;
    font-size: 9px;
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
    border-bottom: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .sp-energy-table td {
    padding: 3px 6px;
    font-size: 10px;
    border-bottom: 1px solid var(--dialog-border, light-dark(#e5e7eb, #333));
  }
  .sp-best-row {
    background: rgba(34, 197, 94, 0.08);
    font-weight: 600;
  }

  /* Structure History (Lineage) breadcrumb */
  .sp-lineage {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    padding: 4px 0;
  }
  .sp-lineage-step {
    display: inline-block;
    padding: 2px 8px;
    font-size: 10px;
    font-weight: 500;
    background: var(--input-bg, light-dark(rgba(0,0,0,0.04), rgba(255, 255, 255, 0.06)));
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    border-radius: 10px;
    color: var(--text-color, light-dark(#374151, #eee));
    white-space: nowrap;
    cursor: default;
  }
  .sp-lineage-arrow {
    font-size: 11px;
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
    flex-shrink: 0;
  }

  /* Sub-step batch progress */
  .sp-substep-summary {
    font-size: 11px;
    color: var(--text-color, light-dark(#374151, #e2e8f0));
    font-weight: 500;
  }
  .sp-substep-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 8px;
  }
  .sp-substep-item {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 2px 5px;
    border-radius: 3px;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid var(--dialog-border, light-dark(#e5e7eb, #333));
  }
  .sp-substep-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .sp-substep-idx {
    font-size: 9px;
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
    font-weight: 600;
    min-width: 10px;
    text-align: center;
  }
  .sp-substep-toggle {
    display: block;
    margin-top: 6px;
    background: none;
    border: none;
    color: var(--accent-color, light-dark(#6366f1, #60a5fa));
    font-size: 10px;
    cursor: pointer;
    padding: 2px 0;
    font-family: inherit;
  }
  .sp-substep-toggle:hover {
    text-decoration: underline;
  }

  .orca-stage-label {
    font-size: 12px;
    color: var(--text-color-muted, #94a3b8);
    padding: 4px 0;
    font-style: italic;
  }

  .imag-freq-warning {
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.3);
    border-radius: 4px;
    padding: 8px 12px;
    font-size: 12px;
    color: #f87171;
    margin: 8px 0;
  }

  .thermo-table {
    margin: 8px 0;
  }

  .thermo-title {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-color-muted, #94a3b8);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 4px;
  }

  .thermo-table table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }

  .thermo-table td {
    padding: 3px 6px;
    border-bottom: 1px solid var(--border-color, rgba(255,255,255,0.06));
  }

  .thermo-table td:first-child {
    color: var(--text-color-muted, #94a3b8);
  }

  .thermo-table td:last-child {
    text-align: right;
    font-family: monospace;
    color: var(--text-color, #e2e8f0);
  }

  /* NEB-TS Tab Styles */
  .neb-tabs {
    display: flex;
    gap: 8px;
    border-bottom: 2px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    margin-bottom: 12px;
  }

  .neb-tab {
    padding: 8px 16px;
    border: none;
    background: transparent;
    cursor: pointer;
    border-bottom: 3px solid transparent;
    transition: all 0.2s ease;
    color: var(--text-color-dim, light-dark(#6b7280, #9ca3af));
    font-size: 12px;
    font-weight: 500;
  }

  .neb-tab:hover:not(:disabled) {
    color: var(--text-color, light-dark(#374151, #e2e8f0));
  }

  .neb-tab.active {
    border-bottom-color: #3b82f6;
    color: #3b82f6;
    font-weight: 600;
  }

  .neb-tab:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .neb-tab-content {
    padding: 8px 0;
  }

  /* ORCA Results Display */
  .results-section {
    margin-top: 12px;
  }

  .frequencies-table {
    margin: 12px 0;
    overflow-x: auto;
  }

  .frequencies-table table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.9em;
  }

  .frequencies-table th,
  .frequencies-table td {
    padding: 6px 8px;
    text-align: left;
    border-bottom: 1px solid var(--dialog-border, light-dark(#e0e0e0, #333));
  }

  .frequencies-table th {
    background: var(--section-bg, light-dark(#f5f5f5, #1e1e1e));
    font-weight: 500;
    color: var(--text-color, #333);
  }

  .frequencies-table tr:hover {
    background: var(--hover-bg, light-dark(#f9f9f9, #2a2a2a));
  }

  .thermochemistry h4,
  .irc-statistics h4 {
    margin: 16px 0 8px 0;
    font-size: 0.95em;
    color: var(--text-color-dim, #555);
  }

  .thermochemistry dl,
  .irc-statistics dl {
    display: grid;
    grid-template-columns: 150px 1fr;
    gap: 8px;
    font-size: 0.9em;
  }

  .thermochemistry dt,
  .irc-statistics dt {
    font-weight: 500;
    color: var(--text-color-dim, #555);
  }

  .thermochemistry dd,
  .irc-statistics dd {
    margin: 0;
    font-family: monospace;
    color: var(--text-color, #333);
  }
</style>

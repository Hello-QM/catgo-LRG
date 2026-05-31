/**
 * Workflow execution state and handlers.
 *
 * Extracted from WorkflowEditor.svelte.
 * Uses factory function pattern — $state must be created in component context.
 *
 * Manages: sim_running, workflow_status, execution_error, show_run_dialog,
 * show_pause_dialog, pause_jobs, node_statuses, has_running_jobs,
 * WebSocket monitor connection, and stale-running detection.
 */

import { NODE_DEFINITIONS } from './node-definitions'
import { push_workflow_event } from './workflow-state.svelte'
import * as api from '$lib/api/workflow'
import { API_BASE } from '$lib/api/config'
import type { WorkflowRunConfig } from './workflow-types'
import type { PauseJob } from './PauseDialog.svelte'
import type { WfNode, WfEdge } from './graph-model'
import {
  is_hpc_node,
  node_needs_hpc,
  parse_slab_gen_params,
} from './graph-model'
import { hpc_session_store, refresh_hpc_sessions } from '$lib/hpc-sessions.svelte'
import { save_run_config } from './run-config-store'
import type { PymatgenStructure } from '$lib'

export interface WorkflowExecution {
  // Reactive state
  readonly sim_running: boolean
  readonly workflow_status: string
  readonly execution_error: string | null
  readonly show_run_dialog: boolean
  readonly show_pause_dialog: boolean
  readonly pause_jobs: PauseJob[]
  readonly node_statuses: Record<string, string>
  readonly step_messages: Record<string, string>
  readonly task_results: Record<string, any>
  readonly has_running_jobs: boolean

  // State setters
  set_sim_running(v: boolean): void
  set_workflow_status(v: string): void
  set_execution_error(v: string | null): void
  set_show_run_dialog(v: boolean): void
  set_show_pause_dialog(v: boolean): void
  set_node_statuses(v: Record<string, string>): void

  // Result management
  fetch_task_results(workflow_id: string, task_id: string): Promise<any>
  setup_result_polling(workflow_id: string, task_id: string): void

  // Actions
  handle_run_click(
    workflow_id: string,
    nodes: WfNode[],
    has_cycle: () => boolean,
    do_save: () => Promise<void>,
    set_cycle_warning: (msg: string) => void,
  ): void

  handle_execute(
    config: WorkflowRunConfig,
    workflow_id: string,
    nodes: WfNode[],
    resolve_input_structure: (node_id: string) => string | null,
    do_save: () => Promise<void>,
    set_nodes?: (updated: WfNode[]) => void,
  ): Promise<void>

  handle_pause_confirm(
    cancel_step_ids: string[],
    workflow_id: string,
    handle_reset: () => void,
  ): Promise<void>

  handle_reset(workflow_id?: string): Promise<void>

  open_pause_dialog(
    workflow_id: string,
    nodes: WfNode[],
  ): Promise<void>

  start_monitoring(
    workflow_id: string,
    nodes: WfNode[],
  ): void

  stop_monitoring(): void

  simulate_run(
    nodes: WfNode[],
    edges: WfEdge[],
  ): void
}

export function create_workflow_execution(tab_id: string = `default`): WorkflowExecution {
  // `tab_id` is captured here so every `push_workflow_event` inside this
  // factory routes to the correct WorkflowSlice. It's constant for the
  // editor's lifetime — a new tab instantiates a new factory.
  let sim_running = $state(false)
  let workflow_status = $state<string>(`draft`)
  let execution_error = $state<string | null>(null)
  let show_run_dialog = $state(false)
  let show_pause_dialog = $state(false)
  let pause_jobs = $state<PauseJob[]>([])
  let node_statuses = $state<Record<string, string>>({})
  let step_messages = $state<Record<string, string>>({})
  let task_results = $state<Record<string, any>>({})
  let monitor_handle: { close: () => void } | null = null
  let sim_timer: ReturnType<typeof setTimeout> | null = null
  let result_poll_timers: Record<string, ReturnType<typeof setInterval>> = {}

  // Stale-running detection
  let stale_check_timer: ReturnType<typeof setTimeout> | null = null
  let last_step_update_ts = 0
  const STALE_CHECK_DELAY = 2 * 60 * 1000 // 2 minutes

  const has_running_jobs = $derived(
    Object.values(node_statuses).some(s => s === `running` || s === `queued` || s === `submitting`),
  )

  function schedule_stale_check() {
    clear_stale_check()
    last_step_update_ts = Date.now()
    stale_check_timer = setTimeout(() => check_stale_running_impl(), STALE_CHECK_DELAY)
  }

  function clear_stale_check() {
    if (stale_check_timer) { clearTimeout(stale_check_timer); stale_check_timer = null }
  }

  // Store workflow_id for the stale check closure
  let _monitor_workflow_id = ``

  async function check_stale_running_impl() {
    if (!_monitor_workflow_id) return
    try {
      const steps = await api.list_steps(_monitor_workflow_id)
      if (!steps?.length) return
      // Terminal states — everything else means the workflow is still in progress
      const TERMINAL = new Set([`completed`, `failed`, `skipped`, `cancelled`, `mapped`])
      for (const s of steps) {
        if (s.status !== node_statuses[s.id]) {
          node_statuses = { ...node_statuses, [s.id]: s.status }
        }
      }
      const all_terminal = Object.values(node_statuses).every(s => TERMINAL.has(s))
      if (all_terminal && sim_running) {
        sim_running = false
        const has_failed = Object.values(node_statuses).some(s => s === `failed`)
        workflow_status = has_failed ? `failed` : `completed`
        stop_monitoring()
      } else if (!all_terminal) {
        schedule_stale_check()
      }
    } catch {
      schedule_stale_check()
    }
  }

  function stop_monitoring() {
    if (sim_timer) { clearTimeout(sim_timer); sim_timer = null }
    monitor_handle?.close()
    monitor_handle = null
    clear_stale_check()
  }

  function start_monitoring(
    workflow_id: string,
    nodes: WfNode[],
  ) {
    if (!workflow_id) return
    stop_monitoring()
    _monitor_workflow_id = workflow_id
    execution_error = null
    monitor_handle = api.connect_workflow_monitor(workflow_id, {
      on_initial_state(data) {
        workflow_status = data.workflow_status
        const st: Record<string, string> = {}
        for (const s of data.steps) st[s.id] = s.status
        node_statuses = st
        if (data.workflow_status === `failed` || data.workflow_status === `completed`) {
          // Check if there are actually active tasks — the workflow may have been
          // incorrectly marked completed/failed by the frontend while tasks are
          // still running.  In that case, keep monitoring so the scanner's
          // correction (revert to RUNNING) is picked up.
          const has_active = data.steps.some(
            (s: any) => s.status === `running` || s.status === `queued` || s.status === `retrying` || s.status === `pending`,
          )
          if (has_active) {
            // Don't stop monitoring — scanner will revert workflow to running
            schedule_stale_check()
          } else {
            sim_running = false
            stop_monitoring()
          }
        } else if (data.workflow_status === `paused`) {
          sim_running = false
          const has_active = data.steps.some(
            s => s.status === `running` || s.status === `queued` || s.status === `submitting`,
          )
          if (!has_active) stop_monitoring()
        }
        if (data.workflow_status === `failed`) {
          const failed_step = data.steps.find(s => s.status === `failed` && s.error_message)
          if (failed_step?.error_message) {
            execution_error = `Step ${failed_step.id}: ${failed_step.error_message}`
          }
          push_workflow_event(tab_id, { type: `workflow_failed` })
        }
        const has_running = data.steps.some(s => s.status === `running` || s.status === `queued`)
        if (has_running) {
          schedule_stale_check()
          // Auto-recheck: query HPC for actual job status (detects jobs that completed while offline)
          api.recheck_jobs(workflow_id).then(result => {
            if (result.updated > 0) {
              console.log(`[Workflow] Recheck: ${result.updated} jobs updated`)
            }
          }).catch(err => {
            console.warn(`[Workflow] Recheck failed:`, err)
          })
        }
      },
      on_step_status(step_id, status, _job_id, message) {
        node_statuses = { ...node_statuses, [step_id]: status }
        if (message) step_messages = { ...step_messages, [step_id]: message }
        if (status === `running` || status === `queued`) schedule_stale_check()
        const node = nodes.find(n => n.id === step_id)
        const label = node ? (NODE_DEFINITIONS[node.type]?.label ?? node.type) : step_id
        if (status === `failed`) {
          push_workflow_event(tab_id, { type: `step_failed`, step_id, step_label: label })
        } else if (status === `completed`) {
          push_workflow_event(tab_id, { type: `step_completed`, step_id, step_label: label })
          // Trigger result collection when task completes
          setup_result_polling(workflow_id, step_id)
          console.info(`Task ${step_id} completed, starting result polling`)
        }
        if (workflow_status === `paused` && (status === `completed` || status === `failed`)) {
          const still_active = Object.values(node_statuses).some(
            s => s === `running` || s === `queued` || s === `submitting`,
          )
          if (!still_active) stop_monitoring()
        }
      },
      on_workflow_status(status) {
        workflow_status = status
        if (status === `completed` || status === `failed` || status === `not_converged`) {
          sim_running = false
          stop_monitoring()
        } else if (status === `paused`) {
          sim_running = false
        }
        if (status === `completed`) {
          push_workflow_event(tab_id, { type: `workflow_completed` })
        } else if (status === `failed`) {
          push_workflow_event(tab_id, { type: `workflow_failed` })
        }
      },
      on_error(error) {
        execution_error = error
        console.error(`[Workflow]`, error)
      },
    })
  }

  async function handle_reset(wf_id?: string) {
    if (sim_timer) { clearTimeout(sim_timer); sim_timer = null }
    sim_running = false
    workflow_status = `draft`
    node_statuses = {}
    execution_error = null
    stop_monitoring()

    // Reset backend DB state — clear all step results, statuses, job IDs
    // MUST await to ensure DB is cleared before user clicks Run
    const id = wf_id || _monitor_workflow_id
    if (id) {
      try {
        const result = await api.reset_workflow(id)
        console.log(`[Workflow] Reset: ${result.steps_reset} steps cleared`)
      } catch (err) {
        console.error(`[Workflow] Backend reset failed:`, err)
      }
    }
  }

  async function open_pause_dialog_impl(
    workflow_id: string,
    nodes: WfNode[],
  ) {
    try {
      const steps = await api.list_steps(workflow_id)
      pause_jobs = Object.entries(node_statuses)
        .filter(([, s]) => s === `running` || s === `queued` || s === `submitting`)
        .map(([id, s]) => {
          const node = nodes.find(n => n.id === id)
          const def = NODE_DEFINITIONS[node?.type ?? ``]
          const step = steps.find(st => st.id === id)
          const sid = step?.hpc_session_id ?? (node?.params?.hpc_session_id as string)
          const session = sid ? hpc_session_store.sessions.find(ss => ss.session_id === sid) : null
          return {
            step_id: id,
            label: def?.label ?? node?.type ?? id,
            status: s,
            job_id: step?.hpc_job_id ?? ``,
            host: session ? `${session.username}@${session.host}` : undefined,
          }
        })
      show_pause_dialog = true
    } catch {
      handle_pause_confirm_impl([], workflow_id, handle_reset)
    }
  }

  function handle_run_click_impl(
    workflow_id: string,
    nodes: WfNode[],
    has_cycle: () => boolean,
    do_save: () => Promise<void>,
    set_cycle_warning: (msg: string) => void,
  ) {
    if (workflow_status === `running`) {
      open_pause_dialog_impl(workflow_id, nodes)
      return
    }
    if (sim_running && workflow_status !== `running`) {
      sim_running = false
    }
    if (has_cycle()) {
      set_cycle_warning(`Cannot run: workflow graph contains a cycle. Remove circular dependencies first.`)
      return
    }
    if (nodes.length === 0) {
      set_cycle_warning(`Add at least one node to the workflow.`)
      return
    }
    do_save().then(() => {
      refresh_hpc_sessions()
      show_run_dialog = true
    }).catch((err) => {
      execution_error = `Save failed before run: ${err?.message ?? err}`
    })
  }

  async function ensure_slab_gen_structures(
    nodes: WfNode[],
    resolve_input_structure: (node_id: string) => string | null,
  ): Promise<{ ok: boolean; updated_nodes?: WfNode[] }> {
    const slab_nodes = nodes.filter(n => n.type === `slab_gen` && !n.params.structure_json)
    if (slab_nodes.length === 0) return { ok: true }

    const { wasm_generate_slab_layers, is_ok } = await import(`$lib/structure/ferrox-wasm`)
    const { matrix_to_params, ensure_right_handed } = await import(`$lib/structure/lattice-ops`)
    const { deduplicate_periodic_images } = await import(`$lib/structure/pbc`)

    let updated_nodes = [...nodes]
    for (const nd of slab_nodes) {
      const upstream_json = resolve_input_structure(nd.id)
      if (!upstream_json) {
        execution_error = `Slab node ${nd.id} has no upstream structure. Connect a structure_input node.`
        return { ok: false }
      }
      try {
        const structure = JSON.parse(upstream_json) as PymatgenStructure
        const { miller, layers, vacuum, supercell, termination } = parse_slab_gen_params(nd.params)
        const result = await wasm_generate_slab_layers(structure, miller, {
          num_layers: layers, termination_index: termination, vacuum, supercell,
        })
        if (!is_ok(result)) {
          execution_error = `Slab generation failed for node ${nd.id}: ${(result as any).error}`
          return { ok: false }
        }
        let slab = result.ok as PymatgenStructure
        if (slab?.lattice?.matrix) {
          type V3 = [number, number, number]
          const { matrix: m, swapped } = ensure_right_handed(slab.lattice.matrix as [V3, V3, V3])
          const p = matrix_to_params(m)
          const [va, vb, vc] = m
          const cx = vb[1] * vc[2] - vb[2] * vc[1], cy = vb[2] * vc[0] - vb[0] * vc[2], cz = vb[0] * vc[1] - vb[1] * vc[0]
          const vol = Math.abs(va[0] * cx + va[1] * cy + va[2] * cz)
          const sites = swapped && slab.sites
            ? slab.sites.map((s: any) => ({ ...s, abc: s.abc ? [s.abc[1], s.abc[0], s.abc[2]] : s.abc }))
            : slab.sites
          slab = {
            ...slab, sites,
            lattice: { ...slab.lattice, matrix: m, a: p.a, b: p.b, c: p.c, alpha: p.alpha, beta: p.beta, gamma: p.gamma, volume: vol, pbc: [true, true, false] as [boolean, boolean, boolean] },
          }
          slab = deduplicate_periodic_images(slab as any) as PymatgenStructure
        }
        updated_nodes = updated_nodes.map(n => n.id === nd.id
          ? { ...n, params: { ...n.params, structure_json: JSON.stringify(slab) } }
          : n,
        )
      } catch (err) {
        execution_error = `WASM slab generation failed for node ${nd.id}: ${err instanceof Error ? err.message : String(err)}`
        return { ok: false }
      }
    }
    return { ok: true, updated_nodes }
  }

  async function handle_execute_impl(
    config: WorkflowRunConfig,
    workflow_id: string,
    nodes: WfNode[],
    resolve_input_structure: (node_id: string) => string | null,
    do_save: () => Promise<void>,
    set_nodes?: (updated: WfNode[]) => void,
  ) {
    show_run_dialog = false
    if (!workflow_id) return
    execution_error = null

    console.log('[DEBUG] Before ensure_slab_gen_structures')
    const slab_result = await ensure_slab_gen_structures(nodes, resolve_input_structure)
    console.log('[DEBUG] After ensure_slab_gen_structures')
    if (!slab_result.ok) return

    // If slab structures were generated, update component nodes before saving
    const effective_nodes = slab_result.updated_nodes ?? nodes
    if (slab_result.updated_nodes) {
      set_nodes?.(slab_result.updated_nodes)
    }
    // Always save the graph before running — ensures imported structures,
    // parameter changes, and node edits are persisted to the DB before
    // the backend reads graph_json to create V2 tasks.
    await do_save()

    // Build step_job_params from per-node Properties panel overrides
    for (const nd of effective_nodes) {
      const p = nd.params ?? {} as Record<string, unknown>
      const jn = p.job_nodes as number | undefined
      const jnt = p.job_ntasks as number | undefined
      const jcpt = p.job_cpus_per_task as number | undefined
      const jwt = p.job_walltime as string | undefined
      const jpart = p.job_partition as string | undefined
      const jacc = p.job_account as string | undefined
      // Populate step_sessions from per-node cluster override
      const hpc_sid = p.hpc_session_id as string | undefined
      if (hpc_sid) {
        config.step_sessions[nd.id] = hpc_sid
      }

      // Populate step_scripts from per-node job script override
      const node_script = p.job_script as string | undefined
      if (node_script?.trim()) {
        config.step_scripts[nd.id] = node_script
      }

      if (!jpart && !jn && !jnt && !jcpt && !jwt && !jacc) continue
      config.step_job_params[nd.id] = {
        nodes: jn ?? config.default_job_params.nodes,
        ntasks: jnt ?? config.default_job_params.ntasks,
        cpus_per_task: jcpt ?? config.default_job_params.cpus_per_task,
        walltime: jwt ?? config.default_job_params.walltime,
        ...(jpart ? { partition: jpart } : config.default_job_params.partition ? { partition: config.default_job_params.partition } : {}),
        ...(jacc ? { account: jacc } : {}),
      }
    }

    // Pre-run validation: in HPC mode, check if cluster is connected
    if (config.execution_mode === `hpc`) {
      const hpc_needed_nodes = effective_nodes.filter(n => {
        const p = n.params ?? {}
        return node_needs_hpc(n.type ?? ``, p as Record<string, unknown>)
      })
      if (hpc_needed_nodes.length > 0) {
        const has_remote = hpc_session_store.sessions.length > 0
        if (!config.default_session_id && !has_remote) {
          const labels = hpc_needed_nodes.map(n => NODE_DEFINITIONS[n.type ?? ``]?.label ?? n.type ?? `unknown`).join(`, `)
          execution_error = `No HPC cluster connected. The following nodes require an HPC session: ${labels}. Connect to a cluster in the Run Config dialog, or switch to Local execution mode.`
          return
        }
      }
    }

    // Persist the fully-assembled run config (incl. per-step overrides) keyed
    // by workflow id, so the in-app AI (CatBot's run_workflow tool) can re-run
    // this workflow later without re-opening the Run dialog.
    save_run_config(workflow_id, config)

    try {
      if (workflow_status === `paused`) {
        console.log('[DEBUG] Before resume_workflow')
        await api.resume_workflow(workflow_id, config)
        console.log('[DEBUG] After resume_workflow')
      } else {
        console.log('[DEBUG] Before run_workflow')
        await api.run_workflow(workflow_id, config)
        console.log('[DEBUG] After run_workflow')
      }
      workflow_status = `running`
      sim_running = true
      const all: Record<string, string> = {}
      effective_nodes.forEach(n => {
        all[n.id] = node_statuses[n.id] === `completed` ? `completed` : `pending`
      })
      node_statuses = { ...all }
      console.log('[DEBUG] Before start_monitoring')
      start_monitoring(workflow_id, effective_nodes)
      console.log('[DEBUG] After start_monitoring')
    } catch (err: any) {
      const msg = err?.message || String(err)
      if (msg.includes(`catgo_run binary not found`) || msg.includes(`catgo_run`)) {
        execution_error = `Engine not available — build catgo_run: cd crates/catgo-graph && cargo build --features cli, or use Tauri mode: pnpm tauri:dev`
      } else if (msg.includes(`tool bridge`) || msg.includes(`HPC node`)) {
        execution_error = `HPC nodes require Python backend with HPC sessions configured. Start: cd server && python main.py`
      } else {
        execution_error = `Run failed: ${msg}`
      }
    }
  }

  async function handle_pause_confirm_impl(
    cancel_step_ids: string[],
    workflow_id: string,
    on_reset: () => void,
  ) {
    show_pause_dialog = false
    if (!workflow_id) return
    try {
      await api.pause_workflow(workflow_id, { cancel_step_ids })
      workflow_status = `paused`
      sim_running = false
      if (cancel_step_ids.length > 0) {
        const updated = { ...node_statuses }
        for (const id of cancel_step_ids) {
          if (updated[id] === `running` || updated[id] === `queued` || updated[id] === `submitting`) {
            updated[id] = `paused`
          }
        }
        node_statuses = updated
      }
      const still_has_running = Object.values(node_statuses).some(
        s => s === `running` || s === `queued` || s === `submitting`,
      )
      if (!still_has_running) {
        stop_monitoring()
      }
    } catch (err: any) {
      console.error(`Pause failed:`, err)
      on_reset()
    }
  }

  function simulate_run(
    nodes: WfNode[],
    edges: WfEdge[],
  ) {
    if (sim_running) {
      if (sim_timer) clearTimeout(sim_timer)
      sim_running = false
      node_statuses = {}
      return
    }
    sim_running = true
    const adj: Record<string, string[]> = {}
    const in_deg: Record<string, number> = {}
    nodes.forEach(n => { adj[n.id] = []; in_deg[n.id] = 0 })
    edges.forEach(e => { adj[e.from]?.push(e.to); in_deg[e.to] = (in_deg[e.to] || 0) + 1 })
    const layers: string[][] = []
    const visited = new Set<string>()
    let queue = nodes.filter(n => in_deg[n.id] === 0).map(n => n.id)
    while (queue.length) {
      layers.push([...queue])
      const next: string[] = []
      queue.forEach(id => {
        visited.add(id);
        (adj[id] || []).forEach(nb => { in_deg[nb]--; if (in_deg[nb] <= 0 && !visited.has(nb)) { next.push(nb); visited.add(nb) } })
      })
      queue = next
    }
    const all: Record<string, string> = {}
    nodes.forEach(n => all[n.id] = `pending`)
    node_statuses = { ...all }
    let step = 0
    function run_step() {
      if (step >= layers.length) { sim_running = false; return }
      const cur = layers[step]
      cur.forEach(id => all[id] = `running`)
      node_statuses = { ...all }
      sim_timer = setTimeout(() => {
        cur.forEach(id => all[id] = Math.random() > 0.1 ? `completed` : `failed`)
        node_statuses = { ...all }
        step++
        sim_timer = setTimeout(run_step, 600)
      }, 1200)
    }
    sim_timer = setTimeout(run_step, 300)
  }

  async function fetch_task_results(workflow_id: string, task_id: string): Promise<any> {
    try {
      const response = await fetch(
        `${API_BASE}/engine/tasks/${task_id}/result`,
        { signal: AbortSignal.timeout(10000) } // 10s timeout
      )

      // Check for server errors first
      if (response.status >= 500) {
        const contentType = response.headers.get('content-type')
        const isJson = contentType?.includes('application/json')

        if (!isJson) {
          // Server returned HTML error page (likely crash or unhandled exception)
          const text = await response.text().catch(() => '')
          console.error(
            `[CRITICAL] Task ${task_id}: Backend returned HTTP ${response.status} with HTML (likely server crash)\n` +
            `Response preview: ${text.slice(0, 200)}`
          )
          // Return distinct error state so polling can alert user
          return { error: `backend_error_${response.status}`, critical: true }
        }

        // Valid JSON error response
        try {
          const error = await response.json()
          console.error(`Task ${task_id}: Backend error (${response.status}):`, error)
          return { error: `backend_error_${response.status}`, detail: error.detail || error }
        } catch {
          console.error(`Task ${task_id}: Backend error (${response.status}) with unparseable response`)
          return { error: `backend_error_${response.status}` }
        }
      }

      if (!response.ok) {
        console.debug(`Task ${task_id} results not ready yet (${response.status})`)
        return null
      }

      const contentType = response.headers.get('content-type')
      if (!contentType?.includes('application/json')) {
        console.error(
          `[CRITICAL] Task ${task_id}: Expected JSON but got ${contentType}\n` +
          `Response: ${await response.text().then(t => t.slice(0, 200))}`
        )
        return { error: 'invalid_response_type', expected: 'application/json', got: contentType }
      }

      const data = await response.json()
      // Store the result for later access
      task_results[task_id] = data
      console.info(`Task ${task_id}: Results loaded successfully`)
      return data
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        console.error(`Task ${task_id}: Fetch timeout (10s)`)
        return { error: 'fetch_timeout' }
      }
      console.error(`Task ${task_id}: Fetch failed:`, err)
      return { error: 'fetch_failed', message: err instanceof Error ? err.message : String(err) }
    }
  }

  function setup_result_polling(workflow_id: string, task_id: string) {
    // Clear any existing polling for this task
    if (result_poll_timers[task_id]) {
      clearInterval(result_poll_timers[task_id])
    }

    let poll_count = 0
    const max_polls = 60 // 5 minutes with 5s interval (reduced from 10min)
    let critical_error_count = 0
    const max_critical_errors = 3 // Alert user after 3 backend errors

    const poll = async () => {
      const results = await fetch_task_results(workflow_id, task_id)

      // Check for errors in the result object
      if (results && typeof results === 'object' && 'error' in results) {
        const error_info = results as any
        console.warn(`Task ${task_id}: Result fetch returned error state:`, error_info.error)

        // Track critical backend errors
        if (error_info.critical || error_info.error?.startsWith('backend_error_')) {
          critical_error_count++
          if (critical_error_count >= max_critical_errors) {
            clearInterval(result_poll_timers[task_id])
            delete result_poll_timers[task_id]
            const status_msg = `Backend error (${error_info.detail || 'unknown'}). Check that the Python backend is running on ${new URL(API_BASE).host}`
            execution_error = `Task ${task_id}: ${status_msg}`
            console.error(`[CRITICAL] ${execution_error}`)
            push_workflow_event(tab_id, { type: `step_failed`, step_id: task_id, step_label: task_id, error: status_msg })
            return
          }
        }

        // For non-critical errors, continue polling (results might not be ready yet)
        if (poll_count++ >= max_polls) {
          clearInterval(result_poll_timers[task_id])
          delete result_poll_timers[task_id]
          const msg = `Result polling timeout after ${max_polls * 5}s. Results endpoint returned: ${error_info.error}`
          execution_error = `Task ${task_id}: ${msg}`
          console.warn(`[TIMEOUT] ${execution_error}`)
          push_workflow_event(tab_id, { type: `step_failed`, step_id: task_id, step_label: task_id, error: msg })
          return
        }
      } else if (results) {
        // Results loaded successfully
        clearInterval(result_poll_timers[task_id])
        delete result_poll_timers[task_id]
        console.info(`Task ${task_id}: Results loaded successfully`)
      } else if (poll_count++ >= max_polls) {
        // Polling timeout (no error, just no results yet)
        clearInterval(result_poll_timers[task_id])
        delete result_poll_timers[task_id]
        const msg = `Result polling timeout after ${max_polls * 5}s. No results available.`
        execution_error = `Task ${task_id}: ${msg}`
        console.warn(`[TIMEOUT] ${execution_error}`)
        push_workflow_event(tab_id, { type: `step_failed`, step_id: task_id, step_label: task_id, error: msg })
      }
    }

    // Poll every 5 seconds (consistent with before)
    result_poll_timers[task_id] = setInterval(poll, 5000)
    // Also check immediately
    poll()
  }

  return {
    get sim_running() { return sim_running },
    get workflow_status() { return workflow_status },
    get execution_error() { return execution_error },
    get show_run_dialog() { return show_run_dialog },
    get show_pause_dialog() { return show_pause_dialog },
    get pause_jobs() { return pause_jobs },
    get node_statuses() { return node_statuses },
    get step_messages() { return step_messages },
    get task_results() { return task_results },
    get has_running_jobs() { return has_running_jobs },

    set_sim_running(v) { sim_running = v },
    set_workflow_status(v) { workflow_status = v },
    set_execution_error(v) { execution_error = v },
    set_show_run_dialog(v) { show_run_dialog = v },
    set_show_pause_dialog(v) { show_pause_dialog = v },
    set_node_statuses(v) { node_statuses = v },

    fetch_task_results,
    setup_result_polling,

    handle_run_click: handle_run_click_impl,
    handle_execute: handle_execute_impl,
    handle_pause_confirm: handle_pause_confirm_impl,
    handle_reset,
    open_pause_dialog: open_pause_dialog_impl,
    start_monitoring,
    stop_monitoring,
    simulate_run,
  }
}

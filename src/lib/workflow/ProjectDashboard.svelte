<script lang="ts">
  import { onMount } from 'svelte'
  import { t } from '$lib/i18n/index.svelte'
  import type { EnrichedResult, ProjectDetail } from '$lib/api/project'
  import type { StepInfo } from './workflow-types'
  import type { ConvergencePoint } from '$lib/api/workflow'
  import * as project_api from '$lib/api/project'
  import * as workflow_api from '$lib/api/workflow'
  import { list_v2_workflows_for_project, list_v2_workflows, assign_v2_workflow_to_project, type V2WorkflowSummary } from '$lib/api/workflow-v2'
  import { check_tauri } from '$lib/io/tauri'
  import { STATUS_COLORS } from './workflow-types'
  import { active_project_context } from './workflow-state.svelte'
  import ResultsTable from './ResultsTable.svelte'
  import ResultsPlot from './ResultsPlot.svelte'
  import BenchmarkTable from './BenchmarkTable.svelte'

  let {
    project_id,
    onback,
    on_open_workflow,
    on_open_engine_workflow,
    onclose,
    ondbchange,
  }: {
    project_id: string
    onback: () => void
    on_open_workflow: (workflow_id: string) => void
    on_open_engine_workflow?: (workflow_id: string) => void
    onclose?: () => void
    ondbchange?: () => void
  } = $props()

  let project = $state<ProjectDetail | null>(null)
  let results = $state<EnrichedResult[]>([])
  let is_loading = $state(true)
  let error = $state(``)
  let active_tab = $state<'table' | 'plot' | 'benchmark'>(`table`)
  let selected_results = $state<EnrichedResult[]>([])

  // Show the Benchmark tab when at least one workflow in this project
  // looks like a Ni-surface MACE benchmark. Names checked (case-insensitive,
  // substring):
  //   - "mace ni benchmark" — legacy (the duplicate preset I removed)
  //   - "uma catalysis" — the actual frontend preset in graph-model.ts
  //   - "kreitz" — users naming their copy after the paper
  // Cheap heuristic; a workflow renamed to something unrelated won't show
  // the tab. A follow-up could persist a preset_id or template_key on the
  // workflow row and match on that.
  const BENCHMARK_NAME_HINTS = [`mace ni benchmark`, `uma catalysis`, `kreitz`]
  const has_mace_benchmark = $derived(
    (project?.workflows ?? []).some((w) => {
      const n = (w.name ?? ``).toLowerCase()
      return BENCHMARK_NAME_HINTS.some((hint) => n.includes(hint))
    }),
  )

  // If the project has a benchmark workflow but no ASE-DB results yet, land
  // on the Benchmark tab so users see the placeholder instead of an empty
  // Table view. Track the "already auto-selected" state PER project_id so
  // switching to a second benchmark project re-arms the one-shot behavior
  // instead of staying stuck on the previous project's tab.
  let auto_selected_for_project = $state(``)
  $effect(() => {
    if (
      has_mace_benchmark
      && results.length === 0
      && auto_selected_for_project !== project_id
    ) {
      active_tab = `benchmark`
      auto_selected_for_project = project_id
    }
  })

  // Editable project fields
  let edit_name = $state(``)
  let is_saving_project = $state(false)
  let save_project_flash = $state(false)

  // Engine workflows assigned to this project
  let engine_workflows = $state<V2WorkflowSummary[]>([])

  // For assigning existing workflows
  let show_assign_picker = $state(false)
  let unassigned_workflows = $state<Array<{ id: string; name: string }>>([])

  // Live polling state (for sidebar status updates, not for convergence plots)
  interface TrackedStep {
    workflow_id: string
    workflow_name: string
    step: StepInfo
    convergence: { points: ConvergencePoint[]; converged: boolean } | null
    is_running: boolean
  }

  const VASP_NODE_TYPES = new Set([
    `vasp_relax`, `vasp_static`, `vasp_md`, `bulk_opt`, `slab_relax`,
    `slab_gen`, `adsorbate_place`, `geometry_opt`, `frequency`,
  ])

  const ORCA_NODE_TYPES = new Set([
    `orca_opt`, `orca_sp`, `orca_freq`, `orca_neb_ts`, `orca_irc`, `orca_uvvis`,
  ])

  // Unified calc-type nodes that dispatch to MLP via software=mlp — these
  // are the graph-model node types whose MLP variant produces an ASE
  // opt.log / neb.log the backend parser can read. mlp_single_point /
  // mlp_vibrations don't produce iteration logs so they're excluded.
  const MLP_LIVE_UNIFIED_TYPES = new Set([`geo_opt`, `ts_search`])

  function step_is_mlp_live(step: StepInfo): boolean {
    if (!MLP_LIVE_UNIFIED_TYPES.has(step.node_type)) return false
    try {
      const cfg = JSON.parse(step.config_json || `{}`)
      return cfg.software === `mlp`
    } catch {
      return false
    }
  }

  let tracked_steps = $state<TrackedStep[]>([])
  let live_polling_interval: ReturnType<typeof setInterval> | null = null
  let prev_had_running = $state(false)
  // Tracked separately from has_running so we can switch to the fast cadence
  // without re-entering the setInterval loop. Flipped inside update_live_steps
  // and consumed by the poll scheduler at the bottom of this component.
  let has_running_mlp = $state(false)
  let table_ready = $state(false)

  const unique_formulas = $derived(new Set(results.map((r) => r.formula)))

  const energy_range = $derived.by(() => {
    const energies = results
      .filter((r) => r.energy_per_atom != null)
      .map((r) => r.energy_per_atom!)
    if (energies.length === 0) return `N/A`
    const min_e = Math.min(...energies)
    const max_e = Math.max(...energies)
    return `${min_e.toFixed(3)} ~ ${max_e.toFixed(3)}`
  })

  async function load_data() {
    is_loading = true
    error = ``
    try {
      const [proj, res] = await Promise.all([
        project_api.get_project(project_id),
        project_api.get_enriched_results(project_id).catch((e) => {
          console.warn(`[ProjectDashboard] Failed to load enriched results:`, e)
          return [] as import('$lib/api/project').EnrichedResult[]
        })
      ])
      project = proj
      edit_name = project.name
      results = res
      // Also fetch engine workflows for this project (non-blocking)
      try {
        engine_workflows = await list_v2_workflows_for_project(project_id)
      } catch {
        engine_workflows = []
      }
    } catch (err) {
      error = String(err)
    } finally {
      is_loading = false
      table_ready = true
    }
  }

  $effect(() => {
    load_data()
  })

  // Live polling — updates sidebar workflow status
  async function update_live_steps() {
    // Get workflow list via HTTP (bypasses stale WASM DB)
    let wfs_to_poll: Array<{ id: string; name: string; status: string; step_count: number; completed_steps: number; created_at: string }> = []
    try {
      const all = await workflow_api.list_workflows_http()
      wfs_to_poll = all.filter(w => w.project_id === project_id).map(w => ({
        id: w.id,
        name: w.name,
        status: w.status,
        step_count: w.step_count,
        completed_steps: w.completed_steps,
        created_at: w.created_at,
      }))

      // Fallback: if project_id filter returned nothing (null/mismatch in DB),
      // also include any workflow already known to belong to this project
      if (wfs_to_poll.length === 0 && project?.workflows?.length) {
        const known_ids = new Set(project.workflows.map(w => w.id))
        const fallback = all.filter(w => known_ids.has(w.id)).map(w => ({
          id: w.id,
          name: w.name,
          status: w.status,
          step_count: w.step_count,
          completed_steps: w.completed_steps,
          created_at: w.created_at,
        }))
        wfs_to_poll = fallback.length > 0 ? fallback : (project.workflows as any)
      }
    } catch {
      // Fall back to WASM data if Python backend unreachable
      wfs_to_poll = project?.workflows ?? []
    }

    if (wfs_to_poll.length === 0) return

    // Sync sidebar with HTTP-derived workflow list
    if (project) {
      project.workflows = wfs_to_poll as any
    }

    let has_running = false
    let seen_running_mlp = false

    for (const wf of wfs_to_poll) {
      try {
        const steps = await workflow_api.list_steps_http(wf.id)
        for (const step of steps) {
          if (step.status === `running` || step.status === `queued`) {
            has_running = true

            const is_vasp = VASP_NODE_TYPES.has(step.node_type)
            const is_orca = ORCA_NODE_TYPES.has(step.node_type)
            const is_mlp = step_is_mlp_live(step)
            if (is_mlp) seen_running_mlp = true

            // Preserve previous convergence if fetch fails (don't overwrite good data with null)
            const prev_conv = tracked_steps.find(ts => ts.step.id === step.id)?.convergence ?? null
            let convergence: { points: ConvergencePoint[]; converged: boolean; message?: string } | null = null

            try {
              if (is_vasp) {
                convergence = await workflow_api.get_convergence(wf.id, step.id)
              } else if (is_orca) {
                // Use lightweight endpoint for UV-Vis to avoid parsing 100+ electronic states
                if (step.node_type === 'orca_uvvis') {
                  const light = await workflow_api.get_orca_uvvis_progress_light(wf.id, step.id)
                  // UV-Vis has no real convergence trajectory — use empty points with status message only
                  convergence = {
                    points: [],
                    converged: light.completed,
                    message: light.completed ? `UV-Vis completed` : (light.message || `UV-Vis running…`)
                  }
                } else {
                  convergence = await workflow_api.get_orca_progress(wf.id, step.id)
                }
              } else if (is_mlp) {
                // Local MLP execution writes opt.log / neb.log into step.work_dir.
                // The endpoint parses the tail — returns an empty points list
                // with a human-readable message while the log is still empty
                // (step just started) or for HPC-mode MLP (not yet wired).
                convergence = await workflow_api.get_mlp_progress(wf.id, step.id)
              }
            } catch {
              // Backend unavailable or step doesn't have convergence data yet
            }

            // Upsert into persistent array, falling back to previous convergence if fetch failed
            const _idx = tracked_steps.findIndex(ts => ts.step.id === step.id)
            const _new_entry = {
              workflow_id: wf.id,
              workflow_name: wf.name,
              step,
              convergence: convergence ?? prev_conv,
              is_running: true,
            }
            if (_idx >= 0) tracked_steps[_idx] = _new_entry
            else tracked_steps.push(_new_entry)
          } else if (tracked_steps.some(ts => ts.step.id === step.id)) {
            // Step was running, now it's not — attempt final convergence fetch, then mark as complete
            const existing = tracked_steps.find(ts => ts.step.id === step.id)!
            const is_vasp = VASP_NODE_TYPES.has(step.node_type)
            const is_orca = ORCA_NODE_TYPES.has(step.node_type)
            const is_mlp = step_is_mlp_live(step)
            let final_conv = existing.convergence

            if (is_vasp || is_orca || is_mlp) {
              try {
                if (is_vasp) {
                  final_conv = (await workflow_api.get_convergence(wf.id, step.id)) ?? existing.convergence
                } else if (is_orca) {
                  final_conv = (await workflow_api.get_orca_progress(wf.id, step.id)) ?? existing.convergence
                } else {
                  final_conv = (await workflow_api.get_mlp_progress(wf.id, step.id)) ?? existing.convergence
                }
              } catch {
                // Keep existing convergence if final fetch fails
              }
            }

            const _comp_idx = tracked_steps.findIndex(ts => ts.step.id === step.id)
            if (_comp_idx >= 0) {
              tracked_steps[_comp_idx] = {
                ...existing,
                step,
                convergence: final_conv,
                is_running: false,
              }
            }
          }
        }

        // Derive correct workflow status from step statuses (bypasses stale WASM DB data)
        const n_running = steps.filter(s => s.status === `running` || s.status === `queued`).length
        const n_completed = steps.filter(s => s.status === `completed`).length
        const n_failed = steps.filter(s => s.status === `failed`).length
        const derived_status = n_running > 0 ? `running`
          : n_failed > 0 ? `failed`
          : n_completed === steps.length && steps.length > 0 ? `completed`
          : `draft`

        if (n_running > 0) has_running = true

        // Update project.workflows entry with live-derived status and step counts
        if (project?.workflows) {
          const idx = project.workflows.findIndex(w => w.id === wf.id)
          if (idx >= 0) {
            project.workflows[idx] = {
              ...project.workflows[idx],
              status: derived_status,
              step_count: steps.length,
              completed_steps: n_completed,
            }
          }
        }

        // Scan for recently-completed steps not yet tracked (e.g., dashboard opened after run finished)
        const FOUR_HOURS_AGO = Date.now() - 4 * 60 * 60 * 1000
        for (const step of steps) {
          const is_mlp_retro = step_is_mlp_live(step)
          if (
            (step.status === `completed` || step.status === `failed`) &&
            !tracked_steps.some(ts => ts.step.id === step.id) &&
            (
              VASP_NODE_TYPES.has(step.node_type)
              || ORCA_NODE_TYPES.has(step.node_type)
              || is_mlp_retro
            ) &&
            step.completed_at &&
            new Date(step.completed_at).getTime() > FOUR_HOURS_AGO
          ) {
            let convergence: { points: ConvergencePoint[]; converged: boolean } | null = null
            try {
              if (VASP_NODE_TYPES.has(step.node_type)) {
                convergence = await workflow_api.get_convergence(wf.id, step.id)
              } else if (ORCA_NODE_TYPES.has(step.node_type)) {
                convergence = await workflow_api.get_orca_progress(wf.id, step.id)
              } else {
                convergence = await workflow_api.get_mlp_progress(wf.id, step.id)
              }
            } catch {
              // Backend unavailable
            }
            if (convergence && convergence.points.length >= 2) {
              tracked_steps.push({
                workflow_id: wf.id,
                workflow_name: wf.name,
                step,
                convergence,
                is_running: false,
              })
            }
          }
        }
      } catch (err) {
        console.warn(`Failed to fetch steps for workflow ${wf.id}:`, err)
      }
    }

    // Refresh enriched results only on completion transition (running → not running)
    // Results don't meaningfully change during active execution, only on step completion
    if (prev_had_running && !has_running) {
      try {
        results = await project_api.get_enriched_results(project_id)
      } catch {
        // Ignore, results will update on next poll or manual refresh
      }
      // Revert to baseline cadence (not null) so the dashboard keeps noticing
      // new workflows that start later in the same session. The previous
      // behaviour cleared the interval entirely, which froze live updates
      // forever until a page reload once the first workflow finished.
    }
    prev_had_running = has_running

    // Adaptive cadence: MLP iterations land every 1-3 s, so 30 s polling is
    // noticeably stale. Switch between the 10 s MLP cadence and the baseline
    // (60 s Tauri / 30 s HTTP) whenever the running-MLP observation changes,
    // or whenever the last tick completed and we need to revert from MLP-
    // fast to baseline.
    const should_reschedule = (
      seen_running_mlp !== has_running_mlp
      || (!has_running && live_polling_interval == null)
    )
    if (seen_running_mlp !== has_running_mlp) {
      has_running_mlp = seen_running_mlp
    }
    if (should_reschedule) {
      reschedule_polling()
    }
  }

  function reschedule_polling() {
    if (live_polling_interval) {
      clearInterval(live_polling_interval)
      live_polling_interval = null
    }
    // Always keep the interval armed. Fast (10 s) while any MLP step is
    // running; baseline (60 s Tauri / 30 s HTTP) otherwise. Baseline is
    // cheap — one list_workflows_http call — and preserves the ability to
    // detect new runs starting later in the session.
    const baseline_ms = check_tauri() ? 60_000 : 30_000
    const poll_ms = has_running_mlp ? 10_000 : baseline_ms
    live_polling_interval = setInterval(() => update_live_steps(), poll_ms)
  }

  // Polling during and after execution
  onMount(() => {
    // Expose project_id so AI-created workflows can auto-assign to this project
    active_project_context.id = project_id

    // Run once immediately after project loads (picks up completed workflows)
    update_live_steps()

    // Initial baseline cadence. reschedule_polling() will switch to 10 s
    // the first time update_live_steps observes a running MLP step.
    const poll_ms = check_tauri() ? 60_000 : 30_000
    live_polling_interval = setInterval(() => update_live_steps(), poll_ms)

    return () => {
      active_project_context.id = ``
      if (live_polling_interval) clearInterval(live_polling_interval)
    }
  })

  async function save_project() {
    if (!project) return
    is_saving_project = true
    try {
      await project_api.update_project(project_id, { name: edit_name })
      project.name = edit_name
      save_project_flash = true
      setTimeout(() => (save_project_flash = false), 800)
      ondbchange?.()
    } catch (err) {
      error = String(err)
    } finally {
      is_saving_project = false
    }
  }

  async function create_workflow_in_project() {
    try {
      const graph_json = JSON.stringify({ nodes: [], edges: [] })
      const wf = await workflow_api.create_workflow(t('workflow.pd_untitled_wf'), graph_json)
      await project_api.assign_workflow_to_project(wf.id, project_id)
      await load_data()
      ondbchange?.()
      on_open_workflow(wf.id)
    } catch (err) {
      error = String(err)
    }
  }

  // For assigning existing engine workflows
  let show_engine_assign_picker = $state(false)
  let unassigned_engine_workflows = $state<Array<{ id: string; name: string }>>([])

  async function toggle_assign_picker() {
    if (show_assign_picker) {
      show_assign_picker = false
      return
    }
    try {
      const all = await workflow_api.list_workflows()
      const assigned_ids = new Set(project?.workflows?.map((w) => w.id) ?? [])
      unassigned_workflows = all
        .filter((w) => !assigned_ids.has(w.id))
        .map((w) => ({ id: w.id, name: w.name }))
      show_assign_picker = true
    } catch (err) {
      error = String(err)
    }
  }

  async function assign_wf(wf_id: string) {
    try {
      await project_api.assign_workflow_to_project(wf_id, project_id)
      show_assign_picker = false
      await load_data()
      ondbchange?.()
      on_open_workflow(wf_id)
    } catch (err) {
      error = String(err)
    }
  }

  async function toggle_engine_assign_picker() {
    if (show_engine_assign_picker) {
      show_engine_assign_picker = false
      return
    }
    try {
      const all = await list_v2_workflows()
      const assigned_ids = new Set(engine_workflows.map((w) => w.id))
      unassigned_engine_workflows = all
        .filter((w) => !w.project_id && !assigned_ids.has(w.id))
        .map((w) => ({ id: w.id, name: w.name }))
      show_engine_assign_picker = true
    } catch (err) {
      error = String(err)
    }
  }

  async function assign_engine_wf(wf_id: string) {
    try {
      await assign_v2_workflow_to_project(wf_id, project_id)
      show_engine_assign_picker = false
      await load_data()
      ondbchange?.()
    } catch (err) {
      error = String(err)
    }
  }

  async function delete_workflow(ev: MouseEvent, wf_id: string, wf_name: string) {
    ev.stopPropagation()
    const confirmMsg = t('workflow.pd_delete_confirm', { wf_name })
    if (!confirm(confirmMsg)) return
    try {
      await workflow_api.delete_workflow(wf_id)
      await load_data()
      ondbchange?.()
    } catch (err) {
      error = String(err)
    }
  }
</script>

<div class="project-dashboard">
  <!-- Header -->
  <div class="dash-header">
    <button class="back-btn" onclick={onback}>
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
      >
        <path d="M19 12H5M12 19l-7-7 7-7" />
      </svg>
      {t('workflow.pd_back')}
    </button>
    <input class="project-name-input" bind:value={edit_name} placeholder={t('workflow.pd_project_name')} />
    <button class="icon-btn" onclick={save_project} disabled={is_saving_project} title={t('workflow.pd_save_project')}>
      {#if save_project_flash}✓{:else if is_saving_project}...{:else}💾{/if}
    </button>
    <button class="icon-btn" onclick={load_data} title="Refresh">
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
      >
        <path d="M23 4v6h-6" />
        <path d="M1 20v-6h6" />
        <path
          d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"
        />
      </svg>
    </button>
    {#if onclose}
      <button class="icon-btn" onclick={onclose} title={t('workflow.pd_close_view')}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>
    {/if}
  </div>

  {#if error}
    <div class="error-bar">{error}</div>
  {/if}

  <!-- Summary stats bar -->
  {#if results.length > 0}
    <div class="stats-bar">
      <div class="stat">
        <span class="stat-value">{results.length}</span>
        <span class="stat-label">{t('workflow.pd_calculations')}</span>
      </div>
      <div class="stat">
        <span class="stat-value">{unique_formulas.size}</span>
        <span class="stat-label">{t('workflow.pd_formulas')}</span>
      </div>
      <div class="stat">
        <span class="stat-value">{energy_range}</span>
        <span class="stat-label">{t('workflow.pd_energy_range')}</span>
      </div>
      <div class="stat">
        <span class="stat-value">{(project?.workflows?.length ?? 0) + engine_workflows.length}</span>
        <span class="stat-label">{t('workflow.pd_workflows')}</span>
      </div>
    </div>
  {/if}

  <!-- Main content: sidebar + results -->
  <div class="dash-body">
    <!-- Workflows sidebar -->
    <div class="sidebar">
      <h3 class="sidebar-title">{t('workflow.pd_workflows')}</h3>
      {#if is_loading}
        <div class="sidebar-loading">{t('workflow.pd_loading')}</div>
      {:else if project?.workflows}
        <div class="workflow-list">
          {#each project.workflows as wf}
            <div class="wf-card-wrapper">
              <button class="wf-card" onclick={() => on_open_workflow(wf.id)}>
                <div class="wf-name">{wf.name}</div>
                <div class="wf-info">
                  <span
                    class="wf-status"
                    style="color: {STATUS_COLORS[wf.status] ?? `#475569`}"
                    >{wf.status.replace(/_/g, ` `)}</span
                  >
                  <span class="wf-progress"
                    >{wf.completed_steps}/{wf.step_count}</span
                  >
                </div>
                <!-- Simple progress bar -->
                <div class="progress-track">
                  <div
                    class="progress-fill"
                    style="width: {wf.step_count > 0
                      ? (wf.completed_steps / wf.step_count) * 100
                      : 0}%; background: {STATUS_COLORS[wf.status] ?? `#22c55e`}"
                  ></div>
                </div>
              </button>
              <button
                class="wf-delete-btn"
                title={t('workflow.pd_delete_wf')}
                onclick={(ev) => delete_workflow(ev, wf.id, wf.name)}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
          {/each}
        </div>
      {/if}
      <div class="sidebar-actions">
        <button class="action-btn" onclick={create_workflow_in_project}
          >{t('workflow.pd_new_wf')}</button
        >
        <button class="action-btn" onclick={toggle_assign_picker}
          >{t('workflow.pd_assign_existing')}</button
        >
      </div>
      {#if show_assign_picker && unassigned_workflows.length > 0}
        <div class="assign-picker">
          {#each unassigned_workflows as wf}
            <button class="assign-item" onclick={() => assign_wf(wf.id)}
              >{wf.name}</button
            >
          {/each}
        </div>
      {/if}
      {#if show_assign_picker && unassigned_workflows.length === 0}
        <div class="assign-empty">{t('workflow.pd_no_unassigned')}</div>
      {/if}

      <!-- Engine workflows section -->
        <h3 class="sidebar-title" style="margin-top: 20px;">{t('workflow.pd_engine_workflows')}</h3>
        {#if engine_workflows.length > 0}
          <div class="workflow-list">
            {#each engine_workflows as ewf}
              <div class="wf-card-wrapper">
                <button class="wf-card" onclick={() => on_open_engine_workflow?.(ewf.id)}>
                  <div class="wf-name">{ewf.name}</div>
                  <div class="wf-info">
                    <span
                      class="wf-status"
                      style="color: {STATUS_COLORS[ewf.status] ?? `#475569`}"
                      >{ewf.status.replace(/_/g, ` `)}</span
                    >
                    <span class="wf-progress">{t('workflow.pd_tasks', { n: ewf.task_count.toString() })}</span>
                  </div>
                </button>
              </div>
            {/each}
          </div>
        {/if}
        <div class="sidebar-actions">
          <button class="action-btn" onclick={toggle_engine_assign_picker}
            >{t('workflow.pd_assign_engine_wf')}</button
          >
        </div>
        {#if show_engine_assign_picker && unassigned_engine_workflows.length > 0}
          <div class="assign-picker">
            {#each unassigned_engine_workflows as ewf}
              <button class="assign-item" onclick={() => assign_engine_wf(ewf.id)}
                >{ewf.name}</button
              >
            {/each}
          </div>
        {/if}
        {#if show_engine_assign_picker && unassigned_engine_workflows.length === 0}
          <div class="assign-empty">{t('workflow.pd_no_unassigned_engine')}</div>
        {/if}
    </div>

    <!-- Results area -->
    <div class="results-area">
      {#if results.length === 0 && !is_loading && !has_mace_benchmark}
        <div class="empty-results">
          <p>{t('workflow.pd_no_results')}</p>
        </div>
      {:else if results.length > 0 || has_mace_benchmark}
        <!-- Tab bar -->
        <div class="tab-bar">
          <button
            class="tab"
            class:active={active_tab === `table`}
            onclick={() => (active_tab = `table`)}
          >
            {t('workflow.pd_tab_table')}
          </button>
          <button
            class="tab"
            class:active={active_tab === `plot`}
            onclick={() => (active_tab = `plot`)}
          >
            {t('workflow.pd_tab_plot')}
          </button>
          {#if has_mace_benchmark}
            <button
              class="tab"
              class:active={active_tab === `benchmark`}
              onclick={() => (active_tab = `benchmark`)}
            >
              {t('workflow.pd_tab_benchmark')}
            </button>
          {/if}
        </div>

        <!-- Tab content -->
        <div class="tab-content">
          {#if active_tab === `table`}
            <ResultsTable
              {results}
              on_select_change={(sel) => (selected_results = sel)}
            />
          {:else if active_tab === `plot`}
            <ResultsPlot
              {results}
              selected_results={selected_results.length > 0
                ? selected_results
                : undefined}
            />
          {:else if active_tab === `benchmark`}
            <BenchmarkTable {project} />
          {/if}
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  .project-dashboard {
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--page-bg);
    color: var(--text-color, #eee);
    font-family: 'SF Mono', 'Cascadia Code', 'JetBrains Mono', monospace;
    font-size: 13px;
  }

  .dash-header {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 12px;
    padding: 16px 24px;
    border-bottom: 1px solid var(--border-color);
  }

  .back-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    background: none;
    border: 1px solid var(--border-color);
    border-radius: 6px;
    color: var(--text-color-muted, #94a3b8);
    font-size: 12px;
    cursor: pointer;
  }

  .back-btn:hover {
    background: var(--surface-bg-hover);
    color: var(--text-color, #eee);
  }

  .project-name-input {
    font-size: 18px;
    font-weight: 700;
    flex: 1;
    margin: 0;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 4px;
    color: var(--text-color, #eee);
    padding: 4px 8px;
    font-family: inherit;
  }
  .project-name-input:hover { border-color: var(--border-color); }
  .project-name-input:focus { border-color: var(--accent-color, #3b82f6); outline: none; }

  .icon-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 6px;
    background: none;
    border: 1px solid var(--border-color);
    border-radius: 6px;
    color: var(--text-color-muted, #94a3b8);
    cursor: pointer;
  }

  .icon-btn:hover {
    background: var(--surface-bg-hover);
    color: var(--text-color, #eee);
  }

  .error-bar {
    padding: 8px 12px;
    background: rgba(239, 68, 68, 0.15);
    border: 1px solid rgba(239, 68, 68, 0.3);
    border-radius: 6px;
    color: #ef4444;
    font-size: 12px;
    margin: 0 24px;
  }

  .stats-bar {
    display: flex;
    flex-direction: row;
    gap: 24px;
    padding: 12px 24px;
    border-bottom: 1px solid var(--border-color);
    background: var(--surface-bg);
  }

  .stat {
    display: flex;
    flex-direction: column;
  }

  .stat-value {
    font-size: 18px;
    font-weight: 700;
    color: var(--text-color, #eee);
  }

  .stat-label {
    font-size: 11px;
    color: var(--text-color-muted);
  }

  .dash-body {
    flex: 1;
    display: grid;
    grid-template-columns: 280px 1fr;
    overflow: hidden;
  }

  .sidebar {
    border-right: 1px solid var(--border-color);
    overflow-y: auto;
    padding: 16px;
  }

  .sidebar-title {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-color-muted);
    text-transform: uppercase;
    letter-spacing: 1px;
    margin: 0 0 12px 0;
  }

  .sidebar-loading {
    padding: 12px;
    text-align: center;
    color: var(--text-color-muted);
    font-size: 12px;
  }

  .workflow-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .wf-card-wrapper {
    position: relative;
  }

  .wf-card-wrapper:hover .wf-delete-btn {
    opacity: 1;
  }

  .wf-delete-btn {
    position: absolute;
    top: 6px;
    right: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    padding: 0;
    background: none;
    border: none;
    border-radius: 4px;
    color: var(--text-color-muted, #94a3b8);
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.15s, color 0.15s, background 0.15s;
    z-index: 1;
  }

  .wf-delete-btn:hover {
    color: #ef4444;
    background: rgba(239, 68, 68, 0.15);
  }

  .wf-card {
    width: 100%;
    background: var(--surface-bg);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    padding: 10px 12px;
    text-align: left;
    color: inherit;
    cursor: pointer;
    transition: border-color 0.2s;
  }

  .wf-card:hover {
    border-color: var(--surface-bg-hover);
  }

  .wf-name {
    font-size: 13px;
    font-weight: 600;
  }

  .wf-info {
    display: flex;
    gap: 8px;
    font-size: 11px;
    color: var(--text-color-muted);
    margin-top: 4px;
  }

  .wf-status {
    font-weight: 600;
    text-transform: uppercase;
    font-size: 10px;
  }

  .wf-progress {
    color: var(--text-color-muted);
  }

  .progress-track {
    height: 3px;
    background: var(--border-color);
    border-radius: 2px;
    margin-top: 6px;
  }

  .progress-fill {
    height: 100%;
    background: #22c55e;
    border-radius: 2px;
    transition: width 0.3s;
  }

  .sidebar-actions {
    margin-top: 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .action-btn {
    padding: 8px 12px;
    background: rgba(59, 130, 246, 0.1);
    border: 1px solid rgba(59, 130, 246, 0.2);
    border-radius: 6px;
    color: #60a5fa;
    font-size: 12px;
    cursor: pointer;
    transition: background 0.2s;
  }

  .action-btn:hover {
    background: rgba(59, 130, 246, 0.2);
  }

  .assign-picker {
    margin-top: 8px;
    background: var(--surface-bg);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    overflow: hidden;
  }

  .assign-item {
    width: 100%;
    padding: 8px 12px;
    background: none;
    border: none;
    border-bottom: 1px solid var(--border-color);
    color: var(--text-color-muted, #94a3b8);
    font-size: 12px;
    text-align: left;
    cursor: pointer;
    transition: all 0.15s;
  }

  .assign-item:last-child {
    border-bottom: none;
  }

  .assign-item:hover {
    background: var(--surface-bg-hover);
    color: var(--text-color, #eee);
  }

  .assign-empty {
    margin-top: 8px;
    padding: 8px 12px;
    font-size: 11px;
    color: var(--text-color-muted);
    text-align: center;
  }

  .results-area {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .tab-bar {
    display: flex;
    gap: 0;
    border-bottom: 1px solid var(--border-color);
    padding: 0 24px;
  }

  .tab {
    padding: 10px 20px;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--text-color-muted);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: color 0.15s;
  }

  .tab:hover {
    color: var(--text-color-muted, #94a3b8);
  }

  .tab.active {
    color: var(--accent-color, #3b82f6);
    border-bottom-color: var(--accent-color, #3b82f6);
  }

  .tab-content {
    flex: 1;
    overflow: auto;
    padding: 16px 24px;
  }

  .empty-results {
    text-align: center;
    color: var(--text-color-muted);
    padding: 48px;
    font-size: 13px;
  }

</style>

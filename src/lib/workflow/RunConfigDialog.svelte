<script lang="ts">
  import '$lib/dialog-shared.css'
  import type { WorkflowRunConfig, JobScriptParams, ClusterConfig } from './workflow-types'
  import { API_BASE } from '$lib/api/config'

  let {
    show = false,
    sessions = [],
    workflow_nodes = [],
    onrun,
    onclose,
    onconnect,
  }: {
    show?: boolean
    sessions?: Array<{ id: string; host: string; username: string; conda_activate?: string }>
    workflow_nodes?: any[]
    onrun?: (config: WorkflowRunConfig) => void
    onclose?: () => void
    onconnect?: () => void
  } = $props()

  // ─── Preset type ───
  interface JobScriptPreset {
    id: string
    name: string
    template: string
  }

  // ─── Tabs ───
  type Tab = 'clusters' | 'params' | 'settings'
  let active_tab = $state<Tab>(`clusters`)

  // ─── State: Global ───
  let execution_mode = $state<`local` | `hpc`>(`local`)
  let lmp_command = $state(`lmp_serial`)
  let local_work_dir = $state(``)
  let selected_session_id = $state(``)
  let base_work_dir = $state(``)
  let use_custodian = $state(true)
  let custodian_max_errors = $state(5)

  // ─── CP2K Settings tab — defaults match the most common periodic DFT setup ───
  // Cutoff / rel_cutoff are GPW grid params; OT is the orbital-transformation
  // SCF method (fast for insulators / closed-shell, disable for metals);
  // max_scf + eps_scf are the standard SCF convergence knobs.
  let cp2k_cutoff = $state(400)        // Ry
  let cp2k_rel_cutoff = $state(60)     // Ry
  let cp2k_use_ot = $state(true)
  let cp2k_max_scf = $state(50)
  let cp2k_eps_scf = $state(1e-6)
  let poll_interval = $state(15)
  let orca_binary = $state(`orca`)
  // Settings-tab software selection. The dropdown is always populated with
  // every supported engine; `calc_mode` here is what the user picks in the
  // UI — initialised from auto-detect but never overwritten after the user
  // touches the dropdown (`user_picked_calc_mode`).
  type CalcMode = 'vasp' | 'orca' | 'cp2k' | 'qe' | 'mlp' | 'xtb' | 'lammps'
  let calc_mode = $state<CalcMode>('vasp')
  let user_picked_calc_mode = $state(false)

  // ─── Engine detection from workflow nodes ───
  const has_orca_nodes = $derived(
    workflow_nodes.some((n: any) => {
      const t = n.type || ``
      const sw = n.params?.software || ``
      const calc = n.params?.calculator || ``
      return t.startsWith(`orca_`) || sw === `orca` || calc === `orca` || t === `sella_ts`
    })
  )
  const has_vasp_nodes = $derived(
    workflow_nodes.some((n: any) => {
      const t = n.type || ``
      const sw = n.params?.software || ``
      return t.startsWith(`vasp_`) || sw === `vasp` || (t === `geo_opt` && (!sw || sw === `vasp`))
    })
  )

  const has_mlp_nodes = $derived(
    workflow_nodes.some((n: any) => {
      const sw = n.params?.software || ``
      return sw === `mlp` || n.type === `mlp_relax` || n.type === `mlp_md`
    })
  )
  const has_lammps_nodes = $derived(
    workflow_nodes.some((n: any) => {
      const t = n.type || ``
      const sw = n.params?.software || ``
      return sw === `lammps` || t === `lammps_md` || t === `polymer_md` || t === `polymer_deform` || t === `glass_transition`
    })
  )
  const has_cp2k_nodes = $derived(
    workflow_nodes.some((n: any) => {
      const t = n.type || ``
      const sw = n.params?.software || ``
      return t.startsWith(`cp2k_`) || sw === `cp2k`
    })
  )
  const has_qe_nodes = $derived(
    workflow_nodes.some((n: any) => {
      const t = n.type || ``
      const sw = n.params?.software || ``
      return t.startsWith(`qe_`) || sw === `qe`
    })
  )
  const has_xtb_nodes = $derived(
    workflow_nodes.some((n: any) => {
      const sw = n.params?.software || ``
      const calc = n.params?.calculator || ``
      return sw === `xtb` || calc === `xtb` || calc?.startsWith?.(`GFN`)
    })
  )

  // Auto-pick an initial calc_mode the first time the dialog opens for a
  // given workflow. After the user manually switches the dropdown we leave
  // it alone — they're typically configuring a software not yet wired in,
  // and re-imposing the detection would erase their pick on every render.
  $effect(() => {
    if (!show || user_picked_calc_mode) return
    if (has_vasp_nodes) calc_mode = `vasp`
    else if (has_cp2k_nodes) calc_mode = `cp2k`
    else if (has_orca_nodes) calc_mode = `orca`
    else if (has_qe_nodes) calc_mode = `qe`
    else if (has_lammps_nodes) calc_mode = `lammps`
    else if (has_xtb_nodes) calc_mode = `xtb`
    else if (has_mlp_nodes) calc_mode = `mlp`
  })

  // ─── State: Per-cluster ───
  let cluster_configs = $state<Record<string, ClusterConfig>>({})

  // ─── State: Templates ───
  let presets = $state<JobScriptPreset[]>([])
  let presets_error = $state(``)
  let fallback_template = $state(``)

  // ─── State: Python env profiles ───
  interface EnvProfile { name: string; commands: string }
  const ENV_PROFILES_KEY = `catgo-python-env-profiles`
  let env_profiles = $state<EnvProfile[]>(load_env_profiles())

  function load_env_profiles(): EnvProfile[] {
    try {
      const raw = localStorage.getItem(ENV_PROFILES_KEY)
      return raw ? JSON.parse(raw) : []
    } catch { return [] }
  }

  function save_env_profiles_to_storage() {
    try {
      localStorage.setItem(ENV_PROFILES_KEY, JSON.stringify(env_profiles))
    } catch {}
  }

  function save_env_profile() {
    const commands = active_cluster?.python_env?.trim()
    if (!commands) return
    const name = prompt(`Save Python env profile as:`)
    if (!name?.trim()) return
    // Replace existing profile with same name
    const idx = env_profiles.findIndex(p => p.name === name.trim())
    if (idx >= 0) {
      env_profiles[idx] = { name: name.trim(), commands }
    } else {
      env_profiles.push({ name: name.trim(), commands })
    }
    save_env_profiles_to_storage()
  }

  function manage_env_profiles() {
    const names = env_profiles.map((p, i) => `${i + 1}. ${p.name}`).join(`\n`)
    const input = prompt(`Delete a profile (enter number):\n\n${names}\n\nOr type "clear" to delete all.`)
    if (!input) return
    if (input.trim().toLowerCase() === `clear`) {
      env_profiles.length = 0
    } else {
      const idx = parseInt(input) - 1
      if (idx >= 0 && idx < env_profiles.length) {
        env_profiles.splice(idx, 1)
      }
    }
    save_env_profiles_to_storage()
  }

  // ─── State: Default job params ───
  let nodes = $state(1)
  let ntasks = $state(96)
  let cpus_per_task = $state(2)
  let walltime = $state(`24:00:00`)
  let partition = $state(`workq`)
  let memory = $state(``)

  // POTCAR root shown on Parameters tab — syncs to all cluster configs
  let _param_potcar_root = $state(`/scratch/reny0b/VASP/pot64`)
  function _sync_potcar_to_clusters(val: string) {
    _param_potcar_root = val
    for (const id in cluster_configs) {
      cluster_configs[id].potcar_root = val
    }
  }

  const CLUSTER_PRESETS: Record<string, ClusterConfig> = {
    shaheen: {
      potcar_root: `/scratch/reny0b/VASP/pot64`,
      potcar_functional: `potpaw_PBE`,
      vasp_command: `srun --hint=nomultithread vasp_std`,
      python_env: `source /scratch/reny0b/iops/sw/miniconda3-amd64/etc/profile.d/conda.sh\nconda activate /scratch/reny0b/iops/sw/envs/gs`,
      default_template: ``,
      default_job_params: { nodes: 1, ntasks: 96, cpus_per_task: 2, walltime: `24:00:00`, partition: `workq` },
      account: ``,
      module_loads: ``,
      orca_dir: ``,
    },
    expanse: {
      potcar_root: `/home/wli7/bin/vasp_pot`,
      potcar_functional: `potpaw_PBE`,
      vasp_command: `srun vasp_std > vasp.out 2> vasp.err`,
      python_env: `source ~/miniforge3/etc/profile.d/conda.sh\nconda activate catgo`,
      default_template: ``,
      default_job_params: { nodes: 1, ntasks: 32, cpus_per_task: 1, walltime: `24:00:00`, partition: `shared` },
      account: `sdp126`,
      module_loads: ``,
      orca_dir: ``,
    },
  }

  const GENERIC_DEFAULTS: ClusterConfig = {
    potcar_root: ``,
    potcar_functional: `potpaw_PBE`,
    vasp_command: `srun vasp_std`,
    python_env: ``,
    default_template: ``,
    default_job_params: { nodes: 1, ntasks: 32, cpus_per_task: 1, walltime: `24:00:00`, partition: `` },
    account: ``,
    module_loads: ``,
    orca_dir: ``,
  }

  function defaults_for_host(host: string): ClusterConfig {
    const h = host.toLowerCase()
    if (h.includes(`shaheen`)) return { ...CLUSTER_PRESETS.shaheen }
    if (h.includes(`expanse`)) return { ...CLUSTER_PRESETS.expanse }
    return { ...GENERIC_DEFAULTS }
  }

  // ─── localStorage persistence ───
  const STORAGE_KEY = `catgo-cluster-configs`
  const GLOBAL_PARAMS_KEY = `catgo-run-params`

  function hostname_key(host: string): string {
    return host.replace(/^.*@/, ``).toLowerCase()
  }

  function load_saved_configs(): Record<string, ClusterConfig> {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      return raw ? JSON.parse(raw) : {}
    } catch { return {} }
  }

  function save_configs_to_storage() {
    try {
      const to_save: Record<string, ClusterConfig> = {}
      for (const s of sessions) {
        const cfg = cluster_configs[s.id]
        if (cfg) to_save[hostname_key(s.host)] = { ...cfg }
      }
      if (Object.keys(to_save).length > 0) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(to_save))
      }
    } catch {}
  }

  // ─── Initialize cluster configs when sessions change ───
  $effect(() => {
    const saved = load_saved_configs()
    for (const s of sessions) {
      if (!(s.id in cluster_configs)) {
        const hkey = hostname_key(s.host)
        const saved_cfg = saved[hkey]
        const defaults = defaults_for_host(s.host)
        // Saved config takes priority, fill missing fields from defaults
        cluster_configs[s.id] = saved_cfg
          ? { ...defaults, ...saved_cfg }
          : defaults
      }
      // Auto-populate python_env from detected conda if empty
      const cfg = cluster_configs[s.id]
      if (cfg && !cfg.python_env && s.conda_activate) {
        cfg.python_env = s.conda_activate
      }
    }
  })

  // ─── Auto-save cluster configs on change ───
  $effect(() => {
    // Touch all config values to establish reactive dependency
    for (const s of sessions) {
      const cfg = cluster_configs[s.id]
      if (cfg) void [cfg.python_env, cfg.account, cfg.potcar_root, cfg.vasp_command, cfg.default_template, cfg.module_loads, cfg.orca_dir]
    }
    save_configs_to_storage()
  })

  // ─── Load saved global job params + execution mode ───
  $effect(() => {
    if (!show) return
    try {
      const raw = localStorage.getItem(GLOBAL_PARAMS_KEY)
      if (!raw) return
      const p = JSON.parse(raw)
      if (p.nodes) nodes = p.nodes
      if (p.ntasks) ntasks = p.ntasks
      if (p.cpus_per_task) cpus_per_task = p.cpus_per_task
      if (p.walltime) walltime = p.walltime
      if (p.partition) partition = p.partition
      if (p.memory) memory = p.memory
      if (p.execution_mode === `hpc` || p.execution_mode === `local`) {
        execution_mode = p.execution_mode
      }
      // CP2K Settings — restore from last session if present.
      if (typeof p.cp2k_cutoff === `number`) cp2k_cutoff = p.cp2k_cutoff
      if (typeof p.cp2k_rel_cutoff === `number`) cp2k_rel_cutoff = p.cp2k_rel_cutoff
      if (typeof p.cp2k_use_ot === `boolean`) cp2k_use_ot = p.cp2k_use_ot
      if (typeof p.cp2k_max_scf === `number`) cp2k_max_scf = p.cp2k_max_scf
      if (typeof p.cp2k_eps_scf === `number`) cp2k_eps_scf = p.cp2k_eps_scf
    } catch {}
  })

  // ─── Load presets on mount ───
  $effect(() => {
    if (!show) return

    fetch(`${API_BASE}/workflow/job-script-presets`)
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then((data: JobScriptPreset[]) => {
        presets = data
        presets_error = ``
      })
      .catch(err => {
        presets_error = `Failed to load presets: ${err.message}`
        presets = []
      })
  })

  // ─── Auto-select first session ───
  $effect(() => {
    if (sessions.length > 0 && (!selected_session_id || !sessions.some(s => s.id === selected_session_id))) {
      selected_session_id = sessions[0].id
    }
  })

  // ─── Derived ───
  let poll_label = $derived(
    poll_interval < 60
      ? `${poll_interval}s`
      : `${Math.floor(poll_interval / 60)}m ${poll_interval % 60}s`
  )

  let active_cluster_id = $state(``)
  $effect(() => {
    if (sessions.length > 0 && (!active_cluster_id || !sessions.some(s => s.id === active_cluster_id))) {
      active_cluster_id = sessions[0].id
    }
  })

  // ─── Seed Parameters tab from the cluster preset, once per session selection ───
  // Tracked by last_synced_session_id so unrelated cluster_configs proxy mutations
  // (POTCAR root, account, module_loads, …) don't re-fire this effect and clobber
  // the user's typed-in box values. Cluster preset only writes when the selected
  // session actually transitions.
  let last_synced_session_id = $state(``)
  $effect(() => {
    const sid = selected_session_id
    if (!sid) return
    if (sid === last_synced_session_id) return
    const s = sessions.find(ss => ss.id === sid)
    if (!s) return
    const cfg = cluster_configs[sid]
    if (!cfg?.default_job_params) return
    last_synced_session_id = sid

    const jp = cfg.default_job_params
    nodes = jp.nodes ?? 1
    ntasks = jp.ntasks ?? 32
    cpus_per_task = jp.cpus_per_task ?? 1
    walltime = jp.walltime ?? `24:00:00`
    partition = jp.partition ?? ``
    // Set base_work_dir based on cluster
    const h = s.host.toLowerCase()
    if (h.includes(`expanse`) && !base_work_dir) {
      base_work_dir = `/expanse/projects/qstore/csd807/gliu3/catgo/opt-1`
    } else if ((h.includes(`shaheen`) || h.includes(`kaust`)) && !base_work_dir) {
      base_work_dir = `/scratch/${s.username}/catgo/workflows`
    } else if (!base_work_dir) {
      base_work_dir = `/home/${s.username}/catgo/workflows`
    }
  })

  // ─── Restore saved global job params + execution mode on dialog open ───
  // Registered AFTER the cluster-sync effect so on first open localStorage wins
  // the initial flush race — boxes show the user's last-used values, not the
  // cluster preset. handle_run writes back here on Run so MCP / next open sees
  // what was actually submitted.
  $effect(() => {
    if (!show) return
    try {
      const raw = localStorage.getItem(GLOBAL_PARAMS_KEY)
      if (!raw) return
      const p = JSON.parse(raw)
      if (p.nodes) nodes = p.nodes
      if (p.ntasks) ntasks = p.ntasks
      if (p.cpus_per_task) cpus_per_task = p.cpus_per_task
      if (p.walltime) walltime = p.walltime
      if (p.partition) partition = p.partition
      if (p.memory) memory = p.memory
      if (p.execution_mode === `hpc` || p.execution_mode === `local`) {
        execution_mode = p.execution_mode
      }
    } catch {}
  })

  let active_cluster = $derived(cluster_configs[active_cluster_id])
  let active_session = $derived(sessions.find(s => s.id === active_cluster_id))

  // ─── Handlers ───
  function apply_preset(template: string) {
    if (active_cluster_id && cluster_configs[active_cluster_id]) {
      cluster_configs[active_cluster_id].default_template = template
    } else {
      fallback_template = template
    }
  }

  function handle_run() {
    // Mismatch warning: user chose a Settings panel for a software whose
    // nodes don't appear in the workflow. Skip when the workflow is empty
    // (anything goes) and when the choice does match. The confirm() is a
    // soft gate — power users sometimes want to pre-fill CP2K knobs before
    // adding the node, and the alternative (silently dropping the chosen
    // settings or blocking Run) is worse.
    const calc_mode_present: Record<CalcMode, boolean> = {
      vasp: has_vasp_nodes, orca: has_orca_nodes, cp2k: has_cp2k_nodes,
      qe: has_qe_nodes, mlp: has_mlp_nodes, xtb: has_xtb_nodes, lammps: has_lammps_nodes,
    }
    const any_known = Object.values(calc_mode_present).some(Boolean)
    if (any_known && !calc_mode_present[calc_mode]) {
      const ok = confirm(
        `You configured settings for ${calc_mode.toUpperCase()}, but the workflow has no ` +
        `${calc_mode.toUpperCase()} nodes. Continue anyway?`,
      )
      if (!ok) return
    }

    // Persist global job params + execution mode for next session
    try {
      localStorage.setItem(GLOBAL_PARAMS_KEY, JSON.stringify({
        nodes, ntasks, cpus_per_task, walltime, partition, memory, execution_mode,
        cp2k_cutoff, cp2k_rel_cutoff, cp2k_use_ot, cp2k_max_scf, cp2k_eps_scf,
      }))
    } catch {}

    // Send all box values explicitly (no truthy-guard) — if the user cleared a
    // field, that empty value should propagate so the backend's setdefault on
    // the cluster preset doesn't silently re-pull a stale default.
    const default_job_params: JobScriptParams = {
      nodes,
      ntasks,
      cpus_per_task,
      walltime,
      partition,
      memory,
    }

    // Determine fallback template from first cluster or presets
    let job_script_template = fallback_template
    if (!job_script_template.trim()) {
      const first_cluster = Object.values(cluster_configs).find(c => c.default_template.trim())
      if (first_cluster) job_script_template = first_cluster.default_template
    }

    const config: WorkflowRunConfig = {
      execution_mode,
      lmp_command,
      local_work_dir,
      default_session_id: selected_session_id,
      job_script_template,
      cluster_configs,
      calc_templates: {},
      base_work_dir,
      poll_interval,
      step_sessions: {},
      step_scripts: {},
      step_job_params: {},
      default_job_params,
      use_custodian,
      custodian_max_errors,
      orca_binary,
      // Per-software defaults nested under `defaults.{sw}` — Scanner's
      // _merged_config merges these into the engine config so each task's
      // engine builtin (e.g. _gen_cp2k) can fall back to them when the
      // node params don't override. Matches the existing ORCA pattern.
      defaults: {
        cp2k: {
          cutoff: cp2k_cutoff,
          rel_cutoff: cp2k_rel_cutoff,
          // CP2K engine reads scf_method as a string; UI exposes the
          // common bool toggle. Anything other than OT falls back to
          // diagonalisation with Fermi smearing inside CP2K itself.
          scf_method: cp2k_use_ot ? `OT` : `DIAGONALIZATION`,
          max_scf: cp2k_max_scf,
          eps_scf: cp2k_eps_scf,
        },
      },
    }

    onrun?.(config)
  }

  let mousedown_on_backdrop = false

  function handle_backdrop_down(e: MouseEvent) {
    mousedown_on_backdrop = e.target === e.currentTarget
  }
  function handle_backdrop_up(e: MouseEvent) {
    if (mousedown_on_backdrop && e.target === e.currentTarget) {
      onclose?.()
    }
    mousedown_on_backdrop = false
  }
  function handle_keydown(e: KeyboardEvent) {
    if (e.key === `Escape`) onclose?.()
  }
</script>

{#if show}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="backdrop dialog-backdrop" onmousedown={handle_backdrop_down} onmouseup={handle_backdrop_up} onkeydown={handle_keydown} role="dialog" aria-modal="true" tabindex="-1">
    <div class="modal dialog-modal">
      <div class="modal-header">
        <h2 class="modal-title">Run Configuration</h2>
        <button class="close-btn" onclick={() => onclose?.()}>x</button>
      </div>

      <!-- Execution Mode Toggle -->
      <div class="modal-body" style="padding-bottom: 0;">
        <section class="section">
          <h3 class="section-title">Execution Mode</h3>
          <div class="mode-toggle">
            <button
              class="mode-btn"
              class:active={execution_mode === `local`}
              onclick={() => execution_mode = `local`}
            >
              <span class="mode-icon">&#x1F4BB;</span>
              Local
            </button>
            <button
              class="mode-btn"
              class:active={execution_mode === `hpc`}
              onclick={() => execution_mode = `hpc`}
            >
              <span class="mode-icon">&#x1F5A5;</span>
              HPC Cluster
            </button>
          </div>
          <div class="mode-desc">
            {#if execution_mode === `local`}
              Run MLP (MACE/CHGNet) and LAMMPS calculations on this machine. VASP, ORCA, and other HPC-only codes are not available in local mode.
            {:else}
              Submit all calculations to a remote HPC cluster via SSH. Requires a connected cluster with the appropriate software installed.
            {/if}
          </div>
          {#if execution_mode === `hpc` && has_mlp_nodes}
            <div class="mode-warn">
              Your workflow includes MLP nodes (MACE/CHGNet). Make sure <strong>Python Environment</strong> is configured in Cluster Settings so the HPC can find the ML potential packages.
            </div>
          {/if}
        </section>
      </div>

      {#if execution_mode === `local`}
        <!-- Local mode warnings -->
        {#if has_vasp_nodes || has_orca_nodes}
          <div class="modal-body" style="padding-bottom: 0">
            <div class="mode-warn">
              Your workflow has {has_vasp_nodes ? `VASP` : ``}{has_vasp_nodes && has_orca_nodes ? ` and ` : ``}{has_orca_nodes ? `ORCA` : ``} nodes which require an HPC cluster. Switch to <strong>HPC Cluster</strong> mode or remove those nodes.
            </div>
          </div>
        {/if}
        <!-- Local Settings -->
        <div class="modal-body">
          <section class="section">
            <h3 class="section-title">Local Settings</h3>
            <div class="field" style="margin-bottom: 10px">
              <label class="field-label">LAMMPS Command</label>
              <input class="input" type="text" bind:value={lmp_command} placeholder="lmp_serial" />
              <div class="help-text">
                LAMMPS executable name or full path. Common: <code>lmp_serial</code> <code>lmp_mpi</code> <code>lmp</code>
              </div>
            </div>
            <div class="field">
              <label class="field-label">Work Directory <span class="optional">(optional)</span></label>
              <input class="input" type="text" bind:value={local_work_dir} placeholder="Auto (temp directory)" />
              <div class="help-text">
                Leave empty to use a temporary directory. Otherwise specify an absolute path.
              </div>
            </div>
          </section>
        </div>
      {:else}
        <!-- HPC Mode: Tabs -->
        <div class="tab-bar">
          <button class="tab" class:active={active_tab === 'clusters'} onclick={() => active_tab = 'clusters'}>Clusters</button>
          <button class="tab" class:active={active_tab === 'params'} onclick={() => active_tab = 'params'}>Parameters</button>
          <button class="tab" class:active={active_tab === 'settings'} onclick={() => active_tab = 'settings'}>Settings</button>
      </div>

      <!-- Software Toggle — drives both Clusters tab field set + Settings tab
           panel. Always shows every supported engine so the user can pre-configure
           cluster paths for a software not yet in the workflow. A ✓ marks
           engines whose nodes actually appear in this workflow. -->
      <div class="calc-mode-bar">
        <button class="mode-btn" class:active={calc_mode === 'vasp'}
          onclick={() => { calc_mode = 'vasp'; user_picked_calc_mode = true }}
          title="VASP — periodic DFT">VASP{has_vasp_nodes ? ` ✓` : ``}</button>
        <button class="mode-btn" class:active={calc_mode === 'cp2k'}
          onclick={() => { calc_mode = 'cp2k'; user_picked_calc_mode = true }}
          title="CP2K — Gaussian-plane-wave DFT (GPW)">CP2K{has_cp2k_nodes ? ` ✓` : ``}</button>
        <button class="mode-btn" class:active={calc_mode === 'orca'}
          onclick={() => { calc_mode = 'orca'; user_picked_calc_mode = true }}
          title="ORCA — quantum chemistry">ORCA{has_orca_nodes ? ` ✓` : ``}</button>
        <button class="mode-btn" class:active={calc_mode === 'qe'}
          onclick={() => { calc_mode = 'qe'; user_picked_calc_mode = true }}
          title="Quantum ESPRESSO — plane-wave DFT">QE{has_qe_nodes ? ` ✓` : ``}</button>
        <button class="mode-btn" class:active={calc_mode === 'mlp'}
          onclick={() => { calc_mode = 'mlp'; user_picked_calc_mode = true }}
          title="MLP — MACE / CHGNet / M3GNet ML potentials">MLP{has_mlp_nodes ? ` ✓` : ``}</button>
        <button class="mode-btn" class:active={calc_mode === 'xtb'}
          onclick={() => { calc_mode = 'xtb'; user_picked_calc_mode = true }}
          title="xTB — semi-empirical tight binding">xTB{has_xtb_nodes ? ` ✓` : ``}</button>
        <button class="mode-btn" class:active={calc_mode === 'lammps'}
          onclick={() => { calc_mode = 'lammps'; user_picked_calc_mode = true }}
          title="LAMMPS — classical molecular dynamics">LAMMPS{has_lammps_nodes ? ` ✓` : ``}</button>
      </div>

      <div class="modal-body">

        <!-- ═══════════ Tab: Clusters ═══════════ -->
        {#if active_tab === 'clusters'}

          <!-- Default cluster -->
          <section class="section">
            <h3 class="section-title">Default HPC Cluster</h3>
            {#if sessions.length === 0}
              <div class="empty-state">
                <div class="empty-icon">&#x1F5A5;</div>
                <p class="empty-text">No HPC clusters connected</p>
                <p class="empty-sub">Connect to a remote cluster via SSH to submit workflow jobs.</p>
                {#if onconnect}
                  <button class="btn btn-connect" onclick={() => onconnect?.()}>+ Connect HPC Cluster</button>
                {/if}
              </div>
            {:else}
              <div class="select-row">
                <select class="input select" bind:value={selected_session_id}>
                  {#each sessions as s}
                    <option value={s.id}>{s.username}@{s.host}</option>
                  {/each}
                </select>
                {#if onconnect}
                  <button class="btn-add-cluster" onclick={() => onconnect?.()} title="Connect another cluster">+</button>
                {/if}
              </div>
            {/if}
          </section>

          <!-- Per-cluster settings -->
          {#if sessions.length > 0}
            <section class="section">
              <h3 class="section-title">Cluster Settings</h3>

              {#if sessions.length > 1}
                <div class="cluster-tabs">
                  {#each sessions as s}
                    <button
                      class="cluster-tab"
                      class:active={active_cluster_id === s.id}
                      onclick={() => active_cluster_id = s.id}
                    >
                      {s.username}@{s.host}
                    </button>
                  {/each}
                </div>
              {/if}

              {#if active_cluster && active_session}
                <div class="cluster-fields">
                  {#if calc_mode === 'vasp'}
                    <label class="field-label">POTCAR Root Directory</label>
                    <input class="input" type="text" placeholder="e.g. /scratch/user/VASP/pot64"
                      bind:value={active_cluster.potcar_root} />
                    <div class="help-text">Base directory containing POTCAR files on {active_session.host}</div>

                    <label class="field-label" style="margin-top: 8px">POTCAR Functional</label>
                    <select class="input select" bind:value={active_cluster.potcar_functional}>
                      <option value="potpaw_PBE">potpaw_PBE</option>
                      <option value="potpaw_PBE.64">potpaw_PBE.64</option>
                      <option value="potpaw_PBE.54">potpaw_PBE.54</option>
                      <option value="potpaw_PBE.52">potpaw_PBE.52</option>
                      <option value="potpaw_LDA">potpaw_LDA</option>
                      <option value="potpaw_LDA.64">potpaw_LDA.64</option>
                      <option value="potpaw_GGA">potpaw_GGA</option>
                      <option value="POT_GGA_PAW_PBE">POT_GGA_PAW_PBE</option>
                      <option value="POT_LDA_PAW">POT_LDA_PAW</option>
                    </select>

                    <label class="field-label" style="margin-top: 8px">VASP Run Command</label>
                    <input class="input" type="text" placeholder="e.g. srun --map-by-numa --hint=nomultithread vasp_std"
                      bind:value={active_cluster.vasp_command} />
                    <div class="help-text">
                      Used by custodian and <code>{"{{vasp_run_command}}"}</code> in templates
                    </div>
                  {:else if calc_mode === 'cp2k'}
                    <label class="field-label">CP2K Data Directory</label>
                    <input class="input" type="text" placeholder="e.g. /opt/cp2k/2024.1/data or $CP2K_DATA_DIR"
                      bind:value={active_cluster.cp2k_data_dir} />
                    <div class="help-text">
                      Directory containing BASIS_MOLOPT, GTH_POTENTIALS, etc. on {active_session.host}.
                      Leave blank if <code>CP2K_DATA_DIR</code> is exported via module load.
                    </div>

                    <label class="field-label" style="margin-top: 8px">CP2K Run Command</label>
                    <input class="input" type="text" placeholder="e.g. srun cp2k.psmp"
                      bind:value={active_cluster.cp2k_command} />
                    <div class="help-text">
                      Default <code>srun cp2k.popt</code>. Use <code>cp2k.psmp</code> for MPI+OpenMP builds.
                    </div>

                    <label class="field-label" style="margin-top: 8px">Module Loads <span class="optional">(optional)</span></label>
                    <textarea class="input textarea" rows={2}
                      placeholder={"module load gcc/10.2.0\nmodule load cp2k/2024.1"}
                      bind:value={active_cluster.module_loads}></textarea>
                    <div class="help-text">Modules to load before running CP2K (one per line)</div>
                  {:else if calc_mode === 'orca'}
                    <label class="field-label">ORCA Directory</label>
                    <input class="input" type="text" placeholder="e.g. /home/user/orca_6_1_1 or /opt/orca"
                      bind:value={active_cluster.orca_dir} />
                    <div class="help-text">Root directory of ORCA installation on {active_session.host}</div>

                    <label class="field-label" style="margin-top: 8px">Module Loads <span class="optional">(optional)</span></label>
                    <textarea class="input textarea" rows={2}
                      placeholder={"module load gcc/10.2.0\nmodule load openmpi/4.1.1"}
                      bind:value={active_cluster.module_loads}></textarea>
                    <div class="help-text">Modules to load before running ORCA (one per line)</div>
                  {:else if calc_mode === 'mlp'}
                    <!-- MLP mode: only needs Python env -->
                    <div class="mlp-info">
                      <div class="mlp-info-title">MLP (MACE / CHGNet / M3GNet)</div>
                      <div class="mlp-info-desc">
                        ML potentials run as Python scripts on the cluster. The only requirement is a Python environment with the ML potential packages installed (shown below in the Python Environment field).
                      </div>
                    </div>
                  {:else}
                    <!-- QE / xTB / LAMMPS: placeholder until per-cluster fields are wired -->
                    <div class="mlp-info">
                      <div class="mlp-info-title">{calc_mode.toUpperCase()}</div>
                      <div class="mlp-info-desc">
                        Cluster-level paths and run commands for {calc_mode.toUpperCase()} aren't surfaced here yet —
                        configure them per-node in the workflow editor, or via the Job Script Template below.
                        Module Loads (next section) is shared across engines.
                      </div>
                    </div>
                  {/if}

                  <label class="field-label" style="margin-top: 8px">SLURM Account <span class="optional">(optional)</span></label>
                  <input class="input" type="text" placeholder="e.g. sdp126"
                    bind:value={active_cluster.account} />
                  <div class="help-text">#SBATCH --account for billing/allocation</div>

                  <label class="field-label" style="margin-top: 8px">Python Environment{calc_mode === 'mlp' ? ' (required)' : ''}</label>
                  {#if env_profiles.length > 0 || active_cluster.python_env?.trim()}
                    <div class="preset-buttons" style="margin-bottom: 4px">
                      {#each env_profiles as profile}
                        <button class="preset-btn" onclick={() => { if (active_cluster) active_cluster.python_env = profile.commands }}
                          title={profile.commands}>{profile.name}</button>
                      {/each}
                      {#if active_cluster.python_env?.trim()}
                        <button class="preset-btn" style="color: var(--accent-color, #60a5fa)"
                          onclick={save_env_profile}>+ Save</button>
                      {/if}
                      {#if env_profiles.length > 0}
                        <button class="preset-btn" style="color: var(--danger-color, #f87171); font-size: 10px"
                          onclick={manage_env_profiles}>Manage</button>
                      {/if}
                    </div>
                  {/if}
                  <textarea class="input textarea" rows={2}
                    placeholder={calc_mode === 'mlp'
                      ? "source ~/miniforge3/etc/profile.d/conda.sh\nconda activate catgo"
                      : "source /path/to/conda/etc/profile.d/conda.sh\nconda activate myenv"}
                    bind:value={active_cluster.python_env}></textarea>
                  <div class="help-text">
                    {#if calc_mode === 'mlp'}
                      Conda activation commands so the cluster can find <code>mace-torch</code> / <code>chgnet</code> / <code>matgl</code>.
                    {:else}
                      Conda/virtualenv activation commands (one per line). Rendered as <code>{"{{python_env_activate}}"}</code> in templates.
                    {/if}
                  </div>
                  {#if calc_mode === 'mlp' && !active_cluster?.python_env?.trim()}
                    <div class="mode-warn" style="margin-top: 4px">
                      Python environment is required for MLP calculations. The job will fail without it.
                    </div>
                  {/if}

                  <label class="field-label" style="margin-top: 12px">Default Job Script Template</label>
                  <div class="preset-buttons" style="margin-bottom: 6px">
                    {#if presets_error}
                      <div class="error-text">{presets_error}</div>
                    {/if}
                    {#each presets as preset}
                      <button class="preset-btn" onclick={() => apply_preset(preset.template)}>
                        {preset.name}
                      </button>
                    {/each}
                    {#if presets.length === 0 && !presets_error}
                      <span class="dim-text">Loading presets...</span>
                    {/if}
                  </div>
                  <textarea class="input textarea" rows={8} bind:value={active_cluster.default_template}></textarea>
                  <div class="help-text">
                    Variables: <code>{"{{job_name}}"}</code> <code>{"{{nodes}}"}</code> <code>{"{{ntasks}}"}</code>
                    <code>{"{{cpus_per_task}}"}</code> <code>{"{{walltime}}"}</code> <code>{"{{partition}}"}</code>
                    <code>{"{{memory}}"}</code> <code>{"{{account}}"}</code> <code>{"{{work_dir}}"}</code> <code>{"{{python_env_activate}}"}</code> <code>{"{{vasp_run_command}}"}</code>
                  </div>
                </div>
              {/if}
            </section>
          {/if}

        <!-- ═══════════ Tab: Parameters ═══════════ -->
        {:else if active_tab === 'params'}

          <section class="section">
            <h3 class="section-title">Default Job Parameters</h3>
            <div class="params-grid">
              <div class="field">
                <label class="field-label">Nodes</label>
                <input class="input number" type="number" min={1} bind:value={nodes} />
              </div>
              <div class="field">
                <label class="field-label">Tasks per node</label>
                <input class="input number" type="number" min={1} bind:value={ntasks} />
              </div>
              <div class="field">
                <label class="field-label">CPUs per task</label>
                <input class="input number" type="number" min={1} bind:value={cpus_per_task} />
              </div>
              <div class="field">
                <label class="field-label">Walltime</label>
                <input class="input" type="text" placeholder="HH:MM:SS" bind:value={walltime} />
              </div>
              <div class="field">
                <label class="field-label">Partition</label>
                <input class="input" type="text" placeholder="e.g. shared, workq" bind:value={partition} />
              </div>
              <div class="field">
                <label class="field-label" for="memory-input">Memory <span class="optional">(optional)</span></label>
                <input id="memory-input" class="input" type="text" placeholder="e.g. 4G" bind:value={memory} />
              </div>
              {#if active_cluster}
              <div class="field">
                <label class="field-label">Account <span class="optional">(optional)</span></label>
                <input class="input" type="text" placeholder="e.g. sdp126"
                  bind:value={active_cluster.account} />
              </div>
              {/if}
            </div>
          </section>

          <section class="section">
            <h3 class="section-title">Paths</h3>
            <div class="field">
              <label class="field-label" for="base-work-dir-input">Base Work Directory</label>
              <input id="base-work-dir-input" class="input" type="text" bind:value={base_work_dir} />
            </div>
          </section>

        <!-- ═══════════ Tab: Settings ═══════════ -->
        {:else if active_tab === 'settings'}

          <!-- Software picker: always lists every supported engine so the
               user can pre-configure (or just inspect) settings for any of
               them, regardless of which nodes the current workflow has.
               `handle_run()` warns if the picked software doesn't match
               the workflow. -->
          <section class="section">
            <h3 class="section-title">Software</h3>
            <div class="field" style="max-width: 240px">
              <label class="field-label" for="settings-software-select">Per-software options</label>
              <select id="settings-software-select" class="input" bind:value={calc_mode}
                onchange={() => { user_picked_calc_mode = true }}>
                <option value="vasp">VASP{has_vasp_nodes ? ` ✓` : ``}</option>
                <option value="cp2k">CP2K{has_cp2k_nodes ? ` ✓` : ``}</option>
                <option value="orca">ORCA{has_orca_nodes ? ` ✓` : ``}</option>
                <option value="qe">Quantum ESPRESSO{has_qe_nodes ? ` ✓` : ``}</option>
                <option value="mlp">MLP (MACE / CHGNet){has_mlp_nodes ? ` ✓` : ``}</option>
                <option value="xtb">xTB{has_xtb_nodes ? ` ✓` : ``}</option>
                <option value="lammps">LAMMPS{has_lammps_nodes ? ` ✓` : ``}</option>
              </select>
              <p class="hint">A ✓ marks engines that have nodes in this workflow.</p>
            </div>
          </section>

          {#if calc_mode === 'vasp'}
            <section class="section">
              <h3 class="section-title">VASP — Error Handling</h3>
              <label class="checkbox-row">
                <input type="checkbox" bind:checked={use_custodian} />
                <span>Use custodian for automatic VASP error recovery</span>
              </label>
              {#if use_custodian}
                <div class="custodian-sub">
                  <div class="field" style="max-width: 160px">
                    <label class="field-label" for="custodian-max-errors-input">Max errors to fix</label>
                    <input id="custodian-max-errors-input" class="input number" type="number" min={1} max={50} bind:value={custodian_max_errors} />
                  </div>
                  <p class="custodian-desc">
                    Custodian automatically fixes common VASP errors (ZBRENT, EDDDAV, memory issues) and restarts the calculation.
                  </p>
                </div>
              {/if}
            </section>
          {:else if calc_mode === 'cp2k'}
            <section class="section">
              <h3 class="section-title">CP2K — SCF &amp; Grid</h3>
              <div class="params-grid">
                <div class="field">
                  <label class="field-label" for="cp2k-cutoff-input">CUTOFF <span class="optional">(Ry)</span></label>
                  <input id="cp2k-cutoff-input" class="input number" type="number" min={100} max={2000} step={50} bind:value={cp2k_cutoff} />
                </div>
                <div class="field">
                  <label class="field-label" for="cp2k-rel-cutoff-input">REL_CUTOFF <span class="optional">(Ry)</span></label>
                  <input id="cp2k-rel-cutoff-input" class="input number" type="number" min={10} max={200} step={5} bind:value={cp2k_rel_cutoff} />
                </div>
                <div class="field">
                  <label class="field-label" for="cp2k-max-scf-input">Max SCF iterations</label>
                  <input id="cp2k-max-scf-input" class="input number" type="number" min={10} max={500} step={5} bind:value={cp2k_max_scf} />
                </div>
                <div class="field">
                  <label class="field-label" for="cp2k-eps-scf-input">EPS_SCF</label>
                  <input id="cp2k-eps-scf-input" class="input number" type="number" min={1e-9} max={1e-3} step={1e-7} bind:value={cp2k_eps_scf} />
                </div>
              </div>
              <label class="checkbox-row">
                <input type="checkbox" bind:checked={cp2k_use_ot} />
                <span>Use Orbital Transformation (OT)</span>
              </label>
              <p class="hint">
                Recommended ON for closed-shell systems (insulators, semiconductors, molecules).
                Turn OFF for metals or open-shell systems — CP2K falls back to traditional
                diagonalisation with Fermi smearing. Default CUTOFF/REL_CUTOFF (400/60 Ry) is
                a safe starting point; converge per system.
              </p>
            </section>
          {:else}
            <section class="section">
              <h3 class="section-title">{calc_mode.toUpperCase()}</h3>
              <p class="hint">
                No software-specific options here yet. Run-time parameters for {calc_mode.toUpperCase()}
                live on each node's config panel; this tab will be expanded as global defaults emerge.
              </p>
            </section>
          {/if}

          <section class="section">
            <h3 class="section-title">Poll Interval <span class="poll-value">{poll_label}</span></h3>
            <input
              class="range-slider"
              type="range"
              min={5}
              max={120}
              step={5}
              bind:value={poll_interval}
            />
            <div class="range-labels">
              <span>5s</span>
              <span>120s</span>
            </div>
          </section>

        {/if}
      </div>
      {/if}

      <!-- Footer -->
      <div class="modal-footer">
        <button class="btn btn-cancel" onclick={() => onclose?.()}>Cancel</button>
        <button class="btn btn-run" onclick={handle_run}>Run Workflow &#9654;</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 1000;
    background: rgba(0, 0, 0, 0.65);
    display: flex;
    align-items: center;
    justify-content: center;
    backdrop-filter: blur(4px);
  }

  .modal {
    background: var(--dialog-bg, light-dark(#fff, #1c1d21));
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    border-radius: 12px;
    max-width: 600px;
    width: 95%;
    max-height: 85vh;
    display: flex;
    flex-direction: column;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6);
    font-family: 'SF Mono', 'Cascadia Code', 'JetBrains Mono', monospace;
    font-size: 13px;
    color: var(--text-color, light-dark(#374151, #eee));
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px 12px;
    flex-shrink: 0;
  }

  .modal-title {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    color: var(--text-color, light-dark(#1f2937, #eee));
    letter-spacing: 0.3px;
  }

  .close-btn {
    background: none;
    border: none;
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
    font-size: 18px;
    cursor: pointer;
    padding: 2px 6px;
    border-radius: 4px;
    font-family: inherit;
    line-height: 1;
  }
  .close-btn:hover {
    color: var(--text-color, light-dark(#374151, #eee));
    background: var(--dialog-border, light-dark(#d1d5db, #3a3a3a));
  }

  /* ─── Tab bar ─── */
  .tab-bar {
    display: flex;
    gap: 0;
    padding: 0 20px;
    border-bottom: 1px solid var(--dialog-border, light-dark(#d1d5db, #3a3a3a));
    flex-shrink: 0;
  }

  /* ─── Calc mode toggle ─── */
  .calc-mode-bar {
    display: flex;
    gap: 4px;
    padding: 10px 20px;
    border-bottom: 1px solid var(--dialog-border, light-dark(#d1d5db, #3a3a3a));
    flex-shrink: 0;
    background: var(--input-bg, light-dark(rgba(0,0,0,0.02), rgba(255, 255, 255, 0.03)));
  }

  .tab {
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    padding: 8px 14px;
    font-size: 11px;
    font-weight: 600;
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
    cursor: pointer;
    font-family: inherit;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    transition: all 0.15s;
  }
  .tab:hover {
    color: var(--text-color, light-dark(#374151, #eee));
  }
  .tab.active {
    color: var(--accent-color, light-dark(#4f46e5, #3b82f6));
    border-bottom-color: var(--accent-color, light-dark(#4f46e5, #3b82f6));
  }

  .modal-body {
    padding: 16px 20px;
    overflow-y: auto;
    flex: 1;
  }

  .section {
    margin-bottom: 20px;
  }
  .section:last-child {
    margin-bottom: 8px;
  }

  .section-title {
    margin: 0 0 10px 0;
    font-size: 11px;
    font-weight: 700;
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
    text-transform: uppercase;
    letter-spacing: 1.2px;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--dialog-border, light-dark(#d1d5db, #3a3a3a));
  }

  .field-label {
    display: block;
    font-size: 11px;
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
    margin-bottom: 4px;
  }

  .optional {
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
    font-weight: 400;
  }

  .dim-text {
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
    font-size: 10px;
    font-weight: 400;
  }

  .input {
    width: 100%;
    padding: 7px 10px;
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255, 255, 255, 0.05)));
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    border-radius: 6px;
    color: var(--text-color, light-dark(#374151, #eee));
    font-size: 12px;
    font-family: inherit;
    outline: none;
    box-sizing: border-box;
    transition: border-color 0.15s;
  }
  .input:focus {
    border-color: var(--accent-color, light-dark(#4f46e5, #3b82f6));
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent-color, #3b82f6) 15%, transparent);
  }
  .input::placeholder {
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
  }
  .input.number {
    max-width: 100%;
  }

  .select {
    appearance: none;
    cursor: pointer;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%23484f58'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 10px center;
    padding-right: 28px;
  }
  .select option {
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255, 255, 255, 0.05)));
    color: var(--text-color, light-dark(#374151, #eee));
  }

  .textarea {
    resize: vertical;
    min-height: 80px;
    line-height: 1.5;
    font-size: 11px;
  }

  .help-text {
    margin-top: 4px;
    font-size: 10px;
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
    line-height: 1.7;
  }
  .help-text code {
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255, 255, 255, 0.05)));
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #3a3a3a));
    border-radius: 3px;
    padding: 1px 4px;
    font-size: 10px;
    color: #7ee787;
    font-family: inherit;
  }

  .params-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }

  .field {
    display: flex;
    flex-direction: column;
  }

  .error-text {
    font-size: 11px;
    color: var(--error-color, light-dark(#dc2626, #ef4444));
    margin-bottom: 6px;
  }

  .checkbox-row {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    font-size: 12px;
    color: var(--text-color, light-dark(#374151, #eee));
  }
  .checkbox-row input[type="checkbox"] {
    width: 15px;
    height: 15px;
    accent-color: var(--accent-color, light-dark(#4f46e5, #3b82f6));
    cursor: pointer;
    flex-shrink: 0;
  }

  .custodian-sub {
    margin-top: 10px;
    padding-left: 23px;
  }

  .custodian-desc {
    margin: 8px 0 0 0;
    font-size: 11px;
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
    line-height: 1.5;
  }

  .hint {
    margin: 8px 0 0 0;
    font-size: 11px;
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
    line-height: 1.5;
  }

  .range-slider {
    width: 100%;
    height: 6px;
    appearance: none;
    background: var(--dialog-border, light-dark(#d1d5db, #3a3a3a));
    border-radius: 3px;
    outline: none;
    cursor: pointer;
  }
  .range-slider::-webkit-slider-thumb {
    appearance: none;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--accent-color, light-dark(#4f46e5, #3b82f6));
    border: 2px solid var(--dialog-bg, light-dark(#fff, #1c1d21));
    cursor: pointer;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
  }
  .range-slider::-moz-range-thumb {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--accent-color, light-dark(#4f46e5, #3b82f6));
    border: 2px solid var(--dialog-bg, light-dark(#fff, #1c1d21));
    cursor: pointer;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
  }

  .range-labels {
    display: flex;
    justify-content: space-between;
    margin-top: 4px;
    font-size: 10px;
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
  }

  .poll-value {
    font-weight: 400;
    color: var(--accent-color, light-dark(#4f46e5, #3b82f6));
    font-size: 11px;
    margin-left: 6px;
    text-transform: none;
    letter-spacing: 0;
  }

  /* ─── Cluster tabs ─── */
  .cluster-tabs {
    display: flex;
    gap: 4px;
    margin-bottom: 10px;
    flex-wrap: wrap;
  }

  .cluster-tab {
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255, 255, 255, 0.05)));
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    border-radius: 4px;
    padding: 4px 10px;
    font-size: 10px;
    font-family: inherit;
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
    cursor: pointer;
    transition: all 0.15s;
  }
  .cluster-tab.active {
    background: var(--accent-color, light-dark(#4f46e5, #3b82f6));
    border-color: var(--accent-color, light-dark(#4f46e5, #3b82f6));
    color: #fff;
  }

  .cluster-fields {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  /* ─── Preset buttons ─── */
  .preset-buttons {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }

  .preset-btn {
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255, 255, 255, 0.05)));
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    border-radius: 4px;
    padding: 5px 12px;
    font-size: 11px;
    font-family: inherit;
    color: var(--text-color, light-dark(#374151, #eee));
    cursor: pointer;
    transition: all 0.15s;
  }
  .preset-btn:hover {
    border-color: var(--accent-color, light-dark(#4f46e5, #3b82f6));
    color: var(--accent-color, light-dark(#4f46e5, #3b82f6));
  }

  .modal-footer {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    padding: 14px 20px;
    border-top: 1px solid var(--dialog-border, light-dark(#d1d5db, #3a3a3a));
    flex-shrink: 0;
  }

  .btn {
    padding: 8px 18px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    border: 1px solid;
    font-family: inherit;
    transition: all 0.15s;
  }

  .btn-cancel {
    background: var(--dialog-border, light-dark(#d1d5db, #3a3a3a));
    border-color: var(--dialog-border, light-dark(#d1d5db, #404040));
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
  }
  .btn-cancel:hover {
    background: var(--dialog-border, light-dark(#d1d5db, #404040));
    color: var(--text-color, light-dark(#374151, #eee));
  }

  .btn-run {
    background: var(--accent-color, light-dark(#4f46e5, #3b82f6));
    border-color: var(--accent-color, light-dark(#4f46e5, #3b82f6));
    color: #fff;
  }
  .btn-run:hover {
    background: var(--accent-hover-color, light-dark(#3730a3, #2563eb));
    border-color: var(--accent-hover-color, light-dark(#3730a3, #2563eb));
  }

  /* ─── Empty state (no clusters) ─── */
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 24px 16px;
    text-align: center;
  }
  .empty-icon {
    font-size: 32px;
    margin-bottom: 10px;
    opacity: 0.5;
  }
  .empty-text {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-color, light-dark(#374151, #eee));
  }
  .empty-sub {
    margin: 4px 0 14px;
    font-size: 11px;
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
    line-height: 1.5;
  }
  .btn-connect {
    padding: 8px 20px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    font-family: inherit;
    background: var(--accent-color, light-dark(#4f46e5, #3b82f6));
    border: 1px solid var(--accent-color, light-dark(#4f46e5, #3b82f6));
    color: #fff;
    transition: all 0.15s;
  }
  .btn-connect:hover {
    background: var(--accent-hover-color, light-dark(#3730a3, #2563eb));
    border-color: var(--accent-hover-color, light-dark(#3730a3, #2563eb));
  }

  /* ─── Select + add button row ─── */
  .select-row {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .select-row .select {
    flex: 1;
  }
  .btn-add-cluster {
    width: 34px;
    height: 34px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255, 255, 255, 0.05)));
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    border-radius: 6px;
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
    font-size: 18px;
    font-family: inherit;
    cursor: pointer;
    transition: all 0.15s;
    line-height: 1;
  }
  .btn-add-cluster:hover {
    border-color: var(--accent-color, light-dark(#4f46e5, #3b82f6));
    color: var(--accent-color, light-dark(#4f46e5, #3b82f6));
    background: color-mix(in srgb, var(--accent-color, #3b82f6) 8%, transparent);
  }

  /* ─── Execution mode toggle ─── */
  .mode-toggle {
    display: flex;
    gap: 8px;
    margin-bottom: 8px;
  }
  .mode-btn {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 10px 12px;
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255, 255, 255, 0.05)));
    border: 2px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    border-radius: 8px;
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
    font-size: 13px;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
    transition: all 0.15s;
  }
  .mode-btn:hover {
    border-color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
    color: var(--text-color, light-dark(#374151, #eee));
    background: var(--surface-bg-hover, light-dark(#e5e7eb, #3a3a3a));
  }
  .mode-btn.active {
    border-color: var(--accent-color, light-dark(#4f46e5, cornflowerblue));
    color: var(--text-color, light-dark(#1f2937, #eee));
    background: color-mix(in srgb, var(--accent-color, cornflowerblue) 10%, transparent);
  }
  .mode-icon {
    font-size: 16px;
  }
  .mode-desc {
    font-size: 11px;
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
    line-height: 1.5;
  }
  .mlp-info {
    padding: 8px 10px;
    background: var(--info-bg, light-dark(#eff6ff, rgba(59, 130, 246, 0.06)));
    border: 1px solid var(--info-border, light-dark(#bfdbfe, rgba(59, 130, 246, 0.15)));
    border-radius: 5px;
    margin-bottom: 4px;
  }
  .mlp-info-title {
    font-size: 11px;
    font-weight: 600;
    color: var(--accent-color, light-dark(#2563eb, #60a5fa));
    margin-bottom: 3px;
  }
  .mlp-info-desc {
    font-size: 10px;
    color: var(--text-color-dim, light-dark(#64748b, #94a3b8));
    line-height: 1.4;
  }
  .mode-warn {
    font-size: 11px;
    color: var(--warning-color, light-dark(#d97706, #f59e0b));
    background: var(--warning-bg, light-dark(#fefce8, rgba(245, 158, 11, 0.08)));
    border: 1px solid var(--warning-border, light-dark(#fde68a, rgba(245, 158, 11, 0.2)));
    border-radius: 4px;
    padding: 6px 8px;
    margin-top: 6px;
    line-height: 1.4;
  }
</style>

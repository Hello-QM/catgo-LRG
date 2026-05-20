<script lang="ts">
  import '$lib/dialog-shared.css'
  import { t } from '$lib/i18n/index.svelte'
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
  let poll_interval = $state(15)
  let orca_binary = $state(`orca`)
  let calc_mode = $state<'vasp' | 'orca' | 'mlp'>('vasp')

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

  $effect(() => {
    if (!show) return
    if (has_mlp_nodes && !has_vasp_nodes && !has_orca_nodes) {
      calc_mode = `mlp`
    } else if (has_orca_nodes && !has_vasp_nodes) {
      calc_mode = `orca`
    }
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
    // Persist global job params + execution mode for next session
    try {
      localStorage.setItem(GLOBAL_PARAMS_KEY, JSON.stringify({
        nodes, ntasks, cpus_per_task, walltime, partition, memory, execution_mode,
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
        <h2 class="modal-title">{t('workflow.rc_title')}</h2>
        <button class="close-btn" onclick={() => onclose?.()}>x</button>
      </div>

      <!-- Execution Mode Toggle -->
      <div class="modal-body" style="padding-bottom: 0;">
        <section class="section">
          <h3 class="section-title">{t('workflow.rc_exec_mode')}</h3>
          <div class="mode-toggle">
            <button
              class="mode-btn"
              class:active={execution_mode === `local`}
              onclick={() => execution_mode = `local`}
            >
              <span class="mode-icon">&#x1F4BB;</span>
              {t('workflow.rc_local')}
            </button>
            <button
              class="mode-btn"
              class:active={execution_mode === `hpc`}
              onclick={() => execution_mode = `hpc`}
            >
              <span class="mode-icon">&#x1F5A5;</span>
              {t('workflow.rc_hpc_cluster')}
            </button>
          </div>
          <div class="mode-desc">
            {#if execution_mode === `local`}
              {@html t('workflow.rc_mode_local_desc')}
            {:else}
              {@html t('workflow.rc_mode_hpc_desc')}
            {/if}
          </div>
          {#if execution_mode === `hpc` && has_mlp_nodes}
            <div class="mode-warn">
              {@html t('workflow.rc_mode_mlp_warn')}
            </div>
          {/if}
        </section>
      </div>

      {#if execution_mode === `local`}
        <!-- Local mode warnings -->
        {#if has_vasp_nodes || has_orca_nodes}
          <div class="modal-body" style="padding-bottom: 0">
            <div class="mode-warn">
              {@html t('workflow.rc_mode_vasp_warn', { vasp: `${has_vasp_nodes ? 'VASP' : ''}${has_vasp_nodes && has_orca_nodes ? ' and ' : ''}${has_orca_nodes ? 'ORCA' : ''}` })}
            </div>
          </div>
        {/if}
        <!-- Local Settings -->
        <div class="modal-body">
          <section class="section">
            <h3 class="section-title">{t('workflow.rc_local_settings')}</h3>
            <div class="field" style="margin-bottom: 10px">
              <label class="field-label">{t('workflow.rc_lmp_command')}</label>
              <input class="input" type="text" bind:value={lmp_command} placeholder="lmp_serial" />
              <div class="help-text">
                {@html t('workflow.rc_lmp_help')}
              </div>
            </div>
            <div class="field">
              <label class="field-label">{t('workflow.rc_work_dir')} <span class="optional">{t('workflow.rc_optional')}</span></label>
              <input class="input" type="text" bind:value={local_work_dir} placeholder="Auto (temp directory)" />
              <div class="help-text">
                {t('workflow.rc_work_dir_help')}
              </div>
            </div>
          </section>
        </div>
      {:else}
        <!-- HPC Mode: Tabs -->
        <div class="tab-bar">
          <button class="tab" class:active={active_tab === 'clusters'} onclick={() => active_tab = 'clusters'}>{t('workflow.rc_tab_clusters')}</button>
          <button class="tab" class:active={active_tab === 'params'} onclick={() => active_tab = 'params'}>{t('workflow.rc_tab_params')}</button>
          <button class="tab" class:active={active_tab === 'settings'} onclick={() => active_tab = 'settings'}>{t('workflow.rc_tab_settings')}</button>
      </div>

      <!-- Calc Mode Toggle -->
      <div class="calc-mode-bar">
        {#if has_vasp_nodes || (!has_mlp_nodes && !has_orca_nodes)}
          <button class="mode-btn" class:active={calc_mode === 'vasp'} onclick={() => calc_mode = 'vasp'}>VASP</button>
        {/if}
        {#if has_orca_nodes}
          <button class="mode-btn" class:active={calc_mode === 'orca'} onclick={() => calc_mode = 'orca'}>ORCA</button>
        {/if}
        {#if has_mlp_nodes}
          <button class="mode-btn" class:active={calc_mode === 'mlp'} onclick={() => calc_mode = 'mlp'}>MLP</button>
        {/if}
      </div>

      <div class="modal-body">

        <!-- ═══════════ Tab: Clusters ═══════════ -->
        {#if active_tab === 'clusters'}

          <!-- Default cluster -->
          <section class="section">
            <h3 class="section-title">{t('workflow.rc_default_hpc')}</h3>
            {#if sessions.length === 0}
              <div class="empty-state">
                <div class="empty-icon">&#x1F5A5;</div>
                <p class="empty-text">{t('workflow.rc_no_hpc')}</p>
                <p class="empty-sub">{t('workflow.rc_no_hpc_sub')}</p>
                {#if onconnect}
                  <button class="btn btn-connect" onclick={() => onconnect?.()}>{t('workflow.rc_connect_hpc')}</button>
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
              <h3 class="section-title">{t('workflow.rc_cluster_settings')}</h3>

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
                    <label class="field-label">{t('workflow.rc_potcar_root')}</label>
                    <input class="input" type="text" placeholder="e.g. /scratch/user/VASP/pot64"
                      bind:value={active_cluster.potcar_root} />
                    <div class="help-text">{@html t('workflow.rc_potcar_help', { host: active_session.host })}</div>

                    <label class="field-label" style="margin-top: 8px">{t('workflow.rc_potcar_functional')}</label>
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

                    <label class="field-label" style="margin-top: 8px">{t('workflow.rc_vasp_cmd')}</label>
                    <input class="input" type="text" placeholder="e.g. srun --map-by-numa --hint=nomultithread vasp_std"
                      bind:value={active_cluster.vasp_command} />
                    <div class="help-text">
                      {@html t('workflow.rc_vasp_cmd_help')}
                    </div>
                  {:else if calc_mode === 'orca'}
                    <label class="field-label">{t('workflow.rc_orca_dir')}</label>
                    <input class="input" type="text" placeholder="e.g. /home/user/orca_6_1_1 or /opt/orca"
                      bind:value={active_cluster.orca_dir} />
                    <div class="help-text">{@html t('workflow.rc_orca_dir_help', { host: active_session.host })}</div>

                    <label class="field-label" style="margin-top: 8px">{t('workflow.rc_module_loads')} <span class="optional">{t('workflow.rc_optional')}</span></label>
                    <textarea class="input textarea" rows={2}
                      placeholder={"module load gcc/10.2.0\nmodule load openmpi/4.1.1"}
                      bind:value={active_cluster.module_loads}></textarea>
                    <div class="help-text">{t('workflow.rc_module_loads_help')}</div>
                  {:else}
                    <!-- MLP mode: only needs Python env -->
                    <div class="mlp-info">
                      <div class="mlp-info-title">{t('workflow.rc_mlp_info')}</div>
                      <div class="mlp-info-desc">
                        {t('workflow.rc_mlp_info_desc')}
                      </div>
                    </div>
                  {/if}

                  <label class="field-label" style="margin-top: 8px">{t('workflow.rc_slurm_account')} <span class="optional">{t('workflow.rc_optional')}</span></label>
                  <input class="input" type="text" placeholder="e.g. sdp126"
                    bind:value={active_cluster.account} />
                  <div class="help-text">{t('workflow.rc_slurm_account_help')}</div>

                  <label class="field-label" style="margin-top: 8px">{calc_mode === 'mlp' ? t('workflow.rc_py_env_req') : t('workflow.rc_py_env')}</label>
                  {#if env_profiles.length > 0 || active_cluster.python_env?.trim()}
                    <div class="preset-buttons" style="margin-bottom: 4px">
                      {#each env_profiles as profile}
                        <button class="preset-btn" onclick={() => { if (active_cluster) active_cluster.python_env = profile.commands }}
                          title={profile.commands}>{profile.name}</button>
                      {/each}
                      {#if active_cluster.python_env?.trim()}
                        <button class="preset-btn" style="color: var(--accent-color, #60a5fa)"
                          onclick={save_env_profile}>{t('workflow.rc_save')}</button>
                      {/if}
                      {#if env_profiles.length > 0}
                        <button class="preset-btn" style="color: var(--danger-color, #f87171); font-size: 10px"
                          onclick={manage_env_profiles}>{t('workflow.rc_manage')}</button>
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
                      {@html t('workflow.rc_py_env_mlp_help')}
                    {:else}
                      {@html t('workflow.rc_py_env_help')}
                    {/if}
                  </div>
                  {#if calc_mode === 'mlp' && !active_cluster?.python_env?.trim()}
                    <div class="mode-warn" style="margin-top: 4px">
                      {t('workflow.rc_py_env_req_warn')}
                    </div>
                  {/if}

                  <label class="field-label" style="margin-top: 12px">{t('workflow.rc_default_job_tpl')}</label>
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
                      <span class="dim-text">{t('workflow.rc_loading_presets')}</span>
                    {/if}
                  </div>
                  <textarea class="input textarea" rows={8} bind:value={active_cluster.default_template}></textarea>
                  <div class="help-text">
                    {t('workflow.rc_job_tpl_help')} <code>{"{{job_name}}"}</code> <code>{"{{nodes}}"}</code> <code>{"{{ntasks}}"}</code>
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
            <h3 class="section-title">{t('workflow.rc_default_job_params')}</h3>
            <div class="params-grid">
              <div class="field">
                <label class="field-label">{t('workflow.rc_nodes')}</label>
                <input class="input number" type="number" min={1} bind:value={nodes} />
              </div>
              <div class="field">
                <label class="field-label">{t('workflow.rc_tasks_per_node')}</label>
                <input class="input number" type="number" min={1} bind:value={ntasks} />
              </div>
              <div class="field">
                <label class="field-label">{t('workflow.rc_cpus_per_task')}</label>
                <input class="input number" type="number" min={1} bind:value={cpus_per_task} />
              </div>
              <div class="field">
                <label class="field-label">{t('workflow.rc_walltime')}</label>
                <input class="input" type="text" placeholder="HH:MM:SS" bind:value={walltime} />
              </div>
              <div class="field">
                <label class="field-label">{t('workflow.rc_partition')}</label>
                <input class="input" type="text" placeholder="e.g. shared, workq" bind:value={partition} />
              </div>
              <div class="field">
                <label class="field-label" for="memory-input">{t('workflow.rc_memory')} <span class="optional">{t('workflow.rc_optional')}</span></label>
                <input id="memory-input" class="input" type="text" placeholder="e.g. 4G" bind:value={memory} />
              </div>
              {#if active_cluster}
              <div class="field">
                <label class="field-label">{t('workflow.rc_slurm_account')} <span class="optional">{t('workflow.rc_optional')}</span></label>
                <input class="input" type="text" placeholder="e.g. sdp126"
                  bind:value={active_cluster.account} />
              </div>
              {/if}
            </div>
          </section>

          <section class="section">
            <h3 class="section-title">{t('workflow.rc_paths')}</h3>
            <div class="field">
              <label class="field-label" for="base-work-dir-input">{t('workflow.rc_base_work_dir')}</label>
              <input id="base-work-dir-input" class="input" type="text" bind:value={base_work_dir} />
            </div>
          </section>

        <!-- ═══════════ Tab: Settings ═══════════ -->
        {:else if active_tab === 'settings'}

          {#if calc_mode === 'vasp'}
            <section class="section">
              <h3 class="section-title">{t('workflow.rc_error_handling')}</h3>
              <label class="checkbox-row">
                <input type="checkbox" bind:checked={use_custodian} />
                <span>{t('workflow.rc_use_custodian')}</span>
              </label>
              {#if use_custodian}
                <div class="custodian-sub">
                  <div class="field" style="max-width: 160px">
                    <label class="field-label" for="custodian-max-errors-input">{t('workflow.rc_max_errors')}</label>
                    <input id="custodian-max-errors-input" class="input number" type="number" min={1} max={50} bind:value={custodian_max_errors} />
                  </div>
                  <p class="custodian-desc">
                    {t('workflow.rc_custodian_desc')}
                  </p>
                </div>
              {/if}
            </section>
          {/if}

          <section class="section">
            <h3 class="section-title">{t('workflow.rc_poll_interval')} <span class="poll-value">{poll_label}</span></h3>
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
        <button class="btn btn-cancel" onclick={() => onclose?.()}>{t('workflow.rc_btn_cancel')}</button>
        <button class="btn btn-run" onclick={handle_run}>{@html t('workflow.rc_btn_run')}</button>
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

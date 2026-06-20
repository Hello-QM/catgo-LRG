<script lang="ts">
  import { DraggablePane } from '$lib'
  import FileTree from './FileTree.svelte'
  import type { Snippet } from 'svelte'
  import {
    hpc_session_store,
    add_session as add_shared_session,
    remove_session as remove_shared_session,
    refresh_hpc_sessions,
  } from '$lib/hpc-sessions.svelte'
  import {
    connectHPC,
    connectSSHConfig,
    submitJob,
    fetchJobs,
    fetchJobDetail,
    cancelJob,
    uploadFile,
    loadProfiles,
    saveProfile,
    deleteProfile,
    disconnectSession,
    fetchOverview,
    readRemoteFile,
    readRemoteBinaryFile,
    getDownloadUrl,
    mergeStructuresFromDir,
    checkInstallStatus,
    runInstall,
    launchCatgo,
    setupCatgoTunnel,
    teardownCatgoTunnel,
    setupClaudeCode,
    type HPCConnectionConfig,
    type HPCProfile,
    type RemoteFile,
    type SchedulerType,
    type AuthMethod,
    type InstallStatus,
    type CatgoLaunchState,
  } from '$lib/api/hpc'
  import { start_hpc_managed_download } from '$lib/downloads/hpc-download'
  import {
    type HPCSession,
    LOCAL_SESSION_ID,
    create_session,
    create_local_session,
    type ServerTab,
    tab_defs,
    type JobStatusFilter,
    type JobTimeFilter,
    type CalcTypeFilter,
    type CalcSoftwareFilter,
    get_sacct_start_time,
    truncate_workdir,
    format_file_size,
    get_status_color,
    filter_jobs,
  } from './server-utils'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'
  import { pick_hpc_key_file } from '$lib/hpc-key-file'

  load_i18n_module('structure')
  load_i18n_module('common')

  let {
    show = $bindable(false),
    max_height = ``,
    children,
    on_select_job,
    on_open_terminal,
    on_load_structure,
    on_open_editor,
    on_preview_file,
    on_load_trajectory,
    on_load_trajectory_stream,
    on_analyze_report,
    external_navigate_path = $bindable<string | undefined>(undefined),
  }: {
    show?: boolean
    max_height?: string
    children?: Snippet
    on_select_job?: (session_id: string, job_id: string) => void
    on_open_terminal?: (session_id: string, host: string, username: string) => void
    on_load_structure?: (content: string, filename: string, file_path?: string, session_id?: string) => void
    on_open_editor?: (content: string, filename: string, file_path: string, session_id: string) => void
    on_preview_file?: (mode: string, filename: string, file_path: string, session_id: string, content?: string, binary_data?: string, mime_type?: string) => void
    on_load_trajectory?: (content: string, filename: string, remote_origin?: { session_id: string; dir_path: string }) => void
    on_load_trajectory_stream?: (local_path: string, filename: string) => void | Promise<void>
    on_analyze_report?: (content: string, filename: string) => void
    external_navigate_path?: string | undefined
  } = $props()

  // ====== Global State ======

  let sessions = $state<HPCSession[]>([create_local_session()])
  let active_session_idx = $state(0) // 0 = Local session

  // On mount: refresh HPC sessions from backend so new browser tabs see existing connections
  $effect(() => { refresh_hpc_sessions() })

  // Listen for session-expired events (fired by pty.ts when backend reports session gone)
  $effect(() => {
    const handler = () => {
      // Re-sync with backend — dead connections are cleaned up server-side
      refresh_hpc_sessions().then(() => {
        // Mark local sessions as disconnected if backend no longer lists them
        const shared_ids = new Set(hpc_session_store.sessions.map((s) => s.session_id))
        for (const ls of sessions) {
          if (ls.session_id && ls.session_id !== LOCAL_SESSION_ID && ls.conn_status === `connected` && !shared_ids.has(ls.session_id)) {
            ls.conn_status = `disconnected`
            ls.conn_error = t('structure.session_expired')
            ls.ws_conn?.disconnect()
            ls.ws_conn = null
            remove_shared_session(ls.session_id)
          }
        }
      })
    }
    window.addEventListener(`catgo:hpc-session-expired`, handler)
    return () => window.removeEventListener(`catgo:hpc-session-expired`, handler)
  })

  // Sync: detect sessions connected externally (e.g. from workflow ConnectDialog)
  // and add them to the local sessions array; also remove sessions disconnected externally
  $effect(() => {
    const shared = hpc_session_store.sessions
    // Add any shared sessions not already in our local array
    for (const s of shared) {
      if (!sessions.find((ls) => ls.session_id === s.session_id)) {
        sessions.push({
          _id: `ext_${s.session_id}`,
          session_id: s.session_id,
          host: s.host,
          username: s.username,
          scheduler: s.scheduler,
          conn_status: `connected`,
          conn_error: ``,
          otp_prompt: ``,
          otp_code: ``,
          ws_conn: null,
          jobs: [],
          jobs_loading: false,
          jobs_fetched: false,
          jobs_error: ``,
          auto_refresh: false,
          refresh_interval: null,
          current_path: s.work_root || `~`,
          work_root: s.work_root || ``,
          files_error: ``,
          upload_progress: null,
          overview: null,
          overview_loading: false,
        })
      }
    }
    // Remove local sessions that were disconnected externally
    const shared_ids = new Set(shared.map((s) => s.session_id))
    for (let i = sessions.length - 1; i >= 0; i--) {
      const ls = sessions[i]
      if (ls.session_id && ls.session_id !== LOCAL_SESSION_ID && ls.conn_status === `connected` && !shared_ids.has(ls.session_id)) {
        // Only remove if it was an externally-added session (no ws_conn)
        if (!ls.ws_conn) sessions.splice(i, 1)
      }
    }
    // Splicing can leave active_session_idx past the end → active_session
    // ($derived) becomes null while the Files/Jobs tab is still mounted, and
    // Svelte re-reads the child prop getters (e.g. session_id) before tearing
    // the block down. Clamp here so active_session never lingers null.
    if (active_session_idx >= sessions.length) active_session_idx = sessions.length - 1
  })

  let active_tab = $state<ServerTab>(`files`)

  // Connection form (shared for new connections)
  let host = $state(``)
  let port = $state(22)
  let username = $state(``)
  let password = $state(``)
  let auth_method = $state<AuthMethod>(`password`)
  let key_file = $state(``)
  let key_content = $state(``)
  let key_selected_name = $state(``)
  let use_jump = $state(false)
  let jump_host = $state(``)
  let jump_port = $state(22)
  let jump_username = $state(``)
  let jump_password = $state(``)
  let jump_use_key = $state(true) // true = SSH key auth, false = password auth
  let ssh_alias = $state(``)
  let scheduler = $state<SchedulerType>(`slurm`)
  let work_root = $state(``)

  // SOCKS5 proxy settings
  let use_proxy = $state(false)
  let proxy_host = $state(`127.0.0.1`)
  let proxy_port = $state(1080)
  let proxy_username = $state(``)
  let proxy_password = $state(``)

  // Profiles
  let profiles = $state<HPCProfile[]>([])
  let selected_profile = $state(``)
  let profile_name = $state(``)

  // Job submission form (shared, submitted to active session)
  let job_name = $state(`catgo_job`)
  let job_nodes = $state(1)
  let job_ntasks = $state(1)
  let job_cpus = $state(1)
  let job_time = $state(`01:00:00`)
  let job_partition = $state(``)
  let job_memory = $state(``)
  let job_work_dir = $state(`~`)
  let job_script = $state(``)
  let submit_loading = $state(false)
  let submit_message = $state(``)

  // CatGO remote install state
  let install_status = $state<InstallStatus | null>(null)
  let install_checking = $state(false)
  let install_error = $state(``)
  let install_running = $state(false)
  let install_log = $state<string[]>([])
  let install_done = $state(false)

  // Claude Code remote setup
  let claude_setup_loading = $state(false)
  let claude_setup_result = $state<{ success: boolean; message: string } | null>(null)

  // CatGO remote launch state
  let catgo_launch_state = $state<CatgoLaunchState>(`idle`)
  let catgo_job_id = $state(``)
  let catgo_node = $state(``)
  let catgo_local_port = $state(0)
  let catgo_message = $state(``)
  let catgo_port_config = $state(8000)
  let catgo_poll_timer = $state<ReturnType<typeof setInterval> | null>(null)

  // Job filters
  let job_status_filter = $state<JobStatusFilter>(`all`)
  let job_time_filter = $state<JobTimeFilter>(`all`)
  let job_calc_filter = $state<CalcTypeFilter>(`all`)
  let job_software_filter = $state<CalcSoftwareFilter>(`all`)
  let workdir_skip_segments = $state(3)

  let filtered_jobs = $derived(() => {
    if (!active_session) return []
    return filter_jobs(active_session.jobs, job_status_filter, job_software_filter, job_calc_filter)
  })

  // Re-fetch when time filter changes
  $effect(() => {
    void job_time_filter
    if (active_session?.conn_status === `connected` && active_session?.jobs_fetched) {
      refresh_jobs()
    }
  })

  // FileTree refresh trigger (increment to force remount after upload)
  let file_tree_key = $state(0)

  // When a FILE op reports the session expired, recover like the terminal does.
  // pty.ts already finds a live replacement session for the terminal; the file
  // browser had no recovery, so it kept querying the dead id (green dot + "Session
  // expired" + refresh that never helped). Re-sync with the live backend
  // connections and, if one exists for this host, adopt its id and remount.
  let last_recovered_sid = $state(``)
  async function recover_file_session(): Promise<void> {
    const sess = active_session
    if (!sess || sess.session_id === LOCAL_SESSION_ID) return
    const stale = sess.session_id
    if (stale === last_recovered_sid) return // already tried for this id — avoid a loop
    last_recovered_sid = stale
    await refresh_hpc_sessions()
    const live = hpc_session_store.sessions.find(
      (s) => s.host === sess.host && s.username === sess.username && s.session_id !== stale,
    )
    if (live) {
      sess.session_id = live.session_id
      file_tree_key++ // remount FileTree → reloads against the live session
    }
  }

  /** Find session by stable _id through the reactive array (returns proxy). */
  function get_session(id: string): HPCSession | undefined {
    return sessions.find((s) => s._id === id)
  }

  let active_session = $derived(
    active_session_idx >= 0 && active_session_idx < sessions.length
      ? sessions[active_session_idx]
      : null,
  )
  let is_connected = $derived(active_session?.conn_status === `connected`)
  let connected_sessions = $derived(sessions.filter((s) => s.conn_status === `connected`))

  // External navigation (e.g., from terminal CWD sync)
  $effect(() => {
    if (external_navigate_path && active_session?.conn_status === `connected`) {
      // Only navigate if the path actually changed (prevents feedback loops)
      if (active_session.current_path !== external_navigate_path) {
        navigate_to(external_navigate_path)
      }
      external_navigate_path = undefined
    }
  })

  // Status indicator color for active session
  let status_color = $derived(() => get_status_color(active_session?.conn_status))

  // ====== Profile Management ======

  async function load_saved_profiles() {
    try {
      profiles = await loadProfiles()
    } catch {
      // Server not running
    }
  }

  function apply_profile(name: string) {
    const p = profiles.find((pr) => pr.name === name)
    if (!p) return
    host = p.host
    port = p.port
    username = p.username
    auth_method = p.auth_method
    key_file = p.key_file ?? ``
    key_content = ``
    key_selected_name = ``
    scheduler = p.scheduler
    ssh_alias = p.ssh_alias ?? ``
    work_root = p.work_root ?? ``
    if (p.jump_host) {
      use_jump = true
      jump_host = p.jump_host
      jump_port = p.jump_port ?? 22
      jump_username = p.jump_username ?? ``
    } else {
      use_jump = false
    }
    if (p.proxy_host) {
      use_proxy = true
      proxy_host = p.proxy_host
      proxy_port = p.proxy_port ?? 1080
      proxy_username = p.proxy_username ?? ``
    } else {
      use_proxy = false
    }
    profile_name = p.name
  }

  async function save_current_profile() {
    if (!profile_name.trim()) return
    const profile: HPCProfile = {
      name: profile_name.trim(),
      host,
      port,
      username,
      auth_method,
      key_file: key_file || undefined,
      scheduler,
      ssh_alias: auth_method === `ssh_config` ? ssh_alias : undefined,
      jump_host: use_jump ? jump_host : undefined,
      jump_port: use_jump ? jump_port : undefined,
      jump_username: use_jump ? jump_username : undefined,
      proxy_host: use_proxy ? proxy_host : undefined,
      proxy_port: use_proxy ? proxy_port : undefined,
      proxy_username: use_proxy && proxy_username ? proxy_username : undefined,
      work_root: work_root.trim() || undefined,
    }
    try {
      await saveProfile(profile)
      await load_saved_profiles()
      selected_profile = profile_name
    } catch (err) {
      // Show error briefly
      console.error(`Failed to save profile:`, err)
    }
  }

  async function delete_current_profile() {
    if (!selected_profile) return
    try {
      await deleteProfile(selected_profile)
      selected_profile = ``
      await load_saved_profiles()
    } catch (err) {
      console.error(`Failed to delete profile:`, err)
    }
  }

  // ====== Connection ======

  function do_connect() {
    if (auth_method === `ssh_config`) {
      do_connect_ssh_config()
      return
    }
    if (!host || !username) return
    const needs_password = auth_method === `password` || auth_method === `password_otp`
    if (needs_password && !password) return

    // Create a new session and push into reactive array
    const raw = create_session()
    raw.host = host
    raw.username = username
    raw.scheduler = scheduler
    raw.work_root = work_root.trim()
    raw.current_path = raw.work_root || `~`
    raw.conn_status = `connecting`
    const sid = raw._id

    sessions.push(raw) // mutates $state array → triggers reactivity
    active_session_idx = sessions.length - 1

    const config: HPCConnectionConfig = {
      host,
      port,
      username,
      password: password || undefined,
      auth_method,
      key_file: key_file || undefined,
      key_content: key_content || undefined,
      scheduler,
      jump_host: use_jump ? jump_host : undefined,
      jump_port: use_jump ? jump_port : undefined,
      jump_username: use_jump ? (jump_username || undefined) : undefined,
      jump_password: use_jump && !jump_use_key && jump_password ? jump_password : undefined,
      proxy_host: use_proxy ? proxy_host : undefined,
      proxy_port: use_proxy ? proxy_port : undefined,
      proxy_username: use_proxy && proxy_username ? proxy_username : undefined,
      proxy_password: use_proxy && proxy_password ? proxy_password : undefined,
      work_root: work_root.trim() || undefined,
    }

    // All callbacks look up the session through the reactive array via _id
    const ws = connectHPC(config, {
      onConnected: (session_id, info) => {
        const s = get_session(sid)
        if (!s) return
        s.session_id = session_id
        s.conn_status = `connected`
        s.conn_error = ``
        s.work_root = info?.work_root || work_root.trim()
        s.current_path = s.work_root || `~`
        password = ``
        // Sync to shared store so Workflow page can see this session
        add_shared_session({ session_id, host, username, scheduler, work_root: s.work_root || undefined })
      },
      onOTPRequired: (prompt) => {
        const s = get_session(sid)
        if (!s) return
        s.conn_status = `otp_required`
        s.otp_prompt = prompt || t('common.verification_code')
        s.otp_code = ``
      },
      onError: (message) => {
        const s = get_session(sid)
        if (!s) return
        s.conn_status = `error`
        s.conn_error = message
      },
      onDisconnected: () => {
        const s = get_session(sid)
        if (!s) return
        if (s.conn_status === `connected`) {
          s.conn_status = `disconnected`
          s.session_id = ``
        }
      },
    })

    // Store ws_conn on the reactive proxy
    const s = get_session(sid)
    if (s) s.ws_conn = ws
  }

  async function choose_key_file() {
    const selected = await pick_hpc_key_file()
    if (!selected) return
    key_selected_name = selected.name
    if (selected.path) {
      key_file = selected.path
      key_content = ``
    } else if (selected.content) {
      key_file = selected.name
      key_content = selected.content
    }
  }

  async function do_connect_ssh_config() {
    if (!ssh_alias) return

    const raw = create_session()
    raw.host = ssh_alias
    raw.username = ``
    raw.scheduler = scheduler
    raw.work_root = work_root.trim()
    raw.current_path = raw.work_root || `~`
    raw.conn_status = `connecting`
    const sid = raw._id

    sessions.push(raw)
    active_session_idx = sessions.length - 1

    try {
      const result = await connectSSHConfig({
        host: ssh_alias,
        port: 22,
        username: ``,
        auth_method: `ssh_config`,
        ssh_alias,
        scheduler,
        work_root: work_root.trim() || undefined,
      })
      const s = get_session(sid)
      if (!s) return
      s.session_id = result.session_id
      s.host = result.host
      s.username = result.username
      s.work_root = result.work_root || work_root.trim()
      s.current_path = s.work_root || `~`
      s.conn_status = `connected`
      // Sync to shared store so Workflow page can see this session
      add_shared_session({
        session_id: result.session_id,
        host: result.host,
        username: result.username,
        scheduler,
        work_root: s.work_root || undefined,
      })
    } catch (err: any) {
      const s = get_session(sid)
      if (!s) return
      s.conn_status = `error`
      s.conn_error = err?.message || String(err)
    }
  }

  function submit_otp() {
    if (!active_session || !active_session.otp_code) return
    active_session.ws_conn?.submit_otp(active_session.otp_code)
    active_session.otp_code = ``
    active_session.conn_status = `connecting`
  }

  async function do_disconnect(idx: number) {
    const session = sessions[idx]
    if (!session || session._id === LOCAL_SESSION_ID) return

    // Stop auto-refresh
    if (session.refresh_interval) {
      clearInterval(session.refresh_interval)
      session.refresh_interval = null
    }

    session.ws_conn?.disconnect()
    if (session.session_id) {
      // Remove from shared store so Workflow page reflects the change
      remove_shared_session(session.session_id)
      try {
        await disconnectSession(session.session_id)
      } catch {
        // Already closed
      }
    }

    // Remove session from array
    sessions.splice(idx, 1)
    if (active_session_idx >= sessions.length) {
      active_session_idx = sessions.length - 1
    }
    if (sessions.length === 0) {
      active_session_idx = -1
    }
  }

  function show_new_connection() {
    active_session_idx = -1
    active_tab = `connection`
  }

  async function check_catgo_install() {
    if (!active_session?.session_id || active_session._id === LOCAL_SESSION_ID) return
    install_checking = true
    install_error = ``
    try {
      install_status = await checkInstallStatus(active_session.session_id)
      // Store detected conda_activate in session store so RunConfigDialog can use it
      if (install_status?.conda_activate) {
        const s = hpc_session_store.sessions.find(ss => ss.session_id === active_session!.session_id)
        if (s) s.conda_activate = install_status.conda_activate
      }
    } catch (e) {
      install_error = t('structure.failed_check', { error: String(e) })
    } finally {
      install_checking = false
    }
  }

  function auto_scroll_bottom(node: HTMLElement, _trigger: number) {
    node.scrollTop = node.scrollHeight
    return {
      update() { node.scrollTop = node.scrollHeight },
    }
  }

  async function do_run_install() {
    if (!active_session?.session_id || active_session._id === LOCAL_SESSION_ID) return
    install_running = true
    install_done = false
    install_log = []
    install_error = ``

    const account = install_status?.accounts?.[0] ?? ``

    await runInstall(
      active_session.session_id,
      account,
      (msg) => { install_log = [...install_log, msg] },
      async () => {
        install_done = true
        install_running = false
        // Auto re-check status after install completes
        await check_catgo_install()
      },
      (err) => {
        install_error = err
        install_running = false
      },
    )
  }

  async function do_setup_claude_code() {
    if (!active_session?.session_id || active_session._id === LOCAL_SESSION_ID) return
    claude_setup_loading = true
    claude_setup_result = null
    try {
      claude_setup_result = await setupClaudeCode(active_session.session_id)
    } catch (e) {
      claude_setup_result = { success: false, message: `${e}` }
    } finally {
      claude_setup_loading = false
    }
  }

  // ====== CatGO Remote Launch ======

  async function do_launch_catgo() {
    if (!active_session?.session_id) return
    catgo_launch_state = `submitting`
    catgo_message = t('structure.submitting_job')
    catgo_job_id = ``
    catgo_node = ``
    catgo_local_port = 0

    try {
      const result = await launchCatgo(active_session.session_id, catgo_port_config)
      if (!result.success) {
        catgo_launch_state = `failed`
        catgo_message = result.message
        return
      }
      catgo_job_id = result.job_id
      catgo_launch_state = `pending`
      catgo_message = t('structure.waiting_for_allocation')
      start_catgo_poll()
    } catch (e) {
      catgo_launch_state = `failed`
      catgo_message = `${e}`
    }
  }

  function start_catgo_poll() {
    stop_catgo_poll()
    catgo_poll_timer = setInterval(poll_catgo_job, 5000)
  }

  function stop_catgo_poll() {
    if (catgo_poll_timer) {
      clearInterval(catgo_poll_timer)
      catgo_poll_timer = null
    }
  }

  async function poll_catgo_job() {
    if (!active_session?.session_id || !catgo_job_id) {
      stop_catgo_poll()
      return
    }
    try {
      const info = await fetchJobDetail(active_session.session_id, catgo_job_id)
      if (info.status === `RUNNING`) {
        stop_catgo_poll()
        catgo_launch_state = `running`
        catgo_message = t('structure.job_running_setup_tunnel')
        await do_setup_tunnel()
      } else if (info.status === `PENDING`) {
        catgo_launch_state = `pending`
        catgo_message = info.reason || t('structure.waiting_for_allocation')
      } else if (info.status === `FAILED` || info.status === `CANCELLED` || info.status === `COMPLETED`) {
        stop_catgo_poll()
        catgo_launch_state = `failed`
        catgo_message = t('structure.job_status_label', { status: info.status })
      }
    } catch (e) {
      // Transient error — keep polling
      console.warn(`CatGO poll error:`, e)
    }
  }

  async function do_setup_tunnel() {
    if (!active_session?.session_id || !catgo_job_id) return
    catgo_launch_state = `tunneling`
    catgo_message = t('structure.setting_up_ssh_tunnel')
    try {
      const result = await setupCatgoTunnel(
        active_session.session_id,
        catgo_job_id,
        catgo_port_config,
        catgo_port_config,
      )
      if (!result.success) {
        catgo_launch_state = `failed`
        catgo_message = result.message
        return
      }
      catgo_local_port = result.local_port
      catgo_node = result.remote_node
      catgo_launch_state = `ready`
      catgo_message = t('structure.catgo_ready_at', { port: result.local_port })
    } catch (e) {
      catgo_launch_state = `failed`
      catgo_message = t('structure.tunnel_failed', { error: String(e) })
    }
  }

  async function do_cancel_catgo() {
    if (!active_session?.session_id) return
    stop_catgo_poll()
    // Cancel job if we have one
    if (catgo_job_id) {
      try {
        await cancelJob(active_session.session_id, catgo_job_id)
      } catch {
        // Best effort
      }
    }
    // Teardown tunnel
    try {
      await teardownCatgoTunnel(active_session.session_id)
    } catch {
      // Best effort
    }
    catgo_launch_state = `idle`
    catgo_job_id = ``
    catgo_node = ``
    catgo_local_port = 0
    catgo_message = ``
  }

  function dismiss_catgo_error() {
    catgo_launch_state = `idle`
    catgo_message = ``
    catgo_job_id = ``
  }

  // Cleanup poll timer on unmount
  $effect(() => {
    return () => stop_catgo_poll()
  })

  // ====== Jobs ======

  async function refresh_jobs() {
    if (!active_session || !active_session.session_id) return
    const s = active_session
    s.jobs_loading = true
    s.jobs_error = ``
    try {
      const result = await fetchJobs(s.session_id, get_sacct_start_time(job_time_filter))
      if (result.success) {
        s.jobs = result.jobs
      } else {
        s.jobs_error = result.message || t('structure.failed_fetch_jobs')
      }
    } catch (err) {
      s.jobs_error = t('structure.error_with_message', { error: String(err) })
    } finally {
      s.jobs_loading = false
      s.jobs_fetched = true
    }
  }

  async function do_submit_job() {
    if (!active_session?.session_id || !job_script.trim()) return
    submit_loading = true
    submit_message = ``
    try {
      const result = await submitJob({
        session_id: active_session.session_id,
        script_content: job_script,
        job_name,
        partition: job_partition || undefined,
        nodes: job_nodes,
        ntasks: job_ntasks,
        cpus_per_task: job_cpus,
        time_limit: job_time,
        memory: job_memory || undefined,
        work_dir: active_session.work_root && job_work_dir.trim() === `~` ? active_session.work_root : job_work_dir,
      })
      submit_message = result.message
      if (result.success) {
        job_script = ``
        await refresh_jobs()
      }
    } catch (err) {
      submit_message = t('structure.error_with_message', { error: String(err) })
    } finally {
      submit_loading = false
    }
  }

  async function do_cancel_job(job_id: string) {
    if (!active_session?.session_id) return
    try {
      await cancelJob(active_session.session_id, job_id)
      await refresh_jobs()
    } catch (err) {
      console.error(`Failed to cancel job:`, err)
    }
  }

  function toggle_auto_refresh() {
    if (!active_session) return
    active_session.auto_refresh = !active_session.auto_refresh
    if (active_session.auto_refresh) {
      refresh_jobs()
      active_session.refresh_interval = setInterval(refresh_jobs, 15000)
    } else {
      if (active_session.refresh_interval) {
        clearInterval(active_session.refresh_interval)
        active_session.refresh_interval = null
      }
    }
  }

  // ====== Script Upload ======

  function upload_script(event: Event) {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (e) => {
      job_script = (e.target?.result as string) || ``
    }
    reader.readAsText(file)
    input.value = ``
  }

  // ====== Files ======

  function navigate_to(path: string) {
    if (active_session) active_session.current_path = path
  }

  async function do_upload(event: Event) {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    if (!file || !active_session?.session_id) return
    const s = active_session

    s.upload_progress = 0
    try {
      await uploadFile(s.session_id, s.current_path, file, (p) => {
        s.upload_progress = p
      })
      s.upload_progress = null
      file_tree_key++  // Force FileTree remount to show new file
    } catch (err) {
      s.files_error = t('structure.upload_failed', { error: String(err) })
      s.upload_progress = null
    }
    input.value = ``
  }

  async function download_remote_file(file: RemoteFile) {
    if (!active_session?.session_id) return
    const session_id = active_session.session_id
    const filename = file.is_dir ? `${file.name}.tar.gz` : file.name

    if (session_id === LOCAL_SESSION_ID) {
      const { check_tauri } = await import(`$lib/io/tauri`)
      if (check_tauri()) {
        // Desktop app: open the local file with the system default app.
        try {
          const { open } = await import(`@tauri-apps/plugin-shell`)
          await open(file.path)
        } catch {
          navigator.clipboard.writeText(file.path).catch(() => {})
        }
      } else if (!file.is_dir) {
        // Web/dev mode: stream the local file via /__files/raw and trigger a
        // browser download (Tauri shell open is unavailable, so the button was
        // a silent no-op before).
        const link = document.createElement(`a`)
        link.href = `/__files/raw?path=${encodeURIComponent(file.path)}`
        link.download = file.name
        link.rel = `noopener`
        link.style.display = `none`
        document.body.appendChild(link)
        link.click()
        link.remove()
      } else {
        // Local directory in web mode: no raw stream for dirs — copy the path.
        navigator.clipboard.writeText(file.path).catch(() => {})
      }
      return
    }

    loading_file = { name: filename, size: file.is_dir ? undefined : file.size_bytes }
    loading_error = null
    active_session.upload_progress = file.is_dir ? null : 0

    try {
      const handled = await start_hpc_managed_download({
        session_id,
        remote_path: file.path,
        filename,
        is_dir: file.is_dir,
      })
      if (handled) return

      const global_download = (globalThis as Record<string, unknown>).download
      if (typeof document !== `undefined` && typeof global_download !== `function`) {
        const link = document.createElement(`a`)
        link.href = getDownloadUrl(session_id, file.path, { is_dir: file.is_dir, skip_stat: true })
        link.download = filename
        link.rel = `noopener`
        link.style.display = `none`
        document.body.appendChild(link)
        link.click()
        link.remove()
        return
      }
    } catch (e: any) {
      loading_error = t('common.download_failed_reason', { reason: e?.message || String(e) })
    } finally {
      loading_file = null
      if (active_session?.session_id === session_id) active_session.upload_progress = null
    }
  }

  function copy_remote_path(file: RemoteFile) {
    navigator.clipboard.writeText(file.path).catch(() => {})
  }

  // ====== Structure file loading ======

  let loading_file = $state<{ name: string; size?: number } | null>(null)
  let loading_error = $state<string | null>(null)

  async function load_remote_structure(file: RemoteFile) {
    if (!active_session || !on_load_structure) return
    loading_file = { name: file.name, size: file.size_bytes }
    loading_error = null
    try {
      // Large remote trajectory → materialize to a backend-local cache file
      // (gzip on the wire) and stream frames, instead of pulling the whole file
      // into the webview (which freezes it).
      if (on_load_trajectory_stream) {
        const { materialize_remote_if_large } = await import('$lib/trajectory/remote-frame-loader')
        const local = await materialize_remote_if_large(active_session.session_id, file.path, file.name, file.size_bytes)
        if (local) {
          await on_load_trajectory_stream(local, file.name)
          loading_file = null
          return
        }
      }
      // Detect trajectory files early — default 2MB limit truncates large XDATCAR etc.
      const { is_trajectory_file } = await import('$lib/trajectory/parse')
      const likely_traj = on_load_trajectory && is_trajectory_file(file.name)
      const max_bytes = likely_traj ? 0 : undefined  // 0 = unlimited for trajectories
      const result = await readRemoteFile(active_session.session_id, file.path, max_bytes)
      if (!result.success) {
        loading_error = t('structure.failed_load_file', { name: file.name, error: result.message || t('structure.unknown_error') })
        return
      }
      if (!result.content) {
        loading_error = t('structure.file_empty_or_unreadable', { name: file.name })
        return
      }
      // Auto-detect multi-frame files and route to trajectory viewer
      if (on_load_trajectory && is_trajectory_file(file.name, result.content)) {
        on_load_trajectory(result.content, file.name)
      } else {
        // For ambiguous extensions (.out, .log), fall back to editor if not a known structure
        const { is_structure_file } = await import('$lib/structure/parse')
        if (!is_structure_file(file.name) && on_open_editor) {
          on_open_editor(result.content, file.name, file.path, active_session.session_id)
        } else {
          on_load_structure(result.content, file.name, file.path, active_session.session_id)
        }
      }
    } catch (e: any) {
      console.error(`Failed to load structure:`, e)
      loading_error = t('structure.failed_load_file', { name: file.name, error: e?.message || String(e) })
    } finally {
      loading_file = null
    }
  }

  // ====== REPORT file analysis (slow-growth) ======

  async function analyze_remote_report(file: RemoteFile) {
    if (!active_session || !on_analyze_report) return
    loading_file = { name: file.name }
    try {
      const result = await readRemoteFile(active_session.session_id, file.path)
      if (result.success && result.content) {
        on_analyze_report(result.content, file.name)
      }
    } catch (e: any) {
      console.error(`Failed to load REPORT file:`, e)
    } finally {
      loading_file = null
    }
  }

  // ====== Text file editing ======

  async function open_remote_editor(file: RemoteFile) {
    if (!active_session || !on_open_editor) return
    loading_file = { name: file.name, size: file.size_bytes }
    loading_error = null
    try {
      const result = await readRemoteFile(active_session.session_id, file.path)
      if (result.success && result.content !== undefined) {
        on_open_editor(result.content, file.name, file.path, active_session.session_id)
      } else {
        loading_error = t('structure.failed_load_file', { name: file.name, error: result.message || t('structure.unknown_error') })
      }
    } catch (e: any) {
      console.error(`Failed to open file:`, e)
      loading_error = t('structure.failed_load_file', { name: file.name, error: e?.message || String(e) })
    } finally {
      loading_file = null
    }
  }

  // ====== File preview (image/pdf/excel/markdown/csv/docx) ======

  async function open_remote_preview(file: RemoteFile, preview_type: string) {
    if (!active_session) return
    if (!on_preview_file) return
    loading_file = { name: file.name, size: file.size_bytes }
    loading_error = null
    try {
      // .docx is read as base64 and routed (via on_preview_file → the document
      // window) to the mammoth DocxView, the same path as image/pdf/excel.
      const is_binary = preview_type === `image` || preview_type === `pdf` || preview_type === `excel` || preview_type === `docx`
      if (is_binary) {
        const result = await readRemoteBinaryFile(active_session.session_id, file.path)
        if (result.success) {
          on_preview_file(preview_type, file.name, file.path, active_session.session_id, undefined, result.data, result.mime_type)
        } else {
          loading_error = t('structure.failed_load_file', { name: file.name, error: result.message || t('structure.unknown_error') })
        }
      } else {
        const result = await readRemoteFile(active_session.session_id, file.path)
        if (result.success && result.content !== undefined) {
          on_preview_file(preview_type, file.name, file.path, active_session.session_id, result.content)
        } else {
          loading_error = t('structure.failed_load_file', { name: file.name, error: result.message || t('structure.unknown_error') })
        }
      }
    } catch (e: any) {
      console.error(`Failed to preview file:`, e)
      loading_error = t('structure.failed_load_file', { name: file.name, error: e?.message || String(e) })
    } finally {
      loading_file = null
    }
  }

  // ====== Trajectory merge from directory ======

  let merging_dir = $state<string | null>(null)
  let merge_status = $state<{ type: `success` | `error`, message: string } | null>(null)
  let merge_status_timer: ReturnType<typeof setTimeout> | null = null

  function set_merge_status(type: `success` | `error`, message: string) {
    merge_status = { type, message }
    if (merge_status_timer) clearTimeout(merge_status_timer)
    merge_status_timer = setTimeout(() => { merge_status = null }, type === `success` ? 5000 : 8000)
  }

  async function merge_dir_as_trajectory(dir: RemoteFile, pattern: string = `CONTCAR`) {
    if (!active_session || !on_load_trajectory) return
    merging_dir = dir.name
    merge_status = null
    try {
      const result = await mergeStructuresFromDir(
        active_session.session_id, dir.path, pattern,
      )
      if (result.success && result.content) {
        on_load_trajectory(result.content, `${dir.name}_${pattern}_trajectory.xyz`, {
          session_id: active_session.session_id,
          dir_path: dir.path,
        })
        set_merge_status(`success`, t('structure.loaded_trajectory_from_dir', { pattern, dir: dir.name }))
      } else {
        set_merge_status(`error`, t('structure.no_pattern_files_in_dir', { pattern, dir: dir.name }))
      }
    } catch (e: any) {
      set_merge_status(`error`, t('structure.merge_failed', { error: e?.message || String(e) }))
    } finally {
      merging_dir = null
    }
  }

  // ====== Overview ======

  async function refresh_overview() {
    if (!active_session?.session_id) return
    const s = active_session
    s.overview_loading = true
    try {
      s.overview = await fetchOverview(s.session_id)
    } catch {
      // Overview not critical
    } finally {
      s.overview_loading = false
    }
  }

  // ====== Effects ======

  // Load profiles on mount
  $effect(() => {
    if (show) load_saved_profiles()
  })

  // Auto-load jobs when switching to jobs tab (only once per session)
  $effect(() => {
    if (is_connected && active_tab === `jobs` && active_session && !active_session.jobs_fetched) {
      refresh_jobs()
    }
  })

  // Auto-load overview when switching to jobs tab
  $effect(() => {
    if (is_connected && active_tab === `jobs` && active_session && !active_session.overview) {
      refresh_overview()
    }
  })
</script>

<DraggablePane
  bind:show
  show_toggle={false}
  close_on_click_outside={false}
  max_width="30em"
  max_height={max_height || ``}
  pane_props={{ class: `server-pane` }}
>
  <h4 class="pane-title">
    <span class="status-dot" style="background: {status_color()}"></span>
    {t('structure.server_hpc')}
  </h4>

  {#if children}
    {@render children()}
  {:else}
    <!-- Session Pills -->
    {#if sessions.length > 0}
      <div class="session-pills">
        {#each sessions as session, idx}
          <div
            class="pill"
            class:active={active_session_idx === idx}
            class:connected={session.conn_status === `connected`}
            class:error={session.conn_status === `error`}
            class:connecting={session.conn_status === `connecting` || session.conn_status === `otp_required`}
            role="button"
            tabindex="0"
            onclick={() => { active_session_idx = idx }}
            onkeydown={(e) => { if (e.key === `Enter`) active_session_idx = idx }}
            title={session._id === LOCAL_SESSION_ID ? t('structure.local_filesystem') : `${session.username}@${session.host} (${session.conn_status})`}
          >
            <span class="pill-dot" class:local-dot={session._id === LOCAL_SESSION_ID}></span>
            {session._id === LOCAL_SESSION_ID ? t('structure.local') : session.host ? session.host.split(`.`)[0] : `...`}
            {#if session._id !== LOCAL_SESSION_ID}
              <button
                class="pill-close"
                onclick={(e) => { e.stopPropagation(); do_disconnect(idx) }}
                title={t('common.disconnect')}
              >
                ✕
              </button>
            {/if}
          </div>
        {/each}
        <button class="pill pill-add" onclick={show_new_connection} title={t('structure.new_connection')}>
          +
        </button>
      </div>
    {/if}

    <!-- Tab Bar -->
    <div class="tab-bar">
      {#each tab_defs as tab}
        {@const tab_label = tab.id === `connection` ? t('structure.connection') : tab.id === `jobs` ? t('structure.jobs') : t('structure.files')}
        <button
          class:active={active_tab === tab.id}
          onclick={() => (active_tab = tab.id)}
          disabled={(tab.id !== `connection` && !is_connected) || (tab.id === `jobs` && active_session?._id === LOCAL_SESSION_ID)}
          title={tab.id === `jobs` && active_session?._id === LOCAL_SESSION_ID ? t('structure.no_scheduler_local') : !is_connected && tab.id !== `connection` ? t('structure.connect_first') : tab_label}
        >
          {tab_label}
        </button>
      {/each}
    </div>

    <div class="pane-content">
      <!-- ====== CONNECTION TAB ====== -->
      {#if active_tab === `connection`}
        {#if active_session && active_session?.conn_status === `otp_required`}
          <!-- OTP Input -->
          <section class="action-section">
            <h5>{t('structure.two_factor_auth')}</h5>
            <p class="description">{active_session?.otp_prompt}</p>
            <div class="form-row">
              <input
                type="text"
                bind:value={active_session.otp_code}
                placeholder={t('structure.enter_code')}
                maxlength="8"
                class="otp-input"
                onkeydown={(e) => e.key === `Enter` && submit_otp()}
              />
              <button class="apply-btn" onclick={submit_otp} disabled={!active_session?.otp_code}>
                {t('common.submit')}
              </button>
            </div>
          </section>
        {:else if active_session && active_session?.conn_status === `connected`}
          <!-- Connected Status -->
          <section class="action-section">
            {#if active_session?._id === LOCAL_SESSION_ID}
              <h5>{t('structure.local_filesystem')}</h5>
              <p class="description">{t('structure.browse_local_server_files')}</p>
            {:else}
              <h5>{t('common.connected')}</h5>
              <div class="conn-info">
                <span>{active_session?.username}@{active_session?.host}</span>
                <span class="badge badge-green">{active_session?.scheduler.toUpperCase()}</span>
              </div>
              {#if active_session?.work_root}
                <div class="work-root-chip" title={active_session?.work_root}>
                  {t('structure.work_root')}: {active_session?.work_root}
                </div>
              {/if}
              {#if active_session?.overview}
                <div class="overview-mini">
                  <span title={t('structure.running')}>{t('structure.running_count', { n: active_session?.overview.job_summary.running })}</span>
                  <span title={t('structure.pending')}>{t('structure.pending_count', { n: active_session?.overview.job_summary.pending })}</span>
                  <span title={t('structure.all')}>{t('structure.total_count', { n: active_session?.overview.job_summary.total })}</span>
                </div>
                {#if active_session?.overview.disk_usage}
                  <div class="overview-disk">{t('structure.disk_usage', { usage: active_session?.overview.disk_usage })}</div>
                {/if}
              {/if}
              <div class="conn-actions">
                {#if on_open_terminal}
                  <button
                    class="action-btn"
                    onclick={() => on_open_terminal?.(active_session?.session_id, active_session?.host, active_session?.username)}
                    title={t('structure.open_remote_terminal')}
                  >
                    {t('structure.terminal_button')}
                  </button>
                {/if}
                <button class="cancel-btn full-width" onclick={() => do_disconnect(active_session_idx)}>
                  {t('common.disconnect')}
                </button>
              </div>

              <!-- CatGO Remote Compute -->
              <div class="install-section">
                <h5>{t('structure.remote_compute')}</h5>
                {#if install_checking}
                  <p class="description">{t('structure.checking_installation')}</p>
                {:else if install_status?.installed}
                  <div class="install-status">
                    <span class="badge badge-green">{t('structure.installed')}</span>
                    <p class="description" style="margin-top: 4px">{t('structure.catgo_server_at', { path: install_status.catgo_dir })}</p>

                    <!-- CatGO Launch State Machine UI -->
                    {#if catgo_launch_state === `idle`}
                      <div class="catgo-launch-row">
                        <label class="catgo-port-label">
                          {t('structure.port')}
                          <input
                            type="number"
                            bind:value={catgo_port_config}
                            min={1024}
                            max={65535}
                            class="catgo-port-input"
                          />
                        </label>
                        <button
                          class="apply-btn catgo-launch-btn"
                          onclick={do_launch_catgo}
                        >
                          {t('structure.launch_on_compute_node')}
                        </button>
                      </div>
                    {:else if catgo_launch_state === `submitting`}
                      <div class="catgo-status-row">
                        <span class="catgo-spinner"></span>
                        <span class="description">{t('structure.submitting_job')}</span>
                      </div>
                    {:else if catgo_launch_state === `pending`}
                      <div class="catgo-status-row">
                        <span class="badge badge-yellow">PENDING</span>
                        <span class="description">{catgo_message}</span>
                      </div>
                      {#if catgo_job_id}
                        <div class="catgo-job-info">{t('structure.job_id_label', { id: catgo_job_id })}</div>
                      {/if}
                      <button class="cancel-btn full-width" onclick={do_cancel_catgo} style="margin-top: 6px">
                        {t('common.cancel')}
                      </button>
                    {:else if catgo_launch_state === `running` || catgo_launch_state === `tunneling`}
                      <div class="catgo-status-row">
                        <span class="badge badge-green">RUNNING</span>
                        <span class="description">{catgo_message}</span>
                      </div>
                      {#if catgo_job_id}
                        <div class="catgo-job-info">{t('structure.job_id_label', { id: catgo_job_id })}</div>
                      {/if}
                      <button class="cancel-btn full-width" onclick={do_cancel_catgo} style="margin-top: 6px">
                        {t('common.cancel')}
                      </button>
                    {:else if catgo_launch_state === `ready`}
                      <div class="catgo-status-row">
                        <span class="badge badge-green">READY</span>
                        <span class="description">{t('structure.on_node', { node: catgo_node })}</span>
                      </div>
                      <a
                        href="http://localhost:{catgo_local_port}"
                        target="_blank"
                        rel="noopener noreferrer"
                        class="apply-btn full-width catgo-open-link"
                      >
                        {t('structure.open_catgo_localhost', { port: catgo_local_port })}
                      </a>
                      <button class="cancel-btn full-width" onclick={do_cancel_catgo} style="margin-top: 4px">
                        {t('structure.stop_disconnect')}
                      </button>
                    {:else if catgo_launch_state === `failed`}
                      <div class="catgo-status-row">
                        <span class="badge badge-red">FAILED</span>
                      </div>
                      <div class="error-msg" style="margin-top: 4px">{catgo_message}</div>
                      <button class="secondary-btn full-width" onclick={dismiss_catgo_error} style="margin-top: 6px">
                        {t('common.dismiss')}
                      </button>
                    {/if}
                  </div>
                {:else if install_status && !install_status.installed}
                  <!-- Not installed: show curl command as primary install path -->
                  <div class="install-status">
                    <div class="install-checks">
                      <span class:ok={install_status.has_conda} class:missing={!install_status.has_conda}>
                        {install_status.has_conda ? '\u2713' : '\u2717'} conda
                      </span>
                      <span class:ok={install_status.has_env} class:missing={!install_status.has_env}>
                        {install_status.has_env ? '\u2713' : '\u2717'} env
                      </span>
                      <span class:ok={install_status.has_server} class:missing={!install_status.has_server}>
                        {install_status.has_server ? '\u2713' : '\u2717'} server
                      </span>
                      <span class:ok={install_status.has_frontend} class:missing={!install_status.has_frontend}>
                        {install_status.has_frontend ? '\u2713' : '\u2717'} frontend
                      </span>
                    </div>
                    <p class="description" style="margin-top: 8px">
                      {t('structure.install_remote_compute_desc')}
                    </p>
                    {#if install_running || install_log.length > 0}
                      <div
                        class="install-log"
                        use:auto_scroll_bottom={install_log.length}
                      >
                        {#each install_log as line}
                          <div class="install-log-line">{line}</div>
                        {/each}
                        {#if install_running}
                          <div class="install-log-line installing-pulse">{t('structure.installing')}</div>
                        {/if}
                      </div>
                    {:else if install_done}
                      <div class="success-msg" style="margin-top: 6px">{t('structure.installation_complete')}</div>
                    {/if}
                    <button
                      class="secondary-btn full-width"
                      onclick={do_run_install}
                      disabled={install_running}
                      style="margin-top: 6px"
                    >
                      {install_running ? t('structure.installing') : t('structure.install_remote_compute')}
                    </button>
                    <button
                      class="secondary-btn full-width"
                      onclick={check_catgo_install}
                      disabled={install_running}
                      style="margin-top: 4px"
                    >
                      {t('structure.re_check')}
                    </button>
                  </div>
                {:else}
                  <button
                    class="secondary-btn full-width"
                    onclick={check_catgo_install}
                  >
                    {t('structure.check_remote_setup')}
                  </button>
                {/if}
                {#if install_error}
                  <div class="error-msg" style="margin-top: 4px">{install_error}</div>
                {/if}
              </div>
            {/if}
          </section>

          <!-- Claude Code Integration -->
          <section class="action-section">
            <h5>Claude Code</h5>
            <p class="description">{t('structure.claude_code_remote_desc')}</p>
            <button
              class="secondary-btn full-width"
              onclick={do_setup_claude_code}
              disabled={claude_setup_loading}
              style="margin-top: 4px"
            >
              {claude_setup_loading ? t('structure.configuring') : t('structure.setup_claude_code')}
            </button>
            {#if claude_setup_result}
              <div
                class={claude_setup_result.success ? `success-msg` : `error-msg`}
                style="margin-top: 4px; font-size: 0.75em"
              >
                {claude_setup_result.message}
              </div>
            {/if}
          </section>
        {:else if active_session && active_session?.conn_status === `connecting`}
          <!-- Connecting -->
          <section class="action-section">
            <h5>{t('structure.connecting')}</h5>
            <p class="description">{t('structure.establishing_ssh_connection', { host: active_session?.host })}</p>
          </section>
        {:else if active_session && active_session?.conn_status === `error`}
          <!-- Error -->
          <section class="action-section">
            <h5>{t('structure.connection_error')}</h5>
            <div class="error-msg">{active_session?.conn_error}</div>
            <button class="secondary-btn full-width" onclick={() => do_disconnect(active_session_idx)} style="margin-top: 6px">
              Dismiss
            </button>
          </section>
        {:else}
          <!-- New Connection Form -->
          {#if profiles.length > 0}
            <section class="action-section">
              <h5>{t('structure.saved_profiles')}</h5>
              <div class="form-row">
                <select
                  bind:value={selected_profile}
                  onchange={() => apply_profile(selected_profile)}
                >
                  <option value="">{t('structure.select_profile_placeholder')}</option>
                  {#each profiles as p}
                    <option value={p.name}>{p.name}</option>
                  {/each}
                </select>
                {#if selected_profile}
                  <button class="icon-btn danger" onclick={delete_current_profile} title={t('structure.delete_profile')}>
                    ✕
                  </button>
                {/if}
              </div>
            </section>
          {/if}

          <section class="action-section">
            <h5>{t('structure.new_connection')}</h5>
            <div class="form-grid">
              <label>
                {t('structure.auth')}
                <select bind:value={auth_method}>
                  <option value="password">{t('structure.password')}</option>
                  <option value="password_otp">{t('structure.password_otp')}</option>
                  <option value="key">{t('structure.ssh_key')}</option>
                  <option value="key_otp">{t('structure.ssh_key_otp')}</option>
                  <option value="ssh_config">{t('structure.ssh_config_controlmaster')}</option>
                </select>
              </label>
              {#if auth_method === `ssh_config`}
                <p class="form-hint warning">
                  {t('structure.ssh_config_windows_hint')}
                </p>
                <label class="full-span">
                  {t('structure.ssh_alias')} <span class="optional-hint">{t('structure.ssh_alias_hint')}</span>
                  <input type="text" bind:value={ssh_alias} placeholder={t('structure.ssh_alias_placeholder')} />
                </label>
              {:else}
                <label>
                  {t('structure.host')}
                  <input type="text" bind:value={host} placeholder="hpc.example.com" />
                </label>
                <label>
                  {t('structure.port')}
                  <input type="number" bind:value={port} min={1} max={65535} />
                </label>
                <label>
                  {t('structure.username')}
                  <input type="text" bind:value={username} placeholder="user" />
                </label>
                {#if auth_method === `password` || auth_method === `password_otp`}
                  <label class="full-span">
                    {t('structure.password')}
                    <input type="password" bind:value={password} placeholder="••••••" />
                  </label>
                {/if}
                <label class="full-span">
                  {t('structure.key_file')} <span class="optional-hint">{t('structure.key_file_hint')}</span>
                  <div class="key-file-row">
                    <input type="text" bind:value={key_file} placeholder={t('structure.key_file_placeholder')} oninput={() => { key_content = ``; key_selected_name = `` }} />
                    <button type="button" class="secondary key-file-btn" onclick={choose_key_file}>{t('common.choose')}</button>
                  </div>
                  {#if key_content && key_selected_name}
                    <span class="optional-hint">{t('structure.key_file_imported', { name: key_selected_name })}</span>
                  {/if}
                </label>
              {/if}
              <label>
                {t('structure.scheduler')}
                <select bind:value={scheduler}>
                  <option value="slurm">SLURM</option>
                  <option value="pbs">PBS/Torque</option>
                </select>
              </label>
              <label class="full-span">
                {t('structure.work_root')} <span class="optional-hint">{t('common.optional')}</span>
                <input type="text" bind:value={work_root} placeholder={t('structure.work_root_placeholder')} />
              </label>
              <p class="form-hint full-span">{t('structure.work_root_hint')}</p>
            </div>

            <label class="checkbox-row">
              <input type="checkbox" bind:checked={use_jump} />
              {t('structure.use_jump_host')}
            </label>

            {#if use_jump}
              <div class="form-grid jump-fields">
                <label>
                  {t('structure.jump_host')}
                  <input type="text" bind:value={jump_host} placeholder="bastion.example.com" />
                </label>
                <label>
                  {t('structure.port')}
                  <input type="number" bind:value={jump_port} min={1} max={65535} />
                </label>
                <label class="full-span">
                  {t('structure.jump_username')}
                  <input type="text" bind:value={jump_username} placeholder={t('structure.same_as_above')} />
                </label>
                <label>
                  {t('structure.jump_auth')}
                  <select bind:value={jump_use_key} onchange={() => { if (jump_use_key) jump_password = `` }}>
                    <option value={true}>{t('structure.ssh_key')}</option>
                    <option value={false}>{t('structure.password')}</option>
                  </select>
                </label>
                {#if !jump_use_key}
                  <label>
                    {t('structure.jump_password')}
                    <input type="password" bind:value={jump_password} placeholder="••••••" />
                  </label>
                {/if}
              </div>
            {/if}

            <label class="checkbox-row">
              <input type="checkbox" bind:checked={use_proxy} />
              {t('structure.use_socks_proxy')}
            </label>

            {#if use_proxy}
              <div class="form-grid jump-fields">
                <label>
                  {t('structure.proxy_host')}
                  <input type="text" bind:value={proxy_host} placeholder="127.0.0.1" />
                </label>
                <label>
                  {t('structure.port')}
                  <input type="number" bind:value={proxy_port} min={1} max={65535} />
                </label>
                <label>
                  {t('structure.username')} <span class="hint">({t('common.optional')})</span>
                  <input type="text" bind:value={proxy_username} placeholder={t('structure.no_proxy_auth_placeholder')} />
                </label>
                <label>
                  {t('structure.password')} <span class="hint">({t('common.optional')})</span>
                  <input type="password" bind:value={proxy_password} placeholder="••••••" />
                </label>
              </div>
            {/if}

            <div class="form-row save-row">
              <input
                type="text"
                bind:value={profile_name}
                placeholder={t('structure.profile_name')}
                class="profile-name"
              />
              <button
                class="secondary-btn"
                onclick={save_current_profile}
                disabled={!profile_name.trim() || (auth_method === `ssh_config` ? !ssh_alias.trim() : !host)}
              >
                {t('common.save')}
              </button>
            </div>

            <button
              class="apply-btn full-width"
              onclick={do_connect}
              disabled={auth_method === `ssh_config`
                ? !ssh_alias
                : (!host || !username || ((auth_method === `password` || auth_method === `password_otp`) && !password))}
            >
              {t('common.connect')}
            </button>
          </section>
        {/if}

      <!-- ====== JOBS TAB ====== -->
      {:else if active_tab === `jobs` && active_session}
        <!-- Overview Card -->
        {#if active_session?.overview}
          <div class="overview-card">
            <div class="overview-row">
              <span class="badge badge-green">{active_session?.overview.job_summary.running} R</span>
              <span class="badge badge-yellow">{active_session?.overview.job_summary.pending} Q</span>
              <span class="badge badge-blue">{active_session?.overview.job_summary.completed} C</span>
              <span class="badge badge-red">{active_session?.overview.job_summary.failed} F</span>
            </div>
            {#if active_session?.overview.system_info}
              <div class="overview-host">{active_session?.overview.system_info}</div>
            {/if}
          </div>
        {/if}

        <!-- Job Submission -->
        <section class="action-section">
          <h5>{t('structure.submit_job')}</h5>
          <div class="form-grid">
            <label>
              {t('structure.job_name')}
              <input type="text" bind:value={job_name} />
            </label>
            <label>
              {t('structure.partition')}
              <input type="text" bind:value={job_partition} placeholder="default" />
            </label>
            <label>
              {t('structure.nodes')}
              <input type="number" bind:value={job_nodes} min={1} />
            </label>
            <label>
              {t('common.tasks')}
              <input type="number" bind:value={job_ntasks} min={1} />
            </label>
            <label>
              {t('structure.cpus_task')}
              <input type="number" bind:value={job_cpus} min={1} />
            </label>
            <label>
              {t('structure.walltime')}
              <input type="text" bind:value={job_time} placeholder="HH:MM:SS" />
            </label>
            <label>
              {t('structure.memory')}
              <input type="text" bind:value={job_memory} placeholder="e.g. 4G" />
            </label>
            <label>
              {t('structure.work_dir')}
              <input type="text" bind:value={job_work_dir} />
            </label>
          </div>
          <div class="script-header">
            <span class="script-label-text">{t('structure.job_script')}</span>
            <label class="upload-script-btn">
              {t('structure.upload_shell_script')}
              <input type="file" accept=".sh,.bash,.slurm,.pbs,.job" onchange={upload_script} hidden />
            </label>
          </div>
          <textarea bind:value={job_script} rows={5} placeholder={`#!/bin/bash\n# ${t('structure.your_commands_here')}`}></textarea>
          <button
            class="apply-btn full-width"
            onclick={do_submit_job}
            disabled={submit_loading || !job_script.trim()}
            style="margin-top: 6px"
          >
            {submit_loading ? t('structure.submitting') : t('structure.submit_job')}
          </button>
          {#if submit_message}
            <div class="submit-msg">{submit_message}</div>
          {/if}
        </section>

        <!-- Job List -->
        <section class="action-section">
          <div class="section-header">
            <h5>{t('structure.jobs')}</h5>
            <div class="header-actions">
              <button
                class="icon-btn"
                class:active={active_session?.auto_refresh}
                onclick={toggle_auto_refresh}
                title={active_session?.auto_refresh ? t('structure.stop_auto_refresh') : t('structure.auto_refresh_seconds', { seconds: 15 })}
              >
                {active_session?.auto_refresh ? `⏸` : `⟳`}
              </button>
              <button class="icon-btn" onclick={() => refresh_jobs()} disabled={active_session?.jobs_loading} title={t('common.refresh')}>
                ↻
              </button>
            </div>
          </div>

          <!-- Job Filters -->
          <div class="job-filters">
            <select class="filter-select" bind:value={job_status_filter}>
              <option value="all">{t('structure.all_status')}</option>
              <option value="RUNNING">{t('structure.running')}</option>
              <option value="PENDING">{t('structure.pending')}</option>
              <option value="COMPLETED">{t('common.completed')}</option>
              <option value="FAILED">{t('common.failed')}</option>
              <option value="CANCELLED">{t('structure.cancelled')}</option>
            </select>
            <select class="filter-select" bind:value={job_time_filter}>
              <option value="all">{t('structure.all_time')}</option>
              <option value="1h">{t('structure.last_hours', { n: 1 })}</option>
              <option value="6h">{t('structure.last_hours', { n: 6 })}</option>
              <option value="24h">{t('structure.last_hours', { n: 24 })}</option>
              <option value="7d">{t('structure.last_days', { n: 7 })}</option>
              <option value="30d">{t('structure.last_days', { n: 30 })}</option>
            </select>
            <select class="filter-select" bind:value={job_software_filter}>
              <option value="all">{t('structure.all_software')}</option>
              <option value="vasp">VASP</option>
              <option value="qe">QE</option>
              <option value="lammps">LAMMPS</option>
              <option value="cp2k">CP2K</option>
            </select>
            <select class="filter-select" bind:value={job_calc_filter}>
              <option value="all">{t('structure.all_types')}</option>
              <option value="opt">Opt</option>
              <option value="scf">SCF</option>
              <option value="md">MD</option>
              <option value="freq">Freq</option>
              <option value="band">Band</option>
              <option value="dos">DOS</option>
              <option value="neb">NEB</option>
            </select>
          </div>
          <div class="workdir-depth">
            <!-- svelte-ignore a11y_label_has_associated_control -->
            <label>{t('structure.path_depth')} <input type="number" min={0} max={20} bind:value={workdir_skip_segments} class="depth-input" /></label>
          </div>

          {#if active_session?.jobs_error}
            <div class="error-msg">{active_session?.jobs_error}</div>
          {/if}

          {#if active_session?.jobs_loading && !active_session?.jobs_fetched}
            <p class="description">{t('structure.loading_jobs')}</p>
          {:else if active_session?.jobs.length === 0}
            <p class="description">{t('structure.no_jobs_found')}</p>
          {:else if filtered_jobs().length === 0}
            <p class="description">{t('structure.no_jobs_match_filters')}</p>
          {:else}
            <div class="job-list">
              {#each filtered_jobs() as job}
                <div
                  class="job-card clickable"
                  onclick={() => on_select_job?.(active_session?.session_id, job.job_id)}
                  role="button"
                  tabindex="0"
                  onkeydown={(e) => e.key === `Enter` && on_select_job?.(active_session?.session_id, job.job_id)}
                >
                  <div class="job-header">
                    <span class="job-id">{job.job_id}</span>
                    <span class="badge" class:badge-green={job.status === `RUNNING`}
                      class:badge-yellow={job.status === `PENDING`}
                      class:badge-red={job.status === `FAILED` || job.status === `CANCELLED`}
                      class:badge-blue={job.status === `COMPLETED`}
                    >
                      {job.status}
                    </span>
                  </div>
                  <div class="job-name">{job.job_name}</div>
                  {#if job.calc_type && job.calc_type !== `unknown`}
                    <span class="job-calc-badge">{job.calc_software?.toUpperCase() || ``} {job.calc_type}</span>
                  {/if}
                  {#if job.work_dir}
                    <div class="job-detail job-dir" title={job.work_dir}>
                      {truncate_workdir(job.work_dir, workdir_skip_segments)}
                    </div>
                  {/if}
                  {#if job.time_elapsed}
                    <div class="job-detail">{t('structure.time_label', { time: job.time_elapsed })}</div>
                  {/if}
                  {#if job.status === `PENDING` || job.status === `RUNNING`}
                    <button class="cancel-btn small" onclick={() => do_cancel_job(job.job_id)}>
                      {t('common.cancel')}
                    </button>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
        </section>

      <!-- ====== FILES TAB ====== -->
      {:else if active_tab === `files` && active_session}
        <section class="action-section files-section">
          <!-- Upload -->
          <div class="form-row">
            <label class="upload-btn">
              {t('structure.upload_file')}
              <input type="file" onchange={do_upload} hidden />
            </label>
          </div>

          {#if active_session?.upload_progress != null}
            <div class="progress-bar">
              <div class="progress-fill" style="width: {active_session?.upload_progress}%"></div>
              <span class="progress-text">{t('structure.uploading_percent', { percent: active_session?.upload_progress })}</span>
            </div>
          {/if}
          {#if active_session?.files_error}
            <div class="error-msg">{active_session?.files_error}</div>
          {/if}

          {#if loading_file}
            <div class="loading-bar">
              <div class="loading-bar-inner"></div>
              <span class="loading-bar-text">{t('structure.loading_file', { name: loading_file.name, size: loading_file.size ? ` (${format_file_size(loading_file.size)})` : `` })}</span>
            </div>
          {/if}
          {#if loading_error}
            <div class="error-msg" style="cursor: pointer;" onclick={() => { loading_error = null }}>{loading_error}</div>
          {/if}
          {#key file_tree_key}
            <FileTree
              session_id={active_session?.session_id ?? ``}
              root_path={active_session?.current_path ?? `~`}
              root_boundary={active_session?.work_root ?? ``}
              on_load_structure={(file) => load_remote_structure(file)}
              on_open_editor={(file) => open_remote_editor(file)}
              on_preview_file={(file, type) => open_remote_preview(file, type)}
              on_load_trajectory={(dir, pattern) => merge_dir_as_trajectory(dir, pattern)}
              on_analyze_report={on_analyze_report ? (file) => analyze_remote_report(file) : undefined}
              on_session_expired={recover_file_session}
              on_navigate={(path) => { if (active_session) active_session.current_path = path }}
              on_download={(file) => download_remote_file(file)}
              on_copy_path={(file) => copy_remote_path(file)}
              {merging_dir}
              {merge_status}
            />
          {/key}
        </section>
      {/if}
    </div>
  {/if}
</DraggablePane>

<style>
  .pane-title {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
  }
  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  /* Session Pills */
  .session-pills {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-bottom: 6px;
    padding: 3px;
    background: var(--pre-bg, light-dark(rgba(0, 0, 0, 0.04), rgba(0, 0, 0, 0.15)));
    border-radius: 6px;
  }
  .pill {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 3px 8px;
    border: 1px solid var(--border-color, light-dark(rgba(0, 0, 0, 0.12), rgba(255, 255, 255, 0.12)));
    background: var(--btn-bg, light-dark(rgba(0, 0, 0, 0.05), rgba(255, 255, 255, 0.05)));
    color: var(--text-color, #fff);
    border-radius: 12px;
    cursor: pointer;
    font-size: 0.72em;
    white-space: nowrap;
    transition: background 0.15s;
  }
  .pill:hover {
    background: var(--btn-bg-hover, light-dark(rgba(0, 0, 0, 0.1), rgba(255, 255, 255, 0.1)));
  }
  .pill.active {
    background: var(--btn-bg-hover, light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15)));
    border-color: var(--accent-color, #3b82f6);
  }
  .pill-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--text-color-dim);
    flex-shrink: 0;
  }
  .pill.connected .pill-dot {
    background: var(--success-color);
  }
  .pill.connecting .pill-dot {
    background: var(--warning-color);
  }
  .pill.error .pill-dot {
    background: var(--error-color);
  }
  .pill-dot.local-dot {
    background: var(--accent-color);
  }
  .pill-close {
    background: none;
    border: none;
    color: var(--text-color-muted, #9ca3af);
    cursor: pointer;
    padding: 0 2px;
    font-size: 0.9em;
    line-height: 1;
  }
  .pill-close:hover {
    color: var(--error-color);
  }
  .pill-add {
    border-style: dashed;
    color: var(--text-color-muted, #9ca3af);
    font-size: 0.85em;
    padding: 3px 10px;
  }
  .pill-add:hover {
    color: var(--text-color, #fff);
  }

  .tab-bar {
    grid-template-columns: repeat(3, 1fr);
  }
  .description {
    font-size: 0.78em;
    color: var(--text-color-muted, #9ca3af);
    margin: 0;
    line-height: 1.5;
  }

  /* Forms */
  .form-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
    margin-bottom: 8px;
  }
  .form-grid label {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 0.75em;
    color: var(--text-color-muted, #9ca3af);
  }
  .full-span {
    grid-column: 1 / -1;
  }
  .optional-hint {
    font-size: 0.85em;
    opacity: 0.5;
    font-weight: normal;
  }
  .key-file-row {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .key-file-row input {
    flex: 1;
    min-width: 0;
  }
  .key-file-btn {
    flex-shrink: 0;
    white-space: nowrap;
  }
  .form-hint.warning {
    font-size: 0.82em;
    color: var(--warning-color, #c57a1a);
    background: color-mix(in srgb, var(--warning-color, #c57a1a) 10%, transparent);
    border-left: 3px solid var(--warning-color, #c57a1a);
    padding: 4px 8px;
    margin: 2px 0;
    grid-column: 1 / -1;
    border-radius: 2px;
  }
  .form-row {
    display: flex;
    gap: 6px;
    align-items: center;
    margin-bottom: 6px;
  }
  select,
  input[type='text'],
  input[type='number'],
  input[type='password'] {
    padding: 5px 7px;
    border: 1px solid var(--border-color, light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15)));
    background: var(--code-bg, light-dark(rgba(0, 0, 0, 0.04), rgba(0, 0, 0, 0.2)));
    color: var(--text-color, #fff);
    border-radius: 4px;
    font-size: 0.85em;
    width: 100%;
    box-sizing: border-box;
  }
  select {
    cursor: pointer;
  }
  select option {
    background: light-dark(#fff, #1e1e2e);
    color: light-dark(#374151, #e0e0e0);
  }
  textarea {
    padding: 5px 7px;
    border: 1px solid var(--border-color, light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15)));
    background: var(--code-bg, light-dark(rgba(0, 0, 0, 0.04), rgba(0, 0, 0, 0.2)));
    color: var(--text-color, #fff);
    border-radius: 4px;
    font-size: 0.8em;
    font-family: monospace;
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
  }
  .otp-input {
    font-size: 1.2em;
    text-align: center;
    letter-spacing: 4px;
    font-family: monospace;
    flex: 1;
  }
  .checkbox-row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.78em;
    color: var(--text-color-muted, #9ca3af);
    margin: 6px 0;
    cursor: pointer;
  }
  .checkbox-row input[type='checkbox'] {
    width: auto;
  }
  .jump-fields {
    margin-top: 6px;
    padding: 6px;
    border: 1px solid var(--border-color, light-dark(rgba(0, 0, 0, 0.08), rgba(255, 255, 255, 0.08)));
    border-radius: 4px;
    margin-bottom: 8px;
  }
  .save-row {
    margin-top: 6px;
  }
  .profile-name {
    flex: 1;
  }

  /* Script header */
  .script-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 4px;
  }
  .script-label-text {
    font-size: 0.75em;
    color: var(--text-color-muted, #9ca3af);
  }
  .upload-script-btn {
    padding: 2px 8px;
    border: 1px dashed var(--border-color, light-dark(rgba(0, 0, 0, 0.25), rgba(255, 255, 255, 0.25)));
    background: transparent;
    color: var(--text-color-muted, #9ca3af);
    border-radius: 3px;
    cursor: pointer;
    font-size: 0.7em;
    transition: background 0.15s;
  }
  .upload-script-btn:hover {
    background: var(--btn-bg, light-dark(rgba(0, 0, 0, 0.06), rgba(255, 255, 255, 0.06)));
    color: var(--text-color, #fff);
  }

  /* Buttons */
  .cancel-btn.small {
    padding: 3px 8px;
    font-size: 0.72em;
    margin-top: 4px;
  }
  .icon-btn {
    padding: 3px 6px;
    border: 1px solid var(--border-color, light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15)));
    background: transparent;
    color: var(--text-color, #fff);
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.8em;
    line-height: 1;
    flex-shrink: 0;
  }
  .icon-btn:hover:not(:disabled) {
    background: var(--btn-bg-hover, light-dark(rgba(0, 0, 0, 0.1), rgba(255, 255, 255, 0.1)));
  }
  .icon-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .icon-btn.active {
    background: var(--accent-color, #3b82f6);
    border-color: var(--accent-color, #3b82f6);
  }
  .icon-btn.danger:hover {
    background: color-mix(in srgb, var(--error-color) 30%, transparent);
    border-color: var(--error-color);
  }
  .conn-actions {
    display: flex;
    gap: 6px;
    margin-top: 8px;
  }
  .install-section {
    margin-top: 12px;
    padding-top: 10px;
    border-top: 1px solid var(--border-color, light-dark(rgba(0, 0, 0, 0.1), rgba(255, 255, 255, 0.1)));
  }
  .install-section h5 {
    margin: 0 0 6px;
    font-size: 0.82em;
    color: var(--text-color, #fff);
  }
  .install-checks {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    font-size: 0.75em;
    margin-top: 4px;
  }
  .install-checks .ok { color: var(--success-color, #4ade80); }
  .install-checks .missing { color: var(--error-color, #f87171); }
  .install-log {
    background: rgba(0, 0, 0, 0.25);
    border-radius: 4px;
    padding: 6px 8px;
    margin-top: 6px;
    max-height: 150px;
    overflow-y: auto;
    font-family: monospace;
    font-size: 0.68em;
    line-height: 1.5;
    color: var(--text-color, #ccc);
  }
  .install-log-line {
    white-space: pre-wrap;
    word-break: break-all;
  }
  .installing-pulse {
    opacity: 0.7;
    animation: pulse 1.5s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 0.4; }
    50% { opacity: 1; }
  }
  .link-btn {
    background: none;
    border: none;
    color: var(--accent-color, #6C9CFC);
    cursor: pointer;
    padding: 0;
    font-size: inherit;
    text-decoration: underline;
    font-family: inherit;
  }
  .link-btn:hover {
    opacity: 0.8;
  }
  .action-btn {
    flex: 1;
    padding: 6px 12px;
    border: 1px solid var(--border-color, light-dark(rgba(0, 0, 0, 0.2), rgba(255, 255, 255, 0.2)));
    background: var(--btn-bg, light-dark(rgba(0, 0, 0, 0.06), rgba(255, 255, 255, 0.06)));
    color: var(--text-color, #fff);
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.8em;
    transition: background 0.15s;
  }
  .action-btn:hover {
    background: var(--btn-bg-hover, light-dark(rgba(0, 0, 0, 0.12), rgba(255, 255, 255, 0.12)));
  }
  .full-width {
    width: 100%;
  }
  .upload-btn {
    padding: 5px 10px;
    border: 1px dashed var(--border-color, light-dark(rgba(0, 0, 0, 0.3), rgba(255, 255, 255, 0.3)));
    background: transparent;
    color: var(--text-color, #fff);
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.78em;
    text-align: center;
    flex: 1;
    transition: background 0.15s;
  }
  .upload-btn:hover {
    background: var(--btn-bg, light-dark(rgba(0, 0, 0, 0.06), rgba(255, 255, 255, 0.06)));
  }

  /* Status & Info */
  .conn-info {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 0.8em;
    color: var(--text-color, #fff);
    margin-bottom: 8px;
  }
  .work-root-chip {
    max-width: 100%;
    margin: -2px 0 8px;
    padding: 4px 6px;
    border: 1px solid var(--border-color, light-dark(rgba(0, 0, 0, 0.12), rgba(255, 255, 255, 0.12)));
    border-radius: 5px;
    color: var(--text-color-muted, #9ca3af);
    background: var(--pre-bg, light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.04)));
    font-family: monospace;
    font-size: 0.7em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .overview-mini {
    display: flex;
    gap: 10px;
    font-size: 0.72em;
    color: var(--text-color-muted, #9ca3af);
    margin-bottom: 6px;
  }
  .overview-disk {
    font-size: 0.7em;
    color: var(--text-color-muted, #9ca3af);
    font-family: monospace;
    margin-bottom: 6px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .overview-card {
    padding: 6px 8px;
    background: var(--pane-bg-hover, light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.04)));
    border-radius: 6px;
  }
  .overview-row {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .overview-host {
    font-size: 0.7em;
    color: var(--text-color-muted, #9ca3af);
    font-family: monospace;
    margin-top: 4px;
  }
  .badge {
    padding: 2px 6px;
    border-radius: 3px;
    font-size: 0.7em;
    font-weight: 600;
    background: var(--btn-bg, light-dark(rgba(0, 0, 0, 0.1), rgba(255, 255, 255, 0.1)));
    color: var(--text-color-muted, #9ca3af);
  }
  .badge-green {
    background: color-mix(in srgb, var(--success-color) 20%, transparent);
    color: var(--success-color);
  }
  .badge-yellow {
    background: color-mix(in srgb, var(--warning-color) 20%, transparent);
    color: var(--warning-color);
  }
  .badge-red {
    background: color-mix(in srgb, var(--error-color) 20%, transparent);
    color: var(--error-color);
  }
  .badge-blue {
    background: color-mix(in srgb, var(--accent-color) 20%, transparent);
    color: var(--accent-color);
  }
  .error-msg {
    padding: 6px 8px;
    background: color-mix(in srgb, var(--error-color) 15%, transparent);
    border: 1px solid color-mix(in srgb, var(--error-color) 30%, transparent);
    border-radius: 4px;
    font-size: 0.78em;
    color: var(--error-color);
  }
  .success-msg {
    padding: 6px 8px;
    background: color-mix(in srgb, #22c55e 15%, transparent);
    border: 1px solid color-mix(in srgb, #22c55e 30%, transparent);
    border-radius: 4px;
    font-size: 0.78em;
    color: #22c55e;
  }
  .submit-msg {
    margin-top: 6px;
    font-size: 0.78em;
    color: var(--text-color-muted, #9ca3af);
  }

  /* Jobs */
  .section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 6px;
  }
  .section-header h5 {
    margin: 0;
  }
  .header-actions {
    display: flex;
    gap: 4px;
  }
  .job-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 300px;
    overflow-y: auto;
  }
  .job-filters {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-bottom: 4px;
  }
  .filter-select {
    flex: 1 1 calc(50% - 2px);
    min-width: 0;
    padding: 3px 4px;
    border-radius: 3px;
    background: var(--code-bg, light-dark(rgba(0, 0, 0, 0.04), rgba(0, 0, 0, 0.2)));
    border: 1px solid var(--border-color, light-dark(rgba(0, 0, 0, 0.12), rgba(255, 255, 255, 0.12)));
    color: inherit;
    font-size: 0.8em;
  }
  .workdir-depth {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 6px;
    font-size: 0.75em;
    color: var(--text-color-muted, #9ca3af);
  }
  .depth-input {
    width: 42px;
    padding: 2px 4px;
    border-radius: 3px;
    background: var(--code-bg, light-dark(rgba(0, 0, 0, 0.04), rgba(0, 0, 0, 0.2)));
    border: 1px solid var(--border-color, light-dark(rgba(0, 0, 0, 0.12), rgba(255, 255, 255, 0.12)));
    color: inherit;
    font-size: 1em;
    text-align: center;
  }
  .job-card {
    padding: 6px 8px;
    background: var(--pre-bg, light-dark(rgba(0, 0, 0, 0.04), rgba(0, 0, 0, 0.15)));
    border-radius: 4px;
  }
  .job-card.clickable {
    cursor: pointer;
    transition: background 0.15s;
  }
  .job-card.clickable:hover {
    background: var(--btn-bg-hover, light-dark(rgba(0, 0, 0, 0.08), rgba(255, 255, 255, 0.08)));
  }
  .job-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .job-id {
    font-family: monospace;
    font-size: 0.8em;
    color: var(--text-color, #fff);
  }
  .job-name {
    font-size: 0.75em;
    color: var(--text-color-muted, #9ca3af);
    margin-top: 2px;
  }
  .job-detail {
    font-size: 0.72em;
    color: var(--text-color-muted, #9ca3af);
  }
  .job-dir {
    font-family: monospace;
    font-size: 0.68em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
  }

  /* Files */
  .files-section {
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  /* Progress */
  .progress-bar {
    position: relative;
    height: 18px;
    background: var(--code-bg, light-dark(rgba(0, 0, 0, 0.04), rgba(0, 0, 0, 0.2)));
    border-radius: 4px;
    overflow: hidden;
    margin: 6px 0;
  }
  .progress-fill {
    height: 100%;
    background: var(--accent-color, #3b82f6);
    transition: width 0.2s;
  }
  .progress-text {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.7em;
    color: white;
  }
  /* Loading bar (indeterminate) */
  .loading-bar {
    position: relative;
    height: 18px;
    background: var(--code-bg, light-dark(rgba(0, 0, 0, 0.04), rgba(0, 0, 0, 0.2)));
    border-radius: 4px;
    overflow: hidden;
    margin: 6px 0;
  }
  .loading-bar-inner {
    position: absolute;
    inset: 0;
    background: linear-gradient(90deg, transparent 0%, var(--accent-color, #3b82f6) 50%, transparent 100%);
    animation: shimmer 1.5s ease-in-out infinite;
  }
  .loading-bar-text {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.7em;
    color: white;
    text-shadow: 0 0 4px rgba(0,0,0,0.5);
  }
  @keyframes shimmer {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(100%); }
  }
  .job-calc-badge {
    display: inline-block;
    padding: 1px 4px;
    border-radius: 2px;
    font-size: 0.7em;
    background: var(--btn-bg, light-dark(rgba(100, 100, 200, 0.1), rgba(100, 100, 200, 0.15)));
    color: var(--accent-color, cornflowerblue);
    margin-top: 2px;
  }

  /* CatGO Launch UI */
  .catgo-launch-row {
    display: flex;
    gap: 6px;
    align-items: flex-end;
    margin-top: 8px;
  }
  .catgo-port-label {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 0.72em;
    color: var(--text-color-muted, #9ca3af);
    flex-shrink: 0;
  }
  .catgo-port-input {
    width: 60px;
    padding: 5px 4px;
    text-align: center;
  }
  .catgo-launch-btn {
    flex: 1;
    white-space: nowrap;
  }
  .catgo-status-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 8px;
  }
  .catgo-job-info {
    font-size: 0.72em;
    font-family: monospace;
    color: var(--text-color-muted, #9ca3af);
    margin-top: 4px;
  }
  .catgo-open-link {
    display: block;
    text-align: center;
    text-decoration: none;
    margin-top: 6px;
  }
  .catgo-spinner {
    width: 14px;
    height: 14px;
    border: 2px solid var(--border-color, rgba(255, 255, 255, 0.2));
    border-top-color: var(--accent-color, #3b82f6);
    border-radius: 50%;
    animation: catgo-spin 0.8s linear infinite;
    flex-shrink: 0;
  }
  @keyframes catgo-spin {
    to { transform: rotate(360deg); }
  }
</style>

<script lang="ts">
  import '$lib/dialog-shared.css'
  import {
    connectHPC,
    connectSSHConfig,
    disconnectSession,
    loadProfiles,
    saveProfile,
    deleteProfile,
    type HPCConnectionConfig,
    type HPCProfile,
    type HPCWSConnection,
    type SchedulerType,
    type AuthMethod,
  } from '$lib/api/hpc'
  import {
    hpc_session_store,
    refresh_hpc_sessions,
    add_session,
    remove_session,
    LOCAL_SESSION_ID,
    type HPCSessionInfo,
  } from '$lib/hpc-sessions.svelte'

  let {
    show = $bindable(false),
  }: {
    show?: boolean
  } = $props()

  // ─── Connection state ───
  type ConnStatus = `idle` | `connecting` | `otp_required` | `connected` | `error`
  let conn_status = $state<ConnStatus>(`idle`)
  let conn_error = $state(``)
  let otp_prompt = $state(`Verification code:`)
  let otp_code = $state(``)
  let ws_conn = $state<HPCWSConnection | null>(null)
  let connected_session_id = $state(``)
  let connected_host = $state(``)
  let connected_username = $state(``)

  // ─── Form state ───
  let host = $state(``)
  let port = $state(22)
  let username = $state(``)
  let password = $state(``)
  let auth_method = $state<AuthMethod>(`password`)
  let key_file = $state(``)
  let use_jump = $state(false)
  let jump_host = $state(``)
  let jump_port = $state(22)
  let jump_username = $state(``)
  let jump_password = $state(``)
  let jump_use_key = $state(true)
  let ssh_alias = $state(``)
  let scheduler = $state<SchedulerType>(`slurm`)
  // ─── SOCKS5 proxy settings ───
  let use_proxy = $state(false)
  let proxy_host = $state(`127.0.0.1`)
  let proxy_port = $state(1080)
  let proxy_username = $state(``)
  let proxy_password = $state(``)

  // ─── Profiles ───
  let profiles = $state<HPCProfile[]>([])
  let selected_profile = $state(``)
  let profile_name = $state(``)
  let profiles_loaded = $state(false)

  // ─── Load profiles + refresh connections on open ───
  $effect(() => {
    if (show) {
      refresh_hpc_sessions()
      if (!profiles_loaded) {
        profiles_loaded = true
        load_saved_profiles()
      }
    }
  })

  async function load_saved_profiles() {
    try {
      profiles = await loadProfiles()
    } catch { /* server not running */ }
  }

  function apply_profile(name: string) {
    const p = profiles.find((pr) => pr.name === name)
    if (!p) return
    host = p.host
    port = p.port
    username = p.username
    auth_method = p.auth_method
    key_file = p.key_file ?? ``
    scheduler = p.scheduler
    ssh_alias = p.ssh_alias ?? ``
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
    }
    try {
      await saveProfile(profile)
      await load_saved_profiles()
      selected_profile = profile_name
    } catch (err) {
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

  // ─── Connect ───
  function do_connect() {
    if (auth_method === `ssh_config`) {
      do_connect_ssh_config()
      return
    }
    // Trim whitespace from hostnames to prevent DNS issues
    host = host.trim()
    username = username.trim()
    if (use_jump && jump_host) jump_host = jump_host.trim()
    if (use_proxy && proxy_host) proxy_host = proxy_host.trim()

    if (!host || !username) return
    const needs_pw = auth_method === `password` || auth_method === `password_otp`
    if (needs_pw && !password) return

    conn_status = `connecting`
    conn_error = ``

    const config: HPCConnectionConfig = {
      host,
      port,
      username,
      password: password || undefined,
      auth_method,
      key_file: key_file || undefined,
      scheduler,
      jump_host: use_jump ? jump_host : undefined,
      jump_port: use_jump ? jump_port : undefined,
      jump_username: use_jump ? (jump_username || undefined) : undefined,
      jump_password: use_jump && !jump_use_key && jump_password ? jump_password : undefined,
      proxy_host: use_proxy ? proxy_host : undefined,
      proxy_port: use_proxy ? proxy_port : undefined,
      proxy_username: use_proxy && proxy_username ? proxy_username : undefined,
      proxy_password: use_proxy && proxy_password ? proxy_password : undefined,
    }

    console.log(
      `[CatGo:HPC] Initiating connection to ${host}:${port}`,
      `auth=${auth_method}`,
      use_proxy ? `proxy=${proxy_host}:${proxy_port}` : `proxy=none`,
      use_jump ? `jump=${jump_host}` : `jump=none`,
    )

    ws_conn = connectHPC(config, {
      onConnected: (session_id) => {
        connected_session_id = session_id
        connected_host = host
        connected_username = username
        conn_status = `connected`
        conn_error = ``
        password = ``
        console.log(`[CatGo:HPC] Connected to ${username}@${host} (session=${session_id})`)
        add_session({ session_id, host, username, scheduler })
      },
      onOTPRequired: (prompt) => {
        conn_status = `otp_required`
        otp_prompt = prompt || `Verification code:`
        otp_code = ``
      },
      onError: (message) => {
        conn_status = `error`
        conn_error = message
        console.error(`[CatGo:HPC] Connection error: ${message}`)
      },
      onDisconnected: () => {
        if (conn_status === `connected`) {
          console.log(`[CatGo:HPC] Disconnected from ${connected_host} (session=${connected_session_id})`)
          conn_status = `idle`
          if (connected_session_id) remove_session(connected_session_id)
          connected_session_id = ``
        }
      },
    })
  }

  async function do_connect_ssh_config() {
    if (!ssh_alias) return
    conn_status = `connecting`
    conn_error = ``
    console.log(`[CatGo:HPC] SSH config connect: alias=${ssh_alias}`, use_proxy ? `proxy=${proxy_host}:${proxy_port}` : `proxy=none`)
    try {
      const result = await connectSSHConfig({
        host: ssh_alias,
        port: 22,
        username: ``,
        auth_method: `ssh_config`,
        ssh_alias,
        scheduler,
        proxy_host: use_proxy ? proxy_host : undefined,
        proxy_port: use_proxy ? proxy_port : undefined,
        proxy_username: use_proxy && proxy_username ? proxy_username : undefined,
        proxy_password: use_proxy && proxy_password ? proxy_password : undefined,
      })
      connected_session_id = result.session_id
      connected_host = result.host
      connected_username = result.username
      conn_status = `connected`
      add_session({
        session_id: result.session_id,
        host: result.host,
        username: result.username,
        scheduler,
      })
    } catch (err: any) {
      conn_status = `error`
      conn_error = err?.message || String(err)
    }
  }

  function submit_otp() {
    if (!otp_code) return
    ws_conn?.submit_otp(otp_code)
    otp_code = ``
    conn_status = `connecting`
  }

  async function do_disconnect(session_id: string) {
    if (!session_id) return
    remove_session(session_id)
    try {
      await disconnectSession(session_id)
    } catch { /* already closed */ }
  }

  function close() {
    show = false
  }

  function reset_form() {
    conn_status = `idle`
    conn_error = ``
    otp_code = ``
    connected_session_id = ``
    ws_conn = null
  }

  // ─── Derived ───
  const can_connect = $derived(
    auth_method === `ssh_config`
      ? !!ssh_alias
      : (!!host && !!username && (auth_method === `key` || auth_method === `key_otp` || !!password))
  )

  // ─── Backdrop handlers ───
  let mousedown_on_backdrop = false
  function handle_backdrop_down(e: MouseEvent) {
    mousedown_on_backdrop = e.target === e.currentTarget
  }
  function handle_backdrop_up(e: MouseEvent) {
    if (mousedown_on_backdrop && e.target === e.currentTarget) close()
    mousedown_on_backdrop = false
  }
  function handle_keydown(e: KeyboardEvent) {
    if (e.key === `Escape`) close()
  }
</script>

{#if show}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="dialog-backdrop"
    onmousedown={handle_backdrop_down}
    onmouseup={handle_backdrop_up}
    onkeydown={handle_keydown}
    role="dialog"
    aria-modal="true"
    tabindex="-1"
  >
    <div class="dialog-modal connect-modal">
      <div class="modal-header">
        <h2 class="modal-title">Connect to Server</h2>
        <button class="close-btn" onclick={close}>x</button>
      </div>

      <div class="modal-body">

        <!-- Connected Sessions List -->
        {#if hpc_session_store.sessions.length > 0}
          <section class="conn-section">
            <h4 class="section-label">Active Connections</h4>
            <div class="session-list">
              {#each hpc_session_store.sessions as s}
                <div class="session-item">
                  <span class="session-dot connected"></span>
                  <span class="session-info">{s.username}@{s.host}</span>
                  <span class="session-sched">{s.scheduler}</span>
                  <button
                    class="session-disconnect"
                    onclick={() => do_disconnect(s.session_id)}
                    title="Disconnect"
                  >✕</button>
                </div>
              {/each}
            </div>
          </section>
        {/if}

        <!-- Status Messages -->
        {#if conn_status === `connecting`}
          <section class="conn-section status-section">
            <div class="status-msg connecting">Connecting...</div>
          </section>
        {:else if conn_status === `otp_required`}
          <section class="conn-section status-section">
            <h4 class="section-label">Two-Factor Authentication</h4>
            <p class="status-description">{otp_prompt}</p>
            <div class="otp-row">
              <input
                type="text"
                bind:value={otp_code}
                placeholder="Enter code"
                maxlength="8"
                class="otp-input"
                onkeydown={(e) => e.key === `Enter` && submit_otp()}
              />
              <button class="btn-primary" onclick={submit_otp} disabled={!otp_code}>Submit</button>
            </div>
          </section>
        {:else if conn_status === `connected`}
          <section class="conn-section status-section">
            <div class="status-msg success">Connected to {connected_username}@{connected_host}</div>
            <button class="btn-new" onclick={reset_form}>Connect Another</button>
          </section>
        {:else if conn_status === `error`}
          <section class="conn-section status-section">
            <div class="status-msg error-msg">{conn_error}</div>
            <button class="btn-new" onclick={reset_form}>Try Again</button>
          </section>
        {/if}

        <!-- Connection Form (shown when idle) -->
        {#if conn_status === `idle`}

          <!-- Profiles -->
          {#if profiles.length > 0}
            <section class="conn-section">
              <h4 class="section-label">Saved Profiles</h4>
              <div class="profile-row">
                <select
                  bind:value={selected_profile}
                  onchange={() => apply_profile(selected_profile)}
                >
                  <option value="">Select profile...</option>
                  {#each profiles as p}
                    <option value={p.name}>{p.name}</option>
                  {/each}
                </select>
                {#if selected_profile}
                  <button class="icon-btn danger" onclick={delete_current_profile} title="Delete profile">✕</button>
                {/if}
              </div>
            </section>
          {/if}

          <!-- New Connection -->
          <section class="conn-section">
            <h4 class="section-label">New Connection</h4>
            <div class="form-grid">
              <label>
                Auth
                <select bind:value={auth_method}>
                  <option value="password">Password</option>
                  <option value="password_otp">Password + OTP</option>
                  <option value="key">SSH Key</option>
                  <option value="key_otp">SSH Key + OTP</option>
                  <option value="ssh_config">SSH Config</option>
                </select>
              </label>
              {#if auth_method === `ssh_config`}
                <label class="full-span">
                  SSH Alias <span class="hint">(from ~/.ssh/config)</span>
                  <input type="text" bind:value={ssh_alias} placeholder="e.g. Shaheen" />
                </label>
              {:else}
                <label>
                  Host
                  <input type="text" bind:value={host} placeholder="hpc.example.com" />
                </label>
                <label>
                  Port
                  <input type="number" bind:value={port} min={1} max={65535} />
                </label>
                <label>
                  Username
                  <input type="text" bind:value={username} placeholder="user" />
                </label>
                {#if auth_method === `password` || auth_method === `password_otp`}
                  <label class="full-span">
                    Password
                    <input type="password" bind:value={password} placeholder="••••••" />
                  </label>
                {/if}
                <label class="full-span">
                  Key File <span class="hint">(optional)</span>
                  <input type="text" bind:value={key_file} placeholder="~/.ssh/id_rsa" />
                </label>
              {/if}
              <label>
                Scheduler
                <select bind:value={scheduler}>
                  <option value="slurm">SLURM</option>
                  <option value="pbs">PBS/Torque</option>
                </select>
              </label>
            </div>

            <!-- Jump Host -->
            <label class="checkbox-row">
              <input type="checkbox" bind:checked={use_jump} />
              Use jump host (bastion)
            </label>

            {#if use_jump}
              <div class="form-grid jump-fields">
                <label>
                  Jump Host
                  <input type="text" bind:value={jump_host} placeholder="bastion.example.com" />
                </label>
                <label>
                  Port
                  <input type="number" bind:value={jump_port} min={1} max={65535} />
                </label>
                <label class="full-span">
                  Jump Username
                  <input type="text" bind:value={jump_username} placeholder="Same as above" />
                </label>
                <label>
                  Jump Auth
                  <select bind:value={jump_use_key} onchange={() => { if (jump_use_key) jump_password = `` }}>
                    <option value={true}>SSH Key</option>
                    <option value={false}>Password</option>
                  </select>
                </label>
                {#if !jump_use_key}
                  <label>
                    Jump Password
                    <input type="password" bind:value={jump_password} placeholder="••••••" />
                  </label>
                {/if}
              </div>
            {/if}

            <!-- Network Settings (SOCKS5 proxy) -->
            <label class="checkbox-row">
              <input type="checkbox" bind:checked={use_proxy} />
              Use SOCKS5 proxy
            </label>

            {#if use_proxy}
              <div class="form-grid jump-fields">
                <label>
                  Proxy Host
                  <input type="text" bind:value={proxy_host} placeholder="127.0.0.1" />
                </label>
                <label>
                  Port
                  <input type="number" bind:value={proxy_port} min={1} max={65535} />
                </label>
                <label>
                  Username <span class="hint">(optional)</span>
                  <input type="text" bind:value={proxy_username} placeholder="Leave empty for no auth" />
                </label>
                <label>
                  Password <span class="hint">(optional)</span>
                  <input type="password" bind:value={proxy_password} placeholder="••••••" />
                </label>
              </div>
            {/if}

            <!-- Save Profile Row -->
            <div class="profile-save-row">
              <input type="text" bind:value={profile_name} placeholder="Profile name" class="profile-name-input" />
              <button class="btn-secondary" onclick={save_current_profile} disabled={!profile_name.trim() || (!host && auth_method !== `ssh_config`)}>Save</button>
            </div>
          </section>
        {/if}
      </div>

      <!-- Footer -->
      <div class="modal-footer">
        <button class="btn-cancel" onclick={close}>
          {conn_status === `connected` ? `Done` : `Cancel`}
        </button>
        {#if conn_status === `idle`}
          <button class="btn-primary" onclick={do_connect} disabled={!can_connect}>Connect</button>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .connect-modal {
    max-width: 480px;
    width: 95%;
  }

  .modal-body {
    padding: 16px 20px;
    overflow-y: auto;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 16px;
    max-height: 65vh;
  }

  .modal-footer {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    padding: 14px 20px;
    border-top: 1px solid var(--dialog-border, light-dark(#d1d5db, #3a3a3a));
    flex-shrink: 0;
  }

  .conn-section {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .section-label {
    margin: 0;
    font-size: 11px;
    font-weight: 700;
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
    text-transform: uppercase;
    letter-spacing: 1px;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--dialog-border, light-dark(#d1d5db, #3a3a3a));
  }

  /* Session list */
  .session-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .session-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border-radius: 6px;
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255, 255, 255, 0.05)));
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    font-size: 12px;
  }

  .session-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .session-dot.connected {
    background: #22c55e;
    box-shadow: 0 0 4px #22c55e;
  }

  .session-info {
    flex: 1;
    color: var(--text-color, light-dark(#374151, #eee));
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .session-sched {
    font-size: 10px;
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
    text-transform: uppercase;
  }

  .session-disconnect {
    background: none;
    border: none;
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
    cursor: pointer;
    font-size: 12px;
    padding: 2px 4px;
    border-radius: 4px;
    line-height: 1;
  }
  .session-disconnect:hover {
    color: var(--error-color, light-dark(#dc2626, #ef4444));
    background: light-dark(rgba(220,38,38,0.1), rgba(248,81,73,0.15));
  }

  /* Status messages */
  .status-section {
    padding: 12px;
    border-radius: 8px;
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255, 255, 255, 0.05)));
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
  }

  .status-msg {
    font-size: 13px;
  }
  .status-msg.connecting {
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
  }
  .status-msg.success {
    color: var(--success-color, light-dark(#059669, #10b981));
  }

  .status-description {
    margin: 0;
    font-size: 12px;
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
  }

  .otp-row {
    display: flex;
    gap: 8px;
    margin-top: 4px;
  }

  .otp-input {
    flex: 1;
    font-size: 18px !important;
    letter-spacing: 4px;
    text-align: center;
    font-family: inherit;
  }

  .btn-new {
    margin-top: 8px;
    background: none;
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    border-radius: 6px;
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
    cursor: pointer;
    padding: 6px 12px;
    font-size: 12px;
    font-family: inherit;
    transition: all 0.15s;
  }
  .btn-new:hover {
    color: var(--text-color, light-dark(#374151, #eee));
    border-color: var(--accent-color, light-dark(#4f46e5, #3b82f6));
  }

  /* Profile row */
  .profile-row {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .profile-row select {
    flex: 1;
  }

  .icon-btn {
    background: none;
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    border-radius: 4px;
    cursor: pointer;
    padding: 4px 8px;
    font-size: 12px;
    line-height: 1;
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
    transition: all 0.15s;
  }
  .icon-btn.danger:hover {
    color: var(--error-color, light-dark(#dc2626, #ef4444));
    border-color: var(--error-color, light-dark(#dc2626, #ef4444));
  }

  /* Form grid */
  .form-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }
  .form-grid label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 11px;
  }
  .form-grid .full-span {
    grid-column: 1 / -1;
  }

  .hint {
    font-weight: 400;
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
  }

  .jump-fields {
    margin-top: 8px;
    padding: 10px;
    border-radius: 6px;
    background: light-dark(rgba(0,0,0,0.02), rgba(255,255,255,0.02));
    border: 1px dashed var(--dialog-border, light-dark(#d1d5db, #404040));
  }

  .checkbox-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 8px;
    font-size: 12px;
    cursor: pointer;
    color: var(--text-color, light-dark(#374151, #eee));
  }
  .checkbox-row input[type="checkbox"] {
    width: 15px;
    height: 15px;
    accent-color: var(--accent-color, light-dark(#4f46e5, #3b82f6));
    cursor: pointer;
  }

  .profile-save-row {
    display: flex;
    gap: 6px;
    margin-top: 10px;
  }
  .profile-name-input {
    flex: 1;
    font-size: 12px !important;
    padding: 6px 10px !important;
  }

  .btn-secondary {
    background: var(--btn-bg, light-dark(rgba(0,0,0,0.06), rgba(255,255,255,0.1)));
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    border-radius: 6px;
    color: var(--text-color, light-dark(#374151, #eee));
    cursor: pointer;
    font-size: 12px;
    padding: 6px 12px;
    font-family: inherit;
    transition: all 0.15s;
  }
  .btn-secondary:hover {
    background: var(--btn-bg-hover, light-dark(rgba(0,0,0,0.12), rgba(255,255,255,0.2)));
  }
  .btn-secondary:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .btn-primary {
    background: var(--accent-color, light-dark(#4f46e5, #3b82f6));
    border: none;
    border-radius: 6px;
    color: #fff;
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
    padding: 8px 18px;
    font-family: inherit;
    transition: all 0.15s;
  }
  .btn-primary:hover {
    background: var(--accent-hover-color, light-dark(#3730a3, #2563eb));
  }
  .btn-primary:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .btn-cancel {
    background: var(--btn-bg, light-dark(rgba(0,0,0,0.06), rgba(255,255,255,0.1)));
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    border-radius: 6px;
    color: var(--text-color, light-dark(#374151, #eee));
    cursor: pointer;
    font-size: 13px;
    padding: 8px 18px;
    font-family: inherit;
    transition: all 0.15s;
  }
  .btn-cancel:hover {
    background: var(--btn-bg-hover, light-dark(rgba(0,0,0,0.12), rgba(255,255,255,0.2)));
  }
</style>

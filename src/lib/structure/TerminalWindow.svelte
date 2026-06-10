<script lang="ts">
  import { untrack } from 'svelte'
  import TerminalPanel from './TerminalPanel.svelte'
  import { Icon } from '$lib'
  import { fetchConnections, type ConnectionInfo } from '$lib/api/hpc'
  import { fetchAvailableShells, type ShellInfo } from '$lib/api/pty'
  import { hpc_session_store, LOCAL_SESSION_ID } from '$lib/hpc-sessions.svelte'
  import { terminal_font_state, save_terminal_font_state, TERMINAL_FONT_FAMILIES } from '$lib/state.svelte'

  let {
    initial_session_id,
    initial_host,
    initial_username,
    initial_sync_cwd = false,
    onclose,
    onpopout,
    on_open_file,
  }: {
    /** Pre-fill the first tab with a remote session. */
    initial_session_id?: string
    initial_host?: string
    initial_username?: string
    /** Enable directory sync on the first tab (inherited from popout URL). */
    initial_sync_cwd?: boolean
    onclose?: () => void
    onpopout?: () => void
    /** Callback when user Ctrl+clicks a file path in the terminal output. */
    on_open_file?: (file_path: string) => void
  } = $props()

  // ====== Server list ======

  interface ServerOption {
    label: string
    session_id?: string
    host?: string
    username?: string
    /** Shell ID for local terminals (e.g. 'powershell', 'git-bash'). */
    shell?: string
  }

  let local_shells = $state<ShellInfo[]>([])
  let servers = $state<ServerOption[]>([{ label: `Local Shell` }])
  let servers_loading = $state(false)

  async function refresh_shells() {
    try {
      local_shells = await fetchAvailableShells()
    } catch {
      local_shells = []
    }
  }

  async function refresh_servers() {
    servers_loading = true
    try {
      const [conns] = await Promise.all([
        fetchConnections(),
        local_shells.length === 0 ? refresh_shells() : Promise.resolve(),
      ])
      // Build local shell options
      const local_options: ServerOption[] = local_shells.length > 0
        ? local_shells.map((s) => ({ label: s.label, shell: s.id }))
        : [{ label: `Local Shell` }]
      // Filter out __local__ session and deduplicate by username@host
      const seen = new Set<string>()
      const unique: ServerOption[] = []
      for (const c of conns) {
        if (c.session_id === LOCAL_SESSION_ID) continue
        const key = `${c.username}@${c.host}`
        if (seen.has(key)) continue
        seen.add(key)
        unique.push({ label: key, session_id: c.session_id, host: c.host, username: c.username })
      }
      servers = [...local_options, ...unique]
    } catch {
      // Keep at least local
    } finally {
      servers_loading = false
    }
  }

  // Load shells + servers on mount — untracked to prevent re-runs
  // (refresh_servers reads local_shells.length synchronously, which would
  //  make this effect depend on local_shells and re-fire every time it changes)
  $effect(() => { untrack(() => { refresh_shells(); refresh_servers() }) })

  // Auto-refresh server list when shared session store changes
  // (e.g. user connects/disconnects from ConnectDialog or another page)
  let _prev_session_count = hpc_session_store.sessions.length
  $effect(() => {
    const count = hpc_session_store.sessions.length
    if (count !== _prev_session_count) {
      _prev_session_count = count
      untrack(() => refresh_servers())
    }
  })

  // ====== Tab management ======

  interface TerminalTab {
    id: string
    label: string
    session_id?: string
    host?: string
    username?: string
    shell?: string
    sync_cwd: boolean
    split: `none` | `horizontal` | `vertical`
    split_session_id?: string
    split_host?: string
    split_username?: string
    split_shell?: string
    split_label?: string
  }

  let _tab_counter = 0
  function next_tab_id(): string { return `tab_${++_tab_counter}` }

  function make_tab(server?: ServerOption): TerminalTab {
    const s = server || servers[0]
    return {
      id: next_tab_id(),
      label: s?.label || `Local Shell`,
      session_id: s?.session_id,
      host: s?.host,
      username: s?.username,
      shell: s?.shell,
      sync_cwd: !!s?.session_id, // Auto-enable CWD sync for remote terminals
      split: `none`,
    }
  }

  let tabs = $state<TerminalTab[]>([])
  let active_tab_id = $state(``)

  // Create initial tab
  $effect(() => {
    if (tabs.length === 0) {
      const first: TerminalTab = {
        id: next_tab_id(),
        label: initial_host ? `${initial_username || ``}@${initial_host}` : `Local Shell`,
        session_id: initial_session_id,
        host: initial_host,
        username: initial_username,
        sync_cwd: initial_sync_cwd || !!initial_session_id, // Auto-enable for remote
        split: `none`,
      }
      tabs = [first]
      active_tab_id = first.id
    }
  })

  let active_tab = $derived(tabs.find((t) => t.id === active_tab_id) || tabs[0])

  // ====== New tab dropdown ======

  let show_new_menu = $state(false)

  function add_tab(server?: ServerOption) {
    const tab = make_tab(server)
    tabs = [...tabs, tab]
    active_tab_id = tab.id
    show_new_menu = false
  }

  function close_tab(id: string) {
    const idx = tabs.findIndex((t) => t.id === id)
    if (idx < 0) return
    tabs = tabs.filter((t) => t.id !== id)
    if (tabs.length === 0) {
      onclose?.()
      return
    }
    if (active_tab_id === id) {
      active_tab_id = tabs[Math.min(idx, tabs.length - 1)].id
    }
  }

  // ====== Split management ======

  let show_split_menu = $state(false)

  function split_tab(direction: `horizontal` | `vertical`, server?: ServerOption) {
    const tab = tabs.find((t) => t.id === active_tab_id)
    if (!tab || tab.split !== `none`) return
    const s = server || { label: tab.label, session_id: tab.session_id, host: tab.host, username: tab.username, shell: tab.shell }
    tab.split = direction
    tab.split_session_id = s.session_id
    tab.split_host = s.host
    tab.split_username = s.username
    tab.split_shell = s.shell
    tab.split_label = s.label
    tabs = [...tabs]
    show_split_menu = false
  }

  function unsplit_tab() {
    const tab = tabs.find((t) => t.id === active_tab_id)
    if (!tab) return
    tab.split = `none`
    tab.split_session_id = undefined
    tab.split_host = undefined
    tab.split_username = undefined
    tab.split_shell = undefined
    tab.split_label = undefined
    tabs = [...tabs]
  }

  let show_font_menu = $state(false)

  function handle_global_click() {
    if (show_new_menu) show_new_menu = false
    if (show_split_menu) show_split_menu = false
    if (show_font_menu) show_font_menu = false
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="tw" onclick={handle_global_click}>
  <!-- Tab bar -->
  <div class="tw-tabbar">
    <div class="tw-tabs">
      {#each tabs as tab (tab.id)}
        <button
          class="tw-tab"
          class:active={active_tab_id === tab.id}
          onclick={() => { active_tab_id = tab.id }}
          title={tab.label}
        >
          <span class="tw-tab-icon">{tab.session_id ? `🖥` : `💻`}</span>
          <span class="tw-tab-label">{tab.label}</span>
          <span
            class="tw-tab-close"
            role="button"
            tabindex="-1"
            onclick={(e) => { e.stopPropagation(); close_tab(tab.id) }}
            onkeydown={(e) => { if (e.key === `Enter`) { e.stopPropagation(); close_tab(tab.id) } }}
          >&times;</span>
        </button>
      {/each}
    </div>

    <!-- New tab button with dropdown -->
    <div class="tw-dropdown-wrap">
      <button
        class="tw-icon-btn"
        title="New terminal tab"
        onclick={(e) => { e.stopPropagation(); show_new_menu = !show_new_menu; show_split_menu = false }}
      >+</button>
      {#if show_new_menu}
        {@const local_options = servers.filter((s) => !s.session_id)}
        {@const remote_options = servers.filter((s) => s.session_id)}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="tw-dropdown" onclick={(e) => e.stopPropagation()}>
          <div class="tw-dropdown-header">New Terminal</div>
          {#each local_options as server}
            <button class="tw-dropdown-item" onclick={() => add_tab(server)}>
              <span class="tw-dropdown-icon">💻</span>
              {server.label}
            </button>
          {/each}
          {#if remote_options.length > 0}
            <div class="tw-dropdown-divider"></div>
            <div class="tw-dropdown-subheader">Remote</div>
            {#each remote_options as server}
              <button class="tw-dropdown-item" onclick={() => add_tab(server)}>
                <span class="tw-dropdown-icon">🖥</span>
                {server.label}
              </button>
            {/each}
          {/if}
          {#if servers_loading}
            <div class="tw-dropdown-note">Loading...</div>
          {/if}
          <button class="tw-dropdown-item tw-dropdown-refresh" onclick={(e) => { e.stopPropagation(); refresh_servers() }}>
            ↻ Refresh
          </button>
        </div>
      {/if}
    </div>

    <!-- Split button with dropdown -->
    <div class="tw-dropdown-wrap">
      <button
        class="tw-icon-btn"
        title={active_tab?.split !== `none` ? `Unsplit pane` : `Split pane`}
        onclick={(e) => {
          e.stopPropagation()
          if (active_tab?.split !== `none`) {
            unsplit_tab()
          } else {
            show_split_menu = !show_split_menu
            show_new_menu = false
          }
        }}
      >{active_tab?.split !== `none` ? `▣` : `⊞`}</button>
      {#if show_split_menu}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="tw-dropdown" onclick={(e) => e.stopPropagation()}>
          <div class="tw-dropdown-header">Split Pane</div>
          <div class="tw-dropdown-subheader">Direction</div>
          {#each servers as server}
            <button class="tw-dropdown-item" onclick={() => split_tab(`horizontal`, server)}>
              ⬌ {server.label}
            </button>
          {/each}
          <div class="tw-dropdown-divider"></div>
          {#each servers as server}
            <button class="tw-dropdown-item" onclick={() => split_tab(`vertical`, server)}>
              ⬍ {server.label}
            </button>
          {/each}
        </div>
      {/if}
    </div>

    <!-- Right-side controls -->
    <div class="tw-toolbar-right">
      <!-- Font settings dropdown -->
      <div class="tw-dropdown-wrap">
        <button
          class="tw-icon-btn"
          title="Terminal font settings"
          onclick={(e) => { e.stopPropagation(); show_font_menu = !show_font_menu; show_new_menu = false; show_split_menu = false }}
        ><Icon icon="Settings" /></button>
        {#if show_font_menu}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="tw-dropdown tw-font-dropdown" onclick={(e) => e.stopPropagation()}>
            <div class="tw-dropdown-header">Font Settings</div>
            <div class="tw-font-control">
              <label class="tw-font-label">
                <span>Size</span>
                <div class="tw-font-size-row">
                  <input
                    type="range"
                    min="10"
                    max="24"
                    step="1"
                    value={terminal_font_state.font_size}
                    oninput={(e) => {
                      terminal_font_state.font_size = +(e.target as HTMLInputElement).value
                      save_terminal_font_state()
                    }}
                  />
                  <span class="tw-font-size-value">{terminal_font_state.font_size}px</span>
                </div>
              </label>
            </div>
            <div class="tw-dropdown-divider"></div>
            <div class="tw-font-control">
              <label class="tw-font-label">
                <span>Font</span>
                <select
                  value={terminal_font_state.font_family}
                  onchange={(e) => {
                    terminal_font_state.font_family = (e.target as HTMLSelectElement).value
                    save_terminal_font_state()
                  }}
                >
                  {#each TERMINAL_FONT_FAMILIES as f}
                    <option value={f.value}>{f.label}</option>
                  {/each}
                </select>
              </label>
            </div>
          </div>
        {/if}
      </div>

      {#if active_tab?.session_id}
        <button
          class="tw-icon-btn tw-sync-btn"
          class:active={active_tab.sync_cwd}
          title={active_tab.sync_cwd ? `Directory sync ON — file browser follows terminal CWD` : `Directory sync OFF — click to enable`}
          onclick={() => { if (active_tab) active_tab.sync_cwd = !active_tab.sync_cwd; tabs = [...tabs] }}
        >
          <Icon icon="Link" />
        </button>
      {/if}
      {#if onpopout}
        <button class="tw-icon-btn" title="Open in new window" onclick={onpopout}>↗</button>
      {/if}
      {#if onclose}
        <button class="tw-icon-btn tw-close-btn" title="Close" onclick={onclose}>&times;</button>
      {/if}
    </div>
  </div>

  <!-- Terminal panes -->
  <div class="tw-content">
    {#each tabs as tab (tab.id)}
      <div
        class="tw-pane-container"
        class:active={active_tab_id === tab.id}
        class:split-h={tab.split === `horizontal`}
        class:split-v={tab.split === `vertical`}
      >
        <div class="tw-pane">
          <TerminalPanel
            session_id={tab?.session_id ?? ``}
            host={tab?.host}
            username={tab?.username}
            shell={tab?.shell}
            font_size={terminal_font_state.font_size}
            font_family={terminal_font_state.font_family}
            show_header={false}
            bind:sync_cwd={tab.sync_cwd}
            {on_open_file}
          />
        </div>
        {#if tab.split !== `none`}
          <div class="tw-divider"></div>
          <div class="tw-pane">
            <TerminalPanel
              session_id={tab?.split_session_id ?? ``}
              host={tab?.split_host}
              username={tab?.split_username}
              shell={tab?.split_shell}
              font_size={terminal_font_state.font_size}
              font_family={terminal_font_state.font_family}
              show_header={false}
              bind:sync_cwd={tab.sync_cwd}
              {on_open_file}
            />
          </div>
        {/if}
      </div>
    {/each}
  </div>
</div>

<style>
  .tw {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
    background: var(--page-bg);
    color: var(--text-color, #e0e0e0);
  }

  /* ====== Tab bar ====== */
  .tw-tabbar {
    display: flex;
    align-items: stretch;
    background: var(--surface-bg);
    border-bottom: 1px solid var(--border-color);
    flex-shrink: 0;
    min-height: 34px;
    min-width: 0;
  }
  .tw-tabs {
    display: flex;
    flex: 1;
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .tw-tabs::-webkit-scrollbar { display: none; }

  .tw-tab {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 5px 10px;
    border: none;
    background: transparent;
    color: var(--text-color-muted, #94a3b8);
    font-size: 0.76em;
    cursor: pointer;
    white-space: nowrap;
    min-width: 0;
    max-width: 180px;
    transition: background 0.15s, color 0.15s;
    border-bottom: 2px solid transparent;
  }
  .tw-tab:hover {
    background: var(--surface-bg-hover, rgba(0, 0, 0, 0.05));
    color: var(--text-color, #e0e0e0);
  }
  .tw-tab.active {
    background: var(--surface-bg-hover, rgba(0, 0, 0, 0.05));
    color: var(--text-color, #e0e0e0);
    border-bottom-color: var(--accent-color, #3b82f6);
  }
  .tw-tab-icon {
    font-size: 0.85em;
    flex-shrink: 0;
  }
  .tw-tab-label {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tw-tab-close {
    flex-shrink: 0;
    font-size: 1.1em;
    line-height: 1;
    opacity: 0;
    padding: 0 2px;
    border-radius: 2px;
    cursor: pointer;
  }
  .tw-tab:hover .tw-tab-close { opacity: 0.5; }
  .tw-tab-close:hover {
    opacity: 1 !important;
    background: rgba(255, 100, 100, 0.3);
    color: #ff6b6b;
  }

  /* ====== Icon buttons ====== */
  .tw-icon-btn {
    padding: 4px 8px;
    border: none;
    background: transparent;
    color: var(--text-color-muted, #94a3b8);
    font-size: 0.85em;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
    flex-shrink: 0;
  }
  .tw-sync-btn.active {
    color: var(--accent-color, #3b82f6);
  }
  .tw-icon-btn:hover {
    background: var(--surface-bg-hover, rgba(0, 0, 0, 0.05));
    color: var(--text-color, #333);
  }
  .tw-close-btn:hover {
    background: rgba(255, 100, 100, 0.15);
    color: #ff6b6b;
  }

  /* ====== Dropdown menu ====== */
  .tw-dropdown-wrap {
    position: relative;
    flex-shrink: 0;
    display: flex;
  }
  .tw-dropdown {
    position: absolute;
    top: 100%;
    right: 0;
    z-index: 100;
    min-width: min(260px, calc(100vw - 16px));
    width: max-content;
    max-width: min(400px, calc(100vw - 16px));
    max-height: calc(100vh - 72px);
    background: var(--surface-bg);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
    padding: 4px 0;
    margin-top: 2px;
    overflow: auto;
  }
  .tw-dropdown-header {
    padding: 6px 10px 3px;
    font-size: 0.68em;
    color: var(--text-color-muted, #94a3b8);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .tw-dropdown-subheader {
    padding: 4px 10px 2px;
    font-size: 0.65em;
    color: var(--text-color-muted, #94a3b8);
    text-transform: uppercase;
    letter-spacing: 0.3px;
  }
  .tw-dropdown-divider {
    border-top: 1px solid var(--border-color, rgba(0, 0, 0, 0.1));
    margin: 4px 0;
  }
  .tw-dropdown-item {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 6px 10px;
    border: none;
    background: transparent;
    color: var(--text-color, #333);
    font-size: 0.78em;
    cursor: pointer;
    text-align: left;
    transition: background 0.1s;
    white-space: nowrap;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tw-dropdown-item:hover {
    background: var(--surface-bg-hover);
  }
  .tw-dropdown-icon {
    font-size: 1em;
    flex-shrink: 0;
  }
  .tw-dropdown-refresh {
    border-top: 1px solid var(--border-color, rgba(0, 0, 0, 0.1));
    margin-top: 2px;
    color: var(--text-color-muted, #94a3b8);
    font-size: 0.72em;
  }
  .tw-dropdown-note {
    padding: 6px 10px;
    font-size: 0.72em;
    color: var(--text-color-muted, #94a3b8);
  }

  /* ====== Font settings dropdown ====== */
  .tw-font-dropdown {
    min-width: 200px;
    padding: 6px 0;
  }
  .tw-font-control {
    padding: 4px 10px;
  }
  .tw-font-label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 0.75em;
    color: var(--text-color, #e0e0e0);
  }
  .tw-font-size-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .tw-font-size-row input[type="range"] {
    flex: 1;
    height: 4px;
    accent-color: var(--accent-color, #3b82f6);
    cursor: pointer;
  }
  .tw-font-size-value {
    font-size: 0.9em;
    color: var(--text-color-muted, #94a3b8);
    min-width: 32px;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .tw-font-control select {
    width: 100%;
    padding: 4px 6px;
    border: 1px solid var(--border-color, rgba(255, 255, 255, 0.12));
    border-radius: 4px;
    background: var(--surface-bg, #1a1a2e);
    color: var(--text-color, #e0e0e0);
    font-size: 0.9em;
    cursor: pointer;
    outline: none;
  }
  .tw-font-control select:focus {
    border-color: var(--accent-color, #3b82f6);
  }

  /* ====== Right toolbar ====== */
  .tw-toolbar-right {
    display: flex;
    align-items: center;
    margin-left: auto;
    flex-shrink: 0;
  }

  /* ====== Terminal content ====== */
  .tw-content {
    flex: 1;
    min-height: 0;
    position: relative;
    overflow: hidden;
  }
  .tw-pane-container {
    position: absolute;
    inset: 0;
    display: none;
  }
  .tw-pane-container.active {
    display: flex;
  }
  /* Single pane */
  .tw-pane-container:not(.split-h):not(.split-v) {
    flex-direction: column;
  }
  /* Horizontal split */
  .tw-pane-container.split-h {
    flex-direction: row;
  }
  .tw-pane-container.split-h > .tw-divider {
    width: 3px;
    background: var(--border-color, rgba(0, 0, 0, 0.1));
    cursor: col-resize;
    flex-shrink: 0;
  }
  .tw-pane-container.split-h > .tw-divider:hover {
    background: rgba(59, 130, 246, 0.3);
  }
  /* Vertical split */
  .tw-pane-container.split-v {
    flex-direction: column;
  }
  .tw-pane-container.split-v > .tw-divider {
    height: 3px;
    background: var(--border-color, rgba(0, 0, 0, 0.1));
    cursor: row-resize;
    flex-shrink: 0;
  }
  .tw-pane-container.split-v > .tw-divider:hover {
    background: rgba(59, 130, 246, 0.3);
  }

  .tw-pane {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-height: 0;
    min-width: 0;
  }
  .tw-pane :global(.terminal-panel) {
    flex: 1;
    border: none;
    border-left: none;
  }
</style>

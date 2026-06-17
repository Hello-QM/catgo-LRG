<!--
  MobileWorkspace.svelte — purpose-built mobile layout for CatGo.

  Terminal-first workspace that hosts BOTH the real structure editor and the
  russh SSH terminal, with switchable layouts. Connecting to a cluster is
  OPTIONAL: the user can just view/edit a local structure (no backend, exactly
  like the web build), or connect for a remote terminal + remote files.

  Entry: a chooser — "Structure" (local, no connect) or "Terminal" (connect).
  Layouts: full-structure / full-terminal / split (horizontal or vertical).
  Flow: tap a structure in Files -> it loads in the structure pane; edit it;
  one-tap Save writes it back to the cluster (sftpWrite) when it came from there,
  else downloads it; one-tap back to the terminal.

  Mounted behind the isMobile() gate INSIDE App.svelte, so the app-root globals
  the editor needs (i18n, theme, <Toast/>) are already set up.
-->
<script lang="ts">
  import Structure from '$lib/structure/Structure.svelte'
  import MolstarViewer from '$lib/structure/bio/MolstarViewer.svelte'
  import BioViewerToggle from '$lib/structure/bio/BioViewerToggle.svelte'
  import { detect_bio } from '$lib/structure/bio/detect'
  import Trajectory from '$lib/trajectory/Trajectory.svelte'
  import OptimadeSearchModal from '$lib/structure/OptimadeSearchModal.svelte'
  import { parse_any_structure } from '$lib/structure/parsers/dispatch'
  import { is_trajectory_file, parse_trajectory_data } from '$lib/trajectory/parse'
  import { structure_to_poscar } from '$lib/structure/export/offline-serialize'
  import { writeRemoteFile } from '$lib/api/hpc'
  import { transport } from '$lib/api/transport'
  import MobileConnect from './MobileConnect.svelte'
  import MobileTerminal from './MobileTerminal.svelte'
  import MobileFiles from './MobileFiles.svelte'
  import MobileChat from './MobileChat.svelte'
  import KeySetup from './KeySetup.svelte'
  import { loadConnections } from './connections'
  import { tick } from 'svelte'
  import {
    active_cwd,
    add_tab,
    close_tab,
    close_tabs_for_session,
    ensure_tab,
    MAX_TABS,
    path_basename,
    set_tab_cwd,
    switch_tab,
    term_tabs,
    toggle_edit_mode,
  } from './terminal-tabs.svelte'
  import {
    clusters,
    get_active_cluster,
    register_cluster,
    remove_cluster,
    set_active_cluster,
  } from './clusters.svelte'
  import type { ConnectedMeta } from './MobileConnect.svelte'
  import { endpointKey } from './sessions'
  import { check_tauri } from '$lib/io/tauri'
  import LocaleSwitch from '$lib/i18n/LocaleSwitch.svelte'
  import Icon from '$lib/Icon.svelte'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'

  load_i18n_module(`mobile`)

  type Mode = `choose` | `structure` | `terminal` | `split-h` | `split-v`

  // Mobile WEB (iPhone/Android browser) vs the native app. The terminal needs
  // the russh transport, which only exists inside the Tauri app (the browser
  // can't open raw TCP for SSH). On web we hide the terminal entry + layouts and
  // tell the user to use the app.
  const is_web = !check_tauri()

  let mode = $state<Mode>(`choose`)
  let session_id = $state<string | null>(null)
  // The live structure (edited in place) + the saveable view (no PBC images).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let structure = $state<any>(undefined)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let saveable_structure = $state<any>(undefined)
  // Multi-frame files (extxyz/traj/vasprun…) load as a trajectory with playback
  // instead of a single static structure.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let trajectory = $state<any>(undefined)
  // Where the open structure came from, so Save knows to write it back.
  let remote_origin = $state<{ path: string; filename: string } | null>(null)
  let local_filename = $state(`structure.vasp`)
  // Biomolecular files (PDB / bio-mmCIF) render in Mol*, not the native viewer.
  let bio_raw_content = $state<string | null>(null)
  let bio_format = $state(`pdb`)
  let bio_viewer = $state(true)
  let files_open = $state(false)
  // AI chat overlay — available whenever the workspace is shown (works without a
  // cluster connection: the key-direct LLM path needs no backend).
  let ai_open = $state(false)
  let db_visible = $state(false)
  let save_msg = $state(``)

  // Auto-expand the terminal while typing: in a split layout the soft keyboard
  // leaves almost no room for the terminal, so when it opens we switch to the
  // full-terminal view and restore the split when it closes. Gated on no overlay
  // (the chat/files own their own keyboard) so we only react to the terminal.
  let kb_open = $state(false)
  let mode_before_kb: Mode | null = null
  $effect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const update = () => {
      // >120px of inset = a real soft keyboard, not the URL bar / safe area.
      const open = window.innerHeight - vv.height - vv.offsetTop > 120
      if (open !== kb_open) kb_open = open
    }
    update()
    vv.addEventListener(`resize`, update)
    vv.addEventListener(`scroll`, update)
    return () => {
      vv.removeEventListener(`resize`, update)
      vv.removeEventListener(`scroll`, update)
    }
  })
  $effect(() => {
    const split = mode === `split-h` || mode === `split-v`
    if (kb_open && split && !ai_open && !files_open && !db_visible) {
      mode_before_kb = mode
      mode = `terminal`
    } else if (!kb_open && mode_before_kb) {
      // Restore the split only if the user didn't manually pick another view.
      if (mode === `terminal`) mode = mode_before_kb
      mode_before_kb = null
    }
  })

  // Hide the editor toolbar items that don't apply on mobile: server/HPC +
  // terminal are owned by MobileWorkspace (russh); workflow, plugin_hub and chat
  // are Python-backend-only (chat streams via /api/agent/stream) so they can't
  // work without the backend.
  // gesture (MediaPipe hand-tracking via camera) is dropped on mobile: the
  // front camera + hand model + the 3D editor together exhaust the WebView and
  // crash the app on this hardware.
  // analysis: AnalysisPane fetches /api/plugins/analyzers from the Python backend,
  // which mobile doesn't run — a visible-but-503 entry point Apple App Review flags.
  const HIDDEN_TOOLBAR = [`server`, `terminal`, `workflow`, `plugin_hub`, `chat`, `gesture`, `analysis`]

  // SSH-key passwordless onboarding (shown once per endpoint after first connect).
  let ks_visible = $state(false)
  let ks_host = $state(``)
  let ks_port = $state(22)
  let ks_user = $state(``)

  let file_input: HTMLInputElement | undefined = $state()
  // NOTE: the keyboard is handled by the native window-insets padding in
  // MainActivity (this WebView's window.visualViewport does NOT shrink for the
  // IME). We deliberately do NOT bind the root height to visualViewport — doing
  // so double-counts the keyboard and leaves a black gap above it.

  // The Files tab follows the ACTIVE terminal's cwd (each tab tracks its own).
  const term_cwd = $derived(active_cwd())
  // Imperative handle from the mounted Structure editor — drives the mobile
  // undo/redo buttons (desktop uses Ctrl+Z; mobile has no keyboard).
  let editor_api = $state<{
    undo: () => void
    redo: () => void
    can_undo: () => boolean
    can_redo: () => boolean
  }>()
  const has_structure = $derived(structure != null)

  // Per-tab component refs so a tab switch can refit()/focus() the now-visible
  // terminal. Keyed by tab id (set via bind:this in the {#each}).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let term_refs = $state<Record<string, any>>({})
  // Long-press → close action sheet; holds the target tab id while open.
  let sheet_tab = $state<string | null>(null)
  let lp_timer: ReturnType<typeof setTimeout> | null = null
  let lp_fired = false

  // Clear a dangling long-press timer if the workspace tears down mid-press.
  $effect(() => () => {
    if (lp_timer) clearTimeout(lp_timer)
  })

  // Tap = switch. Focus synchronously (trusted gesture so the soft keyboard
  // stays up), then refit after the DOM shows the now-active tab.
  async function select_tab(id: string): Promise<void> {
    switch_tab(id)
    // Activating a tab also activates its cluster: Files/Jobs/chat follow.
    const tab = term_tabs.tabs.find((t) => t.id === id)
    if (tab && tab.session_id !== session_id) {
      session_id = tab.session_id
      const c = clusters.list.find((x) => x.session_id === tab.session_id)
      if (c) set_active_cluster(c.key)
    }
    term_refs[id]?.focus?.()
    await tick()
    term_refs[id]?.refit?.()
  }
  // Close a tab + tidy the state tied to it: the unmounting MobileTerminal
  // closes its own PTY, but bind:this leaves a stale `undefined` ref behind, so
  // drop the key; also dismiss the action sheet if it targeted this tab.
  function remove_tab(id: string): void {
    close_tab(id)
    delete term_refs[id]
    if (sheet_tab === id) sheet_tab = null
  }
  function tab_pointerdown(id: string): void {
    if (lp_timer) clearTimeout(lp_timer) // drop any previous press (multi-touch)
    lp_fired = false
    lp_timer = setTimeout(() => {
      lp_fired = true
      sheet_tab = id
    }, 500)
  }
  function tab_pointerup(): void {
    if (lp_timer) clearTimeout(lp_timer)
    lp_timer = null
  }
  function tab_click(id: string): void {
    if (lp_fired) {
      lp_fired = false // long-press already opened the sheet; swallow the click
      return
    }
    select_tab(id)
  }
  function sheet_close(): void {
    if (sheet_tab) remove_tab(sheet_tab)
  }
  const has_content = $derived(structure != null || trajectory != null)
  const multi_cluster_tabs = $derived(
    new Set(term_tabs.tabs.map((t) => t.session_id)).size > 1,
  )

  // Auto-dismiss the save/notice banner so it never sticks permanently; a ✕ also
  // clears it immediately.
  $effect(() => {
    if (!save_msg) return
    const t = setTimeout(() => {
      save_msg = ``
    }, 6000)
    return () => clearTimeout(t)
  })
  const can_save = $derived(has_structure && (saveable_structure != null || structure != null))

  function show_loaded(filename: string, origin: { path: string } | null): void {
    local_filename = filename
    remote_origin = origin ? { path: origin.path, filename } : null
    save_msg = ``
    files_open = false
    if (mode === `choose` || mode === `terminal`) mode = `structure`
  }

  async function set_structure(
    content: string,
    filename: string,
    origin: { path: string } | null,
  ): Promise<void> {
    // Clear any prior bio state so a later trajectory/material load isn't
    // hijacked by a stale protein.
    bio_raw_content = null
    bio_format = `pdb`
    bio_viewer = true
    // Multi-frame file -> load the whole trajectory (with playback), not frame 1.
    if (is_trajectory_file(filename, content)) {
      try {
        const traj = await parse_trajectory_data(content, filename)
        if (traj) {
          trajectory = traj
          structure = undefined
          saveable_structure = undefined
          show_loaded(filename, origin)
          return
        }
      } catch {
        /* fall back to single-structure parsing */
      }
    }
    // Biological macromolecule → render in Mol* (bypass pymatgen parsing,
    // which would drop residue/chain and choke on large proteins).
    const bio = detect_bio(content, filename)
    if (bio.isBio && bio.format) {
      bio_raw_content = content
      bio_format = bio.format
      bio_viewer = true
      structure = undefined
      trajectory = undefined
      saveable_structure = undefined
      show_loaded(filename, origin)
      return
    }
    const parsed = parse_any_structure(content, filename)
    if (!parsed) {
      save_msg = t(`mobile.could_not_parse`, { filename })
      return
    }
    structure = parsed
    trajectory = undefined
    saveable_structure = undefined
    show_loaded(filename, origin)
  }

  /**
   * Flip the mobile viewer between Mol* and native (manual override). Works for
   * ANY loaded structure: with no bio raw text yet we serialize the current
   * structure (CIF when periodic, else XYZ) and hand it to Mol*.
   */
  async function toggle_mobile_viewer(): Promise<void> {
    if (bio_viewer && bio_raw_content) {
      // → native: parse the raw text on demand
      const parsed = parse_any_structure(bio_raw_content, local_filename)
      if (parsed) structure = parsed
      bio_viewer = false
    } else {
      // → Mol*: serialize the current structure if we have no raw text yet
      if (!bio_raw_content && structure?.sites?.length) {
        const { structure_to_cif_str, structure_to_xyz_str } = await import(
          '$lib/structure/export'
        )
        const periodic = !!structure?.lattice?.matrix
        bio_raw_content = periodic
          ? structure_to_cif_str(structure)
          : structure_to_xyz_str(structure)
        bio_format = periodic ? 'mmcif' : 'xyz'
      }
      if (bio_raw_content) {
        structure = undefined
        bio_viewer = true
      }
    }
  }

  // ── Local file open (no cluster needed) ──
  function open_local(): void {
    file_input?.click()
  }

  async function on_local_file(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement
    const f = input.files?.[0]
    if (!f) return
    const text = await f.text()
    set_structure(text, f.name, null)
    input.value = ``
  }

  // ── Remote structure open (from the Files browser) ──
  function open_remote_structure(content: string, filename: string, path: string): void {
    set_structure(content, filename, { path })
  }

  // ── Database import (OPTIMADE / Materials Project / PubChem) ──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function on_db_import(s: any): void {
    structure = s
    trajectory = undefined
    saveable_structure = undefined
    local_filename = `POSCAR`
    remote_origin = null
    save_msg = ``
    db_visible = false
    if (mode === `choose` || mode === `terminal`) mode = `structure`
  }

  // ── Save: write back to the cluster, or download locally ──
  async function save(): Promise<void> {
    const s = saveable_structure ?? structure
    if (!s) return
    let text: string
    try {
      text = structure_to_poscar(s, `CatGo mobile`)
    } catch (err) {
      save_msg = err instanceof Error ? err.message : String(err)
      return
    }
    if (remote_origin && session_id) {
      const r = await writeRemoteFile(session_id, remote_origin.path, text)
      save_msg = r.success
        ? t(`mobile.saved_to`, { path: remote_origin.path })
        : t(`mobile.save_failed_reason`, { reason: r.message })
    } else {
      const blob = new Blob([text], { type: `text/plain` })
      const url = URL.createObjectURL(blob)
      const a = document.createElement(`a`)
      a.href = url
      a.download = local_filename || `POSCAR`
      a.click()
      URL.revokeObjectURL(url)
      save_msg = t(`mobile.downloaded`, { filename: a.download })
    }
  }

  // Eject ONE cluster from the workspace (its russh session stays alive on the
  // Rust side for silent ControlMaster-style reuse — see sessions.ts). Other
  // connected clusters keep their tabs; the next one becomes active. With no
  // clusters left the terminal pane shows the connect form again.
  function eject_cluster(key: string): void {
    const c = clusters.list.find((x) => x.key === key)
    if (c) close_tabs_for_session(c.session_id)
    const next = remove_cluster(key)
    if (next) {
      session_id = next.session_id
      ensure_tab(next.session_id, next.label)
      return
    }
    session_id = null
    ks_visible = false
    files_open = false
    if (!has_content) mode = is_web ? `choose` : `terminal`
  }

  function disconnect(): void {
    const active = get_active_cluster()
    if (active) eject_cluster(active.key)
    else session_id = null
  }

  // "+" on the tab strip: with one cluster it's ambiguous what the user wants
  // (another shell here, or a different cluster?) — ask. Selecting a connected
  // cluster opens a tab on it without re-auth; "new cluster" shows the connect
  // form WITHOUT dropping any live session.
  let add_sheet_visible = $state(false)
  function add_tab_on(cluster_session: string, cluster_label: string): void {
    add_sheet_visible = false
    add_tab(cluster_session, cluster_label)
    const c = clusters.list.find((x) => x.session_id === cluster_session)
    if (c) {
      set_active_cluster(c.key)
      session_id = c.session_id
    }
  }
  function add_new_cluster(): void {
    add_sheet_visible = false
    session_id = null // shows MobileConnect; live clusters stay registered
  }

  function on_connected(id: string, meta: ConnectedMeta): void {
    session_id = id
    register_cluster({
      key: endpointKey(meta.host, meta.port, meta.username),
      session_id: id,
      host: meta.host,
      port: meta.port,
      username: meta.username,
      label: meta.label,
    })
    ensure_tab(id, meta.label) // seed (or refocus) this cluster's terminal tab
    if (mode === `choose`) mode = `terminal`

    // Offer SSH-key passwordless setup once per endpoint (skip if already keyed
    // or the connection already used a public key). MobileConnect persists the
    // connection on success, so the most-recent entry gives host/port/user.
    const recent = loadConnections()[0]
    if (!recent || recent.method === `publickey`) return
    ks_host = recent.host
    ks_port = recent.port
    ks_user = recent.username
    transport
      .keyLoad(`${recent.host}:${recent.port}:${recent.username}`)
      .then((k) => {
        ks_visible = k == null
      })
      .catch(() => {
        ks_visible = false
      })
  }

  // Which panes are visible in the current layout.
  const show_structure = $derived(mode === `structure` || mode === `split-h` || mode === `split-v`)
  const show_terminal = $derived(mode === `terminal` || mode === `split-h` || mode === `split-v`)
</script>

<input
  bind:this={file_input}
  type="file"
  accept="*/*"
  onchange={on_local_file}
  hidden
/>

<div class="mw-root">
  {#if mode === `choose`}
    <div class="mw-choose">
      <div class="mw-choose-top">
        <div class="mw-choose-brand">
          <img class="mw-choose-logo" src="/favicon.svg" alt="CatGo" width="40" height="40" />
          <div class="mw-choose-title">CatGo</div>
        </div>
        <LocaleSwitch />
      </div>
      <div class="mw-choose-sub">{t(`mobile.choose_prompt`)}</div>
      <button type="button" class="mw-choice" onclick={open_local}>
        <span class="mw-choice-icon"><Icon icon="Atom" /></span>
        <span class="mw-choice-main">{t(`mobile.choice_structure_main`)}</span>
        <span class="mw-choice-desc">{t(`mobile.choice_structure_desc`)}</span>
      </button>
      <button type="button" class="mw-choice" onclick={() => (db_visible = true)}>
        <span class="mw-choice-icon"><Icon icon="Database" /></span>
        <span class="mw-choice-main">{t(`mobile.choice_database_main`)}</span>
        <span class="mw-choice-desc">{t(`mobile.choice_database_desc`)}</span>
      </button>
      {#if is_web}
        <div class="mw-choice mw-choice-disabled" aria-disabled="true">
          <span class="mw-choice-icon"><Icon icon="Terminal" /></span>
          <span class="mw-choice-main">{t(`mobile.choice_connect_main`)}</span>
          <span class="mw-choice-desc">{t(`mobile.connect_app_only`)}</span>
        </div>
      {:else}
        <button type="button" class="mw-choice" onclick={() => (mode = `terminal`)}>
          <span class="mw-choice-icon"><Icon icon="Terminal" /></span>
          <span class="mw-choice-main">{t(`mobile.choice_connect_main`)}</span>
          <span class="mw-choice-desc">{t(`mobile.choice_connect_desc`)}</span>
        </button>
      {/if}
      <a
        class="mw-github"
        href="https://github.com/Hello-QM/catgo-LRG"
        target="_blank"
        rel="noopener noreferrer"
        title="Star CatGo on GitHub"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.65 7.65 0 012-.27c.68 0 1.36.09 2 .27 1.53-1.03 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"/>
        </svg>
        <span class="mw-github-text">Star on GitHub</span>
        <svg class="mw-github-star" width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12 17.27l5.18 3.13-1.37-5.9 4.59-3.97-6.04-.52L12 4.5 9.64 10l-6.04.52 4.59 3.97-1.37 5.9z"/>
        </svg>
      </a>
    </div>
  {:else}
    <!-- Top bar: layout switch + actions -->
    <header class="mw-bar">
      <div class="mw-tabs">
        <button type="button" class:active={mode === `structure`} onclick={() => (mode = `structure`)} title={t(`mobile.tab_structure`)} aria-label={t(`mobile.tab_structure`)}><Icon icon="Atom" /></button>
        {#if !is_web}
          <button type="button" class:active={mode === `split-v`} onclick={() => (mode = `split-v`)} title={t(`mobile.tab_split_stacked`)} aria-label={t(`mobile.tab_split_stacked`)}><Icon icon="Layers" /></button>
          <button type="button" class:active={mode === `split-h`} onclick={() => (mode = `split-h`)} title={t(`mobile.tab_split_side`)} aria-label={t(`mobile.tab_split_side`)}><Icon icon="TwoColumns" /></button>
          <button type="button" class:active={mode === `terminal`} onclick={() => (mode = `terminal`)} title={t(`mobile.tab_terminal`)} aria-label={t(`mobile.tab_terminal`)}><Icon icon="Terminal" /></button>
        {/if}
      </div>
      <div class="mw-actions">
        <div class="mw-actions-scroll">
        <LocaleSwitch compact />
        <button type="button" class="mw-act ai" onclick={() => (ai_open = true)} title={t(`mobile.action_ai`)} aria-label={t(`mobile.action_ai`)}>
          <Icon icon="Chat" />
          <span class="mw-act-label">{t(`mobile.action_ai_short`)}</span>
        </button>
        {#if has_structure && editor_api}
          <button type="button" class="mw-act" onclick={() => editor_api?.undo()} disabled={!editor_api.can_undo()} title={t(`common.undo`)} aria-label={t(`common.undo`)}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M3 10h13a4 4 0 010 8H7" />
              <path d="M3 10l4-4M3 10l4 4" />
            </svg>
            <span class="mw-act-label">{t(`common.undo`)}</span>
          </button>
          <button type="button" class="mw-act" onclick={() => editor_api?.redo()} disabled={!editor_api.can_redo()} title={t(`common.redo`)} aria-label={t(`common.redo`)}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M21 10H8a4 4 0 000 8h9" />
              <path d="M21 10l-4-4M21 10l-4 4" />
            </svg>
            <span class="mw-act-label">{t(`common.redo`)}</span>
          </button>
        {/if}
        {#if session_id}
          <button type="button" class="mw-act" onclick={() => (files_open = true)} title={t(`mobile.action_remote_files`)}>
            <Icon icon="Directory" />
            <span class="mw-act-label">{t(`mobile.action_remote_files_short`)}</span>
          </button>
        {/if}
        <button type="button" class="mw-act" onclick={open_local} title={t(`mobile.action_open_local`)}>
          <Icon icon="Upload" />
          <span class="mw-act-label">{t(`mobile.action_open_local_short`)}</span>
        </button>
        <button type="button" class="mw-act" onclick={() => (db_visible = true)} title={t(`mobile.action_import_database`)}>
          <Icon icon="Database" />
          <span class="mw-act-label">{t(`mobile.action_import_database_short`)}</span>
        </button>
        </div>
        {#if can_save}
          <button type="button" class="mw-act save" onclick={save} title={t(`mobile.action_save_structure`)}>
            <Icon icon="Download" />
            <span class="mw-act-label">{t(`mobile.action_save_structure_short`)}</span>
          </button>
        {/if}
        {#if session_id}
          <button type="button" class="mw-act disconnect" onclick={disconnect} title={t(`mobile.action_disconnect`)}>
            <Icon icon="Close" />
            <span class="mw-act-label">{t(`mobile.action_disconnect_short`)}</span>
          </button>
        {/if}
      </div>
    </header>

    {#if save_msg}
      <div class="mw-msg">
        <span>{save_msg}</span>
        <button type="button" class="mw-msg-x" aria-label={t(`common.dismiss`)} onclick={() => (save_msg = ``)}>✕</button>
      </div>
    {/if}

    <!-- Both panes stay MOUNTED across layout switches (hidden, not removed), so
         the terminal keeps its live PTY + working directory when you pop into the
         structure view and back. -->
    <div class="mw-body" class:split-h={mode === `split-h`} class:split-v={mode === `split-v`}>
      <div class="mw-pane mw-struct" class:hidden={!show_structure}>
        {#if trajectory}
          <Trajectory
            bind:trajectory
            fullscreen_toggle={false}
            structure_props={{
              show_controls: true,
              fullscreen_toggle: false,
              allow_file_drop: false,
              hidden_toolbar_items: HIDDEN_TOOLBAR,
            }}
          />
        {:else if bio_raw_content && bio_viewer && !structure}
          <div class="mw-bio-wrap">
            <div class="mw-bio-toolbar">
              <BioViewerToggle is_molstar={true} on_toggle={toggle_mobile_viewer} />
              <span class="mw-bio-name">{local_filename}</span>
            </div>
            <div class="mw-bio-fill">
              {#key bio_raw_content}
                <MolstarViewer content={bio_raw_content} format={bio_format} label={local_filename} />
              {/key}
            </div>
          </div>
        {:else if has_structure}
          <Structure
            bind:structure
            bind:saveable_structure
            bind:editor_api
            show_controls={true}
            fullscreen_toggle={false}
            allow_file_drop={false}
            persist_settings={false}
            hidden_toolbar_items={HIDDEN_TOOLBAR}
            on_open_in_molstar={toggle_mobile_viewer}
            tab_id="mobile"
            is_active={true}
          />
          <!-- tab_id enables the global current-structure store adoption in
               Structure.svelte, so CatBot's client-direct tool edits
               (make_supercell, generate_slab, …) appear in this viewer.
               The MCP bridge that tab_id would normally also start is
               skipped on mobile inside Structure.svelte (no backend). -->
        {:else}
          <div class="mw-empty">
            <p>{t(`mobile.no_structure_loaded`)}</p>
            <button type="button" class="mw-open-btn" onclick={open_local}>{t(`mobile.open_local_file`)}</button>
            {#if session_id}
              <button type="button" class="mw-open-btn" onclick={() => (files_open = true)}>{t(`mobile.open_from_cluster`)}</button>
            {/if}
          </div>
        {/if}
      </div>

      <div class="mw-pane mw-term" class:hidden={!show_terminal}>
        {#if session_id}
          <div class="mw-termwrap">
            <!-- Terminals panel: horizontal strip on phone, vertical sidebar on
                 iPad (CSS breakpoint). Tap = switch; long-press or edit-mode ✕ =
                 close; + = new (capped at MAX_TABS). -->
            <div class="mw-tabbar" role="tablist" aria-label={t(`mobile.term_panel`)}>
              {#each term_tabs.tabs as tab (tab.id)}
                <div class="mw-tabchip" class:active={tab.id === term_tabs.active_id}>
                  <button
                    type="button"
                    class="mw-tabchip-btn"
                    role="tab"
                    aria-selected={tab.id === term_tabs.active_id}
                    onclick={() => tab_click(tab.id)}
                    onpointerdown={() => tab_pointerdown(tab.id)}
                    onpointerup={tab_pointerup}
                    onpointercancel={tab_pointerup}
                    oncontextmenu={(e) => e.preventDefault()}
                  >
                    <Icon icon="Terminal" />
                    <span class="mw-tabchip-label"
                      >{multi_cluster_tabs ? `${tab.cluster} · ` : ``}{path_basename(tab.cwd) ||
                        t(`mobile.term_label`, { n: tab.seq })}</span
                    >
                  </button>
                  {#if term_tabs.edit_mode && term_tabs.tabs.length > 1}
                    <button
                      type="button"
                      class="mw-tabchip-x"
                      aria-label={t(`mobile.term_close`)}
                      onclick={() => remove_tab(tab.id)}
                    ><Icon icon="Close" /></button>
                  {/if}
                </div>
              {/each}
              {#if term_tabs.tabs.length < MAX_TABS}
                <button
                  type="button"
                  class="mw-tab-add"
                  title={t(`mobile.term_new`)}
                  aria-label={t(`mobile.term_new`)}
                  onclick={() => (add_sheet_visible = true)}
                ><Icon icon="Plus" /></button>
              {/if}
              {#if term_tabs.tabs.length > 1}
                <button
                  type="button"
                  class="mw-tab-edit"
                  class:active={term_tabs.edit_mode}
                  title={t(`mobile.term_edit`)}
                  aria-label={t(`mobile.term_edit`)}
                  onclick={toggle_edit_mode}
                ><Icon icon="Pencil" /></button>
              {/if}
            </div>

            <!-- All terminals stay mounted; inactive ones are kept warm
                 (visibility:hidden, full size) so their PTY + grid survive. -->
            <div class="mw-termstack">
              {#each term_tabs.tabs as tab (tab.id)}
                <div class="mw-termtab" class:inactive={tab.id !== term_tabs.active_id}>
                  <MobileTerminal
                    bind:this={term_refs[tab.id]}
                    session_id={tab.session_id}
                    on_cwd={(p) => set_tab_cwd(tab.id, p)}
                  />
                </div>
              {/each}
            </div>

            {#if add_sheet_visible}
              <!-- "+" chooser: a shell on a connected cluster, or a new cluster. -->
              <div
                class="mw-addsheet-backdrop"
                role="presentation"
                onclick={() => (add_sheet_visible = false)}
              >
                <div
                  class="mw-addsheet"
                  role="dialog"
                  aria-label={t(`mobile.term_new`)}
                  onclick={(e) => e.stopPropagation()}
                >
                  <div class="mw-addsheet-title">{t(`mobile.term_add_where`)}</div>
                  {#each clusters.list as c (c.key)}
                    <button type="button" class="mw-addsheet-opt" onclick={() => add_tab_on(c.session_id, c.label)}>
                      <Icon icon="Terminal" />
                      <span>{c.label}</span>
                      {#if c.key === clusters.active_key}
                        <span class="mw-addsheet-cur">{t(`mobile.connected_current`)}</span>
                      {/if}
                    </button>
                  {/each}
                  <button type="button" class="mw-addsheet-opt new" onclick={add_new_cluster}>
                    <Icon icon="Plus" />
                    <span>{t(`mobile.term_add_new_cluster`)}</span>
                  </button>
                </div>
              </div>
            {/if}
          </div>
        {:else}
          <div class="mw-connect">
            <MobileConnect {on_connected} on_eject={eject_cluster} />
          </div>
        {/if}
      </div>
    </div>
  {/if}

  {#if files_open && session_id}
    <div class="mw-files-overlay">
      <header class="mw-files-head">
        <span>{t(`mobile.remote_files_title`)}</span>
        <button type="button" onclick={() => (files_open = false)}>✕</button>
      </header>
      <div class="mw-files-body">
        <MobileFiles {session_id} follow_path={term_cwd} on_open_structure={open_remote_structure} />
      </div>
    </div>
  {/if}

  {#if ai_open}
    <MobileChat {structure} on_close={() => (ai_open = false)} />
  {/if}

  {#if ks_visible && session_id}
    <KeySetup
      {session_id}
      host={ks_host}
      port={ks_port}
      username={ks_user}
      on_done={() => (ks_visible = false)}
    />
  {/if}

  {#if sheet_tab}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="mw-sheet-backdrop" role="presentation" onclick={() => (sheet_tab = null)}>
      <div
        class="mw-sheet"
        role="dialog"
        aria-modal="true"
        tabindex="-1"
        onclick={(e) => e.stopPropagation()}
      >
        <button type="button" class="mw-sheet-btn danger" onclick={sheet_close}>
          {t(`mobile.term_close`)}
        </button>
        <button type="button" class="mw-sheet-btn" onclick={() => (sheet_tab = null)}>
          {t(`common.cancel`)}
        </button>
      </div>
    </div>
  {/if}
</div>

{#if db_visible}
  <OptimadeSearchModal
    visible={db_visible}
    onclose={() => (db_visible = false)}
    onimport={on_db_import}
  />
{/if}

<style>
  .mw-root {
    position: relative;
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    min-height: 0;
    background: var(--page-bg, #0e1117);
  }

  /* Entry chooser */
  .mw-choose {
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 14px;
    padding: 24px;
  }
  .mw-choose-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .mw-choose-brand {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .mw-choose-logo {
    width: 40px;
    height: 40px;
    border-radius: 9px;
    flex: none;
  }
  .mw-choose-title {
    font-size: 1.8em;
    font-weight: 700;
    color: var(--text-color, #e0e0e0);
  }
  .mw-github {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    width: 100%;
    margin-top: 6px;
    padding: 9px 14px;
    border-radius: 9px;
    border: 1px solid var(--border-color, #2c3340);
    background: var(--surface-color, #1b212b);
    color: var(--text-color-muted, #94a3b8);
    font-family: inherit;
    font-size: 0.9em;
    font-weight: 600;
    text-decoration: none;
    cursor: pointer;
    box-sizing: border-box;
  }
  .mw-github:hover {
    color: var(--text-color, #e0e0e0);
  }
  .mw-github-star {
    color: #f1c40f;
  }
  .mw-choose-sub {
    font-size: 0.95em;
    color: var(--text-color-muted, #94a3b8);
    margin-bottom: 8px;
  }
  .mw-choice {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 18px;
    text-align: left;
    background: var(--surface-bg, #1a1a2e);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 12px;
    cursor: pointer;
  }
  .mw-choice:active {
    border-color: var(--accent-color, #3b82f6);
  }
  /* Mobile web: terminal entry shown but inert — the browser can't do SSH. */
  .mw-choice-disabled {
    cursor: default;
    opacity: 0.55;
  }
  .mw-choice-disabled:active {
    border-color: rgba(255, 255, 255, 0.12);
  }
  .mw-choice-icon {
    font-size: 22px;
  }
  .mw-choice-main {
    font-size: 1.05em;
    font-weight: 600;
    color: var(--text-color, #e0e0e0);
  }
  .mw-choice-desc {
    font-size: 0.85em;
    color: var(--text-color-muted, #94a3b8);
  }

  /* Top bar */
  .mw-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex-shrink: 0;
    padding: 6px 10px;
    background: rgba(0, 0, 0, 0.3);
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  }
  .mw-tabs,
  .mw-actions {
    display: flex;
    gap: 4px;
  }
  /* Tabs stay put; the action group may shrink and scroll horizontally so its
     buttons (up to 6 when connected) never hard-clip on a narrow screen — worst
     case they become swipeable instead of cut off. */
  .mw-tabs {
    flex-shrink: 0;
  }
  .mw-actions {
    gap: 2px;
    flex-shrink: 1;
    min-width: 0;
    align-items: center;
  }
  /* Inner scroller holds the SECONDARY actions (locale, AI, undo/redo, files,
     open, database). Save + Disconnect sit OUTSIDE it as direct .mw-actions
     children (flex-shrink:0), so on a narrow iPhone they stay pinned/visible on
     the right instead of scrolling off the edge. */
  .mw-actions-scroll {
    display: flex;
    gap: 2px;
    flex-shrink: 1;
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .mw-actions-scroll::-webkit-scrollbar {
    display: none;
  }
  .mw-tabs button,
  .mw-act {
    min-width: 40px;
    min-height: 40px;
    font-size: 17px;
    color: var(--text-color-muted, #94a3b8);
    background: transparent;
    border: 1px solid transparent;
    border-radius: 8px;
    cursor: pointer;
  }
  /* Action buttons: SVG icon stacked over a short text label. The icon sizes
     off the button's font-size (Icon.svelte uses width: 1em); the label sets
     its own smaller size. Both inherit `color`, so .save/.disconnect tints
     flow through to the SVG via fill="currentColor". */
  .mw-act {
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    padding: 2px 4px;
    line-height: 1;
    min-width: 34px;
    flex-shrink: 0; /* keep button size; the group scrolls instead of squashing */
  }
  .mw-act-label {
    font-size: 8px;
    font-weight: 600;
    letter-spacing: 0.02em;
  }
  .mw-tabs button.active {
    color: var(--accent-color, #3b82f6);
    border-color: var(--accent-color, #3b82f6);
  }
  .mw-act.ai {
    color: var(--accent-color, #3b82f6);
  }
  .mw-act.save {
    color: #4ade80;
  }
  .mw-act.disconnect {
    color: #ff6b6b;
  }
  .mw-msg {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-shrink: 0;
    padding: 6px 8px 6px 12px;
    font-size: 0.82em;
    color: var(--text-color-muted, #cbd5e1);
    background: rgba(59, 130, 246, 0.1);
  }
  .mw-msg span {
    flex: 1;
    min-width: 0;
  }
  .mw-msg-x {
    flex-shrink: 0;
    width: 28px;
    height: 28px;
    font-size: 13px;
    color: var(--text-color-muted, #94a3b8);
    background: transparent;
    border: none;
    border-radius: 6px;
    cursor: pointer;
  }

  /* Body / panes */
  .mw-body {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    position: relative; /* containing block for the kept-warm structure pane */
  }
  .mw-body.split-h {
    flex-direction: row;
  }
  .mw-body.split-v {
    flex-direction: column;
  }
  .mw-pane {
    flex: 1;
    min-width: 0;
    min-height: 0;
    position: relative;
    display: flex;
  }
  /* Kept mounted but hidden (preserves the terminal PTY/cwd across layouts). */
  .mw-pane.hidden {
    display: none;
  }
  /* The 3D viewer's <canvas> blanks if it ever hits display:none on iOS: while
     hidden it measures 0×0, and on return the size doesn't reliably restore, so
     the renderer can paint once at 0×0 and never recover (intermittent blank
     structure after visiting the terminal). Keep the structure pane laid out at
     full size — just visually hidden behind the active pane — so its canvas
     never zeroes. (Render-on-demand means no real battery cost while parked.) */
  .mw-pane.mw-struct.hidden {
    display: flex;
    visibility: hidden;
    pointer-events: none;
    position: absolute;
    inset: 0;
    z-index: -1;
  }
  /* Same keep-warm rationale for the terminal stack: xterm's grid measures
     wrong if the pane ever hits display:none, so park it laid-out + invisible. */
  .mw-pane.mw-term.hidden {
    display: flex;
    visibility: hidden;
    pointer-events: none;
    position: absolute;
    inset: 0;
    z-index: -1;
  }
  /* The editor's root (.structure-main) defaults to height:500px via
     --struct-height; override it so it fills the pane (no black gap / clipping
     in any layout). */
  .mw-struct {
    --struct-height: 100%;
    --struct-width: 100%;
    overflow: hidden;
    /* iOS: a touch-drag to rotate the 3D viewer otherwise triggers WKWebView's
       native text selection (it grabs the toolbar labels and "selects the whole
       thing"). Suppress selection + the callout on the whole structure pane —
       there's no user-selectable text here, only the canvas + tool buttons. */
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
  }
  .mw-struct :global(.structure-main) {
    height: 100%;
    width: 100%;
  }
  .mw-bio-wrap {
    position: relative;
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
  }
  .mw-bio-toolbar {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 5px 8px;
    border-bottom: 1px solid var(--border-color, #ddd);
    background: var(--panel-bg, rgba(0, 0, 0, 0.03));
  }
  .mw-bio-name {
    font-size: 0.78rem;
    color: var(--text-muted, #777);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mw-bio-fill {
    flex: 1 1 auto;
    min-height: 0;
    position: relative;
  }
  .mw-body.split-h .mw-struct,
  .mw-body.split-v .mw-struct {
    border-right: 1px solid rgba(255, 255, 255, 0.08);
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  }
  .mw-struct :global(> *),
  .mw-term :global(.mobile-terminal),
  .mw-connect {
    flex: 1;
    min-width: 0;
    width: 100%;
  }
  .mw-empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    color: var(--text-color-muted, #94a3b8);
  }
  .mw-open-btn {
    min-height: 44px;
    padding: 0 18px;
    font-size: 15px;
    color: #fff;
    background: var(--accent-color, #0a84ff);
    border: none;
    border-radius: 8px;
    cursor: pointer;
  }
  .mw-connect {
    display: flex;
  }

  /* ── Terminals panel (tabs) ─────────────────────────────────────────── */
  .mw-termwrap {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column; /* phone: strip on top, stack below */
    width: 100%;
  }
  .mw-tabbar {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
    padding: 4px 6px;
    overflow-x: auto;
    scrollbar-width: none;
    background: rgba(0, 0, 0, 0.25);
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  }
  .mw-tabbar::-webkit-scrollbar {
    display: none;
  }
  .mw-addsheet-backdrop {
    position: absolute;
    inset: 0;
    background: #0006;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    z-index: 30;
  }
  .mw-addsheet {
    width: 100%;
    max-width: 420px;
    background: var(--surface-bg, var(--page-bg, #fff));
    border-radius: 12px 12px 0 0;
    padding: 10px 12px calc(10px + env(safe-area-inset-bottom));
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .mw-addsheet-title {
    font-size: 13px;
    opacity: 0.7;
    padding: 4px 6px 8px;
  }
  .mw-addsheet-opt {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    background: none;
    border: 1px solid var(--border-color, #4443);
    border-radius: 8px;
    padding: 12px;
    font: inherit;
    color: inherit;
    text-align: left;
  }
  .mw-addsheet-opt.new {
    border-style: dashed;
  }
  .mw-addsheet-cur {
    margin-left: auto;
    font-size: 11px;
    opacity: 0.65;
  }
  .mw-tabchip {
    position: relative;
    display: flex;
    align-items: center;
    flex-shrink: 0;
  }
  .mw-tabchip-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 36px;
    max-width: 140px;
    padding: 0 12px;
    font-size: 13px;
    color: var(--text-color-muted, #94a3b8);
    background: transparent;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 8px;
    cursor: pointer;
    /* iOS: the long-press that opens the close sheet otherwise triggers
       WKWebView's native text selection / callout on the tab label. */
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
  }
  .mw-tabchip.active .mw-tabchip-btn {
    color: var(--accent-color, #3b82f6);
    border-color: var(--accent-color, #3b82f6);
    background: rgba(59, 130, 246, 0.1);
  }
  .mw-tabchip-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mw-tabchip-x {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    margin-left: -6px;
    font-size: 11px;
    color: #ff6b6b;
    background: var(--surface-bg, #1a1a2e);
    border: 1px solid rgba(255, 107, 107, 0.5);
    border-radius: 50%;
    cursor: pointer;
  }
  .mw-tab-add,
  .mw-tab-edit {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 36px;
    height: 36px;
    font-size: 15px;
    color: var(--text-color-muted, #94a3b8);
    background: transparent;
    border: 1px solid transparent;
    border-radius: 8px;
    cursor: pointer;
  }
  .mw-tab-edit.active {
    color: var(--accent-color, #3b82f6);
    border-color: var(--accent-color, #3b82f6);
  }
  /* Stack: all terminals laid out full-size; only the active one is visible. */
  .mw-termstack {
    position: relative;
    flex: 1;
    min-height: 0;
    min-width: 0;
  }
  .mw-termtab {
    position: absolute;
    inset: 0;
    display: flex;
  }
  /* Keep-warm: inactive tabs stay full-size but invisible (NEVER display:none —
     that would zero xterm's measured grid). */
  .mw-termtab.inactive {
    visibility: hidden;
    pointer-events: none;
    z-index: -1;
  }

  /* iPad / wide: vertical sidebar instead of a top strip. */
  @media (min-width: 768px) {
    .mw-termwrap {
      flex-direction: row;
    }
    .mw-tabbar {
      flex-direction: column;
      align-items: stretch;
      overflow-x: hidden;
      overflow-y: auto;
      width: 160px;
      flex-shrink: 0;
      border-bottom: none;
      border-right: 1px solid rgba(255, 255, 255, 0.08);
    }
    .mw-tabchip {
      width: 100%;
    }
    .mw-tabchip-btn {
      flex: 1;
      max-width: none;
    }
  }

  /* Long-press close action sheet */
  .mw-sheet-backdrop {
    position: absolute;
    inset: 0;
    z-index: 200;
    display: flex;
    align-items: flex-end;
    background: rgba(0, 0, 0, 0.45);
  }
  .mw-sheet {
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 100%;
    padding: 12px;
  }
  .mw-sheet-btn {
    min-height: 48px;
    font-size: 15px;
    color: var(--text-color, #e0e0e0);
    background: var(--surface-bg, #1a1a2e);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 10px;
    cursor: pointer;
    /* iOS: don't let a finger still held from the long-press select the
       "Delete"/"Cancel" label text when the sheet opens under it. */
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
  }
  .mw-sheet-btn.danger {
    color: #ff6b6b;
    border-color: rgba(255, 107, 107, 0.5);
  }

  /* Remote files overlay */
  .mw-files-overlay {
    position: absolute;
    inset: 0;
    z-index: 100;
    display: flex;
    flex-direction: column;
    background: var(--page-bg, #0e1117);
  }
  .mw-files-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-shrink: 0;
    padding: 10px 14px;
    font-weight: 600;
    color: var(--text-color, #e0e0e0);
    background: rgba(0, 0, 0, 0.3);
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  }
  .mw-files-head button {
    width: 36px;
    height: 36px;
    font-size: 16px;
    color: var(--text-color-muted, #94a3b8);
    background: transparent;
    border: none;
    cursor: pointer;
  }
  .mw-files-body {
    flex: 1;
    min-height: 0;
    display: flex;
  }
  .mw-files-body :global(.mobile-files) {
    flex: 1;
  }
</style>

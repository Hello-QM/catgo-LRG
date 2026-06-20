/**
 * Popout window management — extracted from App.svelte.
 *
 * Functions for opening structure/workflow/terminal in new windows,
 * with Tauri WebviewWindow support.
 */

import type { AnyStructure } from '$lib'
import type { StructureTabState } from '../pane-utils'
import { findLeafById, leaves, isTerminalLeaf, structurePane } from '../pane-tree'

/**
 * Open a FILE PATH in a new app window that loads/streams it there. Used for
 * large trajectories (e.g. multi-GB AIMD .xyz) that can't be serialized into a
 * structure popout — the new window re-streams the path via the backend.
 */
export async function open_path_in_new_window(path: string, filename: string, is_tauri: boolean) {
  const url = `${window.location.origin}${window.location.pathname}#openpath?path=${encodeURIComponent(path)}&name=${encodeURIComponent(filename)}`
  if (is_tauri) {
    try {
      const { WebviewWindow } = await import(`@tauri-apps/api/webviewWindow`)
      const win = new WebviewWindow(`openpath-${Date.now()}`, {
        title: filename || `CatGo`,
        url, width: 1000, height: 760, center: true, resizable: true, decorations: true,
      })
      win.once(`tauri://error`, () => {
        window.open(url, `_blank`, `width=1000,height=760,resizable=yes`)
      })
      return
    } catch {}
  }
  window.open(url, `_blank`, `width=1000,height=760,resizable=yes`)
}

/**
 * Open the AI chat in its own window. Tauri-aware: a bare `window.open` is
 * intercepted inside the Tauri WebView and never spawns an OS window, so we use
 * a `WebviewWindow` there (mirrors Structure.svelte's popout_chat).
 */
export async function open_chat_in_new_window(is_tauri: boolean, tab_id?: string) {
  const url = `${window.location.origin}${window.location.pathname}#chat${tab_id ? `?tab_id=${encodeURIComponent(tab_id)}` : ``}`
  if (is_tauri) {
    try {
      const { WebviewWindow } = await import(`@tauri-apps/api/webviewWindow`)
      const win = new WebviewWindow(`catgo-chat-${Date.now()}`, {
        title: `CatGo - Chat`,
        url, width: 520, height: 760, center: true, resizable: true, decorations: true,
      })
      win.once(`tauri://error`, () => {
        window.open(url, `_blank`, `width=520,height=760,resizable=yes`)
      })
      return
    } catch {}
  }
  window.open(url, `_blank`, `width=520,height=760,resizable=yes`)
}

/**
 * Open a structure in a new popout window via localStorage transfer.
 * `reuse=true` ("Window + Overwrite") targets a single stable window instead of
 * spawning a fresh one each time: in the browser `window.open` with a fixed name
 * reloads the same window; in Tauri we focus the existing labelled window.
 */
export async function open_structure_in_new_window(structure: AnyStructure, filename: string, is_tauri: boolean, reuse = false) {
  const stamp = reuse ? `reuse` : `${Date.now()}`
  const key = `catgo-popout-${stamp}`
  localStorage.setItem(key, JSON.stringify({ structure, filename }))
  const url = `${window.location.origin}${window.location.pathname}#structure?key=${encodeURIComponent(key)}`
  const label = `structure-${stamp}`
  const win_name = reuse ? label : `_blank`
  if (is_tauri) {
    try {
      const { WebviewWindow } = await import(`@tauri-apps/api/webviewWindow`)
      if (reuse) {
        const existing = await WebviewWindow.getByLabel(label)
        if (existing) {
          // Tell the live popout to reload the new payload, then focus it.
          try { await existing.emit(`catgo-reload-structure`, { key }) } catch {}
          try { await existing.setFocus() } catch {}
          return
        }
      }
      const win = new WebviewWindow(label, {
        title: filename || `CatGo - Structure`,
        url, width: 900, height: 700, center: true, resizable: true, decorations: true,
      })
      win.once(`tauri://error`, () => {
        window.open(url, win_name, `width=900,height=700,resizable=yes`)
      })
      return
    } catch {}
  }
  window.open(url, win_name, `width=900,height=700,resizable=yes`)
}

/** Parse content and open the structure in a new window. */
export async function parse_and_open_structure_window(content: string, filename: string, is_tauri: boolean, reuse = false) {
  try {
    const { is_trajectory_file, parse_trajectory_data } = await import(`$lib/trajectory/parse`)
    if (is_trajectory_file(filename, content)) {
      const traj = await parse_trajectory_data(content, filename)
      if (traj?.frames?.length) {
        await open_structure_in_new_window(traj.frames[0].structure as AnyStructure, filename, is_tauri, reuse)
        return
      }
    }
    const { parse_structure_file } = await import(`$lib/structure/parse`)
    const parsed = parse_structure_file(content, filename)
    if (parsed) {
      await open_structure_in_new_window(parsed as AnyStructure, filename, is_tauri, reuse)
    }
  } catch (e) {
    console.error(`Failed to parse structure for new window:`, e)
  }
}

/** Load structure data from localStorage (used by popout structure windows). */
export function load_popout_structure(
  hash: string,
  get_active_ts: () => StructureTabState | null,
  active_tab_id: string,
  update_tab_label: (tab_id: string) => void,
) {
  const qmark = hash.indexOf(`?`)
  if (qmark < 0) return
  const params = new URLSearchParams(hash.slice(qmark))
  const key = params.get(`key`)
  if (!key) return
  try {
    const raw = localStorage.getItem(key)
    localStorage.removeItem(key) // cleanup after reading
    if (!raw) return
    const { structure, filename } = JSON.parse(raw) as { structure: AnyStructure; filename: string }
    if (!structure) return
    // Ensure a structure tab exists and load the data
    const ts = get_active_ts()
    if (ts) {
      const leaf = findLeafById(ts.root, ts.active_leaf_id) ?? leaves(ts.root)[0]
      if (!leaf) return
      const pane = structurePane(leaf)
      if (!pane) return
      pane.structure = structure
      pane.source_filename = filename
      pane.modified = false
      update_tab_label(active_tab_id)
    }
  } catch (e) {
    console.error(`Failed to load popout structure:`, e)
  }
}

/** Open a split-view pane in a new window. */
export async function popout_pane(
  tab_id: string,
  leaf_id: string,
  tab_states: Record<string, StructureTabState>,
  is_tauri: boolean,
) {
  const ts = tab_states[tab_id]
  if (!ts) return
  const leaf = findLeafById(ts.root, leaf_id)
  if (!leaf) return
  const pane = structurePane(leaf)
  if (!pane) {
    if (isTerminalLeaf(leaf)) return // terminal popout handled by popout_terminal_leaf (Task 4)
    return
  }

  if (pane.mode === `workflow` && pane.workflow_id) {
    // Workflows have their own popout mechanism
    const url = `${window.location.origin}${window.location.pathname}#workflow`
    window.open(url, `_blank`, `width=1400,height=900,resizable=yes`)
    return
  }

  // Structure pane: open in new window via localStorage transfer
  const structure = pane.saveable_structure ?? pane.structure
  if (!structure) return
  await open_structure_in_new_window(structure as AnyStructure, pane.source_filename || ``, is_tauri)
}

/** Open the workflow tab in a new window. */
export async function popout_workflow(
  is_tauri: boolean,
  close_tab: (id: string) => void,
  switch_to_structure: () => void,
) {
  const url = `${window.location.origin}${window.location.pathname}#workflow`
  if (is_tauri) {
    try {
      const { WebviewWindow } = await import(`@tauri-apps/api/webviewWindow`)
      const wf_window = new WebviewWindow(`workflow-editor`, {
        title: `CatGo - Workflow Editor`,
        url, width: 1400, height: 900, center: true, resizable: true, decorations: true,
      })
      wf_window.once(`tauri://created`, () => { close_tab(`workflow`); switch_to_structure() })
      wf_window.once(`tauri://error`, (e) => {
        console.error(`Workflow window error:`, e)
        window.open(url, `workflow-editor`, `width=1400,height=900,resizable=yes`)
        close_tab(`workflow`); switch_to_structure()
      })
      return
    } catch (err) {
      console.error(`Tauri WebviewWindow failed:`, err)
    }
  }
  window.open(url, `workflow-editor`, `width=1400,height=900,resizable=yes`)
  close_tab(`workflow`); switch_to_structure()
}

/**
 * Open a terminal *leaf*'s session in a new bare-terminal window. Unlike
 * `popout_terminal` (which manages the top-level Terminal tab), this is a fire-and-
 * forget popout for a pane-tree terminal leaf: it just opens the `#terminal` window
 * with the session params. The caller removes the leaf from its source tree.
 */
export async function popout_terminal_session(
  is_tauri: boolean,
  terminal: { init_session_id?: string; init_host?: string; init_username?: string; init_sync_cwd: boolean },
) {
  const params = new URLSearchParams()
  if (terminal.init_session_id) params.set(`session_id`, terminal.init_session_id)
  if (terminal.init_host) params.set(`host`, terminal.init_host)
  if (terminal.init_username) params.set(`username`, terminal.init_username)
  if (terminal.init_sync_cwd) params.set(`sync_cwd`, `true`)
  const qs = params.toString()
  const url = `${window.location.origin}${window.location.pathname}#terminal${qs ? `?${qs}` : ``}`
  const win_id = `terminal-${Date.now()}`
  if (is_tauri) {
    try {
      const { WebviewWindow } = await import(`@tauri-apps/api/webviewWindow`)
      const term_window = new WebviewWindow(win_id, {
        title: terminal.init_host ? `${terminal.init_username || ``}@${terminal.init_host}` : `CatGo - Terminal`,
        url, width: 900, height: 600, center: true, resizable: true, decorations: true,
      })
      term_window.once(`tauri://error`, (e) => {
        console.error(`Terminal window error:`, e)
        window.open(url, win_id, `width=900,height=600,resizable=yes`)
      })
      return
    } catch (err) {
      console.error(`Tauri WebviewWindow failed:`, err)
    }
  }
  window.open(url, win_id, `width=900,height=600,resizable=yes`)
}

import type { DocRef } from '$lib/viewer/doc-viewer-state.svelte'
import { send_open_doc, on_docs_ready } from '$lib/viewer/doc-channel'

/** Pre-create the documents window hidden so the first file-open is instant.
 * Idempotent: no-op if it already exists. Main-window only (callers must guard). */
export async function prewarm_doc_window(is_tauri: boolean) {
  if (!is_tauri) return
  try {
    const { WebviewWindow } = await import(`@tauri-apps/api/webviewWindow`)
    const existing = await WebviewWindow.getByLabel(`catgo-docs`)
    if (existing) return
    const url = `${window.location.origin}${window.location.pathname}#docs`
    const win = new WebviewWindow(`catgo-docs`, {
      title: `CatGo - Documents`,
      url, width: 1000, height: 760, center: true, resizable: true, decorations: true,
      visible: false,
    })
    win.once(`tauri://error`, () => {})
  } catch {}
}

/**
 * Open (or focus) the single document-viewer window and deliver a file ref.
 * Warm path: window exists → send immediately via event.
 * Cold path: window created → register a one-shot on_docs_ready listener that
 * sends the ref once the window signals it is mounted, then creates the window.
 * A 1500ms fallback re-send covers the edge case where the ready event is missed;
 * deduplication in open_doc makes double-delivery harmless.
 */
export async function open_doc_window(ref: DocRef, is_tauri: boolean) {
  const url = `${window.location.origin}${window.location.pathname}#docs`
  if (is_tauri) {
    try {
      const { WebviewWindow } = await import(`@tauri-apps/api/webviewWindow`)
      const existing = await WebviewWindow.getByLabel(`catgo-docs`)
      if (existing) {
        await send_open_doc(ref, true)
        try { await existing.show() } catch {}
        try { await existing.unminimize() } catch {}
        try { await existing.setFocus() } catch {}
        return
      }
      // Cold open: listen for the ready handshake, then create the window.
      let off = on_docs_ready(() => {
        off()
        void send_open_doc(ref, true)
      }, true)
      const win = new WebviewWindow(`catgo-docs`, {
        title: `CatGo - Documents`,
        url, width: 1000, height: 760, center: true, resizable: true, decorations: true,
      })
      win.once(`tauri://error`, () => { window.open(url, `catgo-docs`, `width=1000,height=760,resizable=yes`) })
      // Fallback: re-send after 1500ms in case the ready event was missed.
      setTimeout(() => { void send_open_doc(ref, true) }, 1500)
      return
    } catch {}
  }
  // Web: open/reuse the named window and deliver via ready handshake + immediate post.
  let off = on_docs_ready(() => {
    off()
    void send_open_doc(ref, false)
  }, false)
  const w = window.open(url, `catgo-docs`, `width=1000,height=760,resizable=yes`)
  // Warm case: window was already open and won't re-emit ready; send directly too.
  await send_open_doc(ref, false)
  setTimeout(() => { void send_open_doc(ref, false) }, 1500)
  try { w?.focus() } catch {}
}

/** Open the terminal tab in a new window. */
export async function popout_terminal(
  is_tauri: boolean,
  terminal: { init_session_id?: string; init_host?: string; init_username?: string; init_sync_cwd: boolean },
  close_tab: (id: string) => void,
  switch_to_structure: () => void,
) {
  const params = new URLSearchParams()
  if (terminal.init_session_id) params.set(`session_id`, terminal.init_session_id)
  if (terminal.init_host) params.set(`host`, terminal.init_host)
  if (terminal.init_username) params.set(`username`, terminal.init_username)
  if (terminal.init_sync_cwd) params.set(`sync_cwd`, `true`)
  const qs = params.toString()
  const url = `${window.location.origin}${window.location.pathname}#terminal${qs ? `?${qs}` : ``}`
  const win_id = `terminal-${Date.now()}`
  const is_already_popout = window.location.hash.startsWith(`#terminal`)
  if (is_tauri) {
    try {
      const { WebviewWindow } = await import(`@tauri-apps/api/webviewWindow`)
      const term_window = new WebviewWindow(win_id, {
        title: terminal.init_host ? `${terminal.init_username || ``}@${terminal.init_host}` : `CatGo - Terminal`,
        url, width: 900, height: 600, center: true, resizable: true, decorations: true,
      })
      if (!is_already_popout) {
        term_window.once(`tauri://created`, () => { close_tab(`terminal`); switch_to_structure() })
        term_window.once(`tauri://error`, (e) => {
          console.error(`Terminal window error:`, e)
          window.open(url, win_id, `width=900,height=600,resizable=yes`)
          close_tab(`terminal`); switch_to_structure()
        })
      }
      return
    } catch (err) {
      console.error(`Tauri WebviewWindow failed:`, err)
    }
  }
  window.open(url, win_id, `width=900,height=600,resizable=yes`)
  // Only close the terminal tab in the main window, not in popped-out windows
  if (!is_already_popout) {
    close_tab(`terminal`); switch_to_structure()
  }
}

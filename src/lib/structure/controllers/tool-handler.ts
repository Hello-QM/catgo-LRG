/**
 * MCP polling bridge — keeps the frontend viewer in sync with the catgo
 * MCP server's view-state endpoints. Three async loops:
 *   - poll_screenshot     (every 2s)  upload canvas snapshot when requested
 *   - push_structure_info (every 5s)  publish current structure / selection
 *   - poll_structure_updates (500ms) consume backend-pushed structure updates
 *
 * Used by SDK agents (claude / codex / gemini) which call catgo MCP tools
 * server-side; the bridge round-trips view state through the daemon.
 */

import type { AnyStructure } from '$lib'
import type { PymatgenStructure } from '$lib/structure'
import { API_BASE, STATIC_ONLY } from '$lib/api/config'
import { get_workflow_slice } from '$lib/workflow/workflow-state.svelte'

// ─── MCP polling bridge ───

export interface McpBridgeDeps {
  panel_id: string
  get_structure: () => AnyStructure | undefined
  set_structure: (s: AnyStructure) => void
  inc_center_camera: () => void
  align_view_to_lattice?: () => void
  get_selected_sites: () => number[]
  get_wrapper: () => HTMLElement | undefined
}

/** Start MCP polling loops. Returns a cleanup function to stop all loops. */
export function start_mcp_bridge(deps: McpBridgeDeps): () => void {
  let stopped = false
  // Per-bridge-instance dedup for backend-pushed workflow navigations —
  // scoped inside this function so each tab's Structure instance has its
  // own counter (Phase 2 made tab_id = panel_id = unique per Structure).
  // See `handle_pending_update` below for the full rationale — TL;DR: if
  // the backend pushes the same id to `/view/workflow/pending-navigate` N
  // times (because CatBot chained N mutation tools), we only want to
  // dispatch to the UI once. Resets whenever the target id actually
  // changes.
  let last_dispatched_workflow_id = ''

  async function poll_screenshot() {
    while (!stopped) {
      try {
        const resp = await fetch(`${API_BASE}/view/screenshot/pending?panel_id=${deps.panel_id}`)
        if (resp.ok) {
          const data = await resp.json()
          const pending_list = data.pending as { request_id: string }[]
          if (pending_list?.length > 0) {
            const canvas_el = deps.get_wrapper()?.querySelector(`canvas`) as HTMLCanvasElement | null
            if (canvas_el) {
              const data_url = canvas_el.toDataURL(`image/png`)
              for (const item of pending_list) {
                await fetch(`${API_BASE}/view/screenshot/upload?panel_id=${deps.panel_id}`, {
                  method: `POST`,
                  headers: { 'Content-Type': `application/json` },
                  body: JSON.stringify({
                    request_id: item.request_id,
                    image: data_url,
                    width: canvas_el.width,
                    height: canvas_el.height,
                  }),
                })
              }
            }
          }
        }
      } catch (err) {
        console.debug(`[CatGo] poll_screenshot error:`, err)
      }
      await new Promise((r) => setTimeout(r, 2000))
    }
  }

  async function push_structure_info() {
    while (!stopped) {
      try {
        const structure = deps.get_structure()
        if (structure) {
          const elems: Record<string, number> = {}
          for (const s of structure.sites) {
            const el = s.species[0]?.element ?? `?`
            elems[el] = (elems[el] ?? 0) + 1
          }
          const periodic = `lattice` in structure && !!structure.lattice
          const info: Record<string, unknown> = {
            n_atoms: structure.sites.length,
            composition: elems,
            periodic,
          }
          if (periodic) {
            const lat = (structure as PymatgenStructure).lattice
            info.lattice = { a: lat.a, b: lat.b, c: lat.c, alpha: lat.alpha, beta: lat.beta, gamma: lat.gamma, volume: lat.volume }
          }
          await fetch(`${API_BASE}/view/structure-info/update?panel_id=${deps.panel_id}`, {
            method: `POST`,
            headers: { 'Content-Type': `application/json` },
            body: JSON.stringify(info),
          })
          await fetch(`${API_BASE}/view/structure/push?panel_id=${deps.panel_id}`, {
            method: `POST`,
            headers: { 'Content-Type': `application/json` },
            body: JSON.stringify({ structure }),
          })
          await fetch(`${API_BASE}/view/selection/update?panel_id=${deps.panel_id}`, {
            method: `POST`,
            headers: { 'Content-Type': `application/json` },
            body: JSON.stringify({ indices: deps.get_selected_sites() }),
          })
        }
      } catch (err) {
        console.debug(`[CatGo] push_structure_info error:`, err)
      }
      await new Promise((r) => setTimeout(r, 5000))
    }
  }

  // Shared handler for consuming pending structure updates from backend.
  // Used by both the polling loop and the visibility-restore one-shot.
  async function handle_pending_update() {
    const resp = await fetch(`${API_BASE}/view/structure/pending-update?panel_id=${deps.panel_id}`)
    if (!resp.ok) {
      console.warn(`[CatGo] poll pending-update failed: ${resp.status}`)
      return
    }
    const data = await resp.json()
    if (data.pending && data.structure) {
      console.info(`[CatGo] Received pending structure update (${data.structure.sites?.length ?? `?`} sites)`)
      deps.set_structure(data.structure)
      // Recenter camera on the new structure's geometric center
      deps.inc_center_camera()
      // Auto-align camera for slabs (pbc=[true,true,false]) so surface faces the viewer
      const pbc = data.structure.lattice?.pbc
      if (pbc && pbc[0] && pbc[1] && !pbc[2] && deps.align_view_to_lattice) {
        setTimeout(() => deps.align_view_to_lattice?.(), 100)
      }
    }
    if (data.workflow_id) {
      // ─── Dedup: MCP tool chain can push the same workflow_id many times ───
      //
      // Each CatBot mutation tool (create / add_node / batch / connect /
      // set_params / remove_node) calls `_push_workflow_navigate(wf_id)` on
      // the backend. Across a single Claude turn the same id lands in the
      // pending-navigate slot 5+ times. Our 500ms poll consumes one push at
      // a time but historically wrote `pending_navigate_workflow.id = X`
      // unconditionally — Svelte 5 `$state` setters don't compare, so every
      // write re-fired App.svelte's $effect, which in turn ran through
      //   handle_sidebar_open_workflow → workflow_reload_seq++
      //     → WorkflowEditor reload_from_server() (30-node graph re-parse)
      //       → nodes/edges deep-$state rebuild
      //         → workflow_json / orphan_set / mm_bounds / sync_workflow_state
      //           → active_workflow update → ChatPane workflow_context rebuild
      //             → broadcast_chat_context postMessage
      // stacked per poll cycle. 3-6 cycles = WebKitGTK renderer pegged at
      // ~100% CPU / white screen.
      //
      // Fix: remember the last id we actually dispatched. If the backend
      // keeps coughing up the same id after we've already processed it, do
      // nothing — the WorkflowEditor that is (or soon will be) mounted for
      // that id is the authoritative owner; it saves and reloads itself
      // when the user edits or when save_handle triggers.
      //
      // This guard is module-scoped so it survives across poll iterations
      // but is reset whenever the dispatched id actually changes.
      if (last_dispatched_workflow_id === data.workflow_id) {
        // Already handled this id end-to-end; backend is just re-announcing
        // the same navigation after another MCP tool call. Skip.
      } else {
        console.info(`[CatGo] Navigating to workflow: ${data.workflow_id} (panel=${deps.panel_id})`)
        last_dispatched_workflow_id = data.workflow_id
        // Phase 2: route the pending-navigate signal into the slice for
        // THIS tab (the one the MCP bridge polls for) rather than a global
        // singleton. App.svelte watches every slice and picks up the write.
        get_workflow_slice(deps.panel_id).pending_navigate_workflow.id = data.workflow_id
      }
    }
  }

  async function poll_structure_updates() {
    while (!stopped) {
      try {
        await handle_pending_update()
      } catch (err) {
        console.warn(`[CatGo] poll pending-update error:`, err)
      }
      await new Promise((r) => setTimeout(r, 500))
    }
  }

  // Skip all backend polling in static-only mode (no backend to poll)
  if (!STATIC_ONLY) {
    // Clear stale backend state from previous session (backend may outlive browser tab)
    fetch(`${API_BASE}/view/reset?panel_id=${deps.panel_id}`, { method: `POST` })
      .then(r => { if (!r.ok) console.warn(`[CatGo] view/reset returned ${r.status}`) })
      .catch(err => console.debug(`[CatGo] view/reset not reachable:`, err.message))

    poll_screenshot()
    push_structure_info()
    poll_structure_updates()
  }

  // When tab becomes visible again, immediately check for missed updates
  function on_visibility_change() {
    if (!document.hidden && !stopped && !STATIC_ONLY) {
      handle_pending_update().catch(err =>
        console.warn(`[CatGo] visibility restore pending-update error:`, err)
      )
    }
  }
  document.addEventListener(`visibilitychange`, on_visibility_change)

  return () => {
    stopped = true
    document.removeEventListener(`visibilitychange`, on_visibility_change)
  }
}

/**
 * MCP bridge — keeps the frontend viewer in sync with the catgo
 * MCP server's view-state endpoints.
 *
 *   - poll_screenshot   (every 2s)        upload canvas snapshot when requested
 *   - push_loop         (50ms / 5s heartbeat) publish state — instant on
 *                                          edit (via request_push), heartbeat fallback
 *   - sse_subscription  (real-time)       consume backend-pushed structure / workflow events
 *
 * The structure/workflow ingress used to be a 500ms polling loop hitting
 * /view/structure/pending-update. Now it's an SSE subscription on
 * /view/subscribe — events arrive within ~10ms of the backend write
 * instead of up to 500ms. EventSource has built-in auto-reconnect so
 * we drop the visibility-change handler too.
 *
 * Used by SDK agents (claude / codex / gemini) which call catgo MCP tools
 * server-side; the bridge round-trips view state through the daemon.
 */

import type { AnyStructure } from '$lib'
import type { PymatgenStructure } from '$lib/structure'
import { API_BASE, STATIC_ONLY } from '$lib/api/config'
import { get_workflow_slice } from '$lib/workflow/workflow-state.svelte'

// ─── MCP bridge ───

export interface McpBridgeDeps {
  panel_id: string
  get_structure: () => AnyStructure | undefined
  set_structure: (s: AnyStructure) => void
  inc_center_camera: () => void
  align_view_to_lattice?: () => void
  get_selected_sites: () => number[]
  get_wrapper: () => HTMLElement | undefined
}

/** Start MCP bridge loops + SSE subscription.
 *
 * Returns `{ cleanup, request_push }`:
 *   - `cleanup()` stops all loops and closes SSE
 *   - `request_push()` schedules an immediate state push (throttled to
 *     ≥50ms since last push). Use it from a $effect that watches the
 *     structure to give lab claude near-instant visibility into local
 *     edits, instead of waiting up to 5s for the heartbeat tick.
 */
export function start_mcp_bridge(deps: McpBridgeDeps): {
  cleanup: () => void
  request_push: () => void
} {
  let stopped = false
  // Per-bridge-instance dedup for backend-pushed workflow navigations —
  // scoped inside this function so each tab's Structure instance has its
  // own counter (Phase 2 made tab_id = panel_id = unique per Structure).
  // See `apply_workflow_event` below for the full rationale — TL;DR: if
  // the backend pushes the same id N times (because CatBot chained N
  // mutation tools), we only want to dispatch to the UI once. Resets
  // whenever the target id actually changes.
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

  // Push throttle / heartbeat state. Edits trigger request_push() (sets
  // dirty flag); the loop ticks every 50ms and pushes if either the flag
  // is set OR the 5s heartbeat is due, subject to a min-interval throttle
  // so a 60fps drag doesn't fire 60 POSTs per second.
  let push_dirty = false
  let last_push_at = 0
  const MIN_PUSH_INTERVAL = 50
  const HEARTBEAT_INTERVAL = 5000

  async function do_push_now() {
    const structure = deps.get_structure()
    if (!structure) return
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

  async function push_loop() {
    while (!stopped) {
      const now = Date.now()
      const elapsed = now - last_push_at
      const heartbeat_due = elapsed >= HEARTBEAT_INTERVAL
      if ((push_dirty || heartbeat_due) && elapsed >= MIN_PUSH_INTERVAL) {
        try {
          await do_push_now()
        } catch (err) {
          console.debug(`[CatGo] push error:`, err)
        }
        push_dirty = false
        last_push_at = Date.now()
      }
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  function request_push() {
    push_dirty = true
  }

  function apply_structure_event(structure: AnyStructure) {
    if (!structure) return
    console.info(`[CatGo] SSE structure event (${structure.sites?.length ?? `?`} sites)`)
    deps.set_structure(structure)
    // Recenter camera on the new structure's geometric center
    deps.inc_center_camera()
    // Auto-align camera for slabs (pbc=[true,true,false]) so surface faces the viewer
    const pbc = (structure as PymatgenStructure).lattice?.pbc
    if (pbc && pbc[0] && pbc[1] && !pbc[2] && deps.align_view_to_lattice) {
      setTimeout(() => deps.align_view_to_lattice?.(), 100)
    }
  }

  function apply_workflow_event(workflow_id: string) {
    if (!workflow_id) return
    // ─── Two-layer dedup: navigation vs. content refresh ───
    //
    // The backend calls `_push_workflow_navigate(wf_id)` on every mutation
    // (create / add_node / batch / connect / set_params / remove_node), so
    // the same id arrives N times per CatBot turn. The two jobs dedup
    // differently:
    //
    //   - Navigation (mount the editor for this id) IS deduped — pointless
    //     to re-mount the same workflow.
    //   - Content refresh is NOT deduped by id — the content under the
    //     same id is exactly what changes between events. Without nudging
    //     reload_seq, post-create mutations (e.g. a 37-node `batch` after
    //     `create`) never reach the canvas. The editor's effect on
    //     workflow_reload_seq has a 250ms trailing-edge debounce, so
    //     storm-bumping is cheap.
    const slice = get_workflow_slice(deps.panel_id)
    if (last_dispatched_workflow_id === workflow_id) {
      slice.workflow_reload_seq.seq++
      return
    }
    console.info(`[CatGo] SSE workflow event: ${workflow_id} (panel=${deps.panel_id})`)
    last_dispatched_workflow_id = workflow_id
    // Phase 2: route the pending-navigate signal into the slice for
    // THIS tab (the one the MCP bridge subscribes for) rather than a
    // global singleton. App.svelte watches every slice and picks up the write.
    slice.pending_navigate_workflow.id = workflow_id
  }

  function start_sse_subscription(): () => void {
    const url = `${API_BASE}/view/subscribe?panel_id=${encodeURIComponent(deps.panel_id)}`
    const es = new EventSource(url)

    const on_struct_payload = (ev: Event) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data)
        if (data.structure) apply_structure_event(data.structure)
      } catch (err) {
        console.warn(`[CatGo] SSE structure parse error:`, err)
      }
    }
    // `structure` = real push, `snapshot` = replay on (re)connect. Per-pane
    // subscribers want to apply both; global listeners (App.svelte) only
    // subscribe to `structure` so reconnect replays don't re-toast.
    es.addEventListener(`structure`, on_struct_payload)
    es.addEventListener(`snapshot`, on_struct_payload)

    es.addEventListener(`workflow`, (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data)
        if (data.workflow_id) apply_workflow_event(data.workflow_id)
      } catch (err) {
        console.warn(`[CatGo] SSE workflow parse error:`, err)
      }
    })

    es.onerror = (err) => {
      // EventSource auto-reconnects on network errors; only log at debug
      // level since the browser handles this transparently. Repeated errors
      // here usually mean the backend died.
      console.debug(`[CatGo] SSE connection issue (auto-reconnecting):`, err)
    }

    return () => es.close()
  }

  let close_sse: (() => void) | null = null

  // Skip all backend interaction in static-only mode (no backend to talk to)
  if (!STATIC_ONLY) {
    // Clear stale backend state from previous session (backend may outlive browser tab)
    fetch(`${API_BASE}/view/reset?panel_id=${deps.panel_id}`, { method: `POST` })
      .then(r => { if (!r.ok) console.warn(`[CatGo] view/reset returned ${r.status}`) })
      .catch(err => console.debug(`[CatGo] view/reset not reachable:`, err.message))

    poll_screenshot()
    push_loop()
    close_sse = start_sse_subscription()
  }

  return {
    cleanup: () => {
      stopped = true
      close_sse?.()
      // Clear this panel's backend structure on unmount. The backend store can
      // outlive the tab; without this, a closed/replaced structure tab leaves a
      // stale structure that CatBot (bound to the same panel_id) later reads as
      // a phantom the user can't find in any open view.
      if (!STATIC_ONLY) {
        fetch(`${API_BASE}/view/reset?panel_id=${deps.panel_id}`, { method: `POST` })
          .catch(() => {})
      }
    },
    request_push,
  }
}

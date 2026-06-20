/**
 * Tab management reactive state — extracted from App.svelte.
 *
 * Uses factory function pattern because `$state` must be created
 * in component context.
 */

import type { AppTab } from '../TabBar.svelte'
import {
  type StructureTabState,
  pane_has_content, create_tab_state, create_terminal_tab_state,
} from '../pane-utils'
import { leaves, matchesPreset, isTerminalLeaf, structurePane, type PresetId, type TerminalLeafState } from '../pane-tree'
import {
  ensure_workflow_slice,
  remove_workflow_slice,
} from '$lib/workflow/workflow-state.svelte'
import {
  ensure_chat_slice,
  remove_chat_slice,
} from '$lib/chat/chat-state.svelte'
import { unregister_workflow_action_handler } from '$lib/chat/workflow-tool-executor'

export function create_tab_manager() {
  // Eagerly register slices for the initial tab so ChatPane / WorkflowEditor
  // reads inside $derived don't need to lazy-create entries (Svelte 5
  // forbids state mutations inside derivations — state_unsafe_mutation).
  ensure_chat_slice(`structure-1`)
  ensure_workflow_slice(`structure-1`)

  let tab_counter = $state(1)
  let tabs = $state<AppTab[]>([
    { id: `structure-1`, type: `structure`, label: `Structure`, closable: true }
  ])
  let active_tab_id = $state(`structure-1`)
  let active_tab = $derived(tabs.find(t => t.id === active_tab_id))
  let active_tab_type = $derived(active_tab?.type ?? `structure`)
  let tab_states_record = $state<Record<string, StructureTabState>>({
    'structure-1': create_tab_state(),
  })

  function get_active_ts(): StructureTabState | null {
    if (active_tab_type !== `structure` && active_tab_type !== `terminal`) return null
    return tab_states_record[active_tab_id] ?? null
  }

  let tabs_with_badges = $derived(tabs.map(t => {
    if (t.type !== `structure` && t.type !== `terminal`) return t
    const ts = tab_states_record[t.id]
    if (!ts) return t
    // Skip the badge on the currently-active tab — user already sees its
    // content; the count is just visual noise on the active tab.
    if (t.id === active_tab_id) return t
    const badge = leaves(ts.root).filter(l => {
      if (isTerminalLeaf(l)) return true
      const pane = structurePane(l)
      return !!pane && pane_has_content(pane)
    }).length
    return { ...t, badge: badge > 0 ? badge : undefined }
  }))

  let active_layout = $derived.by(() => {
    if (active_tab_type !== `structure` && active_tab_type !== `terminal`) return undefined
    const ts = tab_states_record[active_tab_id]
    if (!ts) return undefined
    return matchesPreset(ts.root)
  })

  let tab_close_confirm_id = $state<string | null>(null)
  let pending_layout_change = $state<{ tab_id: string, new_layout: PresetId, lost_count: number } | null>(null)

  function create_tab(type: `structure` | `workflow` | `terminal`) {
    if (type === `workflow`) {
      const existing = tabs.find(t => t.type === `workflow`)
      if (existing) {
        active_tab_id = existing.id
        return
      }
      // Pre-register slices so the editor's $derived reads work immediately
      // (see note in tab-manager init — state_unsafe_mutation guard).
      ensure_chat_slice(`workflow`)
      ensure_workflow_slice(`workflow`)
      tabs = [...tabs, { id: `workflow`, type: `workflow`, label: `Workflow`, closable: true }]
      active_tab_id = `workflow`
    } else if (type === `terminal`) {
      // A terminal tab is a normal StructureTabState whose root leaf is a
      // terminal (see create_terminal_tab_state) — PaneTree + the tab machinery
      // treat it like any other tab; only the leaf content differs.
      tab_counter++
      const id = `terminal-${tab_counter}`
      tab_states_record[id] = create_terminal_tab_state()
      // Same eager-slice rationale as the structure branch: the converged
      // PaneTree render mounts ChatPane/WorkflowEditor $derived reads.
      ensure_chat_slice(id)
      ensure_workflow_slice(id)
      tabs = [...tabs, { id, type: `terminal`, label: `Terminal`, closable: true }]
      active_tab_id = id
    } else {
      const struct_count = tabs.filter(t => t.type === `structure`).length
      if (struct_count >= 12) return
      tab_counter++
      const id = `structure-${tab_counter}`
      tab_states_record[id] = create_tab_state()
      // Eagerly register this tab's chat + workflow slices so ChatPane /
      // WorkflowEditor $derived reads don't have to lazy-create.
      ensure_chat_slice(id)
      ensure_workflow_slice(id)
      tabs = [...tabs, { id, type: `structure`, label: `Structure`, closable: true }]
      active_tab_id = id
    }
  }

  /** Open (or focus) the singleton `terminal` popout tab.
   *
   * Used by the `#terminal?session_id=…` popout-window hash route. The tab is a
   * terminal-root StructureTabState seeded with the popped-out session, so the
   * converged PaneTree render shows the session in a full app window. */
  function create_terminal_popout_tab(opts: Partial<TerminalLeafState>) {
    const existing = tabs.find(t => t.id === `terminal`)
    if (!existing) {
      tab_states_record[`terminal`] = create_terminal_tab_state(opts)
      ensure_chat_slice(`terminal`)
      ensure_workflow_slice(`terminal`)
      tabs = [...tabs, { id: `terminal`, type: `terminal`, label: `Terminal`, closable: true }]
    }
    active_tab_id = `terminal`
  }

  /** Open (or focus) the Remote/MCP viewer tab.
   *
   * The MCP HTTP server (mcp_http.py) routes lab-claude pushes that come
   * in without an X-CatGo-Tab-Id header into panel_id="default". This tab
   * uses tab_id="default" so its `<Structure>` instance subscribes to that
   * panel's SSE stream — letting lab pushes land somewhere visible
   * instead of an orphan cache. Singleton: subsequent calls just focus
   * the existing tab. */
  function create_remote_tab() {
    const existing = tabs.find(t => t.id === `default`)
    if (existing) {
      active_tab_id = `default`
      return
    }
    tab_states_record[`default`] = create_tab_state()
    ensure_chat_slice(`default`)
    ensure_workflow_slice(`default`)
    tabs = [...tabs, { id: `default`, type: `structure`, label: `🤖 External`, closable: true }]
    active_tab_id = `default`
  }

  function reset_ts_to_empty(ts: StructureTabState, tab: AppTab) {
    const r = create_tab_state()
    ts.root = r.root
    ts.active_leaf_id = r.active_leaf_id
    ts.close_confirm_leaf_id = null
    ts.maximized_leaf_id = null
    ts.library = []
    ts.active_library_id = null
    ts.pending_library_removal = null
    // A last terminal tab being closed reverts to the structure landing page.
    tab.type = `structure`
    tab.label = `Structure`
  }

  function request_close_tab(id: string) {
    const tab = tabs.find(t => t.id === id)
    if (!tab) return

    // For structure tabs, check if any panel has content
    if (tab.type === `structure`) {
      const ts = tab_states_record[id]
      if (ts) {
        const loaded = leaves(ts.root).filter(l => {
          const pane = structurePane(l)
          return !!pane && pane_has_content(pane)
        }).length
        if (loaded > 0) {
          tab_close_confirm_id = id
          return
        }
      }
    }

    // Last tab: reset to empty landing page instead of removing
    if (tabs.length <= 1) {
      if (tab.type === `structure` || tab.type === `terminal`) {
        const ts = tab_states_record[id]
        if (ts) reset_ts_to_empty(ts, tab)
      }
      return
    }

    close_tab(id)
  }

  function close_tab(id: string) {
    const tab = tabs.find(t => t.id === id)
    if (!tab) return
    tab_close_confirm_id = null

    // Last tab: reset to empty landing page instead of removing
    if (tabs.length <= 1 && (tab.type === `structure` || tab.type === `terminal`)) {
      const ts = tab_states_record[id]
      if (ts) reset_ts_to_empty(ts, tab)
      return
    }

    const idx = tabs.findIndex(t => t.id === id)
    tabs = tabs.filter(t => t.id !== id)
    if (tab.type === `structure` || tab.type === `terminal`) {
      delete tab_states_record[id]
    }
    // Phase 2: drop the per-tab workflow slice, chat slice, and
    // action-handler entry so they can't be resurrected by stale $effect
    // references. The editor may already have unregistered itself via its
    // own cleanup effect, but because `inert`-mounted tabs don't fire
    // cleanups we also do it here. remove_chat_slice best-effort-aborts
    // any in-flight SDK stream so the backend stops generating tokens the
    // closed tab would never display.
    remove_chat_slice(id)
    remove_workflow_slice(id)
    unregister_workflow_action_handler(id)
    if (active_tab_id === id) {
      const new_idx = Math.min(idx, tabs.length - 1)
      active_tab_id = tabs[new_idx]?.id ?? tabs[0]?.id
    }
    // Clear URL hash so the hash-routing $effect doesn't re-add the tab
    if (tab.type === `workflow` && window.location.hash.startsWith(`#workflow`)) {
      history.replaceState(null, ``, window.location.pathname + window.location.search)
    } else if (tab.type === `terminal` && window.location.hash.startsWith(`#terminal`)) {
      history.replaceState(null, ``, window.location.pathname + window.location.search)
    }
  }

  function activate_tab(id: string) {
    active_tab_id = id
  }

  function update_tab_label(tab_id: string) {
    const ts = tab_states_record[tab_id]
    if (!ts) return
    const tab = tabs.find(t => t.id === tab_id)
    if (!tab || (tab.type !== `structure` && tab.type !== `terminal`)) return
    // External tab keeps its 🤖 prefix so users can always tell which pane
    // is the lab/MCP receiver, even after a structure loads in it.
    const prefix = tab_id === `default` ? `🤖 ` : ``
    const fallback = tab_id === `default` ? `External` : `Structure`
    const all_leaves = leaves(ts.root)
    const pane = all_leaves.map(l => structurePane(l)).find(p => p?.structure)
    if (pane?.structure?.sites?.length) {
      const counts: Record<string, number> = {}
      for (const site of pane.structure.sites) {
        const el = Array.isArray(site.species) ? site.species[0]?.element : (site.species as string)
        if (el) counts[el] = (counts[el] || 0) + 1
      }
      const formula = Object.entries(counts).map(([el, n]) => n > 1 ? `${el}${n}` : el).join(``)
      if (formula) { tab.label = `${prefix}${formula}`; return }
    }
    if (all_leaves.some(l => structurePane(l)?.mode === 'workflow')) {
      tab.label = `${prefix}Workflow`
      return
    }
    // A tab whose only content is terminal leaves labels as Terminal.
    if (all_leaves.length > 0 && all_leaves.every(l => isTerminalLeaf(l))) {
      tab.label = `${prefix}Terminal`
      return
    }
    tab.label = `${prefix}${fallback}`
  }

  function switch_to_structure() {
    const first = tabs.find(t => t.type === `structure`)
    if (first) active_tab_id = first.id
  }

  return {
    get tab_counter() { return tab_counter },
    set tab_counter(v: number) { tab_counter = v },
    // Return the raw $state reference for tabs — callers must mutate in-place
    // or reassign the whole array (tabs = [...tabs, newTab])
    get tabs() { return tabs },
    set tabs(v: AppTab[]) { tabs = v },
    get active_tab_id() { return active_tab_id },
    set active_tab_id(v: string) { active_tab_id = v },
    get active_tab() { return active_tab },
    get active_tab_type() { return active_tab_type },
    // IMPORTANT: Return the raw $state proxy — do NOT wrap in a getter
    // so that callers can mutate nested properties
    // (e.g. findLeafById(tab_states[id].root, leaf_id).content.pane.structure = ...)
    tab_states: tab_states_record,
    get_active_ts,
    get tabs_with_badges() { return tabs_with_badges },
    get active_layout() { return active_layout },
    get tab_close_confirm_id() { return tab_close_confirm_id },
    set tab_close_confirm_id(v: string | null) { tab_close_confirm_id = v },
    get pending_layout_change() { return pending_layout_change },
    set pending_layout_change(v: { tab_id: string, new_layout: PresetId, lost_count: number } | null) { pending_layout_change = v },
    create_tab,
    create_terminal_popout_tab,
    create_remote_tab,
    close_tab,
    request_close_tab,
    activate_tab,
    update_tab_label,
    switch_to_structure,
  }
}

export type TabManager = ReturnType<typeof create_tab_manager>

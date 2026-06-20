// Durable, module-level "last loaded structure".
//
// The 3D viewer's structure is a component prop inside Structure.svelte; it
// is lost when that component unmounts (e.g. the user expands the Workflow
// editor to full screen and the structure pane is closed). The backend
// `panel_structures` copy is also wiped when the pane closes / on
// `/view/reset`. That left both the workflow "Capture from Viewer" button
// and CatBot's structure_input resolution with nothing to inject.
//
// This store keeps the most recently loaded structure at module scope, so it
// survives pane close / component unmount for the whole session. It is the
// single client-side source of truth for "the structure the user last had",
// independent of which pane is visible.

import type { AnyStructure } from '$lib'

const _state = $state<{ value: AnyStructure | null }>({ value: null })

/** Record the latest real structure. No-ops on null/empty so a transient
 *  unmount (structure briefly undefined) doesn't clear a good value. */
export function set_current_structure(s: AnyStructure | null | undefined): void {
  if (s && Array.isArray((s as { sites?: unknown[] }).sites) && (s as { sites: unknown[] }).sites.length > 0) {
    _state.value = s
  }
}

/** The last loaded structure, or null if the user never loaded one. */
export function get_current_structure(): AnyStructure | null {
  return _state.value
}

/** Reactive accessor for Svelte components/effects. */
export function current_structure_state(): { value: AnyStructure | null } {
  return _state
}

// A client-direct LOAD awaiting the user's choice (overwrite / split / new-window).
// Set when a load tool runs while the viewer already shows a structure; the
// ChatPane card watches this. Pure client-side — no backend (works in STATIC_ONLY web).
export interface PendingClientLoad { structure: AnyStructure; formula: string; n: number }
const _pending = $state<{ value: PendingClientLoad | null }>({ value: null })

export function pending_client_load_state(): { value: PendingClientLoad | null } {
  return _pending
}
export function clear_pending_client_load(): void {
  _pending.value = null
}

/** Client-direct LOAD entry. If the viewer is EMPTY, apply the structure
 *  directly (set_current_structure) and return true. If the viewer already has
 *  a structure, stage it as a pending load (the ChatPane card asks where to put
 *  it) WITHOUT applying — return false. No backend involved. */
export function client_load_or_card(
  struct: AnyStructure,
  formula: string,
  n: number,
): boolean {
  const cur = get_current_structure()
  const has = !!cur && Array.isArray((cur as { sites?: unknown[] }).sites) &&
    (cur as { sites: unknown[] }).sites.length > 0
  if (!has) {
    set_current_structure(struct)
    _pending.value = null
    return true
  }
  _pending.value = { structure: struct, formula, n }
  return false
}

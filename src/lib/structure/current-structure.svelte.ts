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

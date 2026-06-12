// Bridge between CatBot's client tools (src/lib/chat/) and the LIVE 3D viewer.
//
// Viewer controls (show/hide bonds, camera reset, rotation, atom selection,
// appearance) are imperative actions on a mounted Svelte component
// (Structure.svelte) — they are NOT plain functions the chat layer can import,
// and the chat layer must never import a .svelte component (circular-dep / SSR
// pull-in). So Structure.svelte builds a handler capturing its own reactive
// state and REGISTERS it here; the chat-side viewer tools (viewer-tools.ts)
// resolve and call it. The dependency arrow points viewer -> this plain-TS
// module, never chat -> viewer.
//
// Single active-viewer slot (not a per-panel Map): execute_tool is stateless
// (no tab_id is threaded), and exactly one viewer is `is_active` at a time, so a
// single slot is unambiguous — no "most-recently-registered" guessing.

/** Imperative handle into the active 3D structure viewer, built inside
 *  Structure.svelte and registered via {@link register_viewer_action_handler}. */
export interface ViewerActionHandler {
  /** Write a single scene prop (show_atoms, show_bonds, atom_radius, rotation…). */
  set_scene_prop: (key: string, value: unknown) => void
  /** Reset the camera to its default position + zoom. */
  reset_camera: () => void
  /** Replace the atom selection with these validated 0-based site indices. */
  set_selection: (indices: number[]) => void
  /** Select every atom of `element`; returns how many were selected. */
  select_by_element: (element: string) => number
  /** Clear the atom selection. */
  clear_selection: () => void
  /** Site count of the active structure (0 when none is loaded). */
  site_count: () => number
}

let active_handler: ViewerActionHandler | null = null

/** Called by the active viewer on mount/activation. */
export function register_viewer_action_handler(h: ViewerActionHandler): void {
  active_handler = h
}

/** Called by the viewer on unmount/deactivation. Identity-checked: only clears
 *  the slot if it still points at THIS handler, so a deactivating viewer's
 *  cleanup can never wipe a freshly-activated viewer's registration (tab-switch
 *  mount/unmount ordering is not guaranteed). */
export function unregister_viewer_action_handler(h: ViewerActionHandler): void {
  if (active_handler === h) active_handler = null
}

/** The active viewer's handler, or null when no viewer is mounted/active. */
export function get_viewer_action_handler(): ViewerActionHandler | null {
  return active_handler
}

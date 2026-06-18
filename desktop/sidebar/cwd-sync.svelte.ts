/**
 * 5E: CWD sync — same-window CustomEvent listener for terminal CWD changes.
 * Extracted from Sidebar.svelte.
 */
import { LOCAL_SESSION_ID } from '$lib/hpc-sessions.svelte'

/**
 * Creates a CWD sync effect that listens for terminal directory changes in THIS
 * window and moves the active Files panel to follow the terminal's CWD.
 *
 * Window-local only (same-window CustomEvent — no cross-window BroadcastChannel),
 * so a popped-out terminal never moves the origin window's file system.
 *
 * Two distinct local file browsers exist and need different targets:
 *  - "Local Files" (source === LOCAL_SESSION_ID) is the FileTree pointed at the local
 *    filesystem — same component remote sessions use — driven by hpc_current_path.
 *  - "CatGo DB" (source === 'localdb') has an embedded simple browser driven by the
 *    fsb state (navigate_local).
 * A local terminal carries an empty session_id; a remote terminal carries its own.
 *
 * @returns cleanup function (always — the listener is wired for every source)
 */
export function create_cwd_sync_cleanup(
  source: string,
  get_hpc_current_path: () => string,
  set_hpc_current_path: (path: string) => void,
  navigate_local: (path: string) => void,
): (() => void) {
  // FileTree-backed remote sources (real HPC sessions) — NOT catgo/localdb/Local Files.
  const is_remote_source = !!source && source !== `catgo` && source !== `localdb` && source !== LOCAL_SESSION_ID
  const go_hpc = (path: string) => { if (path !== get_hpc_current_path()) set_hpc_current_path(path) }
  const apply = (path: string | undefined, session_id: string | undefined) => {
    if (!path) return
    if (session_id) {
      // Remote terminal CWD — only follow it when the active file source IS that
      // exact session (else a remote path would mis-navigate the local browser).
      if (is_remote_source && session_id === source) go_hpc(path)
    } else if (source === LOCAL_SESSION_ID) {
      // Local terminal + "Local Files" FileTree — both browse the local fs via
      // hpc_current_path, so drive that (NOT fsb, which backs CatGo DB's browser).
      go_hpc(path)
    } else {
      // Local terminal + CatGo DB's embedded fsb browser (no-op for examples view).
      navigate_local(path)
    }
  }
  const win_handler = (event: Event) => {
    const d = (event as CustomEvent).detail
    apply(d?.path, d?.session_id)
  }
  window.addEventListener(`catgo-terminal-cwd`, win_handler)
  return () => window.removeEventListener(`catgo-terminal-cwd`, win_handler)
}

/**
 * 5E: CWD sync — same-window CustomEvent listener for terminal CWD changes.
 * Extracted from Sidebar.svelte.
 */

/**
 * Creates a CWD sync effect that listens for terminal directory changes in THIS
 * window and moves the active Files panel to follow the terminal's CWD.
 *
 * Window-local only (same-window CustomEvent — no cross-window BroadcastChannel),
 * so a popped-out terminal never moves the origin window's file system. Routes by
 * source: HPC browser via set_hpc_current_path, local browser via navigate_local.
 * (Previously local sync was never wired — the listener only ran for HPC sources.)
 *
 * @returns cleanup function (always — the listener is wired for every source)
 */
export function create_cwd_sync_cleanup(
  source: string,
  get_hpc_current_path: () => string,
  set_hpc_current_path: (path: string) => void,
  navigate_local: (path: string) => void,
): (() => void) {
  const is_hpc_source = !!source && source !== `catgo` && source !== `localdb`
  const apply = (path: string | undefined, session_id: string | undefined) => {
    if (!path) return
    if (session_id) {
      // Remote terminal CWD — only follow it when the active file source IS that
      // exact session (else a remote path would mis-navigate the local browser).
      if (is_hpc_source && session_id === source && path !== get_hpc_current_path()) {
        set_hpc_current_path(path)
      }
    } else {
      // Local terminal CWD — only drives the local Files panel.
      if (!is_hpc_source) navigate_local(path)
    }
  }
  const win_handler = (event: Event) => {
    const d = (event as CustomEvent).detail
    apply(d?.path, d?.session_id)
  }
  window.addEventListener(`catgo-terminal-cwd`, win_handler)
  return () => window.removeEventListener(`catgo-terminal-cwd`, win_handler)
}

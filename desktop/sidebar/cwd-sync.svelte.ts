/**
 * 5E: CWD sync — BroadcastChannel + CustomEvent listeners for terminal CWD changes.
 * Extracted from Sidebar.svelte.
 */

/**
 * Creates a CWD sync effect that listens for terminal directory changes.
 * Must be called inside a component's $effect context.
 *
 * @param get_source - getter for current source
 * @param get_hpc_current_path - getter for hpc_current_path
 * @param set_hpc_current_path - setter for hpc_current_path
 * @returns cleanup function
 */
export function create_cwd_sync_cleanup(
  source: string,
  get_hpc_current_path: () => string,
  set_hpc_current_path: (path: string) => void,
): (() => void) | undefined {
  if (source && source !== `catgo` && source !== `localdb`) {
    const bc = new BroadcastChannel(`catgo-terminal-cwd`)
    const bc_handler = (event: MessageEvent) => {
      const { path } = event.data
      if (path && path !== get_hpc_current_path()) set_hpc_current_path(path)
    }
    bc.addEventListener(`message`, bc_handler)
    const win_handler = (event: Event) => {
      const { path } = (event as CustomEvent).detail
      if (path && path !== get_hpc_current_path()) set_hpc_current_path(path)
    }
    window.addEventListener(`catgo-terminal-cwd`, win_handler)
    return () => {
      bc.removeEventListener(`message`, bc_handler)
      bc.close()
      window.removeEventListener(`catgo-terminal-cwd`, win_handler)
    }
  }
  return undefined
}

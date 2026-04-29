/**
 * HPC connection banner state for WorkflowEditor.
 *
 * Extracted from WorkflowEditor.svelte.
 * Uses factory function pattern — $state must be created in component context.
 */

import { hpc_session_store } from '$lib/hpc-sessions.svelte'

export interface HpcBanner {
  readonly needed_hpc_hosts: string[]
  readonly hpc_banner_dismissed: boolean
  readonly show_connect_dialog: boolean
  readonly disconnected_hosts: string[]

  set_needed_hpc_hosts(v: string[]): void
  set_hpc_banner_dismissed(v: boolean): void
  set_show_connect_dialog(v: boolean): void
}

export function create_hpc_banner(): HpcBanner {
  let needed_hpc_hosts = $state<string[]>([])
  let hpc_banner_dismissed = $state(false)
  let show_connect_dialog = $state(false)

  const disconnected_hosts = $derived.by(() => {
    if (hpc_banner_dismissed || needed_hpc_hosts.length === 0) return []
    // Generic "HPC" marker means any connection suffices
    if (needed_hpc_hosts.length === 1 && needed_hpc_hosts[0] === `HPC`) {
      return hpc_session_store.sessions.length > 0 ? [] : [`HPC`]
    }
    const connected = new Set(hpc_session_store.sessions.map(s => `${s.username}@${s.host}`))
    return needed_hpc_hosts.filter(h => !connected.has(h))
  })

  return {
    get needed_hpc_hosts() { return needed_hpc_hosts },
    get hpc_banner_dismissed() { return hpc_banner_dismissed },
    get show_connect_dialog() { return show_connect_dialog },
    get disconnected_hosts() { return disconnected_hosts },

    set_needed_hpc_hosts(v) { needed_hpc_hosts = v },
    set_hpc_banner_dismissed(v) { hpc_banner_dismissed = v },
    set_show_connect_dialog(v) { show_connect_dialog = v },
  }
}

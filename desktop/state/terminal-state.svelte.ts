/**
 * Terminal tab reactive state — extracted from App.svelte.
 */

class TerminalState {
  init_session_id = $state<string | undefined>()
  init_host = $state<string | undefined>()
  init_username = $state<string | undefined>()
  init_sync_cwd = $state(false)

  parse_hash(hash: string) {
    const qmark = hash.indexOf(`?`)
    if (qmark < 0) return
    const params = new URLSearchParams(hash.slice(qmark))
    this.init_session_id = params.get(`session_id`) || undefined
    this.init_host = params.get(`host`) || undefined
    this.init_username = params.get(`username`) || undefined
    this.init_sync_cwd = params.get(`sync_cwd`) === `true`
  }
}

export const terminal = new TerminalState()

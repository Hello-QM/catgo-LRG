<script lang="ts">
  /**
   * DopingPTPanel — headless bridge that opens a separate Tauri/browser window
   * for the periodic table and communicates via localStorage + storage events.
   *
   * Exposes window_open (bindable) and open_pt_window() for parent to show
   * a reopen button in DopingPane when the window is closed.
   */
  import { onMount } from 'svelte'

  const KEY_TO_PT = `catgo-doping-pt:to-pt`
  const KEY_TO_MAIN = `catgo-doping-pt:to-main`

  let {
    highlight_symbols = [],
    group_label = '',
    on_toggle,
    on_add,
    window_open = $bindable(false),
  }: {
    highlight_symbols?: string[]
    group_label?: string
    on_toggle?: (sym: string) => void
    on_add?: (sym: string) => void
    window_open?: boolean
  } = $props()

  let pt_window: Window | null = null
  let tauri_win_label: string | null = null
  let close_poll: ReturnType<typeof setInterval> | null = null
  let last_heartbeat = 0

  function send(payload: any) {
    localStorage.setItem(KEY_TO_PT, JSON.stringify({ ...payload, _ts: Date.now() }))
  }

  /** Browser fallback: open with window.open + poll for close */
  function open_browser_window(url: string) {
    pt_window = window.open(url, `doping-pt`, `width=750,height=480,resizable=yes`) as Window | null
    window_open = !!pt_window
    if (pt_window) {
      close_poll = setInterval(() => {
        if (pt_window?.closed) {
          window_open = false
          pt_window = null
          if (close_poll) { clearInterval(close_poll); close_poll = null }
        }
      }, 500)
    }
  }

  export function open_pt_window() {
    if (pt_window && !pt_window.closed) { pt_window.focus(); return }
    if (tauri_win_label) return
    const url = `${window.location.origin}${window.location.pathname}#doping-pt`

    import(`@tauri-apps/api/webviewWindow`).then(({ WebviewWindow }) => {
      const label = `doping-pt-${Date.now()}`
      const win = new WebviewWindow(label, {
        title: `Periodic Table`,
        url,
        width: 750,
        height: 480,
        center: true,
        resizable: true,
        decorations: true,
      })
      tauri_win_label = label
      window_open = true
      // Detect close via Tauri event
      win.once(`tauri://destroyed`, () => {
        window_open = false
        tauri_win_label = null
        if (close_poll) { clearInterval(close_poll); close_poll = null }
      })
      // Heartbeat-based close detection: if no heartbeat for 3s, window is gone
      last_heartbeat = Date.now()
      close_poll = setInterval(() => {
        if (!tauri_win_label) return
        if (Date.now() - last_heartbeat > 3000) {
          window_open = false
          tauri_win_label = null
          if (close_poll) { clearInterval(close_poll); close_poll = null }
        }
      }, 1000)
      win.once(`tauri://error`, () => {
        tauri_win_label = null
        if (close_poll) { clearInterval(close_poll); close_poll = null }
        open_browser_window(url)
      })
    }).catch(() => {
      open_browser_window(url)  // Tauri window unavailable — fall back to browser window
    })
  }

  function close_pt_window() {
    send({ type: `close` })
    if (pt_window && !pt_window.closed) pt_window.close()
    if (tauri_win_label) {
      import(`@tauri-apps/api/webviewWindow`).then(async ({ WebviewWindow }) => {
        const win = await WebviewWindow.getByLabel(tauri_win_label!)
        win?.close()
      }).catch(() => {}) // Best-effort Tauri window cleanup on close
      tauri_win_label = null
    }
    pt_window = null
    window_open = false
  }

  onMount(() => {
    const on_storage = (e: StorageEvent) => {
      if (e.key !== KEY_TO_MAIN || !e.newValue) return
      try {
        const msg = JSON.parse(e.newValue)
        if (msg.type === `toggle` && msg.sym) on_toggle?.(msg.sym)
        else if (msg.type === `add` && msg.sym) on_add?.(msg.sym)
        else if (msg.type === `ready`) {
          window_open = true
          last_heartbeat = Date.now()
          send({ type: `highlight`, symbols: highlight_symbols, group_label })
        } else if (msg.type === `heartbeat`) {
          last_heartbeat = Date.now()
        } else if (msg.type === `closing`) {
          window_open = false
          tauri_win_label = null
          pt_window = null
          if (close_poll) { clearInterval(close_poll); close_poll = null }
        }
      } catch { /* ignore */ }
    }

    window.addEventListener(`storage`, on_storage)
    open_pt_window()

    return () => {
      window.removeEventListener(`storage`, on_storage)
      if (close_poll) { clearInterval(close_poll); close_poll = null }
      close_pt_window()
    }
  })

  // Send highlight updates — read deps BEFORE conditional for Svelte tracking
  $effect(() => {
    const syms = highlight_symbols
    const label = group_label
    send({ type: `highlight`, symbols: syms, group_label: label })
  })
</script>

<!-- Headless bridge — reopen button is rendered by DopingPane -->

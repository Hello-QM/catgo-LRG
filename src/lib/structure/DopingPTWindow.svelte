<script lang="ts">
  /**
   * Standalone Periodic Table for doping — rendered in a separate Tauri/browser window.
   * Communicates with the main window via localStorage + storage events.
   *
   * Protocol (localStorage keys):
   *   Main → PT:  'catgo-doping-pt:to-pt'   { type: 'highlight', symbols, group_label }
   *   Main → PT:  'catgo-doping-pt:to-pt'   { type: 'close' }
   *   PT → Main:  'catgo-doping-pt:to-main'  { type: 'toggle', sym }
   *   PT → Main:  'catgo-doping-pt:to-main'  { type: 'add', sym }
   *   PT → Main:  'catgo-doping-pt:to-main'  { type: 'ready' }
   *   PT → Main:  'catgo-doping-pt:to-main'  { type: 'closing' }
   */
  import type { ChemicalElement, ElementSymbol } from '$lib'
  import { PeriodicTable } from '$lib/periodic-table'
  import { onMount } from 'svelte'

  const KEY_TO_PT = `catgo-doping-pt:to-pt`
  const KEY_TO_MAIN = `catgo-doping-pt:to-main`

  let highlight_symbols = $state<string[]>([])
  let group_label = $state(`Group 1`)
  let pt_active_element = $state<ChemicalElement | null>(null)
  let is_selecting = $state(false)

  // Non-reactive drag tracking
  let drag_started_on: string | null = null
  let drag_visited_other = false
  let drag_start_added = false

  let color_overrides = $derived.by(() => {
    const overrides: Partial<Record<ElementSymbol, string>> = {}
    for (const sym of highlight_symbols) {
      overrides[sym as ElementSymbol] = `#10b981`
    }
    return overrides
  })

  function send(msg: any) {
    localStorage.setItem(KEY_TO_MAIN, JSON.stringify({ ...msg, _ts: Date.now() }))
  }

  onMount(() => {
    const on_storage = (e: StorageEvent) => {
      if (e.key !== KEY_TO_PT || !e.newValue) return
      try {
        const msg = JSON.parse(e.newValue)
        if (msg.type === `highlight`) {
          highlight_symbols = msg.symbols ?? []
          group_label = msg.group_label ?? ``
        } else if (msg.type === `close`) {
          window.close()
        }
      } catch { /* ignore parse errors */ }
    }

    window.addEventListener(`storage`, on_storage)

    // Signal that the PT window is ready
    send({ type: `ready` })

    // Heartbeat — lets the main window detect when this window is closed
    const heartbeat = setInterval(() => {
      send({ type: `heartbeat` })
    }, 800)

    // Notify main window when this window is being closed
    const on_beforeunload = () => {
      send({ type: `closing` })
    }
    window.addEventListener(`beforeunload`, on_beforeunload)

    return () => {
      clearInterval(heartbeat)
      window.removeEventListener(`storage`, on_storage)
      window.removeEventListener(`beforeunload`, on_beforeunload)
    }
  })

  // ── Element selection (click + drag-to-select) ──

  function on_pointerdown() {
    is_selecting = true
    drag_visited_other = false
    drag_start_added = false
    drag_started_on = pt_active_element?.symbol ?? null
  }

  function on_pointerup() {
    is_selecting = false
    if (!drag_visited_other && drag_started_on) {
      send({ type: `toggle`, sym: drag_started_on })
    }
    drag_started_on = null
    drag_visited_other = false
    drag_start_added = false
  }

  $effect(() => {
    if (is_selecting && pt_active_element) {
      const sym = pt_active_element.symbol
      if (sym !== drag_started_on) {
        if (!drag_start_added && drag_started_on) {
          drag_start_added = true
          send({ type: `add`, sym: drag_started_on })
        }
        drag_visited_other = true
        send({ type: `add`, sym })
      }
    }
  })
</script>

<svelte:head>
  <title>Periodic Table — {group_label}</title>
</svelte:head>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="doping-pt-window"
  onpointerdown={on_pointerdown}
  onpointerup={on_pointerup}
  onpointerleave={on_pointerup}
>
  <div class="doping-pt-header">
    <span class="doping-pt-title">Periodic Table &mdash; {group_label}</span>
  </div>
  <div class="doping-pt-area">
    <PeriodicTable
      bind:active_element={pt_active_element}
      {color_overrides}
      tile_props={{ show_number: false, show_name: false }}
      show_color_bar={false}
      gap="3px"
      style="width: min(100cqi, 180cqb); user-select: none;"
    />
  </div>
</div>

<style>
  .doping-pt-window {
    width: 100vw;
    height: 100vh;
    display: flex;
    flex-direction: column;
    background: light-dark(rgba(245, 245, 250, 1), rgba(22, 22, 32, 1));
    color: light-dark(#333, #ddd);
    overflow: hidden;
    user-select: none;
  }
  .doping-pt-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 12px;
    background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.04));
    border-bottom: 1px solid light-dark(rgba(0, 0, 0, 0.06), rgba(255, 255, 255, 0.06));
    flex-shrink: 0;
  }
  .doping-pt-title {
    font-size: 0.9em;
    font-weight: 600;
  }
  .doping-pt-area {
    flex: 1;
    min-height: 0;
    overflow: hidden;
    padding: 12px;
    touch-action: none;
    container-type: size;
    display: flex;
    align-items: center;
    justify-content: center;
  }
</style>

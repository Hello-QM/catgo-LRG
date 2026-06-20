<script lang="ts">
  import '$lib/pane-shared.css'
  import { Icon } from '$lib'
  import type { IconName } from '$lib/icons'
  import type { Snippet } from 'svelte'
  import { onDestroy } from 'svelte'
  import { tooltip } from 'svelte-multiselect/attachments'
  import type { HTMLAttributes } from 'svelte/elements'

  const DRAG_HANDLES = `.drag-handle, .pane-title, .tab-bar`
  const INTERACTIVE = `button, input, select, textarea, a, [role="button"]`
  const DRAG_THRESHOLD = 3

  function make_draggable(options: {
    on_drag_start?: () => void
    on_drag_end?: () => void
  }) {
    return (node: HTMLElement) => {
      function on_mousedown(event: MouseEvent) {
        if (event.button !== 0) return
        const target = event.target as HTMLElement

        const handle = target.closest(DRAG_HANDLES)
        if (!handle || !node.contains(handle as HTMLElement)) return

        // Skip if mousedown is on an interactive element inside the handle
        const interactive = target.closest(INTERACTIVE)
        if (interactive && handle.contains(interactive)) return

        const start_x = event.clientX
        const start_y = event.clientY
        const initial_left = node.offsetLeft
        const initial_top = node.offsetTop
        let dragging = false

        function on_mousemove(e: MouseEvent) {
          const dx = e.clientX - start_x
          const dy = e.clientY - start_y
          if (!dragging) {
            if (Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return
            dragging = true
            options.on_drag_start?.()
            node.style.userSelect = `none`
            document.body.style.cursor = `grabbing`
          }
          const margin = 16
          const min_visible = Math.min(80, Math.max(40, node.offsetWidth / 4))
          const new_left = Math.max(margin - node.offsetWidth + min_visible, Math.min(initial_left + dx, window.innerWidth - min_visible))
          const new_top = Math.max(margin, Math.min(initial_top + dy, window.innerHeight - min_visible))
          node.style.left = `${new_left}px`
          node.style.top = `${new_top}px`
          node.style.right = `auto`
          node.style.bottom = `auto`
        }

        function on_mouseup() {
          document.removeEventListener(`mousemove`, on_mousemove)
          document.removeEventListener(`mouseup`, on_mouseup)
          if (dragging) {
            node.style.userSelect = ``
            document.body.style.cursor = ``
            options.on_drag_end?.()
          }
        }

        document.addEventListener(`mousemove`, on_mousemove)
        document.addEventListener(`mouseup`, on_mouseup)
      }

      node.addEventListener(`mousedown`, on_mousedown)
      return { destroy() { node.removeEventListener(`mousedown`, on_mousedown) } }
    }
  }

  let {
    show = $bindable(false),
    show_pane = true,
    show_toggle = true,
    close_on_click_outside = true,
    children,
    toggle_props = {},
    open_icon = `Cross`,
    closed_icon = `Settings`,
    icon_style = ``,
    offset = { x: 5, y: 5 },
    max_width = `450px`,
    max_height = ``,
    pane_props = {},
    onclose = () => {},
    on_drag_start = () => {},
    toggle_pane_btn = $bindable(undefined),
    pane_div = $bindable(undefined),
    has_been_dragged = $bindable(false),
    currently_dragging = $bindable(false),
  }: {
    show?: boolean
    show_pane?: boolean
    /** If false, toggle button is hidden but pane still renders */
    show_toggle?: boolean
    /** If false, pane won't close when clicking outside */
    close_on_click_outside?: boolean
    children: Snippet<[]>
    // Toggle button
    toggle_props?: HTMLAttributes<HTMLButtonElement>
    open_icon?: IconName
    closed_icon?: IconName
    icon_style?: string
    // Pane positioning and styling
    offset?: { x?: number; y?: number }
    max_width?: string
    /** Max height constraint from caller (e.g. "calc(500px - 50px)", "80vh").
     *  Combined with viewport clamping: the effective max-height is min(this, available space). */
    max_height?: string
    pane_props?: HTMLAttributes<HTMLDivElement>
    // Callbacks
    onclose?: () => void
    on_drag_start?: () => void
    // Bindable state
    toggle_pane_btn?: HTMLButtonElement
    pane_div?: HTMLDivElement
    has_been_dragged?: boolean
    currently_dragging?: boolean
  } = $props()

  let initial_position = $state({ left: `50px`, top: `50px`, maxHeight: `` })
  let show_control_buttons = $state(false)

  function viewport_max_width() {
    if (typeof window === `undefined`) return max_width
    if (!max_width || max_width === `none`) return `calc(100vw - 32px)`
    return `min(${max_width}, calc(100vw - 32px))`
  }

  function toggle_pane() {
    show = !show
    if (!show) {
      has_been_dragged = false
      show_control_buttons = false
      onclose()
    }
  }
  function close_pane() {
    show = false
    has_been_dragged = false
    show_control_buttons = false
    onclose()
  }

  function reset_position() {
    if (toggle_pane_btn) {
      const pos = calculate_position()
      initial_position = pos
      if (pane_div) {
        Object.assign(pane_div.style, {
          left: pos.left,
          top: pos.top,
          right: `auto`,
          bottom: `auto`,
          width: ``,
          height: ``,
          maxHeight: pos.maxHeight || ``,
          maxWidth: ``,
        })
      }
    }
    // Hide the control buttons after reset
    show_control_buttons = false
    has_been_dragged = false
  }

  // Drag handlers
  function handle_drag_start() {
    has_been_dragged = true
    show_control_buttons = true
    currently_dragging = true
    on_drag_start()
  }

  // Containment bounds: normally the viewport, but when the toggle lives
  // inside a modal dialog the pane must stay within IT — fixed positioning
  // otherwise reasons in viewport coords and happily parks the pane outside
  // the dialog, over unrelated UI (e.g. the structure controls escaping
  // StructureEditModal onto the workflow side panels). `min_width` guards
  // against modals too small to host the pane at all (fall back to viewport).
  function containment_bounds(min_width: number): { left: number; top: number; right: number; bottom: number } {
    const anchor = toggle_pane_btn ?? pane_div
    const modal_el = anchor?.closest(
      `dialog, [role="dialog"], .struct-edit3d-modal`,
    ) as HTMLElement | null
    const rect = modal_el?.getBoundingClientRect()
    if (rect && rect.width > min_width && rect.height > 200) {
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
    }
    return { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }
  }

  // Position calculation — returns viewport-relative coordinates. Panes are
  // portaled to <body>, so fixed positioning is the safest way to avoid
  // clipping/overflow from toolbar wrappers, transformed parents, or split panes.
  function calculate_position() {
    const margin = 16
    const vw = window.innerWidth
    const vh = window.innerHeight
    const safe_w = Math.max(220, vw - margin * 2)
    const safe_h = Math.max(160, vh - margin * 2)

    if (!toggle_pane_btn) {
      console.debug(`[DraggablePane] no toggle_pane_btn, using fallback position`)
      return {
        left: `${Math.max(margin, Math.round((vw - Math.min(450, safe_w)) / 2))}px`,
        top: `${Math.max(margin, Math.round((vh - Math.min(400, safe_h)) / 2))}px`,
        maxHeight: max_height ? `min(${max_height}, ${safe_h}px)` : `${safe_h}px`,
      }
    }

    const toggle_rect = toggle_pane_btn.getBoundingClientRect()
    if (toggle_rect.width === 0 && toggle_rect.height === 0) {
      console.debug(`[DraggablePane] toggle button is hidden (0x0), deferring`)
      return {
        left: `${Math.max(margin, Math.round((vw - Math.min(450, safe_w)) / 2))}px`,
        top: `${Math.max(margin, Math.round((vh - Math.min(400, safe_h)) / 2))}px`,
        maxHeight: max_height ? `min(${max_height}, ${safe_h}px)` : `${safe_h}px`,
      }
    }

    const pane_rect = pane_div?.getBoundingClientRect()
    // `||` would only catch width === 0; getBoundingClientRect can return a
    // tiny non-zero width during the same tick that show=true (race with
    // content layout). Treat anything below 100px as an unreliable
    // measurement and use the conservative fallback instead, so the left
    // doesn't pick a right-anchored position the actual (wider) pane will
    // overflow when it finishes laying out.
    const pane_width = Math.min((pane_rect && pane_rect.width >= 100) ? pane_rect.width : 450, safe_w)
    const pane_height = Math.min((pane_rect && pane_rect.height >= 50) ? pane_rect.height : 400, safe_h)

    const bounds = containment_bounds(pane_width + margin)

    const right_open = toggle_rect.right + (offset.x ?? 5)
    const left_open = toggle_rect.left - pane_width - (offset.x ?? 5)
    // Prefer right of the button if the pane fits within the containment
    // bounds (viewport, or the enclosing modal); otherwise flip left.
    let left_val = right_open + pane_width <= bounds.right - margin ? right_open : left_open
    left_val = Math.max(bounds.left + margin, Math.min(left_val, bounds.right - pane_width - margin))

    let top_val = toggle_rect.bottom + (offset.y ?? 5)
    if (top_val + pane_height > bounds.bottom - margin) {
      const above = toggle_rect.top - pane_height - (offset.y ?? 5)
      top_val = above >= bounds.top + margin
        ? above
        : Math.max(bounds.top + margin, Math.round((bounds.top + bounds.bottom - pane_height) / 2))
    }
    top_val = Math.max(bounds.top + margin, Math.min(top_val, bounds.bottom - pane_height - margin))

    const available_h = `${Math.max(120, bounds.bottom - top_val - margin)}px`
    const effective_max_h = max_height ? `min(${max_height}, ${available_h})` : available_h
    const result = { left: `${left_val}px`, top: `${top_val}px`, maxHeight: effective_max_h }
    // Fixed positioning escapes overflow clipping; the z-index raise keeps the
    // pane above modal overlays (e.g. .struct-preview-overlay is z 9999 —
    // the pane's default z of 10 would paint under the dialog, leaving it
    // visible but unclickable).
    if (pane_div) {
      pane_div.style.position = `fixed`
      pane_div.style.zIndex = `10000`
    }
    console.debug(`[DraggablePane] positioned:`, { toggle: { bottom: toggle_rect.bottom, right: toggle_rect.right }, pane: { width: pane_width, height: pane_height }, bounds, result })
    return result
  }

  // Click outside handler
  function handle_click_outside(event: MouseEvent) {
    if (!show || !close_on_click_outside) return

    const target = event.target as HTMLElement
    const is_toggle_button = toggle_pane_btn &&
      (target === toggle_pane_btn || toggle_pane_btn.contains(target))
    const is_inside_pane = pane_div &&
      (target === pane_div || pane_div.contains(target))

    if (!is_toggle_button && !is_inside_pane && !currently_dragging) close_pane()
  }

  // Debounced resize handler for better performance
  let resize_timeout: ReturnType<typeof setTimeout> | undefined = $state(undefined)

  function handle_resize() {
    if (!show || currently_dragging) return

    if (resize_timeout) clearTimeout(resize_timeout)
    const current_timeout = setTimeout(() => {
      if (resize_timeout !== current_timeout) return
      if (show && pane_div) {
        if (toggle_pane_btn && !has_been_dragged) {
          const pos = calculate_position()
          initial_position = pos
          pane_div.style.left = pos.left
          pane_div.style.top = pos.top
          if (pos.maxHeight) pane_div.style.maxHeight = pos.maxHeight
        } else {
          // Even manually moved panes must remain reachable after viewport changes.
          clamp_to_viewport()
        }
      }
    }, 50) // Debounce resize events
    resize_timeout = current_timeout
  }

  // Position pane when shown
  // Update initial_position and let Svelte's reactive style bindings handle the DOM
  $effect(() => {
    if (show && toggle_pane_btn && !has_been_dragged) {
      const pos = calculate_position()
      initial_position = pos
      // Reset inline styles that might have been set during dragging/resizing
      if (pane_div) {
        pane_div.style.right = `auto`
        pane_div.style.bottom = `auto`
        pane_div.style.width = ``
        pane_div.style.height = ``
        pane_div.style.maxHeight = pos.maxHeight || ``
        pane_div.style.maxWidth = viewport_max_width()
      }
    }
  })

  // Clamp pane geometry so it remains inside the visible bounds (viewport,
  // or the enclosing modal — see containment_bounds).
  // Re-runs on show, resize, and content changes via ResizeObserver.
  function clamp_to_viewport() {
    if (!pane_div || !show) return
    const rect = pane_div.getBoundingClientRect()
    const margin = 16
    const b = containment_bounds(rect.width + margin)
    const max_left = Math.max(b.left + margin, b.right - rect.width - margin)
    const max_top = Math.max(b.top + margin, b.bottom - Math.min(rect.height, b.bottom - b.top - margin * 2) - margin)
    const next_left = Math.max(b.left + margin, Math.min(rect.left, max_left))
    const next_top = Math.max(b.top + margin, Math.min(rect.top, max_top))
    const available = b.bottom - next_top - margin
    const clamped = available > 100
      ? (max_height ? `min(${max_height}, ${available}px)` : `${available}px`)
      : initial_position.maxHeight

    const is_outside_viewport = rect.left < b.left + margin || rect.top < b.top + margin ||
      rect.right > b.right - margin || rect.bottom > b.bottom - margin
    if ((is_outside_viewport || !has_been_dragged) && (
      Math.abs(next_left - rect.left) > 1 ||
      Math.abs(next_top - rect.top) > 1 ||
      initial_position.maxHeight !== clamped
    )) {
      initial_position = {
        left: `${next_left}px`,
        top: `${next_top}px`,
        maxHeight: clamped,
      }
    }

    if (available > 100) {
      if (initial_position.maxHeight !== clamped) {
        initial_position = { ...initial_position, maxHeight: clamped }
      }
    }
  }

  $effect(() => {
    if (!show || !pane_div) return
    // Clamp on show and whenever the pane or its container resizes
    requestAnimationFrame(clamp_to_viewport)
    const ro = new ResizeObserver(() => clamp_to_viewport())
    ro.observe(pane_div)
    // Also observe the offsetParent (container) for modal resize
    if (pane_div.offsetParent instanceof HTMLElement) {
      ro.observe(pane_div.offsetParent)
    }
    return () => ro.disconnect()
  })

  // Defensive cleanup: when the component unmounts (tab closed, parent
  // destroyed, etc.) make sure the portaled pane DOM is removed from
  // <body>.  Svelte's normal teardown should do this via the bind:this
  // contract, but the portal step happens in an $effect and Svelte's
  // moved-node tracking has been observed to miss it in production
  // builds — the cube panel was reproducibly orphaned after a tab close.
  onDestroy(() => {
    if (pane_div && pane_div.parentElement === document.body) {
      pane_div.remove()
    }
  })

  // Portal: move the pane DOM node into document.body when shown so it escapes
  // any transformed / overflow:hidden / lower-z-index ancestor that could trap or
  // clip it. Tauri WKWebView in particular has position:fixed quirks inside
  // transformed containers, and split-pane layouts can resolve offsetParent to
  // a small toolbar SECTION. With the node in body, position:fixed is genuinely
  // viewport-relative and nothing above it can clip it. Svelte's destroy logic
  // uses `node.remove()` so the moved node is still cleaned up correctly when
  // {#if show_pane} flips back to false.
  $effect(() => {
    if (show && pane_div && pane_div.parentElement !== document.body) {
      document.body.appendChild(pane_div)
    }
  })

  // Tab-visibility tracking: because we portal the pane DOM into <body>,
  // hiding the *original* view-layer ancestor (via class `view-layer-hidden`
  // when its tab is inactive) no longer hides the pane.  Result: opening a
  // cube panel in Tab A, switching to Tab B, leaves the cube pane stuck on
  // top of Tab B and unclickable (its tab is inert).  And once Tab A is
  // closed, it's literally orphan DOM in <body>.
  //
  // The toggle button stays in the original tree, so we watch it: any time
  // the toggle is inside a `view-layer-hidden` ancestor (or removed from
  // the document entirely because its tab was destroyed), hide the
  // portaled pane.  Restores `display: grid` when the tab becomes active
  // again, and removes the orphan node from <body> when the toggle goes
  // away.
  $effect(() => {
    if (!toggle_pane_btn || !pane_div) return

    function apply_visibility() {
      if (!pane_div) return
      const owner_in_dom = toggle_pane_btn?.isConnected
      if (!owner_in_dom) {
        // Owner tab was destroyed; remove the orphan portaled DOM.
        pane_div.remove()
        return
      }
      const owner_hidden = !!toggle_pane_btn?.closest('.view-layer-hidden')
      if (owner_hidden) {
        pane_div.style.setProperty('display', 'none', 'important')
      } else if (show) {
        pane_div.style.removeProperty('display')
      }
    }

    apply_visibility()
    // Watch class changes on every view-layer ancestor so we react when the
    // active tab flips, and on body for owner removal.
    const observers: MutationObserver[] = []
    let el: Element | null = toggle_pane_btn.parentElement
    while (el && el !== document.body) {
      const obs = new MutationObserver(apply_visibility)
      obs.observe(el, { attributes: true, attributeFilter: ['class'] })
      observers.push(obs)
      el = el.parentElement
    }
    const body_obs = new MutationObserver(apply_visibility)
    body_obs.observe(document.body, { childList: true, subtree: true })
    observers.push(body_obs)
    return () => observers.forEach((o) => o.disconnect())
  })

  // Stop pointer events from bubbling past the pane root. Once portaled to body,
  // events fired on the pane bubble all the way to document — and any sibling
  // component that listens at the document level (e.g. trajectory plots that
  // track cursor X to scrub frames) will fire on cursor moves over the pane,
  // even though the pane is visually on top. Halting propagation at the pane
  // root preserves the pane's own internal interactivity (children's handlers
  // ran already before reaching the root) while preventing cross-component leaks.
  //
  // Critically, `make_draggable` adds its own mousemove + mouseup listeners on
  // `document` while a drag is active. Stopping those would leave the pane
  // stuck following the pointer (drag-end never fires). So:
  //   - *up events: never stop — drag-end must reach document.
  //   - *move events: only stop when no button is held (hover, not drag).
  //     During an active drag, buttons !== 0 and we let events through so
  //     make_draggable can track movement.
  //   - *down + wheel: always stop. Plot reacts to clicks/scrolls; we don't
  //     want it to fire when the pane is the topmost element.
  $effect(() => {
    if (!pane_div) return
    const stop = (e: Event) => {
      if (e.type.endsWith(`up`)) return
      if (e.type.endsWith(`move`) && `buttons` in e && (e as PointerEvent).buttons !== 0) return
      e.stopPropagation()
    }
    const events = [`pointerdown`, `pointermove`, `pointerup`, `mousedown`, `mousemove`, `mouseup`, `wheel`]
    for (const ev of events) pane_div.addEventListener(ev, stop)
    return () => { for (const ev of events) pane_div?.removeEventListener(ev, stop) }
  })

  // Detect user resize (via native CSS resize handle) to show reset button
  $effect(() => {
    if (!pane_div) return
    let initial_w = 0
    let initial_h = 0
    let first = true
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      if (first) {
        initial_w = width
        initial_h = height
        first = false
        return
      }
      if (Math.abs(width - initial_w) > 2 || Math.abs(height - initial_h) > 2) {
        has_been_dragged = true
        show_control_buttons = true
        // Remove max-height cap so the resize handle can grow freely
        if (pane_div) pane_div.style.maxHeight = ``
        initial_position = { ...initial_position, maxHeight: `` }
      }
    })
    observer.observe(pane_div)
    return () => observer.disconnect()
  })
</script>

<svelte:window
  onkeydown={(event: KeyboardEvent) => {
    if (event.key === `Escape` && show) {
      event.preventDefault()
      close_pane()
    }
  }}
  onresize={handle_resize}
/>
<svelte:document onclick={handle_click_outside} />

{#if show_pane}
  {#if show_toggle}
    <span class="pane-toggle-tooltip-wrap">
      <button
        type="button"
        bind:this={toggle_pane_btn}
        aria-expanded={show}
        {...toggle_props}
        style={`font-size: clamp(1em, 2.2cqw, 1.2em); ${toggle_props.style ?? ``}`}
        onclick={toggle_pane}
        class="pane-toggle {show ? `active` : ``} {toggle_props.class ?? ``}"
      >
        <Icon icon={show ? open_icon : closed_icon} style={icon_style} />
      </button>
      <span class="pane-toggle-tooltip" role="tooltip">{toggle_props.title ?? (show ? `Close pane` : `Open pane`)}</span>
    </span>
  {/if}

  <div
    {@attach make_draggable({
      on_drag_start: handle_drag_start,
      on_drag_end: () => {
        currently_dragging = false
        // Sync initial_position with current DOM position so the reactive
        // style:top/style:left bindings don't snap the pane back
        if (pane_div) {
          initial_position = {
            left: pane_div.style.left,
            top: pane_div.style.top,
            maxHeight: initial_position.maxHeight,
          }
        }
      },
    })}
    bind:this={pane_div}
    role="dialog"
    aria-label="Draggable pane"
    aria-modal="false"
    style:max-width={viewport_max_width()}
    style:max-height={initial_position.maxHeight || null}
    style:top={initial_position.top}
    style:left={initial_position.left}
    style:display={show ? `grid` : `none`}
    {...pane_props}
    class="draggable-pane {show ? `pane-open` : ``} {pane_props.class ?? ``}"
  >
    <div class="control-buttons">
      {#if show_control_buttons}
        <button
          type="button"
          class="reset-button"
          onclick={reset_position}
          title="Reset pane position"
          aria-label="Reset pane position"
        >
          <Icon icon="Reset" style="width: 1.25em; height: 1.25em" />
        </button>
      {/if}
      <!--
        Close button is ALWAYS visible whenever the pane is open, not only
        after the user has dragged/resized it.  Previously gated on
        `show_control_buttons`, which only flipped to true inside the drag /
        ResizeObserver handlers — so a pane that the user just opened and
        wanted to dismiss without dragging first had no in-pane close
        affordance, only the round toggle outside the pane.  When the cube
        panel showed an error message that overlapped the toggle, the user
        had no way to close it.
      -->
      <button
        type="button"
        class="close-button"
        onclick={close_pane}
        title="Close pane"
        aria-label="Close pane"
      >
        <Icon icon="Cross" style="width: 1.25em; height: 1.25em" />
      </button>
      {#if show_toggle || show_control_buttons}
        <Icon
          icon="DragIndicator"
          class="drag-handle"
          style="width: 1.25em; height: 1.25em"
        />
      {/if}
    </div>

    {@render children()}
  </div>
{/if}

<style>
  .pane-toggle-tooltip-wrap {
    position: relative;
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
  }
  .pane-toggle-tooltip {
    position: absolute;
    left: 50%;
    top: calc(100% + 8px);
    transform: translateX(-50%) translateY(-4px);
    padding: 7px 12px;
    border-radius: 7px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    background: rgba(17, 17, 17, 0.96);
    color: #f5f5f5;
    box-shadow: 0 10px 24px rgba(0, 0, 0, 0.3);
    font-size: 13px;
    font-weight: 600;
    line-height: 1.25;
    white-space: nowrap;
    pointer-events: none;
    opacity: 0;
    visibility: hidden;
    z-index: 100000010;
    transition: opacity 0.14s ease, transform 0.14s ease, visibility 0.14s ease;
  }
  .pane-toggle-tooltip-wrap:hover .pane-toggle-tooltip,
  .pane-toggle-tooltip-wrap:focus-within .pane-toggle-tooltip {
    opacity: 1;
    visibility: visible;
    transform: translateX(-50%) translateY(0);
  }
  .pane-toggle-tooltip::before {
    content: '';
    position: absolute;
    left: 50%;
    bottom: 100%;
    width: 9px;
    height: 9px;
    background: inherit;
    border-left: 1px solid rgba(255, 255, 255, 0.12);
    border-top: 1px solid rgba(255, 255, 255, 0.12);
    transform: translate(-50%, 50%) rotate(45deg);
  }
  button.pane-toggle {
    box-sizing: border-box;
    display: flex;
    place-items: center;
    padding: var(--pane-toggle-padding, 2pt);
    border-radius: var(--pane-toggle-border-radius, 3pt);
    background-color: transparent;
    transition: var(--pane-toggle-transition, background-color 0.15s);
    font-size: var(--pane-toggle-font-size, clamp(0.9em, 2cqmin, 1.4em));
  }
  button.pane-toggle:hover {
    background-color: color-mix(in srgb, currentColor 8%, transparent);
  }
  button.pane-toggle.active {
    color: var(--accent-color, #007acc);
    background-color: color-mix(in srgb, var(--accent-color, #007acc) 15%, transparent);
  }
  div.draggable-pane {
    position: fixed;
    background: var(--pane-bg, var(--page-bg, light-dark(white, black)));
    border: var(--pane-border, 1px solid light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15)));
    border-radius: var(--pane-border-radius, 10px);
    padding: var(--pane-padding, 1ex);
    box-sizing: border-box;
    box-shadow: var(--pane-shadow, 0 4px 16px rgba(0, 0, 0, 0.1));
    z-index: var(--pane-z-index, 10);
    display: grid;
    gap: var(--pane-gap, 4pt);
    text-align: left;
    /* Exclude position from being transitioned to prevent sluggish dragging */
    transition: opacity 0.2s, background-color 0.2s, border-color 0.2s, box-shadow 0.2s;
    font-weight: 500;
    width: 28em;
    min-width: 200px;
    min-height: 120px;
    max-width: min(var(--pane-max-width, 80cqw), calc(100vw - 32px));
    resize: both;
    overflow-x: var(--pane-overflow-x, hidden);
    overflow-y: var(--pane-overflow-y, auto);
    max-height: var(--pane-max-height, calc(100vh - var(--pane-bottom-margin, 40px)));
    overscroll-behavior: contain; /* Prevent scroll chaining to parent containers (e.g. Jupyter cells) */
    /* Standardized font styling for all panes */
    font-size: var(--pane-font-size, 0.85em);
    line-height: var(--pane-line-height, 1.4);
  }
  :global(body.fullscreen) .draggable-pane {
    position: fixed !important; /* In fullscreen, we want viewport-relative positioning */
    top: 3.3em !important;
    right: 1em !important;
    left: auto !important;
  }
  /* Standardized pane content styling */
  .draggable-pane :global(h4) {
    margin: var(--pane-h4-margin, 0 0 0.5em 0);
    font-size: var(--pane-h4-font-size, 1.05em);
    font-weight: 600;
    padding-right: 1.8em; /* Clear the drag handle area */
  }
  .draggable-pane :global(h5) {
    margin: var(--pane-h5-margin, 0.5em 0 0.3em 0);
    font-size: var(--pane-h5-font-size, 0.95em);
    font-weight: 500;
    opacity: 0.9;
  }
  .draggable-pane :global(h5:first-child) {
    margin-top: 0;
  }
  .draggable-pane :global(.section-label) {
    display: block;
    font-size: 0.9em;
    font-weight: 500;
    margin-bottom: 0.3em;
    opacity: 0.9;
  }
  .draggable-pane :global(.hint) {
    font-size: 0.85em;
    opacity: 0.65;
    margin: 0.3em 0 0 0;
  }
  .draggable-pane :global(hr) {
    border: none;
    background: var(--pane-hr-bg, var(--pane-card-border, rgba(0, 0, 0, 0.08)));
    margin: var(--pane-hr-margin, 4pt 0);
    height: 1px;
  }
  .draggable-pane :global(> section > div) {
    text-align: right; /* right align long line-breaking trajectory file names */
  }
  .draggable-pane :global(label) {
    display: inline-flex;
    align-items: center;
    gap: var(--pane-label-gap, 2pt);
  }
  .draggable-pane :global(input[type='text']) {
    flex: 1;
    padding: var(--pane-input-padding, 4px 6px);
    margin: var(--pane-input-margin, 0 0 0 5pt);
    background: var(--pane-input-bg, rgba(0, 0, 0, 0.03));
    border: 1px solid var(--pane-input-border, rgba(0, 0, 0, 0.1));
    border-radius: 6px;
  }
  .draggable-pane :global(input[type='text'].invalid) {
    border-color: var(--error-color, #ff6b6b);
    background: rgba(255, 107, 107, 0.1);
  }
  .draggable-pane :global(input[type='text'].invalid):focus {
    outline-color: var(--error-color, #ff6b6b);
    box-shadow: 0 0 0 2px rgba(255, 107, 107, 0.2);
  }
  .draggable-pane :global(input[type='range']) {
    margin-left: 4pt;
    width: 100px;
    flex-shrink: 0;
    flex: 1;
    min-width: 60px;
  }
  .draggable-pane :global(input[type='color']) {
    width: 2.5em;
    height: 1.3em;
    margin: 0 5pt;
  }
  .draggable-pane :global(input[type='number']) {
    box-sizing: border-box;
    text-align: center;
    width: 2.2em;
    margin: 0 3pt 0 6pt;
    flex-shrink: 0;
    background: var(--pane-input-bg, rgba(0, 0, 0, 0.03));
    border: 1px solid var(--pane-input-border, rgba(0, 0, 0, 0.1));
    border-radius: 6px;
  }
  .draggable-pane :global(input::-webkit-inner-spin-button) {
    display: none;
  }
  /* Default chrome for bare pane buttons. Wrapped in :where() so the whole
     selector has ZERO specificity — it acts as a fallback that any button which
     sets its own background (e.g. .btn-primary / .btn-compute accent buttons)
     overrides, instead of this global rule winning and graying them out. */
  :where(.draggable-pane) :global(:where(button)) {
    width: max-content;
    border-radius: 6px;
    background-color: var(--pane-btn-bg, var(--btn-bg));
  }
  :where(.draggable-pane) :global(:where(button:hover)) {
    background-color: var(--pane-btn-bg-hover, var(--btn-bg-hover));
  }
  .draggable-pane :global(select) {
    margin: 0 0 0 5pt;
    flex: 1;
    border-radius: 6px;
    padding: 4px 6px;
    font-size: 0.95em;
    background: var(--pane-input-bg, rgba(0, 0, 0, 0.03));
    border: 1px solid var(--pane-input-border, rgba(0, 0, 0, 0.1));
    color: inherit;
    color-scheme: inherit;
  }
  .draggable-pane :global(option) {
    background: var(--pane-bg, var(--page-bg));
    color: var(--text-color);
  }
  .draggable-pane :global(section) {
    background: var(--pane-card-bg, rgba(0, 0, 0, 0.03));
    border: 1px solid var(--pane-card-border, rgba(0, 0, 0, 0.08));
    border-radius: var(--pane-card-radius, 8px);
    padding: var(--pane-card-padding, 10px 12px);
    margin-bottom: var(--pane-card-gap, 6px);
  }
  .draggable-pane :global(.param-row) {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 0.4em;
    font-size: 0.95em;
  }
  .draggable-pane :global(.error) {
    color: var(--error-color, #ef4444);
    font-size: 0.95em;
    margin: 0.4em 0;
  }
  .draggable-pane :global(.warning) {
    color: var(--warning-color, #f59e0b);
    font-size: 0.95em;
    margin: 0.4em 0;
  }
  .draggable-pane :global(.success) {
    color: var(--success-color, #10b981);
    font-size: 0.95em;
    margin: 0.4em 0;
  }
  .draggable-pane :global(.checkbox-row) {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    font-size: 0.95em;
  }
  .draggable-pane :global(details) {
    font-size: 0.95em;
  }
  .draggable-pane :global(summary) {
    cursor: pointer;
    font-weight: 500;
    opacity: 0.9;
  }
  .draggable-pane :global(.pane-row) {
    display: flex;
    gap: 8pt;
    align-items: center;
  }
  .draggable-pane :global(.pane-grid) {
    display: grid;
    gap: 8pt;
    align-items: center;
  }
  .draggable-pane :global(label:has(input[type='range'])) {
    flex: 1;
  }
  .draggable-pane .control-buttons {
    display: flex;
    justify-content: end;
    align-items: center;
    position: sticky;
    top: 0;
    right: 0;
    height: 0;
    /* Cancel the 12 pt top/bottom padding without relying on width-based percentages */
    gap: 5px;
    padding: 12pt 3pt;
    margin-bottom: calc(-2 * 12pt);
    box-sizing: border-box;
    justify-self: end;
    z-index: var(--pane-control-buttons-z-index, 10);
  }
  .draggable-pane :global(.drag-handle) {
    width: 1.3em;
    height: 1.3em;
    cursor: grab;
    border-radius: 5px;
    padding: 2px;
    box-sizing: border-box;
    opacity: 0.6;
    background-color: color-mix(in srgb, currentColor 10%, transparent);
    pointer-events: auto; /* Re-enable pointer events for drag handle */
  }
  .draggable-pane :global(.drag-handle:hover) {
    opacity: 0.8;
    background-color: color-mix(in srgb, currentColor 20%, transparent);
  }
  /* Ensure drag handle cursor changes properly */
  .draggable-pane :global(.drag-handle:active) {
    cursor: grabbing;
  }
  /* Reset and close button styling */
  .draggable-pane :where(.reset-button, .close-button) {
    background: none;
    border: none;
    padding: 2px;
    border-radius: 5px;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s ease;
    width: 1.3em;
    height: 1.3em;
    opacity: 0.6;
    background-color: color-mix(in srgb, currentColor 10%, transparent);
  }
  .draggable-pane :where(.reset-button:hover, .close-button:hover) {
    opacity: 0.8;
    background-color: color-mix(in srgb, currentColor 20%, transparent);
  }
  /* Draggable header areas */
  .draggable-pane :global(.pane-title),
  .draggable-pane :global(.tab-bar) {
    cursor: grab;
  }
  .draggable-pane :global(.pane-title:active),
  .draggable-pane :global(.tab-bar:active) {
    cursor: grabbing;
  }
  .draggable-pane :global(.tab-bar button) {
    cursor: pointer;
  }
</style>

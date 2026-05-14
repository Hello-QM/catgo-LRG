<script lang="ts">
  import '$lib/pane-shared.css'
  import { Icon } from '$lib'
  import type { IconName } from '$lib/icons'
  import type { Snippet } from 'svelte'
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

        // Walk up to find a reasonably-sized container for clamping bounds.
        // node.offsetParent can be a tiny <SECTION> (30px) which makes dragging impossible.
        // Use the closest ancestor with substantial height, or fall back to viewport.
        function find_clamp_bounds(): { w: number; h: number } {
          let el = node.parentElement
          while (el) {
            if (el.clientHeight >= 200 && el.clientWidth >= 200) {
              return { w: el.clientWidth, h: el.clientHeight }
            }
            el = el.parentElement
          }
          return { w: window.innerWidth, h: window.innerHeight }
        }
        const bounds = find_clamp_bounds()

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
          const min_visible = 60
          const new_left = Math.max(-node.offsetWidth + min_visible, Math.min(initial_left + dx, bounds.w - min_visible))
          const new_top = Math.max(0, Math.min(initial_top + dy, bounds.h - min_visible))
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

  // Position calculation — returns { left, top, maxHeight } relative to positioned ancestor.
  // Clamps vertically so the pane never extends below the ancestor container.
  // Combines caller's max_height constraint with available-space clamping via CSS min().
  function calculate_position() {
    const margin = 20

    if (!toggle_pane_btn) {
      console.debug(`[DraggablePane] no toggle_pane_btn, using fallback position`)
      return { left: `50px`, top: `50px`, maxHeight: max_height || `` }
    }

    const toggle_rect = toggle_pane_btn.getBoundingClientRect()
    if (toggle_rect.width === 0 && toggle_rect.height === 0) {
      console.debug(`[DraggablePane] toggle button is hidden (0x0), deferring`)
      return { left: `50px`, top: `50px`, maxHeight: max_height || `` }
    }

    const pane_rect = pane_div?.getBoundingClientRect()
    // `||` would only catch width === 0; getBoundingClientRect can return a
    // tiny non-zero width during the same tick that show=true (race with
    // content layout). Treat anything below 100px as an unreliable
    // measurement and use the conservative fallback instead, so calc_left
    // doesn't pick a right-anchored position the actual (wider) pane will
    // overflow when it finishes laying out.
    const pane_width = (pane_rect && pane_rect.width >= 100) ? pane_rect.width : 450
    const pane_height = (pane_rect && pane_rect.height >= 50) ? pane_rect.height : 400
    const positioned_ancestor = toggle_pane_btn.offsetParent as HTMLElement
    const ancestor_rect = positioned_ancestor?.getBoundingClientRect()

    // Decide pane left position. Reasons in VIEWPORT coords because the
    // positioned ancestor (toggle_pane_btn.offsetParent) is only a
    // coordinate origin, not a fits-here constraint. When offsetParent
    // resolves to a small wrapper (e.g., a button-sized flex item near
    // the viewport's right edge — exactly what the trajectory info
    // toggle hits) using ancestor.width as the constraint makes both
    // right_open and left_open fail in the old algorithm; it then clamps
    // to ancestor-left = 0, and the pane lands AT the ancestor's left
    // edge — sitting near the viewport's right side, with the pane
    // overflowing past it. Viewport bounds are what users actually see.
    //
    // container_w is kept in the signature for callers but unused; if a
    // smaller logical containment is ever needed, gate behind a prop.
    function calc_left(btn_right: number, btn_left: number, origin_left: number, _container_w: number): number {
      const vw = window.innerWidth
      const right_open_vp = btn_right + (offset.x ?? 5)
      const left_open_vp = btn_left - pane_width - (offset.x ?? 5)
      // Prefer right of the button if the pane fits in the viewport;
      // otherwise flip to the left of the button.
      const target_vp = right_open_vp + pane_width <= vw - margin
        ? right_open_vp
        : left_open_vp
      // Clamp to viewport: pane's right edge ≤ vw − margin,
      // pane's left edge ≥ margin.
      const clamped_vp = Math.max(margin, Math.min(target_vp, vw - pane_width - margin))
      // Convert back to ancestor-relative for the inline `left:` style.
      // May be negative when the ancestor sits near the viewport's right
      // edge — that's correct; the pane extends leftward past the ancestor.
      return clamped_vp - origin_left
    }

    // Also fall back to viewport when the ancestor is too small to contain the pane.
    // Trajectory/split-pane layouts can resolve `offsetParent` to a small toolbar SECTION
    // whose height is much less than the pane needs, which collapses available_h to 0.
    if (!ancestor_rect || ancestor_rect.height === 0 || ancestor_rect.height < pane_height + margin * 2) {
      const vw = window.innerWidth
      const vh = window.innerHeight
      let top_px = toggle_rect.bottom + (offset.y ?? 5)
      // When the pane is too tall to fit at its natural anchored position, prefer
      // shrinking its `maxHeight` (the pane scrolls internally) over yanking it up
      // to the viewport edge, which would land it on top of OS title bars or
      // Tauri drag regions and prevent the user from grabbing the pane's drag
      // handle. Only pull `top_px` up when there isn't enough room below for a
      // minimally usable pane (200px), and never above a safe minimum (50px).
      const TOP_MIN = 50 // safety from OS chrome / Tauri drag regions
      const MIN_PANE_HEIGHT = 200
      if (top_px + MIN_PANE_HEIGHT > vh - margin) {
        top_px = Math.max(TOP_MIN, vh - MIN_PANE_HEIGHT - margin)
      }
      const left_px = calc_left(toggle_rect.right, toggle_rect.left, 0, vw)
      // Clamp max-height so the pane never extends below the viewport
      const available_h = `${vh - top_px - margin}px`
      const effective_max_h = max_height ? `min(${max_height}, ${available_h})` : available_h
      const result = { left: `${left_px}px`, top: `${top_px}px`, maxHeight: effective_max_h }
      // Switch to fixed positioning so coords are viewport-relative AND we escape
      // any `overflow: hidden` on the small ancestor that would otherwise clip the pane.
      if (pane_div) pane_div.style.position = `fixed`
      console.debug(`[DraggablePane] viewport fallback:`, { toggle_rect: { bottom: toggle_rect.bottom, right: toggle_rect.right }, vh, pane_height, result })
      return result
    }
    // Restore default positioning (CSS rule sets position: absolute) when the ancestor is adequate.
    if (pane_div && pane_div.style.position === `fixed`) pane_div.style.position = ``

    const ancestor_h = ancestor_rect.height
    let top_val = toggle_rect.bottom - ancestor_rect.top + (offset.y ?? 5)
    if (top_val + pane_height > ancestor_h - margin) {
      top_val = Math.max(margin, ancestor_h - pane_height - margin)
    }
    const left_val = calc_left(toggle_rect.right, toggle_rect.left, ancestor_rect.left, ancestor_rect.width)
    // Clamp max-height so the pane never extends below the ancestor container
    const available_h = `${ancestor_h - top_val - margin}px`
    const effective_max_h = max_height ? `min(${max_height}, ${available_h})` : available_h
    const result = { left: `${left_val}px`, top: `${top_val}px`, maxHeight: effective_max_h }
    console.debug(`[DraggablePane] positioned:`, {
      toggle: { bottom: toggle_rect.bottom, right: toggle_rect.right },
      ancestor: { top: ancestor_rect.top, height: ancestor_h, tag: positioned_ancestor?.tagName },
      pane: { width: pane_width, height: pane_height },
      result,
    })
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

  function handle_resize() { // Only reposition if pane is visible and hasn't been manually dragged
    if (!show || has_been_dragged || currently_dragging) return

    if (resize_timeout) clearTimeout(resize_timeout)
    const current_timeout = setTimeout(() => {
      if (resize_timeout !== current_timeout) return
      if (show && toggle_pane_btn && !has_been_dragged && pane_div) {
        const pos = calculate_position()
        initial_position = pos
        pane_div.style.left = pos.left
        pane_div.style.top = pos.top
        if (pos.maxHeight) pane_div.style.maxHeight = pos.maxHeight
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
        pane_div.style.maxWidth = ``
      }
    }
  })

  // Clamp pane max-height so it never extends below its containing boundary.
  // Uses the closest overflow-clipping ancestor (modal, .structure, etc.) or viewport.
  // Re-runs on show, resize, and content changes via ResizeObserver.
  function clamp_max_height() {
    if (!pane_div || !show) return
    const rect = pane_div.getBoundingClientRect()
    // Walk up to find the nearest overflow-clipping ancestor
    let bottom = window.innerHeight
    let el: HTMLElement | null = pane_div.offsetParent as HTMLElement | null
    while (el) {
      const style = getComputedStyle(el)
      if (style.overflowY === `hidden` || style.overflowY === `clip`) {
        bottom = el.getBoundingClientRect().bottom
        break
      }
      el = el.offsetParent as HTMLElement | null
    }
    const available = bottom - rect.top - 20
    if (available > 100) {
      const clamped = max_height ? `min(${max_height}, ${available}px)` : `${available}px`
      if (initial_position.maxHeight !== clamped) {
        initial_position = { ...initial_position, maxHeight: clamped }
      }
    }
  }

  $effect(() => {
    if (!show || !pane_div) return
    // Clamp on show and whenever the pane or its container resizes
    requestAnimationFrame(clamp_max_height)
    const ro = new ResizeObserver(() => clamp_max_height())
    ro.observe(pane_div)
    // Also observe the offsetParent (container) for modal resize
    if (pane_div.offsetParent instanceof HTMLElement) {
      ro.observe(pane_div.offsetParent)
    }
    return () => ro.disconnect()
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
    <button
      type="button"
      bind:this={toggle_pane_btn}
      aria-expanded={show}
      {...toggle_props}
      style={`font-size: clamp(1em, 2.2cqw, 1.2em); ${toggle_props.style ?? ``}`}
      onclick={toggle_pane}
      class="pane-toggle {show ? `active` : ``} {toggle_props.class ?? ``}"
      {@attach tooltip({ content: toggle_props.title ?? (show ? `Close pane` : `Open pane`) })}
    >
      <Icon icon={show ? open_icon : closed_icon} style={icon_style} />
    </button>
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
    style:max-width={max_width}
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
    position: absolute; /* Use absolute so pane scrolls with page content */
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
    max-width: var(--pane-max-width, 80cqw);
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
  .draggable-pane :global(button) {
    width: max-content;
    border-radius: 6px;
    background-color: var(--pane-btn-bg, var(--btn-bg));
  }
  .draggable-pane :global(button:hover) {
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

// RT13 drag-rotate FIX — root-caused, proven mechanism.
//
// ROOT CAUSE: src/lib/DraggablePane.svelte (~480-490) attaches a DIRECT
// listener on the pane-root div that calls `e.stopPropagation()` on
// `pointerdown`/`mousedown`/`pointermove`(no-button). Svelte 5 event
// delegation routes a template `onpointerdown={fn}` through ONE listener on
// the document root, reached only by the event BUBBLING all the way up. The
// pane-root `stop()` runs during that bubble (it is a real listener on an
// ANCESTOR of `.preview`) and kills propagation before the event ever
// reaches the document-root delegated dispatcher → the delegated
// `on_pointer_down` never fires → `dragging` stays false → every
// `pointermove` early-returns → no rotation.
//
// FIX: bind the preview's pointer handlers via THIS `use:` action, which
// does a DIRECT `node.addEventListener(...)` on the `.preview` element
// itself. A direct (non-delegated) listener on the descendant fires during
// the bubble phase AT that node — which happens BEFORE the event bubbles up
// to the ancestor pane-root where `stop()` runs. So this handler is immune
// to the delegation-kill. We do NOT touch the shared DraggablePane (editing
// it would risk every other pane). Pane-local, proven end-to-end.
//
// `setPointerCapture` is kept on the preview node so a drag that leaves the
// element still tracks. A non-drag pointerup is still detected (the optional
// `pick` hook) but the in-canvas click-to-select path it once drove has been
// retired (misaligned overlay), so no caller supplies `pick` today.

export type DragRotateHandlers = {
  /** pointerdown on the preview: begin a drag (capture pointer). */
  down: (e: PointerEvent) => void
  /** pointermove: accumulate rotation if dragging. */
  move: (e: PointerEvent) => void
  /** pointerup / pointerleave: end the drag (release capture). */
  up: (e: PointerEvent) => void
  /**
   * pointerup when NOT dragging: treat as a click. Optional — the in-canvas
   * click-to-pick path was retired (misaligned overlay), so callers no longer
   * supply this. Kept on the type as optional in case a future consumer wants
   * a non-drag click hook.
   */
  pick?: (e: PointerEvent) => void
  /** wheel over the preview: visual zoom (CSS scale). Optional. */
  wheel?: (e: WheelEvent) => void
  /** dblclick on the preview: reset visual zoom. Optional. */
  dblclick?: (e: MouseEvent) => void
}

/**
 * Svelte `use:` action. Attaches DIRECT (non-delegated) pointer listeners on
 * the node so they fire before the ancestor DraggablePane `stopPropagation`.
 * Handlers are read live via a getter so reactive closures stay fresh.
 */
export function drag_rotate(
  node: HTMLElement,
  get_handlers: () => DragRotateHandlers,
) {
  let dragged = false

  function on_down(e: PointerEvent) {
    dragged = false
    node.setPointerCapture?.(e.pointerId)
    get_handlers().down(e)
  }
  function on_move(e: PointerEvent) {
    // any movement with a button held marks this interaction as a drag
    if (e.buttons !== 0) dragged = true
    get_handlers().move(e)
  }
  function on_up(e: PointerEvent) {
    node.releasePointerCapture?.(e.pointerId)
    const h = get_handlers()
    h.up(e)
    // a pointerup with no intervening drag == a click; pick is optional now
    // that the in-canvas click-to-select path is retired.
    if (!dragged) h.pick?.(e)
    dragged = false
  }
  function on_leave(e: PointerEvent) {
    node.releasePointerCapture?.(e.pointerId)
    get_handlers().up(e)
    dragged = false
  }
  // Wheel zoom: a DIRECT, NON-PASSIVE listener so e.preventDefault() actually
  // suppresses page scroll (Svelte template onwheel can be passive). Bound on
  // the preview node — independent of the pointer-drag path above (rotation
  // is handled in wasm; zoom is a CSS transform layered on top), so the two
  // never interfere.
  function on_wheel(e: WheelEvent) {
    get_handlers().wheel?.(e)
  }
  // Double-click reset: zoom back to 1.
  function on_dblclick(e: MouseEvent) {
    get_handlers().dblclick?.(e)
  }

  node.addEventListener(`pointerdown`, on_down)
  node.addEventListener(`pointermove`, on_move)
  node.addEventListener(`pointerup`, on_up)
  node.addEventListener(`pointerleave`, on_leave)
  node.addEventListener(`wheel`, on_wheel, { passive: false })
  node.addEventListener(`dblclick`, on_dblclick)

  return {
    destroy() {
      node.removeEventListener(`pointerdown`, on_down)
      node.removeEventListener(`pointermove`, on_move)
      node.removeEventListener(`pointerup`, on_up)
      node.removeEventListener(`pointerleave`, on_leave)
      node.removeEventListener(`wheel`, on_wheel)
      node.removeEventListener(`dblclick`, on_dblclick)
    },
  }
}

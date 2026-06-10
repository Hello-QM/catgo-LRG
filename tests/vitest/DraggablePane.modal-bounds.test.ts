import { DraggablePane } from '$lib'
import { mount, tick } from 'svelte'
import { describe, expect, test, vi } from 'vitest'

/**
 * Regression: structure-viewer control panes escaping their modal.
 *
 * Inside StructureEditModal (.struct-edit3d-modal) the controls toggle sits
 * near the modal's right edge. DraggablePane's viewport-fallback positions
 * the pane `position: fixed` and prefers "right of the button if it fits the
 * VIEWPORT" — so the pane lands outside the modal, on top of the workflow
 * editor's side panels, where it looks unrelated and can't be used sensibly.
 *
 * When the toggle lives inside a modal, the pane must be constrained to the
 * modal's rect, not the viewport.
 */
describe(`DraggablePane modal containment`, () => {
  const click = async (el: Element) => {
    el.dispatchEvent(new MouseEvent(`click`, { bubbles: true, cancelable: true }))
    await tick()
    await new Promise((r) => setTimeout(r, 0))
  }

  test(`viewport-fallback pane stays within enclosing modal`, async () => {
    // Viewport 2000x1100; modal occupies x [110, 1512], y [50, 1050].
    vi.stubGlobal(`innerWidth`, 2000)
    vi.stubGlobal(`innerHeight`, 1100)

    const modal = document.createElement(`div`)
    modal.className = `struct-edit3d-modal`
    document.body.appendChild(modal)

    mount(DraggablePane, {
      target: modal,
      props: { children: () => `Pane Content`, show: true, show_pane: true },
    })

    const modal_rect = {
      left: 110, top: 50, right: 1512, bottom: 1050,
      width: 1402, height: 1000, x: 110, y: 50,
      toJSON: () => ({}),
    } as DOMRect
    // Toggle near the modal's right edge; pane measures 450x400.
    const toggle_rect = {
      left: 1450, top: 140, right: 1482, bottom: 172,
      width: 32, height: 32, x: 1450, y: 140,
      toJSON: () => ({}),
    } as DOMRect
    const pane_rect = {
      left: 0, top: 0, right: 450, bottom: 400,
      width: 450, height: 400, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect

    vi.spyOn(modal, `getBoundingClientRect`).mockReturnValue(modal_rect)
    const toggle = document.querySelector(`.pane-toggle`) as HTMLElement
    const pane = document.querySelector(`.draggable-pane`) as HTMLElement
    vi.spyOn(toggle, `getBoundingClientRect`).mockReturnValue(toggle_rect)
    vi.spyOn(pane, `getBoundingClientRect`).mockReturnValue(pane_rect)

    // Two clicks: first computes position (positioning side-effect), second opens.
    await click(toggle)
    await click(toggle)

    const left_px = Number.parseFloat(pane.style.left)
    expect(Number.isFinite(left_px)).toBe(true)
    // Pane must not extend past the modal's right edge (with its 20px margin):
    // old behavior put left ≈ 1487 (toggle.right + 5) because 1487+450 fits
    // the 2000px viewport — escaping the 1512px-wide modal entirely.
    expect(left_px + 450).toBeLessThanOrEqual(modal_rect.right)
    // And it must stay inside the modal's left edge too.
    expect(left_px).toBeGreaterThanOrEqual(modal_rect.left)
  })
})

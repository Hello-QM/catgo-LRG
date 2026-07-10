import {
  bring_to_front,
  clamp_docked_width,
  clamp_floating_bounds,
  DOCKED_DEFAULT_WIDTH,
  DOCKED_MIN_WIDTH,
  ensure_pane_panels_within,
  FLOATING_MIN,
  get_pane_panel,
  MIN_VIEWPORT_WIDTH,
  open_panel,
  panel_state,
  parse_persisted,
  remove_pane_panels,
  remove_tab_panels,
  set_dock_side,
  set_docked_width,
  set_floating_bounds,
  set_panel_mode,
  toggle_panel,
} from '$lib/panel/panel-state.svelte'
import { beforeEach, describe, expect, test } from 'vitest'

const HOST = { w: 800, h: 600 }
let seq = 0
// 每测试独立 tab 前缀, 隔离共享 module state
function quad() {
  seq += 1
  const tab = `t${seq}`
  return [1, 2, 3, 4].map((n) =>
    open_panel({ panel_type: `workflow`, pane_id: `${tab}:leaf-${n}` })
  )
}

beforeEach(() => {
  localStorage.clear()
})

describe(`per-pane independence (四宫格隔离)`, () => {
  test(`toggle only affects its own pane`, () => {
    const [p1, p2, p3, p4] = quad()
    toggle_panel(p1.id) // 收起 pane-1
    const st = panel_state().panels
    expect(st[p1.id].is_open).toBe(false)
    expect(st[p2.id].is_open).toBe(true)
    expect(st[p3.id].is_open).toBe(true)
    expect(st[p4.id].is_open).toBe(true)
  })

  test(`width change only affects its own pane`, () => {
    const [p1, p2] = quad()
    set_docked_width(p2.id, 300, HOST.w)
    expect(panel_state().panels[p2.id].docked_width).toBe(300)
    expect(panel_state().panels[p1.id].docked_width).toBe(DOCKED_DEFAULT_WIDTH)
  })

  test(`mode change only affects its own pane`, () => {
    const [p1, p2, p3, p4] = quad()
    set_panel_mode(p3.id, `floating`, HOST)
    const st = panel_state().panels
    expect(st[p3.id].mode).toBe(`floating`)
    for (const p of [p1, p2, p4]) expect(st[p.id].mode).toBe(`docked`)
  })

  test(`dock side change only affects its own pane`, () => {
    const [p1, p2] = quad()
    set_dock_side(p2.id, `right`)
    expect(panel_state().panels[p2.id].dock_side).toBe(`right`)
    expect(panel_state().panels[p1.id].dock_side).toBe(`left`)
  })

  test(`instances never share object references (深拷贝默认)`, () => {
    const [p1, p2] = quad()
    set_floating_bounds(p1.id, { x: 100, y: 100 }, HOST)
    const st = panel_state().panels
    expect(st[p1.id].floating_bounds).not.toBe(st[p2.id].floating_bounds)
    expect(st[p2.id].floating_bounds.x).not.toBe(100)
  })

  test(`ensure_pane_panels_within only reclamps that pane`, () => {
    const [p1, p2] = quad()
    set_docked_width(p1.id, 400, 800)
    set_docked_width(p2.id, 400, 800)
    ensure_pane_panels_within(panel_state().panels[p1.id].pane_id, { w: 400, h: 300 })
    const st = panel_state().panels
    expect(st[p1.id].docked_width).toBeLessThanOrEqual(400 - MIN_VIEWPORT_WIDTH)
    expect(st[p2.id].docked_width).toBe(400)
  })
})

describe(`lifecycle & cleanup`, () => {
  test(`same (type, pane) reuses the instance`, () => {
    const [p1] = quad()
    toggle_panel(p1.id)
    const again = open_panel({ panel_type: `workflow`, pane_id: p1.pane_id })
    expect(again.id).toBe(p1.id)
    expect(again.is_open).toBe(true)
  })

  test(`remove_pane_panels clears only that pane`, () => {
    const [p1, p2] = quad()
    remove_pane_panels(p1.pane_id)
    expect(panel_state().panels[p1.id]).toBeUndefined()
    expect(panel_state().panels[p2.id]).toBeDefined()
    expect(get_pane_panel(`workflow`, p1.pane_id)).toBeNull()
  })

  test(`remove_tab_panels clears every pane of the tab`, () => {
    const [p1, p2, p3, p4] = quad()
    const tab = p1.pane_id.split(`:`)[0]
    remove_tab_panels(tab)
    const st = panel_state().panels
    for (const p of [p1, p2, p3, p4]) expect(st[p.id]).toBeUndefined()
  })

  test(`mode switch keeps id and target`, () => {
    const [p1] = quad()
    const ctx = { scope: `viewport` as const, viewport_id: p1.pane_id, display_index: 1 }
    panel_state().panels[p1.id].target = ctx
    set_panel_mode(p1.id, `floating`, HOST)
    set_panel_mode(p1.id, `docked`)
    expect(panel_state().panels[p1.id].id).toBe(p1.id)
    expect(panel_state().panels[p1.id].target).toEqual(ctx)
  })
})

describe(`pane-scoped geometry clamps`, () => {
  test(`docked width dynamic max: min(420, 60% pane, pane − viewport 保底)`, () => {
    expect(clamp_docked_width(9999, 1200)).toBe(420)
    expect(clamp_docked_width(9999, 600)).toBe(360) // 60% of 600
    expect(clamp_docked_width(9999, 400)).toBe(240) // 400 − 160 viewport
    expect(clamp_docked_width(0, 1200)).toBe(DOCKED_MIN_WIDTH)
  })

  test(`floating bounds clamp inside the pane`, () => {
    const b = clamp_floating_bounds({ x: 9999, y: 9999, width: 9999, height: 9999 }, {
      w: 500,
      h: 400,
    })
    expect(b.width).toBe(500 - 16)
    expect(b.height).toBe(400 - 16)
    expect(b.x).toBe(8)
    expect(b.y).toBe(8)
    const tiny = clamp_floating_bounds({ width: 1, height: 1 }, { w: 500, h: 400 })
    expect(tiny.width).toBe(FLOATING_MIN.width)
    expect(tiny.height).toBe(FLOATING_MIN.height)
  })

  test(`z-index bring_to_front monotonic`, () => {
    const [p1, p2] = quad()
    bring_to_front(p1.id)
    const z1 = panel_state().panels[p1.id].z_index
    expect(z1).toBeGreaterThan(panel_state().panels[p2.id].z_index)
    bring_to_front(p2.id)
    expect(panel_state().panels[p2.id].z_index).toBeGreaterThan(z1)
  })
})

describe(`persistence templates & migration`, () => {
  test(`corrupt JSON falls back to defaults`, () => {
    expect(parse_persisted(`{oops`)).toEqual({})
    expect(parse_persisted(`null`)).toEqual({})
    expect(parse_persisted(JSON.stringify({ version: 99 }))).toEqual({})
  })

  test(`v1 global schema migrates to per-type template`, () => {
    const v1 = JSON.stringify({
      version: 1,
      panels: {
        workflow: {
          mode: `floating`,
          docked_width: 999,
          floating_bounds: { x: 1, y: 2, width: 500, height: 400 },
        },
      },
    })
    const tpl = parse_persisted(v1)
    expect(tpl.workflow.mode).toBe(`floating`)
    expect(tpl.workflow.docked_width).toBeLessThanOrEqual(420)
    expect(tpl.workflow.floating_bounds).toMatchObject({ width: 500, height: 400 })
  })

  test(`new instances copy template but stay independent`, () => {
    localStorage.setItem(
      `catgo:panels`,
      JSON.stringify({
        version: 2,
        templates: { workflow: { mode: `docked`, dock_side: `right`, docked_width: 300 } },
      }),
    )
    const a = open_panel({ panel_type: `workflow`, pane_id: `tx:leaf-a` })
    const b = open_panel({ panel_type: `workflow`, pane_id: `tx:leaf-b` })
    expect(a.dock_side).toBe(`right`)
    expect(b.docked_width).toBe(300)
    set_docked_width(a.id, 200, 800)
    expect(panel_state().panels[b.id].docked_width).toBe(300) // 模板拷贝, 不共享
  })
})

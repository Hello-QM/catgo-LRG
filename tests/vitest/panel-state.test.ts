import {
  bring_to_front,
  clamp_docked_width,
  clamp_floating_bounds,
  close_panel,
  DOCKED_DEFAULT_WIDTH,
  FLOATING_MIN,
  get_panel_by_type,
  open_panel,
  panel_state,
  parse_persisted,
  set_docked_width,
  set_floating_bounds,
  set_panel_mode,
  set_panel_target,
} from '$lib/panel/panel-state.svelte'
import { beforeEach, describe, expect, test } from 'vitest'

function fresh(type: string) {
  // 每类型单实例 — 用独立类型名隔离各测试
  return open_panel({ panel_type: type })
}

beforeEach(() => {
  localStorage.clear()
})

describe(`panel instance lifecycle`, () => {
  test(`create panel instance with defaults`, () => {
    const p = fresh(`t-create`)
    expect(p.id).toMatch(/^panel-\d+$/)
    expect(p.mode).toBe(`docked`)
    expect(p.is_open).toBe(true)
    expect(p.docked_width).toBe(DOCKED_DEFAULT_WIDTH)
    expect(p.target_policy).toBe(`user-selectable`)
  })

  test(`one instance per panel_type — reopen returns same instance`, () => {
    const a = fresh(`t-singleton`)
    close_panel(a.id)
    const b = open_panel({ panel_type: `t-singleton` })
    expect(b.id).toBe(a.id)
    expect(b.is_open).toBe(true)
    expect(get_panel_by_type(`t-singleton`)?.id).toBe(a.id)
  })

  test(`docked → floating → docked keeps the same id`, () => {
    const p = fresh(`t-mode`)
    const id = p.id
    set_panel_mode(id, `floating`)
    expect(panel_state().panels[id].mode).toBe(`floating`)
    expect(panel_state().panels[id].id).toBe(id)
    set_panel_mode(id, `docked`)
    expect(panel_state().panels[id].mode).toBe(`docked`)
    expect(panel_state().panels[id].id).toBe(id)
  })

  test(`mode switch preserves targetContext`, () => {
    const p = fresh(`t-target`)
    const ctx = {
      scope: `viewport` as const,
      viewport_id: `structure-1:leaf-42`,
      display_index: 2,
      file_name: `MOF-808_Nd_adsorbed.cif`,
    }
    set_panel_target(p.id, ctx)
    set_panel_mode(p.id, `floating`)
    set_panel_mode(p.id, `docked`)
    expect(panel_state().panels[p.id].target).toEqual(ctx)
  })
})

describe(`geometry clamps`, () => {
  test(`docked width clamps to [280, 480] on wide hosts`, () => {
    expect(clamp_docked_width(100, 1920)).toBe(280)
    expect(clamp_docked_width(320, 1920)).toBe(320)
    expect(clamp_docked_width(9999, 1920)).toBe(480)
  })

  test(`docked width max tightens to 40% on narrow hosts`, () => {
    expect(clamp_docked_width(480, 1000)).toBe(400) // 40% of 1000
    // 极窄宿主: 40% < min 时下限优先 (不产生负/零宽)
    expect(clamp_docked_width(480, 500)).toBe(280)
  })

  test(`floating bounds clamp size and keep title visible`, () => {
    const host = { w: 1280, h: 720 }
    const b = clamp_floating_bounds({ x: 5000, y: 5000, width: 9999, height: 9999 }, host)
    expect(b.width).toBe(Math.round(1280 * 0.9))
    expect(b.height).toBe(Math.round(720 * 0.9))
    expect(b.x).toBeLessThanOrEqual(1280 - 80) // 左缘保留 80px 可抓
    expect(b.y).toBeLessThanOrEqual(720 - 40) // 标题栏可见
    const tiny = clamp_floating_bounds({ width: 10, height: 10 }, host)
    expect(tiny.width).toBe(FLOATING_MIN.width)
    expect(tiny.height).toBe(FLOATING_MIN.height)
    const off = clamp_floating_bounds({ x: -9999, y: -9999, width: 400, height: 300 }, host)
    expect(off.x).toBeGreaterThanOrEqual(80 - 400)
    expect(off.y).toBeGreaterThanOrEqual(8)
  })

  test(`set_docked_width / set_floating_bounds apply clamps to instance`, () => {
    const p = fresh(`t-clamp`)
    set_docked_width(p.id, 10)
    expect(panel_state().panels[p.id].docked_width).toBe(280)
    set_floating_bounds(p.id, { width: 1, height: 1 })
    expect(panel_state().panels[p.id].floating_bounds.width).toBe(FLOATING_MIN.width)
  })
})

describe(`z-order`, () => {
  test(`bring_to_front is monotonic across panels`, () => {
    const a = fresh(`t-z-a`)
    const b = fresh(`t-z-b`)
    bring_to_front(a.id)
    const za = panel_state().panels[a.id].z_index
    expect(za).toBeGreaterThan(panel_state().panels[b.id].z_index)
    bring_to_front(b.id)
    expect(panel_state().panels[b.id].z_index).toBeGreaterThan(za)
  })
})

describe(`persistence`, () => {
  test(`corrupt JSON falls back to defaults`, () => {
    expect(parse_persisted(`{not json!!`)).toEqual({})
    expect(parse_persisted(`null`)).toEqual({})
    expect(parse_persisted(JSON.stringify({ version: 99, panels: {} }))).toEqual({})
  })

  test(`out-of-range persisted values are clamped on parse`, () => {
    const raw = JSON.stringify({
      version: 1,
      panels: {
        workflow: {
          mode: `floating`,
          docked_width: 9999,
          floating_bounds: { x: -99999, y: -99999, width: 5, height: 5 },
          collapsed: false,
        },
        junk: { mode: `sideways`, docked_width: `wide` },
      },
    })
    const parsed = parse_persisted(raw)
    expect(parsed.workflow.mode).toBe(`floating`)
    expect(parsed.workflow.docked_width).toBeLessThanOrEqual(480)
    expect(parsed.workflow.floating_bounds!.width).toBe(FLOATING_MIN.width)
    expect(parsed.workflow.floating_bounds!.y).toBeGreaterThanOrEqual(8)
    expect(parsed.junk.mode).toBeUndefined()
    expect(parsed.junk.docked_width).toBeUndefined()
  })

  test(`mode and geometry survive a reopen via storage`, () => {
    const p = fresh(`t-persist`)
    set_panel_mode(p.id, `floating`)
    set_floating_bounds(p.id, { x: 100, y: 120, width: 400, height: 300 })
    const raw = localStorage.getItem(`catgo:panels`)
    expect(raw).toBeTruthy()
    const parsed = parse_persisted(raw)
    expect(parsed[`t-persist`].mode).toBe(`floating`)
    expect(parsed[`t-persist`].floating_bounds).toMatchObject({ x: 100, y: 120 })
  })
})

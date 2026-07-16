import {
  pane_toolbar,
  remove_pane_toolbar,
  set_toolbar_dock,
  toggle_toolbar_tool,
  toolbar_tool_hidden,
} from '$lib/structure/toolbar-state.svelte'
import { beforeEach, expect, test } from 'vitest'

let seq = 0
const quad = () => {
  seq += 1
  return [1, 2, 3, 4].map((n) => `tb${seq}:leaf-${n}`)
}

beforeEach(() => localStorage.clear())

test(`四向停靠同存, 改一不动三`, () => {
  const [a, b, c, d] = quad()
  set_toolbar_dock(a, `left`)
  set_toolbar_dock(b, `right`)
  set_toolbar_dock(c, `bottom`)
  set_toolbar_dock(d, `top`)
  expect(pane_toolbar(a).dock).toBe(`left`)
  expect(pane_toolbar(b).dock).toBe(`right`)
  expect(pane_toolbar(c).dock).toBe(`bottom`)
  expect(pane_toolbar(d).dock).toBe(`top`)
  set_toolbar_dock(b, `left`)
  expect(pane_toolbar(a).dock).toBe(`left`)
  expect(pane_toolbar(c).dock).toBe(`bottom`)
  expect(pane_toolbar(d).dock).toBe(`top`)
})

test(`勾选项按 pane 独立`, () => {
  const [a, b] = quad()
  set_toolbar_dock(a, `right`)
  set_toolbar_dock(b, `right`)
  toggle_toolbar_tool(a, `info`)
  expect(toolbar_tool_hidden(a, `info`)).toBe(true)
  expect(toolbar_tool_hidden(b, `info`)).toBe(false)
})

test(`模板深拷贝 — 不共享对象引用`, () => {
  const [a, b] = quad()
  expect(pane_toolbar(a).hidden_by_dock).not.toBe(pane_toolbar(b).hidden_by_dock)
  expect(pane_toolbar(a).hidden_by_dock.top).not.toBe(pane_toolbar(b).hidden_by_dock.top)
})

test(`最近改动作为模板, 新 pane 继承但独立`, () => {
  const [a] = quad()
  set_toolbar_dock(a, `top`)
  const fresh = pane_toolbar(`tbx:leaf-new`)
  expect(fresh.dock).toBe(`top`) // 模板继承
  set_toolbar_dock(`tbx:leaf-new`, `bottom`)
  expect(pane_toolbar(a).dock).toBe(`top`) // 互不影响
})

test(`remove_pane_toolbar 清理后重建为模板态`, () => {
  const [a] = quad()
  toggle_toolbar_tool(a, `some_tool`)
  remove_pane_toolbar(a)
  localStorage.clear() // 模板也清 → 全新默认
  expect(toolbar_tool_hidden(a, `some_tool`)).toBe(false)
})

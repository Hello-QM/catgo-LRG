import { afterEach, describe, expect, it } from 'vitest'
import {
  active_cwd,
  add_tab,
  clear_tabs,
  close_tab,
  close_tabs_for_session,
  ensure_tab,
  MAX_TABS,
  path_basename,
  set_tab_cwd,
  switch_tab,
  term_tabs,
} from '../terminal-tabs.svelte'

// Module-level state persists between tests — reset it each time.
afterEach(() => clear_tabs())

describe(`path_basename`, () => {
  it(`returns the last path segment`, () => {
    expect(path_basename(`/home/u/proj`)).toBe(`proj`)
  })
  it(`ignores a trailing slash`, () => {
    expect(path_basename(`/home/u/proj/`)).toBe(`proj`)
  })
  it(`maps root to /`, () => {
    expect(path_basename(`/`)).toBe(`/`)
  })
  it(`returns empty for empty input`, () => {
    expect(path_basename(``)).toBe(``)
  })
  it(`returns a no-slash relative path unchanged`, () => {
    expect(path_basename(`proj`)).toBe(`proj`)
  })
})

describe(`terminal-tabs registry`, () => {
  it(`ensure_tab seeds exactly one active tab for a new session`, () => {
    ensure_tab(`s1`, `me@a`)
    expect(term_tabs.tabs.length).toBe(1)
    expect(term_tabs.active_id).toBe(term_tabs.tabs[0].id)
    expect(term_tabs.tabs[0].session_id).toBe(`s1`)
    expect(term_tabs.tabs[0].cluster).toBe(`me@a`)
  })

  it(`ensure_tab refocuses (not duplicates) a session that already has tabs`, () => {
    ensure_tab(`s1`, `me@a`)
    const first = term_tabs.tabs[0].id
    add_tab(`s1`, `me@a`)
    ensure_tab(`s1`, `me@a`)
    expect(term_tabs.tabs.length).toBe(2)
    expect(term_tabs.active_id).toBe(first)
  })

  it(`tabs from several sessions coexist — connecting B keeps A's tabs`, () => {
    ensure_tab(`s1`, `me@a`)
    ensure_tab(`s2`, `me@b`)
    expect(term_tabs.tabs.length).toBe(2)
    expect(term_tabs.tabs.map((t) => t.session_id)).toEqual([`s1`, `s2`])
  })

  it(`add_tab appends, activates, and caps at MAX_TABS`, () => {
    ensure_tab(`s1`, `me@a`) // 1 tab
    for (let i = 0; i < 10; i++) add_tab(`s1`, `me@a`)
    expect(term_tabs.tabs.length).toBe(MAX_TABS)
    expect(add_tab(`s1`, `me@a`)).toBeNull()
    const last = term_tabs.tabs[term_tabs.tabs.length - 1]
    expect(term_tabs.active_id).toBe(last.id)
  })

  it(`switch_tab changes the active tab and ignores unknown ids`, () => {
    ensure_tab(`s1`, `me@a`)
    const first = term_tabs.tabs[0].id
    add_tab(`s1`, `me@a`)
    switch_tab(first)
    expect(term_tabs.active_id).toBe(first)
    switch_tab(`nope`)
    expect(term_tabs.active_id).toBe(first)
  })

  it(`close_tab removes the tab and reassigns the active selection`, () => {
    ensure_tab(`s1`, `me@a`)
    const a = term_tabs.tabs[0].id
    add_tab(`s1`, `me@a`)
    const b = term_tabs.active_id as string
    close_tab(b)
    expect(term_tabs.tabs.some((t) => t.id === b)).toBe(false)
    expect(term_tabs.active_id).toBe(a)
  })

  it(`closing the last tab respawns a fresh one on the SAME cluster`, () => {
    ensure_tab(`s1`, `me@a`)
    const only = term_tabs.tabs[0].id
    close_tab(only)
    expect(term_tabs.tabs.length).toBe(1)
    expect(term_tabs.tabs[0].id).not.toBe(only)
    expect(term_tabs.tabs[0].session_id).toBe(`s1`)
  })

  it(`close_tab is a no-op for an unknown id`, () => {
    ensure_tab(`s1`, `me@a`)
    add_tab(`s1`, `me@a`)
    const before = term_tabs.tabs.length
    const active = term_tabs.active_id
    close_tab(`nope`)
    expect(term_tabs.tabs.length).toBe(before)
    expect(term_tabs.active_id).toBe(active)
  })

  it(`closing a NON-active tab leaves the active selection unchanged`, () => {
    ensure_tab(`s1`, `me@a`)
    const a = term_tabs.tabs[0].id
    add_tab(`s1`, `me@a`) // b, now active
    const b = term_tabs.active_id as string
    close_tab(a)
    expect(term_tabs.active_id).toBe(b)
    expect(term_tabs.tabs.some((t) => t.id === a)).toBe(false)
  })

  it(`set_tab_cwd updates cwd; active_cwd follows the active tab`, () => {
    ensure_tab(`s1`, `me@a`)
    const a = term_tabs.tabs[0].id
    add_tab(`s1`, `me@a`)
    const b = term_tabs.active_id as string
    set_tab_cwd(a, `/home/u/alpha`)
    set_tab_cwd(b, `/home/u/beta`)
    expect(active_cwd()).toBe(`/home/u/beta`) // b is active
    switch_tab(a)
    expect(active_cwd()).toBe(`/home/u/alpha`)
  })

  it(`close_tabs_for_session removes only that cluster's tabs (no respawn)`, () => {
    ensure_tab(`s1`, `me@a`)
    add_tab(`s1`, `me@a`)
    ensure_tab(`s2`, `me@b`)
    close_tabs_for_session(`s1`)
    expect(term_tabs.tabs.length).toBe(1)
    expect(term_tabs.tabs[0].session_id).toBe(`s2`)
    expect(term_tabs.active_id).toBe(term_tabs.tabs[0].id)
  })

  it(`close_tabs_for_session of the LAST cluster leaves an empty strip`, () => {
    ensure_tab(`s1`, `me@a`)
    close_tabs_for_session(`s1`)
    expect(term_tabs.tabs.length).toBe(0)
    expect(term_tabs.active_id).toBe(null)
  })
})

describe(`clusters registry`, () => {
  it(`register / switch / remove round-trip`, async () => {
    const { clusters, get_active_cluster, register_cluster, remove_cluster, set_active_cluster } =
      await import(`../clusters.svelte`)
    clusters.list.length = 0
    clusters.active_key = null

    register_cluster({ key: `a:22:u`, session_id: `s1`, host: `a`, port: 22, username: `u`, label: `u@a` })
    register_cluster({ key: `b:22:u`, session_id: `s2`, host: `b`, port: 22, username: `u`, label: `u@b` })
    expect(clusters.list.length).toBe(2)
    expect(clusters.active_key).toBe(`b:22:u`) // newest connect becomes active

    set_active_cluster(`a:22:u`)
    expect(get_active_cluster()?.session_id).toBe(`s1`)

    // Removing the active cluster activates the remaining one.
    const next = remove_cluster(`a:22:u`)
    expect(next?.key).toBe(`b:22:u`)
    expect(clusters.active_key).toBe(`b:22:u`)

    // Removing the last leaves none.
    expect(remove_cluster(`b:22:u`)).toBe(null)
    expect(clusters.active_key).toBe(null)
  })

  it(`re-registering the same endpoint refreshes instead of duplicating`, async () => {
    const { clusters, register_cluster } = await import(`../clusters.svelte`)
    clusters.list.length = 0
    clusters.active_key = null
    register_cluster({ key: `a:22:u`, session_id: `s1`, host: `a`, port: 22, username: `u`, label: `u@a` })
    register_cluster({ key: `a:22:u`, session_id: `s9`, host: `a`, port: 22, username: `u`, label: `nick` })
    expect(clusters.list.length).toBe(1)
    expect(clusters.list[0].session_id).toBe(`s9`)
    expect(clusters.list[0].label).toBe(`nick`)
  })
})

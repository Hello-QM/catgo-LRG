import { afterEach, describe, expect, it } from 'vitest'
import {
  active_cwd,
  add_tab,
  clear_tabs,
  close_tab,
  MAX_TABS,
  path_basename,
  reset_for_session,
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
})

describe(`terminal-tabs registry`, () => {
  it(`reset_for_session seeds exactly one active tab`, () => {
    reset_for_session(`s1`)
    expect(term_tabs.tabs.length).toBe(1)
    expect(term_tabs.active_id).toBe(term_tabs.tabs[0].id)
    expect(term_tabs.session_id).toBe(`s1`)
  })

  it(`reset_for_session is idempotent for the same session`, () => {
    reset_for_session(`s1`)
    add_tab()
    const n = term_tabs.tabs.length
    reset_for_session(`s1`) // same session, has tabs → no wipe
    expect(term_tabs.tabs.length).toBe(n)
  })

  it(`reset_for_session wipes when the session changes`, () => {
    reset_for_session(`s1`)
    add_tab()
    reset_for_session(`s2`)
    expect(term_tabs.tabs.length).toBe(1)
    expect(term_tabs.session_id).toBe(`s2`)
  })

  it(`add_tab appends, activates, and caps at MAX_TABS`, () => {
    reset_for_session(`s1`) // 1 tab
    for (let i = 0; i < 10; i++) add_tab()
    expect(term_tabs.tabs.length).toBe(MAX_TABS)
    expect(add_tab()).toBeNull()
    const last = term_tabs.tabs[term_tabs.tabs.length - 1]
    expect(term_tabs.active_id).toBe(last.id)
  })

  it(`switch_tab changes the active tab and ignores unknown ids`, () => {
    reset_for_session(`s1`)
    const first = term_tabs.tabs[0].id
    add_tab()
    switch_tab(first)
    expect(term_tabs.active_id).toBe(first)
    switch_tab(`nope`)
    expect(term_tabs.active_id).toBe(first)
  })

  it(`close_tab removes the tab and reassigns the active selection`, () => {
    reset_for_session(`s1`)
    const a = term_tabs.tabs[0].id
    add_tab()
    const b = term_tabs.active_id as string
    close_tab(b)
    expect(term_tabs.tabs.some((t) => t.id === b)).toBe(false)
    expect(term_tabs.active_id).toBe(a)
  })

  it(`closing the last tab respawns a fresh one`, () => {
    reset_for_session(`s1`)
    const only = term_tabs.tabs[0].id
    close_tab(only)
    expect(term_tabs.tabs.length).toBe(1)
    expect(term_tabs.tabs[0].id).not.toBe(only)
  })

  it(`set_tab_cwd updates cwd; active_cwd follows the active tab`, () => {
    reset_for_session(`s1`)
    const a = term_tabs.tabs[0].id
    add_tab()
    const b = term_tabs.active_id as string
    set_tab_cwd(a, `/home/u/alpha`)
    set_tab_cwd(b, `/home/u/beta`)
    expect(active_cwd()).toBe(`/home/u/beta`) // b is active
    switch_tab(a)
    expect(active_cwd()).toBe(`/home/u/alpha`)
  })
})

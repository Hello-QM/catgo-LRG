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
  toggle_edit_mode,
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

describe(`terminal-tabs registry — edge cases`, () => {
  it(`path_basename returns a no-slash relative path unchanged`, () => {
    expect(path_basename(`proj`)).toBe(`proj`)
  })

  it(`close_tab is a no-op for an unknown id`, () => {
    reset_for_session(`s1`)
    add_tab()
    const before = term_tabs.tabs.length
    const active = term_tabs.active_id
    close_tab(`nope`)
    expect(term_tabs.tabs.length).toBe(before)
    expect(term_tabs.active_id).toBe(active)
  })

  it(`closing a NON-active tab leaves the active selection unchanged`, () => {
    reset_for_session(`s1`)
    const a = term_tabs.tabs[0].id
    add_tab() // b, now active
    const b = term_tabs.active_id as string
    close_tab(a) // close the inactive one
    expect(term_tabs.active_id).toBe(b)
    expect(term_tabs.tabs.some((t) => t.id === a)).toBe(false)
  })

  it(`switch_tab ignores an id that was closed`, () => {
    reset_for_session(`s1`)
    const a = term_tabs.tabs[0].id
    add_tab()
    const b = term_tabs.active_id as string
    close_tab(a)
    switch_tab(a) // a no longer exists
    expect(term_tabs.active_id).toBe(b)
  })

  it(`active_cwd is empty when there is no active tab`, () => {
    clear_tabs()
    expect(active_cwd()).toBe(``)
  })

  it(`set_tab_cwd is a no-op for an unknown id`, () => {
    reset_for_session(`s1`)
    expect(() => set_tab_cwd(`nope`, `/x`)).not.toThrow()
    expect(active_cwd()).toBe(``)
  })

  it(`edit_mode toggles, and drops back off once only one tab remains`, () => {
    reset_for_session(`s1`)
    add_tab() // 2 tabs
    toggle_edit_mode()
    expect(term_tabs.edit_mode).toBe(true)
    close_tab(term_tabs.active_id as string) // back to 1 tab
    expect(term_tabs.edit_mode).toBe(false)
  })

  it(`reset_for_session clears a lingering edit_mode`, () => {
    reset_for_session(`s1`)
    add_tab()
    toggle_edit_mode()
    reset_for_session(`s2`) // different session → fresh state
    expect(term_tabs.edit_mode).toBe(false)
  })
})

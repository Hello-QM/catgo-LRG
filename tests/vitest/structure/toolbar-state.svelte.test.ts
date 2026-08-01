import { beforeEach, describe, expect, test } from 'vitest'
import {
  _reset_toolbar_state_for_test,
  pane_toolbar,
  register_toolbar_pane,
  reset_toolbar,
  set_toolbar_collapsed,
  set_toolbar_tool_visible,
} from '$lib/structure/toolbar-state.svelte'

describe(`structure toolbar state`, () => {
  beforeEach(() => _reset_toolbar_state_for_test())

  test(`keeps panes independent while persisting the latest settings as defaults`, () => {
    register_toolbar_pane(`pane-b`)
    expect(pane_toolbar(`pane-b`)).toEqual({ collapsed: false, hidden: [] })
    set_toolbar_tool_visible(`pane-a`, `build`, false)
    set_toolbar_collapsed(`pane-a`, true)

    expect(pane_toolbar(`pane-a`)).toEqual({ collapsed: true, hidden: [`build`] })
    // An already-mounted sibling keeps its own state.
    expect(pane_toolbar(`pane-b`)).toEqual({ collapsed: false, hidden: [] })

    // New panes use the latest saved configuration as their template.
    register_toolbar_pane(`pane-c`)
    expect(pane_toolbar(`pane-c`)).toEqual({ collapsed: true, hidden: [`build`] })
  })

  test(`filters unknown persisted tool ids`, () => {
    localStorage.setItem(`catgo:structure-toolbar:v1`, JSON.stringify({
      collapsed: true,
      hidden: [`build`, `removed-tool`, 42],
    }))

    expect(pane_toolbar(`pane-a`)).toEqual({ collapsed: true, hidden: [`build`] })
  })

  test(`migrates the legacy PR496 keys once`, () => {
    localStorage.setItem(`catgo:toolbar:collapsed`, `true`)
    localStorage.setItem(`catgo:toolbar:hidden-tools`, JSON.stringify([`analysis`]))

    expect(pane_toolbar(`pane-a`)).toEqual({ collapsed: true, hidden: [`analysis`] })
    expect(localStorage.getItem(`catgo:toolbar:collapsed`)).toBeNull()
    expect(localStorage.getItem(`catgo:toolbar:hidden-tools`)).toBeNull()
    expect(JSON.parse(localStorage.getItem(`catgo:structure-toolbar:v1`) ?? `{}`)).toEqual({
      collapsed: true,
      hidden: [`analysis`],
    })
  })

  test(`restores the product defaults`, () => {
    set_toolbar_collapsed(`pane-a`, true)
    set_toolbar_tool_visible(`pane-a`, `chat`, false)
    reset_toolbar(`pane-a`)

    expect(pane_toolbar(`pane-a`)).toEqual({ collapsed: false, hidden: [] })
  })
})

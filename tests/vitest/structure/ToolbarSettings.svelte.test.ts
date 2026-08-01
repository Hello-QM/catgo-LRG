import { render, within } from '@testing-library/svelte'
import { tick } from 'svelte'
import { beforeEach, describe, expect, test } from 'vitest'
import ToolbarSettings from '$lib/structure/ToolbarSettings.svelte'
import {
  _reset_toolbar_state_for_test,
  pane_toolbar,
} from '$lib/structure/toolbar-state.svelte'

describe(`ToolbarSettings`, () => {
  beforeEach(() => _reset_toolbar_state_for_test())

  test(`lists only available, user-configurable tools`, async () => {
    const view = render(ToolbarSettings, {
      pane_key: `pane-a`,
      available_tools: [`fullscreen`, `analysis`, `server`],
      forced_hidden: [`server`],
    })

    view.getByRole(`button`, { name: `Customize toolbar` }).click()
    await tick()

    expect(view.getByRole(`checkbox`, { name: `Fullscreen` })).toBeTruthy()
    expect(view.getByRole(`checkbox`, { name: `Analysis tools` })).toBeTruthy()
    expect(view.queryByRole(`checkbox`, { name: `Server / HPC` })).toBeNull()
    expect(view.queryByRole(`checkbox`, { name: `Build tools` })).toBeNull()
  })

  test(`customizes panes independently and restores defaults`, async () => {
    const first = render(ToolbarSettings, {
      pane_key: `pane-a`,
      available_tools: [`build`, `analysis`],
    })
    const second = render(ToolbarSettings, {
      pane_key: `pane-b`,
      available_tools: [`build`, `analysis`],
    })

    within(first.container).getByRole(`button`, { name: `Customize toolbar` }).click()
    await tick()

    const first_build = within(first.container).getByRole(`checkbox`, { name: `Build tools` })
    first_build.click()
    await tick()

    expect(pane_toolbar(`pane-a`).hidden).toEqual([`build`])
    expect(pane_toolbar(`pane-b`).hidden).toEqual([])
    within(second.container).getByRole(`button`, { name: `Customize toolbar` }).click()
    await tick()
    expect((within(second.container).getByRole(
      `checkbox`,
      { name: `Build tools` },
    ) as HTMLInputElement).checked).toBe(true)

    within(second.container).getByRole(`button`, { name: `Customize toolbar` }).click()
    within(first.container).getByRole(`button`, { name: `Customize toolbar` }).click()
    await tick()
    within(first.container).getByRole(`button`, { name: `Restore defaults` }).click()
    await tick()
    expect(pane_toolbar(`pane-a`)).toEqual({ collapsed: false, hidden: [] })
  })

  test(`collapses to one accessible button and expands again`, async () => {
    const view = render(ToolbarSettings, {
      pane_key: `pane-a`,
      available_tools: [`fullscreen`],
    })

    view.getByRole(`button`, { name: `Collapse toolbar` }).click()
    await tick()
    expect(view.queryByRole(`button`, { name: `Customize toolbar` })).toBeNull()
    expect(view.getByRole(`button`, { name: `Expand toolbar` }).getAttribute(
      `aria-expanded`,
    )).toBe(`false`)

    view.getByRole(`button`, { name: `Expand toolbar` }).click()
    await tick()
    expect(view.getByRole(`button`, { name: `Customize toolbar` })).toBeTruthy()
  })

  test(`Escape closes the menu and restores focus`, async () => {
    const view = render(ToolbarSettings, {
      pane_key: `pane-a`,
      available_tools: [`fullscreen`],
    })
    const customize = view.getByRole(`button`, { name: `Customize toolbar` })
    customize.click()
    await tick()

    window.dispatchEvent(new KeyboardEvent(`keydown`, { key: `Escape` }))
    await tick()
    await Promise.resolve()

    expect(view.queryByRole(`dialog`, { name: `Toolbar preferences` })).toBeNull()
    expect(document.activeElement).toBe(customize)
  })
})

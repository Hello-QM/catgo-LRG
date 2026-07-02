// Terminal Ctrl+click on a structure file must honor the "Open files in"
// target when NO structure tab exists (e.g. a terminal-only tab is active).
// Regression: this case always popped out a new window, ignoring Tab/Split —
// and on desktop builds where popout windows were ACL-dead the file appeared
// to simply not open.
import { beforeEach, describe, expect, test, vi } from 'vitest'

const popout = vi.fn()

vi.mock(`../../../desktop/lib/popout-manager`, () => ({
  parse_and_open_structure_window: (...args: unknown[]) => popout(...args),
  open_doc_window: vi.fn(),
}))
vi.mock(`$lib/api/hpc`, () => ({
  readRemoteFile: vi.fn().mockResolvedValue({ success: true, content: `POSCAR-content` }),
}))
vi.mock(`$lib/structure/parse`, () => ({ is_structure_file: () => true }))
vi.mock(`$lib/trajectory/parse`, () => ({ is_trajectory_file: () => false }))
vi.mock(`$lib/state.svelte`, () => ({
  resolve_open_target: (t: unknown) => t,
}))
vi.mock(`$lib/toast-state.svelte`, () => ({ show_toast: vi.fn() }))

import {
  handle_terminal_open_file,
  type SidebarHandlerDeps,
} from '../../../desktop/lib/sidebar-handlers'
import type { OpenTarget } from '$lib/state.svelte'

function make_deps(target: OpenTarget, opts: { cap?: boolean; with_structure_tab?: boolean } = {}) {
  const tabs = [{ id: `term-1`, type: `terminal` }]
  if (opts.with_structure_tab) tabs.push({ id: `s0`, type: `structure` })
  const deps = {
    get_active_ts: () => (opts.with_structure_tab ? { active_leaf_id: `L0` } : null),
    get_active_tab_id: () => `term-1`,
    get_active_tab_type: () => `terminal`,
    get_open_target: () => target,
    process_file_content: vi.fn().mockResolvedValue(undefined),
    place_single: vi.fn().mockResolvedValue(undefined),
    update_tab_label: vi.fn(),
    is_tauri: true,
    set_is_loading: vi.fn(),
    set_loading_text: vi.fn(),
    tab_states: {},
    tabs,
    set_active_tab_id: vi.fn(),
    open_new_structure_tab: vi.fn(() => {
      if (opts.cap) return { tab_id: `term-1`, leaf_id: `` } // create_tab no-oped
      tabs.push({ id: `s1`, type: `structure` })
      return { tab_id: `s1`, leaf_id: `leaf-1` }
    }),
  }
  return deps as unknown as SidebarHandlerDeps & typeof deps
}

beforeEach(() => {
  popout.mockClear()
})

describe(`handle_terminal_open_file with no structure tab`, () => {
  test(`split target creates a structure tab instead of a popout window`, async () => {
    const deps = make_deps({ kind: `split`, mode: `overwrite` } as OpenTarget)
    await handle_terminal_open_file(deps, `/tmp/POSCAR`, `POSCAR`, ``)
    expect(deps.open_new_structure_tab).toHaveBeenCalledOnce()
    expect(deps.process_file_content).toHaveBeenCalledOnce()
    // Local shell (blank session): the path travels as local_path, no origin.
    expect(deps.process_file_content).toHaveBeenCalledWith(
      `s1`,
      `POSCAR-content`,
      `POSCAR`,
      `leaf-1`,
      null,
      `/tmp/POSCAR`,
    )
    expect(popout).not.toHaveBeenCalled()
  })

  test(`tab target also lands in a fresh structure tab`, async () => {
    const deps = make_deps({ kind: `tab`, mode: `new` } as OpenTarget)
    await handle_terminal_open_file(deps, `/tmp/POSCAR`, `POSCAR`, ``)
    expect(deps.open_new_structure_tab).toHaveBeenCalledOnce()
    expect(popout).not.toHaveBeenCalled()
  })

  test(`remote file keeps its session origin`, async () => {
    const deps = make_deps({ kind: `split`, mode: `new` } as OpenTarget)
    await handle_terminal_open_file(deps, `/remote/POSCAR`, `POSCAR`, `sess-9`)
    expect(deps.process_file_content).toHaveBeenCalledWith(
      `s1`,
      `POSCAR-content`,
      `POSCAR`,
      `leaf-1`,
      { session_id: `sess-9`, file_path: `/remote/POSCAR` },
      null,
    )
  })

  test(`window target still opens a popout (overwrite → reuse)`, async () => {
    const deps = make_deps({ kind: `window`, mode: `overwrite` } as OpenTarget)
    await handle_terminal_open_file(deps, `/tmp/POSCAR`, `POSCAR`, ``)
    expect(popout).toHaveBeenCalledOnce()
    expect(popout).toHaveBeenCalledWith(`POSCAR-content`, `POSCAR`, true, true)
    expect(deps.open_new_structure_tab).not.toHaveBeenCalled()
  })

  test(`falls back to a popout when the tab cap blocks a new tab`, async () => {
    const deps = make_deps({ kind: `split`, mode: `overwrite` } as OpenTarget, { cap: true })
    await handle_terminal_open_file(deps, `/tmp/POSCAR`, `POSCAR`, ``)
    expect(deps.open_new_structure_tab).toHaveBeenCalledOnce()
    expect(deps.process_file_content).not.toHaveBeenCalled()
    expect(popout).toHaveBeenCalledOnce()
  })
})

describe(`handle_terminal_open_file with an existing structure tab`, () => {
  test(`switches to it and places via the open target (unchanged behavior)`, async () => {
    const deps = make_deps({ kind: `split`, mode: `overwrite` } as OpenTarget, {
      with_structure_tab: true,
    })
    await handle_terminal_open_file(deps, `/tmp/POSCAR`, `POSCAR`, ``)
    expect(deps.set_active_tab_id).toHaveBeenCalledWith(`s0`)
    expect(deps.place_single).toHaveBeenCalledOnce()
    expect(deps.open_new_structure_tab).not.toHaveBeenCalled()
    expect(popout).not.toHaveBeenCalled()
  })
})

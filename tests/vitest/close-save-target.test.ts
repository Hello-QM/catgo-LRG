import { describe, expect, it } from 'vitest'
import { create_empty_pane, type PaneState } from '../../desktop/pane-utils'
import { init_close_save_target } from '../../desktop/lib/pane-manager'
import { exp } from '../../desktop/state/export-state.svelte'

/**
 * Regression: closing a structure imported from the project DB (no
 * local_file_path, no remote_origin) used to default the close-save target to
 * `project`, so "Save & Close" silently wrote it back to the DB with no dialog.
 * Path-less panes must instead default to `local`, which routes through the
 * Save-As export dialog (asks WHERE to save). See init_close_save_target.
 */
function pane(overrides: Partial<PaneState>): PaneState {
  return { ...create_empty_pane(), ...overrides }
}

describe(`init_close_save_target`, () => {
  it(`defaults a path-less (DB-imported) pane to a Save-As dialog, not the DB`, () => {
    exp.close_save_target = `project`
    init_close_save_target(pane({ local_file_path: null, remote_origin: null }))
    expect(exp.close_save_target).toBe(`local`)
  })

  it(`keeps a local-file pane on the local (source-path) target`, () => {
    exp.close_save_target = `project`
    init_close_save_target(pane({ local_file_path: `/tmp/foo.cif` }))
    expect(exp.close_save_target).toBe(`local`)
  })

  it(`routes a remote (HPC) pane to the hpc target`, () => {
    exp.close_save_target = `project`
    init_close_save_target(
      pane({ remote_origin: { session_id: `s1`, file_path: `/home/u/POSCAR` } }),
    )
    expect(exp.close_save_target).toBe(`hpc`)
  })
})

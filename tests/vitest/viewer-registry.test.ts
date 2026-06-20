import { describe, expect, it } from 'vitest'
import { position_alias } from '../../desktop/pane-layout'
import {
  build_workspace_context,
  register_viewer,
  resolve_viewer,
  set_active_viewer,
  type ViewerHandle,
  type ViewerManifest,
} from '$lib/structure/viewer-registry.svelte'

function handle(manifest: ViewerManifest): ViewerHandle {
  return {
    get_manifest: () => manifest,
    get_structure: () => undefined,
    set_structure: () => {},
  }
}

function make(
  viewer_id: string,
  position: ViewerManifest['position'],
  pane_number: number,
  filename = `f.traj`,
): ViewerManifest {
  return {
    viewer_id,
    tab_id: `t`,
    leaf_id: viewer_id.split(`:`).at(-1) ?? viewer_id,
    position,
    pane_number,
    label: `L${pane_number}`,
    filename,
    formula: `X`,
    kind: `trajectory`,
    active: false,
    current_frame: 0,
    total_frames: 1,
    atom_count: 1,
    streaming: false,
    editable: true,
  }
}

describe(`viewer pane addressing`, () => {
  it(`derives visual aliases from pane geometry`, () => {
    expect(position_alias({ x: 0, y: 0, w: 50, h: 100 }, 2)).toBe(`left`)
    expect(position_alias({ x: 50, y: 50, w: 50, h: 50 }, 4)).toBe(`bottom-right`)
  })

  it(`resolves Chinese position aliases to stable viewer ids`, () => {
    const manifest: ViewerManifest = {
      viewer_id: `structure-1:leaf-42`,
      tab_id: `structure-1`,
      leaf_id: `leaf-42`,
      position: `bottom-right`,
      pane_number: 4,
      label: `MoS2`,
      filename: `mos2.traj`,
      formula: `MoS2`,
      kind: `trajectory`,
      active: false,
      current_frame: 17,
      total_frames: 120,
      atom_count: 72,
      streaming: false,
      editable: true,
    }
    const cleanup = register_viewer(handle(manifest))
    expect(resolve_viewer(`右下角`).manifest?.viewer_id).toBe(manifest.viewer_id)
    expect(build_workspace_context(`structure-1`)).toContain(`trajectory 18/120`)
    cleanup()
  })

  it(`errors instead of guessing when the ref is omitted and several panes exist`, () => {
    set_active_viewer(null)
    const a = register_viewer(handle(make(`t:leaf-a`, `left`, 1)))
    const b = register_viewer(handle(make(`t:leaf-b`, `right`, 2)))
    const resolved = resolve_viewer(undefined, `t`)
    expect(resolved.handle).toBeUndefined()
    expect(resolved.error).toMatch(/specify viewer_id|no active/i)
    a()
    b()
  })

  it(`stops resolving a viewer id after its pane is cleaned up`, () => {
    const cleanup = register_viewer(handle(make(`t:leaf-x`, `left`, 1)))
    expect(resolve_viewer(`t:leaf-x`).manifest?.viewer_id).toBe(`t:leaf-x`)
    cleanup()
    expect(resolve_viewer(`t:leaf-x`).error).toMatch(/not found/i)
  })

  it(`matches a filename by exact name or stem, never substring`, () => {
    set_active_viewer(null)
    const cleanup = register_viewer(handle(make(`t:leaf-p`, `left`, 1, `POSCAR`)))
    // The old bug: a bare letter substring ("o") routed to POSCAR.
    expect(resolve_viewer(`o`, `t`).handle).toBeUndefined()
    // Exact name and stem still resolve.
    expect(resolve_viewer(`POSCAR`, `t`).manifest?.viewer_id).toBe(`t:leaf-p`)
    const traj = register_viewer(handle(make(`t:leaf-m`, `right`, 2, `mos2.traj`)))
    expect(resolve_viewer(`mos2`, `t`).manifest?.viewer_id).toBe(`t:leaf-m`)
    cleanup()
    traj()
  })
})


import { describe, expect, it } from 'vitest'
import { position_alias } from '../../desktop/pane-layout'
import {
  build_workspace_context,
  register_viewer,
  resolve_viewer,
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
})


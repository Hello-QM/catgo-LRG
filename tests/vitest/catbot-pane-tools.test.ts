import { describe, expect, it } from 'vitest'
import { execute_tool } from '$lib/chat/structure-tools'
import {
  register_viewer,
  type ViewerHandle,
  type ViewerManifest,
} from '$lib/structure/viewer-registry.svelte'

function manifest(viewer_id: string, position: ViewerManifest['position']): ViewerManifest {
  return {
    viewer_id,
    tab_id: `structure-pane-test`,
    leaf_id: viewer_id.split(`:`).at(-1) ?? viewer_id,
    position,
    pane_number: position === `left` ? 1 : 2,
    label: position === `left` ? `C2H6` : `MoS2`,
    filename: `${position}.traj`,
    formula: position === `left` ? `C2H6` : `MoS2`,
    kind: `trajectory`,
    active: position === `right`,
    current_frame: 0,
    total_frames: 12,
    atom_count: position === `left` ? 8 : 72,
    streaming: false,
    editable: true,
  }
}

describe(`CatBot pane adapter`, () => {
  it(`lists, inspects, and mutates only the addressed viewer`, async () => {
    let left_scales = 0
    let right_scales = 0
    let right_adds = 0
    let right_replaces = 0
    const make_handle = (
      pane_manifest: ViewerManifest,
      scale: (factor: number) => void,
    ): ViewerHandle => ({
      get_manifest: () => pane_manifest,
      get_structure: () => undefined,
      set_structure: () => {},
      inspect_atoms: () => [{
        index: 0,
        element: pane_manifest.formula.startsWith(`Mo`) ? `Mo` : `C`,
        xyz: [0, 0, 0],
        neighbors: [],
        coordination: 0,
        component: 0,
        terminal: true,
        branch_candidate: false,
      }],
      add_atom: () => {
        right_adds++
        return {
          viewer_id: pane_manifest.viewer_id,
          scope: `all_frames`,
          atom_count: pane_manifest.atom_count + 1,
          total_frames: pane_manifest.total_frames,
        }
      },
      replace_atoms: (indices) => {
        right_replaces += indices.length
        return {
          viewer_id: pane_manifest.viewer_id,
          scope: `all_frames`,
          atom_count: pane_manifest.atom_count,
          total_frames: pane_manifest.total_frames,
        }
      },
      scale_geometry: (factor) => {
        scale(factor)
        return {
          viewer_id: pane_manifest.viewer_id,
          scope: `all_frames`,
          atom_count: pane_manifest.atom_count,
          total_frames: pane_manifest.total_frames,
        }
      },
    })

    const clean_left = register_viewer(make_handle(
      manifest(`structure-pane-test:left-leaf`, `left`),
      (factor) => { left_scales += factor },
    ))
    const clean_right = register_viewer(make_handle(
      manifest(`structure-pane-test:right-leaf`, `right`),
      (factor) => { right_scales += factor },
    ))
    try {
      const listed = JSON.parse(await execute_tool(`catgo_pane`, { action: `list` }))
      expect(listed.viewers).toHaveLength(2)

      const inspected = JSON.parse(await execute_tool(`catgo_pane`, {
        action: `inspect`,
        viewer_id: `right`,
      }))
      expect(inspected.viewer.formula).toBe(`MoS2`)
      expect(inspected.atoms[0].element).toBe(`Mo`)

      await execute_tool(`catgo_pane`, {
        action: `add_atom`,
        viewer_id: `right`,
        element: `H`,
        position: [0, 0, 1],
      })
      await execute_tool(`catgo_pane`, {
        action: `replace_atoms`,
        viewer_id: `right`,
        element: `Se`,
        indices: [1, 2],
      })
      expect(right_adds).toBe(1)
      expect(right_replaces).toBe(2)

      const scaled = JSON.parse(await execute_tool(`catgo_pane`, {
        action: `scale_geometry`,
        viewer_id: `right`,
        factor: 1.2,
      }))
      expect(scaled.viewer_id).toBe(`structure-pane-test:right-leaf`)
      expect(right_scales).toBe(1.2)
      expect(left_scales).toBe(0)
    } finally {
      clean_right()
      clean_left()
    }
  })
})

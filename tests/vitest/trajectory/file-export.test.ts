import { describe, expect, it, vi } from 'vitest'
import { strFromU8, unzipSync } from 'fflate'
import {
  create_poscar_frames_zip,
  editable_trajectory_source,
  poscar_frame_filename,
  resolve_frame_range,
  serialize_extxyz_trajectory,
  trajectory_export_basename,
} from '$lib/trajectory/file-export'
import { apply_trajectory_edit_op_to_frame } from '$lib/trajectory/operations'
import { TrajFrameReader } from '$lib/trajectory/parsers/frame-loader'
import { parse_xyz_trajectory } from '$lib/trajectory/parsers/xyz'
import type { TrajectoryFrame } from '$lib/trajectory'

function frame(step: number, x = step): TrajectoryFrame {
  return {
    step,
    structure: {
      lattice: {
        matrix: [[4, 0, 0], [0, 4, 0], [0, 0, 4]],
        a: 4,
        b: 4,
        c: 4,
        alpha: 90,
        beta: 90,
        gamma: 90,
        volume: 64,
        pbc: [true, true, true],
      },
      sites: [{
        species: [{ element: `H`, occu: 1 }],
        label: `H`,
        xyz: [x, 0, 0],
        abc: [x / 4, 0, 0],
        properties: {},
      }],
    },
  } as TrajectoryFrame
}

describe(`trajectory structure-file export`, () => {
  it(`normalizes source names and only permits faithful XYZ-family overwrite`, () => {
    expect(trajectory_export_basename(`/tmp/a run.extxyz.gz`)).toBe(`a_run`)
    expect(editable_trajectory_source(`dump.xyz`)).toBe(`xyz`)
    expect(editable_trajectory_source(`dump.extxyz.gz`)).toBe(`extxyz`)
    expect(editable_trajectory_source(`XDATCAR`)).toBeNull()
    expect(editable_trajectory_source(`run.traj`)).toBeNull()
  })

  it(`resolves every requested frame in order instead of slicing eager placeholders`, async () => {
    const resolver = vi.fn(async (idx: number) => frame(idx))
    const frames = await resolve_frame_range(3, 5, resolver)
    expect(resolver.mock.calls.map(([idx]) => idx)).toEqual([3, 4, 5])
    expect(frames.map((item) => item.step)).toEqual([3, 4, 5])
  })

  it(`serializes edited multi-frame extXYZ`, () => {
    const content = serialize_extxyz_trajectory([frame(0, 1.25), frame(1, 2.5)])
    expect(content.match(/^1$/gm)).toHaveLength(2)
    expect(content).toContain(`1.25000000`)
    expect(content).toContain(`2.50000000`)
  })

  it(`preserves frame metadata, forces, and exact selective dynamics`, () => {
    const edited = apply_trajectory_edit_op_to_frame({
      ...frame(7, 1.5),
      metadata: {
        energy: -2.75,
        temperature: 325,
        forces: [[0.1, -0.2, 0.3]],
      },
    }, {
      kind: `set_selective_dynamics`,
      values: [[false, true, false]],
    })
    const content = serialize_extxyz_trajectory([edited])
    expect(content).toContain(`forces:R:3`)
    expect(content).toContain(`move_mask:L:1:selective_dynamics:L:3`)
    expect(content).toContain(`energy=-2.75`)
    expect(content).toContain(`step=7`)
    expect(content).toContain(`temperature=325`)
    expect(content).toMatch(/0\.10000000\s+-0\.20000000\s+0\.30000000\s+T\s+F\s+T\s+F/)

    const reparsed = parse_xyz_trajectory(`${content}\n`).frames[0]
    expect(reparsed.metadata?.energy).toBe(-2.75)
    expect(reparsed.metadata?.forces).toEqual([[0.1, -0.2, 0.3]])
    expect(reparsed.structure.sites[0].properties?.selective_dynamics)
      .toEqual([false, true, false])

    // Indexed large-file loading must agree with the eager parser.
    const indexed = new TrajFrameReader(`large.extxyz`)
      .load_xyz_frame_chunk(`${content}\n`, 0)
    expect(indexed?.step).toBe(7)
    expect(indexed?.metadata?.energy).toBe(-2.75)
    expect(Array.from(indexed?.position_data?.forces ?? [])).toEqual([
      expect.closeTo(0.1),
      expect.closeTo(-0.2),
      expect.closeTo(0.3),
    ])
    expect(indexed?.structure.sites[0].properties?.selective_dynamics)
      .toEqual([false, true, false])
  })

  it(`exports separate numbered POSCAR files with selective dynamics`, async () => {
    const constrained = apply_trajectory_edit_op_to_frame(frame(8), {
      kind: `set_selective_dynamics`,
      values: [[false, true, false]],
    })
    const blob = create_poscar_frames_zip([constrained], [8], `edited.extxyz`, 36)
    const files = unzipSync(new Uint8Array(await blob.arrayBuffer()))
    const name = poscar_frame_filename(`edited.extxyz`, 8, 36)
    expect(name).toBe(`edited_frame_0008.vasp`)
    expect(Object.keys(files)).toEqual([name])
    const content = strFromU8(files[name])
    expect(content).toContain(`Selective dynamics`)
    expect(content).toMatch(/F\s+T\s+F/)
  })
})

import {
  probe_streamable_trajectory,
  RemoteFrameLoader,
} from '$lib/trajectory/remote-frame-loader'
import { afterEach, describe, expect, test, vi } from 'vitest'

function position_packet_v2(): ArrayBuffer {
  const frames = [
    { number: 0, flags: 0, positions: [0, 0, 0, 1, 0, 0] },
    { number: 1, flags: 2, positions: [2, 0, 0] },
  ]
  const bytes = 16 + frames.reduce(
    (sum, frame) => sum + 84 + frame.positions.length * 4,
    0,
  )
  const buffer = new ArrayBuffer(bytes)
  const view = new DataView(buffer)
  for (const [idx, char] of Array.from(`CGTP`).entries()) {
    view.setUint8(idx, char.charCodeAt(0))
  }
  view.setUint32(4, 2, true)
  view.setUint32(8, frames.length, true)
  view.setUint32(12, 2, true)
  let offset = 16
  for (const frame of frames) {
    view.setUint32(offset, frame.number, true)
    view.setUint32(offset + 4, frame.positions.length / 3, true)
    view.setUint32(offset + 8, frame.flags, true)
    offset += 84
    for (const value of frame.positions) {
      view.setFloat32(offset, value, true)
      offset += 4
    }
  }
  return buffer
}

afterEach(() => vi.unstubAllGlobals())

describe(`remote trajectory file-backed policy`, () => {
  test(`decodes variable atom counts from CGTP v2 packets`, async () => {
    const packet = position_packet_v2()
    vi.stubGlobal(`fetch`, vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => packet,
    })))
    const loader = new RemoteFrameLoader(`/tmp/variable.extxyz`, 2, 2)
    const frame = await loader.load_frame_positions(``, 1)
    expect(Array.from(frame?.positions ?? [])).toEqual([2, 0, 0])
    expect(frame?.topology_changed).toBe(true)
  })

  test(`streams multi-frame extXYZ above 1 MiB on shared app platforms`, async () => {
    vi.stubGlobal(`fetch`, vi.fn(async () => ({
      ok: true,
      json: async () => ({ total_frames: 4367, file_size: 7_864_320 }),
    })))
    await expect(
      probe_streamable_trajectory(`/tmp/djtbl3.extxyz`, `djtbl3.extxyz`),
    ).resolves.toMatchObject({ stream: true, total_frames: 4367 })
  })
})

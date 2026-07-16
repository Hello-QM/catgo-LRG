import type {
  FrameLoader,
  TrajectoryFrame,
  TrajectoryType,
} from '$lib/trajectory'
import {
  create_frame_request_loader,
  select_in_memory_frame,
} from '$lib/trajectory/frame-loading'
import { describe, expect, it } from 'vitest'

const frame = (step: number): TrajectoryFrame => ({
  step,
  structure: { sites: [] } as TrajectoryFrame['structure'],
})

const trajectory_with_loader = (
  load_frame: FrameLoader['load_frame'],
  frame_source_data: string | ArrayBuffer,
): TrajectoryType => ({
  frames: [frame(0)],
  total_frames: 2,
  is_indexed: true,
  frame_source_data,
  frame_loader: {
    get_total_frames: async () => 2,
    build_frame_index: async () => [],
    load_frame,
    extract_plot_metadata: async () => [],
  },
})

const deferred_frame_loader = () => {
  const resolvers = new Map<
    number,
    (value: TrajectoryFrame | null) => void
  >()
  const load_frame: FrameLoader['load_frame'] = (_data, idx) =>
    new Promise((resolve) => resolvers.set(idx, resolve))
  return {
    load_frame,
    resolve: (idx: number, value: TrajectoryFrame | null) => {
      const resolve = resolvers.get(idx)
      if (!resolve) throw new Error(`No pending frame ${idx}`)
      resolve(value)
    },
  }
}

describe(`frame loading`, () => {
  it(`uses trajectory source data instead of the compatibility fallback`, async () => {
    const owned = new ArrayBuffer(8)
    const fallback = new ArrayBuffer(4)
    let received: string | ArrayBuffer | undefined
    const previous = frame(0)
    const trajectory = trajectory_with_loader(async (data) => {
      received = data
      return frame(1)
    }, owned)
    const requests = create_frame_request_loader()

    const result = await requests.load(trajectory, 1, previous, fallback)

    expect(result.status).toBe(`loaded`)
    expect(received).toBe(owned)
  })

  it(`keeps the previous frame when the loader returns null`, async () => {
    const previous = frame(3)
    const requests = create_frame_request_loader()
    const result = await requests.load(
      trajectory_with_loader(async () => null, new ArrayBuffer(1)),
      4,
      previous,
      null,
    )

    expect(result.status).toBe(`failed`)
    if (result.status === `failed`) {
      expect(result.frame).toBe(previous)
      expect(result.error.message).toContain(`frame 4`)
    }
  })

  it(`marks an older async completion stale`, async () => {
    const pending = deferred_frame_loader()
    const trajectory = trajectory_with_loader(pending.load_frame, new ArrayBuffer(1))
    const requests = create_frame_request_loader()
    const old_request = requests.load(trajectory, 1, frame(0), null)
    const new_request = requests.load(trajectory, 2, frame(0), null)

    pending.resolve(2, frame(2))
    expect((await new_request).status).toBe(`loaded`)
    pending.resolve(1, frame(1))
    expect((await old_request).status).toBe(`stale`)
  })

  it(`keeps the previous frame when the loader throws`, async () => {
    const previous = frame(3)
    const requests = create_frame_request_loader()
    const result = await requests.load(
      trajectory_with_loader(async () => { throw new Error(`decode failed`) }, new ArrayBuffer(1)),
      4,
      previous,
      null,
    )

    expect(result.status).toBe(`failed`)
    if (result.status === `failed`) {
      expect(result.frame).toBe(previous)
      expect(result.error.message).toContain(`decode failed`)
    }
  })

  it(`keeps the previous frame when an in-memory index is missing`, () => {
    const previous = frame(3)
    const result = select_in_memory_frame(undefined, previous, 4)
    expect(result.status).toBe(`failed`)
    if (result.status === `failed`) {
      expect(result.frame).toBe(previous)
      expect(result.error.message).toContain(`frame 4`)
    }
  })
})

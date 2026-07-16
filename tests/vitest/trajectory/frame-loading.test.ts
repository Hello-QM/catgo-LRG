import type {
  FrameLoader,
  TrajectoryFrame,
  TrajectoryType,
} from '$lib/trajectory'
import {
  create_frame_request_loader,
  select_displayed_frame_owner,
  select_displayed_frame_remote_origin,
  select_displayed_frame_idx,
  select_in_memory_frame,
  select_pending_frame_publication,
} from '$lib/trajectory/frame-loading'
import { create_effective_frame_resolver } from '$lib/trajectory/effective-frame-resolver'
import { create_frame_position_cache } from '$lib/trajectory/frame-positions'
import { OperationLedger } from '$lib/trajectory/operation-ledger'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const frame = (step: number): TrajectoryFrame => ({
  step,
  structure: { sites: [] } as TrajectoryFrame['structure'],
})

const positioned_frame = (step: number): TrajectoryFrame => ({
  step,
  structure: {
    sites: [{ xyz: [step, 0, 0], properties: {} }],
  } as TrajectoryFrame['structure'],
})

const periodic_frame = (step: number): TrajectoryFrame => ({
  step,
  structure: {
    lattice: {
      matrix: [[2, 0, 0], [0, 2, 0], [0, 0, 2]],
      pbc: [true, true, true],
      volume: 8,
      a: 2,
      b: 2,
      c: 2,
      alpha: 90,
      beta: 90,
      gamma: 90,
    },
    sites: [{
      species: [{ element: `H`, occu: 1, oxidation_state: 0 }],
      abc: [0, 0, 0],
      xyz: [step, 0, 0],
      label: `H`,
      properties: {},
    }],
  } as TrajectoryFrame['structure'],
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

  it(`rejects a resolved outcome invalidated before application`, async () => {
    const trajectory = trajectory_with_loader(
      async () => frame(1),
      new ArrayBuffer(1),
    )
    const requests = create_frame_request_loader()
    const result = await requests.load(trajectory, 1, frame(0), null)

    expect(requests.is_current(result, trajectory)).toBe(true)
    requests.invalidate()
    expect(requests.is_current(result, trajectory)).toBe(false)
  })

  it(`rejects a resolved outcome for a replacement trajectory`, async () => {
    const trajectory = trajectory_with_loader(
      async () => frame(1),
      new ArrayBuffer(1),
    )
    const replacement = { ...trajectory }
    const requests = create_frame_request_loader()
    const result = await requests.load(trajectory, 1, frame(0), null)

    expect(requests.is_current(result, replacement)).toBe(false)
  })

  it(`invalidates a pending load when the requested index leaves bounds`, async () => {
    const pending = deferred_frame_loader()
    const trajectory = trajectory_with_loader(
      pending.load_frame,
      new ArrayBuffer(1),
    )
    const previous = frame(3)
    const requests = create_frame_request_loader()
    const pending_result = requests.load(trajectory, 4, previous, null)

    const rejected = requests.reject_out_of_bounds(100, 100, previous)

    expect(rejected.status).toBe(`failed`)
    expect(rejected.frame).toBe(previous)
    expect(rejected.error.message).toContain(`frame 100`)
    pending.resolve(4, frame(4))
    expect((await pending_result).status).toBe(`stale`)
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

  it(`retains the displayed frame when lazy ledger replay fails`, async () => {
    const previous = positioned_frame(3)
    const ledger = new OperationLedger()
    ledger.append(
      { kind: `all` },
      {
        kind: `supercell`,
        matrix: [[1, 1, 0], [1, 1, 0], [0, 0, 1]],
        reorient: false,
      },
    )
    const replacement = trajectory_with_loader(
      async () => periodic_frame(4),
      new ArrayBuffer(1),
    )
    replacement.operation_ledger = ledger
    replacement.effective_frames = create_effective_frame_resolver(ledger)

    const result = await create_frame_request_loader().load(
      replacement,
      1,
      previous,
      null,
    )

    expect(result.status).toBe(`failed`)
    if (result.status === `failed`) {
      expect(result.frame).toBe(previous)
      expect(result.error.message).toContain(`determinant 0`)
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

  it(`keeps failed-frame positions owned by the displayed index until retry`, () => {
    const cache = create_frame_position_cache()
    const previous = positioned_frame(3)
    const failed = select_in_memory_frame(undefined, previous, 4)
    let displayed_frame_idx = select_displayed_frame_idx(failed, 4, 3)
    expect(displayed_frame_idx).toBe(3)
    if (failed.status === `failed` && failed.frame && displayed_frame_idx !== null) {
      cache.get(displayed_frame_idx, failed.frame.structure.sites)
    }

    const retry = select_in_memory_frame(positioned_frame(4), previous, 4)
    displayed_frame_idx = select_displayed_frame_idx(
      retry,
      4,
      displayed_frame_idx,
    )
    expect(displayed_frame_idx).toBe(4)
    if (retry.status !== `loaded` || displayed_frame_idx === null) {
      throw new Error(`Expected loaded retry`)
    }
    expect(cache.get(displayed_frame_idx, retry.frame.structure.sites).positions[0])
      .toBe(4)
  })

  it.each([
    [`null`, async () => null],
    [`throw`, async () => { throw new Error(`replacement failed`) }],
  ] satisfies [string, FrameLoader['load_frame']][])(
    `preserves published streamed positions when replacement load returns %s`,
    async (_kind, load_frame) => {
      const previous = positioned_frame(3)
      const positions = new Float32Array([3, 0, 0])
      const forces = new Float32Array([0.5, 0, 0])
      const replacement = trajectory_with_loader(load_frame, new ArrayBuffer(1))
      const result = await create_frame_request_loader().load(
        replacement,
        0,
        previous,
        null,
      )
      expect(result.status).toBe(`failed`)
      const displayed_frame_idx = select_displayed_frame_idx(result, 0, null)

      const publication = select_pending_frame_publication(
        displayed_frame_idx,
        positions,
        forces,
      )
      expect(publication?.positions).toBe(positions)
      expect(publication?.forces).toBe(forces)
      expect(Array.from(publication?.positions ?? [])).toEqual([3, 0, 0])
      expect(Array.from(publication?.forces ?? [])).toEqual([0.5, 0, 0])
    },
  )

  it(`keeps remote push-back disabled until a replacement owns the displayed frame`, async () => {
    const original = {
      ...trajectory_with_loader(async () => frame(3), new ArrayBuffer(1)),
      metadata: {
        remote_origin: { session_id: `old-session`, dir_path: `/old/run` },
      },
    }
    const replacement = {
      ...trajectory_with_loader(async () => null, new ArrayBuffer(1)),
      metadata: {
        remote_origin: { session_id: `new-session`, dir_path: `/new/run` },
      },
    }
    let owner = select_displayed_frame_owner(
      { status: `loaded`, frame: frame(3) },
      original,
      3,
      null,
    )

    const failed = await create_frame_request_loader().load(
      replacement,
      0,
      frame(3),
      null,
    )
    owner = select_displayed_frame_owner(failed, replacement, 0, owner)

    expect(owner?.trajectory).toBe(original)
    expect(owner?.frame_idx).toBe(3)
    expect(select_displayed_frame_remote_origin(replacement, owner))
      .toBeUndefined()

    owner = select_displayed_frame_owner(
      { status: `loaded`, frame: frame(0) },
      replacement,
      0,
      owner,
    )
    expect(select_displayed_frame_remote_origin(replacement, owner)).toEqual({
      session_id: `new-session`,
      dir_path: `/new/run`,
    })
  })

  it(`wires displayed frame ownership into trajectory position caches`, () => {
    const source = readFileSync(
      `src/lib/trajectory/Trajectory.svelte`,
      `utf8`,
    )

    expect(source).toContain(
      `let displayed_frame_idx = $state<number | null>(null)`,
    )
    expect(source).toContain(`select_displayed_frame_idx(`)
    expect(source).toMatch(/position_cache\[active_displayed_frame_idx\]/)
    expect(source).toMatch(
      /frame_pos_cache\.get\(active_displayed_frame_idx, frame_sites\)/,
    )
    expect(source).toContain(`select_pending_frame_publication(`)
    expect(source).toContain(`select_displayed_frame_owner(`)
    expect(source).toContain(`select_displayed_frame_remote_origin(`)
  })

  it(`guards outcome application with request and trajectory currentness`, () => {
    const source = readFileSync(
      `src/lib/trajectory/Trajectory.svelte`,
      `utf8`,
    )

    expect(source).toContain(`const requested_trajectory = trajectory`)
    expect(source).toMatch(
      /if \(!frame_requests\.is_current\(result, trajectory\)\) return\s+apply_frame_request_outcome\(result, frame_idx, requested_trajectory\)/,
    )
  })

  it(`wires Structure supercells and all pending edit replay through the pane ledger`, () => {
    const source = readFileSync(
      `src/lib/trajectory/Trajectory.svelte`,
      `utf8`,
    )

    expect(source).toContain(
      `on_supercell_request={handle_trajectory_supercell_request}`,
    )
    expect(source).not.toContain(`let pending_ops`)
    expect(source).not.toContain(`pane_transformations.push`)
    expect(source).toContain(`apply_trajectory_edit_op_to_frame`)
    expect(source).toContain(`ledger_cursor_ledger`)
    expect(source).not.toContain(`ledger_cursor_owner`)
    expect(source).toContain(`has_frame_scoped_structure_ops`)
    expect(source).toContain(`traj.effective_frames?.resolve`)
    expect(source).toMatch(
      /prepare_current_topology_edit: \(\) => \{\s+if \(is_playing\) pause_playback\(\)\s+\}/,
    )
    expect(source).toContain(
      'if (publication.token.mode === `edit-current`) resume_disabled = true',
    )
  })
})

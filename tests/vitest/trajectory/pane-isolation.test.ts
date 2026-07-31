import { describe, expect, it } from 'vitest'
import type { AnyStructure } from '$lib'
import type { FrameLoader, TrajectoryType } from '$lib/trajectory'
import { clone_trajectory_for_pane } from '$lib/trajectory/clone'
import { create_frame_request_loader } from '$lib/trajectory/frame-loading'
import {
  apply_trajectory_edit_op_to_frame,
  scale_structure_geometry,
  validate_uniform_topology,
} from '$lib/trajectory/operations'

function structure(elements = [`C`, `H`]): AnyStructure {
  return {
    sites: elements.map((element, i) => ({
      species: [{ element, occu: 1 }],
      label: element,
      xyz: [i, 0, 0],
      abc: [i / 2, 0, 0],
    })),
    lattice: { matrix: [[2, 0, 0], [0, 2, 0], [0, 0, 2]], a: 2, b: 2, c: 2, volume: 8 },
  } as unknown as AnyStructure
}

describe(`trajectory pane isolation`, () => {
  it(`deep-clones frames and structures`, () => {
    const source: TrajectoryType = {
      frames: [{ structure: structure(), step: 0 }],
      metadata: { filename: `same.traj` },
    }
    const left = clone_trajectory_for_pane(source)!
    const right = clone_trajectory_for_pane(source)!
    left.frames[0].structure.sites[0].xyz[0] = 99
    expect(right.frames[0].structure.sites[0].xyz[0]).toBe(0)
    expect(source.frames[0].structure.sites[0].xyz[0]).toBe(0)
  })

  it(`isolates copy-on-write frames for large trajectories without eager clone`, () => {
    // > LAZY_CLONE_FRAME_THRESHOLD (256) frames take the lazy COW path.
    const source: TrajectoryType = {
      frames: Array.from({ length: 300 }, (_, step) => ({ structure: structure(), step })),
      metadata: { filename: `big.traj` },
    }
    const left = clone_trajectory_for_pane(source)!
    const right = clone_trajectory_for_pane(source)!

    expect(left.frames.length).toBe(300)
    // In-place mutation of one pane's frame must not leak to the other or source.
    left.frames[10].structure.sites[0].xyz[0] = 99
    expect(right.frames[10].structure.sites[0].xyz[0]).toBe(0)
    expect(source.frames[10].structure.sites[0].xyz[0]).toBe(0)
    // Index-replacement (the real edit path) stays pane-local too.
    right.frames[20] = { structure: structure(), step: 20 }
    right.frames[20].structure.sites[1].xyz[0] = 42
    expect(left.frames[20].structure.sites[1].xyz[0]).toBe(1)
    // map/iteration over the COW array yields cloned frames, not source refs.
    expect(left.frames.map((f) => f.step)).toHaveLength(300)
    expect(left.frames[0]).not.toBe(source.frames[0])
  })

  it(`clones Svelte-like proxy metadata without DataCloneError`, () => {
    const frame_metadata = new Proxy({
      forces: [[1, 2, 3]],
      optional: undefined,
    }, {})
    const trajectory_metadata = new Proxy({
      source_format: `traj`,
      nested: { labels: new Set([`energy`]) },
    }, {})
    const source: TrajectoryType = {
      frames: [{
        structure: structure(),
        step: 0,
        metadata: frame_metadata,
      }],
      metadata: trajectory_metadata,
    }

    const cloned = clone_trajectory_for_pane(source)!
    expect(cloned.frames[0].metadata).toEqual(frame_metadata)
    expect(cloned.metadata?.source_format).toBe(`traj`)
    expect(cloned.metadata?.nested).not.toBe(trajectory_metadata.nested)

    ;(cloned.frames[0].metadata?.forces as number[][])[0][0] = 99
    expect(frame_metadata.forces[0][0]).toBe(1)
  })

  it(`forks streaming loaders`, () => {
    let forks = 0
    const frame_source_data = new ArrayBuffer(8)
    const loader: FrameLoader = {
      fork: () => {
        forks++
        return { ...loader }
      },
      get_total_frames: async () => 1,
      build_frame_index: async () => [],
      load_frame: async () => null,
      extract_plot_metadata: async () => [],
    }
    const source = {
      frames: [{ structure: structure(), step: 0 }],
      frame_loader: loader,
      frame_source_data,
    } as TrajectoryType & { frame_loader: FrameLoader; frame_source_data: ArrayBuffer }
    const a = clone_trajectory_for_pane(source) as typeof source
    const b = clone_trajectory_for_pane(source) as typeof source
    expect(forks).toBe(2)
    expect(a.frame_loader).not.toBe(b.frame_loader)
    expect(a.frame_source_data).toBe(frame_source_data)
    expect(b.frame_source_data).toBe(frame_source_data)
  })

  it(`keeps streamed operation ledgers pane-local and out of forked loaders`, async () => {
    const loader: FrameLoader = {
      fork: () => ({ ...loader }),
      get_total_frames: async () => 1,
      build_frame_index: async () => [],
      load_frame: async () => ({ structure: structure(), step: 0 }),
      extract_plot_metadata: async () => [],
    }
    const source = {
      frames: [{ structure: structure(), step: 0 }],
      frame_loader: loader,
    } as TrajectoryType & { frame_loader: FrameLoader }
    const scaled = clone_trajectory_for_pane(source) as typeof source
    const untouched = clone_trajectory_for_pane(source) as typeof source
    scaled.operation_ledger!.append({ kind: `all` }, { kind: `scale_geometry`, factor: 2 })

    // Forked loaders serve immutable base frames — no transformation replay.
    const raw = await scaled.frame_loader.load_frame(``, 0)
    expect(raw?.structure.sites[1].xyz[0]).toBe(1)

    // The pane's effective-frame resolver is the only transform path, and it
    // is pane-local: the sibling pane resolves untransformed frames.
    const scaled_frame = await scaled.effective_frames!.resolve(
      0,
      (idx) => scaled.frame_loader.load_frame(``, idx),
    )
    const untouched_frame = await untouched.effective_frames!.resolve(
      0,
      (idx) => untouched.frame_loader.load_frame(``, idx),
    )
    expect(scaled_frame?.structure.sites[1].xyz[0]).toBeCloseTo(2)
    expect(untouched_frame?.structure.sites[1].xyz[0]).toBe(1)
  })

  it(`routes frame requests through the effective-frame resolver`, async () => {
    const loader: FrameLoader = {
      fork: () => ({ ...loader }),
      get_total_frames: async () => 1,
      build_frame_index: async () => [],
      load_frame: async () => ({ structure: structure(), step: 0 }),
      extract_plot_metadata: async () => [],
    }
    const source = {
      frames: [{ structure: structure(), step: 0 }],
      frame_loader: loader,
      frame_source_data: ``,
    } as TrajectoryType & { frame_loader: FrameLoader }
    const pane = clone_trajectory_for_pane(source) as typeof source

    // Legacy bridge: Trajectory.svelte still records streamed all-frame scale
    // edits via pane_transformations.push — the pane must land it in the ledger.
    pane.pane_transformations!.push({ kind: `scale_geometry`, factor: 2 })
    expect(pane.operation_ledger!.entries).toHaveLength(1)

    const result = await create_frame_request_loader().load(pane, 0, null, null)
    expect(result.status).toBe(`loaded`)
    if (result.status === `loaded`) {
      expect(result.frame.structure.sites[1].xyz[0]).toBeCloseTo(2)
    }
  })

  it(`clones the ledger for pane-from-pane duplication without sharing`, () => {
    const source: TrajectoryType = {
      frames: [{ structure: structure(), step: 0 }],
    }
    const a = clone_trajectory_for_pane(source)!
    a.operation_ledger!.append({ kind: `all` }, { kind: `scale_geometry`, factor: 2 })

    const b = clone_trajectory_for_pane(a)!
    expect(b.operation_ledger).not.toBe(a.operation_ledger)
    expect(b.effective_frames).not.toBe(a.effective_frames)
    expect(b.operation_ledger!.entries).toHaveLength(1) // inherits the edit

    b.operation_ledger!.append({ kind: `frame`, frame_idx: 0 }, {
      kind: `scale_geometry`,
      factor: 3,
    })
    expect(a.operation_ledger!.entries).toHaveLength(1) // append stays pane-local
  })

  it(`preserves in-memory ledger cursors across pane duplication`, () => {
    const source = clone_trajectory_for_pane({
      frames: [{ structure: structure(), step: 0 }],
    })!
    source.operation_ledger!.append(
      { kind: `all` },
      { kind: `scale_geometry`, factor: 2 },
    )
    source.frames[0].structure.sites[1].xyz[0] = 2
    source.materialized_ledger_cursors = [source.operation_ledger!.entries.length]

    const copy = clone_trajectory_for_pane(source)!

    expect(copy.materialized_ledger_cursors).toEqual([1])
    expect(copy.materialized_ledger_cursors).not.toBe(
      source.materialized_ledger_cursors,
    )
    expect(copy.frames[0].structure.sites[1].xyz[0]).toBe(2)
  })

  it(`retains the previous frame when a ledger op fails on a streamed frame`, async () => {
    const molecule = { sites: structure().sites } as AnyStructure // no lattice
    const loader: FrameLoader = {
      fork: () => ({ ...loader }),
      get_total_frames: async () => 1,
      build_frame_index: async () => [],
      load_frame: async () => ({ structure: molecule, step: 0 }),
      extract_plot_metadata: async () => [],
    }
    const source = {
      frames: [{ structure: molecule, step: 0 }],
      frame_loader: loader,
      frame_source_data: ``,
    } as TrajectoryType & { frame_loader: FrameLoader }
    const pane = clone_trajectory_for_pane(source) as typeof source
    pane.operation_ledger!.append({ kind: `all` }, {
      kind: `supercell`,
      matrix: [[2, 0, 0], [0, 1, 0], [0, 0, 1]],
      reorient: false,
    })

    const previous = { structure: structure(), step: 0 }
    const result = await create_frame_request_loader().load(pane, 0, previous, null)
    expect(result.status).toBe(`failed`)
    if (result.status === `failed`) {
      expect(result.frame).toBe(previous) // last complete scene retained
      expect(result.error.message).toMatch(/Supercell rejected/)
    }
  })

  it(`rejects unsafe all-frame topology edits`, () => {
    const trajectory: TrajectoryType = {
      frames: [
        { structure: structure([`C`, `H`]), step: 0 },
        { structure: structure([`H`, `C`]), step: 1 },
      ],
    }
    expect(validate_uniform_topology(trajectory)).toMatch(/different atom count or element order/)
  })

  it(`drops a stale compact position packet after adding a trajectory atom`, () => {
    const original = {
      structure: structure([`C`, `H`]),
      step: 0,
      position_data: {
        step: 0,
        positions: new Float32Array(6),
        forces: null,
        lattice: null,
      },
    }

    const edited = apply_trajectory_edit_op_to_frame(original, {
      kind: `add`,
      element: `O`,
      position: [1, 2, 3],
    })

    expect(edited.structure.sites).toHaveLength(3)
    expect(edited.position_data).toBeUndefined()
    expect(original.position_data.positions).toHaveLength(6)
  })

  it(`scales real geometry and lattice`, () => {
    const scaled = scale_structure_geometry(structure(), 2)
    expect(scaled.sites[0].xyz[0]).toBeCloseTo(0)
    expect(scaled.sites[1].xyz[0]).toBeCloseTo(2)
    expect(scaled.sites[1].abc?.[0]).toBeCloseTo(0.5)
    expect((scaled as any).lattice.matrix[0][0]).toBe(4)
    expect((scaled as any).lattice.volume).toBe(64)
  })

  it(`scales molecules about their geometric center`, () => {
    const molecule = {
      sites: structure().sites.map(({ abc: _abc, ...site }) => site),
    } as unknown as AnyStructure
    const scaled = scale_structure_geometry(molecule, 2)
    expect(scaled.sites[0].xyz[0]).toBeCloseTo(-0.5)
    expect(scaled.sites[1].xyz[0]).toBeCloseTo(1.5)
  })
})

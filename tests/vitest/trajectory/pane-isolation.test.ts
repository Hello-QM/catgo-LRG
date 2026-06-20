import { describe, expect, it } from 'vitest'
import type { AnyStructure } from '$lib'
import type { FrameLoader, TrajectoryType } from '$lib/trajectory'
import { clone_trajectory_for_pane } from '$lib/trajectory/clone'
import { scale_structure_geometry, validate_uniform_topology } from '$lib/trajectory/operations'

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
    const source = { frames: [{ structure: structure(), step: 0 }], frame_loader: loader } as TrajectoryType & { frame_loader: FrameLoader }
    const a = clone_trajectory_for_pane(source) as typeof source
    const b = clone_trajectory_for_pane(source) as typeof source
    expect(forks).toBe(2)
    expect(a.frame_loader).not.toBe(b.frame_loader)
  })

  it(`keeps streamed transformation pipelines pane-local`, async () => {
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
    const scaled = clone_trajectory_for_pane(source) as typeof source & {
      pane_transformations: { kind: `scale_geometry`; factor: number }[]
    }
    const untouched = clone_trajectory_for_pane(source) as typeof source
    scaled.pane_transformations.push({ kind: `scale_geometry`, factor: 2 })

    const scaled_frame = await scaled.frame_loader.load_frame(``, 0)
    const untouched_frame = await untouched.frame_loader.load_frame(``, 0)
    expect(scaled_frame?.structure.sites[1].xyz[0]).toBeCloseTo(2)
    expect(untouched_frame?.structure.sites[1].xyz[0]).toBe(1)
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

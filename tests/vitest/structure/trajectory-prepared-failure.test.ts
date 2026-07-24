import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import type {
  BaseBondGraph,
  RenderPacket,
} from '$lib/structure/scene/render-packet'
import {
  classify_prepared_path,
} from '$lib/structure/trajectory-frame-preparer'
import {
  create_prepared_frame_pipeline,
  type PreparedFrameKey,
  type PreparedTrajectoryFrame,
} from '$lib/structure/trajectory-prepared-frame'
import { SharedPositionTexture } from '$lib/structure/gpu/webgl2/shared-position-texture'
import { SharedAtomColorTexture } from '$lib/structure/gpu/webgl2/shared-atom-color-texture'

const owner = {}

function key(
  frame_idx: number,
  overrides: Partial<PreparedFrameKey> = {},
): PreparedFrameKey {
  return {
    owner,
    frame_idx,
    positions_version: frame_idx + 1,
    topology_version: 1,
    rules_version: `default`,
    ...overrides,
  }
}

function prepared(
  prepared_key: PreparedFrameKey,
  byte_size = 64,
): PreparedTrajectoryFrame {
  const graph: BaseBondGraph = {
    version: prepared_key.frame_idx,
    pairs: new Uint32Array(0),
    jimages: new Int8Array(0),
    kinds: new Uint8Array(0),
    strengths: new Float32Array(0),
  }
  const packet: RenderPacket = {
    topology: {
      version: prepared_key.topology_version,
      atom_count: 1,
      site_ids: Uint32Array.of(0),
      atomic_numbers: Uint8Array.of(6),
      radii: Float32Array.of(0.7),
      colors: Float32Array.of(1, 1, 1),
      bond_graph: graph,
    },
    frame: {
      owner: prepared_key.owner,
      frame_idx: prepared_key.frame_idx,
      positions_version: prepared_key.positions_version,
      positions: Float32Array.of(prepared_key.frame_idx, 0, 0),
      lattice: Float32Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1),
    },
    replicas: {
      version: 1,
      dims: [1, 1, 1],
      boundary_policy: `stub`,
      semantics: `visual-shared-base`,
    },
  }
  return {
    key: prepared_key,
    packet,
    graph,
    gpu_positions_rgba: Float32Array.of(prepared_key.frame_idx, 0, 0, 1),
    forces: null,
    graph_hash: `${prepared_key.frame_idx}`,
    byte_size,
    compute_ms: 1,
  }
}

const typed_features = {
  strategy: `atom_radii` as const,
  atom_count: 100,
  show_bonds: true,
  topology_stable: true,
  atomic_numbers_complete: true,
  distance_rule_count: 0,
  site_radius_override_count: 0,
  manual_bond_count: 0,
  deleted_bond_count: 0,
  hidden_bond_features: false,
  hydrogen_bonds: false,
  bond_orders: false,
  clipping: false,
  polyhedra: false,
  drag_overrides: false,
}

describe(`prepared-path failure and fallback contracts`, () => {
  test(`classifies typed, atom-only, and diagnostic exact-object paths`, () => {
    expect(classify_prepared_path(typed_features)).toEqual({ kind: `typed-fast` })
    expect(classify_prepared_path({
      ...typed_features,
      show_bonds: false,
    })).toEqual({ kind: `atom-only` })

    for (const override of [
      { strategy: `solid_angle` as const },
      { topology_stable: false },
      { atomic_numbers_complete: false },
      { distance_rule_count: 1 },
      { site_radius_override_count: 1 },
      { manual_bond_count: 1 },
      { deleted_bond_count: 1 },
      { hidden_bond_features: true },
      { hydrogen_bonds: true },
      { bond_orders: true },
      { clipping: true },
      { polyhedra: true },
      { drag_overrides: true },
    ]) {
      const result = classify_prepared_path({ ...typed_features, ...override })
      expect(result.kind).toBe(`exact-object`)
      if (result.kind === `exact-object`) expect(result.reasons.length).toBeGreaterThan(0)
    }
  })

  test(`failure retains the last complete frame and a later request recovers`, async () => {
    const pipeline = create_prepared_frame_pipeline()
    const first_key = key(0)
    const first_generation = pipeline.begin_request(first_key)
    await expect(pipeline.request({
      key: first_key,
      priority: `current`,
      estimated_bytes: 64,
      prepare: async () => prepared(first_key),
    }, first_generation)).resolves.toMatchObject({ status: `ready` })

    const failed_key = key(1)
    const failed_generation = pipeline.begin_request(failed_key)
    await expect(pipeline.request({
      key: failed_key,
      priority: `current`,
      estimated_bytes: 64,
      prepare: async () => {
        throw new Error(`worker unavailable`)
      },
    }, failed_generation)).resolves.toMatchObject({ status: `failed` })
    expect(pipeline.peek(first_key)?.key.frame_idx).toBe(0)
    expect(pipeline.peek(failed_key)).toBeNull()

    const recovered_key = key(2)
    const recovered_generation = pipeline.begin_request(recovered_key)
    await expect(pipeline.request({
      key: recovered_key,
      priority: `current`,
      estimated_bytes: 64,
      prepare: async () => prepared(recovered_key),
    }, recovered_generation)).resolves.toMatchObject({
      status: `ready`,
      value: { key: { frame_idx: 2 } },
    })
  })

  test(`owner change releases the old cache and cache bounds stay strict`, async () => {
    const pipeline = create_prepared_frame_pipeline({
      max_frames: 8,
      max_bytes: 512,
    })
    for (let frame_idx = 0; frame_idx < 12; frame_idx++) {
      const frame_key = key(frame_idx)
      const generation = pipeline.begin_request(frame_key)
      await pipeline.request({
        key: frame_key,
        priority: `current`,
        estimated_bytes: 64,
        prepare: async () => prepared(frame_key),
      }, generation)
      expect(pipeline.stats().cached_frames).toBeLessThanOrEqual(8)
      expect(pipeline.stats().cached_bytes).toBeLessThanOrEqual(512)
    }

    const old_key = key(11)
    const new_owner = {}
    pipeline.begin_request(key(0, { owner: new_owner }))
    expect(pipeline.peek(old_key)).toBeNull()
  })

  test(`position edits invalidate only older revisions of the edited frame`, async () => {
    const pipeline = create_prepared_frame_pipeline()
    const frame_zero = key(0)
    const frame_one = key(1)
    for (const frame_key of [frame_zero, frame_one]) {
      const generation = pipeline.begin_request(frame_key)
      await pipeline.request({
        key: frame_key,
        priority: `current`,
        estimated_bytes: 64,
        prepare: async () => prepared(frame_key),
      }, generation)
    }

    const edited = key(0, { positions_version: 99 })
    pipeline.begin_request(edited)

    expect(pipeline.peek(frame_zero)).toBeNull()
    expect(pipeline.peek(frame_one)).not.toBeNull()
  })

  test(`context restore re-uploads once without replacing texture identity`, () => {
    const positions = new SharedPositionTexture()
    const colors = new SharedAtomColorTexture()
    const position_texture = positions.texture
    const color_texture = colors.texture
    positions.update({
      owner,
      frame_idx: 0,
      positions_version: 1,
      positions: Float32Array.of(1, 2, 3),
      lattice: Float32Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1),
    })
    colors.update({
      version: 1,
      atom_count: 1,
      colors: Float32Array.of(1, 1, 1),
    })

    expect(positions.restore()).toBe(true)
    expect(colors.restore()).toBe(true)
    expect(positions.texture).toBe(position_texture)
    expect(colors.texture).toBe(color_texture)
    expect(positions.stats().uploads).toBe(2)
    expect(colors.stats()).toMatchObject({ uploads: 1, restores: 1 })
    positions.dispose()
    colors.dispose()
  })

  test(`production path never imports the cadence-era diagnostic`, () => {
    const source = readFileSync(
      resolve(process.cwd(), `src/lib/structure/StructureScene.svelte`),
      `utf8`,
    )
    expect(source).not.toContain(`trajectory-bond-legacy-diagnostic`)
    expect(source).toContain(`webglcontextrestored`)
    expect(source).toContain(`shared_position_texture.restore()`)
    expect(source).toContain(`shared_atom_color_texture.restore()`)
    expect(source).toContain(`prepared_pipeline.clear()`)
  })
})

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as THREE from 'three'
import {
  create_replica_id_codec,
  decode_replica_pick_id,
  encode_replica_atom_id,
  encode_replica_bond_id,
  encode_replica_ghost_id,
  logical_site_for_replica_pick_id,
  REPLICA_PICK_MAX_ID,
  REPLICA_PICK_MISS_ID,
  ReplicaPickScene,
  resolve_replica_pick_action,
  type ScenePickResult,
} from '$lib/structure/gpu/webgl2/replica-id-picker'
import type { PickPixelRenderer } from '$lib/structure/gpu-picker'
import { create_large_system_renderer } from '$lib/structure/gpu/large-system-renderer'
import {
  create_render_packet_builder,
  type PacketBondConnectivity,
} from '$lib/structure/scene/render-packet-builder'
import type {
  BaseBondGraph,
  ImageInstanceTable,
  RenderPacket,
  ReplicaLayout,
} from '$lib/structure/scene/render-packet'
import type { AnyStructure, Site } from '$lib'
import { SharedPositionTexture } from '$lib/structure/gpu/webgl2/shared-position-texture'
import { decode_compact_bond_instance } from '$lib/structure/gpu/webgl2/compact-bond-instance-layout'

const EMPTY_IMAGES: ImageInstanceTable = {
  count: 0,
  base_sites: new Uint32Array(0),
  jimages: new Int8Array(0),
}

function visual_layout(
  dims: readonly [number, number, number] = [2, 1, 1],
): ReplicaLayout {
  return {
    version: 1,
    dims,
    boundary_policy: 'ghost-images',
    semantics: 'visual-shared-base',
  }
}

describe('replica integer pick ID codec', () => {
  test('same base atom in different visual cells has one logical site', () => {
    const replicas = visual_layout()
    const codec = create_replica_id_codec({
      base_atom_count: 2,
      base_bond_count: 0,
      replicas,
      ghost_count: 0,
    })

    const cell_0_id = encode_replica_atom_id(codec, 1)
    const cell_1_id = encode_replica_atom_id(codec, 3)
    expect(cell_0_id).not.toBe(cell_1_id)
    expect(decode_replica_pick_id(cell_0_id, codec, replicas, EMPTY_IMAGES)).toEqual({
      kind: 'atom',
      base_site: 1,
      cell: [0, 0, 0],
      ghost: false,
    })
    expect(decode_replica_pick_id(cell_1_id, codec, replicas, EMPTY_IMAGES)).toEqual({
      kind: 'atom',
      base_site: 1,
      cell: [1, 0, 0],
      ghost: false,
    })
    expect(
      logical_site_for_replica_pick_id(cell_0_id, codec, replicas, EMPTY_IMAGES),
    ).toBe(1)
    expect(
      logical_site_for_replica_pick_id(cell_1_id, codec, replicas, EMPTY_IMAGES),
    ).toBe(1)
  })

  test('ghost IDs map through the sparse image table to the base atom', () => {
    const replicas = visual_layout([1, 1, 1])
    const images: ImageInstanceTable = {
      count: 1,
      base_sites: Uint32Array.from([2]),
      jimages: Int8Array.from([-1, 1, 0]),
    }
    const codec = create_replica_id_codec({
      base_atom_count: 3,
      base_bond_count: 1,
      replicas,
      ghost_count: images.count,
    })
    const id = encode_replica_ghost_id(codec, 0)

    expect(decode_replica_pick_id(id, codec, replicas, images)).toEqual({
      kind: 'atom',
      base_site: 2,
      cell: [-1, 1, 0],
      ghost: true,
    })
    expect(logical_site_for_replica_pick_id(id, codec, replicas, images)).toBe(2)
  })

  test('physical-distinct semantics resolve through physical_site_map', () => {
    const replicas: ReplicaLayout = {
      version: 1,
      dims: [2, 1, 1],
      boundary_policy: 'stub',
      semantics: 'physical-distinct-sites',
      physical_site_map: Uint32Array.from([10, 11, 20, 21]),
    }
    const codec = create_replica_id_codec({
      base_atom_count: 2,
      base_bond_count: 0,
      replicas,
      ghost_count: 0,
    })

    const first = encode_replica_atom_id(codec, 1)
    const second = encode_replica_atom_id(codec, 3)
    expect(logical_site_for_replica_pick_id(first, codec, replicas, EMPTY_IMAGES)).toBe(
      11,
    )
    expect(logical_site_for_replica_pick_id(second, codec, replicas, EMPTY_IMAGES)).toBe(
      21,
    )
  })

  test('same-dims malformed physical map returns a safe miss', () => {
    const replicas: ReplicaLayout = {
      version: 1,
      dims: [2, 1, 1],
      boundary_policy: 'stub',
      semantics: 'physical-distinct-sites',
      physical_site_map: Uint32Array.from([10, 11, 20, 21]),
    }
    const codec = create_replica_id_codec({
      base_atom_count: 2,
      base_bond_count: 0,
      replicas,
      ghost_count: 0,
    })
    const id = encode_replica_atom_id(codec, 3)
    const malformed: ReplicaLayout = {
      ...replicas,
      physical_site_map: Uint32Array.from([30, 31, 40]),
    }

    expect(decode_replica_pick_id(id, codec, malformed, EMPTY_IMAGES)).toEqual({
      kind: 'miss',
      base_site: -1,
      cell: [0, 0, 0],
      ghost: false,
    })
    expect(logical_site_for_replica_pick_id(id, codec, malformed, EMPTY_IMAGES)).toBe(-1)
  })

  test('same-dims physical layout missing its map returns a safe miss', () => {
    const replicas: ReplicaLayout = {
      version: 1,
      dims: [2, 1, 1],
      boundary_policy: 'stub',
      semantics: 'physical-distinct-sites',
      physical_site_map: Uint32Array.from([10, 11, 20, 21]),
    }
    const codec = create_replica_id_codec({
      base_atom_count: 2,
      base_bond_count: 0,
      replicas,
      ghost_count: 0,
    })
    const id = encode_replica_atom_id(codec, 3)
    const missing: ReplicaLayout = {
      version: 2,
      dims: [2, 1, 1],
      boundary_policy: 'stub',
      semantics: 'physical-distinct-sites',
    }

    expect(decode_replica_pick_id(id, codec, missing, EMPTY_IMAGES)).toEqual({
      kind: 'miss',
      base_site: -1,
      cell: [0, 0, 0],
      ghost: false,
    })
    expect(logical_site_for_replica_pick_id(id, codec, missing, EMPTY_IMAGES)).toBe(-1)
  })

  test('same-dims semantics mismatch returns a safe miss', () => {
    const replicas: ReplicaLayout = {
      version: 1,
      dims: [2, 1, 1],
      boundary_policy: 'stub',
      semantics: 'physical-distinct-sites',
      physical_site_map: Uint32Array.from([10, 11, 20, 21]),
    }
    const codec = create_replica_id_codec({
      base_atom_count: 2,
      base_bond_count: 0,
      replicas,
      ghost_count: 0,
    })
    const id = encode_replica_atom_id(codec, 3)
    const visual = visual_layout()

    expect(decode_replica_pick_id(id, codec, visual, EMPTY_IMAGES)).toEqual({
      kind: 'miss',
      base_site: -1,
      cell: [0, 0, 0],
      ghost: false,
    })
    expect(logical_site_for_replica_pick_id(id, codec, visual, EMPTY_IMAGES)).toBe(-1)
  })

  test('visual-shared layouts reject an incompatible physical map', () => {
    const replicas = visual_layout()
    const codec = create_replica_id_codec({
      base_atom_count: 2,
      base_bond_count: 0,
      replicas,
      ghost_count: 0,
    })
    const id = encode_replica_atom_id(codec, 3)
    const incompatible: ReplicaLayout = {
      ...replicas,
      physical_site_map: Uint32Array.from([10, 11, 20, 21]),
    }

    expect(decode_replica_pick_id(id, codec, incompatible, EMPTY_IMAGES)).toEqual({
      kind: 'miss',
      base_site: -1,
      cell: [0, 0, 0],
      ghost: false,
    })
    expect(logical_site_for_replica_pick_id(id, codec, incompatible, EMPTY_IMAGES)).toBe(
      -1,
    )
  })

  test('same-length replacement physical map remains valid', () => {
    const replicas: ReplicaLayout = {
      version: 1,
      dims: [2, 1, 1],
      boundary_policy: 'stub',
      semantics: 'physical-distinct-sites',
      physical_site_map: Uint32Array.from([10, 11, 20, 21]),
    }
    const codec = create_replica_id_codec({
      base_atom_count: 2,
      base_bond_count: 0,
      replicas,
      ghost_count: 0,
    })
    const id = encode_replica_atom_id(codec, 3)
    const replacement: ReplicaLayout = {
      ...replicas,
      version: 2,
      physical_site_map: Uint32Array.from([30, 31, 40, 41]),
    }

    expect(decode_replica_pick_id(id, codec, replacement, EMPTY_IMAGES)).toEqual({
      kind: 'atom',
      base_site: 1,
      cell: [1, 0, 0],
      ghost: false,
    })
    expect(logical_site_for_replica_pick_id(id, codec, replacement, EMPTY_IMAGES)).toBe(
      41,
    )
  })

  test('bond IDs preserve the base graph index and cell without atom mapping', () => {
    const replicas: ReplicaLayout = {
      version: 1,
      dims: [2, 1, 1],
      boundary_policy: 'stub',
      semantics: 'physical-distinct-sites',
      physical_site_map: Uint32Array.from([100, 101, 200, 201]),
    }
    const codec = create_replica_id_codec({
      base_atom_count: 2,
      base_bond_count: 3,
      replicas,
      ghost_count: 0,
    })
    const id = encode_replica_bond_id(codec, 5)

    expect(decode_replica_pick_id(id, codec, replicas, EMPTY_IMAGES)).toEqual({
      kind: 'bond',
      base_site: 2,
      cell: [1, 0, 0],
      ghost: false,
    })
    expect(logical_site_for_replica_pick_id(id, codec, replicas, EMPTY_IMAGES)).toBe(2)
  })

  test('miss and malformed integer IDs fail safely', () => {
    const replicas = visual_layout()
    const codec = create_replica_id_codec({
      base_atom_count: 2,
      base_bond_count: 1,
      replicas,
      ghost_count: 1,
    })
    const miss = {
      kind: 'miss',
      base_site: -1,
      cell: [0, 0, 0],
      ghost: false,
    }

    expect(decode_replica_pick_id(REPLICA_PICK_MISS_ID, codec, replicas)).toEqual(miss)
    expect(decode_replica_pick_id(-1, codec, replicas)).toEqual(miss)
    expect(decode_replica_pick_id(1.5, codec, replicas)).toEqual(miss)
    expect(decode_replica_pick_id(Number.NaN, codec, replicas)).toEqual(miss)
    expect(decode_replica_pick_id(codec.max_id + 1, codec, replicas)).toEqual(miss)
    expect(
      decode_replica_pick_id(
        encode_replica_ghost_id(codec, 0),
        codec,
        replicas,
        EMPTY_IMAGES,
      ),
    ).toEqual(miss)
    expect(
      decode_replica_pick_id(
        encode_replica_atom_id(codec, 0),
        codec,
        visual_layout([1, 2, 1]),
        EMPTY_IMAGES,
      ),
    ).toEqual(miss)
  })

  test('kind ranges are collision-free and reject out-of-range indices', () => {
    const replicas = visual_layout()
    const codec = create_replica_id_codec({
      base_atom_count: 2,
      base_bond_count: 3,
      replicas,
      ghost_count: 2,
    })
    const ids = [
      ...Array.from(
        { length: codec.atom_instance_count },
        (_, index) => encode_replica_atom_id(codec, index),
      ),
      ...Array.from(
        { length: codec.bond_instance_count },
        (_, index) => encode_replica_bond_id(codec, index),
      ),
      ...Array.from(
        { length: codec.ghost_count },
        (_, index) => encode_replica_ghost_id(codec, index),
      ),
    ]

    expect(ids).not.toContain(REPLICA_PICK_MISS_ID)
    expect(new Set(ids).size).toBe(ids.length)
    expect(Math.max(...ids)).toBe(codec.max_id)
    expect(() => encode_replica_atom_id(codec, codec.atom_instance_count)).toThrow(
      RangeError,
    )
    expect(() => encode_replica_bond_id(codec, -1)).toThrow(RangeError)
    expect(() => encode_replica_ghost_id(codec, 0.5)).toThrow(RangeError)
  })

  test('validates uint32 capacity without constructing N x cell tables', () => {
    const replicas = visual_layout([2, 2, 2])
    const codec = create_replica_id_codec({
      base_atom_count: 20_000,
      base_bond_count: 50_000,
      replicas,
      ghost_count: 7,
    })

    expect(codec.atom_instance_count).toBe(160_000)
    expect(codec.bond_instance_count).toBe(400_000)
    expect(codec.max_id).toBe(560_007)
    expect(codec.semantics).toBe('visual-shared-base')
    expect(Object.values(codec).every((value) => typeof value !== 'object')).toBe(true)
    expect(Object.isFrozen(codec)).toBe(true)

    const edge = create_replica_id_codec({
      base_atom_count: REPLICA_PICK_MAX_ID,
      base_bond_count: 0,
      replicas: visual_layout([1, 1, 1]),
      ghost_count: 0,
    })
    expect(encode_replica_atom_id(edge, REPLICA_PICK_MAX_ID - 1)).toBe(
      REPLICA_PICK_MAX_ID,
    )

    expect(() =>
      create_replica_id_codec({
        base_atom_count: REPLICA_PICK_MAX_ID,
        base_bond_count: 1,
        replicas: visual_layout([1, 1, 1]),
        ghost_count: 0,
      })
    ).toThrow(/uint32 capacity/)
    expect(() =>
      create_replica_id_codec({
        base_atom_count: 1,
        base_bond_count: 0,
        replicas: visual_layout([2, 1, 1]),
        ghost_count: REPLICA_PICK_MAX_ID,
      })
    ).toThrow(/uint32 capacity/)
  })

  test('rejects invalid counts, dimensions, and physical maps explicitly', () => {
    expect(() =>
      create_replica_id_codec({
        base_atom_count: -1,
        base_bond_count: 0,
        replicas: visual_layout(),
        ghost_count: 0,
      })
    ).toThrow(/base_atom_count/)
    expect(() =>
      create_replica_id_codec({
        base_atom_count: 1,
        base_bond_count: 0,
        replicas: visual_layout([0, 1, 1]),
        ghost_count: 0,
      })
    ).toThrow(/replica dims/)
    expect(() =>
      create_replica_id_codec({
        base_atom_count: 2,
        base_bond_count: 0,
        replicas: {
          version: 1,
          dims: [2, 1, 1],
          boundary_policy: 'stub',
          semantics: 'physical-distinct-sites',
          physical_site_map: Uint32Array.from([10, 11]),
        },
        ghost_count: 0,
      })
    ).toThrow(/physical_site_map/)
    expect(() =>
      create_replica_id_codec({
        base_atom_count: 2,
        base_bond_count: 0,
        replicas: {
          ...visual_layout(),
          physical_site_map: Uint32Array.from([10, 11, 20, 21]),
        },
        ghost_count: 0,
      })
    ).toThrow(/visual-shared-base/)
  })
})

// ── T5 integration: WebGL2 pick scene + action resolution + WebGPU snapshot ──

function carbon_site(xyz: [number, number, number]): Site {
  return {
    species: [{ element: 'C', occu: 1, oxidation_state: 0 }],
    abc: [0, 0, 0],
    xyz,
    label: 'C',
    properties: {},
  } as unknown as Site
}

function make_structure(n: number, a = 10): AnyStructure {
  const sites = Array.from({ length: n }, (_, idx) => carbon_site([1.4 * idx, 0, 0]))
  return {
    sites,
    lattice: {
      matrix: [[a, 0, 0], [0, a, 0], [0, 0, a]],
      pbc: [true, true, true],
      a,
      b: a,
      c: a,
      alpha: 90,
      beta: 90,
      gamma: 90,
      volume: a ** 3,
    },
  } as unknown as AnyStructure
}

function make_packet(input: {
  n: number
  dims: readonly [number, number, number]
  boundary_policy?: 'stub' | 'hide' | 'ghost-images'
  bonds?: PacketBondConnectivity[]
}): RenderPacket {
  const builder = create_render_packet_builder()
  return builder.build({
    structure: make_structure(input.n),
    bond_connectivity: input.bonds ?? null,
    dims: input.dims,
    boundary_policy: input.boundary_policy ?? 'stub',
  })
}

/** Minimal WebGL-free renderer fake: pick renders no-op, readback pops the
 *  next injected uint32 ID into the 4-byte RGBA little-endian pixel. */
function make_fake_pick_renderer(ids: number[]): PickPixelRenderer {
  return {
    domElement: { width: 200, height: 100 } as HTMLCanvasElement,
    getRenderTarget: () => null,
    setRenderTarget: () => {},
    getClearColor: (target: THREE.Color) => target,
    getClearAlpha: () => 1,
    setClearColor: () => {},
    clear: () => {},
    render: () => {},
    readRenderTargetPixels: (
      _target: unknown,
      _x: number,
      _y: number,
      _w: number,
      _h: number,
      buffer: Uint8Array,
    ) => {
      const id = ids.shift() ?? 0
      buffer[0] = id & 0xff
      buffer[1] = (id >>> 8) & 0xff
      buffer[2] = (id >>> 16) & 0xff
      buffer[3] = (id >>> 24) & 0xff
    },
  } as unknown as PickPixelRenderer
}

function make_pick_scene(packet?: RenderPacket): ReplicaPickScene {
  const positions = new SharedPositionTexture()
  if (packet) positions.update(packet.frame)
  const scene = new ReplicaPickScene({
    renderer: make_fake_pick_renderer([]) as unknown as THREE.WebGLRenderer,
    positions,
  })
  const dispose = scene.dispose.bind(scene)
  scene.dispose = () => {
    dispose()
    positions.dispose()
  }
  return scene
}

describe('ReplicaPickScene — WebGL2 integer GPU ID pass', () => {
  const camera = new THREE.PerspectiveCamera(50, 2, 0.1, 100)

  test('same base atom picked in two replica cells folds to one base site', () => {
    const packet = make_packet({ n: 2, dims: [2, 1, 1] })
    const scene = make_pick_scene(packet)
    scene.sync(packet)
    const codec = scene.codec
    if (codec === null) throw new Error('codec missing after sync')

    // atom-major instance indices: atom 1 in cell 0 → 1; atom 1 in cell 1 → 3.
    const ids = [encode_replica_atom_id(codec, 1), encode_replica_atom_id(codec, 3)]
    const fake = make_fake_pick_renderer([...ids])
    const first = scene.pick(fake, camera, 0, 0)
    const second = scene.pick(fake, camera, 0, 0)

    expect(first.pick).toEqual({
      kind: 'atom',
      base_site: 1,
      cell: [0, 0, 0],
      ghost: false,
    })
    expect(second.pick).toEqual({
      kind: 'atom',
      base_site: 1,
      cell: [1, 0, 0],
      ghost: false,
    })
    // ONE base selection flag: both replica picks resolve to one logical site.
    expect(new Set([first.logical_site, second.logical_site]).size).toBe(1)
    expect(first.logical_site).toBe(1)
    scene.dispose()
  })

  test('ghost instances map through the sparse table to their base site', () => {
    const packet = make_packet({
      n: 3,
      dims: [1, 1, 1],
      boundary_policy: 'ghost-images',
      bonds: [{ site_idx_1: 1, site_idx_2: 2, jimage: [1, 0, 0] }],
    })
    const scene = make_pick_scene(packet)
    scene.sync(packet)
    const codec = scene.codec
    if (codec === null) throw new Error('codec missing after sync')
    expect(codec.ghost_count).toBe(1)

    const fake = make_fake_pick_renderer([encode_replica_ghost_id(codec, 0)])
    const picked = scene.pick(fake, camera, 0, 0)
    expect(picked.pick).toEqual({
      kind: 'atom',
      base_site: 2,
      cell: [1, 0, 0],
      ghost: true,
    })
    expect(picked.logical_site).toBe(2)
    scene.dispose()
  })

  test('bond picks resolve to the base bond graph index in any replica cell', () => {
    const packet = make_packet({
      n: 3,
      dims: [2, 1, 1],
      bonds: [
        { site_idx_1: 0, site_idx_2: 1 },
        { site_idx_1: 1, site_idx_2: 2, jimage: [1, 0, 0] },
        { site_idx_1: 0, site_idx_2: 0, jimage: [0, 0, 1] },
      ],
    })
    const scene = make_pick_scene(packet)
    scene.sync(packet)
    const codec = scene.codec
    if (codec === null) throw new Error('codec missing after sync')
    expect(codec.base_bond_count).toBe(3)

    // bond graph index 2 in replica cell 1 → atom-major bond instance 2 + 3·1.
    const fake = make_fake_pick_renderer([encode_replica_bond_id(codec, 5)])
    const picked = scene.pick(fake, camera, 0, 0)
    expect(picked.pick).toEqual({
      kind: 'bond',
      base_site: 2,
      cell: [1, 0, 0],
      ghost: false,
    })
    expect(picked.logical_site).toBe(2)

    // Both compact half-bond instances fold to ONE bond graph index in the
    // shader-side encode (bond_index = gl_InstanceID / (2 * cell count)).
    expect(scene.bond_material.vertexShader).toContain('2 * uCellCount')
    expect(scene.bond_material.vertexShader).toContain('gl_InstanceID / group_size')
    expect(scene.bond_material.vertexShader).toContain(
      'int half_index = within_bond / uCellCount',
    )
    expect(scene.bond_material.vertexShader).toContain('half_index == 1')
    expect(scene.bond_material.vertexShader).not.toMatch(/\bint\s+half\b/)
    expect(scene.bond_material.vertexShader).not.toMatch(/\bhalf\s*==/)
    expect(scene.bond_material.vertexShader).toContain('uBondFirstId')
    expect(scene.bond_material.vertexShader).toContain('uBaseBondCount * cell_index')
    scene.dispose()
  })

  test.each([
    [1, 1, 1],
    [2, 1, 1],
    [2, 2, 2],
  ] as const)(
    'compact bond instances map both halves in every cell to one logical ID for dims %j',
    (...dims) => {
      const bonds: PacketBondConnectivity[] = [
        { site_idx_1: 0, site_idx_2: 1 },
        { site_idx_1: 1, site_idx_2: 2, jimage: [1, 0, 0] },
      ]
      const packet = make_packet({ n: 3, dims, bonds })
      const scene = make_pick_scene(packet)
      scene.sync(packet)
      const codec = scene.codec
      if (codec === null) throw new Error('codec missing after sync')

      const geometry = scene.bond_mesh.geometry as THREE.InstancedBufferGeometry
      const cell_count = dims[0] * dims[1] * dims[2]
      const site = geometry.getAttribute('a_site') as THREE.InstancedBufferAttribute
      const jimage = geometry.getAttribute('a_jimage') as THREE.InstancedBufferAttribute
      expect(site.count).toBe(2)
      expect(jimage.count).toBe(2)
      expect(site.meshPerAttribute).toBe(2 * cell_count)
      expect(jimage.meshPerAttribute).toBe(2 * cell_count)
      expect(geometry.getAttribute('a_half')).toBeUndefined()
      expect(geometry.instanceCount).toBe(2 * 2 * cell_count)

      for (let instance_index = 0; instance_index < geometry.instanceCount; instance_index++) {
        const decoded = decode_compact_bond_instance(instance_index, dims)
        const id = codec.bond_first_id + decoded.bond_index +
          codec.base_bond_count * decoded.cell_index
        expect(decode_replica_pick_id(id, codec, packet.replicas, scene.images)).toEqual({
          kind: 'bond',
          base_site: decoded.bond_index,
          cell: decoded.cell,
          ghost: false,
        })
      }
      scene.dispose()
    },
  )

  test('integer ID encode lives in the shaders — atoms, bonds, ghosts', () => {
    const scene = make_pick_scene()
    expect(scene.atom_material.vertexShader).toContain('uAtomFirstId')
    expect(scene.atom_material.vertexShader).toContain('gl_InstanceID / uCellCount')
    expect(scene.atom_material.vertexShader).toContain('uBaseCount * cell_index')
    expect(scene.ghost_material.vertexShader).toContain('uGhostFirstId')
    for (
      const material of [scene.atom_material, scene.bond_material, scene.ghost_material]
    ) {
      expect(material.fragmentShader).toContain('fragColor = vPickColor')
    }
    scene.dispose()
  })

  test('zero N×C CPU expansion — attributes stay base-sized with shared positions', () => {
    const n = 50
    const cell_count = 27
    const packet = make_packet({
      n,
      dims: [3, 3, 3],
      boundary_policy: 'ghost-images',
      bonds: [
        { site_idx_1: 0, site_idx_2: 1 },
        { site_idx_1: 1, site_idx_2: 2, jimage: [1, 0, 0] },
        { site_idx_1: 0, site_idx_2: 0, jimage: [0, 0, 1] },
      ],
    })
    const scene = make_pick_scene(packet)
    scene.sync(packet)

    const atom_geometry = scene.atom_mesh.geometry as THREE.InstancedBufferGeometry
    const bond_geometry = scene.bond_mesh.geometry as THREE.InstancedBufferGeometry
    expect(atom_geometry.instanceCount).toBe(n * cell_count)
    expect(bond_geometry.instanceCount).toBe(3 * 2 * cell_count)

    const site_attr = atom_geometry.getAttribute(
      'instanceSite',
    ) as THREE.InstancedBufferAttribute
    expect(site_attr.count).toBe(n)
    expect(site_attr.meshPerAttribute).toBe(cell_count)
    expect((scene.atom_material.uniforms.uPosTex.value as THREE.DataTexture).image.data)
      .not.toBe(packet.frame.positions)

    // No instanceMatrix and no attribute anywhere near N×C instance size.
    for (const mesh of [scene.atom_mesh, scene.bond_mesh, scene.ghost_mesh]) {
      expect((mesh as unknown as { instanceMatrix?: unknown }).instanceMatrix)
        .toBeUndefined()
      const geometry = mesh.geometry as THREE.InstancedBufferGeometry
      for (const [name, attribute] of Object.entries(geometry.attributes)) {
        if (name === 'position') continue // shared unit quad/box corners
        expect(
          attribute.array.length,
          `${name} must stay base-sized`,
        ).toBeLessThan(n * cell_count)
      }
    }
    scene.dispose()
  })

  test('miss, stale and out-of-range IDs fail safely', () => {
    const packet = make_packet({ n: 2, dims: [2, 1, 1] })
    const scene = make_pick_scene(packet)
    scene.sync(packet)
    const codec = scene.codec
    if (codec === null) throw new Error('codec missing after sync')

    const fake = make_fake_pick_renderer([0, codec.max_id + 1])
    for (let round = 0; round < 2; round++) {
      const picked = scene.pick(fake, camera, 0, 0)
      expect(picked.pick.kind).toBe('miss')
      expect(picked.logical_site).toBe(-1)
    }
    scene.dispose()
  })
})

describe('replica pick action resolution (base-site selection)', () => {
  const site_ids = Uint32Array.from([0, 1, 2])

  function atom_pick(
    base_site: number,
    cell: [number, number, number],
    logical_site = base_site,
  ): ScenePickResult {
    return {
      pick: { kind: 'atom', base_site, cell, ghost: false },
      logical_site,
    }
  }

  test('visual layouts store ONE base selection flag across replica cells', () => {
    const first = resolve_replica_pick_action(
      atom_pick(1, [0, 0, 0]),
      'visual-shared-base',
      site_ids,
      null,
    )
    const second = resolve_replica_pick_action(
      atom_pick(1, [1, 0, 0]),
      'visual-shared-base',
      site_ids,
      null,
    )
    expect(first).toEqual({ type: 'atom', site_idx: 1 })
    expect(second).toEqual({ type: 'atom', site_idx: 1 })
    const selected = new Set<number>()
    for (const action of [first, second]) {
      if (action?.type === 'atom') selected.add(action.site_idx)
    }
    expect(selected.size).toBe(1)
  })

  test('physical-distinct provenance keeps distinct physical IDs', () => {
    const first = resolve_replica_pick_action(
      atom_pick(1, [0, 0, 0], 11),
      'physical-distinct-sites',
      site_ids,
      null,
    )
    const second = resolve_replica_pick_action(
      atom_pick(1, [1, 0, 0], 21),
      'physical-distinct-sites',
      site_ids,
      null,
    )
    expect(first).toEqual({ type: 'atom', site_idx: 11 })
    expect(second).toEqual({ type: 'atom', site_idx: 21 })
  })

  test('bond picks route the graph index through slot_to_filtered_idx', () => {
    const picked: ScenePickResult = {
      pick: { kind: 'bond', base_site: 2, cell: [1, 0, 0], ghost: false },
      logical_site: 2,
    }
    expect(
      resolve_replica_pick_action(
        picked,
        'visual-shared-base',
        site_ids,
        Int32Array.from([10, 11, 12]),
      ),
    ).toEqual({ type: 'bond', filtered_idx: 12 })
    // Orphan (-1), out-of-range, and missing maps degrade to null hits.
    expect(
      resolve_replica_pick_action(
        picked,
        'visual-shared-base',
        site_ids,
        Int32Array.from([10, 11, -1]),
      ),
    ).toBeNull()
    expect(
      resolve_replica_pick_action(
        picked,
        'visual-shared-base',
        site_ids,
        Int32Array.from([10]),
      ),
    ).toBeNull()
    expect(
      resolve_replica_pick_action(picked, 'visual-shared-base', site_ids, null),
    ).toBeNull()
  })

  test('miss and out-of-range logical sites resolve to null', () => {
    expect(
      resolve_replica_pick_action(
        {
          pick: { kind: 'miss', base_site: -1, cell: [0, 0, 0], ghost: false },
          logical_site: -1,
        },
        'visual-shared-base',
        site_ids,
        null,
      ),
    ).toBeNull()
    expect(
      resolve_replica_pick_action(
        atom_pick(7, [0, 0, 0]),
        'visual-shared-base',
        site_ids,
        null,
      ),
    ).toBeNull()
  })
})

// ── WebGPU adapter: pick decode must snapshot layout state at REQUEST time ──

type DeferredMap = { promise: Promise<void>; resolve: () => void }

function make_deferred(): DeferredMap {
  let resolve_map!: () => void
  const promise = new Promise<void>((done) => {
    resolve_map = done
  })
  return { promise, resolve: resolve_map }
}

function make_pick_mock_device(opts: {
  pick_reads: number[]
  pick_maps: Promise<void>[]
}) {
  const device = {
    limits: { maxStorageBufferBindingSize: 1 << 27 },
    createBuffer: (desc: { size: number; label?: string }) => ({
      label: desc.label,
      size: desc.size,
      destroy: () => {},
      mapAsync: () => {
        if (desc.label === 'large-system-pick-readback') {
          return opts.pick_maps.shift() ?? Promise.resolve()
        }
        return Promise.resolve()
      },
      getMappedRange: () => {
        const buf = new ArrayBuffer(Math.max(desc.size, 8))
        if (desc.label === 'large-system-pick-readback') {
          const next = opts.pick_reads.shift()
          if (next !== undefined) new Uint32Array(buf)[0] = next
        }
        return buf
      },
      unmap: () => {},
    }),
    createTexture: (desc: { size: { width: number; height: number } }) => ({
      width: desc.size.width,
      height: desc.size.height,
      createView: () => ({}),
      destroy: () => {},
    }),
    createShaderModule: () => ({}),
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createRenderPipeline: () => ({}),
    createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createBindGroup: () => ({}),
    createCommandEncoder: () => ({
      beginComputePass: () => ({
        setPipeline: () => {},
        setBindGroup: () => {},
        dispatchWorkgroups: () => {},
        end: () => {},
      }),
      beginRenderPass: () => ({
        setPipeline: () => {},
        setBindGroup: () => {},
        draw: () => {},
        drawIndirect: () => {},
        end: () => {},
      }),
      copyBufferToBuffer: () => {},
      copyTextureToBuffer: () => {},
      finish: () => ({}),
    }),
    queue: { writeBuffer: () => {}, submit: () => {} },
  }
  return device
}

const N_SNAP = 8

function snapshot_topology(bond_graph?: BaseBondGraph): RenderPacket['topology'] {
  return {
    version: 1,
    atom_count: N_SNAP,
    site_ids: Uint32Array.from({ length: N_SNAP }, (_, idx) => idx),
    atomic_numbers: new Uint8Array(N_SNAP).fill(6),
    radii: new Float32Array(N_SNAP).fill(0.5),
    colors: new Float32Array(N_SNAP * 3).fill(0.5),
    bond_graph,
  }
}

function snapshot_frame(): RenderPacket['frame'] {
  return {
    owner: { tag: 'snapshot-owner' },
    frame_idx: 0,
    positions_version: 0,
    positions: new Float32Array(N_SNAP * 3),
    lattice: new Float32Array([20, 0, 0, 0, 20, 0, 0, 0, 20]),
  }
}

describe('WebGPU pick decode — request-time snapshot', () => {
  beforeAll(() => {
    vi.stubGlobal('navigator', {
      gpu: { getPreferredCanvasFormat: () => 'bgra8unorm' },
    })
    vi.stubGlobal('GPUShaderStage', { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 })
    vi.stubGlobal('GPUBufferUsage', {
      MAP_READ: 1,
      MAP_WRITE: 2,
      COPY_SRC: 4,
      COPY_DST: 8,
      INDEX: 16,
      VERTEX: 32,
      UNIFORM: 64,
      STORAGE: 128,
      INDIRECT: 256,
      QUERY_RESOLVE: 512,
    })
    vi.stubGlobal('GPUMapMode', { READ: 1, WRITE: 2 })
    vi.stubGlobal('GPUTextureUsage', {
      COPY_SRC: 1,
      COPY_DST: 2,
      TEXTURE_BINDING: 4,
      STORAGE_BINDING: 8,
      RENDER_ATTACHMENT: 16,
    })
  })
  afterAll(() => {
    vi.unstubAllGlobals()
  })

  test('layout/image churn during mapAsync cannot re-interpret the picked id', async () => {
    const deferred = make_deferred()
    const device = make_pick_mock_device({
      // id 17 → g = 16 = base_count·ncells under the REQUEST layout [2,1,1]:
      // ghost 0 → base 5 at absolute image [-1,0,0].
      pick_reads: [17],
      pick_maps: [deferred.promise],
    })
    const canvas = {
      width: 8,
      height: 8,
      getContext: () => ({
        configure: () => {},
        unconfigure: () => {},
        getCurrentTexture: () => ({ createView: () => ({}) }),
      }),
    }
    const renderer = create_large_system_renderer(
      device as unknown as GPUDevice,
      canvas as unknown as HTMLCanvasElement,
    )
    const graph: BaseBondGraph = {
      version: 1,
      pairs: new Uint32Array([0, 5]),
      jimages: new Int8Array([-1, 0, 0]),
      kinds: new Uint8Array(1),
      strengths: new Float32Array([1]),
    }
    renderer.set_packet({
      topology: snapshot_topology(graph),
      frame: snapshot_frame(),
      replicas: {
        version: 1,
        dims: [2, 1, 1],
        boundary_policy: 'ghost-images',
        semantics: 'visual-shared-base',
      },
    }, EMPTY_IMAGES)

    const pending = renderer.pick(2, 2)

    // Mid-flight: replicas grow to [4,1,1] and the ghost table changes (the
    // new graph has no outside edge). Under POST-submit state, id 17 → g=16
    // would decode as a REAL replica atom (base 0, cell [2,0,0]) — wrong.
    renderer.set_packet({
      topology: snapshot_topology({
        version: 2,
        pairs: new Uint32Array([0, 1]),
        jimages: new Int8Array(3),
        kinds: new Uint8Array(1),
        strengths: new Float32Array([1]),
      }),
      frame: snapshot_frame(),
      replicas: {
        version: 2,
        dims: [4, 1, 1],
        boundary_policy: 'ghost-images',
        semantics: 'visual-shared-base',
      },
    }, EMPTY_IMAGES)

    deferred.resolve()
    const result = await pending
    expect(result).toEqual({
      kind: 'atom',
      base_site: 5,
      cell: [-1, 0, 0],
      ghost: true,
    })
    renderer.destroy()
  })
})

describe('packet path picking wiring (source contract)', () => {
  test('StructureScene gates the invisible CPU hitboxes off the packet path', () => {
    const scene_source = readFileSync(
      resolve(process.cwd(), 'src/lib/structure/StructureScene.svelte'),
      'utf8',
    )
    expect(scene_source).toContain(
      'let packet_picking_active = $derived(combined_packet_renderer_owned)',
    )
    expect(scene_source).toMatch(
      /atom_data\.length > 0 && show_bulk_atoms && !packet_picking_active/,
    )
    expect(scene_source).toMatch(
      /filtered_bond_pairs\.length > 0 && show_bulk_atoms && !packet_picking_active/,
    )
    // The scene wires the packet + click routing into the picker integration.
    expect(scene_source).toContain(
      'combined_packet_renderer_owned ? manager_render_packet : null',
    )
    expect(scene_source).toContain('on_packet_atom_click')
    expect(scene_source).toContain('on_packet_bond_click')
  })

  test('picker integration owns the packet branch and canvas click routing', () => {
    const integration_source = readFileSync(
      resolve(process.cwd(), 'src/lib/structure/gpu-picker-integration.svelte.ts'),
      'utf8',
    )
    expect(integration_source).toContain('get_render_packet')
    expect(integration_source).toContain('resolve_replica_pick_action')
    expect(integration_source).toMatch(/addEventListener\(\s*[`'"]click/)
  })
})

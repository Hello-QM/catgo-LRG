// gpu-visual-supercell Task 4 — WebGL2 atom replica impostors (design §7.1).
//
// The replica fast path must draw N × nx·ny·nz atom impostors from ONE plain
// `Mesh` over an `InstancedBufferGeometry` whose `instanceCount` is the
// replica product — with NO `instanceMatrix` and NO N×cell-count attribute
// expansion. Base attributes stay N-sized (divisor = cell count) and the
// shader decodes the replica cell from `gl_InstanceID`, translating by the
// CURRENT frame lattice held in uniforms (never baked into attributes).
// The legacy `InstancedMesh` path fails every one of these assertions: it
// allocates a capacity-sized `instanceMatrix` and needs one attribute slot
// per drawn instance.
import { describe, expect, test } from 'vitest'
import * as THREE from 'three'
import {
  AtomReplicaRenderer,
  cell_count_of,
  decode_webgl2_instance,
} from '$lib/structure/gpu/webgl2/atom-replica-renderer'
import {
  build_image_instance_table,
  decode_replica_instance,
} from '$lib/structure/scene/replica-layout'
import type { RenderPacket } from '$lib/structure/scene/render-packet'
import {
  create_render_packet_builder,
  type PacketBondConnectivity,
} from '$lib/structure/scene/render-packet-builder'
import { AtomManager } from '$lib/structure/atoms/atom-manager.svelte'
import { AtomInstancedRenderer } from '$lib/structure/atoms/atom-instanced-renderer'
import type { AnyStructure, Site } from '$lib'

function carbon_site(xyz: [number, number, number]): Site {
  return {
    species: [{ element: `C`, occu: 1, oxidation_state: 0 }],
    abc: [0, 0, 0],
    xyz,
    label: `C`,
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

// One intra-cell bond, one cross-cell bond, and one periodic SELF-image bond
// (a === b with non-zero jimage — valid, never filtered).
const BONDS: PacketBondConnectivity[] = [
  { site_idx_1: 0, site_idx_2: 1 },
  { site_idx_1: 1, site_idx_2: 2, jimage: [1, 0, 0] },
  { site_idx_1: 0, site_idx_2: 0, jimage: [0, 0, 1] },
]

function make_packet(
  dims: readonly [number, number, number],
  boundary_policy: `stub` | `hide` | `ghost-images` = `stub`,
): RenderPacket {
  const builder = create_render_packet_builder()
  return builder.build({
    structure: make_structure(3),
    bond_connectivity: BONDS,
    dims,
    boundary_policy,
  })
}

function geo(mesh: THREE.Mesh): THREE.InstancedBufferGeometry {
  return mesh.geometry as THREE.InstancedBufferGeometry
}

function attr(mesh: THREE.Mesh, name: string): THREE.InstancedBufferAttribute {
  return geo(mesh).getAttribute(name) as THREE.InstancedBufferAttribute
}

describe(`AtomReplicaRenderer — mesh shape`, () => {
  test(`plain Mesh over InstancedBufferGeometry — no instanceMatrix anywhere`, () => {
    const renderer = new AtomReplicaRenderer()
    renderer.update(make_packet([2, 2, 2]))

    for (const mesh of [renderer.mesh, renderer.ghost_mesh]) {
      expect(mesh).toBeInstanceOf(THREE.Mesh)
      expect((mesh as unknown as { isInstancedMesh?: boolean }).isInstancedMesh)
        .toBeFalsy()
      expect((mesh as unknown as { instanceMatrix?: unknown }).instanceMatrix)
        .toBeUndefined()
      expect(geo(mesh).isInstancedBufferGeometry).toBe(true)
      expect(geo(mesh).getAttribute(`instanceMatrix`)).toBeUndefined()
    }
    renderer.dispose()
  })

  test(`2×2×2 draws 8N instances from N-sized base attributes at divisor 8`, () => {
    const renderer = new AtomReplicaRenderer()
    renderer.update(make_packet([2, 2, 2]))

    expect(geo(renderer.mesh).instanceCount).toBe(3 * 8)
    for (const name of [`instancePosition`, `instanceRadius`, `instanceAtomColor`]) {
      const a = attr(renderer.mesh, name)
      // Uploaded buffers stay BASE-sized: one slot per base atom, not 8N.
      expect(a.count).toBe(3)
      expect(a.meshPerAttribute).toBe(8)
    }
    renderer.dispose()
  })

  test(`1×1×1 keeps a single copy`, () => {
    const renderer = new AtomReplicaRenderer()
    renderer.update(make_packet([1, 1, 1]))
    expect(geo(renderer.mesh).instanceCount).toBe(3)
    expect(attr(renderer.mesh, `instancePosition`).meshPerAttribute).toBe(1)
    renderer.dispose()
  })
})

describe(`AtomReplicaRenderer — replica factor changes`, () => {
  test(`factor change reuses typed arrays + geometry/material/mesh`, () => {
    const builder = create_render_packet_builder()
    const structure = make_structure(3)
    const renderer = new AtomReplicaRenderer()

    renderer.update(builder.build({ structure, dims: [2, 2, 2] }))
    const mesh = renderer.mesh
    const geometry = geo(mesh)
    const material = mesh.material
    const attributes = {
      pos: attr(mesh, `instancePosition`),
      rad: attr(mesh, `instanceRadius`),
      col: attr(mesh, `instanceAtomColor`),
    }
    const versions = {
      pos: attributes.pos.version,
      rad: attributes.rad.version,
      col: attributes.col.version,
    }

    renderer.update(builder.build({ structure, dims: [3, 3, 3] }))

    // Same mesh / geometry / material — no reconstruction on a factor change.
    expect(renderer.mesh).toBe(mesh)
    expect(geo(renderer.mesh)).toBe(geometry)
    expect(renderer.mesh.material).toBe(material)
    // Same attribute OBJECTS (and therefore same renderer-side WebGLBuffer
    // resources) — only counts / divisors / uniforms move. Attribute versions
    // must not bump: a factor-only change uploads no base data.
    expect(attr(mesh, `instancePosition`)).toBe(attributes.pos)
    expect(attr(mesh, `instanceRadius`)).toBe(attributes.rad)
    expect(attr(mesh, `instanceAtomColor`)).toBe(attributes.col)
    expect(attributes.pos.version).toBe(versions.pos)
    expect(attributes.rad.version).toBe(versions.rad)
    expect(attributes.col.version).toBe(versions.col)
    expect(attr(mesh, `instancePosition`).count).toBe(3)
    expect(attr(mesh, `instancePosition`).meshPerAttribute).toBe(27)
    expect(geometry.instanceCount).toBe(3 * 27)

    const uniforms = (material as THREE.ShaderMaterial).uniforms
    expect(uniforms.uCellCount.value).toBe(27)
    expect(Array.from(uniforms.uDims.value as ArrayLike<number>)).toEqual([3, 3, 3])
    renderer.dispose()
  })
})

describe(`AtomReplicaRenderer — frame updates (play / pause / scrub)`, () => {
  test(`frame advance reuses geometry+material and refreshes positions + lattice`, () => {
    const builder = create_render_packet_builder()
    const structure = make_structure(3)
    const renderer = new AtomReplicaRenderer()

    renderer.update(builder.build({
      structure,
      dims: [2, 2, 2],
      frame_positions: new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]),
      frame_idx: 0,
      positions_version: 1,
    }))
    const mesh = renderer.mesh
    const geometry = geo(mesh)
    const material = mesh.material
    const pos_attr = attr(mesh, `instancePosition`)

    // Variable-cell scrub: new positions AND a new current-frame lattice.
    renderer.update(builder.build({
      structure,
      dims: [2, 2, 2],
      frame_positions: new Float32Array([0, 5, 0, 1, 5, 0, 2, 5, 0]),
      frame_lattice: [[12, 0, 0], [0, 12, 0], [0, 0, 12]],
      frame_idx: 1,
      positions_version: 2,
    }))

    // Same impostor geometry and material — no mesh reconstruction, no
    // sphere/cylinder switching between play, pause, and scrub.
    expect(renderer.mesh).toBe(mesh)
    expect(geo(renderer.mesh)).toBe(geometry)
    expect(renderer.mesh.material).toBe(material)
    expect(attr(mesh, `instancePosition`)).toBe(pos_attr)
    // Base positions rewritten in place (still 3N floats).
    const pos = pos_attr.array as Float32Array
    expect(pos.length).toBe(9)
    expect(pos[1]).toBeCloseTo(5, 5)
    // Current frame lattice lands in the uniform, never in attributes:
    // Matrix3.fromArray copies the row-major 9 floats verbatim, so column 0
    // of the mat3 is lattice row a — uLattice · (ix,iy,iz) = ix·a+iy·b+iz·c.
    const lattice = (material as THREE.ShaderMaterial).uniforms.uLattice
      .value as THREE.Matrix3
    expect(lattice.elements[0]).toBeCloseTo(12, 5)
    expect(lattice.elements[4]).toBeCloseTo(12, 5)
    expect(lattice.elements[8]).toBeCloseTo(12, 5)
    renderer.dispose()
  })
})

describe(`AtomReplicaRenderer — shader contract`, () => {
  test(`GLSL3 shader decodes the cell from gl_InstanceID and adds the lattice`, () => {
    const renderer = new AtomReplicaRenderer()
    renderer.update(make_packet([2, 2, 2]))
    const material = renderer.mesh.material as THREE.ShaderMaterial
    expect(material.glslVersion).toBe(THREE.GLSL3)
    expect(material.vertexShader).toContain(`gl_InstanceID`)
    expect(material.vertexShader).toContain(`uCellCount`)
    expect(material.vertexShader).toContain(`uDims`)
    expect(material.vertexShader).toContain(`uLattice`)
    // Sphere impostor fragment: explicit GLSL3 output + analytic depth.
    expect(material.fragmentShader).toContain(`out vec4 fragColor`)
    expect(material.fragmentShader).toContain(`gl_FragDepth`)
    expect(material.fragmentShader).not.toContain(`gl_FragColor`)
    renderer.dispose()
  })

  test(`JS decode mirror matches the T1 oracle cell decode`, () => {
    const dims = [2, 3, 2] as const
    const base_count = 3
    const cell_count = cell_count_of(dims)
    expect(cell_count).toBe(12)
    const seen = new Set<string>()
    for (let inst = 0; inst < base_count * cell_count; inst++) {
      const decoded = decode_webgl2_instance(inst, dims)
      // WebGL2 order is base-outer / cell-inner (divisor semantics); the SAME
      // (atom, cell_index) pair in T1's atom-major order must decode to the
      // SAME replica cell tuple.
      expect(decoded.base_index).toBe(Math.floor(inst / cell_count))
      expect(decoded.cell_index).toBe(inst % cell_count)
      const oracle = decode_replica_instance(
        decoded.base_index + base_count * decoded.cell_index,
        base_count,
        dims,
      )
      expect(decoded.cell).toEqual(oracle.cell)
      seen.add(`${decoded.base_index}:${decoded.cell_index}`)
    }
    // Every (atom, cell) pair is covered exactly once.
    expect(seen.size).toBe(base_count * cell_count)
  })
})

describe(`AtomReplicaRenderer — sparse ghost second draw`, () => {
  test(`ghost-images policy draws exactly the T1 image-instance table`, () => {
    const packet = make_packet([2, 1, 1], `ghost-images`)
    const renderer = new AtomReplicaRenderer()
    renderer.update(packet)

    const table = build_image_instance_table(
      packet.topology.bond_graph!,
      packet.replicas.dims,
      `ghost-images`,
    )
    expect(table.count).toBeGreaterThan(0)
    expect(geo(renderer.ghost_mesh).instanceCount).toBe(table.count)
    expect(renderer.ghost_mesh.visible).toBe(true)

    const image = attr(renderer.ghost_mesh, `ghostImage`)
    const pos = attr(renderer.ghost_mesh, `ghostPosition`)
    expect(image.meshPerAttribute).toBe(1)
    expect(image.count).toBe(table.count)
    for (let idx = 0; idx < table.count; idx++) {
      // Static absolute image offset per ghost — translation happens in the
      // shader against the CURRENT lattice uniform.
      expect((image.array as Float32Array)[idx * 3]).toBe(table.jimages[idx * 3])
      expect((image.array as Float32Array)[idx * 3 + 1]).toBe(table.jimages[idx * 3 + 1])
      expect((image.array as Float32Array)[idx * 3 + 2]).toBe(table.jimages[idx * 3 + 2])
      // Per-frame base-position copy for the ghost's base site.
      const site = table.base_sites[idx]
      expect((pos.array as Float32Array)[idx * 3])
        .toBeCloseTo(packet.frame.positions[site * 3], 5)
    }
    renderer.dispose()
  })

  test(`stub / hide policies draw no ghosts`, () => {
    for (const policy of [`stub`, `hide`] as const) {
      const renderer = new AtomReplicaRenderer()
      renderer.update(make_packet([2, 1, 1], policy))
      expect(geo(renderer.ghost_mesh).instanceCount).toBe(0)
      expect(renderer.ghost_mesh.visible).toBe(false)
      renderer.dispose()
    }
  })
})

describe(`legacy AtomInstancedRenderer bypass wiring`, () => {
  test(`set_suspended gates sync work until the replica layer releases it`, () => {
    const mesh = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.MeshBasicMaterial(),
      16,
    )
    const manager = new AtomManager(16)
    const renderer = new AtomInstancedRenderer(mesh, manager)
    manager.add_atom(0, 1, 2, 3, 6, 0.8)

    renderer.set_suspended(true)
    renderer.sync()
    renderer.force_full_resync()
    // Suspended: nothing uploaded, dirty state preserved for the resume flush.
    const pos = (mesh.geometry.getAttribute(`instancePosition`)
      .array) as Float32Array
    expect(pos[0]).toBe(0)

    renderer.set_suspended(false)
    renderer.sync()
    expect(mesh.count).toBe(1)
    expect(pos[0]).toBeCloseTo(1, 5)
  })
})

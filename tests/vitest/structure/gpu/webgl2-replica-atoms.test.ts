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
import { describe, expect, test, vi } from 'vitest'
import * as THREE from 'three'
import {
  AtomReplicaRenderer,
  cell_count_of,
  decode_webgl2_instance,
} from '$lib/structure/gpu/webgl2/atom-replica-renderer'
import { SharedPositionTexture } from '$lib/structure/gpu/webgl2/shared-position-texture'
import {
  build_image_instance_table,
  decode_replica_instance,
} from '$lib/structure/scene/replica-layout'
import type {
  ImageInstanceTable,
  RenderPacket,
} from '$lib/structure/scene/render-packet'
import {
  create_render_packet_builder,
  type PacketBondConnectivity,
} from '$lib/structure/scene/render-packet-builder'
import { AtomManager } from '$lib/structure/atoms/atom-manager.svelte'
import { AtomInstancedRenderer } from '$lib/structure/atoms/atom-instanced-renderer'
import {
  build_display_radii,
  build_logical_radii,
} from '$lib/structure/gpu/radius-lut'
import { VISUAL_RADIUS_SCALE } from '$lib/structure/rendering/visual-state'
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

function ghost_pages(root: THREE.Mesh): THREE.Mesh[] {
  return [
    root,
    ...root.children.filter((child): child is THREE.Mesh =>
      (child as THREE.Mesh).isMesh === true
    ),
  ]
}

describe(`AtomReplicaRenderer — mesh shape`, () => {
  test(`converts logical packet radii to the shared final display radii once`, () => {
    const structure = make_structure(3)
    const logical = build_logical_radii(structure.sites, { atom_radius: 1.5 })
    const expected = build_display_radii(structure.sites, { atom_radius: 1.5 })
    const packet = create_render_packet_builder().build({
      structure,
      radii: logical,
      dims: [1, 1, 1],
    })
    const renderer = new AtomReplicaRenderer()
    renderer.update(packet)
    expect(packet.topology.radii).toBe(logical)
    for (let idx = 0; idx < logical.length; idx++) {
      expect(expected[idx]).toBeCloseTo(logical[idx] * VISUAL_RADIUS_SCALE)
    }
    expect(
      Array.from(attr(renderer.mesh, `instanceRadius`).array as Float32Array),
    ).toEqual(Array.from(expected))
    renderer.dispose()
  })

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
    for (const name of [`instanceSite`, `instanceRadius`, `instanceAtomColor`]) {
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
    expect(attr(renderer.mesh, `instanceSite`).meshPerAttribute).toBe(1)
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
      site: attr(mesh, `instanceSite`),
      rad: attr(mesh, `instanceRadius`),
      col: attr(mesh, `instanceAtomColor`),
    }

    renderer.update(builder.build({ structure, dims: [3, 3, 3] }))

    // Same mesh / geometry / material — no reconstruction on a factor change.
    expect(renderer.mesh).toBe(mesh)
    expect(geo(renderer.mesh)).toBe(geometry)
    expect(renderer.mesh.material).toBe(material)
    // FRESH attribute objects over the SAME base-sized typed arrays. Replacing
    // the attribute is the only divisor change Three's binding-state cache
    // detects (`needsUpdate()` ignores meshPerAttribute); in-place mutation
    // required the mid-frame resetState() hack that vanished atoms on
    // non-ANGLE GL stacks (see webgl2-replica-atom-resize.test.ts).
    expect(attr(mesh, `instanceSite`)).not.toBe(attributes.site)
    expect(attr(mesh, `instanceRadius`)).not.toBe(attributes.rad)
    expect(attr(mesh, `instanceAtomColor`)).not.toBe(attributes.col)
    expect(attr(mesh, `instanceSite`).array).toBe(attributes.site.array)
    expect(attr(mesh, `instanceRadius`).array).toBe(attributes.rad.array)
    expect(attr(mesh, `instanceAtomColor`).array).toBe(attributes.col.array)
    expect(attr(mesh, `instanceSite`).count).toBe(3)
    expect(attr(mesh, `instanceSite`).meshPerAttribute).toBe(27)
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
    const positions = new SharedPositionTexture()
    const renderer = new AtomReplicaRenderer({ positions })

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
    const site_attr = attr(mesh, `instanceSite`)

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
    expect(attr(mesh, `instanceSite`)).toBe(site_attr)
    expect(Array.from(site_attr.array as Float32Array)).toEqual([0, 1, 2])
    const pos = positions.texture.image.data as Float32Array
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

  test(`same-frame lattice-only packet refreshes uLattice without uploading positions`, () => {
    const builder = create_render_packet_builder()
    const structure = make_structure(3)
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0])
    const position_resource = new SharedPositionTexture()
    const renderer = new AtomReplicaRenderer({ positions: position_resource })
    const first = builder.build({
      structure,
      dims: [2, 2, 2],
      frame_positions: positions,
      frame_lattice: [[10, 0, 0], [0, 10, 0], [0, 0, 10]],
      frame_idx: 7,
      positions_version: 11,
    })
    const second = builder.build({
      structure,
      dims: [2, 2, 2],
      frame_positions: positions,
      frame_lattice: [[14, 0, 0], [0, 12, 0], [0, 0, 9]],
      frame_idx: 7,
      positions_version: 11,
    })
    expect(second.frame).not.toBe(first.frame)
    expect(second.frame.positions).toBe(first.frame.positions)
    expect(second.frame.frame_idx).toBe(first.frame.frame_idx)
    expect(second.frame.positions_version).toBe(first.frame.positions_version)

    renderer.update(first)
    const texture_version = position_resource.texture.version
    renderer.update(second)

    expect(position_resource.texture.version).toBe(texture_version)
    const lattice = renderer.material.uniforms.uLattice.value as THREE.Matrix3
    expect([lattice.elements[0], lattice.elements[4], lattice.elements[8]])
      .toEqual([14, 12, 9])
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
  test(`authoritative boundary table replaces graph ghosts and updates without a packet change`, () => {
    const packet = make_packet([3, 3, 3], `ghost-images`)
    const first: ImageInstanceTable = {
      count: 2,
      base_sites: Uint32Array.from([2, 1]),
      jimages: Int8Array.from([3, 0, 0, -1, 2, 0]),
    }
    const second: ImageInstanceTable = {
      count: 1,
      base_sites: Uint32Array.from([0]),
      jimages: Int8Array.from([0, 0, -1]),
    }
    const renderer = new AtomReplicaRenderer()
    renderer.update(packet, first)
    expect(geo(renderer.ghost_mesh).instanceCount).toBe(2)
    expect(Array.from(
      (attr(renderer.ghost_mesh, `ghostBaseSite`).array as Float32Array)
        .subarray(0, 2),
    )).toEqual([2, 1])

    // The async ordinary 19/19 cache can arrive while the RenderPacket
    // identity stays fixed. Table identity alone must rebuild the sparse draw.
    renderer.update(packet, second)
    expect(geo(renderer.ghost_mesh).instanceCount).toBe(1)
    expect((attr(renderer.ghost_mesh, `ghostBaseSite`).array as Float32Array)[0])
      .toBe(0)
    expect(Array.from(
      (attr(renderer.ghost_mesh, `ghostImage`).array as Float32Array)
        .subarray(0, 3),
    )).toEqual([0, 0, -1])
    renderer.dispose()
  })

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
    const base_site = attr(renderer.ghost_mesh, `ghostBaseSite`)
    const ghost_radius = attr(renderer.ghost_mesh, `ghostRadius`)
    expect(image.meshPerAttribute).toBe(1)
    expect(image.count).toBe(table.count)
    for (let idx = 0; idx < table.count; idx++) {
      // Static absolute image offset per ghost — translation happens in the
      // shader against the CURRENT lattice uniform.
      expect((image.array as Float32Array)[idx * 3]).toBe(table.jimages[idx * 3])
      expect((image.array as Float32Array)[idx * 3 + 1]).toBe(table.jimages[idx * 3 + 1])
      expect((image.array as Float32Array)[idx * 3 + 2]).toBe(table.jimages[idx * 3 + 2])
      expect((base_site.array as Float32Array)[idx])
        .toBe(table.base_sites[idx])
      const site = table.base_sites[idx]
      expect((ghost_radius.array as Float32Array)[idx]).toBeCloseTo(
        packet.topology.radii[site] * VISUAL_RADIUS_SCALE,
      )
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

  test(`ghost-images 1×↔2×↔8× keeps main and sparse attribute buffers`, () => {
    const builder = create_render_packet_builder()
    const structure = make_structure(3)
    const renderer = new AtomReplicaRenderer()
    const packet = (dims: readonly [number, number, number]) => builder.build({
      structure,
      bond_connectivity: BONDS,
      dims,
      boundary_policy: `ghost-images`,
    })

    const first = packet([1, 1, 1])
    renderer.update(first)
    const main_geometry = geo(renderer.mesh)
    const ghost_geometry = geo(renderer.ghost_mesh)
    const main_names = [
      `instanceSite`,
      `instanceRadius`,
      `instanceAtomColor`,
    ] as const
    const ghost_names = [
      `ghostBaseSite`,
      `ghostImage`,
      `ghostRadius`,
      `ghostColor`,
    ] as const
    const main_attrs = main_names.map((name) => attr(renderer.mesh, name))
    const ghost_attrs = ghost_names.map((name) => attr(renderer.ghost_mesh, name))
    const main_arrays = main_attrs.map((attribute) => attribute.array)
    const ghost_arrays = ghost_attrs.map((attribute) => attribute.array)

    for (const dims of [
      [2, 1, 1],
      [2, 2, 2],
      [1, 1, 1],
    ] as const) {
      const next = packet(dims)
      renderer.update(next)
      const table = build_image_instance_table(
        next.topology.bond_graph!,
        next.replicas.dims,
        `ghost-images`,
      )
      expect(geo(renderer.mesh)).toBe(main_geometry)
      expect(geo(renderer.ghost_mesh)).toBe(ghost_geometry)
      for (let idx = 0; idx < main_names.length; idx++) {
        // Divisor changes replace the attribute OBJECT (identity-based VAO
        // rebind) but always reuse the base-sized typed array.
        expect(attr(renderer.mesh, main_names[idx]).array).toBe(main_arrays[idx])
      }
      for (let idx = 0; idx < ghost_names.length; idx++) {
        expect(attr(renderer.ghost_mesh, ghost_names[idx])).toBe(ghost_attrs[idx])
        expect(ghost_attrs[idx].array).toBe(ghost_arrays[idx])
        expect(ghost_attrs[idx].count).toBe(table.count)
      }
      expect(main_geometry.instanceCount).toBe(3 * cell_count_of(dims))
      expect(ghost_geometry.instanceCount).toBe(table.count)
    }
    renderer.dispose()
  })

  test(`ghost pages append, shrink, regrow, and dispose without replacing buffers`, () => {
    const site_count = 129
    const structure = make_structure(site_count)
    const bonds: PacketBondConnectivity[] = Array.from(
      { length: site_count },
      (_, site_idx) => ({
        site_idx_1: site_idx,
        site_idx_2: site_idx,
        jimage: [1, 0, 0] as [number, number, number],
      }),
    )
    const builder = create_render_packet_builder()
    const renderer = new AtomReplicaRenderer()
    const packet = (
      dims: readonly [number, number, number],
      boundary_policy: `stub` | `ghost-images` = `ghost-images`,
    ) => builder.build({ structure, bond_connectivity: bonds, dims, boundary_policy })

    renderer.update(packet([1, 1, 1]))
    expect(ghost_pages(renderer.ghost_mesh)).toHaveLength(1)
    renderer.update(packet([2, 2, 2]))
    const pages = ghost_pages(renderer.ghost_mesh)
    expect(pages).toHaveLength(3)
    expect(pages.map((page) => geo(page).instanceCount)).toEqual([256, 256, 4])
    const attrs = pages.map((page) => attr(page, `ghostBaseSite`))
    const arrays = attrs.map((attribute) => attribute.array)

    renderer.update(packet([1, 1, 1]))
    expect(ghost_pages(renderer.ghost_mesh)).toEqual(pages)
    expect(pages.map((page) => geo(page).instanceCount)).toEqual([129, 0, 0])
    expect(pages.map((page) => page.visible)).toEqual([true, false, false])
    renderer.update(packet([1, 1, 1], `stub`))
    expect(pages.map((page) => geo(page).instanceCount)).toEqual([0, 0, 0])
    expect(pages.map((page) => page.visible)).toEqual([false, false, false])
    renderer.update(packet([2, 2, 2]))
    expect(ghost_pages(renderer.ghost_mesh)).toEqual(pages)
    expect(pages.map((page) => geo(page).instanceCount)).toEqual([256, 256, 4])
    for (let idx = 0; idx < pages.length; idx++) {
      expect(attr(pages[idx], `ghostBaseSite`)).toBe(attrs[idx])
      expect(attrs[idx].array).toBe(arrays[idx])
    }

    const disposed = pages.map(() => vi.fn())
    for (let idx = 0; idx < pages.length; idx++) {
      pages[idx].geometry.addEventListener(`dispose`, disposed[idx])
    }
    const material_disposed = vi.fn()
    renderer.ghost_material.addEventListener(`dispose`, material_disposed)
    renderer.dispose()
    for (const spy of disposed) expect(spy).toHaveBeenCalledOnce()
    expect(material_disposed).toHaveBeenCalledOnce()
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

describe(`Appearance → Material on the packet path (#533)`, () => {
  test(`fragment shader carries the legacy style branches`, () => {
    const renderer = new AtomReplicaRenderer()
    const fragment = renderer.material.fragmentShader
    // 0 glossy/GGX, 1 matte, 2 toon, 3 matcap — legacy AtomManagerInstances
    // branch order; the packet path must not silently render one fixed look.
    expect(fragment).toContain(`uRenderStyle`)
    expect(fragment).toContain(`uRoughness`)
    expect(fragment).toContain(`uMetalness`)
    expect(fragment).toContain(`uSpecStrength`)
    expect(fragment).toContain(`uMatcap`)
    expect(fragment).toContain(`uShadowThreshold`)
    renderer.dispose()
  })

  test(`set_render_style routes uniforms to BOTH main and ghost draws`, () => {
    const renderer = new AtomReplicaRenderer()
    // Shared uniform objects: one write must update the ghost material too.
    expect(renderer.ghost_material.uniforms.uRenderStyle)
      .toBe(renderer.material.uniforms.uRenderStyle)

    renderer.set_render_style(2, { roughness: 0.4, metalness: 0.4 })
    expect(renderer.material.uniforms.uRenderStyle.value).toBe(2)
    expect(renderer.material.uniforms.uRoughness.value).toBeCloseTo(0.4)
    expect(renderer.material.uniforms.uMetalness.value).toBeCloseTo(0.4)
    expect(renderer.ghost_material.uniforms.uRenderStyle.value).toBe(2)

    const matcap = new THREE.Texture()
    renderer.set_render_style(3, { roughness: 0.2, metalness: 0 }, matcap)
    expect(renderer.material.uniforms.uMatcap.value).toBe(matcap)
    expect(renderer.ghost_material.uniforms.uMatcap.value).toBe(matcap)

    renderer.set_highlight_strength(1.7)
    expect(renderer.material.uniforms.uSpecStrength.value).toBeCloseTo(1.7)
    renderer.dispose()
    matcap.dispose()
  })

  test(`style changes touch uniforms only — no material or geometry swap`, () => {
    const renderer = new AtomReplicaRenderer()
    const material = renderer.material
    const geometry = renderer.mesh.geometry
    renderer.set_render_style(1, { roughness: 0.2, metalness: 0 })
    renderer.set_render_style(0, { roughness: 0.2, metalness: 0 })
    expect(renderer.material).toBe(material)
    expect(renderer.mesh.geometry).toBe(geometry)
    renderer.dispose()
  })
})

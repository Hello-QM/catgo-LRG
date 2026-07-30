// gpu-visual-supercell Task 4 — WebGL2 bond replica impostors (design §7.2).
//
// One base `BaseBondGraph` drives all replica cells: per-bond attributes stay
// B-sized (divisor = 2 × cell count), `instanceCount = 2B × nx·ny·nz`, and the
// flat ray-cylinder impostor shader evaluates `cell + jimage` per replica —
// complete / stub / hide / ghost — against the CURRENT frame lattice uniform.
// Periodic self-image edges (a === b, jimage ≠ 0) are valid and never
// filtered. Ghost-side halves render through a sparse second draw. The legacy
// `InstancedMesh` path (one CPU mat4 per drawn instance) fails all of this.
import { describe, expect, test, vi } from 'vitest'
import * as THREE from 'three'
import {
  BondReplicaRenderer,
  build_authoritative_boundary_half_table,
  build_ghost_half_table,
  classify_half_draw,
} from '$lib/structure/gpu/webgl2/bond-replica-renderer'
import {
  AtomReplicaRenderer,
  cell_count_of,
} from '$lib/structure/gpu/webgl2/atom-replica-renderer'
import {
  decode_compact_bond_instance,
} from '$lib/structure/gpu/webgl2/compact-bond-instance-layout'
import { SharedPositionTexture } from '$lib/structure/gpu/webgl2/shared-position-texture'
import { SharedAtomColorTexture } from '$lib/structure/gpu/webgl2/shared-atom-color-texture'
import {
  type PeriodicBond,
  resolve_periodic_edge,
} from '$lib/structure/scene/replica-layout'
import type {
  BoundaryPolicy,
  ImageInstanceTable,
  RenderPacket,
} from '$lib/structure/scene/render-packet'
import {
  create_render_packet_builder,
  type PacketBondConnectivity,
} from '$lib/structure/scene/render-packet-builder'
import { BOND_KIND, BondManager } from '$lib/structure/bonding/bond-manager.svelte'
import { BondInstancedRenderer } from '$lib/structure/bonding/bond-instanced-renderer'
import { trajectory_render_diagnostics } from '$lib/structure/trajectory-render-diagnostics'
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

// Intra-cell, cross-cell, and a periodic SELF-image bond (single-atom
// primitive cells only have such bonds — they must never be filtered).
const BONDS: PacketBondConnectivity[] = [
  { site_idx_1: 0, site_idx_2: 1 },
  { site_idx_1: 1, site_idx_2: 2, jimage: [1, 0, 0] },
  { site_idx_1: 0, site_idx_2: 0, jimage: [0, 0, 1] },
]
const BOND_COUNT = BONDS.length

function make_packet(
  dims: readonly [number, number, number],
  boundary_policy: BoundaryPolicy = `stub`,
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

function sweep_cells(
  dims: readonly [number, number, number],
): [number, number, number][] {
  const cells: [number, number, number][] = []
  for (let iz = 0; iz < dims[2]; iz++) {
    for (let iy = 0; iy < dims[1]; iy++) {
      for (let ix = 0; ix < dims[0]; ix++) cells.push([ix, iy, iz])
    }
  }
  return cells
}

describe(`compact bond instance layout`, () => {
  test.each([
    [1, 1, 1],
    [2, 1, 1],
    [2, 2, 2],
    [3, 2, 4],
  ] as const)(`decodes bond, half, and x-fastest cell for dims %j`, (...dims) => {
    const cell_count = cell_count_of(dims)
    const group_size = 2 * cell_count
    const instance_count = BOND_COUNT * group_size

    for (let instance_index = 0; instance_index < instance_count; instance_index++) {
      const decoded = decode_compact_bond_instance(instance_index, dims)
      const bond_index = Math.floor(instance_index / group_size)
      const within_bond = instance_index % group_size
      const half = Math.floor(within_bond / cell_count) as 0 | 1
      const cell_index = within_bond % cell_count
      expect(decoded).toEqual({
        bond_index,
        half,
        cell_index,
        cell: [
          cell_index % dims[0],
          Math.floor(cell_index / dims[0]) % dims[1],
          Math.floor(cell_index / (dims[0] * dims[1])),
        ],
      })
    }
  })

  test.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    `rejects invalid instance index %s`,
    (instance_index) => {
      expect(() => decode_compact_bond_instance(instance_index, [1, 1, 1]))
        .toThrow(RangeError)
    },
  )
})

describe(`BondReplicaRenderer — mesh shape`, () => {
  test(`records topology bytes only when the renderer schedules GPU attribute uploads`, () => {
    trajectory_render_diagnostics.reset()
    const renderer = new BondReplicaRenderer()
    const packet = make_packet([2, 2, 2])

    renderer.update(packet)
    expect(trajectory_render_diagnostics.snapshot()).toMatchObject({
      topology_uploads: 1,
      topology_upload_bytes: BOND_COUNT * 11,
      bond_main_topology_uploads: 1,
      bond_main_topology_upload_bytes: BOND_COUNT * 11,
      bond_main_topology_uploaded_bonds: BOND_COUNT,
    })

    renderer.update(packet)
    expect(trajectory_render_diagnostics.snapshot()).toMatchObject({
      topology_uploads: 1,
      topology_upload_bytes: BOND_COUNT * 11,
      bond_main_topology_uploads: 1,
      bond_main_topology_upload_bytes: BOND_COUNT * 11,
      bond_main_topology_uploaded_bonds: BOND_COUNT,
    })
    renderer.dispose()
  })

  test(`plain Mesh over InstancedBufferGeometry — no instanceMatrix anywhere`, () => {
    const renderer = new BondReplicaRenderer()
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

  test(`2×2×2 draws 16B instances from B-sized bond attributes at divisor 16`, () => {
    const renderer = new BondReplicaRenderer()
    renderer.update(make_packet([2, 2, 2]))

    // 2 halves per base bond × 8 replica cells = 16B.
    expect(geo(renderer.mesh).instanceCount).toBe(2 * BOND_COUNT * 8)
    for (const name of [`a_site`, `a_jimage`]) {
      const bond_attr = attr(renderer.mesh, name)
      expect(bond_attr.count).toBe(BOND_COUNT)
      expect(bond_attr.meshPerAttribute).toBe(16)
    }
    expect(geo(renderer.mesh).getAttribute(`a_half`)).toBeUndefined()
    expect(geo(renderer.mesh).getAttribute(`a_color`)).toBeUndefined()
    renderer.dispose()
  })

  test(`self-image edges land in the compact bond attributes unfiltered`, () => {
    const renderer = new BondReplicaRenderer()
    renderer.update(make_packet([2, 2, 2]))
    const site = attr(renderer.mesh, `a_site`).array as Float32Array
    const jimage = attr(renderer.mesh, `a_jimage`).array as Int8Array
    // Bond 2 is the (0, 0, [0,0,1]) self-edge: one logical record serves
    // both halves and every replica cell.
    expect([site[4], site[5]]).toEqual([0, 0])
    expect(Array.from(jimage.slice(6, 9))).toEqual([0, 0, 1])
    renderer.dispose()
  })
})

describe(`BondReplicaRenderer — replica factor changes`, () => {
  test(`factor change reuses typed arrays + geometry/material/mesh`, () => {
    const builder = create_render_packet_builder()
    const structure = make_structure(3)
    const renderer = new BondReplicaRenderer()

    renderer.update(builder.build({
      structure,
      bond_connectivity: BONDS,
      dims: [2, 2, 2],
    }))
    const mesh = renderer.mesh
    const geometry = geo(mesh)
    const material = mesh.material
    const attributes = {
      site: attr(mesh, `a_site`),
      jimage: attr(mesh, `a_jimage`),
    }

    renderer.update(builder.build({
      structure,
      bond_connectivity: BONDS,
      dims: [3, 3, 3],
    }))

    expect(renderer.mesh).toBe(mesh)
    expect(geo(renderer.mesh)).toBe(geometry)
    expect(renderer.mesh.material).toBe(material)
    // FRESH attribute objects over the SAME graph-sized typed arrays — the
    // identity change is what Three's binding-state cache detects for the
    // divisor rebind (`needsUpdate()` ignores meshPerAttribute; the in-place
    // mutation needed the mid-frame resetState() hack that vanished draws on
    // non-ANGLE GL stacks — see webgl2-replica-atom-resize.test.ts).
    expect(attr(mesh, `a_site`)).not.toBe(attributes.site)
    expect(attr(mesh, `a_jimage`)).not.toBe(attributes.jimage)
    expect(attr(mesh, `a_site`).array).toBe(attributes.site.array)
    expect(attr(mesh, `a_jimage`).array).toBe(attributes.jimage.array)
    expect(attr(mesh, `a_site`).meshPerAttribute).toBe(54)
    expect(geometry.instanceCount).toBe(2 * BOND_COUNT * 27)

    const uniforms = (material as THREE.ShaderMaterial).uniforms
    expect(uniforms.uCellCount.value).toBe(27)
    expect(Array.from(uniforms.uDims.value as ArrayLike<number>)).toEqual([3, 3, 3])
    renderer.dispose()
  })
})

describe(`classify_half_draw — matches the T1 oracle`, () => {
  const dims = [2, 2, 1] as const
  const bonds: PeriodicBond[] = [
    { a: 0, b: 1, jimage: [0, 0, 0] },
    { a: 1, b: 2, jimage: [1, 0, 0] },
    { a: 2, b: 0, jimage: [-1, 1, 0] },
    { a: 0, b: 0, jimage: [0, 0, 1] }, // periodic self-image edge
  ]
  const policies: BoundaryPolicy[] = [`stub`, `hide`, `ghost-images`]

  test(`anchor half (half A) classification IS resolve_periodic_edge`, () => {
    for (const policy of policies) {
      for (const bond of bonds) {
        for (const cell of sweep_cells(dims)) {
          const oracle = resolve_periodic_edge(bond, cell, dims, policy)
          expect(
            classify_half_draw(bond, cell, dims, policy, 0),
            `bond ${bond.a}-${bond.b} j=${bond.jimage} cell=${cell} ${policy}`,
          ).toBe(oracle.kind)
        }
      }
    }
  })

  test(`partner half (half B) probes cell - jimage; ghosts stay B-side only`, () => {
    for (const policy of policies) {
      for (const bond of bonds) {
        for (const cell of sweep_cells(dims)) {
          // The reverse probe is the oracle applied to the flipped bond: the
          // half anchored at B sees its partner A at cell − jimage. Under
          // ghost-images an OUTSIDE reverse partner draws nothing (the T1
          // image table only ghosts endpoint B images — see
          // build_image_instance_table), so oracle 'ghost' maps to 'omit'.
          const flipped: PeriodicBond = {
            a: bond.b,
            b: bond.a,
            jimage: [-bond.jimage[0], -bond.jimage[1], -bond.jimage[2]],
          }
          const oracle = resolve_periodic_edge(flipped, cell, dims, policy)
          const expected = oracle.kind === `ghost` ? `omit` : oracle.kind
          expect(
            classify_half_draw(bond, cell, dims, policy, 1),
            `bond ${bond.a}-${bond.b} j=${bond.jimage} cell=${cell} ${policy}`,
          ).toBe(expected)
        }
      }
    }
  })

  test(`self-image edges are complete inside — never filtered`, () => {
    const self_edge: PeriodicBond = { a: 0, b: 0, jimage: [1, 0, 0] }
    expect(classify_half_draw(self_edge, [0, 0, 0], [2, 1, 1], `hide`, 0))
      .toBe(`complete`)
    expect(classify_half_draw(self_edge, [1, 0, 0], [2, 1, 1], `hide`, 0))
      .toBe(`omit`)
  })
})

describe(`BondReplicaRenderer — flat ray-cylinder impostor shader`, () => {
  test(`atom and bond draws share one position texture upload`, () => {
    const positions = new SharedPositionTexture()
    const atom_renderer = new AtomReplicaRenderer({ positions })
    const bond_renderer = new BondReplicaRenderer({ positions })
    const packet = make_packet([2, 2, 2])

    atom_renderer.update(packet)
    bond_renderer.update(packet)

    expect(atom_renderer.material.uniforms.uPosTex.value).toBe(positions.texture)
    expect(bond_renderer.material.uniforms.uPosTex.value).toBe(positions.texture)
    expect(bond_renderer.ghost_material.uniforms.uPosTex.value)
      .toBe(positions.texture)
    expect(positions.stats()).toMatchObject({
      uploads: 1,
      atom_consumers: 1,
      bond_consumers: 1,
    })

    atom_renderer.dispose()
    bond_renderer.dispose()
    expect(positions.stats()).toMatchObject({
      atom_consumers: 0,
      bond_consumers: 0,
    })
    positions.dispose()
  })

  test(`color-only topology updates the shared texture without replacing graph attributes`, () => {
    const colors = new SharedAtomColorTexture()
    const renderer = new BondReplicaRenderer({ colors })
    const builder = create_render_packet_builder()
    const structure = make_structure(3)
    const packet = (rgb: Float32Array) => builder.build({
      structure,
      bond_connectivity: BONDS,
      dims: [2, 1, 1],
      colors: rgb,
    })

    renderer.update(packet(Float32Array.from([
      1, 0, 0,
      0, 1, 0,
      0, 0, 1,
    ])))
    const site = attr(renderer.mesh, `a_site`)
    const jimage = attr(renderer.mesh, `a_jimage`)
    const color_texture = renderer.material.uniforms.uColorTex.value
    expect(color_texture).toBe(colors.texture)
    expect(renderer.ghost_material.uniforms.uColorTex.value).toBe(colors.texture)
    expect(colors.stats().uploads).toBe(1)

    renderer.update(packet(Float32Array.from([
      0.2, 0.3, 0.4,
      0.5, 0.6, 0.7,
      0.8, 0.9, 1,
    ])))

    expect(attr(renderer.mesh, `a_site`)).toBe(site)
    expect(attr(renderer.mesh, `a_jimage`)).toBe(jimage)
    expect(renderer.material.uniforms.uColorTex.value).toBe(color_texture)
    expect(colors.stats().uploads).toBe(2)
    renderer.dispose()
    colors.dispose()
  })

  test(`dispose releases an internally owned atom color texture`, () => {
    const renderer = new BondReplicaRenderer()
    const color_texture = renderer.material.uniforms.uColorTex
      .value as THREE.DataTexture
    const dispose = vi.spyOn(color_texture, `dispose`)

    renderer.dispose()

    expect(dispose).toHaveBeenCalledOnce()
  })

  test(`dispose preserves an externally supplied atom color texture`, () => {
    const colors = new SharedAtomColorTexture()
    const dispose = vi.spyOn(colors.texture, `dispose`)
    const renderer = new BondReplicaRenderer({ colors })

    renderer.dispose()

    expect(dispose).not.toHaveBeenCalled()
    colors.dispose()
    expect(dispose).toHaveBeenCalledOnce()
  })

  test(`GLSL3, gl_InstanceID decode, per-replica jimage policy, ray-cast depth`, () => {
    const renderer = new BondReplicaRenderer()
    renderer.update(make_packet([2, 2, 2]))
    const material = renderer.mesh.material as THREE.ShaderMaterial
    expect(material.glslVersion).toBe(THREE.GLSL3)
    // Replica decode + current-lattice translation + boundary policy all
    // evaluated in the vertex stage, per instance.
    for (const token of [
      `gl_InstanceID`,
      `uCellCount`,
      `uDims`,
      `uLattice`,
      `a_jimage`,
      `uPolicy`,
      `uStubScale`,
      `texelFetch`,
      `uColorTex`,
      `uColorTexWidth`,
      `int group_size = 2 * uCellCount`,
      `int half_index = within_bond / uCellCount`,
      `half_index == 1`,
    ]) expect(material.vertexShader).toContain(token)
    expect(material.vertexShader).not.toMatch(/\bint\s+half\b/)
    expect(material.vertexShader).not.toMatch(/\bhalf\s*==/)
    expect(material.vertexShader).not.toContain(`a_half`)
    expect(material.vertexShader).not.toContain(`a_color`)
    // Flat (non-interpolated) per-instance cylinder frame + analytic ray-cast.
    expect(material.vertexShader).toContain(`flat varying`)
    expect(material.fragmentShader).toContain(`flat varying`)
    expect(material.fragmentShader).toContain(`gl_FragDepth`)
    expect(material.fragmentShader).toContain(`out vec4 fragColor`)
    expect(material.fragmentShader).not.toContain(`gl_FragColor`)
    expect(material.fragmentShader).toContain(`discard`)
    // The base geometry is the unit OBB the impostor maps per half-bond.
    expect(geo(renderer.mesh).getAttribute(`position`).count).toBe(24)
    renderer.dispose()
  })

  test(`render-time camera hook refreshes inverse projection + viewport`, () => {
    const renderer = new BondReplicaRenderer()
    const camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 100)
    camera.updateProjectionMatrix()
    const fake_webgl_renderer = {
      getCurrentViewport(target: THREE.Vector4) {
        return target.set(23, 29, 1600, 900)
      },
      getDrawingBufferSize(target: THREE.Vector2) {
        return target.set(1920, 1080)
      },
    } as unknown as THREE.WebGLRenderer

    renderer.mesh.onBeforeRender(
      fake_webgl_renderer,
      new THREE.Scene(),
      camera,
      geo(renderer.mesh),
      renderer.material,
      null,
    )

    const inv = renderer.material.uniforms.uInvProjection.value as THREE.Matrix4
    const viewport = renderer.material.uniforms.uViewport.value as THREE.Vector4
    expect(inv.elements).toEqual(camera.projectionMatrixInverse.elements)
    expect(viewport.toArray()).toEqual([23, 29, 1600, 900])
    expect(renderer.material.fragmentShader).toContain(
      `(gl_FragCoord.xy - uViewport.xy) / uViewport.zw`,
    )
    renderer.dispose()
  })

  test(`positions travel as a base-sized texture, refreshed per frame`, () => {
    const builder = create_render_packet_builder()
    const structure = make_structure(3)
    const renderer = new BondReplicaRenderer()
    renderer.update(builder.build({
      structure,
      bond_connectivity: BONDS,
      dims: [2, 2, 2],
      frame_positions: new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]),
      positions_version: 1,
    }))
    const mesh = renderer.mesh
    const material = mesh.material as THREE.ShaderMaterial
    const tex = material.uniforms.uPosTex.value as THREE.DataTexture
    expect(tex).toBeInstanceOf(THREE.DataTexture)

    renderer.update(builder.build({
      structure,
      bond_connectivity: BONDS,
      dims: [2, 2, 2],
      frame_positions: new Float32Array([0, 7, 0, 1, 7, 0, 2, 7, 0]),
      frame_lattice: [[11, 0, 0], [0, 11, 0], [0, 0, 11]],
      frame_idx: 1,
      positions_version: 2,
    }))
    // Same mesh/geometry/material across the frame advance.
    expect(renderer.mesh).toBe(mesh)
    expect(renderer.mesh.material).toBe(material)
    const data = (material.uniforms.uPosTex.value as THREE.DataTexture).image
      .data as unknown as Float32Array
    expect(data[1]).toBeCloseTo(7, 5)
    const lattice = material.uniforms.uLattice.value as THREE.Matrix3
    expect(lattice.elements[0]).toBeCloseTo(11, 5)
    renderer.dispose()
  })

  test(`same-frame lattice-only packet refreshes uLattice without uploading positions`, () => {
    const builder = create_render_packet_builder()
    const structure = make_structure(3)
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0])
    const renderer = new BondReplicaRenderer()
    const first = builder.build({
      structure,
      bond_connectivity: BONDS,
      dims: [2, 2, 2],
      frame_positions: positions,
      frame_lattice: [[10, 0, 0], [0, 10, 0], [0, 0, 10]],
      frame_idx: 7,
      positions_version: 11,
    })
    const second = builder.build({
      structure,
      bond_connectivity: BONDS,
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
    const texture = renderer.material.uniforms.uPosTex.value as THREE.DataTexture
    const texture_version = texture.version
    renderer.update(second)

    expect(renderer.material.uniforms.uPosTex.value).toBe(texture)
    expect(texture.version).toBe(texture_version)
    const lattice = renderer.material.uniforms.uLattice.value as THREE.Matrix3
    expect([lattice.elements[0], lattice.elements[4], lattice.elements[8]])
      .toEqual([14, 12, 9])
    renderer.dispose()
  })
})

describe(`BondReplicaRenderer — sparse ghost second draw`, () => {
  test(`authoritative image ownership replaces endpoint-B graph ghosts`, () => {
    const packet = make_packet([3, 3, 3], `ghost-images`)
    const images: ImageInstanceTable = {
      count: 3,
      base_sites: Uint32Array.from([2, 1, 0]),
      jimages: Int8Array.from([
        3, 0, 0,
        -1, 0, 0,
        0, 0, 3,
      ]),
    }
    const graph = packet.topology.bond_graph!
    const expected = build_authoritative_boundary_half_table(
      graph,
      images,
      packet.frame.positions,
      packet.frame.lattice,
      packet.replicas.dims,
      packet.replicas.boundary_policy,
    )
    const renderer = new BondReplicaRenderer()
    renderer.update(packet, images)

    expect(expected.count).toBeGreaterThan(images.count)
    expect(geo(renderer.ghost_mesh).instanceCount).toBe(expected.count)
    // The base draw must fall back to ordinary paired stubs; the sparse
    // decorator table, not graph-derived ghost completion, owns the boundary.
    expect(renderer.material.uniforms.uPolicy.value).toBe(0)
    expect(attr(renderer.ghost_mesh, `g_stub`).count).toBe(expected.count)
    renderer.dispose()
  })

  test(`ghost-images renders one ghost-side half per oracle 'ghost' probe`, () => {
    const dims = [2, 1, 1] as const
    const packet = make_packet(dims, `ghost-images`)
    const renderer = new BondReplicaRenderer()
    renderer.update(packet)

    // Expected count straight from the T1 oracle sweep.
    let expected = 0
    const graph = packet.topology.bond_graph!
    for (let bi = 0; bi < graph.pairs.length / 2; bi++) {
      const bond: PeriodicBond = {
        a: graph.pairs[bi * 2],
        b: graph.pairs[bi * 2 + 1],
        jimage: [
          graph.jimages[bi * 3],
          graph.jimages[bi * 3 + 1],
          graph.jimages[bi * 3 + 2],
        ],
      }
      for (const cell of sweep_cells(dims)) {
        if (resolve_periodic_edge(bond, cell, dims, `ghost-images`).kind === `ghost`) {
          expected += 1
        }
      }
    }
    expect(expected).toBe(3) // (1,2,+x)@cell1 + (0,0,+z)@cell0 + (0,0,+z)@cell1

    expect(geo(renderer.ghost_mesh).instanceCount).toBe(expected)
    expect(renderer.ghost_mesh.visible).toBe(true)

    // Every table entry must itself resolve to 'ghost' through the oracle.
    const table = build_ghost_half_table(graph, dims, `ghost-images`)
    expect(table.count).toBe(expected)
    for (let idx = 0; idx < table.count; idx++) {
      const bond: PeriodicBond = {
        a: table.sites[idx * 2],
        b: table.sites[idx * 2 + 1],
        jimage: [
          table.jimages[idx * 3],
          table.jimages[idx * 3 + 1],
          table.jimages[idx * 3 + 2],
        ],
      }
      const cell: [number, number, number] = [
        table.cells[idx * 3],
        table.cells[idx * 3 + 1],
        table.cells[idx * 3 + 2],
      ]
      expect(resolve_periodic_edge(bond, cell, dims, `ghost-images`).kind)
        .toBe(`ghost`)
    }
    renderer.dispose()
  })

  test(`stub / hide policies keep the second draw empty`, () => {
    for (const policy of [`stub`, `hide`] as const) {
      const renderer = new BondReplicaRenderer()
      renderer.update(make_packet([2, 1, 1], policy))
      expect(geo(renderer.ghost_mesh).instanceCount).toBe(0)
      expect(renderer.ghost_mesh.visible).toBe(false)
      renderer.dispose()
    }
  })

  test(`ghost-images 1×↔2×↔8× keeps main and sparse attribute buffers`, () => {
    const builder = create_render_packet_builder()
    const structure = make_structure(3)
    const renderer = new BondReplicaRenderer()
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
    const main_names = [`a_site`, `a_jimage`] as const
    const ghost_names = [`g_site`, `g_jimage`, `g_cell`] as const
    const main_attrs = main_names.map((name) => attr(renderer.mesh, name))
    const ghost_attrs = ghost_names.map((name) => attr(renderer.ghost_mesh, name))
    const main_arrays = main_attrs.map((attribute) => attribute.array)
    const ghost_arrays = ghost_attrs.map((attribute) => attribute.array)
    expect(geo(renderer.ghost_mesh).getAttribute(`g_color`)).toBeUndefined()

    for (const dims of [
      [2, 1, 1],
      [2, 2, 2],
      [1, 1, 1],
    ] as const) {
      const next = packet(dims)
      renderer.update(next)
      const table = build_ghost_half_table(
        next.topology.bond_graph!,
        next.replicas.dims,
        `ghost-images`,
      )
      expect(geo(renderer.mesh)).toBe(main_geometry)
      expect(geo(renderer.ghost_mesh)).toBe(ghost_geometry)
      for (let idx = 0; idx < main_names.length; idx++) {
        // Divisor changes replace the attribute OBJECT (identity-based VAO
        // rebind) but always reuse the graph-sized typed array.
        expect(attr(renderer.mesh, main_names[idx]).array).toBe(main_arrays[idx])
      }
      for (let idx = 0; idx < ghost_names.length; idx++) {
        expect(attr(renderer.ghost_mesh, ghost_names[idx])).toBe(ghost_attrs[idx])
        expect(ghost_attrs[idx].array).toBe(ghost_arrays[idx])
        expect(ghost_attrs[idx].count).toBe(table.count)
      }
      expect(main_geometry.instanceCount).toBe(
        2 * BOND_COUNT * cell_count_of(dims),
      )
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
    const renderer = new BondReplicaRenderer()
    const packet = (
      dims: readonly [number, number, number],
      boundary_policy: BoundaryPolicy = `ghost-images`,
    ) => builder.build({ structure, bond_connectivity: bonds, dims, boundary_policy })

    renderer.update(packet([1, 1, 1]))
    expect(ghost_pages(renderer.ghost_mesh)).toHaveLength(1)
    const position_texture = renderer.material.uniforms.uPosTex.value as THREE.DataTexture
    renderer.update(packet([2, 2, 2]))
    const pages = ghost_pages(renderer.ghost_mesh)
    expect(pages).toHaveLength(3)
    expect(pages.map((page) => geo(page).instanceCount)).toEqual([256, 256, 4])
    const attrs = pages.map((page) => attr(page, `g_site`))
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
      expect(attr(pages[idx], `g_site`)).toBe(attrs[idx])
      expect(attrs[idx].array).toBe(arrays[idx])
    }

    const disposed = pages.map(() => vi.fn())
    for (let idx = 0; idx < pages.length; idx++) {
      pages[idx].geometry.addEventListener(`dispose`, disposed[idx])
    }
    const material_disposed = vi.fn()
    const ghost_material_disposed = vi.fn()
    const texture_disposed = vi.fn()
    renderer.material.addEventListener(`dispose`, material_disposed)
    renderer.ghost_material.addEventListener(`dispose`, ghost_material_disposed)
    position_texture.addEventListener(`dispose`, texture_disposed)
    renderer.dispose()
    for (const spy of disposed) expect(spy).toHaveBeenCalledOnce()
    expect(material_disposed).toHaveBeenCalledOnce()
    expect(ghost_material_disposed).toHaveBeenCalledOnce()
    expect(texture_disposed).toHaveBeenCalledOnce()
  })
})

describe(`legacy BondInstancedRenderer bypass wiring`, () => {
  test(`set_suspended gates sync work until the replica layer releases it`, () => {
    const mesh = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.15, 0.15, 1, 8),
      new THREE.MeshBasicMaterial(),
      16,
    )
    const manager = new BondManager(16)
    const positions = new Float32Array([0, 0, 0, 1, 0, 0])
    const renderer = new BondInstancedRenderer(mesh, manager, () => positions)
    manager.add_bond(0, 1, BOND_KIND.AUTO)

    const before = (mesh.instanceMatrix.array as Float32Array).slice()
    renderer.set_suspended(true)
    renderer.sync()
    renderer.force_full_resync()
    renderer.sync_gpu_topology()
    // Suspended: no matrices composed, no GPU attrs written.
    expect(Array.from(mesh.instanceMatrix.array as Float32Array))
      .toEqual(Array.from(before))
    expect(mesh.geometry.getAttribute(`a_site`)).toBeUndefined()

    renderer.set_suspended(false)
    renderer.sync()
    expect(Array.from((mesh.instanceMatrix.array as Float32Array).slice(0, 32)))
      .not.toEqual(Array.from(before.slice(0, 32)))
    expect(mesh.count).toBe(2)
  })
})

describe(`per-frame bond-count churn stays identity-stable (#534)`, () => {
  // MD playback changes the bond count nearly every frame. The renderer must
  // absorb that as an in-place rewrite on capacity-stable attributes — a
  // fresh-attribute install per frame costs a VAO rebuild + a new GL buffer
  // per attribute per frame (the old ones leak until GC) + full-capacity
  // uploads, which is the #534 playback regression.
  const BOND_ATTRS = [`a_site`, `a_jimage`] as const

  function packet_with_bonds(
    builder: ReturnType<typeof create_render_packet_builder>,
    n: number,
  ): RenderPacket {
    const bonds: PacketBondConnectivity[] = Array.from({ length: n }, (_, idx) => ({
      site_idx_1: idx % 3,
      site_idx_2: (idx + 1) % 3,
    }))
    return builder.build({
      structure: make_structure(3),
      bond_connectivity: bonds,
      dims: [1, 1, 1],
      positions_version: n,
    })
  }

  test(`shrink + regrow within capacity keep attribute and array identities`, () => {
    const builder = create_render_packet_builder()
    const renderer = new BondReplicaRenderer()
    renderer.update(packet_with_bonds(builder, 4))
    const attrs0 = BOND_ATTRS.map((name) => attr(renderer.mesh, name))
    const arrays0 = attrs0.map((attribute) => attribute.array)
    expect(geo(renderer.mesh).instanceCount).toBe(8)

    // Shrink 4 → 3 bonds: same attributes, same backing arrays, live span 3.
    renderer.update(packet_with_bonds(builder, 3))
    BOND_ATTRS.forEach((name, idx) => {
      const attribute = attr(renderer.mesh, name)
      expect(attribute).toBe(attrs0[idx])
      expect(attribute.array).toBe(arrays0[idx])
    })
    expect(geo(renderer.mesh).instanceCount).toBe(6)

    // Regrow 3 → 4 bonds (fits capacity): still the same identities.
    renderer.update(packet_with_bonds(builder, 4))
    BOND_ATTRS.forEach((name, idx) => {
      expect(attr(renderer.mesh, name)).toBe(attrs0[idx])
    })
    expect(geo(renderer.mesh).instanceCount).toBe(8)
    renderer.dispose()
  })

  test(`rewrites cover exactly the live prefix via accumulated update ranges`, () => {
    const builder = create_render_packet_builder()
    const renderer = new BondReplicaRenderer()
    renderer.update(packet_with_bonds(builder, 4))
    renderer.update(packet_with_bonds(builder, 3))
    for (const name of BOND_ATTRS) {
      const attribute = attr(renderer.mesh, name)
      expect(attribute.needsUpdate || attribute.version > 0).toBe(true)
      // Ranges accumulate until the draw consumes them (#532 contract); the
      // latest one must span the full live prefix of 3 logical bonds.
      const last = attribute.updateRanges.at(-1)!
      expect(last.start).toBe(0)
      expect(last.count).toBe(3 * attribute.itemSize)
    }
    renderer.dispose()
  })

  test(`growth beyond capacity installs fresh attributes and drops the draw clamp`, () => {
    const builder = create_render_packet_builder()
    const renderer = new BondReplicaRenderer()
    renderer.update(packet_with_bonds(builder, 2))
    const before = BOND_ATTRS.map((name) => attr(renderer.mesh, name))
    ;(geo(renderer.mesh) as unknown as { _maxInstanceCount?: number })
      ._maxInstanceCount = 4

    renderer.update(packet_with_bonds(builder, 8))
    BOND_ATTRS.forEach((name, idx) => {
      const attribute = attr(renderer.mesh, name)
      expect(attribute).not.toBe(before[idx])
      expect(attribute.array.length).toBeGreaterThanOrEqual(8 * attribute.itemSize)
    })
    expect(geo(renderer.mesh).instanceCount).toBe(16)
    expect(
      (geo(renderer.mesh) as unknown as { _maxInstanceCount?: number })
        ._maxInstanceCount,
    ).toBeUndefined()
    renderer.dispose()
  })
})

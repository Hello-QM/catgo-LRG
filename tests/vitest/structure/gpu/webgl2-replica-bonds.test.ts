// gpu-visual-supercell Task 4 — WebGL2 bond replica impostors (design §7.2).
//
// One base `BaseBondGraph` drives all replica cells: per-half attributes stay
// 2B-sized (divisor = cell count), `instanceCount = 2B × nx·ny·nz`, and the
// flat ray-cylinder impostor shader evaluates `cell + jimage` per replica —
// complete / stub / hide / ghost — against the CURRENT frame lattice uniform.
// Periodic self-image edges (a === b, jimage ≠ 0) are valid and never
// filtered. Ghost-side halves render through a sparse second draw. The legacy
// `InstancedMesh` path (one CPU mat4 per drawn instance) fails all of this.
import { describe, expect, test } from 'vitest'
import * as THREE from 'three'
import {
  BondReplicaRenderer,
  build_ghost_half_table,
  classify_half_draw,
} from '$lib/structure/gpu/webgl2/bond-replica-renderer'
import {
  type PeriodicBond,
  resolve_periodic_edge,
} from '$lib/structure/scene/replica-layout'
import type { BoundaryPolicy, RenderPacket } from '$lib/structure/scene/render-packet'
import {
  create_render_packet_builder,
  type PacketBondConnectivity,
} from '$lib/structure/scene/render-packet-builder'
import { BOND_KIND, BondManager } from '$lib/structure/bonding/bond-manager.svelte'
import { BondInstancedRenderer } from '$lib/structure/bonding/bond-instanced-renderer'
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

describe(`BondReplicaRenderer — mesh shape`, () => {
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

  test(`2×2×2 draws 16B instances from 2B-sized half attributes at divisor 8`, () => {
    const renderer = new BondReplicaRenderer()
    renderer.update(make_packet([2, 2, 2]))

    // 2 halves per base bond × 8 replica cells = 16B.
    expect(geo(renderer.mesh).instanceCount).toBe(2 * BOND_COUNT * 8)
    for (const name of [`a_site`, `a_jimage`, `a_half`, `a_color`]) {
      const half_attr = attr(renderer.mesh, name)
      // Uploaded buffers stay base-sized: one slot per HALF, not per replica.
      expect(half_attr.count).toBe(2 * BOND_COUNT)
      expect(half_attr.meshPerAttribute).toBe(8)
    }
    renderer.dispose()
  })

  test(`self-image edges land in the half attributes unfiltered`, () => {
    const renderer = new BondReplicaRenderer()
    renderer.update(make_packet([2, 2, 2]))
    const site = attr(renderer.mesh, `a_site`).array as Float32Array
    const jimage = attr(renderer.mesh, `a_jimage`).array as Int8Array
    const half = attr(renderer.mesh, `a_half`).array as Float32Array
    // Bond 2 is the (0, 0, [0,0,1]) self-edge → half instances 4 and 5.
    expect([site[8], site[9], site[10], site[11]]).toEqual([0, 0, 0, 0])
    expect(Array.from(jimage.slice(12, 18))).toEqual([0, 0, 1, 0, 0, 1])
    expect([half[4], half[5]]).toEqual([0, 1])
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
      half: attr(mesh, `a_half`),
      color: attr(mesh, `a_color`),
    }
    const versions = Object.fromEntries(
      Object.entries(attributes).map(([key, value]) => [key, value.version]),
    )

    renderer.update(builder.build({
      structure,
      bond_connectivity: BONDS,
      dims: [3, 3, 3],
    }))

    expect(renderer.mesh).toBe(mesh)
    expect(geo(renderer.mesh)).toBe(geometry)
    expect(renderer.mesh.material).toBe(material)
    // Same attribute OBJECTS (and therefore same renderer-side WebGLBuffer
    // resources) — a factor-only change mutates divisors/counts without a
    // base-data upload (version stays unchanged).
    expect(attr(mesh, `a_site`)).toBe(attributes.site)
    expect(attr(mesh, `a_jimage`)).toBe(attributes.jimage)
    expect(attr(mesh, `a_half`)).toBe(attributes.half)
    expect(attr(mesh, `a_color`)).toBe(attributes.color)
    expect(attributes.site.version).toBe(versions.site)
    expect(attributes.jimage.version).toBe(versions.jimage)
    expect(attributes.half.version).toBe(versions.half)
    expect(attributes.color.version).toBe(versions.color)
    expect(attr(mesh, `a_site`).meshPerAttribute).toBe(27)
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
    ]) expect(material.vertexShader).toContain(token)
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
      getDrawingBufferSize(target: THREE.Vector2) {
        return target.set(1600, 900)
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
    const viewport = renderer.material.uniforms.uViewport.value as THREE.Vector2
    expect(inv.elements).toEqual(camera.projectionMatrixInverse.elements)
    expect([viewport.x, viewport.y]).toEqual([1600, 900])
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
})

describe(`BondReplicaRenderer — sparse ghost second draw`, () => {
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

import { afterEach, describe, expect, test, vi } from 'vitest'
import { flushSync, mount, tick, unmount } from 'svelte'
import * as THREE from 'three'
import type { AnyStructure, Site } from '$lib'
import { AtomManager } from '$lib/structure/atoms/atom-manager.svelte'
import { BondManager } from '$lib/structure/bonding/bond-manager.svelte'
import {
  SharedPositionTexture,
  type UploadedFrameIdentity,
} from '$lib/structure/gpu/webgl2/shared-position-texture'
import { AtomReplicaRenderer } from '$lib/structure/gpu/webgl2/atom-replica-renderer'
import { BondReplicaRenderer } from '$lib/structure/gpu/webgl2/bond-replica-renderer'
import { combined_packet_render_eligible } from '$lib/structure/gpu/combined-packet-render-eligible'
import {
  create_render_packet_builder,
  type PacketBondConnectivity,
} from '$lib/structure/scene/render-packet-builder'
import Harness from './webgl2-replica-managers-harness.svelte'

function carbon_site(xyz: [number, number, number]): Site {
  return {
    species: [{ element: `C`, occu: 1, oxidation_state: 0 }],
    abc: [0, 0, 0],
    xyz,
    label: `C`,
    properties: {},
  } as unknown as Site
}

function packets() {
  const structure = {
    sites: [carbon_site([0, 0, 0]), carbon_site([1.4, 0, 0])],
    lattice: {
      matrix: [[10, 0, 0], [0, 10, 0], [0, 0, 10]],
      pbc: [true, true, true],
      a: 10,
      b: 10,
      c: 10,
      alpha: 90,
      beta: 90,
      gamma: 90,
      volume: 1000,
    },
  } as unknown as AnyStructure
  const bonds: PacketBondConnectivity[] = [
    { site_idx_1: 0, site_idx_2: 1 },
  ]
  const builder = create_render_packet_builder()
  return [
    builder.build({
      structure,
      bond_connectivity: bonds,
      dims: [1, 1, 1],
      frame_idx: 0,
      positions_version: 1,
    }),
    builder.build({
      structure,
      bond_connectivity: bonds,
      dims: [2, 1, 1],
      frame_positions: new Float32Array([0, 1, 0, 1.4, 1, 0]),
      frame_idx: 1,
      positions_version: 2,
    }),
    builder.build({
      structure,
      bond_connectivity: bonds,
      dims: [2, 2, 2],
      frame_idx: 2,
      positions_version: 3,
    }),
  ]
}

function fake_renderer(): THREE.WebGLRenderer {
  return {
    render: vi.fn(),
    setSize: vi.fn(),
    setPixelRatio: vi.fn(),
    getDrawingBufferSize: (target: THREE.Vector2) => target.set(800, 600),
    dispose: vi.fn(),
    outputColorSpace: THREE.SRGBColorSpace,
    shadowMap: { enabled: false, type: THREE.PCFSoftShadowMap },
    toneMapping: THREE.NoToneMapping,
  } as unknown as THREE.WebGLRenderer
}

function meshes(scene: THREE.Scene): THREE.Mesh[] {
  const found: THREE.Mesh[] = []
  scene.traverse((object) => {
    if ((object as THREE.Mesh).isMesh) found.push(object as THREE.Mesh)
  })
  return found
}

function renderer_meshes(
  scene: THREE.Scene,
  uniform: `uRenderStyle` | `uBondRadius`,
): THREE.Mesh[] {
  return meshes(scene).filter((mesh) =>
    uniform in (mesh.material as THREE.ShaderMaterial).uniforms
  )
}

async function settle(): Promise<void> {
  flushSync()
  await tick()
  flushSync()
}

const mounted: object[] = []
afterEach(async () => {
  while (mounted.length > 0) await unmount(mounted.pop()!)
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe(`unified WebGL2 replica layer`, () => {
  test(`reports renderer-derived packet evidence only after every enabled resource is synchronized`, async () => {
    const dom = document.createElement(`div`)
    const canvas = document.createElement(`canvas`)
    dom.append(canvas)
    document.body.append(dom)
    const expected_packets = packets()
    let scene!: THREE.Scene
    let positions!: SharedPositionTexture
    const atom_updates = vi.spyOn(AtomReplicaRenderer.prototype, `update`)
    const bond_updates = vi.spyOn(BondReplicaRenderer.prototype, `update`)
    const synced: Array<UploadedFrameIdentity & {
      packet: ReturnType<typeof packets>[number]
      topology_version: number
      graph_version: number | null
      bond_count: number
      atom_renderer_synced: boolean
      bond_renderer_synced: boolean
    }> = []
    const component = mount(Harness, {
      target: dom,
      props: {
        mode: `combined`,
        packets: expected_packets,
        atom_manager: new AtomManager(16),
        bond_manager: new BondManager(16),
        renderer: fake_renderer(),
        dom,
        canvas,
        onscene: (next: THREE.Scene) => scene = next,
        onpositions: (next: SharedPositionTexture) => positions = next,
        on_packet_synced: (evidence) => {
          expect(atom_updates).toHaveBeenCalled()
          expect(bond_updates).toHaveBeenCalled()
          expect(positions.uploaded_frame()).toMatchObject({
            owner: evidence.owner,
            frame_idx: evidence.frame_idx,
            positions_version: evidence.positions_version,
          })
          synced.push(evidence)
        },
      },
    })
    mounted.push(component)
    await settle()

    expect(synced).toHaveLength(1)
    expect(synced[0].packet).toBe(expected_packets[0])
    expect(synced[0]).toMatchObject({
      owner: expected_packets[0].frame.owner,
      frame_idx: expected_packets[0].frame.frame_idx,
      positions_version: expected_packets[0].frame.positions_version,
      topology_version: expected_packets[0].topology.version,
      graph_version: expected_packets[0].topology.bond_graph?.version ?? null,
      bond_count:
        (expected_packets[0].topology.bond_graph?.pairs.length ?? 0) / 2,
      atom_renderer_synced: true,
      bond_renderer_synced: true,
    })
    const atom_main = renderer_meshes(scene, `uRenderStyle`).find((mesh) =>
      `uCellCount` in (mesh.material as THREE.ShaderMaterial).uniforms
    )!
    const bond_main = renderer_meshes(scene, `uBondRadius`).find((mesh) =>
      `uCellCount` in (mesh.material as THREE.ShaderMaterial).uniforms
    )!
    expect(
      (atom_main.material as THREE.ShaderMaterial).uniforms.uLattice.value
        .toArray(),
    ).toEqual(Array.from(expected_packets[0].frame.lattice))
    expect(
      (bond_main.material as THREE.ShaderMaterial).uniforms.uLattice.value
        .toArray(),
    ).toEqual(Array.from(expected_packets[0].frame.lattice))
    expect(
      (bond_main.geometry as THREE.InstancedBufferGeometry).instanceCount,
    ).toBe(synced[0].bond_count * 2)
  })

  test(`does not report packet sync when the installed frame metadata is stale`, async () => {
    vi.spyOn(SharedPositionTexture.prototype, `uploaded_frame`)
      .mockReturnValue({
        owner: {},
        frame_idx: 99,
        positions_version: 99,
      })
    const dom = document.createElement(`div`)
    const canvas = document.createElement(`canvas`)
    dom.append(canvas)
    document.body.append(dom)
    const on_packet_synced = vi.fn()
    const component = mount(Harness, {
      target: dom,
      props: {
        mode: `combined`,
        packets: packets(),
        atom_manager: new AtomManager(16),
        bond_manager: new BondManager(16),
        renderer: fake_renderer(),
        dom,
        canvas,
        onscene: () => {},
        on_packet_synced,
      },
    })
    mounted.push(component)
    await settle()

    expect(on_packet_synced).not.toHaveBeenCalled()
  })

  test.each([
    [`an independent bond packet`, `packet`],
    [`tampered bond graph metadata`, `metadata`],
  ] as const)(
    `does not report packet sync from %s`,
    async (_description, fault) => {
      const expected_packets = packets()
      vi.spyOn(BondReplicaRenderer.prototype, `installed_state`)
        .mockImplementation(function () {
          const packet = this.installed_packet()
          if (packet === null) return null
          const graph = packet.topology.bond_graph
          return {
            packet: fault === `packet` ? { ...packet } : packet,
            topology_version: packet.topology.version,
            graph_version: fault === `metadata`
              ? (graph?.version ?? 0) + 1
              : graph?.version ?? null,
            bond_count: (graph?.pairs.length ?? 0) / 2 +
              (fault === `metadata` ? 1 : 0),
          }
        })
      const dom = document.createElement(`div`)
      const canvas = document.createElement(`canvas`)
      dom.append(canvas)
      document.body.append(dom)
      const on_packet_synced = vi.fn()
      const component = mount(Harness, {
        target: dom,
        props: {
          mode: `combined`,
          packets: expected_packets,
          atom_manager: new AtomManager(16),
          bond_manager: new BondManager(16),
          renderer: fake_renderer(),
          dom,
          canvas,
          onscene: () => {},
          on_packet_synced,
        },
      })
      mounted.push(component)
      await settle()

      expect(on_packet_synced).not.toHaveBeenCalled()
    },
  )

  test(`creates and disposes the bond draw reactively without replacing atoms`, async () => {
    const dom = document.createElement(`div`)
    const canvas = document.createElement(`canvas`)
    dom.append(canvas)
    document.body.append(dom)
    let scene!: THREE.Scene
    let positions!: SharedPositionTexture
    const component = mount(Harness, {
      target: dom,
      props: {
        mode: `combined`,
        packets: packets(),
        atom_manager: new AtomManager(16),
        bond_manager: new BondManager(16),
        renderer: fake_renderer(),
        dom,
        canvas,
        onscene: (next: THREE.Scene) => scene = next,
        onpositions: (next: SharedPositionTexture) => positions = next,
        initial_show_atoms: true,
        initial_show_bonds: false,
      },
    })
    mounted.push(component)
    await settle()

    const atom_meshes = renderer_meshes(scene, `uRenderStyle`)
    expect(atom_meshes).toHaveLength(2)
    expect(renderer_meshes(scene, `uBondRadius`)).toHaveLength(0)
    expect(positions.stats()).toMatchObject({
      uploads: 1,
      atom_consumers: 1,
      bond_consumers: 0,
    })

    dom.querySelector<HTMLButtonElement>(`[data-testid="bonds-on"]`)!.click()
    await settle()
    const bond_meshes = renderer_meshes(scene, `uBondRadius`)
    expect(bond_meshes).toHaveLength(2)
    expect(renderer_meshes(scene, `uRenderStyle`)).toEqual(atom_meshes)
    expect(
      (bond_meshes[0].geometry as THREE.InstancedBufferGeometry).instanceCount,
    ).toBeGreaterThan(0)
    expect(positions.stats()).toMatchObject({
      uploads: 1,
      atom_consumers: 1,
      bond_consumers: 1,
    })

    dom.querySelector<HTMLButtonElement>(`[data-testid="bonds-off"]`)!.click()
    await settle()
    expect(renderer_meshes(scene, `uBondRadius`)).toHaveLength(0)
    expect(renderer_meshes(scene, `uRenderStyle`)).toEqual(atom_meshes)
    expect(positions.stats()).toMatchObject({
      uploads: 1,
      atom_consumers: 1,
      bond_consumers: 0,
    })
  })

  test(`creates and disposes the atom draw reactively without replacing bonds`, async () => {
    const dom = document.createElement(`div`)
    const canvas = document.createElement(`canvas`)
    dom.append(canvas)
    document.body.append(dom)
    let scene!: THREE.Scene
    let positions!: SharedPositionTexture
    const component = mount(Harness, {
      target: dom,
      props: {
        mode: `combined`,
        packets: packets(),
        atom_manager: new AtomManager(16),
        bond_manager: new BondManager(16),
        renderer: fake_renderer(),
        dom,
        canvas,
        onscene: (next: THREE.Scene) => scene = next,
        onpositions: (next: SharedPositionTexture) => positions = next,
        initial_show_atoms: false,
        initial_show_bonds: true,
      },
    })
    mounted.push(component)
    await settle()

    const bond_meshes = renderer_meshes(scene, `uBondRadius`)
    expect(bond_meshes).toHaveLength(2)
    expect(renderer_meshes(scene, `uRenderStyle`)).toHaveLength(0)
    expect(positions.stats()).toMatchObject({
      uploads: 1,
      atom_consumers: 0,
      bond_consumers: 1,
    })

    dom.querySelector<HTMLButtonElement>(`[data-testid="style-toon"]`)!.click()
    dom.querySelector<HTMLButtonElement>(`[data-testid="appearance"]`)!.click()
    dom.querySelector<HTMLButtonElement>(`[data-testid="atoms-on"]`)!.click()
    await settle()
    const atom_meshes = renderer_meshes(scene, `uRenderStyle`)
    expect(atom_meshes).toHaveLength(2)
    expect(renderer_meshes(scene, `uBondRadius`)).toEqual(bond_meshes)
    const atom_main = atom_meshes.find((mesh) =>
      `uCellCount` in (mesh.material as THREE.ShaderMaterial).uniforms
    )!
    expect(
      (atom_main.geometry as THREE.InstancedBufferGeometry).instanceCount,
    ).toBeGreaterThan(0)
    expect(
      (atom_main.material as THREE.ShaderMaterial).uniforms.uRenderStyle.value,
    ).toBe(2)
    expect(
      (bond_meshes[0].material as THREE.ShaderMaterial).uniforms.uOpacity.value,
    ).toBeCloseTo(0.4)
    expect(positions.stats()).toMatchObject({
      uploads: 1,
      atom_consumers: 1,
      bond_consumers: 1,
    })

    dom.querySelector<HTMLButtonElement>(`[data-testid="atoms-off"]`)!.click()
    await settle()
    expect(renderer_meshes(scene, `uRenderStyle`)).toHaveLength(0)
    expect(renderer_meshes(scene, `uBondRadius`)).toEqual(bond_meshes)
    expect(positions.stats()).toMatchObject({
      uploads: 1,
      atom_consumers: 0,
      bond_consumers: 1,
    })
  })

  test(`disposes each live renderer exactly once across toggles and unmount`, async () => {
    const atom_dispose = vi.spyOn(AtomReplicaRenderer.prototype, `dispose`)
    const bond_dispose = vi.spyOn(BondReplicaRenderer.prototype, `dispose`)
    const dom = document.createElement(`div`)
    const canvas = document.createElement(`canvas`)
    dom.append(canvas)
    document.body.append(dom)
    let positions!: SharedPositionTexture
    const component = mount(Harness, {
      target: dom,
      props: {
        mode: `combined`,
        packets: packets(),
        atom_manager: new AtomManager(16),
        bond_manager: new BondManager(16),
        renderer: fake_renderer(),
        dom,
        canvas,
        onscene: () => {},
        onpositions: (next: SharedPositionTexture) => positions = next,
      },
    })
    mounted.push(component)
    await settle()

    dom.querySelector<HTMLButtonElement>(`[data-testid="bonds-off"]`)!.click()
    await settle()
    expect(bond_dispose).toHaveBeenCalledTimes(1)
    expect(positions.stats().bond_consumers).toBe(0)

    dom.querySelector<HTMLButtonElement>(`[data-testid="bonds-on"]`)!.click()
    await settle()
    expect(positions.stats()).toMatchObject({
      uploads: 1,
      atom_consumers: 1,
      bond_consumers: 1,
    })

    mounted.splice(mounted.indexOf(component), 1)
    await unmount(component)
    expect(atom_dispose).toHaveBeenCalledTimes(1)
    expect(bond_dispose).toHaveBeenCalledTimes(2)
    expect(positions.stats()).toMatchObject({
      atom_consumers: 0,
      bond_consumers: 0,
    })
  })

  test(`owns one atom draw, one bond draw, and one position upload per frame`, async () => {
    const dom = document.createElement(`div`)
    const canvas = document.createElement(`canvas`)
    dom.append(canvas)
    document.body.append(dom)
    let scene!: THREE.Scene
    let positions!: SharedPositionTexture
    const component = mount(Harness, {
      target: dom,
      props: {
        mode: `combined`,
        packets: packets(),
        atom_manager: new AtomManager(16),
        bond_manager: new BondManager(16),
        renderer: fake_renderer(),
        dom,
        canvas,
        onscene: (next: THREE.Scene) => scene = next,
        onpositions: (next: SharedPositionTexture) => positions = next,
      },
    })
    mounted.push(component)
    await settle()

    const packet_meshes = meshes(scene)
    expect(packet_meshes).toHaveLength(4)
    expect(packet_meshes.filter((mesh) => mesh.visible)).toHaveLength(2)
    expect(packet_meshes.every((mesh) =>
      (mesh.material as THREE.ShaderMaterial).uniforms.uPosTex?.value ===
        positions.texture
    )).toBe(true)
    expect(positions.stats()).toMatchObject({
      uploads: 1,
      atom_consumers: 1,
      bond_consumers: 1,
    })

    dom.querySelector<HTMLButtonElement>(`[data-testid="factor-2"]`)!.click()
    await settle()
    expect(meshes(scene)).toEqual(packet_meshes)
    expect(positions.stats().uploads).toBe(2)

    dom.querySelector<HTMLButtonElement>(`[data-testid="factor-null"]`)!.click()
    await settle()
    expect(meshes(scene).filter((mesh) =>
      (mesh as THREE.InstancedMesh).isInstancedMesh
    )).toHaveLength(2)
  })

  test(`unsupported visual features select the exact legacy path`, () => {
    const base = {
      atom_opacity_overrides: 0,
      bond_opacity_overrides: 0,
      cutting_active: false,
      drag_overrides: 0,
      partial_occupancy: false,
      multibond: false,
    }
    expect(combined_packet_render_eligible(base)).toBe(true)
    for (const override of [
      { atom_opacity_overrides: 1 },
      { bond_opacity_overrides: 1 },
      { cutting_active: true },
      { drag_overrides: 1 },
      { hidden_atoms: 1 },
      { partial_occupancy: true },
      { multibond: true },
    ]) {
      expect(combined_packet_render_eligible({ ...base, ...override })).toBe(false)
    }
  })
})

import { afterEach, describe, expect, test, vi } from 'vitest'
import { flushSync, mount, tick, unmount } from 'svelte'
import * as THREE from 'three'
import type { AnyStructure, Site } from '$lib'
import { AtomManager } from '$lib/structure/atoms/atom-manager.svelte'
import { BondManager } from '$lib/structure/bonding/bond-manager.svelte'
import type { SharedPositionTexture } from '$lib/structure/gpu/webgl2/shared-position-texture'
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

async function settle(): Promise<void> {
  flushSync()
  await tick()
  flushSync()
}

const mounted: object[] = []
afterEach(async () => {
  while (mounted.length > 0) await unmount(mounted.pop()!)
  document.body.replaceChildren()
})

describe(`unified WebGL2 replica layer`, () => {
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

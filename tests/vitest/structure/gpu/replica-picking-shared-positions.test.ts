import { describe, expect, test, vi } from 'vitest'
import * as THREE from 'three'
import type { AnyStructure, Site } from '$lib'
import { create_replica_picker } from '$lib/structure/gpu-picker-integration.svelte'
import { ReplicaPickScene } from '$lib/structure/gpu/webgl2/replica-id-picker'
import { SharedPositionTexture } from '$lib/structure/gpu/webgl2/shared-position-texture'
import {
  create_render_packet_builder,
  type PacketBondConnectivity,
} from '$lib/structure/scene/render-packet-builder'

function carbon_site(xyz: [number, number, number]): Site {
  return {
    species: [{ element: `C`, occu: 1, oxidation_state: 0 }],
    abc: [0, 0, 0],
    xyz,
    label: `C`,
    properties: {},
  } as unknown as Site
}

function make_packet(frame_idx: number, positions_version: number) {
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
    { site_idx_1: 1, site_idx_2: 0, jimage: [1, 0, 0] },
  ]
  return create_render_packet_builder().build({
    structure,
    bond_connectivity: bonds,
    dims: [2, 1, 1],
    boundary_policy: `ghost-images`,
    frame_positions: new Float32Array([
      0,
      frame_idx,
      0,
      1.4,
      frame_idx,
      0,
    ]),
    frame_idx,
    positions_version,
  })
}

function fake_renderer() {
  return {
    domElement: { width: 200, height: 100 } as HTMLCanvasElement,
  } as unknown as THREE.WebGLRenderer
}

describe(`replica picker shared positions`, () => {
  test(`passive playback stays lazy and first sync does not upload positions`, () => {
    const positions = new SharedPositionTexture()
    const picker = create_replica_picker(positions)
    const packet = make_packet(0, 1)
    positions.update(packet.frame)

    expect(picker.stats()).toEqual({ created: 0, syncs: 0 })
    expect(positions.stats()).toMatchObject({
      uploads: 1,
      picker_consumers: 0,
    })

    picker.sync(fake_renderer(), packet)
    expect(picker.stats()).toEqual({ created: 1, syncs: 1 })
    expect(positions.stats()).toMatchObject({
      uploads: 1,
      picker_consumers: 1,
    })
    picker.dispose()
    positions.dispose()
  })

  test(`atom, bond, and ghost draws reference one visible texture`, () => {
    const positions = new SharedPositionTexture()
    const packet = make_packet(0, 1)
    positions.update(packet.frame)
    const scene = new ReplicaPickScene({
      renderer: fake_renderer(),
      positions,
    })

    scene.sync(packet)

    expect(scene.atom_material.uniforms.uPosTex.value).toBe(positions.texture)
    expect(scene.bond_material.uniforms.uPosTex.value).toBe(positions.texture)
    expect(scene.ghost_material.uniforms.uPosTex.value).toBe(positions.texture)
    const atom_geometry =
      scene.atom_mesh.geometry as THREE.InstancedBufferGeometry
    expect(atom_geometry.getAttribute(`instanceSite`).array)
      .toEqual(Float32Array.from([0, 1]))
    expect(positions.stats().uploads).toBe(1)

    const site_attribute = atom_geometry.getAttribute(`instanceSite`)
    const next = make_packet(1, 2)
    positions.update(next.frame)
    scene.sync(next)
    scene.sync(next)
    expect(atom_geometry.getAttribute(`instanceSite`)).toBe(site_attribute)
    expect(positions.stats().uploads).toBe(2)

    const texture_dispose = vi.spyOn(positions.texture, `dispose`)
    scene.dispose()
    expect(texture_dispose).not.toHaveBeenCalled()
    expect(positions.stats().picker_consumers).toBe(0)
    positions.dispose()
  })
})

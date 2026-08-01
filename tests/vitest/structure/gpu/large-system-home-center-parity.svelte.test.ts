import type { AnyStructure } from '$lib'
import { pack_camera_full } from '$lib/structure/gpu/camera-uniform'
import { resolve_view_transform } from '$lib/structure/rendering/view-transform'
import type { RenderPacket } from '$lib/structure/scene/render-packet'
import {
  Group,
  OrthographicCamera,
  PerspectiveCamera,
  type Camera,
  Vector3,
} from 'three'
import { flushSync, mount, tick, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const renderer = {
    destroy: vi.fn(),
    on_bond_work: vi.fn(),
    on_device_lost: vi.fn(),
    pick: vi.fn(),
    render: vi.fn(),
    resize: vi.fn(),
    set_background: vi.fn(),
    set_bond_data: vi.fn(),
    set_bond_rules: vi.fn(),
    set_bond_style: vi.fn(),
    set_bonds_enabled: vi.fn(),
    set_camera_full: vi.fn(),
    set_cell: vi.fn(),
    set_gizmo_layout: vi.fn(),
    set_ghost_opacity: vi.fn(),
    set_packet: vi.fn(),
    set_selection: vi.fn(),
    set_shading: vi.fn(() => false),
  }
  return {
    renderer,
    create_large_system_renderer: vi.fn(() => renderer),
    get_webgpu_lease: vi.fn(async () => ({
      device: {},
      generation: 1,
    })),
    invalidate_webgpu_lease: vi.fn(),
  }
})

vi.mock(`$lib/structure/gpu/webgpu-context`, () => ({
  get_webgpu_lease: mocks.get_webgpu_lease,
  invalidate_webgpu_lease: mocks.invalidate_webgpu_lease,
}))

vi.mock(`$lib/structure/gpu/large-system-renderer`, () => ({
  create_large_system_renderer: mocks.create_large_system_renderer,
}))

import LargeSystemOverlay from '$lib/structure/gpu/LargeSystemOverlay.svelte'

const VIEWPORT = { width: 960, height: 640 }
const ROTATION: [number, number, number] = [0.37, -0.52, 0.81]
const PIVOT: [number, number, number] = [1.3, -0.8, 2.2]
const LATTICE: [
  [number, number, number],
  [number, number, number],
  [number, number, number],
] = [
  [4.2, 0.3, 0.1],
  [1.1, 3.7, 0.4],
  [0.2, 1.2, 5.1],
]

const mounted: object[] = []
let raf_callbacks = new Map<number, FrameRequestCallback>()
let next_raf_id = 1
let frame_time = 0

function make_structure(): AnyStructure {
  return {
    sites: [
      {
        species: [{ element: `C`, occu: 1 }],
        abc: [0.12, 0.21, 0.31],
        xyz: [1.2, -0.4, 2.1],
        label: `C`,
        properties: {},
      },
      {
        species: [{ element: `O`, occu: 1 }],
        abc: [0.43, 0.37, 0.18],
        xyz: [-0.7, 1.8, 0.6],
        label: `O`,
        properties: {},
      },
      {
        species: [{ element: `N`, occu: 1 }],
        abc: [0.71, 0.14, 0.52],
        xyz: [2.6, 0.9, -1.3],
        label: `N`,
        properties: {},
      },
    ],
    lattice: {
      matrix: LATTICE,
      pbc: [true, true, true],
      a: Math.hypot(...LATTICE[0]),
      b: Math.hypot(...LATTICE[1]),
      c: Math.hypot(...LATTICE[2]),
      alpha: 80,
      beta: 75,
      gamma: 70,
      volume: 75,
    },
  } as unknown as AnyStructure
}

function make_visual_source(is_ortho: boolean) {
  const background_linear: [number, number, number] = [0, 0, 0]
  return {
    revision: 1,
    resolve: () => ({
      render_style_source: `glossy` as const,
      shading: {
        light_dir: [0, 0, 1] as [number, number, number],
        is_ortho,
        ambient: 0.4,
        directional: 0.6,
        spec_strength: 0.5,
        roughness: 0.2,
        metalness: 0,
        render_style: 0 as const,
        outline: 0,
        bond_outline: 0,
        depth_cueing: 0,
        depth_near: 0,
        depth_far: 1,
        depth_bg: background_linear,
        toon_shadow_threshold: 0.3,
        toon_highlight_threshold: 0.97,
        toon_shadow_brightness: 0.5,
      },
      background_linear,
      atom_colors_linear: new Float32Array([
        1, 0, 0,
        0, 1, 0,
        0, 0, 1,
      ]),
      view_transform: resolve_view_transform(ROTATION, PIVOT),
    }),
  }
}

function make_camera(kind: `perspective` | `orthographic`): Camera {
  const aspect = VIEWPORT.width / VIEWPORT.height
  const camera = kind === `perspective`
    ? new PerspectiveCamera(47, aspect, 0.1, 200)
    : new OrthographicCamera(-7.5 * aspect, 7.5 * aspect, 7.5, -7.5, -100, 200)
  camera.position.set(9, -12, 8)
  camera.up.set(0, 0, 1)
  camera.lookAt(new Vector3(1.1, 0.4, 0.8))
  camera.updateProjectionMatrix()
  camera.updateMatrixWorld(true)
  return camera
}

function make_legacy_inner_group(): Group {
  const outer = new Group()
  const rotated = new Group()
  const inner = new Group()
  outer.position.fromArray(PIVOT)
  rotated.rotation.set(...ROTATION)
  inner.position.set(-PIVOT[0], -PIVOT[1], -PIVOT[2])
  outer.add(rotated)
  rotated.add(inner)
  outer.updateMatrixWorld(true)
  return inner
}

function packet_position(packet: RenderPacket, site_idx: number): Vector3 {
  const offset = site_idx * 3
  return new Vector3(
    packet.frame.positions[offset],
    packet.frame.positions[offset + 1],
    packet.frame.positions[offset + 2],
  )
}

function translated_position(
  xyz: readonly [number, number, number],
  jimage: readonly [number, number, number],
): Vector3 {
  return new Vector3(...xyz)
    .addScaledVector(new Vector3(...LATTICE[0]), jimage[0])
    .addScaledVector(new Vector3(...LATTICE[1]), jimage[1])
    .addScaledVector(new Vector3(...LATTICE[2]), jimage[2])
}

function overlay_bond_endpoint(
  packet: RenderPacket,
  site_idx: number,
  jimage: readonly [number, number, number],
): Vector3 {
  const lattice = packet.frame.lattice
  return packet_position(packet, site_idx)
    .addScaledVector(new Vector3(lattice[0], lattice[1], lattice[2]), jimage[0])
    .addScaledVector(new Vector3(lattice[3], lattice[4], lattice[5]), jimage[1])
    .addScaledVector(new Vector3(lattice[6], lattice[7], lattice[8]), jimage[2])
}

function screen_position(world: Vector3, camera: Camera): Vector3 {
  const ndc = world.clone().project(camera)
  return new Vector3(
    (ndc.x + 1) * VIEWPORT.width * 0.5,
    (1 - ndc.y) * VIEWPORT.height * 0.5,
    ndc.z,
  )
}

function expect_same_center(
  legacy_world: Vector3,
  overlay_world: Vector3,
  camera: Camera,
): void {
  expect(overlay_world.distanceTo(legacy_world)).toBeLessThan(2e-5)
  const legacy_screen = screen_position(legacy_world, camera)
  const overlay_screen = screen_position(overlay_world, camera)
  expect(Math.hypot(
    overlay_screen.x - legacy_screen.x,
    overlay_screen.y - legacy_screen.y,
  )).toBeLessThan(0.1)
}

async function settle(): Promise<void> {
  flushSync()
  await tick()
  await Promise.resolve()
  await tick()
  flushSync()
}

function run_overlay_frame(): void {
  const entry = [...raf_callbacks.entries()].find(([, callback]) =>
    callback.name === `frame`
  )
  expect(entry, `expected one queued LargeSystemOverlay frame`).toBeDefined()
  const [id, callback] = entry!
  raf_callbacks.delete(id)
  frame_time += 16
  callback(frame_time)
  flushSync()
}

function last_packet(): RenderPacket {
  const call = mocks.renderer.set_packet.mock.calls.at(-1)
  expect(call).toBeDefined()
  return call![0] as RenderPacket
}

beforeEach(() => {
  document.body.innerHTML = ``
  raf_callbacks = new Map()
  next_raf_id = 1
  frame_time = 0
  for (const mock of Object.values(mocks.renderer)) mock.mockClear()
  mocks.renderer.set_shading.mockReturnValue(false)
  mocks.create_large_system_renderer.mockClear()
  mocks.get_webgpu_lease.mockClear()
  mocks.invalidate_webgpu_lease.mockClear()
  vi.stubGlobal(
    `requestAnimationFrame`,
    vi.fn((callback: FrameRequestCallback) => {
      const id = next_raf_id++
      raf_callbacks.set(id, callback)
      return id
    }),
  )
  vi.stubGlobal(
    `cancelAnimationFrame`,
    vi.fn((id: number) => raf_callbacks.delete(id)),
  )
})

afterEach(async () => {
  while (mounted.length > 0) await unmount(mounted.pop()!)
  vi.unstubAllGlobals()
})

describe.each([`perspective`, `orthographic`] as const)(
  `LargeSystem HOME center parity with %s camera`,
  (camera_kind) => {
    it(`matches legacy Three atom centers and common bond endpoints`, async () => {
      const structure = make_structure()
      const camera = make_camera(camera_kind)
      const component = mount(LargeSystemOverlay, {
        target: document.body,
        props: {
          enabled: true,
          camera,
          structure,
          visual_state_source: make_visual_source(camera_kind === `orthographic`),
          supercell: [1, 1, 1],
          show_image_atoms: false,
          show_bonds: `never`,
        },
      })
      mounted.push(component)
      await settle()
      run_overlay_frame()

      const packet = last_packet()
      const legacy_group = make_legacy_inner_group()
      expect(packet.topology.atom_count).toBe(structure.sites.length)
      expect(packet.frame.positions).toHaveLength(structure.sites.length * 3)

      for (let site_idx = 0; site_idx < structure.sites.length; site_idx++) {
        const legacy_world = new Vector3(...structure.sites[site_idx].xyz)
          .applyMatrix4(legacy_group.matrixWorld)
        expect_same_center(
          legacy_world,
          packet_position(packet, site_idx),
          camera,
        )
      }

      const common_bonds = [
        { a: 0, b: 2, jimage: [0, 0, 0] as const },
        { a: 0, b: 1, jimage: [1, -1, 1] as const },
      ]
      for (const { a, b, jimage } of common_bonds) {
        const legacy_a = new Vector3(...structure.sites[a].xyz)
          .applyMatrix4(legacy_group.matrixWorld)
        const legacy_b = translated_position(structure.sites[b].xyz, jimage)
          .applyMatrix4(legacy_group.matrixWorld)
        expect_same_center(legacy_a, packet_position(packet, a), camera)
        expect_same_center(
          legacy_b,
          overlay_bond_endpoint(packet, b, jimage),
          camera,
        )
      }

      const uploaded_camera = mocks.renderer.set_camera_full.mock.calls.at(-1)?.[0]
      expect(Array.from(uploaded_camera as Float32Array)).toEqual(
        Array.from(pack_camera_full(camera)),
      )
    })
  },
)

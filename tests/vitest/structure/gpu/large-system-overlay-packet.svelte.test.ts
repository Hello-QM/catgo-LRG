import type { AnyStructure } from '$lib'
import { flushSync, mount, tick, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolve_atom_colors_linear } from '$lib/structure/rendering/atom-colors'
import type { RenderPacket } from '$lib/structure/scene/render-packet'

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

const mounted: object[] = []
let raf_callbacks = new Map<number, FrameRequestCallback>()
let next_raf_id = 1
let frame_time = 0

function make_structure(): AnyStructure {
  return {
    sites: [
      {
        species: [{ element: `C`, occu: 1 }],
        abc: [0.1, 0, 0],
        xyz: [1, 0, 0],
        properties: {},
      },
      {
        species: [{ element: `O`, occu: 1 }],
        abc: [0, 0.1, 0],
        xyz: [0, 1, 0],
        properties: {},
      },
    ],
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

function run_until_sleep(): void {
  for (let idx = 0; idx < 40; idx++) {
    const has_overlay_frame = [...raf_callbacks.values()].some((callback) =>
      callback.name === `frame`
    )
    if (!has_overlay_frame) return
    run_overlay_frame()
  }
  throw new Error(`LargeSystemOverlay did not suspend after 40 stable frames`)
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

describe(`LargeSystemOverlay authoritative packet bridge`, () => {
  it(`defers set_packet until an exact authoritative base color buffer is ready`, async () => {
    const props = $state({
      enabled: true,
      structure: make_structure(),
      resolved_atom_colors: null as Float32Array | null,
      rotation: [0, 0, 0] as [number, number, number],
      show_bonds: `never` as const,
    })
    const component = mount(LargeSystemOverlay, {
      target: document.body,
      props,
    })
    mounted.push(component)
    await settle()

    run_overlay_frame()
    expect(mocks.renderer.set_packet).not.toHaveBeenCalled()

    props.resolved_atom_colors = new Float32Array(7)
    await settle()
    run_overlay_frame()
    expect(mocks.renderer.set_packet).not.toHaveBeenCalled()

    props.resolved_atom_colors = new Float32Array([1, 0, 0])
    await settle()
    run_overlay_frame()
    expect(mocks.renderer.set_packet).not.toHaveBeenCalled()

    const authoritative = new Float32Array([
      0.1, 0.2, 0.3,
      0.4, 0.5, 0.6,
    ])
    props.resolved_atom_colors = authoritative
    await settle()
    run_overlay_frame()

    expect(mocks.renderer.set_packet).toHaveBeenCalledTimes(1)
    expect(last_packet().topology.colors).toBe(authoritative)

    const confirmed = last_packet()
    props.resolved_atom_colors = null
    props.rotation = [0, 0, Math.PI / 4]
    await settle()
    run_overlay_frame()
    expect(mocks.renderer.set_packet).toHaveBeenCalledTimes(1)
    expect(last_packet()).toBe(confirmed)

    props.resolved_atom_colors = new Float32Array([0.9, 0.8, 0.7])
    props.rotation = [0, 0, Math.PI / 2]
    await settle()
    run_overlay_frame()
    expect(mocks.renderer.set_packet).toHaveBeenCalledTimes(1)
    expect(last_packet()).toBe(confirmed)

    props.resolved_atom_colors = new Float32Array(7)
    props.rotation = [0, 0, Math.PI]
    await settle()
    run_overlay_frame()
    expect(mocks.renderer.set_packet).toHaveBeenCalledTimes(1)
    expect(last_packet()).toBe(confirmed)
  })

  it(`wakes from a suspended RAF loop and publishes a new frame revision on rotation`, async () => {
    const colors = new Float32Array([1, 0, 0, 0, 1, 0])
    const props = $state({
      enabled: true,
      structure: make_structure(),
      resolved_atom_colors: colors,
      rotation: [0, 0, 0] as [number, number, number],
      rotation_target: [0, 0, 0] as [number, number, number],
      show_bonds: `never` as const,
    })
    const component = mount(LargeSystemOverlay, {
      target: document.body,
      props,
    })
    mounted.push(component)
    await settle()
    run_overlay_frame()
    const first = last_packet()
    run_until_sleep()

    expect(
      [...raf_callbacks.values()].some((callback) => callback.name === `frame`),
    ).toBe(false)

    props.rotation = [0, 0, Math.PI / 2]
    await settle()
    expect(
      [...raf_callbacks.values()].some((callback) => callback.name === `frame`),
    ).toBe(true)
    run_overlay_frame()

    const rotated = last_packet()
    expect(mocks.renderer.set_packet).toHaveBeenCalledTimes(2)
    expect(rotated.frame.positions_version).toBeGreaterThan(
      first.frame.positions_version,
    )
    expect(rotated.frame.positions[0]).toBeCloseTo(0, 5)
    expect(rotated.frame.positions[1]).toBeCloseTo(1, 5)
    expect(rotated.frame.positions[2]).toBeCloseTo(0, 5)
  })

  it(`keeps trajectory and rotation packet revisions strictly monotonic`, async () => {
    const props = $state({
      enabled: true,
      structure: make_structure(),
      resolved_atom_colors: new Float32Array([1, 0, 0, 0, 1, 0]),
      frame_positions: new Float32Array([1, 0, 0, 0, 1, 0]),
      trajectory_positions_version: { v: 1, all: true },
      trajectory_step_idx: 0,
      rotation: [0, 0, 0] as [number, number, number],
      rotation_target: [0, 0, 0] as [number, number, number],
      show_bonds: `never` as const,
    })
    const component = mount(LargeSystemOverlay, {
      target: document.body,
      props,
    })
    mounted.push(component)
    await settle()
    run_overlay_frame()
    const revisions = [last_packet().frame.positions_version]

    props.frame_positions = new Float32Array([2, 0, 0, 0, 2, 0])
    props.trajectory_positions_version = { v: 2, all: true }
    props.trajectory_step_idx = 1
    await settle()
    run_overlay_frame()
    revisions.push(last_packet().frame.positions_version)

    props.frame_positions = new Float32Array([3, 0, 0, 0, 3, 0])
    props.trajectory_positions_version = { v: 3, all: true }
    props.trajectory_step_idx = 2
    props.rotation = [0, Math.PI / 4, 0]
    await settle()
    run_overlay_frame()
    revisions.push(last_packet().frame.positions_version)

    props.rotation = [0, Math.PI / 2, 0]
    await settle()
    run_overlay_frame()
    revisions.push(last_packet().frame.positions_version)

    expect(revisions).toEqual([...revisions].sort((a, b) => a - b))
    expect(new Set(revisions).size).toBe(revisions.length)
    expect(mocks.renderer.set_packet).toHaveBeenCalledTimes(revisions.length)
  })

  it(`puts site, plugin, and property recolors into the shared-base replica packet`, async () => {
    const structure = make_structure()
    const element = resolve_atom_colors_linear({
      sites: structure.sites,
      element_colors: { C: `#ff0000`, O: `#00ff00` },
    })
    const props = $state({
      enabled: true,
      structure,
      resolved_atom_colors: element,
      supercell: [2, 1, 1] as [number, number, number],
      show_image_atoms: true,
      show_bonds: `never` as const,
    })
    const component = mount(LargeSystemOverlay, {
      target: document.body,
      props,
    })
    mounted.push(component)
    await settle()
    run_overlay_frame()
    expect(last_packet().topology.colors).toBe(element)

    const property = resolve_atom_colors_linear({
      sites: structure.sites,
      element_colors: { C: `#ff0000`, O: `#00ff00` },
      property_colors: { colors: [`#0000ff`, `#00ffff`] },
    })
    props.resolved_atom_colors = property
    await settle()
    run_overlay_frame()
    expect(last_packet().topology.colors).toBe(property)

    const plugin = resolve_atom_colors_linear({
      sites: structure.sites,
      element_colors: { C: `#ff0000`, O: `#00ff00` },
      property_colors: { colors: [`#0000ff`, `#00ffff`] },
      plugin_colors: [`#ffff00`, `#ff00ff`],
    })
    props.resolved_atom_colors = plugin
    await settle()
    run_overlay_frame()
    expect(last_packet().topology.colors).toBe(plugin)

    const site = resolve_atom_colors_linear({
      sites: structure.sites,
      element_colors: { C: `#ff0000`, O: `#00ff00` },
      property_colors: { colors: [`#0000ff`, `#00ffff`] },
      plugin_colors: [`#ffff00`, `#ff00ff`],
      site_color_overrides: new Map([[0, `#ffffff`]]),
    })
    const displayed_with_ghost = new Float32Array([
      ...site,
      0.25, 0.5, 0.75,
    ])
    props.resolved_atom_colors = displayed_with_ghost
    await settle()
    run_overlay_frame()

    const packet = last_packet()
    expect(Array.from(packet.topology.colors)).toEqual(Array.from(site))
    expect(packet.topology.colors).toHaveLength(structure.sites.length * 3)
    expect(packet.topology.atom_count).toBe(structure.sites.length)
    expect(packet.replicas.dims).toEqual([2, 1, 1])
    expect(packet.replicas.semantics).toBe(`visual-shared-base`)
    expect(packet.replicas.boundary_policy).toBe(`ghost-images`)
    expect(mocks.renderer.set_packet.mock.calls.at(-1)?.[1]).toMatchObject({
      count: 0,
    })
  })
})

import type { AnyStructure } from '$lib'
import { flushSync, mount, tick, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolve_atom_colors_linear } from '$lib/structure/rendering/atom-colors'
import { resolve_view_transform } from '$lib/structure/rendering/view-transform'
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

function make_visual_source(
  revision: number,
  atom_colors_linear: Float32Array | null,
  rotation: [number, number, number] = [0, 0, 0],
  target: [number, number, number] = [0, 0, 0],
  bond_outline = 0,
) {
  const background_linear: [number, number, number] = [0, 0, 0]
  const resolve = vi.fn(() => ({
    render_style_source: `glossy` as const,
    shading: {
      light_dir: [0, 0, 1] as [number, number, number],
      is_ortho: false,
      ambient: 0.4,
      directional: 0.6,
      spec_strength: 0.5,
      roughness: 0.2,
      metalness: 0,
      render_style: 0 as const,
      outline: 0,
      bond_outline,
      depth_cueing: 0,
      depth_near: 0,
      depth_far: 1,
      depth_bg: background_linear,
      toon_shadow_threshold: 0.3,
      toon_highlight_threshold: 0.97,
      toon_shadow_brightness: 0.5,
    },
    background_linear,
    atom_colors_linear,
    view_transform: resolve_view_transform(rotation, target),
  }))
  return {
    source: {
      revision,
      resolve,
    },
    resolve,
  }
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
  it(`consumes authoritative colors and view transform from one visual snapshot`, async () => {
    const colors = new Float32Array([1, 0, 0, 0, 1, 0])
    const initial = make_visual_source(1, colors)
    const props = $state({
      enabled: true,
      structure: make_structure(),
      visual_state_source: initial.source,
      show_bonds: `never` as const,
      show_cell: true,
    })
    const component = mount(LargeSystemOverlay, {
      target: document.body,
      props,
    })
    mounted.push(component)
    await settle()

    run_overlay_frame()
    expect(initial.resolve).toHaveBeenCalledTimes(1)
    expect(last_packet().topology.colors).toBe(colors)
    const first_revision = last_packet().frame.positions_version
    run_until_sleep()

    const rotated = make_visual_source(
      2,
      colors,
      [0, 0, Math.PI / 2],
      [1, 0, 0],
    )
    props.visual_state_source = rotated.source
    await settle()
    run_overlay_frame()

    expect(rotated.resolve).toHaveBeenCalledTimes(1)
    expect(last_packet().frame.positions_version).toBeGreaterThan(first_revision)
    expect(last_packet().frame.positions[0]).toBeCloseTo(1, 5)
    expect(last_packet().frame.positions[1]).toBeCloseTo(0, 5)
    expect(last_packet().frame.positions[3]).toBeCloseTo(0, 5)
    expect(last_packet().frame.positions[4]).toBeCloseTo(-1, 5)
    expect(last_packet().frame.lattice[0]).toBeCloseTo(0, 5)
    expect(last_packet().frame.lattice[1]).toBeCloseTo(10, 5)
    expect(last_packet().frame.lattice[3]).toBeCloseTo(-10, 5)
    expect(mocks.renderer.set_cell.mock.calls.at(-1)?.[3]).toEqual(
      expect.arrayContaining([
        expect.closeTo(1, 5),
        expect.closeTo(-1, 5),
        expect.closeTo(0, 5),
      ]),
    )
  })

  it(`defers set_packet until an exact authoritative base color buffer is ready`, async () => {
    let revision = 1
    const props = $state({
      enabled: true,
      structure: make_structure(),
      visual_state_source: make_visual_source(revision, null).source,
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

    props.visual_state_source = make_visual_source(
      ++revision,
      new Float32Array(7),
    ).source
    await settle()
    run_overlay_frame()
    expect(mocks.renderer.set_packet).not.toHaveBeenCalled()

    props.visual_state_source = make_visual_source(
      ++revision,
      new Float32Array([1, 0, 0]),
    ).source
    await settle()
    run_overlay_frame()
    expect(mocks.renderer.set_packet).not.toHaveBeenCalled()

    const authoritative = new Float32Array([
      0.1, 0.2, 0.3,
      0.4, 0.5, 0.6,
    ])
    props.visual_state_source = make_visual_source(
      ++revision,
      authoritative,
    ).source
    await settle()
    run_overlay_frame()

    expect(mocks.renderer.set_packet).toHaveBeenCalledTimes(1)
    expect(last_packet().topology.colors).toBe(authoritative)

    const confirmed = last_packet()
    props.visual_state_source = make_visual_source(
      ++revision,
      null,
      [0, 0, Math.PI / 4],
    ).source
    await settle()
    run_overlay_frame()
    expect(mocks.renderer.set_packet).toHaveBeenCalledTimes(1)
    expect(last_packet()).toBe(confirmed)

    props.visual_state_source = make_visual_source(
      ++revision,
      new Float32Array([0.9, 0.8, 0.7]),
      [0, 0, Math.PI / 2],
    ).source
    await settle()
    run_overlay_frame()
    expect(mocks.renderer.set_packet).toHaveBeenCalledTimes(1)
    expect(last_packet()).toBe(confirmed)

    props.visual_state_source = make_visual_source(
      ++revision,
      new Float32Array(7),
      [0, 0, Math.PI],
    ).source
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
      visual_state_source: make_visual_source(1, colors).source,
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

    props.visual_state_source = make_visual_source(
      2,
      colors,
      [0, 0, Math.PI / 2],
    ).source
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

  it(`wakes a suspended RAF loop exactly once for a bond-outline-only revision`, async () => {
    const colors = new Float32Array([1, 0, 0, 0, 1, 0])
    const props = $state({
      enabled: true,
      structure: make_structure(),
      visual_state_source: make_visual_source(1, colors).source,
      show_bonds: `never` as const,
    })
    const component = mount(LargeSystemOverlay, {
      target: document.body,
      props,
    })
    mounted.push(component)
    await settle()
    run_overlay_frame()
    run_until_sleep()

    mocks.renderer.set_shading.mockClear()
    props.visual_state_source = make_visual_source(
      2,
      colors,
      [0, 0, 0],
      [0, 0, 0],
      0.65,
    ).source
    await settle()

    const overlay_frames = [...raf_callbacks.values()].filter((callback) =>
      callback.name === `frame`
    )
    expect(overlay_frames).toHaveLength(1)
    run_overlay_frame()
    expect(mocks.renderer.set_shading).toHaveBeenCalledTimes(1)
    expect(mocks.renderer.set_shading).toHaveBeenCalledWith(
      expect.objectContaining({ outline: 0, bond_outline: 0.65 }),
    )
  })

  it(`wakes once and syncs ghost atom and bond opacity after sleep`, async () => {
    const colors = new Float32Array([1, 0, 0, 0, 1, 0])
    const props = $state({
      enabled: true,
      structure: make_structure(),
      visual_state_source: make_visual_source(1, colors).source,
      image_atom_opacity: 0.2,
      show_bonds: `always` as const,
      show_image_atoms: true,
    })
    const component = mount(LargeSystemOverlay, {
      target: document.body,
      props,
    })
    mounted.push(component)
    await settle()
    run_overlay_frame()
    expect(mocks.renderer.set_ghost_opacity).toHaveBeenCalledOnce()
    expect(mocks.renderer.set_ghost_opacity).toHaveBeenLastCalledWith(0.2)
    run_until_sleep()

    mocks.renderer.set_ghost_opacity.mockClear()
    mocks.renderer.set_bond_style.mockClear()
    mocks.renderer.render.mockClear()
    props.image_atom_opacity = 0.65
    await settle()

    const overlay_frames = [...raf_callbacks.values()].filter((callback) =>
      callback.name === `frame`
    )
    expect(overlay_frames).toHaveLength(1)
    run_overlay_frame()
    expect(mocks.renderer.set_ghost_opacity).toHaveBeenCalledTimes(1)
    expect(mocks.renderer.set_ghost_opacity).toHaveBeenCalledWith(0.65)
    expect(mocks.renderer.set_bond_style).toHaveBeenCalledTimes(1)
    expect(mocks.renderer.set_bond_style).toHaveBeenCalledWith(
      expect.objectContaining({ periodic_bond_opacity: 0.65 }),
    )
    expect(mocks.renderer.render).toHaveBeenCalledTimes(1)
  })

  it(`keeps trajectory and rotation packet revisions strictly monotonic`, async () => {
    const colors = new Float32Array([1, 0, 0, 0, 1, 0])
    const props = $state({
      enabled: true,
      structure: make_structure(),
      visual_state_source: make_visual_source(1, colors).source,
      frame_positions: new Float32Array([1, 0, 0, 0, 1, 0]),
      trajectory_positions_version: { v: 1, all: true },
      trajectory_step_idx: 0,
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
    props.visual_state_source = make_visual_source(2, colors).source
    await settle()
    run_overlay_frame()
    revisions.push(last_packet().frame.positions_version)

    props.frame_positions = new Float32Array([3, 0, 0, 0, 3, 0])
    props.trajectory_positions_version = { v: 3, all: true }
    props.trajectory_step_idx = 2
    props.visual_state_source = make_visual_source(
      3,
      colors,
      [0, Math.PI / 4, 0],
    ).source
    await settle()
    run_overlay_frame()
    revisions.push(last_packet().frame.positions_version)

    props.visual_state_source = make_visual_source(
      4,
      colors,
      [0, Math.PI / 2, 0],
    ).source
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
      visual_state_source: make_visual_source(1, element).source,
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
    props.visual_state_source = make_visual_source(2, property).source
    await settle()
    run_overlay_frame()
    expect(last_packet().topology.colors).toBe(property)

    const plugin = resolve_atom_colors_linear({
      sites: structure.sites,
      element_colors: { C: `#ff0000`, O: `#00ff00` },
      property_colors: { colors: [`#0000ff`, `#00ffff`] },
      plugin_colors: [`#ffff00`, `#ff00ff`],
    })
    props.visual_state_source = make_visual_source(3, plugin).source
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
    props.visual_state_source = make_visual_source(
      4,
      displayed_with_ghost,
    ).source
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

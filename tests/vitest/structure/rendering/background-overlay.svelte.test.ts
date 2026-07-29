import { flushSync, mount, tick, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolve_view_transform } from '$lib/structure/rendering/view-transform'

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
let raf_callbacks: FrameRequestCallback[] = []
let next_raf_id = 1

beforeEach(() => {
  raf_callbacks = []
  next_raf_id = 1
  for (const mock of Object.values(mocks.renderer)) mock.mockClear()
  mocks.renderer.set_shading.mockReturnValue(false)
  mocks.create_large_system_renderer.mockClear()
  mocks.get_webgpu_lease.mockClear()
  mocks.invalidate_webgpu_lease.mockClear()
  vi.stubGlobal(
    `requestAnimationFrame`,
    vi.fn((callback: FrameRequestCallback) => {
      raf_callbacks.push(callback)
      return next_raf_id++
    }),
  )
  vi.stubGlobal(`cancelAnimationFrame`, vi.fn())
})

afterEach(async () => {
  while (mounted.length > 0) await unmount(mounted.pop()!)
  vi.unstubAllGlobals()
})

describe(`LargeSystemOverlay shared visual snapshot`, () => {
  it(`reads one queued-frame snapshot and forwards its exact background to both adapters`, async () => {
    const background_linear: [number, number, number] = [0.0123, 0.2345, 0.4567]
    const snapshot = {
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
        bond_outline: 0,
        depth_cueing: 1,
        depth_near: 2,
        depth_far: 8,
        depth_bg: background_linear,
        toon_shadow_threshold: 0.3,
        toon_highlight_threshold: 0.97,
        toon_shadow_brightness: 0.5,
      },
      background_linear,
      atom_colors_linear: null,
      view_transform: resolve_view_transform(null, null),
    }
    const resolve = vi.fn(() => snapshot)

    const component = mount(LargeSystemOverlay, {
      target: document.body,
      props: {
        enabled: true,
        visual_state_source: {
          revision: 1,
          resolve,
        },
      },
    })
    mounted.push(component)
    flushSync()
    await tick()
    await Promise.resolve()
    await tick()

    expect(mocks.create_large_system_renderer).toHaveBeenCalledTimes(1)
    expect(resolve).not.toHaveBeenCalled()

    // Svelte's runtime also queues private rAF work in this environment. Select
    // the overlay's named frame callback so this test advances exactly one
    // production render frame and no framework animation bookkeeping.
    const overlay_frames = raf_callbacks.filter((callback) => callback.name === `frame`)
    expect(overlay_frames).toHaveLength(1)
    overlay_frames[0](16)

    expect(resolve).toHaveBeenCalledTimes(1)
    expect(mocks.renderer.set_background).toHaveBeenCalledTimes(1)
    expect(mocks.renderer.set_shading).toHaveBeenCalledTimes(1)
    expect(mocks.renderer.set_background.mock.calls[0][0]).toBe(background_linear)
    expect(mocks.renderer.set_shading.mock.calls[0][0]).toBe(snapshot.shading)
    expect(mocks.renderer.render).toHaveBeenCalledTimes(1)
  })
})

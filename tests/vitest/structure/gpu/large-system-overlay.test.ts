import type {
  ResolvedVisualState,
  VisualStateSource,
} from '$lib/structure/rendering/visual-state'
import { resolve_view_transform } from '$lib/structure/rendering/view-transform'
import { readFileSync } from 'node:fs'
import { resolve as resolve_path } from 'node:path'
import { createSubscriber } from 'svelte/reactivity'
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
import OverlayHarness from './large-system-overlay-harness.svelte'

const mounted: object[] = []
let raf_callbacks = new Map<number, FrameRequestCallback>()
let next_raf_id = 1
let frame_time = 0

function make_state(
  render_style: 0 | 1 | 2 = 0,
  overrides: Partial<ResolvedVisualState[`shading`]> = {},
): ResolvedVisualState {
  const background_linear: [number, number, number] = [0.0123, 0.2345, 0.4567]
  return {
    shading: {
      light_dir: [0, 0, 1],
      is_ortho: false,
      ambient: 0.4,
      directional: 0.6,
      spec_strength: 0.5,
      roughness: 0.2,
      metalness: 0,
      render_style,
      outline: 0,
      depth_cueing: 1,
      depth_near: 2,
      depth_far: 8,
      depth_bg: background_linear,
      toon_shadow_threshold: 0.3,
      toon_highlight_threshold: 0.97,
      toon_shadow_brightness: 0.5,
      ...overrides,
    },
    background_linear,
    atom_colors_linear: null,
    view_transform: resolve_view_transform(null, null),
  }
}

function make_source(initial_revision: number, initial_state: ResolvedVisualState) {
  let revision = initial_revision
  let state = initial_state
  let notify = () => {}
  const subscribe = createSubscriber((update) => {
    notify = update
    return () => {
      notify = () => {}
    }
  })
  const resolve = vi.fn(() => state)
  const source: VisualStateSource = {
    get revision() {
      subscribe()
      return revision
    },
    resolve,
  }
  return {
    source,
    resolve,
    publish(next_revision: number, next_state: ResolvedVisualState): void {
      revision = next_revision
      state = next_state
      notify()
    },
    update_camera_state(next_state: ResolvedVisualState): void {
      state = next_state
    },
  }
}

function pending_overlay_frames(): [number, FrameRequestCallback][] {
  return [...raf_callbacks].filter(([, callback]) => callback.name === `frame`)
}

function run_overlay_frame(): void {
  const next = pending_overlay_frames()[0]
  expect(next).toBeDefined()
  raf_callbacks.delete(next[0])
  frame_time += 16
  next[1](frame_time)
}

function drain_overlay_to_sleep(): number {
  let frames = 0
  while (pending_overlay_frames().length > 0) {
    expect(frames++).toBeLessThan(64)
    run_overlay_frame()
  }
  return frames
}

async function settle_mount(): Promise<void> {
  flushSync()
  await tick()
  await Promise.resolve()
  await tick()
  flushSync()
}

beforeEach(() => {
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
    vi.fn((id: number) => {
      raf_callbacks.delete(id)
    }),
  )
})

afterEach(async () => {
  while (mounted.length > 0) await unmount(mounted.pop()!)
  vi.unstubAllGlobals()
})

describe(`LargeSystemOverlay revision-bearing visual source`, () => {
  it(`wakes a sleeping loop once, resolves once, and uploads the next snapshot`, async () => {
    const visual = make_source(1, make_state(0))
    const component = mount(LargeSystemOverlay, {
      target: document.body,
      props: {
        enabled: true,
        visual_state_source: visual.source,
      },
    })
    mounted.push(component)
    await settle_mount()
    drain_overlay_to_sleep()

    expect(pending_overlay_frames()).toHaveLength(0)
    visual.resolve.mockClear()
    mocks.renderer.set_background.mockClear()
    mocks.renderer.set_shading.mockClear()
    mocks.renderer.render.mockClear()

    const toon = make_state(2)
    visual.publish(2, toon)
    flushSync()

    expect(pending_overlay_frames()).toHaveLength(1)
    run_overlay_frame()

    expect(visual.resolve).toHaveBeenCalledTimes(1)
    expect(mocks.renderer.set_shading).toHaveBeenCalledTimes(1)
    expect(mocks.renderer.set_shading).toHaveBeenCalledWith(toon.shading)
    expect(mocks.renderer.set_background).not.toHaveBeenCalled()
    expect(mocks.renderer.render).toHaveBeenCalledTimes(1)

    expect(drain_overlay_to_sleep()).toBe(24)
    visual.publish(2, toon)
    flushSync()
    expect(pending_overlay_frames()).toHaveLength(0)

    // A distinct semantic revision with an equal snapshot gets one repaint
    // opportunity, but equality suppresses both adapter uploads and the normal
    // 24-stable-frame tail still reaches a fully empty RAF queue.
    mocks.renderer.set_background.mockClear()
    mocks.renderer.set_shading.mockClear()
    visual.publish(3, toon)
    flushSync()
    expect(pending_overlay_frames()).toHaveLength(1)
    run_overlay_frame()
    expect(mocks.renderer.set_background).not.toHaveBeenCalled()
    expect(mocks.renderer.set_shading).not.toHaveBeenCalled()
    expect(drain_overlay_to_sleep()).toBe(24)
    expect(pending_overlay_frames()).toHaveLength(0)
  })

  it(`wakes for late source initialization and forwards one shared snapshot`, async () => {
    const component = mount(OverlayHarness, { target: document.body })
    mounted.push(component)
    await settle_mount()
    drain_overlay_to_sleep()

    const visual = make_source(1, make_state(1))
    visual.resolve.mockClear()
    mocks.renderer.set_background.mockClear()
    mocks.renderer.set_shading.mockClear()

    component.publish_visual_source(visual.source)
    flushSync()

    expect(pending_overlay_frames()).toHaveLength(1)
    run_overlay_frame()
    expect(visual.resolve).toHaveBeenCalledTimes(1)
    const snapshot = visual.resolve.mock.results[0].value
    expect(mocks.renderer.set_background.mock.calls[0][0]).toBe(
      snapshot.background_linear,
    )
    expect(mocks.renderer.set_shading.mock.calls[0][0]).toBe(snapshot.shading)
  })

  it(`re-resolves camera-dependent fields on an existing interaction wake`, async () => {
    const visual = make_source(1, make_state(0))
    const component = mount(LargeSystemOverlay, {
      target: document.body,
      props: {
        enabled: true,
        visual_state_source: visual.source,
      },
    })
    mounted.push(component)
    await settle_mount()
    drain_overlay_to_sleep()

    const moved_camera = make_state(0, { depth_near: 5, depth_far: 13 })
    visual.update_camera_state(moved_camera)
    visual.resolve.mockClear()
    mocks.renderer.set_shading.mockClear()
    window.dispatchEvent(new PointerEvent(`pointermove`))

    expect(pending_overlay_frames()).toHaveLength(1)
    run_overlay_frame()
    expect(visual.resolve).toHaveBeenCalledTimes(1)
    expect(mocks.renderer.set_shading).toHaveBeenCalledWith(moved_camera.shading)
  })
})

describe(`visual source ownership and wiring`, () => {
  it(`publishes theme revisions in StructureScene and passes only the source to the overlay`, () => {
    const scene = readFileSync(
      resolve_path(`src/lib/structure/StructureScene.svelte`),
      `utf8`,
    )
    const structure = readFileSync(
      resolve_path(`src/lib/structure/Structure.svelte`),
      `utf8`,
    )
    const overlay = readFileSync(
      resolve_path(`src/lib/structure/gpu/LargeSystemOverlay.svelte`),
      `utf8`,
    )

    expect(scene).toContain(`visual_state_source = {`)
    expect(scene).toContain(`theme_revision,`)
    const theme_sync = scene.indexOf(
      `sync_clear_color()\n        // Publish only after`,
    )
    const theme_publish = scene.indexOf(`theme_revision += 1`, theme_sync)
    expect(theme_sync).toBeGreaterThan(-1)
    expect(theme_publish).toBeGreaterThan(theme_sync)

    expect(structure).toContain(
      `bind:visual_state_source={scene_visual_state_source}`,
    )
    expect(structure).toContain(
      `visual_state_source={scene_visual_state_source}`,
    )
    expect(overlay).not.toContain(`getComputedStyle`)
    expect(overlay).not.toContain(`background_opacity`)
    expect(overlay).not.toContain(`get_shading`)
  })

  it(`passes one Structure HUD safe-area to both WebGL and WebGPU gizmos`, () => {
    const scene = readFileSync(
      resolve_path(`src/lib/structure/StructureScene.svelte`),
      `utf8`,
    )
    const structure = readFileSync(
      resolve_path(`src/lib/structure/Structure.svelte`),
      `utf8`,
    )

    expect(scene).toContain(`hud_safe = EMPTY_HUD_SAFE_AREA`)
    expect(scene).toContain(`offset: gizmo_dom_offset(hud_safe)`)
    expect(scene).toContain(`var(--structure-gizmo-size)`)
    expect(structure).toContain(`const hud_safe = $derived(`)
    expect(structure).toContain(`style:--structure-gizmo-size={GIZMO_SIZE_CSS}`)
    expect(structure).toContain(`<StructureScene\n            {hud_safe}`)
    expect(structure).toContain(`visual_state_source={scene_visual_state_source}\n            {hud_safe}`)
  })
})

describe(`LargeSystemOverlay gizmo layout`, () => {
  it(`seeds and reactively forwards the same HUD safe-area`, async () => {
    const component = mount(OverlayHarness, { target: document.body })
    mounted.push(component)
    component.publish_hud_safe({ l: 12, r: 2, t: 3, b: 20 })
    await settle_mount()

    expect(mocks.renderer.set_gizmo_layout).toHaveBeenCalledWith({
      safe_left: 12,
      safe_bottom: 20,
    })

    mocks.renderer.set_gizmo_layout.mockClear()
    component.publish_hud_safe({ l: 30, r: 2, t: 3, b: 40 })
    flushSync()

    expect(mocks.renderer.set_gizmo_layout).toHaveBeenCalledTimes(1)
    expect(mocks.renderer.set_gizmo_layout).toHaveBeenCalledWith({
      safe_left: 30,
      safe_bottom: 40,
    })
  })
})

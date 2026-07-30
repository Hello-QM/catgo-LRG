import type { ResolvedVisualState } from '$lib/structure/rendering/visual-state'
import { Color, NoToneMapping, PCFSoftShadowMap, SRGBColorSpace, Vector2 } from 'three'
import { flushSync, mount, tick, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  atom_visual_snapshots,
  combined_visual_snapshots,
  reset_structure_scene_visual_captures,
} from './structure-scene-visual-capture'

const spies = vi.hoisted(() => ({
  apply_webgl_background: vi.fn(),
  resolve_view_transform: vi.fn(),
}))

vi.mock(`$lib/structure/rendering/visual-adapters`, async (import_original) => {
  const original = await import_original<
    typeof import('$lib/structure/rendering/visual-adapters')
  >()
  return {
    ...original,
    apply_webgl_background: (
      ...args: Parameters<typeof original.apply_webgl_background>
    ) => {
      spies.apply_webgl_background(...args)
      return original.apply_webgl_background(...args)
    },
  }
})

vi.mock(`$lib/structure/rendering/view-transform`, async (import_original) => {
  const original = await import_original<
    typeof import('$lib/structure/rendering/view-transform')
  >()
  return {
    ...original,
    resolve_view_transform: (
      ...args: Parameters<typeof original.resolve_view_transform>
    ) => {
      spies.resolve_view_transform(...args)
      return original.resolve_view_transform(...args)
    },
  }
})

vi.mock(`$lib/structure/atoms/AtomManagerInstances.svelte`, async () => ({
  default: (await import(`./structure-scene-atom-capture.svelte`)).default,
}))

vi.mock(`$lib/structure/gpu/WebGLReplicaLayer.svelte`, async () => ({
  default: (await import(`./structure-scene-combined-capture.svelte`)).default,
}))

vi.mock(`$lib/structure/SceneLighting.svelte`, async () => ({
  default: (await import(`./structure-scene-noop.svelte`)).default,
}))

vi.mock(`$lib/structure/ferrox-wasm`, () => ({
  on_ferrox_wasm_ready: () => undefined,
}))

import Harness from './structure-scene-visual-harness.svelte'

const mounted: object[] = []
const roots: HTMLElement[] = []

function make_renderer(canvas: HTMLCanvasElement) {
  return {
    capabilities: { isWebGL2: true },
    domElement: canvas,
    dispose: vi.fn(),
    getDrawingBufferSize: (target: Vector2) => target.set(320, 240),
    outputColorSpace: SRGBColorSpace,
    render: vi.fn(),
    setAnimationLoop: vi.fn(),
    setClearColor: vi.fn(),
    setPixelRatio: vi.fn(),
    setSize: vi.fn(),
    shadowMap: { enabled: false, type: PCFSoftShadowMap },
    toneMapping: NoToneMapping,
  }
}

async function settle(): Promise<void> {
  flushSync()
  await tick()
  await Promise.resolve()
  await tick()
  flushSync()
}

beforeEach(() => {
  reset_structure_scene_visual_captures()
  spies.apply_webgl_background.mockClear()
  spies.resolve_view_transform.mockClear()
})

afterEach(async () => {
  while (mounted.length > 0) await unmount(mounted.pop()!)
  while (roots.length > 0) roots.pop()!.remove()
})

describe(`StructureScene visual snapshot producer`, () => {
  test(`materializes one snapshot per semantic revision for every renderer consumer`, async () => {
    const dom = document.createElement(`div`)
    const canvas = document.createElement(`canvas`)
    dom.append(canvas)
    document.body.append(dom)
    roots.push(dom)
    const renderer = make_renderer(canvas)
    const component = mount(Harness, {
      target: document.body,
      props: { renderer: renderer as never, dom, canvas },
    })
    mounted.push(component)
    await settle()

    const initial_source = component.get_visual_source()
    expect(initial_source).not.toBeNull()
    const initial_snapshot = initial_source!.resolve()
    expect(initial_source!.resolve()).toBe(initial_snapshot)
    expect(spies.apply_webgl_background).toHaveBeenLastCalledWith(
      renderer,
      initial_snapshot,
      expect.any(Color),
    )
    expect(renderer.setClearColor).toHaveBeenLastCalledWith(expect.any(Color), 1)
    expect(atom_visual_snapshots.at(-1)).toBe(initial_snapshot)
    expect(combined_visual_snapshots.at(-1)).toBe(initial_snapshot)

    const initial_revision = initial_source!.revision
    reset_structure_scene_visual_captures()
    spies.apply_webgl_background.mockClear()
    spies.resolve_view_transform.mockClear()
    renderer.setClearColor.mockClear()

    component.publish_toon_revision()
    await settle()

    const next_source = component.get_visual_source()
    expect(next_source).not.toBeNull()
    expect(next_source!.revision).toBe(initial_revision + 1)
    const next_snapshot = next_source!.resolve()
    expect(next_source!.resolve()).toBe(next_snapshot)
    expect(next_snapshot).not.toBe(initial_snapshot)
    expect(next_snapshot.render_style_source).toBe(`toon`)
    expect(spies.resolve_view_transform).toHaveBeenCalledTimes(1)
    expect(spies.apply_webgl_background).toHaveBeenCalledTimes(1)
    expect(spies.apply_webgl_background).toHaveBeenCalledWith(
      renderer,
      next_snapshot,
      expect.any(Color),
    )
    expect(renderer.setClearColor).toHaveBeenCalledTimes(1)
    const clear_color = renderer.setClearColor.mock.calls[0][0] as Color
    expect([clear_color.r, clear_color.g, clear_color.b]).toEqual(
      next_snapshot.background_linear,
    )
    expect(atom_visual_snapshots).toHaveLength(1)
    expect(atom_visual_snapshots[0]).toBe(next_snapshot)
    expect(combined_visual_snapshots).toHaveLength(1)
    expect(combined_visual_snapshots[0]).toBe(next_snapshot)
  })
})

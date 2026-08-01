import type { AnyStructure } from '$lib'
import { flushSync, mount, tick, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock(`@threlte/core`, async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const { default: CanvasCapture } = await import(`./canvas-capture.svelte`)
  return { ...original, Canvas: CanvasCapture }
})

vi.mock(`$lib/structure/ferrox-wasm`, async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return {
    ...original,
    compile_wasm_module: vi.fn(async () => null),
    ensure_ferrox_wasm_ready: vi.fn(async () => null),
  }
})

vi.mock(`$lib/structure/index`, async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const { default: StructureSceneCapture } = await import(
    `./structure-scene-hud-capture.svelte`
  )
  return { ...original, StructureScene: StructureSceneCapture }
})

const mounted: unknown[] = []

beforeEach(() => {
  vi.stubGlobal(`WebGLRenderingContext`, class WebGLRenderingContext {})
})

afterEach(() => {
  while (mounted.length > 0) unmount(mounted.pop() as never)
  document.body.innerHTML = ``
  vi.unstubAllGlobals()
})

const structure = {
  sites: [{
    species: [{ element: `H`, occu: 1 }],
    xyz: [0, 0, 0],
    abc: [0, 0, 0],
    label: `H`,
    properties: {},
  }],
  lattice: {
    matrix: [[4, 0, 0], [0, 4, 0], [0, 0, 4]],
    pbc: [true, true, true],
    a: 4,
    b: 4,
    c: 4,
    alpha: 90,
    beta: 90,
    gamma: 90,
    volume: 64,
  },
} as unknown as AnyStructure

describe(`Structure authoritative HUD safe-area`, () => {
  test(`normalized host insets override a conflicting scene_props value`, async () => {
    const { default: Structure } = await import(`$lib/structure/Structure.svelte`)
    const app = mount(Structure, {
      target: document.body,
      props: {
        structure,
        hud_safe_area: { l: 12, r: -2, t: Number.NaN, b: 20 },
        scene_props: {
          gizmo: true,
          hud_safe: { l: 90, r: 90, t: 90, b: 90 },
        },
      },
    })
    mounted.push(app)
    flushSync()
    await tick()

    await vi.waitFor(() => {
      expect(document.querySelector(
        `[data-testid="structure-scene-hud-capture"]`,
      )).not.toBeNull()
    }, { timeout: 5_000 })
    const capture = document.querySelector<HTMLElement>(
      `[data-testid="structure-scene-hud-capture"]`,
    )
    expect(capture?.dataset).toMatchObject({
      left: `12`,
      right: `0`,
      top: `0`,
      bottom: `20`,
    })
  }, 30_000)
})

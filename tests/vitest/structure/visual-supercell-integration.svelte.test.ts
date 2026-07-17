// Visual T6 — view-only semantics for the viewer's bottom-right visual
// supercell control, plus base scientific export/capture routing.
//
// Contract under test:
// 1. factor 1× → 8× changes ONLY the replica layout — the scientific
//    structure (displayed base frame + saveable) is never CPU-expanded.
// 2. Backend choice (WebGPU overlay vs WebGL2 vs legacy) does not change
//    the scientific structure — renderer mode is OUT of semantic routing.
// 3. PBC images never append sites to the scientific structure.
// 4. Raster capture selects the ACTIVE marked canvas (render-surface.ts).
//
// NOTE filename uses the collected `.svelte.test.ts` convention (the task
// brief's `.test.svelte.ts` would be silently skipped by the vitest include
// glob `tests/vitest/**/*.test.ts`).

import type { AnyStructure } from '$lib'
import { Structure } from '$lib'
import { make_supercell } from '$lib/structure/supercell'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { flushSync, mount, tick, unmount } from 'svelte'
import { beforeEach, describe, expect, test, vi } from 'vitest'

// Deterministic scientific-expansion spy: if ANY code path still routes the
// viewer's visual supercell control into WASM expansion, this returns a real
// expanded structure so the leak becomes observable — and the call count
// itself proves the (forbidden) routing happened.
const create_supercell_spy = vi.fn(
  (structure: AnyStructure, nx: number, ny: number, nz: number) =>
    Promise.resolve({
      ok: make_supercell(structure as never, [nx, ny, nz] as never),
    }),
)

vi.mock(`$lib/structure/ferrox-wasm`, async (importOriginal) => {
  const mod = await importOriginal<Record<string, unknown>>()
  return {
    ...mod,
    create_supercell: (...args: unknown[]) =>
      create_supercell_spy(
        ...(args as [AnyStructure, number, number, number]),
      ),
  }
})

import { create_transform_controller } from '$lib/structure/controllers/transform-controller.svelte'
import { create_render_packet_builder } from '$lib/structure/scene/render-packet-builder'

function make_base(): AnyStructure {
  return {
    sites: [
      {
        species: [{ element: `Na`, occu: 1, oxidation_state: 1 }],
        xyz: [0, 0, 0],
        abc: [0, 0, 0],
        label: `Na`,
        properties: {},
      },
      {
        species: [{ element: `Cl`, occu: 1, oxidation_state: -1 }],
        xyz: [2, 2, 2],
        abc: [0.5, 0.5, 0.5],
        label: `Cl`,
        properties: {},
      },
    ],
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
}

async function settle(): Promise<void> {
  // Let effect flushes and any (forbidden) async expansion promise land.
  flushSync()
  await tick()
  await Promise.resolve()
  await Promise.resolve()
  flushSync()
}

// ─── transform controller: view-only visual replication ───

type ControllerHandle = {
  get_displayed: () => AnyStructure | undefined
  get_saveable: () => AnyStructure | undefined
  cleanup: () => void
}

function run_controller(opts: {
  base: AnyStructure
  get_scaling: () => string
  get_replicas_active: () => boolean
  get_show_image_atoms?: () => boolean
  get_repeats?: () => [number, number, number]
}): ControllerHandle {
  let displayed = $state<AnyStructure | undefined>(undefined)
  let saveable = $state<AnyStructure | undefined>(undefined)
  const cleanup = $effect.root(() => {
    create_transform_controller({
      get_structure: () => opts.base,
      get_symmetry_data: () => null,
      get_cell_type: () => `original`,
      // Legacy dep name (pre-T6) — a view-only controller must ignore it.
      // Kept in the deps object so the RED run exercises the old routing.
      get_supercell_scaling: opts.get_scaling,
      get_show_image_atoms: opts.get_show_image_atoms ?? (() => false),
      get_periodic_repeats: opts.get_repeats ?? (() => [0, 0, 0]),
      get_visual_replicas_active: opts.get_replicas_active,
      set_displayed_structure: (s) => {
        displayed = s
      },
      set_saveable_structure: (s) => {
        saveable = s
      },
    } as never)
  })
  return {
    get_displayed: () => displayed,
    get_saveable: () => saveable,
    cleanup,
  }
}

describe(`Visual T6 — transform controller is view-only`, () => {
  beforeEach(() => {
    create_supercell_spy.mockClear()
  })

  test(`factor 1→8 never mutates the scientific structure (no CPU expansion)`, async () => {
    const base = make_base()
    let scaling = $state(`1x1x1`)
    const ctl = run_controller({
      base,
      get_scaling: () => scaling,
      get_replicas_active: () => scaling !== `1x1x1`,
    })
    await settle()
    expect(ctl.get_saveable()?.sites).toHaveLength(2)

    scaling = `2x2x2`
    await settle()

    // The bottom-right control builds ONLY a ReplicaLayout — never a
    // scientific supercell.
    expect(create_supercell_spy).not.toHaveBeenCalled()
    expect(ctl.get_saveable()?.sites).toHaveLength(2)
    expect(ctl.get_displayed()?.sites).toHaveLength(2)
    expect(base.sites).toHaveLength(2)
    ctl.cleanup()
  })

  test(`backend/replica-path flips never change the scientific structure`, async () => {
    // Pre-T6, flipping the WebGPU overlay OFF at >1× re-routed the SAME dims
    // into CPU/WASM scientific expansion — the backend changed the science.
    const base = make_base()
    let replicas_active = $state(true)
    const ctl = run_controller({
      base,
      get_scaling: () => `2x2x2`,
      get_replicas_active: () => replicas_active,
    })
    await settle()
    expect(ctl.get_saveable()?.sites).toHaveLength(2)

    replicas_active = false // e.g. WebGPU device loss → WebGL2/legacy path
    await settle()
    expect(create_supercell_spy).not.toHaveBeenCalled()
    expect(ctl.get_saveable()?.sites).toHaveLength(2)
    expect(ctl.get_displayed()?.sites).toHaveLength(2)

    replicas_active = true
    await settle()
    expect(ctl.get_saveable()?.sites).toHaveLength(2)
    ctl.cleanup()
  })

  test(`PBC images decorate the DISPLAYED structure only, never the scientific one`, async () => {
    const base = make_base()
    const ctl = run_controller({
      base,
      get_scaling: () => `1x1x1`,
      get_replicas_active: () => false,
      get_show_image_atoms: () => true,
      get_repeats: () => [1, 1, 1],
    })
    await settle()
    // Legacy 1× display path may append ghost image sites for rendering…
    expect((ctl.get_displayed()?.sites.length ?? 0)).toBeGreaterThan(2)
    // …but the scientific structure never grows.
    expect(ctl.get_saveable()?.sites).toHaveLength(2)
    expect(base.sites).toHaveLength(2)
    ctl.cleanup()
  })

  test(`PBC images are packet (ghost) concerns while replicas are active`, async () => {
    const base = make_base()
    const ctl = run_controller({
      base,
      get_scaling: () => `2x2x2`,
      get_replicas_active: () => true,
      get_show_image_atoms: () => true,
      get_repeats: () => [1, 1, 1],
    })
    await settle()
    expect(ctl.get_displayed()?.sites).toHaveLength(2)
    expect(ctl.get_saveable()?.sites).toHaveLength(2)
    ctl.cleanup()
  })
})

// ─── replica layout: the ONLY thing a factor change may touch ───

describe(`Visual T6 — factor changes touch only the ReplicaLayout`, () => {
  test(`dims 1×→2×2×2 reuses topology+frame, swaps replicas`, () => {
    const base = make_base()
    const builder = create_render_packet_builder()
    const p1 = builder.build({ structure: base, dims: [1, 1, 1] })
    const p8 = builder.build({ structure: base, dims: [2, 2, 2] })
    expect(p8.topology).toBe(p1.topology)
    expect(p8.frame).toBe(p1.frame)
    expect(p8.replicas).not.toBe(p1.replicas)
    expect(Array.from(p8.replicas.dims)).toEqual([2, 2, 2])
    expect(p8.replicas.semantics).toBe(`visual-shared-base`)
    // Base scientific frame stays exactly N sites — replication is instancing.
    expect(p8.topology.atom_count).toBe(2)
    expect(p8.frame.positions).toHaveLength(6)
  })
})

// ─── mounted viewer: production wiring ───

describe(`Visual T6 — mounted Structure keeps scientific structure at base`, () => {
  beforeEach(() => {
    document.body.innerHTML = ``
    create_supercell_spy.mockClear()
  })

  test(`supercell_scaling 1x1x1 → 2x2x2 keeps displayed+saveable at the base frame`, async () => {
    const props = $state({
      structure: make_base(),
      supercell_scaling: `1x1x1`,
      show_image_atoms: false,
      displayed_structure: undefined as AnyStructure | undefined,
      saveable_structure: undefined as AnyStructure | undefined,
    })
    const app = mount(Structure, { target: document.body, props })
    await settle()
    expect(props.saveable_structure?.sites).toHaveLength(2)

    props.supercell_scaling = `2x2x2`
    await settle()
    await vi.waitFor(async () => {
      await settle()
      expect(create_supercell_spy).not.toHaveBeenCalled()
      expect(props.saveable_structure?.sites).toHaveLength(2)
      expect(props.displayed_structure?.sites).toHaveLength(2)
    })
    // The input structure object itself is never mutated by view state.
    expect(props.structure.sites).toHaveLength(2)
    unmount(app)
  })
})

// ─── render-surface helper + canvas marking ───

describe(`Visual T6 — render-surface active-canvas selection`, () => {
  test(`mark_render_surface stamps backend + active attributes`, async () => {
    const { mark_render_surface } = await import(
      `$lib/structure/scene/render-surface`
    )
    const canvas = document.createElement(`canvas`)
    mark_render_surface(canvas, `webgl2`, true)
    expect(canvas.getAttribute(`data-render-backend`)).toBe(`webgl2`)
    expect(canvas.getAttribute(`data-render-active`)).toBe(`true`)
    mark_render_surface(canvas, `webgl2`, false)
    expect(canvas.getAttribute(`data-render-active`)).toBe(`false`)
  })

  test(`select_active_render_canvas picks the ACTIVE canvas, not the first`, async () => {
    const { mark_render_surface, select_active_render_canvas } = await import(
      `$lib/structure/scene/render-surface`
    )
    const root = document.createElement(`div`)
    const webgl = document.createElement(`canvas`)
    const overlay = document.createElement(`canvas`)
    root.append(webgl, overlay)
    // Bonds-T6 atomic swap agreement: overlay covering ⇒ WebGL suspended.
    mark_render_surface(webgl, `webgl2`, false)
    mark_render_surface(overlay, `webgpu`, true)
    expect(select_active_render_canvas(root)).toBe(overlay)
    // Swap back (overlay unmounts on fallback; WebGL resumes).
    overlay.remove()
    mark_render_surface(webgl, `webgl2`, true)
    expect(select_active_render_canvas(root)).toBe(webgl)
  })

  test(`unmarked scenes keep legacy first-canvas behaviour`, async () => {
    const { select_active_render_canvas } = await import(
      `$lib/structure/scene/render-surface`
    )
    const root = document.createElement(`div`)
    const first = document.createElement(`canvas`)
    const second = document.createElement(`canvas`)
    root.append(first, second)
    expect(select_active_render_canvas(root)).toBe(first)
    expect(select_active_render_canvas(null)).toBe(null)
    expect(select_active_render_canvas(document.createElement(`div`))).toBe(
      null,
    )
  })
})

// ─── production source contracts (jsdom cannot mount the 3D scene) ───

describe(`Visual T6 — production wiring source contracts`, () => {
  const structure_source = readFileSync(
    resolve(process.cwd(), `src/lib/structure/Structure.svelte`),
    `utf8`,
  )
  const scene_source = readFileSync(
    resolve(process.cwd(), `src/lib/structure/StructureScene.svelte`),
    `utf8`,
  )
  const overlay_source = readFileSync(
    resolve(process.cwd(), `src/lib/structure/gpu/LargeSystemOverlay.svelte`),
    `utf8`,
  )
  const export_source = readFileSync(
    resolve(process.cwd(), `src/lib/structure/ExportPane.svelte`),
    `utf8`,
  )
  const transform_source = readFileSync(
    resolve(
      process.cwd(),
      `src/lib/structure/controllers/transform-controller.svelte.ts`,
    ),
    `utf8`,
  )

  test(`renderer mode is out of semantic routing`, () => {
    // The visual-replication gate exists and is computed by the pure,
    // backend-free routing helper.
    expect(structure_source).toContain(`visual_replication_active(`)
    const gate_start = structure_source.indexOf(`let visual_replicas_active`)
    expect(gate_start).toBeGreaterThan(-1)
    const gate_block = structure_source.slice(gate_start, gate_start + 400)
    expect(gate_block).not.toContain(`large_system_mode`)
  })

  test(`transform controller no longer materializes scientific supercells`, () => {
    expect(transform_source).not.toContain(`create_supercell`)
    expect(transform_source).not.toContain(`get_supercell_scaling`)
  })

  test(`export pane no longer expands visual dims into scientific exports`, () => {
    expect(export_source).not.toContain(`export_supercell_via_worker`)
    expect(export_source).not.toContain(`gpu_supercell_active`)
    expect(export_source).toContain(`select_active_render_canvas`)
  })

  test(`both render canvases carry backend/active marks`, () => {
    expect(scene_source).toContain(`mark_render_surface(`)
    expect(overlay_source).toContain(`data-render-backend="webgpu"`)
    expect(overlay_source).toContain(`data-render-active="true"`)
  })
})

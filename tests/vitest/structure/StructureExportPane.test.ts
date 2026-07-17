// Smoke + behaviour tests for the structure export pane. Covers:
// - text format download/copy buttons in the Structure tab
// - the Figure tab's 3D model (GLB/OBJ) buttons
// - the Figure tab's PNG export
//
// The current ExportPane.svelte exposes tabs ("Structure", "Figure", "QE", …)
// instead of the old expandable toggle, so tests need to click the right tab
// before asserting on its content.

import type { AnyStructure } from '$lib'
import { export_canvas_as_image } from '$lib/io/export'
import { StructureExportPane } from '$lib/structure'
import * as export_funcs from '$lib/structure/export'
import { mount, tick } from 'svelte'
import type { Camera, Scene } from 'three'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { simple_structure } from '../setup'

// happy-dom defines navigator.clipboard as a non-configurable getter, so the
// usual defineProperty trick fails; stash a single mock and reset it per test.
const clipboard_write = vi.fn().mockResolvedValue(undefined)
;(navigator as unknown as { clipboard: { writeText: typeof clipboard_write } }).clipboard = {
  writeText: clipboard_write,
}

// Mock the export functions — every name the component looks up by key.
vi.mock(`$lib/structure/export`, () => ({
  export_structure_as_json: vi.fn(),
  export_structure_as_xyz: vi.fn(),
  export_structure_as_extxyz: vi.fn(),
  export_structure_as_cif: vi.fn(),
  export_structure_as_poscar: vi.fn(),
  export_structure_as_mol2: vi.fn(),
  export_structure_as_pdb: vi.fn(),
  export_structure_as_glb: vi.fn(),
  export_structure_as_obj: vi.fn(),
  structure_to_json_str: vi.fn(() => `{"test": "json"}`),
  structure_to_xyz_str: vi.fn(() => `3\ntest\nH 0 0 0`),
  structure_to_extxyz_str: vi.fn(() => `3\ntest\nH 0 0 0`),
  structure_to_cif_str: vi.fn(() => `data_test\n_cell_length_a 1.0`),
  structure_to_poscar_str: vi.fn(() => `test\n1.0\n1 0 0`),
  structure_to_mol2_str: vi.fn(() => `@<TRIPOS>MOLECULE\ntest`),
  structure_to_pdb_str: vi.fn(() => `HEADER test`),
}))

vi.mock(`$lib/io/export`, () => ({
  export_canvas_as_image: vi.fn(),
  export_canvas_as_png: vi.fn(),
  export_trajectory_png_sequence: vi.fn(),
  parse_frame_spec: vi.fn(() => []),
}))

// Visual T6: the worker-expansion module must never be reachable from the
// export pane — visual replication is view-only. The mock is registered for
// BOTH phases: pre-fix it intercepts the (forbidden) routing so the RED test
// can observe it; post-fix the pane no longer imports the module at all.
vi.mock(`$lib/structure/export/supercell-export-client`, () => ({
  export_supercell_via_worker: vi.fn().mockResolvedValue(undefined),
}))

// Helper: click a button by its visible text (case-insensitive trim match).
function click_text(text: string): boolean {
  const btn = Array.from(document.querySelectorAll<HTMLButtonElement>(`button`)).find(
    (b) => b.textContent?.trim().toLowerCase() === text.toLowerCase(),
  )
  if (!btn) return false
  btn.click()
  return true
}

// Helper: find the .export-item that contains a given label, then the button
// matching the desired title. If title_substr is empty, return the first
// button in the item (used for the 3D model section where buttons attach
// tooltips dynamically and don't carry a `title` attribute).
function find_button(label: string, title_substr: string): HTMLButtonElement | undefined {
  const item = Array.from(document.querySelectorAll<HTMLDivElement>(`.export-item`)).find(
    (el) => el.querySelector(`span`)?.textContent?.trim().toUpperCase() === label.toUpperCase(),
  )
  if (!item) return undefined
  const buttons = Array.from(item.querySelectorAll<HTMLButtonElement>(`button`))
  if (!title_substr) return buttons[0]
  return buttons.find(
    (b) => b.getAttribute(`title`)?.toLowerCase().includes(title_substr.toLowerCase()),
  )
}

describe(`StructureExportPane (Structure tab)`, () => {
  beforeEach(() => {
    document.body.innerHTML = ``
  })

  test(`displays all text export format labels`, () => {
    mount(StructureExportPane, {
      target: document.body,
      props: { structure: simple_structure },
    })
    for (const label of [`JSON`, `XYZ`, `CIF`, `POSCAR`, `MOL2`, `PDB`]) {
      expect(document.body.textContent).toContain(label)
    }
    // 6 format rows × 2 buttons (download + copy) inside .export-buttons.
    const text_buttons = document
      .querySelector(`.section-content .export-buttons`)
      ?.querySelectorAll(`button`)
    expect(text_buttons?.length).toBe(12)
  })

  test.each([
    { label: `JSON`, fn_name: `export_structure_as_json` as const },
    { label: `XYZ`, fn_name: `export_structure_as_xyz` as const },
    { label: `CIF`, fn_name: `export_structure_as_cif` as const },
    { label: `POSCAR`, fn_name: `export_structure_as_poscar` as const },
    { label: `MOL2`, fn_name: `export_structure_as_mol2` as const },
    { label: `PDB`, fn_name: `export_structure_as_pdb` as const },
  ])(`calls $fn_name for $label download`, ({ label, fn_name }) => {
    mount(StructureExportPane, {
      target: document.body,
      props: { structure: simple_structure },
    })
    const download_btn = find_button(label, `download`)
    expect(download_btn, `download button for ${label}`).toBeTruthy()
    download_btn?.click()
    expect(export_funcs[fn_name]).toHaveBeenCalledWith(simple_structure)
  })

  test.each([
    {
      label: `JSON`,
      str_fn: `structure_to_json_str` as const,
      expected: `{"test": "json"}`,
    },
    {
      label: `XYZ`,
      str_fn: `structure_to_xyz_str` as const,
      expected: `3\ntest\nH 0 0 0`,
    },
    {
      label: `CIF`,
      str_fn: `structure_to_cif_str` as const,
      expected: `data_test\n_cell_length_a 1.0`,
    },
    {
      label: `POSCAR`,
      str_fn: `structure_to_poscar_str` as const,
      expected: `test\n1.0\n1 0 0`,
    },
  ])(`copies $label content via clipboard`, async ({ label, str_fn, expected }) => {
    clipboard_write.mockClear()

    mount(StructureExportPane, {
      target: document.body,
      props: { structure: simple_structure },
    })
    const copy_btn = find_button(label, `copy`)
    expect(copy_btn, `copy button for ${label}`).toBeTruthy()
    copy_btn?.click()

    await vi.waitFor(() => {
      expect(export_funcs[str_fn]).toHaveBeenCalled()
      expect(clipboard_write).toHaveBeenCalledWith(expected)
    })
  })

  test(`Quick Export POSCAR button visible when structure has lattice`, () => {
    mount(StructureExportPane, {
      target: document.body,
      props: { structure: simple_structure },
    })
    expect(document.body.textContent).toContain(`Quick Export`)
  })
})

describe(`StructureExportPane — visual dims are view-only (Visual T6)`, () => {
  beforeEach(() => {
    document.body.innerHTML = ``
    vi.clearAllMocks()
  })

  // Legacy visual-supercell props (pre-T6 API). Post-T6 the pane must ignore
  // them entirely — scientific export always serializes the base structure.
  const legacy_visual_props = {
    gpu_supercell_active: true,
    gpu_supercell_factors: [2, 2, 2] as [number, number, number],
    gpu_supercell_base: simple_structure,
  }

  test.each([
    { label: `POSCAR`, fn_name: `export_structure_as_poscar` as const },
    { label: `XYZ`, fn_name: `export_structure_as_xyz` as const },
    { label: `CIF`, fn_name: `export_structure_as_cif` as const },
  ])(
    `$label download exports the BASE scientific structure, never a worker-expanded visual supercell`,
    async ({ label, fn_name }) => {
      const { export_supercell_via_worker } = await import(
        `$lib/structure/export/supercell-export-client`
      )
      mount(StructureExportPane, {
        target: document.body,
        props: { structure: simple_structure, ...legacy_visual_props },
      })
      const download_btn = find_button(label, `download`)
      expect(download_btn, `download button for ${label}`).toBeTruthy()
      download_btn?.click()
      expect(export_funcs[fn_name]).toHaveBeenCalledWith(simple_structure)
      expect(export_supercell_via_worker).not.toHaveBeenCalled()
    },
  )

  test(`image capture targets the ACTIVE render canvas, not the first one`, async () => {
    const wrapper = document.createElement(`div`)
    const suspended_webgl = document.createElement(`canvas`)
    suspended_webgl.setAttribute(`data-render-backend`, `webgl2`)
    suspended_webgl.setAttribute(`data-render-active`, `false`)
    const active_overlay = document.createElement(`canvas`)
    active_overlay.setAttribute(`data-render-backend`, `webgpu`)
    active_overlay.setAttribute(`data-render-active`, `true`)
    wrapper.append(suspended_webgl, active_overlay)
    document.body.appendChild(wrapper)

    mount(StructureExportPane, {
      target: document.body,
      props: {
        structure: simple_structure,
        scene: {} as Scene,
        wrapper,
        camera: { isPerspectiveCamera: true } as unknown as Camera,
      },
    })
    click_text(`Figure`)
    await tick()

    const select = document.querySelector<HTMLSelectElement>(`select`)
    const image_item = select?.closest(`.export-item`)
    const download_btn = image_item?.querySelector<HTMLButtonElement>(`button`)
    expect(download_btn, `image download button`).toBeTruthy()
    download_btn?.click()
    expect(export_canvas_as_image).toHaveBeenCalled()
    const captured = vi.mocked(export_canvas_as_image).mock.calls[0][0]
    expect(captured).toBe(active_overlay)
  })
})

describe(`StructureExportPane (Figure tab)`, () => {
  beforeEach(() => {
    document.body.innerHTML = ``
  })

  test(`exposes 3D model GLB/OBJ buttons when Figure tab is active`, async () => {
    const canvas = document.createElement(`canvas`)
    document.body.appendChild(canvas)
    mount(StructureExportPane, {
      target: document.body,
      props: { structure: simple_structure, scene: {} as Scene, wrapper: canvas.parentElement! },
    })
    click_text(`Figure`)
    await tick()
    expect(document.body.textContent).toContain(`GLB`)
    expect(document.body.textContent).toContain(`OBJ`)
  })

  test.each([
    { label: `GLB`, fn_name: `export_structure_as_glb` as const },
    { label: `OBJ`, fn_name: `export_structure_as_obj` as const },
  ])(`calls $fn_name for $label`, async ({ label, fn_name }) => {
    const canvas = document.createElement(`canvas`)
    document.body.appendChild(canvas)
    const mock_scene = {} as Scene
    mount(StructureExportPane, {
      target: document.body,
      props: { structure: simple_structure, scene: mock_scene, wrapper: canvas.parentElement! },
    })
    click_text(`Figure`)
    await tick()
    const download_btn = find_button(label, ``)
    expect(download_btn, `download button for ${label}`).toBeTruthy()
    download_btn?.click()
    expect(export_funcs[fn_name]).toHaveBeenCalled()
  })

  test(`Image (PNG) export invokes export_canvas_as_image when canvas is present`, async () => {
    // Figure tab uses a <select> for format and a single download (⬇)
    // button beside it that calls export_canvas_as_image(canvas, ..., format, ...)
    const wrapper = document.createElement(`div`)
    const canvas = document.createElement(`canvas`)
    wrapper.appendChild(canvas)
    document.body.appendChild(wrapper)
    const mock_camera = { isPerspectiveCamera: true } as unknown as Camera
    mount(StructureExportPane, {
      target: document.body,
      props: {
        structure: simple_structure,
        scene: {} as Scene,
        wrapper,
        camera: mock_camera,
      },
    })
    click_text(`Figure`)
    await tick()

    // The image-export download button sits next to the format <select>.
    const select = document.querySelector<HTMLSelectElement>(`select`)
    const image_item = select?.closest(`.export-item`)
    const download_btn = image_item?.querySelector<HTMLButtonElement>(`button`)
    expect(download_btn, `image download button`).toBeTruthy()
    download_btn?.click()
    expect(export_canvas_as_image).toHaveBeenCalled()
  })
})

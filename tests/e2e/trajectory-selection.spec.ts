import { Buffer } from 'node:buffer'
import { expect, test } from '@playwright/test'
import { project_to_pixel } from '../playwright/helpers/project_to_pixel'

const TWO_FRAME_EXTXYZ = `3
Lattice="8 0 0 0 8 0 0 0 8" Properties=species:S:1:pos:R:3 pbc="T T T" step=0
H 3.0 4.0 4.0
O 4.0 4.0 4.0
H 5.0 4.0 4.0
3
Lattice="8 0 0 0 8 0 0 0 8" Properties=species:S:1:pos:R:3 pbc="T T T" step=1
H 2.8 4.1 4.0
O 4.0 4.0 4.0
H 5.2 3.9 4.0
`

// Mirrors a trajectory saved after adding one atom to a middle frame only.
// Reloading this 3 -> 4 -> 3 topology used to build a three-atom position
// cache, then feed the middle frame's 12 coordinates into that fixed topology.
const VARIABLE_TOPOLOGY_EXTXYZ = `3
Lattice="8 0 0 0 8 0 0 0 8" Properties=species:S:1:pos:R:3 pbc="T T T" step=0
H 3.0 4.0 4.0
O 4.0 4.0 4.0
H 5.0 4.0 4.0
4
Lattice="8 0 0 0 8 0 0 0 8" Properties=species:S:1:pos:R:3 pbc="T T T" step=1
H 2.8 4.1 4.0
O 4.0 4.0 4.0
H 5.2 3.9 4.0
He 4.0 5.0 4.0
3
Lattice="8 0 0 0 8 0 0 0 8" Properties=species:S:1:pos:R:3 pbc="T T T" step=2
H 2.6 4.2 4.0
O 4.0 4.0 4.0
H 5.4 3.8 4.0
`

type Probe = {
  atom_count: number
  get_atom_xyz: (site_id: number) => [number, number, number] | null
  get_camera_matrices: () => {
    projection: number[]
    view: number[]
    width: number
    height: number
  } | null
  get_trackball_pointer_state: () => {
    state: number
    pointer_count: number
  } | null
  get_camera_is_moving: () => boolean
  selected_site_id: number | null
  selected_bond_count: number
  get_packet_bond_midpoint: (graph_idx: number) => [number, number, number] | null
}

test('bundled ASE trajectory stays binary through the Vite asset URL', async ({ page }) => {
  test.setTimeout(60_000)
  await page.goto('/', { waitUntil: 'load' })
  const source = page.locator('.source-selector select').first()
  await source.selectOption('catgo')
  await page.locator('.section-header', { hasText: /Trajectories/i }).click()
  await page.locator(
    'button.file-item[title="ase-LiMnO2-chgnet-relax.traj"]',
  ).click()

  await expect(page.locator('.trajectory-controls')).toBeVisible({
    timeout: 30_000,
  })
  await expect(page.getByText(/Unsupported text format/)).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Error' })).toHaveCount(0)
})

test('saved middle-frame atom additions reopen with discrete topology', async ({ page }) => {
  test.setTimeout(60_000)
  const shader_errors: string[] = []
  page.on(`console`, (message) => {
    const value = message.text()
    if (/Shader Error|VALIDATE_STATUS|ERROR:\s*0:/.test(value)) {
      shader_errors.push(value)
    }
  })
  await page.goto('/', { waitUntil: 'load' })
  const open = page.locator(
    'button.import-card.add-own-card',
    { hasText: /Open file/i },
  ).first()
  await expect(open).toBeVisible({ timeout: 30_000 })
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    open.click(),
  ])
  await chooser.setFiles({
    name: 'saved-middle-frame-add.extxyz',
    mimeType: 'chemical/x-xyz',
    buffer: Buffer.from(VARIABLE_TOPOLOGY_EXTXYZ),
  })

  await expect(page.locator('.trajectory-controls')).toBeVisible({
    timeout: 30_000,
  })
  const step = page.locator('.step-input')
  await step.fill('1')
  await step.press('Enter')
  await page.waitForFunction(
    () => (globalThis as typeof globalThis & { __catgo_probe?: Probe })
      .__catgo_probe?.atom_count === 4,
    null,
    { timeout: 10_000 },
  )
  await expect(page.getByText(/position values for 3 atoms/)).toHaveCount(0)
  await expect(page.locator('.trajectory-controls')).toBeVisible()

  await step.fill('2')
  await step.press('Enter')
  await page.waitForFunction(
    () => (globalThis as typeof globalThis & { __catgo_probe?: Probe })
      .__catgo_probe?.atom_count === 3,
    null,
    { timeout: 10_000 },
  )
  await expect(page.locator('.play-button').first()).toBeEnabled()
  expect(shader_errors).toEqual([])
})

test('packet-rendered trajectory atoms remain clickable', async ({ page }) => {
  // This scenario intentionally covers the complete edit lifecycle (ordered
  // measurement, add/delete, playback, export and dirty-close guard).  A cold
  // software-WebGL CI worker needs more than the ordinary one-action budget.
  test.setTimeout(120_000)
  await page.goto('/', { waitUntil: 'load' })
  const open = page.locator(
    'button.import-card.add-own-card',
    { hasText: /Open file/i },
  ).first()
  await expect(open).toBeVisible({ timeout: 30_000 })
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    open.click(),
  ])
  await chooser.setFiles({
    name: 'trajectory-selection.extxyz',
    mimeType: 'chemical/x-xyz',
    buffer: Buffer.from(TWO_FRAME_EXTXYZ),
  })

  await expect(page.locator('.trajectory-controls')).toBeVisible({
    timeout: 30_000,
  })
  await page.waitForFunction(
    () => Boolean((globalThis as typeof globalThis & { __catgo_probe?: Probe }).__catgo_probe),
    null,
    { timeout: 30_000 },
  )
  await page.waitForTimeout(300)

  const state = await page.evaluate(() => {
    const probe = (globalThis as typeof globalThis & { __catgo_probe?: Probe })
      .__catgo_probe
    return {
      // The central O stays at the rotation pivot, so projecting it remains
      // exact even when principal-axis alignment rotates the molecule group.
      xyz: probe?.get_atom_xyz(1) ?? null,
      matrices: probe?.get_camera_matrices() ?? null,
      selected: probe?.selected_site_id ?? null,
    }
  })
  expect(state.xyz).not.toBeNull()
  expect(state.selected).toBeNull()
  const pixel = project_to_pixel(state.matrices, state.xyz!)
  expect(pixel).not.toBeNull()
  const canvas = page.locator('canvas[data-render-active="true"]').first()
  const box = await canvas.boundingBox()
  expect(box).not.toBeNull()

  const packet_path_active = await canvas.evaluate((element) => {
    const scene = (element as HTMLCanvasElement & {
      __scene?: { getObjectByName: (name: string) => unknown }
    }).__scene
    return Boolean(scene) &&
      !scene!.getObjectByName('catgo-atom-picking-hitbox')
  })
  expect(packet_path_active).toBe(true)

  // VS Code/Antigravity webviews may consume pointerup in a capture listener
  // before it reaches Threlte's TrackballControls DOM element. Reproduce that
  // host-specific path while still allowing the picker window-capture handler
  // to run first.
  await page.evaluate(() => {
    const consume_pointer_up = (event: PointerEvent) => {
      document.removeEventListener('pointerup', consume_pointer_up, true)
      event.stopPropagation()
    }
    document.addEventListener('pointerup', consume_pointer_up, true)
  })
  await page.mouse.click(box!.x + pixel!.x, box!.y + pixel!.y)

  await page.waitForFunction(
    () => (globalThis as typeof globalThis & { __catgo_probe?: Probe })
      .__catgo_probe?.selected_site_id === 1,
    null,
    { timeout: 5_000 },
  )

  // A packet pick must finish the same pointer gesture that TrackballControls
  // started. Otherwise its captured pointer remains in ROTATE state and the
  // next hover-only mouse move rotates the structure without a button held.
  await page.waitForTimeout(500)
  const pointer_state = await page.evaluate(() =>
    (globalThis as typeof globalThis & { __catgo_probe?: Probe })
      .__catgo_probe?.get_trackball_pointer_state() ?? null,
  )
  expect(pointer_state).toEqual({ state: -1, pointer_count: 0 })
  const view_before_hover = await page.evaluate(() =>
    (globalThis as typeof globalThis & { __catgo_probe?: Probe })
      .__catgo_probe?.get_camera_matrices()?.view ?? null,
  )
  expect(view_before_hover).not.toBeNull()
  await page.mouse.move(box!.x + pixel!.x + 120, box!.y + pixel!.y + 80)
  await page.waitForTimeout(300)
  const view_after_hover = await page.evaluate(() =>
    (globalThis as typeof globalThis & { __catgo_probe?: Probe })
      .__catgo_probe?.get_camera_matrices()?.view ?? null,
  )
  expect(view_after_hover).toEqual(view_before_hover)

  // Preserve click order for an angle: O(1) -> H(0) -> H(2) means H(0) is
  // the vertex and therefore gives 0 degrees for this collinear fixture.
  // Rendering every atom as a possible center would incorrectly show three
  // labels instead of this one ordered A-B-C measurement.
  const remaining = await page.evaluate(() => {
    const probe = (globalThis as typeof globalThis & { __catgo_probe?: Probe })
      .__catgo_probe
    return {
      matrices: probe?.get_camera_matrices() ?? null,
      xyz_0: probe?.get_atom_xyz(0) ?? null,
      xyz_2: probe?.get_atom_xyz(2) ?? null,
    }
  })
  for (const xyz of [remaining.xyz_0, remaining.xyz_2]) {
    expect(xyz).not.toBeNull()
    const next_pixel = project_to_pixel(remaining.matrices, xyz!)
    expect(next_pixel).not.toBeNull()
    await page.mouse.click(
      box!.x + next_pixel!.x,
      box!.y + next_pixel!.y,
    )
  }
  await expect(page.locator('.selection-limit-text')).toHaveText('3')
  await page.locator('.measure-mode-dropdown .view-mode-button').click()
  await page.locator('.measure-mode-dropdown .view-mode-option').nth(1).click()

  const angle_labels = page.locator('.measure-label')
  await expect(angle_labels).toHaveCount(1)
  await expect(angle_labels).toHaveText(/^0(?:\.0+)?°$/)

  // A topology edit must invalidate the compact three-atom coordinate packet.
  // Otherwise the renderer combines 9 old position values with the new
  // four-atom topology and replaces the viewer with a fatal error page.
  await page.locator('.pencil-toggle').click()
  await expect(page.locator('.pencil-toggle')).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  const add_state = await page.evaluate(() => {
    const probe = (globalThis as typeof globalThis & { __catgo_probe?: Probe })
      .__catgo_probe
    return {
      xyz: probe?.get_atom_xyz(1) ?? null,
      matrices: probe?.get_camera_matrices() ?? null,
    }
  })
  const add_anchor = project_to_pixel(add_state.matrices, add_state.xyz!)
  expect(add_anchor).not.toBeNull()
  const anchor_x = box!.x + add_anchor!.x
  const anchor_y = box!.y + add_anchor!.y
  await page.mouse.click(anchor_x, anchor_y)
  await page.mouse.move(anchor_x + 80, anchor_y + 40, { steps: 4 })
  await page.mouse.click(anchor_x + 80, anchor_y + 40)

  await page.waitForFunction(
    () => (globalThis as typeof globalThis & { __catgo_probe?: Probe })
      .__catgo_probe?.get_atom_xyz(3) != null,
    null,
    { timeout: 5_000 },
  )
  await expect(page.locator('.trajectory-controls')).toBeVisible()
  await expect(page.getByText(/position values for 4 atoms/)).toHaveCount(0)

  // Deleting from only the current frame creates a variable-topology
  // trajectory. It must remain playable via the discrete slow path instead
  // of leaving the play button permanently disabled or waiting forever for a
  // fixed-topology prepared-frame buffer that can never be produced.
  await page.evaluate(() => {
    const api = (globalThis as typeof globalThis & {
      __catgo_traj_test?: { trigger_atoms_deleted: () => void }
    }).__catgo_traj_test
    api?.trigger_atoms_deleted()
  })
  await page.waitForFunction(
    () => (globalThis as typeof globalThis & { __catgo_probe?: Probe })
      .__catgo_probe?.get_atom_xyz(3) == null,
  )
  const play = page.locator('.play-button').first()
  await expect(play).toBeEnabled()
  const frame_before_play = await page.evaluate(() => {
    const api = (globalThis as typeof globalThis & {
      __catgo_traj_test?: { get_current_idx: () => number }
    }).__catgo_traj_test
    return api?.get_current_idx() ?? -1
  })
  await play.click()
  await page.waitForFunction(
    (before) => {
      const api = (globalThis as typeof globalThis & {
        __catgo_traj_test?: { get_current_idx: () => number }
      }).__catgo_traj_test
      return Boolean(
        (globalThis as typeof globalThis & {
          __catgo_traj_is_playing?: boolean
        }).__catgo_traj_is_playing,
      ) && api?.get_current_idx() !== before
    },
    frame_before_play,
    { timeout: 5_000 },
  )
  await expect(page.locator('.trajectory-controls')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Error' })).toHaveCount(0)

  // Structure-file exports are separate from video/image export: the visible
  // frame downloads as one POSCAR, while a selected range can be downloaded
  // as numbered POSCAR files in a ZIP. The current-frame path must work after
  // topology edits and playback, not just on the initial eager frame.
  if (await page.evaluate(() => Boolean(
    (globalThis as typeof globalThis & { __catgo_traj_is_playing?: boolean })
      .__catgo_traj_is_playing,
  ))) await play.click()
  const export_toggle = page.locator('.trajectory-export-toggle')
  // Dispatch directly because the preceding pencil gesture intentionally
  // exercises host-level pointer capture/swallowing; this assertion is about
  // the export workflow rather than another pointer-routing round trip.
  await export_toggle.dispatchEvent(`click`)
  await expect(export_toggle).toHaveAttribute(`aria-expanded`, `true`)
  const export_pane = page.locator('.export-pane')
  await expect(export_pane).toBeVisible()
  await expect(export_pane.locator('.trajectory-extxyz-export')).toBeVisible()
  await expect(export_pane.locator('.current-poscar-export')).toBeVisible()
  await expect(export_pane.locator('.poscar-sequence-export')).toBeVisible()

  await page.evaluate(() => {
    ;(globalThis as typeof globalThis & {
      __catgo_export_capture?: { filename: string; content: string }
      download?: (data: string | Blob, filename: string) => Promise<void>
    }).download = async (data, filename) => {
      const content = typeof data === `string` ? data : await data.text()
      ;(globalThis as typeof globalThis & {
        __catgo_export_capture?: { filename: string; content: string }
      }).__catgo_export_capture = { filename, content }
    }
  })
  await export_pane.locator('.current-poscar-export').dispatchEvent(`click`)
  await page.waitForFunction(() => Boolean(
    (globalThis as typeof globalThis & { __catgo_export_capture?: unknown })
      .__catgo_export_capture,
  ))
  const poscar_download = await page.evaluate(() =>
    (globalThis as typeof globalThis & {
      __catgo_export_capture?: { filename: string; content: string }
    }).__catgo_export_capture!,
  )
  expect(poscar_download.filename).toMatch(
    /^trajectory-selection_frame_\d{4}\.vasp$/,
  )
  expect(poscar_download.content).toContain(`1.0`)
  expect(poscar_download.content).toMatch(/Direct|Cartesian/)

  // Trajectory edits must enter the same dirty/close guard as ordinary
  // structures. A tab close now offers Save & Close instead of silently
  // discarding the edited trajectory.
  await page.getByRole(`button`, { name: `Close tab` }).first().click()
  const close_dialog = page.locator(`.modal-dialog`).filter({
    has: page.locator(`.modal-btn.save`),
  })
  await expect(close_dialog).toBeVisible()
  await expect(close_dialog.locator(`.modal-btn.save`)).toBeVisible()
  await close_dialog.locator(`.modal-btn.cancel`).click()
})

test('packet-rendered trajectory bonds remain clickable', async ({ page }) => {
  test.setTimeout(60_000)
  await page.goto('/', { waitUntil: 'load' })
  const open = page.locator(
    'button.import-card.add-own-card',
    { hasText: /Open file/i },
  ).first()
  await expect(open).toBeVisible({ timeout: 30_000 })
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    open.click(),
  ])
  await chooser.setFiles({
    name: 'trajectory-bond-selection.extxyz',
    mimeType: 'chemical/x-xyz',
    buffer: Buffer.from(TWO_FRAME_EXTXYZ),
  })

  await expect(page.locator('.trajectory-controls')).toBeVisible({
    timeout: 30_000,
  })
  await page.waitForFunction(
    () => {
      const probe = (globalThis as typeof globalThis & { __catgo_probe?: Probe })
        .__catgo_probe
      return probe?.get_packet_bond_midpoint(0) != null
    },
    null,
    { timeout: 30_000 },
  )
  await page.waitForTimeout(300)

  const state = await page.evaluate(() => {
    const probe = (globalThis as typeof globalThis & { __catgo_probe?: Probe })
      .__catgo_probe
    return {
      midpoint: probe?.get_packet_bond_midpoint(0) ?? null,
      matrices: probe?.get_camera_matrices() ?? null,
      selected_bonds: probe?.selected_bond_count ?? -1,
    }
  })
  expect(state.midpoint).not.toBeNull()
  expect(state.selected_bonds).toBe(0)
  const pixel = project_to_pixel(state.matrices, state.midpoint!)
  expect(pixel).not.toBeNull()
  const canvas = page.locator('canvas[data-render-active="true"]').first()
  const box = await canvas.boundingBox()
  expect(box).not.toBeNull()

  // Paused quality mode supersamples the analytic sphere/cylinder depth
  // boundary; browser downsampling is what removes the junction staircase.
  // Initial camera fitting temporarily enables the native-DPR motion path.
  // Wait for both layout and that fit to settle before checking paused quality.
  await expect.poll(async () => page.evaluate(() => {
    const probe = (globalThis as typeof globalThis & { __catgo_probe?: Probe })
      .__catgo_probe
    const canvas = document.querySelector<HTMLCanvasElement>(
      `canvas[data-render-active="true"]`,
    )
    const camera_is_moving = typeof probe?.get_camera_is_moving === `function`
      ? probe.get_camera_is_moving()
      : probe?.get_trackball_pointer_state()?.state !== -1
    return Boolean(
      canvas && canvas.clientWidth > 0 && canvas.clientHeight > 0 &&
      probe && !camera_is_moving,
    )
  }), { timeout: 15_000 }).toBe(true)
  await expect.poll(async () => canvas.evaluate((node) => {
    const el = node as HTMLCanvasElement
    return el.width / Math.max(1, el.clientWidth)
  }), { timeout: 15_000 }).toBeGreaterThan(1.5)

  await page.mouse.click(box!.x + pixel!.x, box!.y + pixel!.y)
  await page.waitForFunction(
    () => (globalThis as typeof globalThis & { __catgo_probe?: Probe })
      .__catgo_probe?.selected_bond_count === 1,
    null,
    { timeout: 5_000 },
  )
  await expect(page.getByRole('heading', { name: 'Error' })).toHaveCount(0)

  // Playback must shed the extra framebuffer immediately; this keeps the
  // quality fix out of the trajectory hot path.
  const play = page.locator('.play-button').first()
  await play.click()
  await page.waitForFunction(() =>
    (globalThis as typeof globalThis & { __catgo_traj_is_playing?: boolean })
      .__catgo_traj_is_playing === true,
  )
  await expect.poll(async () => canvas.evaluate((node) => {
    const el = node as HTMLCanvasElement
    return el.width / Math.max(1, el.clientWidth) - window.devicePixelRatio
  })).toBeCloseTo(0, 1)
  await play.click()
})

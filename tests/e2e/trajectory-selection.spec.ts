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

type Probe = {
  get_atom_xyz: (site_id: number) => [number, number, number] | null
  get_camera_matrices: () => {
    projection: number[]
    view: number[]
    width: number
    height: number
  } | null
  selected_site_id: number | null
}

test('packet-rendered trajectory atoms remain clickable', async ({ page }) => {
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

  await page.mouse.click(box!.x + pixel!.x, box!.y + pixel!.y)

  await page.waitForFunction(
    () => (globalThis as typeof globalThis & { __catgo_probe?: Probe })
      .__catgo_probe?.selected_site_id === 1,
    null,
    { timeout: 5_000 },
  )
})

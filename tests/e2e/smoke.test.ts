// Smoke tests for the real CatGo app (served by vite.desktop.config.ts).
//
// The legacy tests/playwright suite came from upstream matterviz and targets
// demo-site routes (/test/*, /periodic-table, ...) that do not exist in this
// repo — it cannot pass and is excluded from CI (see playwright.config.ts and
// issue #310). This suite drives the actual app at `/` instead: launcher,
// editor mount, WebGL canvas, and the layout round-trip that previously
// scrambled the viewer (#309).
import { expect, test } from '@playwright/test'

// No backend runs in CI: /api requests fail and the app must still render.
// Avoid `networkidle` (HMR websocket keeps the connection pool busy).

test(`launcher renders the sample structure preview`, async ({ page }) => {
  await page.goto(`/`, { waitUntil: `load` })
  await expect(page.getByText(`Water`, { exact: true })).toBeVisible({ timeout: 20_000 })
  const canvas = page.locator(`canvas`).first()
  await expect(canvas).toBeVisible({ timeout: 20_000 })
})

test(`opening the sample structure mounts the editor with a live canvas`, async ({ page }) => {
  await page.goto(`/`, { waitUntil: `load` })
  const card = page.getByRole(`button`, { name: /^Structure viewer/ })
  await card.click({ timeout: 20_000 })

  // A workspace tab appears and the editor's WebGL canvas has real dimensions.
  await expect(page.getByRole(`tab`).first()).toBeVisible({ timeout: 20_000 })
  const canvas = page.locator(`canvas`).first()
  await expect(canvas).toBeVisible({ timeout: 20_000 })
  const size = await canvas.evaluate((el) => ({
    w: (el as HTMLCanvasElement).clientWidth,
    h: (el as HTMLCanvasElement).clientHeight,
  }))
  expect(size.w).toBeGreaterThan(100)
  expect(size.h).toBeGreaterThan(100)
})

test(`layout round-trip keeps the viewer canvas alive`, async ({ page }) => {
  await page.goto(`/`, { waitUntil: `load` })
  await page.getByRole(`button`, { name: /^Structure viewer/ }).click({ timeout: 20_000 })
  await expect(page.locator(`canvas`).first()).toBeVisible({ timeout: 20_000 })

  // Single -> Side by Side -> Single. Each step the canvas must stay mounted
  // and visible (this round-trip used to rescale/crop the view, #309/#310).
  const layout_menu = page.getByRole(`button`, { name: `Single`, exact: true })
  await layout_menu.click()
  await page.getByRole(`button`, { name: `Side by Side` }).last().click()
  await expect(page.locator(`canvas`).first()).toBeVisible({ timeout: 20_000 })

  await page.getByRole(`button`, { name: `Side by Side`, exact: true }).first().click()
  await page.getByRole(`button`, { name: `Single` }).last().click()
  // Dropping back to one pane may warn about removing loaded structures.
  const confirm = page.getByRole(`button`, { name: `Continue` })
  if (await confirm.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await confirm.click()
  }
  await expect(page.locator(`canvas`).first()).toBeVisible({ timeout: 20_000 })
})

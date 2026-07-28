import { expect, test } from '@playwright/test'

// ── Build supercell is a TRUE edit (trajectory-supercell design §9.1/§9.2) ──
//
// Build → Lattice → Transform → Supercell must materialize real sites via the
// explicit SupercellOp channel. `large_system_mode` selects a renderer ONLY —
// it must never turn the Build edit into visual replication (the old
// renderer shortcut wrote `supercell_scaling` instead of editing; that path
// was removed). The Vitest layer (tests/vitest/structure/
// supercell-worker-api.test.ts) covers the same invariants at component level.
test.describe(`Build supercell — true edit semantics`, () => {
  // Read the summed element amounts from the atom legend (one <sub> per
  // element row) as a proxy for the structure's real site count.
  async function legend_atom_total(
    page: import('@playwright/test').Page,
  ): Promise<number> {
    const subs = page.locator(`#test-structure .legend-item sub`)
    const texts = await subs.allTextContents()
    return texts.reduce((sum, txt) => sum + (parseFloat(txt) || 0), 0)
  }

  async function apply_2x2x2_build_supercell(page: import('@playwright/test').Page) {
    await page.locator(`.lattice-pane-toggle`).click()
    await page.locator(`.tab-bar button`, { hasText: `Transform` }).click()
    await page.locator(`.preset-grid button`, { hasText: `2x2x2` }).click()
    await page.locator(`.apply-btn`, { hasText: `Apply Transform` }).click()
  }

  test.beforeEach(async ({ page }) => {
    await page.goto(`/test/structure`, { waitUntil: `networkidle` })
    await expect(page.locator(`#test-structure canvas`)).toBeVisible()
  })

  test(`Build 2x2x2 supercell materializes 8x the sites`, async ({ page }) => {
    const before = await legend_atom_total(page)
    expect(before).toBeGreaterThan(0)

    await apply_2x2x2_build_supercell(page)

    await expect
      .poll(() => legend_atom_total(page), { timeout: 10_000 })
      .toBe(before * 8)
  })

  test(`large-system mode does not downgrade Build supercell to visual replication`, async ({ page }) => {
    // Renderer state must not alter Build semantics: with the large-system
    // (WebGPU overlay) checkbox enabled, the SAME true edit must happen.
    const large_system_toggle = page.locator(
      `label:has-text("large system") input[type="checkbox"], label:has-text("Large system") input[type="checkbox"]`,
    )
    if (await large_system_toggle.count()) await large_system_toggle.first().check()

    const before = await legend_atom_total(page)
    expect(before).toBeGreaterThan(0)

    await apply_2x2x2_build_supercell(page)

    await expect
      .poll(() => legend_atom_total(page), { timeout: 10_000 })
      .toBe(before * 8)
  })
})

test.describe(`Lattice Component Tests`, () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`/test/structure`, { waitUntil: `networkidle` })
    await expect(page.locator(`#test-structure canvas`)).toBeVisible()

    // Use test page checkbox to open controls
    await page
      .locator(`label:has-text("Controls Open") input[type="checkbox"]`)
      .check()
    await expect(page.locator(`.draggable-pane.controls-pane`)).toHaveClass(
      /pane-open/,
    )
  })

  test(`renders lattice with default properties`, async ({ page }) => {
    const canvas = page.locator(`#test-structure canvas`)
    const screenshot = await canvas.screenshot()
    expect(screenshot.length).toBeGreaterThan(1000)
  })

  test(`lattice vectors checkbox toggles visibility`, async ({ page }) => {
    const canvas = page.locator(`#test-structure canvas`)
    const checkbox = page.locator(
      `.draggable-pane label:has-text("lattice vectors") input[type="checkbox"]`,
    )

    const before = await canvas.screenshot()
    await checkbox.click()
    await page.waitForLoadState(`networkidle`)
    const after = await canvas.screenshot()

    expect(before.equals(after)).toBe(false)
  })

  test(`color controls work`, async ({ page }) => {
    const canvas = page.locator(`#test-structure canvas`)
    // Target Edge color input by its label text
    const edge_color = page.locator(
      `.draggable-pane label:has-text("Edge color") input[type="color"]`,
    )
    // Target Surface opacity range input
    const surface_opacity = page.locator(
      `.draggable-pane label:has-text("Surface color") + label input[type="range"]`,
    )

    // Make surface visible and change edge color
    await surface_opacity.fill(`0.5`)
    const before = await canvas.screenshot()
    await edge_color.fill(`#ff0000`)
    await page.waitForLoadState(`networkidle`)
    const after = await canvas.screenshot()

    expect(before.equals(after)).toBe(false)
  })

  test(`opacity controls work`, async ({ page }) => {
    const canvas = page.locator(`#test-structure canvas`)
    const edge_opacity = page.locator(
      `.draggable-pane label:has-text("Edge color") + label input[type="range"]`,
    )
    const surface_opacity = page.locator(
      `.draggable-pane label:has-text("Surface color") + label input[type="range"]`,
    )

    const before = await canvas.screenshot()
    await edge_opacity.fill(`1`)
    await surface_opacity.fill(`0.8`)
    await page.waitForLoadState(`networkidle`)
    const after = await canvas.screenshot()

    expect(before.equals(after)).toBe(false)
  })

  test(`number and range inputs sync`, async ({ page }) => {
    const edge_range = page.locator(
      `.draggable-pane label:has-text("Edge color") + label input[type="range"]`,
    )
    const edge_number = page.locator(
      `.draggable-pane label:has-text("Edge color") + label input[type="number"]`,
    )

    await edge_number.fill(`0.3`)
    await expect(edge_range).toHaveValue(`0.3`)

    await edge_range.fill(`0.7`)
    await expect(edge_number).toHaveValue(`0.7`)
  })

  test(`inputs have correct validation`, async ({ page }) => {
    const edge_number = page.locator(
      `.draggable-pane label:has-text("Edge color") + label input[type="number"]`,
    )
    const surface_number = page.locator(
      `.draggable-pane label:has-text("Surface color") + label input[type="number"]`,
    )

    await expect(edge_number).toHaveAttribute(`step`, `0.05`)
    await expect(surface_number).toHaveAttribute(`step`, `0.01`)
  })
})

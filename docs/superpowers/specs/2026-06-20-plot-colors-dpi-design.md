# Customizable line colors + Nature presets + export DPI for electronic-structure plots

**Date:** 2026-06-20
**Status:** Approved — ready for implementation plan
**Scope:** DOS, COHP, and band-structure analysis plots (`src/lib/electronic/`)

## Problem

The three electronic-structure analysis plots (DOS, COHP, band structure) have
fixed line colors and a fixed image-export resolution:

1. **Line colors are not fully customizable.** COHP already exposes per-series
   color and fill-color pickers, but DOS exposes only dash + width (no color),
   and the band plot exposes nothing — its colors are hardcoded. Worse, the band
   plot draws spin-up and spin-down bands in the *same* blue (differentiated only
   by opacity/dash), which is a legibility bug.
2. **No curated publication palettes.** Each plot hardcodes its own copy of the
   matplotlib `tab10` array (four duplicate copies across the codebase). There is
   no shared palette module and no Nature-journal-style preset.
3. **Export DPI is hardcoded.** All three plots call
   `Plotly.toImage(plot_div, { width: 800, height, scale: 2 })`. Users cannot
   request a publication-grade resolution (e.g. 300 dpi at a fixed column width).

## Goals

- Let users set the color of every line in DOS / COHP / band plots, manually and
  via one-click curated presets.
- Ship canonical Nature-journal palettes (NPG, AAAS/Science, Lancet, NEJM) plus a
  print-safe grayscale, alongside the existing `tab10` default.
- Let users export PNGs at a chosen DPI and physical width (exact pixel size).
- Keep current behavior unchanged by default — every addition is opt-in.

## Non-goals

- Changing "chrome" colors (Fermi line, band gap annotation, gridlines, ticks,
  high-symmetry vlines). Only data-series line colors are in scope.
- SVG export changes — SVG is vector, DPI does not apply; the SVG path is left as
  is.
- Refactoring the plotting beyond what these features require.

## Reference implementation

**COHP is the template.** `CohpAnalysisPane.svelte` (the 线型 section, ~L435–496)
already has per-series `<input type=color>` for line color and fill color, written
into `cohp_state.line_styles[label].{color,fill_color}`, and `CohpPlot.svelte:143`
reads `style.color ?? DEFAULT_COLORS[i % …]`. DOS and band work brings them to this
same shape; COHP itself only gains the preset dropdown + shared palette import.

## Design

### A. Shared palette module — `src/lib/electronic/palettes.ts` (new)

Single source of truth that replaces the four duplicated color arrays
(`DosPlot.svelte:57`, `BandPlot.svelte:57`, `CohpPlot.svelte:59`,
`CohpAnalysisPane.svelte:61`).

```ts
// preset key → ordered hex array
export const PALETTE_PRESETS = {
  default:   ['#1f77b4', '#ff7f0e', …],  // current tab10 — unchanged
  npg:       ['#E64B35', '#4DBBD5', '#00A087', '#3C5488', '#F39B7F',
              '#8491B4', '#91D1C2', '#DC0000', '#7E6148', '#B09C85'],
  aaas:      ['#3B4992', '#EE0000', '#008B45', '#631879', '#008280',
              '#BB0021', '#5F559B', '#A20056', '#808180', '#1B1919'],
  lancet:    ['#00468B', '#ED0000', '#42B540', '#0099B4', '#925E9F',
              '#FDAF91', '#AD002A', '#ADB6B6', '#1B1919'],
  nejm:      ['#BC3C29', '#0072B5', '#E18727', '#20854E', '#7876B1',
              '#6F99AD', '#FFDC91', '#EE4C97'],
  grayscale: ['#000000', '#595959', '#7f7f7f', '#a6a6a6', '#bfbfbf', '#d9d9d9'],
} as const

export type PaletteName = keyof typeof PALETTE_PRESETS

// preset ordering for the dropdown + i18n label keys
export const PALETTE_ORDER: PaletteName[] = ['default','npg','aaas','lancet','nejm','grayscale']

// assign colors to labels in array order, cycling when labels outnumber colors
export function apply_palette(
  labels: string[],
  preset: PaletteName,
): Record<string, string>
```

Hex values are the established ggsci journal palettes (NPG = Nature Publishing
Group, AAAS = Science, Lancet, NEJM). The four existing arrays import
`PALETTE_PRESETS.default` instead of redefining tab10.

i18n label keys (en + zh): `配色方案` / "Palette" and one label per preset.

### B. DOS color support

- **Type:** extend the `line_styles` record value (in `types.ts:78` and the
  `DosPlot.svelte:39` prop type) from `{ dash?, width? }` to
  `{ dash?, width?, color?, fill_color? }`.
- **Plot read:** `DosPlot.svelte:115` becomes
  `const color = style.color ?? PALETTE_PRESETS.default[i % …]`; fill derives from
  `style.fill_color ?? color` via the existing slice logic.
- **UI:** in `DosAnalysisPane.svelte` 线型 section (~L760–796), add per-series
  color + fill-color `<input type=color>` (mirroring COHP L444–490), and a
  配色方案 `<select>` at the top of the section that, on change, calls
  `apply_palette(series_labels, preset)` and writes the result into
  `dos_state.line_styles[label].color` for every series.

### C. COHP preset support

- Replace the local `DEFAULT_COLORS` arrays (`CohpPlot.svelte:59`,
  `CohpAnalysisPane.svelte:61`) with `PALETTE_PRESETS.default`.
- Add the 配色方案 `<select>` to the COHP 线型 section; on change bulk-write
  `cohp_state.line_styles[label].color`. Per-series pickers already exist.

### D. Band color support (largest change — also fixes the same-blue spin bug)

- **State:** add to `BandViewState` (`band_types.ts:66`):
  `spin_up_color?: string`, `spin_down_color?: string`, `proj_palette?: PaletteName`,
  `proj_colors?: Record<string,string>` (per-projection manual overrides).
- **Plot read:** `BandPlot.svelte:117-118` — replace the hardcoded
  `'rgba(100,160,255,0.x)'` literals with `band_state.spin_up_color` /
  `band_state.spin_down_color` (falling back to the current blue when unset so the
  default look is preserved). `BandPlot.svelte:143` fat-band color resolves from
  `proj_colors[label] ?? PALETTE_PRESETS[proj_palette ?? 'default'][proj_idx % …]`.
- **UI:** add a new 线型 `<details>` section to `BandAnalysisPane.svelte`
  (sibling of the existing 显示选项 block): spin-up picker, spin-down picker, a
  投影配色 preset `<select>`, and per-projection color pickers.
- **Wiring:** `band_state` already threads to `<BandPlot>` at `Structure.svelte:5228+`
  — pass the new fields through.

### E. Export DPI (PNG only)

- **Signature:** extend `export_image` on all three plots to
  `export_image(format, opts?: { dpi?: number; width_mm?: number }): Promise<string|null>`.
  - PNG **with** opts: `width_px = Math.round(width_mm / 25.4 * dpi)`,
    `height_px = Math.round(width_px * aspect)` where `aspect = container_height / 800`
    (the current logical aspect ratio); call
    `Plotly.toImage(plot_div, { format, width: width_px, height: height_px, scale: 1 })`.
  - SVG, or PNG with no opts: unchanged
    (`{ width: 800, height: container_height, scale: 2 }`) — back-compat.
- **Shared export settings (state):** `dpi` (default 300) and `width_mm`
  (default 180 = double column; 88 = single column; custom numeric), persisted to
  `localStorage` (keys `catgo.export.dpi`, `catgo.export.width_mm`) so the choice
  is set once and reused by both export entry points.
- **UI:** a small 导出设置 (PNG) block rendered next to the PNG/SVG buttons in
  **both** `DosPlotWindow.svelte` (its own buttons) and the shared export area in
  `Structure.svelte` (`export_plot`, ~L1530–1565, which calls
  `plot_ref.export_image(format)`):
  - DPI number input + quick chips `96 / 150 / 300 / 600`
  - width `<select>`: 单栏 88mm / 双栏 180mm / 自定义 → numeric mm input
  - live readout `→ {width_px} × {height_px} px`
  The PNG button passes `{ dpi, width_mm }` to `export_image`; SVG passes nothing.

## Data flow summary

| Plot | Style carrier (`$bindable` in `Structure.svelte`) | Colors today | After |
|------|--------------------------------------------------|--------------|-------|
| DOS  | `dos_state.line_styles` (init L1427)             | dash+width   | + color, fill_color, preset |
| COHP | `cohp_state.line_styles` (init L1497)           | color+fill+dash+width | + preset dropdown |
| Band | `band_state` (init L1451) — gains color fields  | none (hardcoded) | spin colors + proj palette + per-proj |

Export DPI is independent of the per-plot style carriers: a shared, localStorage-backed
export preference passed as an argument at export time.

## Error handling / edge cases

- More series than palette colors → `apply_palette` cycles (`i % len`).
- Preset picked, then a series color hand-edited → manual edit persists in
  `line_styles[label].color` until another preset is picked (preset overwrites all).
- `width_mm` custom must be > 0; clamp DPI to a sane range (e.g. 50–1200) to avoid
  multi-hundred-megapixel renders.
- Unset color fields fall back to the existing default so untouched plots look
  identical to today.
- Band default fallback keeps the current blue rgba so the spin-bug fix is opt-in
  via picking distinct colors (or a preset).

## Testing

- **Vitest unit tests** (`tests/vitest/` — note: only `tests/vitest/**` and
  `src/**/__tests__/**` are collected by CI):
  - `apply_palette` assigns labels to colors in order; cycles when labels exceed
    colors; every `PaletteName` resolves to a non-empty array.
  - DPI px helper: `width_mm/25.4*dpi` rounding, aspect-preserving height, clamp
    bounds.
- **Live verification** (Plotly canvases are not unit-testable): for each plot,
  pick each preset and confirm bulk recolor; hand-pick a single series color and
  confirm override + persistence; export a PNG at 300 dpi / 180mm and confirm the
  output pixel dimensions match the readout.

## i18n

New keys in both `src/lib/i18n/en/*.ts` and `src/lib/i18n/zh/*.ts` (keep key sets
in parity): palette label + per-preset names, 自旋向上 / 自旋向下 / 投影配色,
导出设置 / DPI / 宽度 / 单栏 / 双栏 / 自定义.

## Out of scope / future

- Saving a hand-tuned palette as a named custom preset.
- Per-plot (vs shared) export DPI preferences.
- DPI metadata chunk embedding in the PNG (Plotly does not write one; the image is
  simply rendered at the target pixel size).

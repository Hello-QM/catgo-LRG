# Plot Line Colors + Nature Presets + Export DPI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the DOS, COHP, and band-structure analysis plots user-customizable line colors (manual + one-click Nature-journal presets) and publication-grade PNG export at a chosen DPI × physical width.

**Architecture:** A new shared `palettes.ts` replaces four duplicated `tab10` arrays and adds ggsci journal presets. COHP already has per-series color pickers and is the reference; DOS and band plots are brought to parity (band also gains distinct spin-up/down colors, fixing a same-blue bug). A new `export-dims.ts` helper converts mm + DPI → exact pixels; `export_image` gains an optional `{dpi, width_mm}` arg threaded from a shared `ExportDpiControl.svelte` whose preference persists to `localStorage`.

**Tech Stack:** SvelteKit 2 / Svelte 5 runes, TypeScript, Plotly (`plotly.js-dist-min`), Vitest.

## Global Constraints

- **Svelte 5 runes only** — `$state` / `$derived` / `$props` / `$bindable`, never legacy stores or `export let`.
- **Formatting** enforced by pre-commit `deno fmt`: single quotes, **no semicolons**, 2-space indent. `.svelte` files are excluded from `deno fmt` but still follow the same style. Let the hook format, then re-stage.
- **i18n parity** — every new key added to BOTH `src/lib/i18n/en/structure.ts` and `src/lib/i18n/zh/structure.ts`.
- **Vitest CI glob** — tests only collected from `tests/vitest/**` and `src/**/__tests__/**`. Put new tests under `tests/vitest/`.
- **RTK stale cache** — run vitest via `rtk proxy pnpm exec vitest` (plain `pnpm vitest` may serve stale output).
- **No behavior change by default** — every new color/DPI field is optional; unset → current look (tab10, `scale:2`).
- **Pre-existing baseline:** `pnpm check` currently reports ~10 errors, all in `src/lib/gesture/__tests__/` (whisper/stt). These are NOT yours — only fail a task on *new* errors.
- **Branch:** `feat/plot-colors-dpi` (already created off `main`, spec committed at `8f224ffb`).

---

### Task 1: Shared palette module

**Files:**
- Create: `src/lib/electronic/palettes.ts`
- Test: `tests/vitest/electronic/palettes.test.ts`

**Interfaces:**
- Produces:
  - `PALETTE_PRESETS: Record<PaletteName, string[]>` — keys `default | npg | aaas | lancet | nejm | grayscale`
  - `type PaletteName`
  - `PALETTE_ORDER: PaletteName[]`
  - `PALETTE_LABEL_KEY: Record<PaletteName, string>` (i18n key per preset)
  - `apply_palette(labels: string[], preset: PaletteName): Record<string, string>`

- [ ] **Step 1: Write the failing test**

```ts
// tests/vitest/electronic/palettes.test.ts
import { describe, it, expect } from 'vitest'
import { PALETTE_PRESETS, PALETTE_ORDER, apply_palette } from '$lib/electronic/palettes'

describe('apply_palette', () => {
  it('assigns colors to labels in array order', () => {
    expect(apply_palette(['a', 'b', 'c'], 'npg')).toEqual({
      a: '#E64B35', b: '#4DBBD5', c: '#00A087',
    })
  })

  it('cycles when labels outnumber colors', () => {
    const labels = Array.from({ length: 8 }, (_, i) => `s${i}`)
    const out = apply_palette(labels, 'grayscale') // 6 colors
    expect(out.s6).toBe(PALETTE_PRESETS.grayscale[0])
    expect(out.s7).toBe(PALETTE_PRESETS.grayscale[1])
  })

  it('every preset in PALETTE_ORDER resolves to a non-empty array', () => {
    for (const name of PALETTE_ORDER) {
      expect(PALETTE_PRESETS[name].length).toBeGreaterThan(0)
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk proxy pnpm exec vitest run tests/vitest/electronic/palettes.test.ts`
Expected: FAIL — cannot resolve `$lib/electronic/palettes`.

- [ ] **Step 3: Write the module**

```ts
// src/lib/electronic/palettes.ts
/** Shared color palettes for electronic-structure plots (DOS / COHP / band). */

export const PALETTE_PRESETS = {
  default: [
    '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd',
    '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf',
  ],
  npg: [
    '#E64B35', '#4DBBD5', '#00A087', '#3C5488', '#F39B7F',
    '#8491B4', '#91D1C2', '#DC0000', '#7E6148', '#B09C85',
  ],
  aaas: [
    '#3B4992', '#EE0000', '#008B45', '#631879', '#008280',
    '#BB0021', '#5F559B', '#A20056', '#808180', '#1B1919',
  ],
  lancet: [
    '#00468B', '#ED0000', '#42B540', '#0099B4', '#925E9F',
    '#FDAF91', '#AD002A', '#ADB6B6', '#1B1919',
  ],
  nejm: [
    '#BC3C29', '#0072B5', '#E18727', '#20854E', '#7876B1',
    '#6F99AD', '#FFDC91', '#EE4C97',
  ],
  grayscale: [
    '#000000', '#595959', '#7f7f7f', '#a6a6a6', '#bfbfbf', '#d9d9d9',
  ],
} as const

export type PaletteName = keyof typeof PALETTE_PRESETS

/** Preset order for dropdowns. */
export const PALETTE_ORDER: PaletteName[] = [
  'default', 'npg', 'aaas', 'lancet', 'nejm', 'grayscale',
]

/** i18n key per preset; resolved by the caller via t(). */
export const PALETTE_LABEL_KEY: Record<PaletteName, string> = {
  default: 'structure.palette_default',
  npg: 'structure.palette_npg',
  aaas: 'structure.palette_aaas',
  lancet: 'structure.palette_lancet',
  nejm: 'structure.palette_nejm',
  grayscale: 'structure.palette_grayscale',
}

/** Assign a color to each label in order, cycling when labels outnumber colors. */
export function apply_palette(
  labels: string[],
  preset: PaletteName,
): Record<string, string> {
  const colors = PALETTE_PRESETS[preset]
  const out: Record<string, string> = {}
  labels.forEach((label, i) => {
    out[label] = colors[i % colors.length]
  })
  return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `rtk proxy pnpm exec vitest run tests/vitest/electronic/palettes.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/electronic/palettes.ts tests/vitest/electronic/palettes.test.ts
git commit -m "feat(electronic): shared palette module with Nature-journal presets"
```

---

### Task 2: Export pixel-dimension helper

**Files:**
- Create: `src/lib/electronic/export-dims.ts`
- Test: `tests/vitest/electronic/export-dims.test.ts`

**Interfaces:**
- Produces:
  - `interface ExportDims { width: number; height: number }`
  - `DPI_MIN = 50`, `DPI_MAX = 1200`
  - `compute_export_px(width_mm: number, dpi: number, aspect: number): ExportDims`

- [ ] **Step 1: Write the failing test**

```ts
// tests/vitest/electronic/export-dims.test.ts
import { describe, it, expect } from 'vitest'
import { compute_export_px, DPI_MAX } from '$lib/electronic/export-dims'

describe('compute_export_px', () => {
  it('maps mm + dpi to pixels (180mm @ 300dpi -> 2126)', () => {
    expect(compute_export_px(180, 300, 0.5).width).toBe(2126)
  })

  it('preserves aspect ratio in height', () => {
    const d = compute_export_px(180, 300, 0.625)
    expect(d.height).toBe(Math.round(d.width * 0.625))
  })

  it('clamps dpi to the max', () => {
    expect(compute_export_px(100, 99999, 1).width).toBe(
      compute_export_px(100, DPI_MAX, 1).width,
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk proxy pnpm exec vitest run tests/vitest/electronic/export-dims.test.ts`
Expected: FAIL — cannot resolve `$lib/electronic/export-dims`.

- [ ] **Step 3: Write the module**

```ts
// src/lib/electronic/export-dims.ts
/** Exact pixel dimensions for a publication-grade PNG export. */

export interface ExportDims {
  width: number
  height: number
}

const MM_PER_INCH = 25.4
export const DPI_MIN = 50
export const DPI_MAX = 1200

/**
 * Pixel dimensions for a PNG of physical `width_mm` at `dpi`, preserving the
 * on-screen `aspect` (= rendered height / width). DPI is clamped to
 * [DPI_MIN, DPI_MAX] to avoid multi-hundred-megapixel renders.
 */
export function compute_export_px(
  width_mm: number,
  dpi: number,
  aspect: number,
): ExportDims {
  const clamped_dpi = Math.max(DPI_MIN, Math.min(DPI_MAX, dpi))
  const width = Math.max(1, Math.round((width_mm / MM_PER_INCH) * clamped_dpi))
  const height = Math.max(1, Math.round(width * aspect))
  return { width, height }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `rtk proxy pnpm exec vitest run tests/vitest/electronic/export-dims.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/electronic/export-dims.ts tests/vitest/electronic/export-dims.test.ts
git commit -m "feat(electronic): mm+dpi -> pixel export-dimension helper"
```

---

### Task 3: DOS line colors + preset dropdown

**Files:**
- Modify: `src/lib/electronic/types.ts:78` (DosViewState line_styles type)
- Modify: `src/lib/electronic/DosPlot.svelte:39` (prop type), `:57-60` (remove COLORS), `:113-118` (read color), `:136` & `:156` (fill color)
- Modify: `src/lib/electronic/DosAnalysisPane.svelte:760-796` (线型 section)
- Modify: `src/lib/i18n/en/structure.ts` and `src/lib/i18n/zh/structure.ts` (palette_* keys)

**Interfaces:**
- Consumes: `PALETTE_PRESETS`, `PALETTE_ORDER`, `PALETTE_LABEL_KEY`, `apply_palette` (Task 1).
- Produces: `line_styles` record value now `{ dash?, width?, color?, fill_color? }` for DOS.

- [ ] **Step 1: Add palette i18n keys (en)**

In `src/lib/i18n/en/structure.ts`, immediately after the `dos_line_styles:` line (~1414), add:

```ts
  palette_label: `Palette`,
  palette_default: `Default (tab10)`,
  palette_npg: `Nature (NPG)`,
  palette_aaas: `Science (AAAS)`,
  palette_lancet: `Lancet`,
  palette_nejm: `NEJM`,
  palette_grayscale: `Grayscale`,
```

- [ ] **Step 2: Add palette i18n keys (zh)**

In `src/lib/i18n/zh/structure.ts`, immediately after the `dos_line_styles:` line (~1414), add:

```ts
  palette_label: `配色方案`,
  palette_default: `默认 (tab10)`,
  palette_npg: `Nature (NPG)`,
  palette_aaas: `Science (AAAS)`,
  palette_lancet: `Lancet`,
  palette_nejm: `NEJM`,
  palette_grayscale: `灰度`,
```

- [ ] **Step 3: Extend the DosViewState type**

In `src/lib/electronic/types.ts:78`, replace:

```ts
  line_styles: Record<string, { dash?: string; width?: number }>
```

with:

```ts
  line_styles: Record<string, { dash?: string; width?: number; color?: string; fill_color?: string }>
```

- [ ] **Step 4: Extend the DosPlot prop type + import palette**

In `src/lib/electronic/DosPlot.svelte`, at the existing import block (top `<script>`), add:

```ts
  import { PALETTE_PRESETS } from './palettes'
```

Replace the prop at `:39`:

```ts
    line_styles?: Record<string, { dash?: string; width?: number }>
```

with:

```ts
    line_styles?: Record<string, { dash?: string; width?: number; color?: string; fill_color?: string }>
```

Delete the local `COLORS` array at `:57-60`:

```ts
  const COLORS = [
    `#1f77b4`, `#ff7f0e`, `#2ca02c`, `#d62728`, `#9467bd`,
    `#8c564b`, `#e377c2`, `#7f7f7f`, `#bcbd22`, `#17becf`,
  ]
```

- [ ] **Step 5: Read user color + fill in the plot loop**

In `src/lib/electronic/DosPlot.svelte`, replace lines `:115-118`:

```ts
      const color = COLORS[i % COLORS.length]
      const style = line_styles[s.label] ?? {}
      const dash = style.dash ?? `solid`
      const lw = style.width ?? 1.5
```

with:

```ts
      const style = line_styles[s.label] ?? {}
      const color = style.color ?? PALETTE_PRESETS.default[i % PALETTE_PRESETS.default.length]
      const fill_base = style.fill_color ?? color
      const dash = style.dash ?? `solid`
      const lw = style.width ?? 1.5
```

Then in the same `$effect`, change the two `fillcolor` lines to use `fill_base` instead of `color`:

`:136` becomes:

```ts
        trace_up.fillcolor = `rgba(${parseInt(fill_base.slice(1, 3), 16)}, ${parseInt(fill_base.slice(3, 5), 16)}, ${parseInt(fill_base.slice(5, 7), 16)}, 0.15)`
```

`:156` becomes:

```ts
          trace_down.fillcolor = `rgba(${parseInt(fill_base.slice(1, 3), 16)}, ${parseInt(fill_base.slice(3, 5), 16)}, ${parseInt(fill_base.slice(5, 7), 16)}, 0.1)`
```

- [ ] **Step 6: Add preset dropdown + color pickers to DosAnalysisPane**

In `src/lib/electronic/DosAnalysisPane.svelte`, add to the top `<script>` imports:

```ts
  import { PALETTE_PRESETS, PALETTE_ORDER, PALETTE_LABEL_KEY, apply_palette } from './palettes'
```

Replace the 线型 section body `:764-794` (the `<div class="line-styles">…</div>`) with:

```svelte
        <div class="line-styles">
          <div class="line-style-row">
            <span class="group-label">{t('structure.palette_label')}</span>
            <select
              onchange={(e) => {
                const preset = (e.target as HTMLSelectElement).value as keyof typeof PALETTE_PRESETS
                const assigned = apply_palette(groups.map((g) => g.label), preset)
                const next = { ...dos_state.line_styles }
                for (const [label, color] of Object.entries(assigned)) {
                  next[label] = { ...next[label], color }
                }
                dos_state.line_styles = next
              }}
            >
              {#each PALETTE_ORDER as name}
                <option value={name}>{t(PALETTE_LABEL_KEY[name])}</option>
              {/each}
            </select>
          </div>
          {#each groups as g, gi}
            <div class="line-style-row">
              <span class="group-label">{g.label}</span>
              <input
                type="color"
                value={dos_state.line_styles[g.label]?.color ?? PALETTE_PRESETS.default[gi % PALETTE_PRESETS.default.length]}
                class="color-input"
                oninput={(e) => {
                  const target = e.target as HTMLInputElement
                  dos_state.line_styles = { ...dos_state.line_styles, [g.label]: { ...dos_state.line_styles[g.label], color: target.value } }
                }}
              />
              <select
                value={dos_state.line_styles[g.label]?.dash ?? `solid`}
                onchange={(e) => {
                  const target = e.target as HTMLSelectElement
                  dos_state.line_styles = { ...dos_state.line_styles, [g.label]: { ...dos_state.line_styles[g.label], dash: target.value } }
                }}
              >
                <option value="solid">{t('structure.dos_line_solid')}</option>
                <option value="dash">{t('structure.dos_line_dashed')}</option>
                <option value="dot">{t('structure.dos_line_dotted')}</option>
                <option value="dashdot">{t('structure.dos_line_dashdot')}</option>
              </select>
              <input
                type="number"
                value={dos_state.line_styles[g.label]?.width ?? 1.5}
                min="0.5"
                max="5"
                step="0.5"
                class="width-input"
                onchange={(e) => {
                  const target = e.target as HTMLInputElement
                  dos_state.line_styles = { ...dos_state.line_styles, [g.label]: { ...dos_state.line_styles[g.label], width: parseFloat(target.value) } }
                }}
              />
              {#if dos_state.show_fill}
                <input
                  type="color"
                  value={dos_state.line_styles[g.label]?.fill_color ?? dos_state.line_styles[g.label]?.color ?? PALETTE_PRESETS.default[gi % PALETTE_PRESETS.default.length]}
                  class="color-input"
                  title={t('structure.cohp_fill_color')}
                  oninput={(e) => {
                    const target = e.target as HTMLInputElement
                    dos_state.line_styles = { ...dos_state.line_styles, [g.label]: { ...dos_state.line_styles[g.label], fill_color: target.value } }
                  }}
                />
              {/if}
            </div>
          {/each}
        </div>
```

> The fill picker reuses the existing `structure.cohp_fill_color` key (already defined in both locales), gated on `dos_state.show_fill` exactly like COHP.

- [ ] **Step 7: Type-check (no new errors)**

Run: `pnpm check`
Expected: no NEW errors in `DosPlot.svelte`, `DosAnalysisPane.svelte`, `types.ts`. (Pre-existing gesture errors unchanged.)

- [ ] **Step 8: Live verify**

Run the app (`pnpm desktop:serve`). Compute a PDOS with ≥2 groups → open 线型 → pick a preset (all lines recolor in order) → hand-pick one group's color via the swatch (only that line changes, persists when reopening the section). Default look (no preset/no pick) is unchanged tab10.

- [ ] **Step 9: Commit**

```bash
git add src/lib/electronic/types.ts src/lib/electronic/DosPlot.svelte src/lib/electronic/DosAnalysisPane.svelte src/lib/i18n/en/structure.ts src/lib/i18n/zh/structure.ts
git commit -m "feat(dos): per-series line color + Nature-preset dropdown"
```

---

### Task 4: COHP preset dropdown + shared palette

**Files:**
- Modify: `src/lib/electronic/CohpPlot.svelte:59-62` (remove local DEFAULT_COLORS, import shared)
- Modify: `src/lib/electronic/CohpAnalysisPane.svelte:61` (remove local DEFAULT_COLORS), `:439` (add preset dropdown)

**Interfaces:**
- Consumes: `PALETTE_PRESETS`, `PALETTE_ORDER`, `PALETTE_LABEL_KEY`, `apply_palette` (Task 1); palette i18n keys (Task 3). COHP per-series `color`/`fill_color` pickers already exist — no type change needed (`cohp_types.ts` already has them).

- [ ] **Step 1: Swap CohpPlot's local palette for the shared one**

In `src/lib/electronic/CohpPlot.svelte`, add to the imports:

```ts
  import { PALETTE_PRESETS } from './palettes'
```

Delete `:59-62`:

```ts
  const DEFAULT_COLORS = [
    `#1f77b4`, `#ff7f0e`, `#2ca02c`, `#d62728`, `#9467bd`,
    `#8c564b`, `#e377c2`, `#7f7f7f`, `#bcbd22`, `#17becf`,
  ]
```

At `:143`, replace:

```ts
      const color = style.color ?? DEFAULT_COLORS[i % DEFAULT_COLORS.length]
```

with:

```ts
      const color = style.color ?? PALETTE_PRESETS.default[i % PALETTE_PRESETS.default.length]
```

- [ ] **Step 2: Swap CohpAnalysisPane's local palette + add preset dropdown**

In `src/lib/electronic/CohpAnalysisPane.svelte`, add to imports:

```ts
  import { PALETTE_PRESETS, PALETTE_ORDER, PALETTE_LABEL_KEY, apply_palette } from './palettes'
```

Delete the local `DEFAULT_COLORS` const at `:61` (the 10-color tab10 array).

Replace the two references `DEFAULT_COLORS[idx % DEFAULT_COLORS.length]` (at `:446` and `:482`) with:

```ts
PALETTE_PRESETS.default[idx % PALETTE_PRESETS.default.length]
```

Insert the preset dropdown as the first child of `<div class="line-styles">` (just after the opening tag at `:439`, before `{#each cohp_state.cohp_result.series …}`):

```svelte
          <div class="line-style-row">
            <span class="group-label">{t('structure.palette_label')}</span>
            <select
              onchange={(e) => {
                const preset = (e.target as HTMLSelectElement).value as keyof typeof PALETTE_PRESETS
                const labels = cohp_state.cohp_result.series.map((s) => s.label)
                const assigned = apply_palette(labels, preset)
                const next = { ...cohp_state.line_styles }
                for (const [label, color] of Object.entries(assigned)) {
                  next[label] = { ...next[label], color }
                }
                cohp_state.line_styles = next
              }}
            >
              {#each PALETTE_ORDER as name}
                <option value={name}>{t(PALETTE_LABEL_KEY[name])}</option>
              {/each}
            </select>
          </div>
```

- [ ] **Step 3: Type-check (no new errors)**

Run: `pnpm check`
Expected: no NEW errors in the two COHP files.

- [ ] **Step 4: Live verify**

Compute a COHP with ≥2 pairs → 线型 → pick a preset (all series recolor) → hand-pick one series color (overrides only that one). Existing dash/width/fill pickers still work.

- [ ] **Step 5: Commit**

```bash
git add src/lib/electronic/CohpPlot.svelte src/lib/electronic/CohpAnalysisPane.svelte
git commit -m "feat(cohp): Nature-preset dropdown + shared palette module"
```

---

### Task 5: Band colors — types + plot

**Files:**
- Modify: `src/lib/electronic/band_types.ts:66-83` (BandViewState fields + PaletteName import)
- Modify: `src/lib/electronic/BandPlot.svelte:30-50` (props), `:57-60` (remove COLORS), `:116-118` (spin colors), `:143` (proj color)

**Interfaces:**
- Consumes: `PALETTE_PRESETS`, `PaletteName` (Task 1).
- Produces: `BandViewState` gains `spin_up_color?`, `spin_down_color?`, `proj_palette?: PaletteName`, `proj_colors?: Record<string,string>`. `BandPlot` gains matching props.

- [ ] **Step 1: Extend BandViewState**

In `src/lib/electronic/band_types.ts`, add at the top of the file (after the existing leading comment):

```ts
import type { PaletteName } from './palettes'
```

Inside `interface BandViewState` (before the closing `}` at `:83`), add:

```ts
  // Line colors (optional; unset -> default blue / tab10 projections)
  spin_up_color?: string
  spin_down_color?: string
  proj_palette?: PaletteName
  proj_colors?: Record<string, string>
```

- [ ] **Step 2: Add BandPlot props + import palette, remove COLORS**

In `src/lib/electronic/BandPlot.svelte`, add to imports:

```ts
  import { PALETTE_PRESETS, type PaletteName } from './palettes'
```

In the `$props()` block (before the closing `} = $props()` at `:50`), add:

```ts
    spin_up_color?: string
    spin_down_color?: string
    proj_palette?: PaletteName
    proj_colors?: Record<string, string>
```

Delete the local `COLORS` array at `:57-60`.

- [ ] **Step 3: Use spin colors (fixes same-blue bug)**

In `src/lib/electronic/BandPlot.svelte`, replace `:117-118`:

```ts
      const line_dash = is_down ? `dash` : `solid`
      const line_color = is_down ? `rgba(100, 160, 255, 0.6)` : `rgba(100, 160, 255, 0.8)`
```

with:

```ts
      const line_dash = is_down ? `dash` : `solid`
      const line_color = is_down
        ? (spin_down_color ?? `rgba(100, 160, 255, 0.6)`)
        : (spin_up_color ?? `rgba(100, 160, 255, 0.8)`)
```

- [ ] **Step 4: Use projection palette/colors**

In `src/lib/electronic/BandPlot.svelte`, replace `:143`:

```ts
        const color = COLORS[proj_idx % COLORS.length]
```

with:

```ts
        const palette = PALETTE_PRESETS[proj_palette ?? `default`]
        const color = proj_colors?.[proj.label] ?? palette[proj_idx % palette.length]
```

- [ ] **Step 5: Type-check (no new errors)**

Run: `pnpm check`
Expected: no NEW errors in `band_types.ts`, `BandPlot.svelte`. (BandPlot's new props are not yet passed by the parent — that is Task 6; optional props with `?` keep the call site valid meanwhile.)

- [ ] **Step 6: Commit**

```bash
git add src/lib/electronic/band_types.ts src/lib/electronic/BandPlot.svelte
git commit -m "feat(band): spin + projection color props, shared palette (fixes same-blue spin)"
```

---

### Task 6: Band colors — UI + wiring + i18n

**Files:**
- Modify: `src/lib/electronic/BandAnalysisPane.svelte` (new 线型 `<details>` after the display-options block at `:494`; imports)
- Modify: `src/lib/structure/Structure.svelte:1451` (band_state init defaults), `:5229+` (pass new props to `<BandPlot>`)
- Modify: `src/lib/i18n/en/structure.ts`, `src/lib/i18n/zh/structure.ts` (band color keys)

**Interfaces:**
- Consumes: BandViewState color fields + BandPlot props (Task 5); palette exports (Task 1).

- [ ] **Step 1: Add band i18n keys (en)**

In `src/lib/i18n/en/structure.ts`, after the `palette_grayscale:` line added in Task 3, add:

```ts
  band_spin_up: `Spin up`,
  band_spin_down: `Spin down`,
  band_proj_palette: `Projection palette`,
```

- [ ] **Step 2: Add band i18n keys (zh)**

In `src/lib/i18n/zh/structure.ts`, after the `palette_grayscale:` line, add:

```ts
  band_spin_up: `自旋向上`,
  band_spin_down: `自旋向下`,
  band_proj_palette: `投影配色`,
```

- [ ] **Step 3: Add the 线型 section to BandAnalysisPane**

In `src/lib/electronic/BandAnalysisPane.svelte`, add to imports:

```ts
  import { PALETTE_PRESETS, PALETTE_ORDER, PALETTE_LABEL_KEY } from './palettes'
```

Immediately after the display-options `</details>` (the one closing at `:494`), insert:

```svelte
    <!-- Line colors -->
    <details>
      <summary>{t('structure.dos_line_styles')}</summary>
      <div class="line-styles">
        <div class="line-style-row">
          <span class="group-label">{t('structure.band_spin_up')}</span>
          <input
            type="color"
            value={band_state.spin_up_color ?? `#64A0FF`}
            class="color-input"
            oninput={(e) => band_state.spin_up_color = (e.target as HTMLInputElement).value}
          />
        </div>
        <div class="line-style-row">
          <span class="group-label">{t('structure.band_spin_down')}</span>
          <input
            type="color"
            value={band_state.spin_down_color ?? `#64A0FF`}
            class="color-input"
            oninput={(e) => band_state.spin_down_color = (e.target as HTMLInputElement).value}
          />
        </div>
        {#if band_state.projections && band_state.projections.length > 0}
          <div class="line-style-row">
            <span class="group-label">{t('structure.band_proj_palette')}</span>
            <select
              value={band_state.proj_palette ?? `default`}
              onchange={(e) => band_state.proj_palette = (e.target as HTMLSelectElement).value as keyof typeof PALETTE_PRESETS}
            >
              {#each PALETTE_ORDER as name}
                <option value={name}>{t(PALETTE_LABEL_KEY[name])}</option>
              {/each}
            </select>
          </div>
          {#each band_state.projections as proj, idx}
            <div class="line-style-row">
              <span class="group-label">{proj.label}</span>
              <input
                type="color"
                value={band_state.proj_colors?.[proj.label] ?? PALETTE_PRESETS[band_state.proj_palette ?? `default`][idx % PALETTE_PRESETS[band_state.proj_palette ?? `default`].length]}
                class="color-input"
                oninput={(e) => band_state.proj_colors = { ...band_state.proj_colors, [proj.label]: (e.target as HTMLInputElement).value }}
              />
            </div>
          {/each}
        {/if}
      </div>
    </details>
```

> Note: `#64A0FF` is the hex form of the default `rgba(100,160,255)` so the color swatch shows the current band color before any edit.

- [ ] **Step 4: Seed band_state with a default projection palette**

In `src/lib/structure/Structure.svelte`, inside the `band_state` initializer object (starts at `:1451`), add a field alongside the existing ones:

```ts
    proj_palette: `default`,
```

(Leave `spin_up_color` / `spin_down_color` / `proj_colors` unset — fallbacks handle them.)

- [ ] **Step 5: Pass the new props to BandPlot**

In `src/lib/structure/Structure.svelte`, in the `<BandPlot bind:this={band_plot_ref} … />` element (near `:5229`), add these attributes alongside the existing ones:

```svelte
          spin_up_color={band_state.spin_up_color}
          spin_down_color={band_state.spin_down_color}
          proj_palette={band_state.proj_palette}
          proj_colors={band_state.proj_colors}
```

- [ ] **Step 6: Type-check (no new errors)**

Run: `pnpm check`
Expected: no NEW errors in `BandAnalysisPane.svelte`, `Structure.svelte`.

- [ ] **Step 7: Live verify**

Compute a band structure (spin-polarized if possible) → new 线型 section: spin-up and spin-down pickers change those band sets to distinct colors (confirms same-blue fix). With projections, the 投影配色 dropdown recolors all projections in order; per-projection swatches override individually.

- [ ] **Step 8: Commit**

```bash
git add src/lib/electronic/BandAnalysisPane.svelte src/lib/structure/Structure.svelte src/lib/i18n/en/structure.ts src/lib/i18n/zh/structure.ts
git commit -m "feat(band): line-color UI (spin + projection palette) + wiring"
```

---

### Task 7: Export DPI — plot `export_image` signatures

**Files:**
- Modify: `src/lib/electronic/DosPlot.svelte:312-321`
- Modify: `src/lib/electronic/CohpPlot.svelte:344-353`
- Modify: `src/lib/electronic/BandPlot.svelte:307-316`

**Interfaces:**
- Consumes: `compute_export_px` (Task 2).
- Produces: each plot's `export_image(format, opts?: { dpi?: number; width_mm?: number })`. The `ElectronicPlotRef` union (`Structure.svelte:1515`) picks this up automatically.

- [ ] **Step 1: Extend DosPlot.export_image**

In `src/lib/electronic/DosPlot.svelte`, add to imports:

```ts
  import { compute_export_px } from './export-dims'
```

Replace `export_image` (`:312-321`):

```ts
  export async function export_image(
    format: `png` | `svg` = `png`,
    opts?: { dpi?: number; width_mm?: number },
  ): Promise<string | null> {
    if (!Plotly || !plot_div) return null
    if (format === `png` && opts?.dpi && opts?.width_mm) {
      const { width, height } = compute_export_px(opts.width_mm, opts.dpi, container_height / 800)
      return await Plotly.toImage(plot_div, { format, width, height, scale: 1 })
    }
    return await Plotly.toImage(plot_div, {
      format,
      width: 800,
      height: container_height,
      scale: 2,
    })
  }
```

- [ ] **Step 2: Extend CohpPlot.export_image**

In `src/lib/electronic/CohpPlot.svelte`, add `import { compute_export_px } from './export-dims'`, then apply the **identical** replacement to `export_image` at `:344-353` (same body as Step 1).

- [ ] **Step 3: Extend BandPlot.export_image**

In `src/lib/electronic/BandPlot.svelte`, add `import { compute_export_px } from './export-dims'`, then apply the **identical** replacement to `export_image` at `:307-316` (same body as Step 1).

- [ ] **Step 4: Type-check (no new errors)**

Run: `pnpm check`
Expected: no NEW errors. Existing callers pass only `format` → `opts` is `undefined` → back-compat `scale:2` path. Confirmed safe.

- [ ] **Step 5: Commit**

```bash
git add src/lib/electronic/DosPlot.svelte src/lib/electronic/CohpPlot.svelte src/lib/electronic/BandPlot.svelte
git commit -m "feat(electronic): optional dpi+width_mm arg on plot export_image"
```

---

### Task 8: Export DPI — control component + wiring

**Files:**
- Create: `src/lib/electronic/ExportDpiControl.svelte`
- Modify: `src/lib/structure/Structure.svelte` — top-level export state, `export_electronic_plot` signature (`:1523-1565`), 3 PNG buttons (`:5050`, `:5158`, `:5214`), render control in each panel-controls div
- Modify: `src/lib/electronic/DosPlotWindow.svelte:66-74` (wrapper), `:100-105` (export bar)
- Modify: `src/lib/i18n/en/structure.ts`, `src/lib/i18n/zh/structure.ts` (export_* keys)

**Interfaces:**
- Consumes: `compute_export_px` (Task 2), plot `export_image(format, opts)` (Task 7).
- Produces: `<ExportDpiControl bind:dpi bind:width_mm />`; `export_electronic_plot(..., export_opts?: { dpi?: number; width_mm?: number })`.

- [ ] **Step 1: Add export i18n keys (en)**

In `src/lib/i18n/en/structure.ts`, after the band keys from Task 6, add:

```ts
  export_settings: `Export (PNG)`,
  export_dpi: `DPI`,
  export_width: `Width`,
  export_width_single: `Single column (88mm)`,
  export_width_double: `Double column (180mm)`,
  export_width_custom: `Custom (mm)`,
```

- [ ] **Step 2: Add export i18n keys (zh)**

In `src/lib/i18n/zh/structure.ts`, after the band keys, add:

```ts
  export_settings: `导出设置 (PNG)`,
  export_dpi: `DPI`,
  export_width: `宽度`,
  export_width_single: `单栏 (88mm)`,
  export_width_double: `双栏 (180mm)`,
  export_width_custom: `自定义 (mm)`,
```

- [ ] **Step 3: Create the ExportDpiControl component**

```svelte
<!-- src/lib/electronic/ExportDpiControl.svelte -->
<script lang="ts">
  import { onMount } from 'svelte'
  import { t } from '$lib/i18n'
  import { compute_export_px } from './export-dims'

  let {
    dpi = $bindable(300),
    width_mm = $bindable(180),
  }: { dpi?: number; width_mm?: number } = $props()

  const DPI_PRESETS = [96, 150, 300, 600]
  const WIDTH_PRESETS = [
    { mm: 88, key: 'structure.export_width_single' },
    { mm: 180, key: 'structure.export_width_double' },
  ]

  // Hydrate once from localStorage (onMount = no effect loop).
  onMount(() => {
    const d = parseFloat(localStorage.getItem('catgo.export.dpi') ?? '')
    const w = parseFloat(localStorage.getItem('catgo.export.width_mm') ?? '')
    if (!Number.isNaN(d)) dpi = d
    if (!Number.isNaN(w)) width_mm = w
  })

  function persist() {
    try {
      localStorage.setItem('catgo.export.dpi', String(dpi))
      localStorage.setItem('catgo.export.width_mm', String(width_mm))
    } catch {}
  }

  // Aspect is plot-dependent; use a representative 0.625 just for the readout.
  const preview = $derived(compute_export_px(width_mm, dpi, 0.625))
  const is_custom = $derived(!WIDTH_PRESETS.some((w) => w.mm === width_mm))
</script>

<details class="export-dpi">
  <summary>{t('structure.export_settings')}</summary>
  <div class="export-dpi-body">
    <div class="row">
      <span>{t('structure.export_dpi')}</span>
      <input
        type="number" min="50" max="1200" step="1" class="num"
        value={dpi}
        onchange={(e) => { dpi = parseFloat((e.target as HTMLInputElement).value) || 300; persist() }}
      />
      {#each DPI_PRESETS as d}
        <button class="chip" class:active={dpi === d} onclick={() => { dpi = d; persist() }}>{d}</button>
      {/each}
    </div>
    <div class="row">
      <span>{t('structure.export_width')}</span>
      <select
        value={is_custom ? 'custom' : String(width_mm)}
        onchange={(e) => {
          const v = (e.target as HTMLSelectElement).value
          if (v !== 'custom') { width_mm = parseFloat(v); persist() }
        }}
      >
        {#each WIDTH_PRESETS as w}
          <option value={String(w.mm)}>{t(w.key)}</option>
        {/each}
        <option value="custom">{t('structure.export_width_custom')}</option>
      </select>
      {#if is_custom}
        <input
          type="number" min="10" step="1" class="num"
          value={width_mm}
          onchange={(e) => { width_mm = parseFloat((e.target as HTMLInputElement).value) || 180; persist() }}
        />
      {/if}
    </div>
    <div class="readout">→ ~{preview.width} × {preview.height} px</div>
  </div>
</details>

<style>
  .export-dpi { font-size: 0.85em; }
  .export-dpi-body { display: flex; flex-direction: column; gap: 6px; padding: 4px 0; }
  .row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .num { width: 64px; }
  .chip { padding: 1px 6px; cursor: pointer; }
  .chip.active { font-weight: 700; text-decoration: underline; }
  .readout { opacity: 0.7; }
</style>
```

- [ ] **Step 4: Add shared export state + thread opts in Structure.svelte**

In `src/lib/structure/Structure.svelte`, add the import:

```ts
  import ExportDpiControl from '$lib/electronic/ExportDpiControl.svelte'
```

Near the other electronic-plot state (around the `dos_state`/`band_state`/`cohp_state` declarations), add:

```ts
  let export_dpi = $state(300)
  let export_width_mm = $state(180)
```

Extend `export_electronic_plot` (`:1523-1529`) with a trailing optional param:

```ts
  async function export_electronic_plot(
    plot_ref: ElectronicPlotRef | undefined,
    format: ExportFormat,
    base_name: string,
    set_status: (value: string | null) => void,
    set_exporting: (value: string | null) => void,
    export_opts?: { dpi?: number; width_mm?: number },
  ) {
```

And at `:1550` replace:

```ts
      const url = await plot_ref.export_image(format)
```

with (the union may type `export_image` as `(format) => …` for CSV-less refs; cast through `any` to pass the optional opts — runtime ignores it for SVG):

```ts
      const url = await (plot_ref.export_image as (
        f: ExportFormat,
        o?: { dpi?: number; width_mm?: number },
      ) => Promise<string | null>)(format, export_opts)
```

- [ ] **Step 5: Wire the 3 PNG buttons + render the control**

In `src/lib/structure/Structure.svelte`, for each of the three panels, (a) pass `export_opts` on the **PNG** button only, and (b) render the control in the panel-controls div.

DOS — replace the PNG button at `:5050`:

```svelte
          <button class="dos-export-btn" disabled={!!dos_exporting} onclick={() => export_electronic_plot(dos_plot_ref, `png`, `dos`, (v) => dos_export_status = v, (v) => dos_exporting = v, { dpi: export_dpi, width_mm: export_width_mm })}>{dos_exporting === `png` ? `...` : `PNG`}</button>
```

and add, right before that PNG button:

```svelte
          <ExportDpiControl bind:dpi={export_dpi} bind:width_mm={export_width_mm} />
```

COHP — apply the same two edits at the COHP PNG button (`:5158`), using `cohp_plot_ref`, `'cohp'`, `cohp_export_status`, `cohp_exporting`.

BAND — apply the same two edits at the band PNG button (`:5214`), using `band_plot_ref`, `'band'`, `band_export_status`, `band_exporting`.

> SVG and CSV buttons are left unchanged (no `export_opts`).

- [ ] **Step 6: Wire DosPlotWindow's own export bar**

In `src/lib/electronic/DosPlotWindow.svelte`, add imports:

```ts
  import ExportDpiControl from './ExportDpiControl.svelte'
```

Add state in the `<script>`:

```ts
  let export_dpi = $state(300)
  let export_width_mm = $state(180)
```

Replace the `export_image` wrapper (`:66-74`):

```ts
  async function export_image(format: `png` | `svg`) {
    if (!dos_plot) return
    const opts = format === `png` ? { dpi: export_dpi, width_mm: export_width_mm } : undefined
    const url = await dos_plot.export_image(format, opts)
    if (!url) return
    const a = document.createElement(`a`)
    a.href = url
    a.download = `dos_plot.${format}`
    a.click()
  }
```

In the export bar (`:100-105`), add the control before the PNG button:

```svelte
    <div class="export-bar">
      <ExportDpiControl bind:dpi={export_dpi} bind:width_mm={export_width_mm} />
      <button class="btn-small" onclick={() => export_image(`png`)}>PNG</button>
      <button class="btn-small" onclick={() => export_image(`svg`)}>SVG</button>
      <button class="btn-small" onclick={export_csv}>CSV</button>
      <button class="btn-small" onclick={export_json}>JSON</button>
    </div>
```

- [ ] **Step 7: Type-check (no new errors)**

Run: `pnpm check`
Expected: no NEW errors in `ExportDpiControl.svelte`, `Structure.svelte`, `DosPlotWindow.svelte`.

- [ ] **Step 8: Live verify**

Open DOS/COHP/band panel → 导出设置 → set 300 dpi / 双栏180mm → readout shows ~2126 px wide → click PNG → saved file's pixel width ≈ readout (height tracks the plot's true aspect). Switch to 单栏88mm or custom and re-export → dimensions scale. Reload app → DPI/width persist (localStorage). SVG export unchanged.

- [ ] **Step 9: Commit**

```bash
git add src/lib/electronic/ExportDpiControl.svelte src/lib/structure/Structure.svelte src/lib/electronic/DosPlotWindow.svelte src/lib/i18n/en/structure.ts src/lib/i18n/zh/structure.ts
git commit -m "feat(electronic): publication DPI x width PNG export control"
```

---

## Final verification (after all tasks)

- [ ] `rtk proxy pnpm exec vitest run tests/vitest/electronic/` — palette + export-dims tests pass.
- [ ] `pnpm check` — no NEW errors beyond the pre-existing gesture baseline.
- [ ] i18n parity: en and zh `structure.ts` both define `palette_*`, `band_spin_up/down`, `band_proj_palette`, `export_*` (same key set).
- [ ] Default look unchanged with no presets/colors/DPI touched (tab10, `scale:2`).
- [ ] Open a PR `feat/plot-colors-dpi` → `main` (only when the user asks).

## Notes / out of scope (from spec)

- Not touching chrome colors (Fermi/gap/grid/ticks/vlines).
- SVG export path unchanged (vector — DPI N/A).
- Saving a hand-tuned palette as a named custom preset — future.
- DPI metadata chunk in the PNG — Plotly writes none; the image is simply rendered at the target pixel size.

# Shared WebGL2/WebGPU Visual Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace duplicated WebGL2/WebGPU visual semantics with one shared visual core, then fix background parity, sleeping-overlay shading updates, and WebGPU shading-buffer teardown in PR #540.

**Architecture:** A backend-neutral TypeScript core resolves color space, background, radii, render style, PBR/toon constants, and visual-state equality. WebGL2 maps that state to Three/GLSL uniforms; WebGPU maps it to uniform buffers and WGSL. A revision-bearing source makes Svelte dependencies visible so a sleeping overlay wakes for semantic changes without continuously rendering.

**Tech Stack:** Svelte 5 runes, TypeScript, Three.js 0.181, WebGL2/GLSL3, WebGPU/WGSL, Vitest, Playwright.

## Global Constraints

- WebGL2 remains the supported fallback on devices without WebGPU.
- Share CPU-side scene semantics, constants, lifecycle revisions, and test vectors.
- Keep GLSL/WGSL and GPU resource binding backend-specific.
- Do not introduce a shader DSL or a general cross-GPU framework.
- Preserve current visual settings and public component behavior.
- Follow strict TDD: every production change requires a failing regression test first.
- Every shell command starts with `rtk`.
- Do not stage or modify `.claude/gate-approvals/`, `.claude/tmp-dump.traj`, or `.superpowers/`.
- Commit after every task and push only after all verification gates pass.

---

## File map

- Create `src/lib/structure/rendering/visual-state.ts`: shared constants, render-style/PBR resolution, state types, equality, and WebGPU matcap fallback.
- Create `src/lib/structure/rendering/background.ts`: computed-CSS parsing, sRGB/linear conversion, and background blending.
- Create `tests/vitest/structure/rendering/visual-state.test.ts`: shared state, mapping, equality, and radius constants.
- Create `tests/vitest/structure/rendering/background.test.ts`: dark-theme and opacity color-space regressions.
- Modify `src/lib/structure/atoms/atom-instanced-renderer.ts`: import the shared radius constant.
- Modify `src/lib/structure/atoms/AtomManagerInstances.svelte`: import shared render-style/PBR mapping.
- Modify `src/lib/structure/gpu/radius-lut.ts`: import the shared radius constant.
- Modify `src/lib/structure/Structure.svelte`: carry the revision-bearing visual source to the overlay.
- Modify `src/lib/structure/StructureScene.svelte`: use the shared background resolver and publish the visual source.
- Modify `src/lib/structure/gpu/LargeSystemOverlay.svelte`: consume shared background/state and wake on revision.
- Modify `src/lib/structure/gpu/large-system-renderer.ts`: use shared state types/constants and destroy the shading buffer.
- Modify `tests/vitest/structure/gpu/large-system-renderer.test.ts`: state packing and teardown.
- Modify `tests/vitest/structure/gpu/large-system-overlay.test.ts`: sleeping overlay wake regression, or add the test there if the branch names the component suite differently.

---

### Task 1: Shared visual-state contract

**Files:**
- Create: `src/lib/structure/rendering/visual-state.ts`
- Create: `tests/vitest/structure/rendering/visual-state.test.ts`

**Interfaces:**
- Produces:
  - `VISUAL_RADIUS_SCALE: 0.5`
  - `TOON_SHADOW_THRESHOLD`, `TOON_HIGHLIGHT_THRESHOLD`, `TOON_SHADOW_BRIGHTNESS`
  - `BackendRenderStyle = 0 | 1 | 2 | 3`
  - `ResolvedVisualShading`
  - `ResolvedVisualState`
  - `VisualStateSource`
  - `render_style_to_backend(style, backend)`
  - `style_pbr(style)`
  - `same_visual_shading(a, b)`

- [ ] **Step 1: Write failing shared-contract tests**

```ts
import { describe, expect, it } from 'vitest'
import {
  VISUAL_RADIUS_SCALE,
  render_style_to_backend,
  same_visual_shading,
  style_pbr,
  type ResolvedVisualShading,
} from '$lib/structure/rendering/visual-state'

const shading = (): ResolvedVisualShading => ({
  light_dir: [0, 0, 1],
  is_ortho: false,
  ambient: 0.6,
  directional: 2.2,
  spec_strength: 1,
  roughness: 0.2,
  metalness: 0,
  render_style: 2,
  outline: 0.2,
  depth_cueing: 0.4,
  depth_near: 1,
  depth_far: 9,
  depth_bg: [0.01, 0.01, 0.01],
  toon_shadow_threshold: 0.3,
  toon_highlight_threshold: 0.97,
  toon_shadow_brightness: 0.5,
})

describe(`shared visual state`, () => {
  it(`owns the single atom display-radius scale`, () => {
    expect(VISUAL_RADIUS_SCALE).toBe(0.5)
  })

  it.each([
    [`glossy`, 0, 0],
    [`metallic`, 0, 0],
    [`matte`, 1, 1],
    [`soft`, 1, 1],
    [`flat`, 1, 1],
    [`toon`, 2, 2],
    [`matcap`, 3, 0],
  ] as const)(`maps %s explicitly for WebGL2 and WebGPU`, (style, webgl, webgpu) => {
    expect(render_style_to_backend(style, `webgl2`)).toBe(webgl)
    expect(render_style_to_backend(style, `webgpu`)).toBe(webgpu)
  })

  it(`resolves one PBR table for both adapters`, () => {
    expect(style_pbr(`metallic`)).toEqual({ roughness: 0.4, metalness: 0.4 })
    expect(style_pbr(`glossy`)).toEqual({ roughness: 0.2, metalness: 0 })
  })

  it(`detects nested-vector changes without reference equality`, () => {
    const a = shading()
    expect(same_visual_shading(a, { ...a, light_dir: [...a.light_dir] })).toBe(true)
    expect(same_visual_shading(a, { ...a, depth_bg: [0.02, 0.01, 0.01] })).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
rtk pnpm vitest run tests/vitest/structure/rendering/visual-state.test.ts
```

Expected: FAIL because `$lib/structure/rendering/visual-state` does not exist.

- [ ] **Step 3: Implement the minimal shared contract**

```ts
import type { RenderStyle } from '$lib/settings'

export const VISUAL_RADIUS_SCALE = 0.5
export const TOON_SHADOW_THRESHOLD = 0.3
export const TOON_HIGHLIGHT_THRESHOLD = 0.97
export const TOON_SHADOW_BRIGHTNESS = 0.5

export type BackendRenderStyle = 0 | 1 | 2 | 3
export type VisualBackend = `webgl2` | `webgpu`

export type ResolvedVisualShading = {
  light_dir: [number, number, number]
  is_ortho: boolean
  ambient: number
  directional: number
  spec_strength: number
  roughness: number
  metalness: number
  render_style: BackendRenderStyle
  outline: number
  depth_cueing: number
  depth_near: number
  depth_far: number
  depth_bg: [number, number, number]
  toon_shadow_threshold: number
  toon_highlight_threshold: number
  toon_shadow_brightness: number
}

export type ResolvedVisualState = {
  shading: ResolvedVisualShading
  background_linear: [number, number, number]
}

export type VisualStateSource = {
  revision: string
  resolve: () => ResolvedVisualState
}

export function render_style_to_backend(
  style: RenderStyle,
  backend: VisualBackend,
): BackendRenderStyle {
  if (style === `toon`) return 2
  if (style === `matte` || style === `soft` || style === `flat`) return 1
  if (style === `matcap`) return backend === `webgl2` ? 3 : 0
  return 0
}

export function style_pbr(style: RenderStyle): { roughness: number; metalness: number } {
  return style === `metallic`
    ? { roughness: 0.4, metalness: 0.4 }
    : { roughness: 0.2, metalness: 0 }
}

export function same_visual_shading(
  a: ResolvedVisualShading,
  b: ResolvedVisualShading,
): boolean {
  return a.light_dir.every((value, idx) => value === b.light_dir[idx]) &&
    a.is_ortho === b.is_ortho &&
    a.ambient === b.ambient &&
    a.directional === b.directional &&
    a.spec_strength === b.spec_strength &&
    a.roughness === b.roughness &&
    a.metalness === b.metalness &&
    a.render_style === b.render_style &&
    a.outline === b.outline &&
    a.depth_cueing === b.depth_cueing &&
    a.depth_near === b.depth_near &&
    a.depth_far === b.depth_far &&
    a.depth_bg.every((value, idx) => value === b.depth_bg[idx]) &&
    a.toon_shadow_threshold === b.toon_shadow_threshold &&
    a.toon_highlight_threshold === b.toon_highlight_threshold &&
    a.toon_shadow_brightness === b.toon_shadow_brightness
}
```

- [ ] **Step 4: Run the test and verify GREEN**

Run the command from Step 2. Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add src/lib/structure/rendering/visual-state.ts tests/vitest/structure/rendering/visual-state.test.ts
rtk git commit -m "refactor(renderer): define shared visual state"
```

---

### Task 2: One background/color-space resolver

**Files:**
- Create: `src/lib/structure/rendering/background.ts`
- Create: `tests/vitest/structure/rendering/background.test.ts`
- Modify: `src/lib/structure/StructureScene.svelte`
- Modify: `src/lib/structure/gpu/LargeSystemOverlay.svelte`

**Interfaces:**
- Produces:
  - `srgb_channel_to_linear(value)`
  - `linear_channel_to_srgb(value)`
  - `parse_computed_background(css)`
  - `find_theme_background(start, target)`
  - `resolve_background_linear(input, target)`
- Consumes: Three `Color`.

- [ ] **Step 1: Write failing dark-theme and blend tests**

```ts
import { Color } from 'three'
import { describe, expect, it } from 'vitest'
import {
  linear_channel_to_srgb,
  parse_computed_background,
  resolve_background_linear,
} from '$lib/structure/rendering/background'

describe(`shared background resolver`, () => {
  it(`parses computed CSS RGB as sRGB and converts exactly once`, () => {
    const parsed = parse_computed_background(`rgb(28, 28, 28)`)
    expect(parsed?.alpha).toBe(1)
    expect(linear_channel_to_srgb(parsed!.linear[0]) * 255).toBeCloseTo(28, 5)
  })

  it.each([0, 0.1, 1])(`resolves opacity %s in linear space`, (opacity) => {
    const out = resolve_background_linear({
      theme_linear: parse_computed_background(`rgb(28, 28, 28)`)!.linear,
      picked: `#808080`,
      opacity,
    }, new Color())
    const expected = opacity === 0 ? 28 : opacity === 1 ? 128 : 50.12
    expect(linear_channel_to_srgb(out.r) * 255).toBeCloseTo(expected, 1)
  })
})
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
rtk pnpm vitest run tests/vitest/structure/rendering/background.test.ts
```

Expected: FAIL because the shared resolver does not exist.

- [ ] **Step 3: Implement the shared resolver**

Use the IEC sRGB transfer functions and keep every returned `Color` in linear
working space. `find_theme_background` walks parents until alpha is at least
`0.5`; transparent roots fall back to black. `resolve_background_linear` lerps
the linear theme and picked colors once.

```ts
export const srgb_channel_to_linear = (value: number): number =>
  value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4)

export const linear_channel_to_srgb = (value: number): number =>
  value <= 0.0031308 ? value * 12.92 : 1.055 * Math.pow(Math.max(0, value), 1 / 2.4) - 0.055
```

The parser must accept comma-separated `rgb()`/`rgba()` forms already emitted
by supported browsers and return `{ linear: [r, g, b], alpha }`.

- [ ] **Step 4: Migrate both consumers**

Delete both local `find_theme_bg` implementations. `StructureScene.svelte`
calls `find_theme_background()` and `resolve_background_linear()` once and
publishes the resulting triple in `ResolvedVisualState.background_linear`.
WebGPU passes that value to `set_background`; WebGL2 passes the same value to
`setClearColor`. The overlay must not inspect the DOM or re-resolve the theme.

- [ ] **Step 5: Run focused tests and verify GREEN**

```bash
rtk pnpm vitest run \
  tests/vitest/structure/rendering/background.test.ts \
  tests/vitest/structure/default-view.test.ts \
  tests/vitest/structure/gpu/large-system-renderer.test.ts
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
rtk git add \
  src/lib/structure/rendering/background.ts \
  src/lib/structure/StructureScene.svelte \
  src/lib/structure/gpu/LargeSystemOverlay.svelte \
  tests/vitest/structure/rendering/background.test.ts
rtk git commit -m "fix(renderer): share linear background resolution"
```

---

### Task 3: Share radius and render-style rules

**Files:**
- Modify: `src/lib/structure/rendering/visual-state.ts`
- Modify: `src/lib/structure/atoms/atom-instanced-renderer.ts`
- Modify: `src/lib/structure/atoms/AtomManagerInstances.svelte`
- Modify: `src/lib/structure/gpu/radius-lut.ts`
- Modify: `tests/vitest/structure/gpu/radius-lut.test.ts`
- Modify: `tests/vitest/structure/rendering/visual-state.test.ts`

**Interfaces:**
- Consumes: `VISUAL_RADIUS_SCALE`, `render_style_to_backend`, `style_pbr`.
- Produces: no new public API.

- [ ] **Step 1: Add failing source-of-truth tests**

Extend the tests to assert all display-radius branches include
`VISUAL_RADIUS_SCALE`, and add a source guard that the legacy atom writer and
WebGPU radius LUT import the constant rather than declaring `0.5` locally.

- [ ] **Step 2: Run tests and verify RED**

```bash
rtk pnpm vitest run \
  tests/vitest/structure/rendering/visual-state.test.ts \
  tests/vitest/structure/gpu/radius-lut.test.ts
```

Expected: FAIL because the consumers still own local constants/mappings.

- [ ] **Step 3: Replace local definitions with imports**

In the WebGL atom writer and WebGPU radius LUT:

```ts
import { VISUAL_RADIUS_SCALE } from '$lib/structure/rendering/visual-state'
```

In `AtomManagerInstances.svelte`, delete its local render-style and PBR
functions and call:

```ts
render_style_to_backend(render_style, `webgl2`)
style_pbr(render_style)
```

The WebGPU state resolver calls the same functions with backend `webgpu`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the Step 2 command plus:

```bash
rtk pnpm vitest run tests/vitest/structure/gpu/webgl2-replica-atoms.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add \
  src/lib/structure/rendering/visual-state.ts \
  src/lib/structure/atoms/atom-instanced-renderer.ts \
  src/lib/structure/atoms/AtomManagerInstances.svelte \
  src/lib/structure/gpu/radius-lut.ts \
  tests/vitest/structure/rendering/visual-state.test.ts \
  tests/vitest/structure/gpu/radius-lut.test.ts
rtk git commit -m "refactor(renderer): share radius and style rules"
```

---

### Task 4: Revision-bearing shading bridge

**Files:**
- Modify: `src/lib/structure/Structure.svelte`
- Modify: `src/lib/structure/StructureScene.svelte`
- Modify: `src/lib/structure/gpu/LargeSystemOverlay.svelte`
- Modify: `src/lib/structure/rendering/visual-state.ts`
- Test: `tests/vitest/structure/gpu/large-system-overlay.test.ts`

**Interfaces:**
- Produces: `VisualStateSource { revision: string; resolve(): ResolvedVisualState }`.
- Consumes: shared style/PBR/toon constants and existing depth-cue uniforms.

- [ ] **Step 1: Write the sleeping-overlay regression test**

Mount the overlay with a fake renderer and a source whose revision changes from
`toon:0` to `toon:1` after the stable-frame sleep threshold. Assert:

1. no RAF remains scheduled after the stable threshold;
2. changing only `source.revision` schedules one RAF;
3. the next frame calls `set_shading` with the new state;
4. republishing an equal revision/state does not keep the loop awake.

- [ ] **Step 2: Run the test and verify RED**

```bash
rtk pnpm vitest run tests/vitest/structure/gpu/large-system-overlay.test.ts
```

Expected: FAIL because getter-internal reads do not wake the sleeping loop.

- [ ] **Step 3: Publish a visible revision**

`StructureScene.svelte` creates a new source whenever semantic inputs change:

```ts
const revision = [
  render_style,
  active_ambient_light,
  active_directional_light,
  active_highlight_strength,
  depth_cueing,
  atom_outline_strength,
  background_color ?? `#000000`,
  background_opacity,
  theme_revision,
].join(`|`)

get_visual_state = {
  revision,
  resolve: resolve_current_visual_shading,
}
```

`resolve_current_visual_state` refreshes camera-dependent depth planes, resolves
the background once through the shared module, and returns
`ResolvedVisualState` using the shared mappings and constants. The existing
theme `MutationObserver` increments `theme_revision` before publishing the new
state so a theme-only change also wakes the overlay.

- [ ] **Step 4: Wake the overlay from the revision**

Replace the opaque `get_shading` prop with `visual_state_source`. Add a Svelte
effect that reads `visual_state_source?.revision`, marks the next frame dirty,
and calls `wake()`. The frame calls `visual_state_source.resolve()`, sends its
background to `set_background`, and relies on `same_visual_shading` to suppress
equal shading uploads.

- [ ] **Step 5: Run the regression and component tests**

```bash
rtk pnpm vitest run \
  tests/vitest/structure/gpu/large-system-overlay.test.ts \
  tests/vitest/structure/gpu/large-system-renderer.test.ts \
  tests/vitest/structure/default-view.test.ts
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
rtk git add \
  src/lib/structure/Structure.svelte \
  src/lib/structure/StructureScene.svelte \
  src/lib/structure/gpu/LargeSystemOverlay.svelte \
  src/lib/structure/rendering/visual-state.ts \
  tests/vitest/structure/gpu/large-system-overlay.test.ts
rtk git commit -m "fix(gpu): wake overlay for shared visual revisions"
```

---

### Task 5: WebGPU state packing and resource teardown

**Files:**
- Modify: `src/lib/structure/gpu/large-system-renderer.ts`
- Modify: `tests/vitest/structure/gpu/large-system-renderer.test.ts`

**Interfaces:**
- Consumes: `ResolvedVisualShading`, `same_visual_shading`.
- Produces: unchanged renderer API `set_shading(state): boolean`.

- [ ] **Step 1: Write failing packing and teardown tests**

Use a fake `GPUDevice`/buffer recorder. Assert the 24-float layout receives the
shared state at offsets `0..22`, and that `destroy()` calls
`shading_buffer.destroy()` exactly once even when renderer teardown is repeated.

- [ ] **Step 2: Run the tests and verify RED**

```bash
rtk pnpm vitest run tests/vitest/structure/gpu/large-system-renderer.test.ts
```

Expected: teardown assertion FAIL because the shading buffer is not destroyed.

- [ ] **Step 3: Use shared equality and explicit teardown**

Replace the hand-written state comparator with `same_visual_shading`. Preserve
the existing WGSL layout. Add:

```ts
shading_buffer.destroy()
```

to the renderer's guarded `destroy()` path beside the other owned uniform
buffers.

- [ ] **Step 4: Run the tests and verify GREEN**

Run the Step 2 command. Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add \
  src/lib/structure/gpu/large-system-renderer.ts \
  tests/vitest/structure/gpu/large-system-renderer.test.ts
rtk git commit -m "fix(gpu): release shared shading resources"
```

---

### Task 6: Cross-backend acceptance gates

**Files:**
- Modify only if a gate exposes a regression.

- [ ] **Step 1: Run focused renderer tests**

```bash
rtk pnpm vitest run \
  tests/vitest/structure/rendering/visual-state.test.ts \
  tests/vitest/structure/rendering/background.test.ts \
  tests/vitest/structure/gpu/radius-lut.test.ts \
  tests/vitest/structure/gpu/large-system-overlay.test.ts \
  tests/vitest/structure/gpu/large-system-renderer.test.ts \
  tests/vitest/structure/gpu/webgl2-replica-atoms.test.ts
```

Expected: all tests PASS.

- [ ] **Step 2: Run the structure GPU suite**

```bash
rtk pnpm vitest run tests/vitest/structure/gpu
```

Expected: all non-device-gated tests PASS; device-only tests may skip when
`navigator.gpu` is unavailable.

- [ ] **Step 3: Run full frontend and typecheck**

```bash
rtk pnpm test
rtk pnpm check
```

Expected: test suite PASS; `svelte-check` reports 0 errors.

- [ ] **Step 4: Run browser visual checks**

On a WebGPU-capable browser:

1. load the same dark-theme structure in normal and large-system mode;
2. test background opacity `0`, `0.1`, and `1`;
3. verify toon, glossy, and metallic settings;
4. let the overlay sleep, change style, and confirm it repaints immediately;
5. orbit/zoom and toggle the overlay repeatedly;
6. confirm no WebGL/WebGPU validation errors and no increasing live-buffer count.

- [ ] **Step 5: Verify repository hygiene**

```bash
rtk git diff --check
rtk git status --short
```

Expected: no unstaged production changes and none of the protected paths staged.

- [ ] **Step 6: Update PR #540**

Push `feat/large-system-shading-parity`, update the PR description with shared
architecture and verification counts, and leave the worktree intact for review.

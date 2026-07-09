# Polyhedra Render Styles (flat / matte / glass) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the new "glassy" polyhedra face shading one selectable mode among three (`flat` / `matte` / `glass`), default `flat` (the classic pre-52f2993c look).

**Architecture:** One new enum setting `polyhedra_style` flows Settings → StructureScene prop → CoordinationPolyhedra prop → a `u_style` int uniform branching a single fragment shader. Geometry is untouched (the `face_normals` attribute stays; the flat branch recomputes facet normals from screen-space derivatives). Fat `LineSegments2` edges stay shared across all modes; the edge-color default reverts to dark `#333333` to suit the flat default.

**Tech Stack:** Svelte 5 (runes), Threlte 8, Three.js ShaderMaterial (GLSL), vitest.

## Global Constraints

- Branch: `feat/polyhedra-elegance` (work directly on it; spec committed there).
- Formatting: local pre-commit hook runs `deno fmt` — single quotes, no semicolons, 2-space indent, 90-col. Let the hook format, then re-stage (`.svelte` files excluded from deno fmt).
- Svelte 5 runes only (`$state` / `$derived` / `$effect` / `$props`), no legacy stores.
- i18n: `src/lib/i18n/{en,zh}/structure.ts` key sets MUST stay in parity.
- Vitest: CI only collects `tests/vitest/**` and `src/**/__tests__/**` — put the new test under `tests/vitest/`. RTK serves stale vitest output — always run via `rtk proxy pnpm exec vitest run …`.
- Default style MUST be `flat`; flat must reproduce the pre-52f2993c look (facet normals + headlamp lambert `0.3 + 0.7·ndotl`, raw element color).

---

### Task 1: `PolyhedraStyle` type, `polyhedra_style` setting, shader-int helper

**Files:**
- Modify: `src/lib/settings/types.ts` (near line 59–63: polyhedra mode types; and line ~263: `SettingsConfig` polyhedra entries)
- Modify: `src/lib/settings/config.ts` (polyhedra block ~line 662–770)
- Modify: `src/lib/structure/polyhedra.ts` (append helper)
- Test: `tests/vitest/structure/polyhedra-style.test.ts` (new)

**Interfaces:**
- Consumes: existing `SettingType<T>` pattern (see `polyhedra_color_mode`), `SETTINGS_CONFIG` / `DEFAULTS` re-exported from `$lib/settings` (`DEFAULTS` auto-derives from `SETTINGS_CONFIG` in `defaults.ts` — no manual defaults work).
- Produces: `polyhedra_styles` const + `PolyhedraStyle` type exported from `$lib/settings`; `polyhedra_style_to_int(style: PolyhedraStyle): 0 | 1 | 2` exported from `$lib/structure/polyhedra`; `SETTINGS_CONFIG.structure.polyhedra_style` with default `flat`.

- [ ] **Step 1: Write the failing test**

Create `tests/vitest/structure/polyhedra-style.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { polyhedra_styles, SETTINGS_CONFIG } from '$lib/settings'
import { polyhedra_style_to_int } from '$lib/structure/polyhedra'

describe(`polyhedra_style_to_int`, () => {
  it(`maps each style to its shader int`, () => {
    expect(polyhedra_style_to_int(`flat`)).toBe(0)
    expect(polyhedra_style_to_int(`matte`)).toBe(1)
    expect(polyhedra_style_to_int(`glass`)).toBe(2)
  })
})

describe(`polyhedra_style setting`, () => {
  it(`defaults to flat and enumerates all three styles`, () => {
    expect(SETTINGS_CONFIG.structure.polyhedra_style.value).toBe(`flat`)
    expect(Object.keys(SETTINGS_CONFIG.structure.polyhedra_style.enum ?? {})).toEqual([
      ...polyhedra_styles,
    ])
  })

  it(`defaults polyhedra edges to dark #333333 (suits the flat default)`, () => {
    expect(SETTINGS_CONFIG.structure.polyhedra_edge_color.value).toBe(`#333333`)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk proxy pnpm exec vitest run tests/vitest/structure/polyhedra-style.test.ts`
Expected: FAIL — `polyhedra_styles` / `polyhedra_style_to_int` not exported, `polyhedra_style` undefined, edge color is `#cfd6e2`.

- [ ] **Step 3: Implement**

`src/lib/settings/types.ts` — after the `polyhedra_color_modes` pair (line ~63):

```ts
export const polyhedra_styles = [`flat`, `matte`, `glass`] as const
export type PolyhedraStyle = (typeof polyhedra_styles)[number]
```

Same file, in the `SettingsConfig` structure block next to `polyhedra_color_mode: SettingType<PolyhedraColorMode>` (line ~263):

```ts
polyhedra_style: SettingType<PolyhedraStyle>
```

`src/lib/settings/config.ts` — insert directly after the `polyhedra_metals_only` entry (before `polyhedra_color_mode`):

```ts
polyhedra_style: {
  value: `flat` as const,
  description:
    `Polyhedra face rendering: classic flat facets, smooth matte, or frosted glass`,
  enum: {
    flat: `Flat`,
    matte: `Smooth Matte`,
    glass: `Glass`,
  },
},
```

Same file, revert the edge-color default (`polyhedra_edge_color`): `value: '#cfd6e2'` → `value: '#333333'`.

`src/lib/structure/polyhedra.ts` — append at end of file:

```ts
/** Map a polyhedra render style to the face shader's u_style int. */
export function polyhedra_style_to_int(
  style: import('$lib/settings').PolyhedraStyle,
): 0 | 1 | 2 {
  return style === `glass` ? 2 : style === `matte` ? 1 : 0
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `rtk proxy pnpm exec vitest run tests/vitest/structure/polyhedra-style.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/settings/types.ts src/lib/settings/config.ts src/lib/structure/polyhedra.ts tests/vitest/structure/polyhedra-style.test.ts
git commit -m "feat(viewer): polyhedra_style setting (flat/matte/glass, default flat) + dark edge default"
```

(If the deno fmt pre-commit hook rewrites the `.ts` files, re-stage and commit again.)

---

### Task 2: Shader branch + scene threading

**Files:**
- Modify: `src/lib/structure/CoordinationPolyhedra.svelte` (props, fragment shader, uniforms, `$effect`)
- Modify: `src/lib/structure/StructureScene.svelte` (Props interface polyhedra block ~line 913–932; destructure defaults ~line 647–656; `<CoordinationPolyhedra …/>` at ~line 5401)

**Interfaces:**
- Consumes: `PolyhedraStyle` type from `$lib/settings`, `polyhedra_style_to_int` from `./polyhedra` (Task 1).
- Produces: `CoordinationPolyhedra` prop `render_style?: PolyhedraStyle` (default `flat`); `StructureScene` prop `polyhedra_style?: PolyhedraStyle` (default `flat`) — Task 3's control binds `scene_props.polyhedra_style`.

- [ ] **Step 1: CoordinationPolyhedra.svelte — prop + shader + uniform**

Import type (extend the existing settings type import) and helper:

```ts
import type { PolyhedraOpacityMode, PolyhedraStyle } from '$lib/settings'
import { polyhedra_style_to_int } from './polyhedra'
import type { MergedPolyhedraGeometry } from './polyhedra'
```

Add prop (destructure + type, next to `whiteness`):

```ts
render_style = `flat` as PolyhedraStyle,
```

```ts
render_style?: PolyhedraStyle
```

Replace `face_fragment_shader` with:

```glsl
uniform float u_opacity;
uniform float u_opacity_near;
uniform float u_opacity_far;
uniform int u_opacity_mode;
uniform float u_depth_min;
uniform float u_depth_max;
uniform float u_whiteness;
uniform vec3 u_camera_pos;
uniform int u_style; // 0 = flat facets, 1 = smooth matte, 2 = frosted glass

varying vec3 vColor;
varying vec3 vWorldPosition;
varying vec3 vNormal;

void main() {
  vec3 V = normalize(u_camera_pos - vWorldPosition);

  // flat: hard facet normal from screen-space derivatives (classic look);
  // matte/glass: smooth radial normal (soft gradient).
  vec3 N;
  if (u_style == 0) {
    N = normalize(cross(dFdx(vWorldPosition), dFdy(vWorldPosition)));
  } else {
    N = normalize(vNormal);
  }
  float NdotV = abs(dot(N, V));

  vec3 color;
  float fresnel = 0.0;
  if (u_style == 0) {
    // Classic headlamp lambert on raw element color.
    color = vColor * (0.3 + 0.7 * NdotV);
  } else if (u_style == 1) {
    // Smooth matte: soft diffuse, raw color, no tint/rim/spec.
    color = vColor * (0.62 + 0.38 * NdotV);
  } else {
    // Frosted glass: white-lifted tint + Fresnel rim glow + specular sheen.
    vec3 tint = mix(vColor, vec3(1.0), u_whiteness);
    float diffuse = 0.62 + 0.38 * NdotV;
    fresnel = pow(1.0 - NdotV, 2.5);
    float spec = pow(NdotV, 26.0) * 0.35;
    color = tint * diffuse + vec3(1.0) * (fresnel * 0.45 + spec);
  }

  // Base opacity (uniform or depth-graded).
  float alpha;
  if (u_opacity_mode == 0) {
    alpha = u_opacity;
  } else {
    float dist = distance(u_camera_pos, vWorldPosition);
    float t = clamp((dist - u_depth_min) / (u_depth_max - u_depth_min + 0.001), 0.0, 1.0);
    alpha = mix(u_opacity_near, u_opacity_far, t);
  }
  // Glass only: densify the rim so silhouettes read as glass edges
  // (fresnel stays 0.0 in flat/matte, so this is a no-op there).
  alpha = mix(alpha, min(1.0, alpha + 0.3), fresnel);

  gl_FragColor = vec4(color, alpha);
}
```

Add uniform to the `ShaderMaterial` uniforms object:

```ts
u_style: { value: 0 },
```

Add to the existing uniform-sync `$effect` (before `needsUpdate`):

```ts
face_material.uniforms.u_style.value = polyhedra_style_to_int(render_style)
```

Vertex shader and geometry untouched (`polyNormal`/`vNormal` still computed; flat ignores it).

- [ ] **Step 2: StructureScene.svelte — thread the prop**

Props interface, next to `polyhedra_color_mode?: …` in the `// Polyhedra visualization` block:

```ts
polyhedra_style?: import('$lib/settings').PolyhedraStyle
```

Destructure defaults, next to `polyhedra_color_mode = …` (~line 647):

```ts
polyhedra_style = `flat` as import('$lib/settings').PolyhedraStyle,
```

`<CoordinationPolyhedra …/>` instantiation (~line 5401), add:

```svelte
render_style={polyhedra_style}
```

- [ ] **Step 3: Type-check**

Run: `pnpm check`
Expected: 0 errors (pre-existing warnings OK).

- [ ] **Step 4: Commit**

```bash
git add src/lib/structure/CoordinationPolyhedra.svelte src/lib/structure/StructureScene.svelte
git commit -m "feat(viewer): u_style shader branch — flat/matte/glass polyhedra faces"
```

---

### Task 3: Controls UI + i18n

**Files:**
- Modify: `src/lib/structure/StructureControls.svelte` (polyhedra `SettingsSection` ~line 1254–1457)
- Modify: `src/lib/i18n/en/structure.ts` (polyhedra keys ~line 72–90)
- Modify: `src/lib/i18n/zh/structure.ts` (same keys, keep parity)

**Interfaces:**
- Consumes: `scene_props.polyhedra_style` (typed via StructureScene Props from Task 2), `DEFAULTS.structure.polyhedra_style` (auto-derived from Task 1's setting).
- Produces: user-facing select; i18n keys `polyhedra_style_label`, `style_flat`, `style_matte`, `style_glass`.

- [ ] **Step 1: i18n keys**

`src/lib/i18n/en/structure.ts`, after `polyhedra_centers_auto: 'Auto',`:

```ts
polyhedra_style_label: `Style`,
style_flat: `Flat`,
style_matte: `Smooth Matte`,
style_glass: `Glass`,
```

`src/lib/i18n/zh/structure.ts`, same position:

```ts
polyhedra_style_label: `样式`,
style_flat: `经典平面`,
style_matte: `平滑哑光`,
style_glass: `玻璃`,
```

- [ ] **Step 2: Controls select + reset + current_values**

`StructureControls.svelte`, inside `{#if scene_props.show_polyhedra}` directly after the centers `{#if available_elements.length}…{/if}` block (before the `min_coordination` label):

```svelte
<label>
  {t(`structure.polyhedra_style_label`)}
  <select bind:value={scene_props.polyhedra_style}>
    <option value="flat">{t(`structure.style_flat`)}</option>
    <option value="matte">{t(`structure.style_matte`)}</option>
    <option value="glass">{t(`structure.style_glass`)}</option>
  </select>
</label>
```

Add to the section's `current_values` object (after `polyhedra_color_mode: …`):

```ts
polyhedra_style: scene_props.polyhedra_style,
```

Add to the section's `on_reset` (after the `polyhedra_color_mode` reset line):

```ts
scene_props.polyhedra_style = DEFAULTS.structure.polyhedra_style
```

- [ ] **Step 3: Type-check + full unit tests**

Run: `pnpm check`
Expected: 0 errors.

Run: `rtk proxy pnpm exec vitest run`
Expected: all green (4400+ tests, includes the new polyhedra-style tests).

- [ ] **Step 4: Commit**

```bash
git add src/lib/structure/StructureControls.svelte src/lib/i18n/en/structure.ts src/lib/i18n/zh/structure.ts
git commit -m "feat(viewer): polyhedra style select (flat/matte/glass) + i18n"
```

---

### Task 4: Live visual verification

**Files:** none (verification only).

**Interfaces:**
- Consumes: the running dev app; a polyhedra-bearing structure (e.g. rutile TiO₂ or any perovskite demo structure in the app's library).

- [ ] **Step 1: Start dev stack** (do NOT kill anything on :8000 — shared box)

Frontend-only is enough for shader verification: `pnpm desktop:dev` per worktree conventions, or `pnpm desktop:serve` if a full stack isn't already running.

- [ ] **Step 2: Screenshot all three modes**

Load a structure with coordination polyhedra, enable Show Polyhedra, then via the new Style select capture one screenshot per mode (agent-browser or chrome-devtools screenshot):
- `flat` (default on fresh state): hard facets, raw colors, dark edges — must match pre-52f2993c look.
- `matte`: smooth soft gradient, raw colors, no white lift, no rim glow.
- `glass`: identical to current 52f2993c look (white-lifted, rim glow, sheen).

Also confirm: switching modes repaints immediately (threlte invalidate), edge width slider still works in all modes, section Reset returns style to `flat`.

- [ ] **Step 3: Report** — show the three screenshots to the user for final sign-off.

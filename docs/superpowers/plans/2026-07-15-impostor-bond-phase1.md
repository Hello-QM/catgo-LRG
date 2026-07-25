# Impostor Bond — Phase 1 (core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render trajectory-playback bonds as ray-cylinder impostors (12 tris/bond) instead of the 16-seg CylinderGeometry, on the existing `gpu_active` path, and measure the absolute cached-lap fps against the 27.8 baseline on a real 52k-half-bond trajectory.

**Architecture:** A second `ShaderMaterial` (impostor) reuses #524's per-instance attributes (`a_site`/`a_jimage`/`a_half`) and uniforms (`uPosTex`/`uLattice`/`uHideIncomplete`/`uStubMode`/`uStubScale`/`uMaxBondLength` + all lighting uniforms). When `gpu_active`, the geometry `$derived` swaps CylinderGeometry for an oriented-bounding-box base and the mesh uses the impostor material; the vertex shader builds a half-bond OBB (intra-cell or periodic stub, at parity with #524), the fragment shader ray-casts the half-cylinder and feeds the **existing** studio_env/ACES/depth-cue/outline/colour code. Everything not `gpu_active` (static, multibond, image-atom, transparent) is unchanged mesh.

**Tech Stack:** Svelte 5 runes, Threlte 8 / Three.js r181 (WebGL2, GLSL3), Vitest.

## Global Constraints

- Formatting: `deno fmt` — single quotes, no semicolons, 2-space indent, 90-col. Let the pre-commit hook format; re-stage after.
- Svelte 5 runes only (`$state`/`$derived`/`$effect`/`$props`), no legacy stores.
- The `gpu_active` `$derived` already exists (`BondManagerInstances.svelte`): `gpu_transform_active && !multibond_enabled && (image_atom_layout===null || n_image_atoms===0) && !__catgo_disable_gpu_bonds`. Phase 1 adds NO new eligibility — impostor renders exactly when `gpu_active` is true.
- `atom_positions` gets a fresh identity every playback frame. Any geometry/derived that reads it MUST read length/count `untrack`ed (mirror the segment-LOD `geometry` derived) — a tracked read rebuilds the mesh every frame.
- Impostor writes `gl_FragDepth`; keep `logarithmicDepthBuffer` off for this material (CatGo's renderer does not enable it — verify in Task 6).
- Reuse the spike's verified GLSL (`e2e/impostor-spike/impostor.js`) as the math source: OBB proxy, Koradi ray-cylinder, analytic caps, radial normal, analytic `gl_FragDepth`, coverage AA (side-wall via ray-to-axis distance, cap via hit radial distance), `alphaToCoverage`.

---

### Task 1: Geometry-mode selector (pure function)

**Files:**
- Create: `src/lib/structure/bonding/bond-geometry-mode.ts`
- Test: `tests/vitest/structure/bonding/bond-geometry-mode.test.ts`

**Interfaces:**
- Produces: `bond_geometry_mode(gpu_active: boolean, n_atoms: number, playing: boolean): 'impostor' | 'cylinder'` and `bond_cylinder_segments` re-exported from `bond-lod.ts`. When `gpu_active` → `'impostor'`; else `'cylinder'` (segments still chosen by `bond_lod_segments`). Separated from `bond_lod_segments` so the geometry `$derived` composes both.

- [ ] **Step 1: Write the failing test**

```typescript
import { bond_geometry_mode } from '$lib/structure/bonding/bond-geometry-mode'
import { describe, expect, test } from 'vitest'

describe(`bond_geometry_mode`, () => {
  test(`gpu_active selects impostor regardless of size`, () => {
    expect(bond_geometry_mode(true, 20000, true)).toBe(`impostor`)
    expect(bond_geometry_mode(true, 100, true)).toBe(`impostor`)
  })
  test(`not gpu_active selects cylinder (static / ineligible)`, () => {
    expect(bond_geometry_mode(false, 20000, true)).toBe(`cylinder`)
    expect(bond_geometry_mode(false, 20000, false)).toBe(`cylinder`)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk proxy pnpm exec vitest run tests/vitest/structure/bonding/bond-geometry-mode.test.ts`
Expected: FAIL — cannot resolve `bond-geometry-mode`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// Geometry selection for bond rendering. The impostor (a ray-cast OBB) is
// used exactly on the GPU-transform playback path (gpu_active); everything
// else keeps the CylinderGeometry mesh (segment count from bond_lod_segments).
export function bond_geometry_mode(
  gpu_active: boolean,
  _n_atoms: number,
  _playing: boolean,
): 'impostor' | 'cylinder' {
  return gpu_active ? 'impostor' : 'cylinder'
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `rtk proxy pnpm exec vitest run tests/vitest/structure/bonding/bond-geometry-mode.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/structure/bonding/bond-geometry-mode.ts tests/vitest/structure/bonding/bond-geometry-mode.test.ts
git commit -m "feat(bonds): geometry-mode selector — impostor on gpu_active, else cylinder"
```

---

### Task 2: OBB base geometry + geometry `$derived` impostor branch

**Files:**
- Modify: `src/lib/structure/bonding/BondManagerInstances.svelte` (imports; the `geometry` `$derived` added in the segment-LOD change)

**Interfaces:**
- Consumes: `bond_geometry_mode` (Task 1), `bond_lod_segments` (existing).
- Produces: `geometry` `$derived` returns a unit-OBB `BoxGeometry` when `gpu_active`, else the LOD CylinderGeometry. The OBB base is `BoxGeometry(2,2,2)` centered (corners x,y,z ∈ [-1,1]); the vertex shader maps it onto each half-bond.

- [ ] **Step 1: Add the import**

In the import block (beside `bond_lod_segments`):

```svelte
  import { bond_geometry_mode } from './bond-geometry-mode'
```

- [ ] **Step 2: Extend the geometry `$derived`**

Replace the segment-LOD `geometry` `$derived` with (tracks `gpu_active` + `bond_radius`; reads atom count untracked — same discipline):

```svelte
  const _unit_obb = new BoxGeometry(2, 2, 2) // corners x,y,z in [-1,1]
  const geometry = $derived.by(() => {
    const active = gpu_active
    const radius = bond_radius
    if (active) return _unit_obb // impostor maps the box per half-bond in the shader
    const segments = untrack(() =>
      bond_lod_segments(atom_positions.length / 3, gpu_transform_active)
    )
    return new CylinderGeometry(radius, radius, 1, segments)
  })
```

Note: the OBB base is shared (constant) — its per-half placement is entirely in the vertex shader, so `bond_radius` changes reach the impostor via the `uBondRadius` uniform (Task 5), not a geometry rebuild. The CylinderGeometry branch still rebuilds on radius/segment change as before.

- [ ] **Step 3: Type-check**

Run: `pnpm check 2>&1 | grep -c "Error:"`
Expected: `0`.

- [ ] **Step 4: Commit**

```bash
git add src/lib/structure/bonding/BondManagerInstances.svelte
git commit -m "feat(bonds): OBB base geometry on gpu_active, cylinder otherwise"
```

Note: the mesh renders wrong (raw boxes) until Tasks 3-5 add the impostor material. That is expected mid-plan; do not fix by reverting. The next tasks make the boxes render as cylinders.

---

### Task 3: Impostor vertex shader (half-bond OBB + stub)

**Files:**
- Modify: `src/lib/structure/bonding/BondManagerInstances.svelte` (add `impostor_vertex_shader` const beside `vertex_shader`)

**Interfaces:**
- Consumes: instanced attributes `a_site` (vec2), `a_jimage` (vec3 i8), `a_half` (float), plus `position` (OBB corner). Uniforms `uPosTex`, `uNAtoms`, `uLattice`, `uHideIncomplete`, `uMaxBondLength`, `uStubMode`, `uStubScale`, `uBondRadius`, `projectionMatrix`, `modelViewMatrix`, `uInvProjection`, `uViewport`.
- Produces (flat/varying to fragment): `vColorStart`, `vColorEnd`, `vOpacity` (reuse existing instance attrs `instance_color_start/end`, `instance_opacity`); `flat vImpBase` (view-space anchor of the half-cylinder), `flat vImpAxis` (view-space axis, length = half-cylinder length), `flat vImpRadiusSq`, `flat vImpLen`, `flat vImpCollapse` (1 = zero-scale this instance).

- [ ] **Step 1: Add the impostor vertex shader**

This mirrors #524's `uGpuXform` branch geometry (endpoint fetch, `b_eff`, intra-cell mid, periodic paired-stub, collapse) but emits an OBB corner and passes the half-cylinder's view-space frame to the fragment stage instead of computing a surface normal. Add beside `vertex_shader`:

```svelte
  const impostor_vertex_shader = `
    attribute vec3 instance_color_start;
    attribute vec3 instance_color_end;
    attribute float instance_opacity;
    attribute vec2 a_site;
    attribute vec3 a_jimage;
    attribute float a_half;
    uniform sampler2D uPosTex;
    uniform float uNAtoms;
    uniform mat3 uLattice;
    uniform float uHideIncomplete;
    uniform float uMaxBondLength;
    uniform float uStubMode;
    uniform float uStubScale;
    uniform float uBondRadius;
    uniform mat4 uInvProjection;
    varying vec3 vColorStart;
    varying vec3 vColorEnd;
    varying float vOpacity;
    flat varying vec3 vImpBase;     // view-space half-cylinder base (anchor)
    flat varying vec3 vImpAxis;     // view-space axis, length = half-cyl length
    flat varying float vImpRadiusSq;
    flat varying float vImpLen;
    flat varying float vImpCollapse;

    void main() {
      vColorStart = instance_color_start;
      vColorEnd = instance_color_end;
      vOpacity = instance_opacity;

      int ia = int(a_site.x + 0.5);
      int ib = int(a_site.y + 0.5);
      ivec2 sa = ivec2(ia & ${1024 - 1}, ia >> 10);
      ivec2 sb = ivec2(ib & ${1024 - 1}, ib >> 10);
      vec3 pa = texelFetch(uPosTex, sa, 0).xyz;
      vec3 pb_base = texelFetch(uPosTex, sb, 0).xyz;
      bool periodic = dot(abs(a_jimage), vec3(1.0)) > 0.5;
      vec3 pb = periodic ? pb_base + uLattice * a_jimage : pb_base;
      vec3 d = pb - pa;
      float len = length(d);

      // Collapse (zero-scale) under the same conditions as #524: endpoint past
      // the live buffer, degenerate/over-cap length, or cross-cell under
      // hide_incomplete.
      bool collapse = a_site.x >= uNAtoms || a_site.y >= uNAtoms ||
        !(len > 1e-6) || len > uMaxBondLength ||
        (periodic && uHideIncomplete > 0.5);
      vImpCollapse = collapse ? 1.0 : 0.0;
      if (collapse) {
        gl_Position = vec4(0.0, 0.0, 2.0, 1.0); // off-screen (clipped)
        vImpBase = vec3(0.0); vImpAxis = vec3(0.0, 0.0, 1.0);
        vImpRadiusSq = 0.0; vImpLen = 0.0;
        return;
      }

      vec3 dir = d / len;
      // Deterministic ⊥ basis (same roll-arbitrary choice as #524).
      vec3 ref = abs(dir.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
      vec3 xb = normalize(cross(ref, dir));
      vec3 zb = cross(xb, dir);
      float half_len = 0.5 * len;

      // Object-space half-cylinder endpoints (base → tip along dir).
      vec3 obj_base;   // the capped/anchored end
      vec3 obj_tip;    // the mid (or stub) end
      if (periodic) {
        // Phase 6 outward paired stubs (hide OFF; hide ON collapsed above).
        float stub_len = half_len * (uStubMode > 0.5 ? uStubScale : 1.0);
        if (a_half < 0.5) { obj_base = pa;      obj_tip = pa + dir * stub_len; }
        else              { obj_base = pb_base; obj_tip = pb_base - dir * stub_len; }
      } else {
        // Intra-cell: half A spans pa..mid, half B spans mid..pb.
        vec3 mid = 0.5 * (pa + pb);
        if (a_half < 0.5) { obj_base = pa; obj_tip = mid; }
        else              { obj_base = pb; obj_tip = mid; }
      }

      float R = uBondRadius * 1.3; // AA padding shell (ray-cast uses true radius)
      float cyl_len = length(obj_tip - obj_base);
      vec3 cyl_dir = (obj_tip - obj_base) / max(cyl_len, 1e-6);
      // OBB corner: base + (±R)⊥ + (0..len)axis. position ∈ [-1,1]^3 → remap
      // z from [-1,1] to [0,1] so the box spans base→tip.
      float za = position.z * 0.5 + 0.5;
      vec3 corner = obj_base
        + xb * (position.x * R)
        + zb * (position.y * R)
        + cyl_dir * (za * cyl_len);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(corner, 1.0);

      // View-space half-cylinder frame for the fragment ray-cast.
      vImpBase = (modelViewMatrix * vec4(obj_base, 1.0)).xyz;
      vImpAxis = (modelViewMatrix * vec4(obj_tip - obj_base, 0.0)).xyz;
      vImpLen = length(vImpAxis);
      float vr = uBondRadius * length(modelViewMatrix[0].xyz);
      vImpRadiusSq = vr * vr;
    }
  `
```

- [ ] **Step 2: Type-check (shader is a string; verify no Svelte/TS break)**

Run: `pnpm check 2>&1 | grep -c "Error:"`
Expected: `0`.

- [ ] **Step 3: Commit**

```bash
git add src/lib/structure/bonding/BondManagerInstances.svelte
git commit -m "feat(bonds): impostor vertex shader — half-bond OBB + periodic stub"
```

---

### Task 4: Impostor fragment shader (ray-cast + AA + reuse lighting)

**Files:**
- Modify: `src/lib/structure/bonding/BondManagerInstances.svelte` (add `impostor_fragment_shader`; it embeds the existing `studio_env`/`aces_tonemap`/`linearTosRGB` helpers verbatim from `fragment_shader`)

**Interfaces:**
- Consumes: the flat varyings from Task 3 + all fragment lighting uniforms already on the material (`ambientIntensity`, `directionalIntensity`, `saturation`, `brightness`, `uOpacity`, `uLightDir`, `uSpecStrength`, `uDepthCueing`, `uDepthNear`, `uDepthFar`, `uDepthCueBgColor`, `uBondOutlineStrength`), plus `projectionMatrix`, `uInvProjection`, `uViewport`.
- Produces: `gl_FragColor` with lit colour (via reused `studio_env`) and coverage in alpha (alphaToCoverage), `gl_FragDepth` = analytic surface depth.

- [ ] **Step 1: Add the impostor fragment shader**

Ports the spike's Koradi ray-cast + caps + coverage AA, computes the axial parameter for the existing colour gradient, and calls the **same** studio_env lighting the mesh uses (copy `studio_env`/`aces_tonemap`/`linearTosRGB` bodies verbatim from `fragment_shader`):

```svelte
  const impostor_fragment_shader = `
    uniform float ambientIntensity;
    uniform float directionalIntensity;
    uniform float saturation;
    uniform float brightness;
    uniform float uOpacity;
    uniform float uDepthCueing;
    uniform float uDepthNear;
    uniform float uDepthFar;
    uniform vec3 uDepthCueBgColor;
    uniform float uBondOutlineStrength;
    uniform vec3 uLightDir;
    uniform float uSpecStrength;
    uniform mat4 projectionMatrix;
    uniform mat4 uInvProjection;
    uniform vec2 uViewport;
    varying vec3 vColorStart;
    varying vec3 vColorEnd;
    varying float vOpacity;
    flat varying vec3 vImpBase;
    flat varying vec3 vImpAxis;
    flat varying float vImpRadiusSq;
    flat varying float vImpLen;
    flat varying float vImpCollapse;

    vec3 linearTosRGB(vec3 linear) {
      return vec3(
        linear.r <= 0.0031308 ? linear.r * 12.92 : 1.055 * pow(linear.r, 1.0/2.4) - 0.055,
        linear.g <= 0.0031308 ? linear.g * 12.92 : 1.055 * pow(linear.g, 1.0/2.4) - 0.055,
        linear.b <= 0.0031308 ? linear.b * 12.92 : 1.055 * pow(linear.b, 1.0/2.4) - 0.055
      );
    }
    vec3 studio_env(vec3 n, vec3 keyDir) {
      vec3 col = vec3(0.72);
      float k = max(dot(n, keyDir), 0.0);
      col += vec3(1.00, 0.97, 0.92) * (k * k) * 0.35;
      float sky = n.y * 0.5 + 0.5;
      col += vec3(0.06, 0.06, 0.07) * sky;
      return col;
    }
    vec3 aces_tonemap(vec3 x) {
      return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
    }

    void main() {
      if (vImpCollapse > 0.5) discard;

      // View-space ray through this pixel.
      vec2 ndc = (gl_FragCoord.xy / uViewport) * 2.0 - 1.0;
      vec4 near = uInvProjection * vec4(ndc, -1.0, 1.0);
      vec4 far  = near + uInvProjection[2];
      vec3 ray_origin = near.xyz / near.w;
      vec3 rd = normalize(far.xyz / far.w - ray_origin);

      vec3 A = vImpAxis;
      vec3 B = vImpBase;
      float len2 = vImpLen * vImpLen;
      float r = sqrt(vImpRadiusSq);

      vec3 n = cross(rd, A);
      float ln = length(n);
      vec3 RC = ray_origin - B;
      vec3 hit; vec3 nrm; float coverage = 1.0; float axial = 0.0;

      if (ln < 1e-7 * vImpLen) {
        float t = dot(RC, rd);
        float v = dot(RC, RC);
        if (v - t * t > vImpRadiusSq) discard;
        hit = ray_origin - t * rd;
        nrm = -A; axial = 0.0;
      } else {
        n /= ln;
        float dd = dot(RC, n); dd *= dd;
        float pd = sqrt(dd);
        coverage = clamp((r - pd) / max(fwidth(pd), 1e-6) + 0.5, 0.0, 1.0);
        if (coverage <= 0.0) discard;
        float dc = min(dd, vImpRadiusSq);
        float t = dot(cross(A, RC), n) / ln;
        float s = abs(sqrt(vImpRadiusSq - dc) / dot(cross(n, A), rd) * vImpLen);
        float tnear = t - s;
        hit = ray_origin + tnear * rd;
        float anear = dot(hit - B, A) / len2;
        if (anear >= 0.0 && anear <= 1.0) {
          nrm = hit - (B + anear * A); axial = anear;
        } else {
          float tfar = t + s;
          vec3 farp = ray_origin + tfar * rd;
          float afar = dot(farp - B, A) / len2;
          if (anear < 0.0 && afar > 0.0) {
            hit = ray_origin + (tnear + (anear / (anear - afar)) * 2.0 * s) * rd;
            nrm = -A; axial = 0.0;
          } else if (anear > 1.0 && afar < 1.0) {
            hit = ray_origin + (tnear + ((anear - 1.0) / (anear - afar)) * 2.0 * s) * rd;
            nrm = A; axial = 1.0;
          } else discard;
        }
      }

      nrm = normalize(nrm);
      // Cap coverage from hit radial distance (side wall used ray-to-axis).
      if (abs(dot(nrm, normalize(A))) > 0.9) {
        vec3 rad = (hit - B) - A * (dot(hit - B, A) / len2);
        float pdc = length(rad);
        coverage = clamp((r - pdc) / max(fwidth(pdc), 1e-6) + 0.5, 0.0, 1.0);
      }

      // Analytic depth.
      vec4 proj = projectionMatrix * vec4(hit, 1.0);
      float dz = (proj.z / proj.w + 1.0) * 0.5;
      if (dz < 0.0 || dz > 1.0) discard;
      gl_FragDepth = dz;

      // ── reuse #524 lighting verbatim ──
      // Colour gradient: axial 0..1 over the HALF-cylinder maps to the same
      // vYPosition+0.5 the mesh used (its cylinder y ran -0.5..0.5).
      vec3 base_color = mix(vColorStart, vColorEnd, axial);
      float gray = dot(base_color, vec3(0.299, 0.587, 0.114));
      base_color = mix(vec3(gray), base_color, saturation) * brightness;
      vec3 N = normalize((modelViewMatrix_normal(nrm)));
      vec3 viewDir = normalize(-hit);
      vec3 keyDir = normalize(uLightDir);
      vec3 env = studio_env(nrm, keyDir);
      vec3 halfDir = normalize(keyDir + viewDir);
      float specular = pow(max(dot(nrm, halfDir), 0.0), 64.0);
      float NdotV = max(dot(nrm, viewDir), 0.0);
      float fresnel = pow(1.0 - NdotV, 5.0);
      float rim_mask = smoothstep(0.0, 0.25, NdotV);
      float floor_lift = mix(0.18, 1.0, rim_mask);
      vec3 specColor = mix(vec3(1.0), base_color, 0.55);
      float exposure = ambientIntensity + directionalIntensity * 0.5;
      vec3 final_color = base_color * env * exposure * floor_lift
                       + specColor * specular * directionalIntensity * 0.5 * rim_mask * uSpecStrength
                       + vec3(fresnel * 0.08) * rim_mask;
      final_color = aces_tonemap(final_color);
      gl_FragColor = vec4(linearTosRGB(final_color), uOpacity * vOpacity * coverage);

      if (uDepthCueing > 0.0) {
        float fade = clamp((-hit.z - uDepthNear) / max(uDepthFar - uDepthNear, 0.01), 0.0, 1.0) * uDepthCueing;
        gl_FragColor.rgb = mix(gl_FragColor.rgb, linearTosRGB(uDepthCueBgColor), fade);
      }
      if (uBondOutlineStrength > 0.0) {
        float silhouette = smoothstep(0.0, 0.6, 1.0 - NdotV);
        gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.0), silhouette * uBondOutlineStrength * 0.85);
      }
    }
  `
```

Note on the normal: the mesh path transforms the object normal by `normalMatrix`; the impostor's `nrm` is ALREADY view-space (from view-space A/B), so it needs no `normalMatrix`. Remove the `modelViewMatrix_normal(nrm)` placeholder and use `nrm` directly — the `N` line is dead (studio_env takes `nrm`); delete it. (Left as an explicit fix step below so the implementer doesn't ship the placeholder.)

- [ ] **Step 2: Remove the dead view-space-normal placeholder**

Delete the `vec3 N = normalize((modelViewMatrix_normal(nrm)));` line — `studio_env`, specular, fresnel, rim all already use `nrm` (view-space). Confirm no remaining reference to `N` or `modelViewMatrix_normal`.

- [ ] **Step 3: Type-check**

Run: `pnpm check 2>&1 | grep -c "Error:"`
Expected: `0`.

- [ ] **Step 4: Commit**

```bash
git add src/lib/structure/bonding/BondManagerInstances.svelte
git commit -m "feat(bonds): impostor fragment shader — ray-cast + AA + reused lighting"
```

---

### Task 5: Second material + gpu_active switch + uniform sync

**Files:**
- Modify: `src/lib/structure/bonding/BondManagerInstances.svelte` (construct `impostor_material`; add `uInvProjection`/`uViewport`/`uBondRadius` uniforms; switch `<T.InstancedMesh material>`; per-frame uniform sync in the position effect)

**Interfaces:**
- Consumes: `impostor_vertex_shader` (Task 3), `impostor_fragment_shader` (Task 4), `gpu_active` (existing).
- Produces: `<T.InstancedMesh>` uses `impostor_material` when `gpu_active`, else `shader_material`. `impostor_material` shares every lighting uniform value with `shader_material` (same uniform objects) plus impostor-only `uInvProjection`/`uViewport`/`uBondRadius`.

- [ ] **Step 1: Construct the impostor material sharing lighting uniforms**

After `shader_material`:

```svelte
  const impostor_material = untrack(() => new ShaderMaterial({
    vertexShader: impostor_vertex_shader,
    fragmentShader: impostor_fragment_shader,
    glslVersion: '300 es',
    transparent: false,
    depthWrite: true,
    alphaToCoverage: true,
    uniforms: {
      // SHARE the exact uniform objects so the existing sync effects update both.
      ambientIntensity: shader_material.uniforms.ambientIntensity,
      directionalIntensity: shader_material.uniforms.directionalIntensity,
      saturation: shader_material.uniforms.saturation,
      brightness: shader_material.uniforms.brightness,
      uOpacity: shader_material.uniforms.uOpacity,
      uLightDir: shader_material.uniforms.uLightDir,
      uSpecStrength: shader_material.uniforms.uSpecStrength,
      uDepthCueing: shader_material.uniforms.uDepthCueing,
      uDepthNear: shader_material.uniforms.uDepthNear,
      uDepthFar: shader_material.uniforms.uDepthFar,
      uDepthCueBgColor: shader_material.uniforms.uDepthCueBgColor,
      uBondOutlineStrength: shader_material.uniforms.uBondOutlineStrength,
      uPosTex: shader_material.uniforms.uPosTex,
      uNAtoms: shader_material.uniforms.uNAtoms,
      uLattice: shader_material.uniforms.uLattice,
      uHideIncomplete: shader_material.uniforms.uHideIncomplete,
      uMaxBondLength: shader_material.uniforms.uMaxBondLength,
      uStubMode: shader_material.uniforms.uStubMode,
      uStubScale: shader_material.uniforms.uStubScale,
      // impostor-only
      uBondRadius: { value: bond_radius },
      uInvProjection: { value: new Matrix4() },
      uViewport: { value: new Vector2(1, 1) },
    },
  }))
```

- [ ] **Step 2: Switch the mesh material on gpu_active**

Change the `<T.InstancedMesh>` `args` material slot to a `$derived`:

```svelte
  const active_material = $derived(gpu_active ? impostor_material : shader_material)
```

and use `material={active_material}` (or the `args` array's material position) on the `<T.InstancedMesh>`.

- [ ] **Step 3: Per-frame impostor camera uniforms**

The impostor needs `uInvProjection` + `uViewport` each frame. In the positions-sync effect (where `upload_positions` runs during playback), add — guarded by `gpu_active` and read from Threlte's camera/renderer:

```svelte
    if (gpu_active) {
      const cam = threlte.camera.current
      const size = threlte.renderer?.getDrawingBufferSize(new Vector2())
      if (cam) impostor_material.uniforms.uInvProjection.value.copy(cam.projectionMatrixInverse)
      if (size) impostor_material.uniforms.uViewport.value.copy(size)
    }
```

Also keep `uBondRadius` synced: in the existing radius-driven effect set `impostor_material.uniforms.uBondRadius.value = bond_radius`.

- [ ] **Step 4: Type-check + full vitest**

Run: `pnpm check 2>&1 | grep -c "Error:"` → `0`
Run: `rtk proxy pnpm exec vitest run tests/vitest/structure/bonding/` → all pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/structure/bonding/BondManagerInstances.svelte
git commit -m "feat(bonds): impostor material + gpu_active switch + camera uniform sync"
```

---

### Task 6: alphaToCoverage / MSAA confirmation + prod build

**Files:**
- Read: the renderer construction (search `new WebGLRenderer` / Threlte `<Canvas>` props for `antialias`)
- Modify (only if MSAA is off): enable `antialias` for the bond pass, or document the aliasing limitation.

- [ ] **Step 1: Find the renderer antialias setting**

Run: `grep -rn "antialias\|WebGLRenderer\|<Canvas" src/lib/structure/StructureScene.svelte src/lib/structure/*.svelte | grep -i "antialias\|Canvas" | head`
Expected: identify whether the WebGL context requests MSAA.

- [ ] **Step 2: Decide**

If `antialias: true` (or default true): `alphaToCoverage` works — proceed. If off: either turn it on for this scene (preferred — the mesh path benefits too) or set `alphaToCoverage: false` on `impostor_material` and note aliased impostor silhouettes as a known Phase-1 limitation (fix in a follow-up). Record the decision in a code comment beside `alphaToCoverage: true`.

- [ ] **Step 3: Prod build sanity**

Run: `pnpm desktop:build 2>&1 | tail -3`
Expected: build succeeds (impostor shaders compile in prod).

- [ ] **Step 4: Commit (if any change)**

```bash
git add -A
git commit -m "chore(bonds): confirm MSAA for impostor alphaToCoverage"
```

---

### Task 7: Real-trajectory fps + visual verification

**Files:** none (measurement only)

- [ ] **Step 1: Serve the prod build**

```bash
cd build-desktop && python3 -m http.server 3505 &
ln -sf /home/james0001/project/catgo-LRG/.claude/tmp-dump.traj build-desktop/tmp-dump.traj
```

- [ ] **Step 2: Load the 48MB / 20k-atom / 52k-bond trajectory, play, measure cached-lap fps**

Open `http://localhost:3505/`, drop `tmp-dump.traj`, let idle warmup finish, then drive the scrubber cached-lap benchmark (0→99 rAF loop, 3 laps, take the steady fps). Baseline to beat: **27.8fps** (the #524 mesh path). Confirm `__catgo_bond_gpu.uGpuXform` shows the GPU path active during playback and the bond mesh geometry is the OBB (12 tris/bond).

- [ ] **Step 3: Visual parity check**

Screenshot playing (impostor) vs paused (mesh, after tail-sync). Confirm: bonds render as smooth cylinders (not raw boxes), colours/gradient match, cross-cell stubs present, no flicker at crossings, silhouettes AA'd. `gl.getError()` clean, no shader-compile console errors.

- [ ] **Step 4: Record the result**

Write the measured cached-lap fps (impostor vs 27.8 baseline) and tris/bond into the PR description and the round-4 memory. If impostor fps ≥ mesh, Phase 1 succeeds and Phases 2-4 are justified; if not, capture why (fill-bound? gl_FragDepth early-z cost?) for the follow-up.

- [ ] **Step 5: Clean up**

```bash
pkill -f "http.server 3505"; rm -f build-desktop/tmp-dump.traj
```

---

## Self-Review

**Spec coverage:** Task 1-2 = geometry switch (reuse segment-LOD); Task 3 = vertex OBB half-bond + stub (decision a); Task 4 = fragment ray-cast + reuse lighting/colour/depth-cue/outline + AA; Task 5 = second material + gpu_active switch + uniform sync; Task 6 = alphaToCoverage/MSAA; Task 7 = real 52k-bond fps vs 27.8. All Phase-1 spec sections covered. Phases 2-4 (multibond/image-atom/transparent/always-on) are explicitly out and get their own plans.

**Placeholder scan:** the one intentional placeholder (`modelViewMatrix_normal(nrm)`) is removed by Task 4 Step 2 with an explicit instruction — flagged, not shipped.

**Type consistency:** flat varyings `vImpBase`/`vImpAxis`/`vImpRadiusSq`/`vImpLen`/`vImpCollapse` are declared identically in Task 3 (vertex out) and Task 4 (fragment in); uniform names match the shared-object list in Task 5; `bond_geometry_mode` signature identical in Task 1 and Task 2 usage.

## Phase 2-4 (follow-up plans, not this document)

- **Phase 2 multibond:** stride-6 instances, order>1 multi-cylinder; the OBB per sub-cylinder, `a_half`/order attrs extended.
- **Phase 3 image-atom decorators:** the decorator half-bond range (past cell-internal) as impostors; reuse `#write_decorators` topology into impostor attrs.
- **Phase 4 always-on + transparent:** impostor for static frames (drop the `gpu_active`-only gate; pathtracer Render Still still rebuilds mesh); transparent bonds via alpha-blend path instead of alphaToCoverage.

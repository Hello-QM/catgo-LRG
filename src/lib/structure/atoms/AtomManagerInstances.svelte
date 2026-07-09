<script lang="ts">
  /**
   * Phase X3+X6b Threlte wrapper for `AtomInstancedRenderer`. Parallels
   * `BondManagerInstances.svelte` — owns InstancedMesh + the renderer,
   * subscribes to `atom_manager.version`, and calls `threlte.invalidate()`
   * after each sync.
   *
   * Shader vertex + fragment are copied verbatim from `AtomImpostors.svelte`
   * so there is zero intentional visual difference versus the legacy path
   * for the feature set covered.
   *
   * X6b additions vs X3 PoC:
   *   - Realtime drag fast-path: `realtime_position_overrides` writes directly
   *     to manager positions each frame, bumping version, letting main sync
   *     re-upload only the position attribute.
   *   - Cutting-plane modulation: `cutting_active` + `cutting_visibility_map`
   *     feed the renderer's effective-opacity + effective-saturation chain.
   *   - Image-atom opacity: `num_original_sites` + `image_atom_opacity` +
   *     `image_to_original_map` dim atoms at `site_id >= num_original_sites`
   *     with parent inheritance for overrides.
   *   - Per-atom opacity overrides (vibration mode, polyhedra-hidden pass-
   *     through, clip, isolation, user dim).
   *
   * Known regressions vs AtomImpostors (deferred — NOT in X6b scope):
   *   - Partial-occupancy wedges: AtomManager's X2 shadow sync only tracks
   *     the first species per site. Multi-species wedge rendering requires a
   *     separate instance mesh. Sites with `has_partial_occupancy` are still
   *     rendered through the legacy path in StructureScene (the partial-
   *     occupancy `{#each}` block).
   *   - Selection highlight / hover pulse: handled by overlay components
   *     (selection markers) on top of the impostor mesh — the impostor itself
   *     doesn't render them in the legacy path either, so no action needed.
   *
   * The `USE_NEW_ATOM_SYSTEM` feature flag stays `false` through X6b. This
   * component only runs when the caller flips the flag on in source.
   */

  import type { Vec3 } from '$lib'
  import { untrack } from 'svelte'
  import { T, useThrelte } from '@threlte/core'
  import type { InstancedMesh } from 'three'
  import { Color, PlaneGeometry, ShaderMaterial, Vector3 } from 'three'
  import type { AtomManager } from './atom-manager.svelte'
  import { AtomInstancedRenderer, type CuttingVisibilityEntry } from './atom-instanced-renderer'
  import { get_atom_matcap, type MatcapPreset } from './matcap-texture'

  interface Props {
    atom_manager: AtomManager
    /** site_ids whose atoms should be hidden (opacity forced to 0). The
     *  fragment shader discards on `vOpacity < 0.001`; no slot shuffling.
     *  Passed through un-proxied from the caller — mutate with a NEW Set. */
    hidden_site_ids?: ReadonlySet<number>
    /** Drag overrides: mutating this map with a site_id → new xyz tuple
     *  writes the new position directly to the manager. Used by the drag
     *  fast-path so per-frame mutations don't go through the X2 shadow sync. */
    realtime_position_overrides?: Map<number, Vec3> | null
    /** Slab-cut modulation: when active, each atom's opacity/saturation is
     *  multiplied by the map entry for its site_id. */
    cutting_active?: boolean
    cutting_visibility_map?: ReadonlyMap<number, CuttingVisibilityEntry>
    /** Per-site opacity overrides (vibration mode, polyhedra-hidden, user dim,
     *  clip, isolation). Image atoms without their own entry inherit the
     *  parent's via `image_to_original_map`. */
    atom_opacity_overrides?: ReadonlyMap<number, number>
    /** The last index in `structure.sites` that is an "original" atom (not a
     *  PBC image). Slots with `site_id >= num_original_sites` are image atoms
     *  and are subject to the image opacity multiplier + parent inheritance. */
    num_original_sites?: number
    /** Global multiplier applied to image atoms only (ignored if >= 1). */
    image_atom_opacity?: number
    /** For image atoms: `image_to_original_map[site_id - num_original_sites]`
     *  gives the parent atom's site_id for opacity inheritance. */
    image_to_original_map?: readonly number[]
    /** Shared depth-cue uniform objects (same shape as AtomImpostors). */
    depth_cue_uniforms?: {
      uDepthCueing: { value: number }
      uDepthNear: { value: number }
      uDepthFar: { value: number }
      uDepthCueBgColor: { value: Color }
      uOutlineStrength: { value: number }
    }
    ambient_light?: number
    directional_light?: number
    /** Atom shading style. Branches the fragment lighting on uRenderStyle:
     *  glossy (Blinn-Phong, default), matte (diffuse only, no spec), toon
     *  (3-band cel, AtomCanvas ToonHighlightMaterial). */
    render_style?: `glossy` | `metallic` | `matte` | `soft` | `flat` | `toon` | `matcap`
    matcap_preset?: string
    /** View-space headlamp direction (x=right, y=up, z=toward camera). Driven
     *  by the light_azimuth/elevation sliders; written live into uLightDir. */
    light_dir?: Vector3
    /** Specular highlight intensity multiplier (highlight_strength setting).
     *  Multiplies the glossy spec term; 1.0 = byte-identical legacy look.
     *  Written live into uSpecStrength. */
    highlight_strength?: number
    /** Pre-allocated InstancedMesh capacity. Fixed at construction — the
     *  renderer's `sync()` throws if `manager.count` exceeds this. Matches the
     *  BondManagerInstances pattern (fixed 200k). For X3 PoC a generous
     *  static cap is simpler + safer than dynamic grow-on-demand (which has
     *  an effect-ordering race — see git history for details). */
    max_capacity?: number
  }

  let {
    atom_manager,
    hidden_site_ids,
    realtime_position_overrides = null,
    cutting_active = false,
    cutting_visibility_map,
    atom_opacity_overrides,
    num_original_sites,
    image_atom_opacity = 1,
    image_to_original_map,
    depth_cue_uniforms,
    ambient_light = 0.7,
    directional_light = 0.3,
    render_style = `glossy`,
    matcap_preset = `ceramic`,
    light_dir = new Vector3(0.4, 0.7, 0.6).normalize(),
    highlight_strength = 1.0,
    max_capacity = 200_000,
  }: Props = $props()

  // glossy = 0, matte = 1, toon = 2 (matches the uRenderStyle branch order).
  function render_style_to_int(
    style: `glossy` | `metallic` | `matte` | `soft` | `flat` | `toon` | `matcap`,
  ): number {
    // Map onto the shader branches (0 glossy/Blinn-Phong, 1 matte diffuse,
    // 2 toon, 3 matcap). Metallic reuses the specular branch; 2.5D-soft and
    // 2D-flat reuse the matte branch — their distinct look comes from the
    // per-style lighting profile, not a new GLSL branch.
    if (style === `toon`) return 2
    if (style === `matcap`) return 3
    if (style === `matte` || style === `soft` || style === `flat`) return 1
    return 0
  }

  const threlte = useThrelte()

  // Render-loop refactor (R4c): all canvas-paint requests in this component
  // route through mark_dirty() — single grep target + DEV counter contribution.
  function mark_dirty(): void {
    threlte.invalidate()
    if (import.meta.env?.DEV) {
      const g = globalThis as unknown as { __invalidate_count?: number }
      g.__invalidate_count = (g.__invalidate_count ?? 0) + 1
    }
  }

  // ─── Shaders: verbatim copy from AtomImpostors.svelte (L69–209) ───
  // Kept identical so the new path is a visual drop-in for the covered
  // feature set. Any divergence here becomes a regression.
  const vertex_shader = `
    attribute vec3 instancePosition;
    attribute float instanceRadius;
    attribute vec3 instanceAtomColor;
    attribute float instanceOpacity;
    attribute float instanceSaturation;

    varying vec3 vCenter;       // atom center in view space
    varying float vRadius;      // atom radius in world units
    varying vec3 vColor;
    varying float vOpacity;
    varying float vSaturation;
    varying vec2 vQuadCoord;    // billboard corner [-1,1]

    void main() {
      vQuadCoord = position.xy;
      vColor = instanceAtomColor;
      vOpacity = instanceOpacity;
      vSaturation = instanceSaturation;
      vRadius = instanceRadius;

      // Transform atom center to view space
      // Use viewMatrix * modelMatrix directly — bypass instanceMatrix
      vec4 worldPos = modelMatrix * vec4(instancePosition, 1.0);
      vec4 viewCenter = viewMatrix * worldPos;
      vCenter = viewCenter.xyz;

      // Expand quad in view space: billboard always faces camera
      vec3 viewPos = viewCenter.xyz;
      // Scale billboard by 1.05 to avoid edge clipping at grazing angles
      viewPos.xy += position.xy * instanceRadius * 1.05;

      gl_Position = projectionMatrix * vec4(viewPos, 1.0);
    }
  `

  const fragment_shader = `
    uniform bool uIsOrthographic;
    uniform vec3 uLightDir;    // directional light in view space (headlamp, normalized)
    uniform float uAmbientIntensity;
    uniform float uDirectionalIntensity;
    uniform float uDepthCueing;
    uniform float uDepthNear;
    uniform float uDepthFar;
    uniform vec3 uDepthCueBgColor;
    uniform float uOutlineStrength;
    uniform int uRenderStyle;  // 0 = glossy, 1 = matte, 2 = toon, 3 = matcap
    // Toon (cel) thresholds — AtomCanvas ToonHighlightMaterial parity.
    uniform float uShadowThreshold;
    uniform float uHighlightThreshold;
    uniform float uShadowBrightness;
    uniform float uSpecStrength;  // glossy specular highlight multiplier (1.0 = default)
    uniform sampler2D uMatcap;    // baked studio-sphere lighting (render style 3)
    // projectionMatrix is only auto-injected into vertex shader, must re-declare for fragment
    uniform mat4 projectionMatrix;

    varying vec3 vCenter;
    varying float vRadius;
    varying vec3 vColor;
    varying float vOpacity;
    varying float vSaturation;
    varying vec2 vQuadCoord;

    vec3 linearTosRGB(vec3 linear) {
      return vec3(
        linear.r <= 0.0031308 ? linear.r * 12.92 : 1.055 * pow(linear.r, 1.0/2.4) - 0.055,
        linear.g <= 0.0031308 ? linear.g * 12.92 : 1.055 * pow(linear.g, 1.0/2.4) - 0.055,
        linear.b <= 0.0031308 ? linear.b * 12.92 : 1.055 * pow(linear.b, 1.0/2.4) - 0.055
      );
    }

    // ACES filmic tonemap — rolls off bright specular so glossy highlights read
    // soft/desaturated (publication-figure look) instead of hard clipped dots.
    vec3 aces_tonemap(vec3 x) {
      return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
    }

    void main() {
      // PoC hidden-atom discard: hidden_site_ids is implemented by forcing
      // opacity = 0 in the CPU side, so discard here saves all fragment work.
      if (vOpacity < 0.001) discard;

      // Ray-sphere intersection in view space.
      // Uses cross-product formulation to avoid catastrophic cancellation
      // when vCenter has large values (periodic structures with lattice offsets).
      // The algebraic b²−4ac form subtracts two ~|vCenter|² values, losing
      // precision and creating visible concentric banding on sphere surfaces.

      vec3 fragViewPos = vec3(vCenter.xy + vQuadCoord * vRadius * 1.05, vCenter.z);

      vec3 hitPos;
      vec3 normal;
      // Silhouette anti-aliasing: instead of a hard discard at the sphere edge
      // (d2 > r2), fade a ~1px coverage band via screen-space derivatives and
      // feed it to alpha-to-coverage (material.alphaToCoverage + MSAA). This
      // smooths the jagged impostor outline that plain MSAA can't touch, since
      // a hard discard gives no sub-pixel coverage. thc is clamped so grazing-
      // edge fragments (d2 slightly > r2) still get a finite hit for shading.
      float coverage = 1.0;

      if (uIsOrthographic) {
        // Orthographic: ray origin at fragment XY on near plane, direction -Z
        // Perpendicular distance from ray to sphere center is just the XY offset
        vec2 offset = vQuadCoord * vRadius * 1.05;
        float d2 = dot(offset, offset);
        float r2 = vRadius * vRadius;
        // Analytic 1px-wide edge coverage on the RADIAL distance (not d², whose
        // fast edge derivative gave a ~4px band that read as a white halo).
        float d = length(offset);
        coverage = clamp((vRadius - d) / fwidth(d) + 0.5, 0.0, 1.0);
        if (coverage <= 0.0) discard;
        float thc = sqrt(max(r2 - min(d2, r2), 0.0));
        // Hit point: fragment XY, sphere front Z
        hitPos = vec3(vCenter.xy + offset, vCenter.z + thc);
        normal = vec3(offset, thc) / vRadius;
      } else {
        // Perspective: ray from camera origin (0,0,0) through fragViewPos
        vec3 rayDir = normalize(fragViewPos);

        // Cross-product distance: avoids |L|² − (L·d)² cancellation
        vec3 cr = cross(vCenter, rayDir);
        float d2 = dot(cr, cr);
        float r2 = vRadius * vRadius;
        // Analytic 1px-wide edge coverage on the RADIAL distance (see ortho).
        float d = sqrt(d2);
        coverage = clamp((vRadius - d) / fwidth(d) + 0.5, 0.0, 1.0);
        if (coverage <= 0.0) discard;

        float tca = dot(vCenter, rayDir);
        float thc = sqrt(max(r2 - min(d2, r2), 0.0));
        float t = tca - thc;
        hitPos = t * rayDir;

        // Compute normal without hitPos−vCenter (large-value subtraction).
        // Decompose vCenter = tca*rayDir + L_perp, then:
        //   hitPos − vCenter = (t−tca)*rayDir − L_perp = −thc*rayDir − L_perp
        vec3 L_perp = vCenter - tca * rayDir;
        normal = normalize(-thc * rayDir - L_perp);
      }

      // Write correct depth for proper overlap
      vec4 clipPos = projectionMatrix * vec4(hitPos, 1.0);
      float ndcDepth = clipPos.z / clipPos.w;
      gl_FragDepth = ndcDepth * 0.5 + 0.5;

      // Desaturation for slab cutting
      vec3 baseColor = vColor;
      if (vSaturation < 1.0) {
        float luminance = dot(baseColor, vec3(0.299, 0.587, 0.114));
        baseColor = mix(vec3(luminance), baseColor, vSaturation);
      }

      // Lighting with camera-fixed (headlamp) light direction.
      vec3 lightDirView = normalize(uLightDir);
      vec3 viewDir = uIsOrthographic ? vec3(0.0, 0.0, 1.0) : normalize(-hitPos);

      vec3 color;
      if (uRenderStyle == 2) {
        // ── Toon: 3-band cel shading (AtomCanvas ToonHighlightMaterial) ──
        // Per-instance baseColor stands in for the reference's uColor/vTint;
        // vOpacity carries the per-instance alpha (instanceAlpha equivalent).
        float diffuse = dot(normal, lightDirView);
        if (diffuse > uHighlightThreshold) {
          color = vec3(1.0, 1.0, 1.0);
        } else if (diffuse > uShadowThreshold) {
          color = baseColor;
        } else {
          color = baseColor * uShadowBrightness;
        }
      } else if (uRenderStyle == 1) {
        // ── Matte: diffuse-only Lambert, no specular highlight ──
        float diffuse = max(dot(normal, lightDirView), 0.0);
        color = baseColor * (uAmbientIntensity + uDirectionalIntensity * diffuse);
      } else if (uRenderStyle == 3) {
        // ── MatCap: sample a baked studio-sphere by the view-space normal and
        //    tint by the element colour (grayscale matcap → keeps element ID). ──
        vec2 muv = normal.xy * 0.5 + 0.5;
        color = baseColor * texture2D(uMatcap, muv).rgb;
      } else {
        // ── Glossy: Cook-Torrance GGX PBR (equivalent to a MeshStandardMaterial
        //    at roughness 0.2, metalness 0) lit by ambient + a near-head-on key.
        //    GGX(rough=0.2) is what gives the SMALL, bright, centred hot spot;
        //    ACES rolls the HDR key light back to display range. ──
        float rough = 0.2;
        float a = rough * rough;
        float a2 = a * a;
        float NdotL = max(dot(normal, lightDirView), 0.0);
        float NdotV = max(dot(normal, viewDir), 1e-4);
        vec3 halfDir = normalize(lightDirView + viewDir);
        float NdotH = max(dot(normal, halfDir), 0.0);
        float VdotH = max(dot(viewDir, halfDir), 0.0);
        // GGX normal distribution (tight lobe for low roughness).
        float dn = (NdotH * NdotH) * (a2 - 1.0) + 1.0;
        float D = a2 / (3.14159265 * dn * dn);
        // Smith-Schlick geometry.
        float k = a * 0.5;
        float G = (NdotV / (NdotV * (1.0 - k) + k)) * (NdotL / (NdotL * (1.0 - k) + k));
        // Schlick Fresnel, dielectric F0 = 0.04.
        float F = 0.04 + 0.96 * pow(1.0 - VdotH, 5.0);
        float specular = (D * G * F) / (4.0 * NdotV * NdotL + 1e-4);
        // Energy-conserving Lambert (÷π) on the key, like MeshStandardMaterial —
        // without it the base*key diffuse blew out (too bright, over-saturated).
        // uDirectionalIntensity = HDR key strength, uAmbientIntensity = fill.
        vec3 color2 = baseColor * (uAmbientIntensity + uDirectionalIntensity * NdotL * 0.31831)
                 + vec3(1.0) * specular * uDirectionalIntensity * NdotL * uSpecStrength;
        // Soft rim shadow: darken the grazing silhouette a touch (NdotV→0 at the
        // edge) for a little volume / ambient-occlusion feel, like VESTA spheres.
        color2 *= mix(0.6, 1.0, smoothstep(0.0, 0.5, NdotV));
        color = aces_tonemap(color2);
      }

      gl_FragColor = vec4(linearTosRGB(color), vOpacity * coverage);

      // Depth cueing: VESTA-style fade toward background.
      // uDepthCueBgColor is in linear-RGB (Three.js color space), but
      // gl_FragColor.rgb here is already sRGB-encoded — encode the bg too.
      if (uDepthCueing > 0.0) {
        float depthZ = -hitPos.z; // view-space depth of the hit point
        float fade = clamp((depthZ - uDepthNear) / max(uDepthFar - uDepthNear, 0.01), 0.0, 1.0) * uDepthCueing;
        gl_FragColor.rgb = mix(gl_FragColor.rgb, linearTosRGB(uDepthCueBgColor), fade);
      }

      // 3Dmol-style silhouette outline: darken pixels at glancing angles.
      if (uOutlineStrength > 0.0) {
        float NdotV = max(dot(normal, viewDir), 0.0);
        float silhouette = smoothstep(0.55, 1.0, 1.0 - NdotV);
        gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.0), silhouette * uOutlineStrength);
      }

    }
  `

  // ─── Materials (one per mesh layer) ───
  // Matches AtomImpostors material flags exactly:
  //   opaque    : transparent=false, depthWrite=true,  depthTest=true
  //   transparent: transparent=true, depthWrite=false, depthTest=false
  function create_material(transparent: boolean): ShaderMaterial {
    return new ShaderMaterial({
      vertexShader: vertex_shader,
      fragmentShader: fragment_shader,
      transparent,
      depthWrite: !transparent,
      depthTest: !transparent,
      // Alpha-to-coverage turns the fragment's edge-coverage alpha into MSAA
      // sample coverage — anti-aliases the impostor silhouette on the opaque
      // pass (needs the canvas MSAA, which is on). Harmless on the transparent
      // pass (it blends anyway).
      alphaToCoverage: !transparent,
      side: 0,
      uniforms: {
        uIsOrthographic: { value: false },
        uLightDir: { value: light_dir.clone() }, // view-space headlamp (slider-driven); kept live by $effect below
        uAmbientIntensity: { value: ambient_light },
        uDirectionalIntensity: { value: directional_light },
        uDepthCueing: depth_cue_uniforms?.uDepthCueing ?? { value: 0 },
        uDepthNear: depth_cue_uniforms?.uDepthNear ?? { value: 0 },
        uDepthFar: depth_cue_uniforms?.uDepthFar ?? { value: 10 },
        uDepthCueBgColor: depth_cue_uniforms?.uDepthCueBgColor ?? { value: new Color(0xffffff) },
        uOutlineStrength: depth_cue_uniforms?.uOutlineStrength ?? { value: 0 },
        uRenderStyle: { value: render_style_to_int(render_style) },
        // Glossy specular highlight multiplier (slider-driven); kept live by $effect below.
        uSpecStrength: { value: highlight_strength },
        // Toon (cel) thresholds — AtomCanvas ToonHighlightMaterial defaults.
        uShadowThreshold: { value: 0.3 },
        uHighlightThreshold: { value: 0.97 },
        uShadowBrightness: { value: 0.5 },
        // Null until MatCap is selected (see the render-style $effect). Three
        // binds its default 1×1 texture for an unset sampler, so the declared
        // uMatcap sampler is safe to leave empty on non-matcap paths.
        uMatcap: { value: null },
      },
    })
  }

  // untrack: material construction reads the initial values; the $effects
  // below keep uniforms in sync reactively.
  const opaque_material = untrack(() => create_material(false))

  // Single geometry for the PoC opaque mesh. Kept outside any remount key
  // because the mesh itself is allocated once at `max_capacity` (same
  // strategy as BondManagerInstances) — no remount race, no attribute
  // dispose ordering surface. Transparent mesh and transparent_material are
  // deferred to X6 when per-atom opacity routing actually needs them.
  const opaque_geometry = new PlaneGeometry(2, 2, 1, 1)

  // ─── Mesh refs ───
  // Single opaque mesh serves both opaque and transparent atoms:
  //   - opacity < 1 still renders through this mesh (depthTest on, depthWrite on)
  //   - hidden atoms get opacity < 0.001 and `discard` in the fragment shader
  //   - cutting / image-atom / per-site overrides all flow through the
  //     renderer's `compute_effective_opacity` chain (see atom-instanced-
  //     renderer.ts L166–205)
  // AtomImpostors's two-mesh split (opaque depthTest on, transparent depthTest
  // off) is intentionally NOT replicated: keeping a single mesh avoids the
  // remount race described in the X3 commit and the minor depth-ordering
  // differences are visually indistinguishable in practice for the structures
  // CatGo renders (small number of partial-opacity atoms, billboard impostors).
  let opaque_mesh = $state<InstancedMesh | undefined>()
  let opaque_renderer: AtomInstancedRenderer | undefined

  // Rebuild the renderer when the mesh ref binds (mount only — mesh capacity
  // is fixed, so no remount happens after initial bind).
  //
  // `untrack` the modulation reads so the mount effect doesn't become a
  // reactive dependent of them — the main sync effect already handles changes.
  $effect(() => {
    if (!opaque_mesh) return
    const r = new AtomInstancedRenderer(opaque_mesh, atom_manager, hidden_site_ids ?? null)
    untrack(() => {
      r.set_cutting(cutting_active, cutting_visibility_map ?? null)
      r.set_atom_opacity_overrides(atom_opacity_overrides ?? null)
      r.set_image_atoms(num_original_sites, image_atom_opacity, image_to_original_map)
    })
    opaque_renderer = r
    r.force_full_resync()
    mark_dirty()
    return () => {
      r.dispose()
      if (opaque_renderer === r) opaque_renderer = undefined
    }
  })

  // Track identity/size of each render-side modulation input — the manager
  // can't know when these change, so we must force a full resync when any
  // change. Identity + size is cheap and catches the common cases (new map,
  // entries added/removed). In-place entry-value edits won't invalidate via
  // identity, but the consumer pattern in StructureScene re-creates these maps
  // via `$derived.by(…new Map(…))` whenever inputs change, so identity flips.
  let last_hidden_ref: ReadonlySet<number> | undefined
  let last_hidden_size = -1
  let last_cutting_active = false
  let last_cutting_map_ref: ReadonlyMap<number, CuttingVisibilityEntry> | undefined
  let last_cutting_map_size = -1
  let last_overrides_ref: ReadonlyMap<number, number> | undefined
  let last_overrides_size = -1
  let last_num_original = -1
  let last_image_opacity = 1
  let last_image_map_ref: readonly number[] | undefined

  // Main sync effect: tracks `atom_manager.version` + every render-side
  // modulation identity/size. Calls `sync()` for incremental uploads, or
  // `force_full_resync()` when any modulation input flipped (the manager
  // can't dirty-track these — they're per-frame props, not per-atom data).
  $effect(() => {
    const _version = atom_manager.version
    void _version
    const hidden = hidden_site_ids
    const _hidden_size = hidden?.size ?? 0
    const cut_active = cutting_active
    const cut_map = cutting_visibility_map
    const _cut_map_size = cut_map?.size ?? 0
    const overrides = atom_opacity_overrides
    const _overrides_size = overrides?.size ?? 0
    const num_orig = num_original_sites ?? -1
    const img_op = image_atom_opacity
    const img_map = image_to_original_map

    if (!opaque_renderer) return

    const hidden_changed = hidden !== last_hidden_ref || _hidden_size !== last_hidden_size
    const cutting_changed =
      cut_active !== last_cutting_active ||
      cut_map !== last_cutting_map_ref ||
      _cut_map_size !== last_cutting_map_size
    const overrides_changed =
      overrides !== last_overrides_ref || _overrides_size !== last_overrides_size
    const image_changed =
      num_orig !== last_num_original ||
      img_op !== last_image_opacity ||
      img_map !== last_image_map_ref

    last_hidden_ref = hidden
    last_hidden_size = _hidden_size
    last_cutting_active = cut_active
    last_cutting_map_ref = cut_map
    last_cutting_map_size = _cut_map_size
    last_overrides_ref = overrides
    last_overrides_size = _overrides_size
    last_num_original = num_orig
    last_image_opacity = img_op
    last_image_map_ref = img_map

    if (hidden_changed) opaque_renderer.set_hidden_site_ids(hidden ?? null)
    if (cutting_changed) opaque_renderer.set_cutting(cut_active, cut_map ?? null)
    if (overrides_changed) opaque_renderer.set_atom_opacity_overrides(overrides ?? null)
    if (image_changed) {
      opaque_renderer.set_image_atoms(
        num_original_sites,
        img_op,
        img_map,
      )
    }

    if (hidden_changed || cutting_changed || overrides_changed || image_changed) {
      opaque_renderer.force_full_resync()
    } else {
      opaque_renderer.sync()
    }
    mark_dirty()
  })

  // ─── Drag fast-path ───
  // `realtime_position_overrides` is a transient map that the parent mutates
  // (often each frame during a drag). Writing to the manager bumps `version`,
  // which wakes the main sync effect above; per-attribute dirty tracking
  // ensures only the position attribute uploads — not colors/radii/opacity.
  //
  // When the drag ends the parent clears the map. We do NOT try to restore
  // pre-drag positions here — the canonical `structure.sites` mutation will
  // fire the X2 shadow sync which reconciles any drift (a no-op diff if the
  // final drag position matches the structure update, a normal diff otherwise).
  //
  // Guarded on `map.size === 0` so that parent setting `realtime_position_overrides = null`
  // (or resetting it to an empty Map) doesn't trip an unnecessary write pass.
  $effect(() => {
    const overrides = realtime_position_overrides
    if (!overrides || overrides.size === 0) return
    const manager = atom_manager
    for (const [site_id, pos] of overrides) {
      const slot = manager.find_slot_by_site_id(site_id)
      if (slot < 0) continue
      manager.set_position(slot, pos[0], pos[1], pos[2])
    }
    // The manager version bump will wake the main sync effect; no direct
    // invalidate() here to avoid double-scheduling a paint.
  })

  // ─── Uniform sync effects ───

  $effect(() => {
    const cam = threlte.camera.current
    const is_ortho = cam ? !!(cam as { isOrthographicCamera?: boolean }).isOrthographicCamera : false
    opaque_material.uniforms.uIsOrthographic.value = is_ortho
    // mark_dirty: imperative ShaderMaterial uniform write bypasses <T.> prop chain
    mark_dirty()
  })

  $effect(() => {
    opaque_material.uniforms.uAmbientIntensity.value = ambient_light
    opaque_material.uniforms.uDirectionalIntensity.value = directional_light
    // mark_dirty: imperative ShaderMaterial uniform write bypasses <T.> prop chain
    mark_dirty()
  })

  // Render-style is a uniform int branch in the fragment shader — no recompile,
  // no material swap, so glossy/matte/toon toggle live with zero GPU churn.
  $effect(() => {
    opaque_material.uniforms.uRenderStyle.value = render_style_to_int(render_style)
    // Generate/swap the baked matcap texture ONLY while MatCap is the active
    // style. Building it eagerly on the default (toon) path meant every scene —
    // including headless CI — paid a canvas-texture bake it never sampled; gate
    // it so non-matcap renders never touch matcap code. Cached per preset.
    if (render_style === `matcap`) {
      opaque_material.uniforms.uMatcap.value = get_atom_matcap(
        matcap_preset as MatcapPreset,
        mark_dirty, // repaint once (async presets, if any) finish loading
      )
    }
    // mark_dirty: imperative ShaderMaterial uniform write bypasses <T.> prop chain
    mark_dirty()
  })

  // Headlamp direction is a plain view-space uniform — copy the slider-derived
  // direction into the live material so light moves the instant the slider does.
  $effect(() => {
    opaque_material.uniforms.uLightDir.value.copy(light_dir)
    // mark_dirty: imperative ShaderMaterial uniform write bypasses <T.> prop chain
    mark_dirty()
  })

  // Specular highlight strength is a plain float uniform — copy the slider value
  // into the live material so glossiness changes the instant the slider moves.
  $effect(() => {
    opaque_material.uniforms.uSpecStrength.value = highlight_strength
    // mark_dirty: imperative ShaderMaterial uniform write bypasses <T.> prop chain
    mark_dirty()
  })
</script>

<!-- Single mesh, fixed `max_capacity` (default 200k) avoids the remount race
     between capacity-growth and main-sync $effects. See the "Mesh refs"
     comment above for why we don't replicate AtomImpostors's opaque /
     transparent two-mesh split. -->
<T.InstancedMesh
  args={[opaque_geometry, opaque_material, max_capacity]}
  bind:ref={opaque_mesh}
  frustumCulled={false}
  raycast={null}
/>

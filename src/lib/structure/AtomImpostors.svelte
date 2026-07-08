<script lang="ts">
  import type { Vec3 } from '$lib'
  import { T, useThrelte, useTask } from '@threlte/core'
  import type { BufferGeometry } from 'three'
  import {
    Color,
    InstancedBufferAttribute,
    InstancedMesh,
    Matrix4,
    PlaneGeometry,
    ShaderMaterial,
    Vector3,
  } from 'three'

  // Types matching StructureScene's atom_data items
  interface AtomDataItem {
    site_idx: number
    element: string
    occupancy: number
    position: Vec3
    radius: number
    color: string
    has_partial_occupancy: boolean
  }

  interface CuttingVisibility {
    inside: boolean
    opacity: number
    saturation: number
  }

  let {
    atom_data = [],
    realtime_position_overrides = null,
    cutting_active = false,
    cutting_visibility_map = new Map(),
    atom_opacity_overrides = new Map(),
    num_original_sites = undefined,
    image_atom_opacity = 1,
    image_to_original_map = undefined,
    depth_cue_uniforms,
    ambient_light = 0.7,
    directional_light = 0.3,
    render_style = `glossy`,
    light_dir = new Vector3(0.4, 0.7, 0.6).normalize(),
    highlight_strength = 1.0,
  }: {
    atom_data: AtomDataItem[]
    realtime_position_overrides: Map<number, Vec3> | null
    cutting_active: boolean
    cutting_visibility_map: Map<number, CuttingVisibility>
    atom_opacity_overrides: Map<number, number>
    num_original_sites: number | undefined
    image_atom_opacity: number
    image_to_original_map: number[] | undefined
    depth_cue_uniforms: {
      uDepthCueing: { value: number }
      uDepthNear: { value: number }
      uDepthFar: { value: number }
      uDepthCueBgColor: { value: Color }
      uOutlineStrength: { value: number }
    }
    ambient_light: number
    directional_light: number
    /** Atom shading style. Branches the fragment lighting on uRenderStyle:
     *  glossy (studio env + tinted spec), matte (diffuse only, no spec/fresnel),
     *  toon (3-band cel, AtomCanvas ToonHighlightMaterial). */
    render_style?: `glossy` | `metallic` | `matte` | `soft` | `flat` | `toon` | `matcap`
    /** View-space headlamp direction (x=right, y=up, z=toward camera). Driven
     *  by the light_azimuth/elevation sliders; written live into uLightDir. */
    light_dir?: Vector3
    /** Specular highlight intensity multiplier (highlight_strength setting).
     *  Multiplies the glossy tinted-spec term; 1.0 = byte-identical legacy
     *  look. Written live into uSpecStrength. */
    highlight_strength?: number
  } = $props()

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

  // --- Shaders ---
  // The vertex shader uses viewMatrix + modelMatrix directly (NOT modelViewMatrix)
  // because InstancedMesh bakes instanceMatrix into modelViewMatrix, and we don't
  // use instanceMatrix (we pass positions via custom attributes instead).
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
    uniform int uRenderStyle;  // 0 = glossy, 1 = matte, 2 = toon
    // Toon (cel) thresholds — AtomCanvas ToonHighlightMaterial parity.
    uniform float uShadowThreshold;
    uniform float uHighlightThreshold;
    uniform float uShadowBrightness;
    uniform float uSpecStrength;  // glossy specular highlight multiplier (1.0 = default)
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

    // 3-point procedural studio env (key + fill + sky/ground gradient).
    // n is view-space normal. Returns linear-RGB env response for that normal.
    vec3 studio_env(vec3 n, vec3 keyDir) {
      vec3 col = vec3(0.0);
      // Quadratic falloff (cheap, no pow) — visually close to pow 1.4.
      float k = max(dot(n, keyDir), 0.0);
      col += vec3(1.00, 0.97, 0.92) * (k * k) * 0.55;
      vec3 fillDir = normalize(vec3(-keyDir.x * 0.9, keyDir.y * 0.4, keyDir.z * 0.6));
      float f = max(dot(n, fillDir), 0.0);
      col += vec3(0.88, 0.93, 1.00) * (f * f) * 0.30;
      float sky = n.y * 0.5 + 0.5;
      col += mix(vec3(0.42, 0.43, 0.50), vec3(0.95, 0.97, 1.00), sky) * 0.22;
      return col;
    }

    // ACES filmic tonemap — preserves highlights, no clipping to white
    vec3 aces_tonemap(vec3 x) {
      return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
    }

    void main() {
      // Ray-sphere intersection in view space.
      // Uses cross-product formulation to avoid catastrophic cancellation
      // when vCenter has large values (periodic structures with lattice offsets).
      // The algebraic b²−4ac form subtracts two ~|vCenter|² values, losing
      // precision and creating visible concentric banding on sphere surfaces.

      vec3 fragViewPos = vec3(vCenter.xy + vQuadCoord * vRadius * 1.05, vCenter.z);

      vec3 hitPos;
      vec3 normal;

      if (uIsOrthographic) {
        // Orthographic: ray origin at fragment XY on near plane, direction -Z
        // Perpendicular distance from ray to sphere center is just the XY offset
        vec2 offset = vQuadCoord * vRadius * 1.05;
        float d2 = dot(offset, offset);
        float r2 = vRadius * vRadius;
        if (d2 > r2) discard;
        float thc = sqrt(r2 - d2);
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
        if (d2 > r2) discard;

        float tca = dot(vCenter, rayDir);
        float thc = sqrt(r2 - d2);
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

      vec3 keyDir = normalize(uLightDir);
      vec3 viewDir = uIsOrthographic ? vec3(0.0, 0.0, 1.0) : normalize(-hitPos);
      // NdotV is needed by both the glossy fresnel and the shared outline pass.
      float NdotV = max(dot(normal, viewDir), 0.0);

      vec3 color;
      if (uRenderStyle == 2) {
        // ── Toon: 3-band cel shading (AtomCanvas ToonHighlightMaterial) ──
        // Per-instance baseColor stands in for the reference's uColor/vTint;
        // vOpacity carries the per-instance alpha (instanceAlpha equivalent).
        float diffuse = dot(normal, keyDir);
        if (diffuse > uHighlightThreshold) {
          color = vec3(1.0, 1.0, 1.0);
        } else if (diffuse > uShadowThreshold) {
          color = baseColor;
        } else {
          color = baseColor * uShadowBrightness;
        }
      } else if (uRenderStyle == 1) {
        // ── Matte: diffuse-only (roughness 1, metalness 0, no spec/fresnel) ──
        float diffuse = max(dot(normal, keyDir), 0.0);
        color = baseColor * (uAmbientIntensity + uDirectionalIntensity * diffuse);
        color = aces_tonemap(color);
      } else {
        // ── Glossy (default): studio env + tinted specular + fresnel rim ──
        vec3 env = studio_env(normal, keyDir);

        // Tight Blinn-Phong specular — small, refined highlight.
        // pow(.., 64) is ~half the cost of pow(.., 80) and gives a tighter
        // spot than pow 32 (which created broad "white blob" artifacts on
        // saturated atoms).
        vec3 halfDir = normalize(keyDir + viewDir);
        float specular = pow(max(dot(normal, halfDir), 0.0), 64.0);

        // Schlick Fresnel — premium rim highlight
        float fresnel = pow(1.0 - NdotV, 5.0);

        // Tint specular by the atom color so green/red/etc. atoms get a
        // material-tinted highlight (ceramic look) instead of a pure-white
        // sticker. mix factor 0.55 = 55% atom color + 45% white.
        vec3 specColor = mix(vec3(1.0), baseColor, 0.55);

        // Compose: env-shaded base color + tinted specular + subtle fresnel
        float exposure = uAmbientIntensity + uDirectionalIntensity * 0.5;
        color = baseColor * env * exposure
                 + specColor * specular * uDirectionalIntensity * 0.6 * uSpecStrength
                 + vec3(fresnel * 0.12);

        // Filmic tonemap before sRGB encode
        color = aces_tonemap(color);
      }

      gl_FragColor = vec4(linearTosRGB(color), vOpacity);

      // Depth cueing: VESTA-style fade toward background
      if (uDepthCueing > 0.0) {
        float depthZ = -hitPos.z; // view-space depth of the hit point
        float fade = clamp((depthZ - uDepthNear) / max(uDepthFar - uDepthNear, 0.01), 0.0, 1.0) * uDepthCueing;
        gl_FragColor.rgb = mix(gl_FragColor.rgb, uDepthCueBgColor, fade);
      }

      // 3Dmol-inspired silhouette outline: darken pixels at glancing angles
      // (high 1 - NdotV). smoothstep gives a clean ring without bleeding into
      // the body. Skipped when uOutlineStrength == 0 so default visuals are
      // unchanged.
      if (uOutlineStrength > 0.0) {
        float silhouette = smoothstep(0.55, 1.0, 1.0 - NdotV);
        gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.0), silhouette * uOutlineStrength);
      }

    }
  `

  // --- Separate geometries for each mesh (InstancedBufferAttributes are per-geometry) ---
  const opaque_geometry = new PlaneGeometry(2, 2, 1, 1)
  const transparent_geometry = new PlaneGeometry(2, 2, 1, 1)

  // --- Shader material creation ---
  function create_material(transparent: boolean): ShaderMaterial {
    return new ShaderMaterial({
      vertexShader: vertex_shader,
      fragmentShader: fragment_shader,
      transparent,
      depthWrite: !transparent,
      depthTest: !transparent, // transparent atoms skip depth test so they're always visible
      side: 0, // FrontSide: billboard always faces camera, DoubleSide causes double-blending at same pixels
      uniforms: {
        uIsOrthographic: { value: false },
        uLightDir: { value: light_dir.clone() }, // view-space headlamp (slider-driven); kept live by $effect below
        uAmbientIntensity: { value: ambient_light },
        uDirectionalIntensity: { value: directional_light },
        uDepthCueing: depth_cue_uniforms.uDepthCueing,
        uDepthNear: depth_cue_uniforms.uDepthNear,
        uDepthFar: depth_cue_uniforms.uDepthFar,
        uDepthCueBgColor: depth_cue_uniforms.uDepthCueBgColor,
        uOutlineStrength: depth_cue_uniforms.uOutlineStrength,
        uRenderStyle: { value: render_style_to_int(render_style) },
        // Glossy specular highlight multiplier (slider-driven); kept live by $effect below.
        uSpecStrength: { value: highlight_strength },
        // Toon (cel) thresholds — AtomCanvas ToonHighlightMaterial defaults.
        uShadowThreshold: { value: 0.3 },
        uHighlightThreshold: { value: 0.97 },
        uShadowBrightness: { value: 0.5 },
      },
    })
  }

  // Map onto the three uRenderStyle shader branches (0 glossy, 1 matte, 2 toon).
  // Metallic reuses the glossy branch; 2.5D-soft and 2D-flat reuse the matte
  // branch — their distinct look comes from the per-style lighting profile.
  function render_style_to_int(
    style: `glossy` | `metallic` | `matte` | `soft` | `flat` | `toon` | `matcap`,
  ): number {
    if (style === `toon`) return 2
    if (style === `matte` || style === `soft` || style === `flat`) return 1
    // MatCap has no branch in this legacy impostor shader — fall back to glossy.
    // The default path (AtomManagerInstances) implements the real matcap.
    return 0
  }

  let opaque_material = create_material(false)
  let transparent_material = create_material(true)

  // --- Mesh refs ---
  let opaque_mesh: InstancedMesh | undefined = $state()
  let transparent_mesh: InstancedMesh | undefined = $state()

  // Reusable buffers (grown as needed)
  let opaque_positions = new Float32Array(0)
  let opaque_radii = new Float32Array(0)
  let opaque_colors = new Float32Array(0)
  let opaque_opacities = new Float32Array(0)
  let opaque_saturations = new Float32Array(0)

  let trans_positions = new Float32Array(0)
  let trans_radii = new Float32Array(0)
  let trans_colors = new Float32Array(0)
  let trans_opacities = new Float32Array(0)
  let trans_saturations = new Float32Array(0)

  const tmp_color = new Color()
  const identity = new Matrix4()

  // Fixed initial capacity for InstancedMesh construction.
  // Threlte may NOT recreate the mesh when args change, so we start with a
  // reasonable capacity and let update_mesh_attributes() grow it dynamically.
  // This prevents invisible atoms caused by stale mesh refs after a remount race.
  const INITIAL_CAPACITY = 64

  // --- Update uniforms reactively ---
  $effect(() => {
    const cam = threlte.camera.current
    const is_ortho = cam ? !!(cam as any).isOrthographicCamera : false
    opaque_material.uniforms.uIsOrthographic.value = is_ortho
    transparent_material.uniforms.uIsOrthographic.value = is_ortho
    // mark_dirty: imperative ShaderMaterial uniform write bypasses <T.> prop chain
    mark_dirty()
  })

  $effect(() => {
    opaque_material.uniforms.uAmbientIntensity.value = ambient_light
    transparent_material.uniforms.uAmbientIntensity.value = ambient_light
    opaque_material.uniforms.uDirectionalIntensity.value = directional_light
    transparent_material.uniforms.uDirectionalIntensity.value = directional_light
    // mark_dirty: imperative ShaderMaterial uniform write bypasses <T.> prop chain
    mark_dirty()
  })

  // Render-style is a uniform int branch in the fragment shader — no recompile,
  // no material swap, so glossy/matte/toon toggle live with zero GPU churn.
  $effect(() => {
    const v = render_style_to_int(render_style)
    opaque_material.uniforms.uRenderStyle.value = v
    transparent_material.uniforms.uRenderStyle.value = v
    // mark_dirty: imperative ShaderMaterial uniform write bypasses <T.> prop chain
    mark_dirty()
  })

  // Headlamp direction is a plain view-space uniform — copy the slider-derived
  // direction into both materials live so light moves the instant the slider does.
  $effect(() => {
    opaque_material.uniforms.uLightDir.value.copy(light_dir)
    transparent_material.uniforms.uLightDir.value.copy(light_dir)
    // mark_dirty: imperative ShaderMaterial uniform write bypasses <T.> prop chain
    mark_dirty()
  })

  // Specular highlight strength is a plain float uniform — copy the slider value
  // into both materials live so glossiness changes the instant the slider moves.
  $effect(() => {
    opaque_material.uniforms.uSpecStrength.value = highlight_strength
    transparent_material.uniforms.uSpecStrength.value = highlight_strength
    // mark_dirty: imperative ShaderMaterial uniform write bypasses <T.> prop chain
    mark_dirty()
  })

  // VESTA-style headlamp: light is fixed in view space (follows camera).
  // This ensures every atom has a bright center and dark edges regardless
  // of rotation, matching VESTA's lighting model.

  // --- Helper: get effective opacity for an atom ---
  function get_effective_opacity(site_idx: number): number {
    let opacity = atom_opacity_overrides.get(site_idx) ?? 1
    // Image atoms inherit per-atom opacity from their original atom
    if (opacity === 1 && num_original_sites !== undefined && site_idx >= num_original_sites && image_to_original_map) {
      const orig_idx = image_to_original_map[site_idx - num_original_sites]
      if (orig_idx !== undefined) opacity = atom_opacity_overrides.get(orig_idx) ?? 1
    }
    if (num_original_sites !== undefined && site_idx >= num_original_sites && image_atom_opacity < 1) {
      opacity *= image_atom_opacity
    }
    if (cutting_active && cutting_visibility_map.size > 0) {
      const vis = cutting_visibility_map.get(site_idx)
      if (vis) opacity *= vis.opacity
    }
    return opacity
  }

  function get_effective_saturation(site_idx: number): number {
    if (cutting_active && cutting_visibility_map.size > 0) {
      const vis = cutting_visibility_map.get(site_idx)
      if (vis) return vis.saturation
    }
    return 1
  }

  // Ensure buffer is large enough; returns existing or new buffer
  function ensure_buffer(buf: Float32Array<ArrayBuffer>, needed: number): Float32Array<ArrayBuffer> {
    if (buf.length >= needed) return buf
    return new Float32Array(Math.max(needed, buf.length * 2))
  }

  // Initialize InstancedMesh instanceMatrix to identity so Three.js doesn't
  // multiply by zero matrices (Float32Array is zero-filled by default)
  function init_instance_matrices(mesh: InstancedMesh, count: number) {
    for (let i = 0; i < count; i++) {
      mesh.setMatrixAt(i, identity)
    }
    mesh.instanceMatrix.needsUpdate = true
  }

  // --- Color cache: avoid re-parsing hex strings every frame ---
  // Maps color hex string → [r, g, b] in linear space
  let color_cache = new Map<string, [number, number, number]>()

  function get_linear_color(hex: string): [number, number, number] {
    let cached = color_cache.get(hex)
    if (cached) return cached
    tmp_color.set(hex).convertSRGBToLinear()
    cached = [tmp_color.r, tmp_color.g, tmp_color.b]
    color_cache.set(hex, cached)
    return cached
  }

  // --- Site-to-buffer mapping for fast-path position updates ---
  // Maps site_idx -> { mesh: 'opaque'|'transparent', buffer_idx: number }
  // Rebuilt only on full updates, used by drag fast-path to update only positions.
  let site_buffer_map = new Map<number, { opaque: boolean; idx: number }>()
  let last_opaque_count = 0
  let last_trans_count = 0

  // --- Full buffer update effect ---
  // Runs when atom data, colors, opacity, or cutting changes.
  // During drag (when only positions change), the fast-path below handles it.
  $effect(() => {
    // Access reactive dependencies (NOT realtime_position_overrides — that's the fast path)
    const data = atom_data
    const _cutting = cutting_active
    const _vis_map_size = cutting_visibility_map.size
    const _opacity_overrides_size = atom_opacity_overrides.size
    const _image_opacity = image_atom_opacity
    const _num_orig = num_original_sites
    const _image_map = image_to_original_map

    if (!opaque_mesh || !transparent_mesh) return

    const max_count = data.length
    opaque_positions = ensure_buffer(opaque_positions, max_count * 3)
    opaque_radii = ensure_buffer(opaque_radii, max_count)
    opaque_colors = ensure_buffer(opaque_colors, max_count * 3)
    opaque_opacities = ensure_buffer(opaque_opacities, max_count)
    opaque_saturations = ensure_buffer(opaque_saturations, max_count)

    trans_positions = ensure_buffer(trans_positions, max_count * 3)
    trans_radii = ensure_buffer(trans_radii, max_count)
    trans_colors = ensure_buffer(trans_colors, max_count * 3)
    trans_opacities = ensure_buffer(trans_opacities, max_count)
    trans_saturations = ensure_buffer(trans_saturations, max_count)

    const new_map = new Map<number, { opaque: boolean; idx: number }>()
    let oi = 0
    let ti = 0

    for (let idx = 0; idx < data.length; idx++) {
      const atom = data[idx]
      if (atom.has_partial_occupancy) continue

      const opacity = get_effective_opacity(atom.site_idx)
      if (opacity <= 0) continue

      // Use base position (not overrides) for full rebuild
      const pos = realtime_position_overrides?.get(atom.site_idx) ?? atom.position
      const [cr, cg, cb] = get_linear_color(atom.color)
      const sat = get_effective_saturation(atom.site_idx)
      const visual_radius = atom.radius * 0.5

      if (opacity >= 1) {
        new_map.set(atom.site_idx, { opaque: true, idx: oi })
        const i3 = oi * 3
        opaque_positions[i3] = pos[0]
        opaque_positions[i3 + 1] = pos[1]
        opaque_positions[i3 + 2] = pos[2]
        opaque_radii[oi] = visual_radius
        opaque_colors[i3] = cr
        opaque_colors[i3 + 1] = cg
        opaque_colors[i3 + 2] = cb
        opaque_opacities[oi] = 1
        opaque_saturations[oi] = sat
        oi++
      } else {
        new_map.set(atom.site_idx, { opaque: false, idx: ti })
        const i3 = ti * 3
        trans_positions[i3] = pos[0]
        trans_positions[i3 + 1] = pos[1]
        trans_positions[i3 + 2] = pos[2]
        trans_radii[ti] = visual_radius
        trans_colors[i3] = cr
        trans_colors[i3 + 1] = cg
        trans_colors[i3 + 2] = cb
        trans_opacities[ti] = opacity
        trans_saturations[ti] = sat
        ti++
      }
    }

    site_buffer_map = new_map
    last_opaque_count = oi
    last_trans_count = ti

    update_mesh_attributes(opaque_mesh, oi, opaque_positions, opaque_radii, opaque_colors, opaque_opacities, opaque_saturations)
    update_mesh_attributes(transparent_mesh, ti, trans_positions, trans_radii, trans_colors, trans_opacities, trans_saturations)

    // Threlte 8 is render-on-demand — GPU attribute writes need invalidate() or
    // the upload sits unpainted until the camera moves.
    mark_dirty()
  })

  // --- Fast-path: position-only update during drag ---
  // Only writes position buffers (not color/radius/opacity/saturation).
  // Triggers when realtime_position_overrides changes.
  $effect(() => {
    const overrides = realtime_position_overrides
    if (!overrides || overrides.size === 0) return
    if (!opaque_mesh || !transparent_mesh) return
    if (site_buffer_map.size === 0) return

    let opaque_dirty = false
    let trans_dirty = false

    for (const [site_idx, pos] of overrides) {
      const mapping = site_buffer_map.get(site_idx)
      if (!mapping) continue

      if (mapping.opaque) {
        const i3 = mapping.idx * 3
        opaque_positions[i3] = pos[0]
        opaque_positions[i3 + 1] = pos[1]
        opaque_positions[i3 + 2] = pos[2]
        opaque_dirty = true
      } else {
        const i3 = mapping.idx * 3
        trans_positions[i3] = pos[0]
        trans_positions[i3 + 1] = pos[1]
        trans_positions[i3 + 2] = pos[2]
        trans_dirty = true
      }
    }

    // Only mark the position attribute as needing update (not all 5 attributes)
    if (opaque_dirty) {
      const attr = opaque_mesh.geometry.getAttribute(`instancePosition`)
      if (attr) attr.needsUpdate = true
    }
    if (trans_dirty) {
      const attr = transparent_mesh.geometry.getAttribute(`instancePosition`)
      if (attr) attr.needsUpdate = true
    }

    // Threlte 8 render-on-demand: position writes during drag need invalidate().
    if (opaque_dirty || trans_dirty) mark_dirty()
  })

  function update_mesh_attributes(
    mesh: InstancedMesh,
    count: number,
    positions: Float32Array,
    radii: Float32Array,
    colors: Float32Array,
    opacities: Float32Array,
    saturations: Float32Array,
  ) {
    // Grow instanceMatrix if needed — Three.js InstancedMesh allocates it at
    // construction time with a fixed capacity. If atom count exceeds that,
    // WebGL reads out-of-bounds from the instanceMatrix buffer, which silently
    // fails the draw call on most GPU drivers (atoms become invisible).
    const current_capacity = mesh.instanceMatrix.array.length / 16
    if (count > current_capacity) {
      const new_capacity = Math.max(count, Math.ceil(current_capacity * 2))
      const new_array = new Float32Array(new_capacity * 16)
      for (let idx = 0; idx < new_capacity; idx++) {
        identity.toArray(new_array, idx * 16)
      }
      mesh.instanceMatrix = new InstancedBufferAttribute(new_array, 16)
      mesh.instanceMatrix.needsUpdate = true
    }

    const geom = mesh.geometry

    // Update or create each attribute
    set_instanced_attr(geom, `instancePosition`, positions, 3)
    set_instanced_attr(geom, `instanceRadius`, radii, 1)
    set_instanced_attr(geom, `instanceAtomColor`, colors, 3)
    set_instanced_attr(geom, `instanceOpacity`, opacities, 1)
    set_instanced_attr(geom, `instanceSaturation`, saturations, 1)

    mesh.count = count
  }

  function set_instanced_attr(
    geom: BufferGeometry,
    name: string,
    buffer: Float32Array,
    item_size: number,
  ) {
    const existing = geom.getAttribute(name) as InstancedBufferAttribute | undefined
    if (existing?.array === buffer) {
      existing.needsUpdate = true
    } else {
      geom.setAttribute(name, new InstancedBufferAttribute(buffer, item_size))
    }
  }
</script>

<!-- Opaque atoms: depthWrite on, renders first -->
<T.InstancedMesh
  args={[opaque_geometry, opaque_material, INITIAL_CAPACITY]}
  bind:ref={opaque_mesh}
  frustumCulled={false}
  raycast={null}
  oncreate={(mesh) => init_instance_matrices(mesh, INITIAL_CAPACITY)}
/>

<!-- Transparent atoms: depthWrite off, renders after opaque -->
<T.InstancedMesh
  args={[transparent_geometry, transparent_material, INITIAL_CAPACITY]}
  bind:ref={transparent_mesh}
  frustumCulled={false}
  raycast={null}
  renderOrder={1}
  oncreate={(mesh) => init_instance_matrices(mesh, INITIAL_CAPACITY)}
/>

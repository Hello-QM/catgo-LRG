<script lang="ts">
  import { untrack } from 'svelte'
  import { T, useThrelte } from '@threlte/core'
  import type { InstancedMesh } from 'three'
  import {
    BoxGeometry,
    Color,
    CylinderGeometry,
    DataTexture,
    FloatType,
    Matrix3,
    NearestFilter,
    RGBAFormat,
    ShaderMaterial,
    Vector3,
  } from 'three'
  import { get_bond_key } from '../bonding'
  import { BondInstancedRenderer, type PartnerDrawnLookup } from './bond-instanced-renderer'
  import { bond_geometry_mode } from './bond-geometry-mode'
  import { bond_lod_segments } from './bond-lod'
  import type { BondManager } from './bond-manager.svelte'
  import type { ImageAtomLayout } from './image-atom-layout'

  interface Props {
    bond_manager: BondManager
    atom_positions: Float32Array
    /** Flat linear-RGB buffer (3 floats per site). Index by bond's site_idx to get color. */
    atom_colors: Float32Array
    positions_version?: number
    bond_radius?: number
    /** Pass-through to the shader for global saturation. Default 1.0. */
    saturation?: number
    /** Pass-through to the shader for global brightness. Default 1.0. */
    brightness?: number
    /** Opacity for all bonds. Default 1.0. */
    opacity?: number
    /** Optional depth-cue uniforms from the parent. If omitted, safe defaults are used. */
    depth_cue_uniforms?: {
      uDepthCueing: { value: number }
      uDepthNear: { value: number }
      uDepthFar: { value: number }
      uDepthCueBgColor: { value: Color }
      uOutlineStrength: { value: number }       // unused here — kept for shape match
      uBondOutlineStrength: { value: number }
    }
    max_capacity?: number
    /**
     * Per-bond-key opacity overrides. Default opacity is 1.0 (fully opaque).
     * Entries not in this map use 1.0 (modulo the periodic-bond multiplier).
     */
    bond_opacity_overrides?: Map<string, number> | ReadonlyMap<string, number>
    /**
     * Multiplier applied to cross-cell (periodic) bonds — bonds whose
     * `jimage` is non-zero. Lets users de-emphasize PBC bonds without
     * affecting intra-cell bonds. Default 1 (no effect).
     */
    periodic_bond_opacity?: number
    /**
     * Lattice matrix as a 3×3 row-major Float64Array of length 9: rows are
     * lattice vectors a, b, c (pymatgen convention). Required for rendering
     * cross-cell bonds correctly — the renderer applies
     * `b_eff = pos_b + lattice·jimage` per-bond. `null` for molecules.
     */
    lattice_matrix?: Float64Array | null
    /**
     * Variable-cell trajectory override: the DISPLAYED frame's lattice in the
     * same row-major Float64Array(9) layout as `lattice_matrix`. Fed ONLY to
     * the uLattice uniform and the renderer's per-slot lattice getter — the
     * full-resync config effect keeps tracking the static `lattice_matrix`,
     * so a per-frame identity change here costs one mat3 uniform write, not
     * a full buffer rebuild. `null` = fixed cell (use `lattice_matrix`).
     */
    frame_lattice_matrix?: Float64Array | null
    /**
     * VESTA-Mode-1 cell-edge style: when true, cross-cell bonds (jimage ≠ 0)
     * render as a single stub on atom A's side of the boundary instead of
     * paired stubs on both sides. Default false (paired stubs).
     */
    incomplete_periodic_edge_mode?: boolean
    /**
     * Length multiplier applied to the visible stub when
     * `incomplete_periodic_edge_mode` is on. 1.0 = full half-bond length;
     * 0.5 (default) is the conventional VESTA stub size.
     */
    incomplete_edge_length_scale?: number
    /**
     * When true, suppress cell-internal cross-cell bond stubs whose partner
     * image atom is not present in the image-atom draw set. Matches
     * Materials Project / VESTA defaults — eliminates "dangling stub"
     * artifacts on slab structures where image atoms aren't drawn.
     */
    hide_incomplete_bonds?: boolean
    /**
     * Phase 7 image-atom decorator layout. When non-null, the renderer
     * writes additional half-bond instances at image-atom-shifted positions
     * after the cell-internal range. Pass `null` (or a layout with
     * `n_image_atoms === 0`) to disable the decorator pass — restores
     * Phase 4-6 behavior. Layout reference changes trigger a full resync.
     */
    image_atom_layout?: ImageAtomLayout | null
    /**
     * Phase 7d partner-drawn predicate. When provided and the partner of a
     * decorator's bond is NOT in `sites_to_draw`, the renderer emits an
     * incomplete-edge stub on the anchor side instead of a full bond.
     * `null` (default) treats every partner as drawn — Phase 7c behavior.
     */
    partner_drawn_lookup?: PartnerDrawnLookup | null
    /** View-space headlamp direction (x=right, y=up, z=toward camera). Driven
     *  by the light_azimuth/elevation sliders; written live into uLightDir. */
    light_dir?: Vector3
    /** Specular highlight intensity multiplier (highlight_strength setting).
     *  Multiplies the bond glossy spec term; 1.0 = byte-identical legacy look.
     *  Written live into uSpecStrength. */
    highlight_strength?: number
    /**
     * Adsorbate bond-order rendering. When true, each logical bond reserves 6
     * instances (3 lines × 2 halves) and bonds whose perceived order > 1 draw
     * as multi-cylinder double/triple/aromatic bonds. Default false → the
     * verbatim single-cylinder (2 instances/bond) path, byte-identical to today.
     */
    multibond_enabled?: boolean
    /**
     * GPU vertex-transform playback mode (trajectory typed-direct). When true
     * AND the current config is GPU-eligible (no multibond, no decorator
     * image atoms), per-instance mat4
     * composition + upload is replaced by: static topology attributes
     * (a_site / a_jimage / a_half, written once per topology change) + a
     * per-atom RGBA32F position texture (one ~16·N-byte upload per frame).
     * The vertex shader reconstructs each half-cylinder transform in-shader.
     * Ineligible configs silently stay on the CPU instanceMatrix path.
     */
    gpu_transform_active?: boolean
    /**
     * Hard cap for in-shader bond length in the GPU path. Bonds whose
     * current-frame length exceeds this collapse to zero scale — mirrors the
     * typed-topology conversion filter (MAX_BOND_LENGTH) and guards against
     * stale-topology / fresh-positions races during async detection.
     */
    max_bond_length?: number
  }

  let {
    bond_manager,
    atom_positions,
    atom_colors,
    positions_version = 0,
    bond_radius = 0.15,
    saturation = 1.0,
    brightness = 1.0,
    opacity = 1.0,
    depth_cue_uniforms,
    max_capacity = 1_000_000,
    bond_opacity_overrides,
    periodic_bond_opacity = 1,
    lattice_matrix = null,
    frame_lattice_matrix = null,
    incomplete_periodic_edge_mode = false,
    incomplete_edge_length_scale = 0.5,
    hide_incomplete_bonds = true,
    image_atom_layout = null,
    partner_drawn_lookup = null,
    light_dir = new Vector3(0.4, 0.7, 0.6).normalize(),
    highlight_strength = 1.0,
    multibond_enabled = false,
    gpu_transform_active = false,
    max_bond_length = 4.0,
  }: Props = $props()

  // GPU-transform eligibility. v1 exclusions (all fall back to the CPU
  // instanceMatrix path, zero regression surface):
  //   - multibond (per-slot stride 6 + order-dependent line counts);
  //   - non-empty decorator range (image atoms drawn — the decorator pass
  //     writes CPU matrices past the cell-internal range).
  // Cross-cell bonds are handled in-shader for BOTH hide_incomplete modes:
  // collapse (hide ON) and Phase-6 paired stubs (hide OFF, uStubMode /
  // uStubScale) — exact parity with #write_slot's periodic branch.
  // DEV escape hatch: `globalThis.__catgo_disable_gpu_bonds = true` forces
  // the CPU path for in-session A/B benchmarking.
  const gpu_active = $derived(
    gpu_transform_active &&
      !multibond_enabled &&
      (image_atom_layout === null || image_atom_layout.n_image_atoms === 0) &&
      !(import.meta.env?.DEV &&
        (globalThis as { __catgo_disable_gpu_bonds?: boolean })
          .__catgo_disable_gpu_bonds),
  )

  let mesh = $state<InstancedMesh | undefined>()
  let renderer: BondInstancedRenderer | undefined

  // Threlte renders on-demand; after GPU-attribute uploads we must ask for a
  // frame. Without this, bond restores after Ctrl+Z sit in the buffer
  // invisibly until camera movement or a structure change triggers a repaint.
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

  // Per-atom position texture geometry for the GPU-transform path. Fixed
  // power-of-two width keeps the shader's index→texel math to two bit ops;
  // height grows with atom count (1024 × 2048 texels = 2M atoms headroom,
  // way past MAX_TEXTURE_SIZE concerns at realistic sizes).
  const POS_TEX_WIDTH = 1024
  const POS_TEX_SHIFT = 10 // log2(POS_TEX_WIDTH)
  // Zero lattice ≡ "no lattice": uLattice·jimage adds nothing, so a bond
  // with a non-zero jimage but no lattice renders from the base position —
  // exact parity with #write_slot's null-lattice fallback.
  const ZERO_LATTICE = [0, 0, 0, 0, 0, 0, 0, 0, 0]

  // Vertex shader has two transform paths selected by the uGpuXform uniform
  // (uniform branch — no recompile / material swap on playback start):
  //   0 (default): per-instance mat4 from instanceMatrix (CPU-composed).
  //   1 (typed-direct trajectory playback): the transform is reconstructed
  //     in-shader from static topology attributes (a_site / a_jimage /
  //     a_half) + a per-atom RGBA32F position texture. Per frame only the
  //     position texture (16 bytes/atom) is uploaded — the 64-byte/instance
  //     matrix rewrite and its CPU compose loop are skipped entirely.
  // Position texture layout: fixed width ${POS_TEX_WIDTH}; atom i sits at
  // texel (i % width, i / width); xyz in rgb, alpha unused. texelFetch is
  // available because three r163+ is WebGL2-only (GLSL is compiled as
  // "#version 300 es" with compatibility defines).
  const vertex_shader = `
    attribute vec3 instance_color_start;
    attribute vec3 instance_color_end;
    attribute float instance_opacity;
    // GPU-transform (playback) topology attributes. Absent from the geometry
    // until the first GPU sync -- WebGL then feeds constant 0s, and the
    // uGpuXform=0 branch never reads them.
    attribute vec2 a_site;    // endpoint site indices (a, b)
    attribute vec3 a_jimage;  // lattice image of atom B (Int8, non-normalized)
    attribute float a_half;   // 0 = half A (anchored at a), 1 = half B
    uniform float uGpuXform;
    uniform sampler2D uPosTex;      // RGBA32F, 1 texel per atom
    uniform float uNAtoms;          // live atom count in uPosTex
    uniform mat3 uLattice;          // columns = lattice vectors a, b, c; zero when no lattice
    uniform float uHideIncomplete;  // collapse cross-cell bonds (parity with #write_slot)
    uniform float uMaxBondLength;   // hard cap; longer bonds collapse (stale-topology guard)
    uniform float uStubMode;        // incomplete_periodic_edge_mode (VESTA Mode 1)
    uniform float uStubScale;       // stub length multiplier when uStubMode is on
    varying vec3 vColorStart;
    varying vec3 vColorEnd;
    varying float vYPosition;
    varying float vOpacity;
    varying vec3 vNormal;
    varying vec3 vViewPosition;
    varying float vDepthCueZ;

    void main() {
      vColorStart = instance_color_start;
      vColorEnd = instance_color_end;
      vYPosition = position.y;
      vOpacity = instance_opacity;

      vec3 transformed;
      vec3 objectNormal;

      if (uGpuXform > 0.5) {
        int ia = int(a_site.x + 0.5);
        int ib = int(a_site.y + 0.5);
        vec3 pa = texelFetch(uPosTex, ivec2(ia & ${POS_TEX_WIDTH - 1}, ia >> ${POS_TEX_SHIFT}), 0).xyz;
        vec3 pb_base = texelFetch(uPosTex, ivec2(ib & ${POS_TEX_WIDTH - 1}, ib >> ${POS_TEX_SHIFT}), 0).xyz;
        bool periodic = dot(abs(a_jimage), vec3(1.0)) > 0.5;
        // b_eff = pos_b + lattice * jimage (uLattice columns are the lattice
        // rows a,b,c, so the mat*vec product matches pbc.rs / #write_slot).
        vec3 pb = periodic ? pb_base + uLattice * a_jimage : pb_base;
        vec3 d = pb - pa;
        float len = length(d);
        // Collapse to zero scale (ZERO_MATRIX parity) when: endpoint index
        // is past the live position buffer (stale-frame safety net), length
        // is degenerate / non-finite (!(len > eps) also catches NaN), the
        // bond exceeds the hard cap, or it is a cross-cell bond under
        // hide_incomplete_bonds.
        bool collapse = a_site.x >= uNAtoms || a_site.y >= uNAtoms ||
          !(len > 1e-6) || len > uMaxBondLength ||
          (periodic && uHideIncomplete > 0.5);
        if (collapse) {
          transformed = vec3(0.0);
          objectNormal = vec3(0.0, 0.0, 1.0);
        } else {
          vec3 dir = d / len;
          // Deterministic orthonormal basis with dir as the cylinder's Y
          // axis. Roll around the axis is arbitrary -- the cylinder is
          // rotationally symmetric, so this matches the CPU quaternion path
          // visually.
          vec3 ref = abs(dir.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
          vec3 xb = normalize(cross(ref, dir));
          vec3 zb = cross(xb, dir);
          float half_len = 0.5 * len;
          vec3 mid;
          float y_len;
          if (periodic) {
            // Phase 6 outward paired stubs (hide_incomplete OFF; the ON case
            // collapsed above). Half A anchored at pa pointing toward b_eff;
            // half B anchored at the BASE pos_b pointing -dir. Full
            // half-length unless VESTA Mode 1 shortens it (uStubScale).
            float stub_len = half_len * (uStubMode > 0.5 ? uStubScale : 1.0);
            y_len = stub_len;
            mid = a_half < 0.5
              ? pa + dir * (0.5 * stub_len)
              : pb_base - dir * (0.5 * stub_len);
          } else {
            // Intra-cell: half A center = 0.75*pa + 0.25*pb; half B =
            // 0.25*pa + 0.75*pb; unit-height cylinder scales to half_length
            // along the axis. Radius is baked into the geometry
            // (radius_scale = 1 on the single-line path).
            y_len = half_len;
            mid = mix(pa, pb, 0.25 + 0.5 * a_half);
          }
          transformed = xb * position.x + dir * (position.y * y_len) +
            zb * position.z + mid;
          // Basis is orthonormal and radial/cap normals are invariant under
          // the axis-only scale, so no inverse-transpose is needed.
          objectNormal = xb * normal.x + dir * normal.y + zb * normal.z;
        }
      } else {
        // Compute instance normal matrix (inverse-transpose) for correct normals
        // under non-uniform scaling. mat3(instanceMatrix) alone squishes radial
        // normals toward the cylinder axis, producing flat shading.
        // We use the cofactor (cross-product) trick: cofactor columns are
        // proportional to inverse-transpose columns.
        mat3 m = mat3(instanceMatrix);
        mat3 instanceNormalMat;
        instanceNormalMat[0] = cross(m[1], m[2]);
        instanceNormalMat[1] = cross(m[2], m[0]);
        instanceNormalMat[2] = cross(m[0], m[1]);
        objectNormal = instanceNormalMat * normal;
        transformed = (instanceMatrix * vec4(position, 1.0)).xyz;
      }

      vNormal = normalize(normalMatrix * objectNormal);
      vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
      vViewPosition = mvPosition.xyz;
      gl_Position = projectionMatrix * mvPosition;
      vDepthCueZ = -mvPosition.z;
    }
  `

  // Impostor (ray-cylinder) vertex shader for the GPU-transform trajectory
  // path. It mirrors #524's uGpuXform-branch geometry at parity -- same
  // endpoint texelFetch, b_eff = pb_base + uLattice*a_jimage, intra-cell mid,
  // periodic paired-stub (uStubMode / uStubScale), and the same collapse
  // conditions -- but instead of transforming a cylinder vertex + emitting a
  // surface normal, it maps a unit OBB box (Task 2's BoxGeometry, corners in
  // [-1,1]) onto each half-bond and passes the half-cylinder's view-space
  // frame (base / axis / radius) to the fragment stage (Task 4), which
  // ray-casts the true cylinder surface. uBondRadius / uInvProjection are
  // wired as uniforms in Task 5.
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
      // Deterministic perp basis (same roll-arbitrary choice as #524).
      vec3 ref = abs(dir.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
      vec3 xb = normalize(cross(ref, dir));
      vec3 zb = cross(xb, dir);
      float half_len = 0.5 * len;

      // Object-space half-cylinder endpoints (base -> tip along dir).
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
      // OBB corner: base + (+/-R)perp + (0..len)axis. position in [-1,1]^3 -> remap
      // z from [-1,1] to [0,1] so the box spans base->tip.
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

  const fragment_shader = `
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
    uniform vec3 uLightDir;    // directional light in view space (headlamp, normalized)
    uniform float uSpecStrength;  // glossy specular highlight multiplier (1.0 = default)
    varying vec3 vColorStart;
    varying vec3 vColorEnd;
    varying float vYPosition;
    varying float vOpacity;
    varying vec3 vNormal;
    varying vec3 vViewPosition;
    varying float vDepthCueZ;

    vec3 linearTosRGB(vec3 linear) {
      return vec3(
        linear.r <= 0.0031308 ? linear.r * 12.92 : 1.055 * pow(linear.r, 1.0/2.4) - 0.055,
        linear.g <= 0.0031308 ? linear.g * 12.92 : 1.055 * pow(linear.g, 1.0/2.4) - 0.055,
        linear.b <= 0.0031308 ? linear.b * 12.92 : 1.055 * pow(linear.b, 1.0/2.4) - 0.055
      );
    }

    // Procedural env for the bond cylinders. The old version summed a key lobe
    // and a near-opposite fill lobe — for a cylinder that left a dark VALLEY
    // along the axis (the strip whose normal is perpendicular to BOTH lights got
    // neither), read as a dark line down the middle of every bond. Replace with
    // a flat ambient floor + a single soft key so the shading is a gentle
    // one-sided gradient with no dark seam. n is the view-space normal.
    vec3 studio_env(vec3 n, vec3 keyDir) {
      // Flat ambient floor — the cylinder never goes dark on its shaded side.
      vec3 col = vec3(0.72);
      // Soft key highlight on the lit side (quadratic falloff, cheap).
      float k = max(dot(n, keyDir), 0.0);
      col += vec3(1.00, 0.97, 0.92) * (k * k) * 0.35;
      // Faint vertical sky lift for a touch of volume.
      float sky = n.y * 0.5 + 0.5;
      col += vec3(0.06, 0.06, 0.07) * sky;
      return col;
    }

    // ACES filmic tonemap — preserves highlights, no clipping to white
    vec3 aces_tonemap(vec3 x) {
      return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
    }

    void main() {
      vec3 base_color = mix(vColorStart, vColorEnd, vYPosition + 0.5);

      // Desaturate and darken for visual distinction from atoms
      float gray = dot(base_color, vec3(0.299, 0.587, 0.114));
      base_color = mix(vec3(gray), base_color, saturation) * brightness;

      vec3 viewDir = normalize(-vViewPosition);
      vec3 keyDir = normalize(uLightDir);

      // Procedural studio env replaces single-light Blinn-Phong diffuse term
      vec3 env = studio_env(vNormal, keyDir);

      // Tight Blinn-Phong specular — refined small highlight.
      vec3 halfDir = normalize(keyDir + viewDir);
      float specular = pow(max(dot(vNormal, halfDir), 0.0), 64.0);

      // Schlick Fresnel — clean rim highlight (the "premium" signature)
      float NdotV = max(dot(vNormal, viewDir), 0.0);
      float fresnel = pow(1.0 - NdotV, 5.0);

      // Soft rim mask — bonds viewed end-on (NdotV→0) get a slightly muted floor
      // so cylinders don't go pitch-dark at grazing angles.
      float rim_mask = smoothstep(0.0, 0.25, NdotV);
      float floor_lift = mix(0.18, 1.0, rim_mask);

      // Tint specular by bond base color so highlights blend, not stick.
      vec3 specColor = mix(vec3(1.0), base_color, 0.55);

      // Compose: env-shaded base + tinted specular + fresnel rim, gated by rim_mask
      float exposure = ambientIntensity + directionalIntensity * 0.5;
      vec3 final_color = base_color * env * exposure * floor_lift
                       + specColor * specular * directionalIntensity * 0.5 * rim_mask * uSpecStrength
                       + vec3(fresnel * 0.08) * rim_mask;

      // Filmic tonemap before sRGB encode — keeps colors saturated, no over-blown highlights
      final_color = aces_tonemap(final_color);

      gl_FragColor = vec4(linearTosRGB(final_color), uOpacity * vOpacity);

      // Depth cueing: fade toward background color (VESTA-style).
      // uDepthCueBgColor is linear-RGB; encode to sRGB to match gl_FragColor.
      if (uDepthCueing > 0.0) {
        float fade = clamp((vDepthCueZ - uDepthNear) / max(uDepthFar - uDepthNear, 0.01), 0.0, 1.0) * uDepthCueing;
        gl_FragColor.rgb = mix(gl_FragColor.rgb, linearTosRGB(uDepthCueBgColor), fade);
      }

      // Bond silhouette outline. Bonds already dim at the rim via
      // rim_mask, so the atom shader's tight smoothstep window was
      // mostly invisible here — widen the band (0.0 → 0.6) and add a
      // higher gain (×0.85) so the side strip visibly darkens.
      if (uBondOutlineStrength > 0.0) {
        float silhouette = smoothstep(0.0, 0.6, 1.0 - NdotV);
        gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.0), silhouette * uBondOutlineStrength * 0.85);
      }
    }
  `

  // Create material ONCE — update uniforms reactively (no shader recompilation)
  // untrack: initial values are captured intentionally; $effect below keeps them in sync
  const shader_material = untrack(() => new ShaderMaterial({
    vertexShader: vertex_shader,
    fragmentShader: fragment_shader,
    transparent: true,
    depthWrite: true,
    uniforms: {
      // Bonds are lit by their own fixed studio env (not the atom render-style
      // profile). With the flattened env (ambient floor ~0.72) exposure ~0.95
      // lands the cylinders at roughly their base colour — matching the atoms
      // they connect, no dark seam. ACES rolls off any over-bright key.
      ambientIntensity: { value: 0.8 },
      directionalIntensity: { value: 0.3 },
      saturation: { value: saturation },
      brightness: { value: brightness },
      uOpacity: { value: opacity },
      uLightDir: { value: light_dir.clone() }, // view-space headlamp (slider-driven); kept live by $effect below
      uSpecStrength: { value: highlight_strength }, // glossy spec multiplier (slider-driven); kept live by $effect below
      uDepthCueing: depth_cue_uniforms?.uDepthCueing ?? { value: 0 },
      uDepthNear: depth_cue_uniforms?.uDepthNear ?? { value: 0 },
      uDepthFar: depth_cue_uniforms?.uDepthFar ?? { value: 10 },
      uDepthCueBgColor: depth_cue_uniforms?.uDepthCueBgColor ?? { value: new Color(0xffffff) },
      uBondOutlineStrength: depth_cue_uniforms?.uBondOutlineStrength ?? { value: 0 },
      // GPU-transform playback path (kept in sync by the effects below).
      uGpuXform: { value: 0 },
      uPosTex: { value: null },
      uNAtoms: { value: 0 },
      uLattice: { value: new Matrix3().fromArray(ZERO_LATTICE) },
      uHideIncomplete: { value: hide_incomplete_bonds ? 1 : 0 },
      uMaxBondLength: { value: max_bond_length },
      uStubMode: { value: incomplete_periodic_edge_mode ? 1 : 0 },
      uStubScale: { value: incomplete_edge_length_scale },
    },
  }))

  // ── GPU-transform position texture ────────────────────────────────────────
  // RGBA32F DataTexture, one texel per atom (xyz in rgb). Rewritten in place
  // + re-uploaded each playback frame (~16·N bytes) — replaces the CPU mat4
  // compose loop + 64-byte/instance matrix upload. Reallocated only when the
  // atom count outgrows the current height.
  let pos_texture: DataTexture | null = null

  function upload_positions(pos: Float32Array): void {
    const n_atoms = (pos.length / 3) | 0
    const rows = Math.max(1, Math.ceil(n_atoms / POS_TEX_WIDTH))
    if (pos_texture === null || (pos_texture.image.height as number) < rows) {
      pos_texture?.dispose()
      const data = new Float32Array(POS_TEX_WIDTH * rows * 4)
      const tex = new DataTexture(data, POS_TEX_WIDTH, rows, RGBAFormat, FloatType)
      tex.minFilter = NearestFilter
      tex.magFilter = NearestFilter
      tex.generateMipmaps = false
      pos_texture = tex
      shader_material.uniforms.uPosTex.value = tex
    }
    const data = pos_texture.image.data as unknown as Float32Array
    for (let i = 0; i < n_atoms; i++) {
      data[i * 4] = pos[i * 3]
      data[i * 4 + 1] = pos[i * 3 + 1]
      data[i * 4 + 2] = pos[i * 3 + 2]
    }
    pos_texture.needsUpdate = true
    shader_material.uniforms.uNAtoms.value = n_atoms
  }

  // Texture is referenced only via a uniform — Threlte's auto-dispose covers
  // the material/geometry (created through T args) but not this.
  $effect(() => () => {
    pos_texture?.dispose()
    pos_texture = null
  })

  // DEV-only debug surface: globalThis.__catgo_bond_gpu. Mirrors the shader's
  // GPU-path math in JS over the exact GPU-bound data (topology attrs +
  // position texture + uLattice) so a console/e2e check can programmatically
  // verify geometry consistency (no over-max "spike" bonds, no NaN) without
  // reading back GPU buffers. Tree-shaken from production builds.
  $effect(() => {
    if (!import.meta.env?.DEV) return
    const surface = {
      get gpu_active() {
        return gpu_active
      },
      // Eligibility inputs — which v1 gate (if any) is holding the GPU path off.
      get eligibility() {
        return {
          gpu_transform_active,
          multibond_enabled,
          n_image_atoms: image_atom_layout?.n_image_atoms ?? 0,
          hide_incomplete_bonds,
          has_lattice: lattice_matrix !== null,
        }
      },
      get uGpuXform() {
        return shader_material.uniforms.uGpuXform.value as number
      },
      get mesh_count() {
        return mesh?.count ?? -1
      },
      get n_atoms() {
        return shader_material.uniforms.uNAtoms.value as number
      },
      stats: () => {
        const geo = mesh?.geometry
        const site = geo?.getAttribute(`a_site`)?.array as Float32Array | undefined
        const jimg = geo?.getAttribute(`a_jimage`)?.array as Int8Array | undefined
        const tex = pos_texture?.image.data as unknown as Float32Array | undefined
        if (!mesh || !site || !jimg || !tex) return null
        const n_atoms = shader_material.uniforms.uNAtoms.value as number
        const hide = (shader_material.uniforms.uHideIncomplete.value as number) > 0.5
        const max_len = shader_material.uniforms.uMaxBondLength.value as number
        const lat = (shader_material.uniforms.uLattice.value as Matrix3).elements
        const n_inst = mesh.count
        let over_max = 0
        let non_finite = 0
        let oob = 0
        let collapsed_periodic = 0
        let drawn = 0
        let min_len = Infinity
        let max_seen = 0
        for (let i = 0; i < n_inst; i += 2) { // one check per slot (halves share)
          const a = site[i * 2]
          const b = site[i * 2 + 1]
          if (a >= n_atoms || b >= n_atoms) {
            oob++
            continue
          }
          const dx = jimg[i * 3]
          const dy = jimg[i * 3 + 1]
          const dz = jimg[i * 3 + 2]
          const periodic = (dx | dy | dz) !== 0
          if (periodic && hide) {
            collapsed_periodic++
            continue
          }
          const ax = tex[a * 4], ay = tex[a * 4 + 1], az = tex[a * 4 + 2]
          // Column-major mat3: col0 = elements[0..2] = lattice vector a, etc.
          const bx = tex[b * 4] + dx * lat[0] + dy * lat[3] + dz * lat[6]
          const by = tex[b * 4 + 1] + dx * lat[1] + dy * lat[4] + dz * lat[7]
          const bz = tex[b * 4 + 2] + dx * lat[2] + dy * lat[5] + dz * lat[8]
          const len = Math.hypot(bx - ax, by - ay, bz - az)
          if (!Number.isFinite(len)) {
            non_finite++
            continue
          }
          if (len > max_len) {
            over_max++
            continue
          }
          drawn++
          if (len < min_len) min_len = len
          if (len > max_seen) max_seen = len
        }
        return {
          slots: n_inst / 2,
          drawn,
          over_max,
          non_finite,
          oob,
          collapsed_periodic,
          min_len,
          max_drawn_len: max_seen,
        }
      },
    }
    ;(globalThis as unknown as { __catgo_bond_gpu?: typeof surface })
      .__catgo_bond_gpu = surface
    return () => {
      delete (globalThis as { __catgo_bond_gpu?: unknown }).__catgo_bond_gpu
    }
  })

  // Update uniforms when props change — no material recreation needed
  $effect(() => {
    shader_material.uniforms.uOpacity.value = opacity
    shader_material.uniforms.saturation.value = saturation
    shader_material.uniforms.brightness.value = brightness
    shader_material.transparent = opacity < 1
    shader_material.depthWrite = opacity >= 1
    shader_material.depthTest = opacity >= 1
    shader_material.side = opacity < 1 ? 2 : 0
    // mark_dirty: imperative ShaderMaterial uniform write bypasses <T.> prop chain
    mark_dirty()
  })

  // Headlamp direction is a plain view-space uniform — copy the slider-derived
  // direction into the live material so bonds re-light the instant the slider moves.
  $effect(() => {
    shader_material.uniforms.uLightDir.value.copy(light_dir)
    // mark_dirty: imperative ShaderMaterial uniform write bypasses <T.> prop chain
    mark_dirty()
  })

  // Specular highlight strength is a plain float uniform — copy the slider value
  // into the live material so bond glossiness changes the instant it moves.
  $effect(() => {
    shader_material.uniforms.uSpecStrength.value = highlight_strength
    // mark_dirty: imperative ShaderMaterial uniform write bypasses <T.> prop chain
    mark_dirty()
  })

  // GPU-path scalar/matrix uniforms. lattice_matrix identity is stable
  // during playback (the per-frame structure cascade is cut), so this fires
  // on load / lattice edits, not per frame. frame_lattice_matrix is the
  // variable-cell exception: identity changes per frame there, and this
  // effect's whole body is cheap uniform writes — that per-frame cost is
  // exactly the point (cross-cell bonds must use the displayed frame's cell).
  $effect(() => {
    const lat = frame_lattice_matrix ?? lattice_matrix
    const m = shader_material.uniforms.uLattice.value as Matrix3
    if (lat) m.fromArray(lat as unknown as number[])
    else m.fromArray(ZERO_LATTICE)
    shader_material.uniforms.uHideIncomplete.value = hide_incomplete_bonds ? 1 : 0
    shader_material.uniforms.uMaxBondLength.value = max_bond_length
    shader_material.uniforms.uStubMode.value = incomplete_periodic_edge_mode ? 1 : 0
    shader_material.uniforms.uStubScale.value = incomplete_edge_length_scale
    // mark_dirty: imperative ShaderMaterial uniform write bypasses <T.> prop chain
    mark_dirty()
  })

  // GPU-transform mode transitions. Tracks ONLY the eligibility boolean; the
  // body runs untracked (renderer methods read manager $state — see the
  // mount-effect discipline note below). Entering: flip the shader to the
  // texture path, upload current positions, write topology attrs. Exiting:
  // flip back and force_full_resync — instanceMatrix is stale after any
  // GPU-mode window and must be rebuilt before the CPU path draws again.
  let last_gpu_active = false
  $effect(() => {
    const active = gpu_active
    if (!renderer) {
      // Renderer not up yet — the mount effect applies the current mode when
      // it constructs the renderer (and records it in last_gpu_active).
      return
    }
    if (active === last_gpu_active) return
    last_gpu_active = active
    untrack(() => {
      shader_material.uniforms.uGpuXform.value = active ? 1 : 0
      if (active) {
        upload_positions(atom_positions)
        renderer!.sync_gpu_topology()
      } else {
        renderer!.force_full_resync()
      }
      mark_dirty()
    })
  })

  // Geometry rebuilds reactively when bond_radius OR the LOD segment count
  // changes. Threlte's `args` reconciliation reconstructs the InstancedMesh,
  // which drops the mesh ref — the renderer effect below then reinitialises
  // and force_full_resync()s every slot's matrix, preserving bond data.
  //
  // Segment LOD: a large system drops to fewer cylinder segments *while
  // playing* (gpu_transform_active) and restores full segments on pause —
  // motion hides the facets, a paused frame does not. The rebuild fires only
  // on the play/pause EDGE (gpu_transform_active flips), never per frame:
  // atom_positions gets a fresh identity every frame, so its length is read
  // UNTRACKED (the count only matters at a play/pause edge, which re-runs this
  // derived and re-reads it). Tracking it would rebuild the whole mesh every
  // frame — the exact per-frame churn the trajectory fast-path exists to kill.
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

  $effect(() => {
    // Tracked deps: ONLY the mesh binding and manager identity — the body
    // runs untracked. The constructor and force_full_resync() read reactive
    // manager internals (version/count) plus the layout/positions getters;
    // tracked, those subscribed this effect to per-frame signals and every
    // trajectory frame disposed + rebuilt the renderer, recreating the
    // instanced GL attributes (kind/color/opacity — capacity-sized
    // bufferData reallocations each frame).
    const mesh_ref = mesh
    const mgr = bond_manager
    if (!mesh_ref) return
    return untrack(() => {
      const r = new BondInstancedRenderer(
        mesh_ref,
        mgr,
        () => atom_positions,
        // Variable-cell playback: per-slot CPU matrix writes must use the
        // displayed frame's cell. Read at call time inside the renderer's
        // (untracked) sync bodies, so this adds no reactive subscription.
        () => frame_lattice_matrix ?? lattice_matrix ?? null,
        () => ({
          mode: incomplete_periodic_edge_mode,
          scale: incomplete_edge_length_scale,
          hide_incomplete: hide_incomplete_bonds,
        }),
        () => image_atom_layout ?? null,
        () => partner_drawn_lookup ?? null,
        // Bond colors are now sourced directly from the per-atom color buffer
        // inside the renderer's matrix-write loop — same dirty-slot snapshot,
        // no race between matrix and color writes. The atom_colors-change
        // $effect below triggers `force_full_resync()` when the per-atom
        // buffer identity changes (color-only updates don't bump
        // bond_manager.version).
        () => atom_colors ?? null,
      )
      // Apply the multi-bond flag BEFORE the first resync so the initial mesh
      // layout uses the correct per-slot stride.
      r.set_multibond(multibond_enabled, bond_radius)
      renderer = r
      // Apply the current transform mode: the mode-transition effect only
      // fires on gpu_active CHANGES and may have already run (renderer was
      // undefined), so a mesh (re)mount mid-playback must self-serve.
      const active = gpu_active
      last_gpu_active = active
      shader_material.uniforms.uGpuXform.value = active ? 1 : 0
      if (active) {
        upload_positions(atom_positions)
        r.sync_gpu_topology()
      } else {
        r.force_full_resync()
      }
      mark_dirty()
      return () => {
        r.dispose()
        if (renderer === r) renderer = undefined
      }
    })
  })

  // Lattice matrix, incomplete-edge mode, image-atom layout, or per-atom
  // color buffer changes invalidate the entire bond-instance buffer
  // (cross-cell transforms and decorator instances reference all of these
  // inputs; bond colors are now derived directly from `atom_colors` inside
  // the renderer's matrix-write loop, so an atom_colors identity change
  // requires re-running every slot's color write — a pure recolor doesn't
  // bump bond_manager.version, so the standard sync() fast path skips it).
  // Force a full resync — incremental updates only refresh dirty BondManager
  // slots.
  $effect(() => {
    void lattice_matrix
    void incomplete_periodic_edge_mode
    void incomplete_edge_length_scale
    void hide_incomplete_bonds
    void image_atom_layout
    void partner_drawn_lookup
    void atom_colors
    // Toggling multi-bond rendering (or changing the base radius used to size
    // the per-line gap / reduced radius) changes the per-slot instance stride
    // and geometry, so re-lay-out the whole mesh.
    const mb = multibond_enabled
    const br = bond_radius
    if (!renderer) return
    // Untracked: force_full_resync reads manager $state (version/count);
    // tracked it would subscribe this effect to every per-frame version
    // bump and duplicate the version-sync effect's full pass.
    // Note: during typed-direct playback with image atoms off,
    // image_atom_layout re-derives to the EMPTY_LAYOUT singleton (stable
    // identity), so this effect does NOT fire per frame.
    untrack(() => {
      renderer!.set_multibond(mb, br)
      // GPU-transform mode owns the mesh: refresh its buffers (colors are
      // rewritten in the topology loop) instead of composing stale matrices.
      if (gpu_active) renderer!.sync_gpu_topology()
      else renderer!.force_full_resync()
      mark_dirty()
    })
  })

  let last_overrides_ref: Map<string, number> | ReadonlyMap<string, number> | undefined
  let last_periodic_op = 1
  let last_defaults_written = false

  $effect(() => {
    if (!renderer) return
    const mgr = bond_manager
    const _version = bond_manager.version
    const overrides = bond_opacity_overrides
    const _size = overrides?.size ?? 0
    const periodic_op = periodic_bond_opacity

    const count = mgr.count
    if (count === 0) return

    // Defaults fast path. With no overrides and periodic opacity 1 every
    // write below is a compare-noop, but each one still allocates a string
    // bond key — ~26k short-lived strings per version bump, every frame
    // during typed-direct trajectory playback. The all-1s buffer invariant
    // holds across topology churn: ensure_opacity() and the capacity grow
    // both fill(1), replace_auto_bonds never touches opacity, and this
    // effect is the only set_opacity caller — so once a full default pass
    // has run, later default passes can skip the loop entirely.
    const defaults = (overrides === undefined || overrides.size === 0) &&
      periodic_op === 1
    if (defaults && last_defaults_written) {
      last_overrides_ref = overrides
      last_periodic_op = periodic_op
      void _version
      void _size
      return
    }

    const pairs = mgr.pairs_buffer
    const jimages = mgr.jimages_buffer
    mgr.begin_opacity_batch()
    mgr.ensure_opacity()
    try {
      if (mgr.dirty_all) {
        for (let slot = 0; slot < count; slot++) {
          write_slot_opacity(slot, pairs, jimages, overrides, periodic_op, mgr)
        }
      } else {
        const inputs_changed = overrides !== last_overrides_ref ||
                                periodic_op !== last_periodic_op
        if (inputs_changed) {
          for (let slot = 0; slot < count; slot++) {
            write_slot_opacity(slot, pairs, jimages, overrides, periodic_op, mgr)
          }
        } else {
          for (const slot of mgr.dirty_slots) {
            if (slot < count) write_slot_opacity(slot, pairs, jimages, overrides, periodic_op, mgr)
          }
        }
      }
    } finally {
      mgr.commit_opacity_batch()
    }
    last_overrides_ref = overrides
    last_periodic_op = periodic_op
    last_defaults_written = defaults
    void _version
    void _size
  })

  function write_slot_opacity(
    slot: number,
    pairs: Uint32Array,
    jimages: Int8Array,
    overrides: Map<string, number> | ReadonlyMap<string, number> | undefined,
    periodic_op: number,
    mgr: BondManager,
  ): void {
    const a = pairs[slot * 2]
    const b = pairs[slot * 2 + 1]
    const key = get_bond_key(a, b)
    let op = overrides?.get(key) ?? 1
    if (periodic_op < 1) {
      const ji = slot * 3
      const is_periodic = jimages[ji] !== 0 || jimages[ji + 1] !== 0 || jimages[ji + 2] !== 0
      if (is_periodic) op *= periodic_op
    }
    mgr.set_opacity(slot, op)
  }

  // Topology version sync. In GPU-transform mode the per-frame
  // replace_auto_bonds bump routes to sync_gpu_topology (topology attrs +
  // kind/color/opacity — no matrix math); otherwise the classic dirty-slot
  // matrix sync. gpu_active is read untracked: mode transitions are owned by
  // the dedicated effect above, which fully rebuilds the incoming mode's
  // buffers — tracking it here would only duplicate that pass.
  $effect(() => {
    const version = bond_manager.version
    void version
    if (!renderer) return
    untrack(() => {
      if (gpu_active) renderer!.sync_gpu_topology()
      else renderer!.sync()
      mark_dirty()
    })
  })

  $effect(() => {
    positions_version
    atom_positions
    if (!renderer) return
    // Untracked: force_full_resync reads manager $state (version/count);
    // tracked it would re-fire this effect on every version bump on top of
    // the positions-identity dep above — a duplicate full matrix pass.
    untrack(() => {
      if (gpu_active) {
        // GPU-transform mode: per-frame positions land in the per-atom
        // texture (~16·N bytes) instead of a full per-instance matrix pass.
        upload_positions(atom_positions)
      } else {
        renderer!.force_full_resync()
      }
      mark_dirty()
    })
  })
</script>

<T.InstancedMesh
  args={[geometry, shader_material, max_capacity]}
  bind:ref={mesh}
  raycast={null}
  frustumCulled={false}
/>

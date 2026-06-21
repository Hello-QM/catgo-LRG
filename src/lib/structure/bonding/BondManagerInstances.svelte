<script lang="ts">
  import { untrack } from 'svelte'
  import { T, useThrelte } from '@threlte/core'
  import type { InstancedMesh } from 'three'
  import { Color, CylinderGeometry, ShaderMaterial, Vector3 } from 'three'
  import { get_bond_key } from '../bonding'
  import { BondInstancedRenderer, type PartnerDrawnLookup } from './bond-instanced-renderer'
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
    /**
     * Adsorbate bond-order rendering. When true, each logical bond reserves 6
     * instances (3 lines × 2 halves) and bonds whose perceived order > 1 draw
     * as multi-cylinder double/triple/aromatic bonds. Default false → the
     * verbatim single-cylinder (2 instances/bond) path, byte-identical to today.
     */
    multibond_enabled?: boolean
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
    incomplete_periodic_edge_mode = false,
    incomplete_edge_length_scale = 0.5,
    hide_incomplete_bonds = true,
    image_atom_layout = null,
    partner_drawn_lookup = null,
    multibond_enabled = false,
  }: Props = $props()

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

  const vertex_shader = `
    attribute vec3 instance_color_start;
    attribute vec3 instance_color_end;
    attribute float instance_opacity;
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

      // Compute instance normal matrix (inverse-transpose) for correct normals
      // under non-uniform scaling. mat3(instanceMatrix) alone squishes radial
      // normals toward the cylinder axis, producing flat shading.
      // WebGL 1 lacks inverse(), so we use the cofactor (cross-product) trick:
      // cofactor columns are proportional to inverse-transpose columns.
      mat3 m = mat3(instanceMatrix);
      mat3 instanceNormalMat;
      instanceNormalMat[0] = cross(m[1], m[2]);
      instanceNormalMat[1] = cross(m[2], m[0]);
      instanceNormalMat[2] = cross(m[0], m[1]);
      vNormal = normalize(normalMatrix * instanceNormalMat * normal);

      vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
      vViewPosition = mvPosition.xyz;
      gl_Position = projectionMatrix * mvPosition;
      vDepthCueZ = -mvPosition.z;
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

    // 3-point procedural studio env (key + fill + sky/ground gradient).
    // n is view-space normal. Returns linear-RGB env response for that normal.
    vec3 studio_env(vec3 n, vec3 keyDir) {
      vec3 col = vec3(0.0);
      // Key: warm white from primary direction. Quadratic falloff (cheap, no pow).
      float k = max(dot(n, keyDir), 0.0);
      col += vec3(1.00, 0.97, 0.92) * (k * k) * 0.55;
      // Fill: cool white opposite-ish.
      vec3 fillDir = normalize(vec3(-keyDir.x * 0.9, keyDir.y * 0.4, keyDir.z * 0.6));
      float f = max(dot(n, fillDir), 0.0);
      col += vec3(0.88, 0.93, 1.00) * (f * f) * 0.30;
      // Sky-to-ground gradient driven by vertical view-space normal
      float sky = n.y * 0.5 + 0.5;
      col += mix(vec3(0.42, 0.43, 0.50), vec3(0.95, 0.97, 1.00), sky) * 0.22;
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
                       + specColor * specular * directionalIntensity * 0.5 * rim_mask
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
      ambientIntensity: { value: 0.7 },
      directionalIntensity: { value: 0.3 },
      saturation: { value: saturation },
      brightness: { value: brightness },
      uOpacity: { value: opacity },
      uLightDir: { value: new Vector3(-0.7, -0.5, 1.0).normalize() },
      uDepthCueing: depth_cue_uniforms?.uDepthCueing ?? { value: 0 },
      uDepthNear: depth_cue_uniforms?.uDepthNear ?? { value: 0 },
      uDepthFar: depth_cue_uniforms?.uDepthFar ?? { value: 10 },
      uDepthCueBgColor: depth_cue_uniforms?.uDepthCueBgColor ?? { value: new Color(0xffffff) },
      uBondOutlineStrength: depth_cue_uniforms?.uBondOutlineStrength ?? { value: 0 },
    },
  }))

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

  // Geometry rebuilds reactively when bond_radius changes. Threlte's
  // `args` reconciliation reconstructs the InstancedMesh, which drops the
  // mesh ref — the renderer effect below then reinitialises and
  // force_full_resync()s every slot's matrix, preserving bond data.
  const geometry = $derived(new CylinderGeometry(bond_radius, bond_radius, 1, 16))

  $effect(() => {
    if (!mesh) return
    const r = new BondInstancedRenderer(
      mesh,
      bond_manager,
      () => atom_positions,
      () => lattice_matrix ?? null,
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
    r.set_multibond(untrack(() => multibond_enabled), untrack(() => bond_radius))
    renderer = r
    r.force_full_resync()
    mark_dirty()
    return () => {
      r.dispose()
      if (renderer === r) renderer = undefined
    }
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
    renderer.set_multibond(mb, br)
    renderer.force_full_resync()
    mark_dirty()
  })

  let last_overrides_ref: Map<string, number> | ReadonlyMap<string, number> | undefined
  let last_periodic_op = 1

  $effect(() => {
    if (!renderer) return
    const mgr = bond_manager
    const _version = bond_manager.version
    const overrides = bond_opacity_overrides
    const _size = overrides?.size ?? 0
    const periodic_op = periodic_bond_opacity

    const count = mgr.count
    if (count === 0) return

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

  $effect(() => {
    const version = bond_manager.version
    void version
    if (!renderer) return
    renderer.sync()
    mark_dirty()
  })

  $effect(() => {
    positions_version
    atom_positions
    if (!renderer) return
    renderer.force_full_resync()
    mark_dirty()
  })
</script>

<T.InstancedMesh
  args={[geometry, shader_material, max_capacity]}
  bind:ref={mesh}
  raycast={null}
  frustumCulled={false}
/>

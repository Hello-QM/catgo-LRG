<script lang="ts">
  /**
   * Fresnel-halo selection highlight.
   *
   * Replaces the legacy black-wireframe sphere with a 3Dmol-style
   * silhouette glow. The body of each highlight is fully transparent
   * (atoms + fog read through unobstructed); only the rim contributes
   * color, decaying smoothly toward the center via a fresnel curve.
   *
   * Architecture (mirrors Bond.svelte's proven path — explicitly NOT
   * using Three.js's `mesh.instanceColor` special-attribute mechanism,
   * which has historically been flaky with raw ShaderMaterial + Threlte
   * v8 on this codebase):
   *
   *   - Build SphereGeometry up front; attach a custom
   *     InstancedBufferAttribute named `haloColor` (per-instance vec3)
   *     and a per-instance scale attribute `haloScale` (float, applied
   *     to the unit sphere so we avoid mucking with instanceMatrix
   *     scale and can render slightly larger than the underlying atom).
   *   - Build a ShaderMaterial up front and pass it via T.InstancedMesh
   *     `args` so Threlte attaches it directly (instead of via a child
   *     <T.ShaderMaterial>, which doesn't reliably wire custom attribs).
   *   - The vertex shader reads `instanceMatrix` (auto-injected by
   *     Three.js for InstancedMesh + ShaderMaterial) for translation,
   *     plus `haloColor` and `haloScale` for the rest.
   *
   * Depth behavior:
   *   - depthTest: true  → opaque atoms in front correctly occlude.
   *   - depthWrite: false → halo doesn't itself occlude things behind.
   *   - renderOrder: 1 → paints after opaque atoms. The cell surface
   *     also has depthWrite:false (Lattice.svelte) so it can't block
   *     the halo from being seen through translucent volumes.
   *
   * Capacity: fixed `max_capacity` (default 4096). Selecting more than
   * that truncates silently with a console warning.
   */

  import type { AnyStructure, Vec3 } from '$lib'
  import { T } from '@threlte/core'
  import type { Camera, InstancedMesh } from 'three'
  import { Color, InstancedBufferAttribute, Matrix4, NormalBlending, Quaternion, ShaderMaterial, SphereGeometry, Vector3 } from 'three'
  import { compute_depth_range, get_depth_color } from './depth-cue-helpers'

  interface Props {
    structure: AnyStructure | undefined
    selected_sites: number[]
    active_sites: number[]
    selection_highlight_color: string
    active_highlight_color: string
    /** Per-frame pulse opacity (0..1), driven by the parent's $effect.
     *  Bound to the shared material's uOpacity uniform. */
    pulse_opacity: number
    /** Atom drag overrides — when present, override the canonical xyz. */
    realtime_position_overrides: Map<number, Vec3> | null
    /** Resolved per-site position from atom_data (handles supercell, etc). */
    position_by_site_idx: Map<number, Vec3>
    /** Resolved per-site visual radius. */
    radius_by_site_idx: Map<number, number>
    /** Fallback radius for sites missing from radius_by_site_idx. */
    atom_radius: number
    /** Camera reference for depth-tinting during manipulation. May be
     *  undefined before Threlte mounts the camera ref. */
    camera: Camera | undefined
    is_rotating_atoms: boolean
    is_dragging_atom: boolean
    /** Imperative GPU writes (instanceMatrix + custom buffers) bypass the
     *  <T.> prop chain — caller passes its mark_dirty so we can request a
     *  paint after each rebuild. */
    mark_dirty: () => void
    max_capacity?: number
    /** Single-atom hover index. Renders a halo at half the pulse opacity
     *  (subtle preview, distinguishable from a committed selection). */
    hovered_site_idx?: number | null
  }

  let {
    structure,
    selected_sites,
    active_sites,
    selection_highlight_color,
    active_highlight_color,
    pulse_opacity,
    realtime_position_overrides,
    position_by_site_idx,
    radius_by_site_idx,
    atom_radius,
    camera,
    is_rotating_atoms,
    is_dragging_atom,
    mark_dirty,
    max_capacity = 4096,
    hovered_site_idx = null,
  }: Props = $props()

  let mesh = $state<InstancedMesh | undefined>()

  // Reusable scratch objects — zero per-frame allocations.
  const __scratch_xyz = new Vector3()
  const __scratch_quat = new Quaternion() // identity, never modified
  const __scratch_unit_scale = new Vector3(1, 1, 1)
  const __scratch_matrix = new Matrix4()
  const __scratch_color = new Color()
  // Pre-parsed base colors. Recomputed only when the input string props change.
  const __selected_color_obj = new Color()
  const __active_color_obj = new Color()

  // ─── Geometry + shader material (built up front, attached via args) ───
  // 48×48 keeps the silhouette arc clean even at high zoom — 24×24 was
  // visibly polygonal on the outer ring.
  const halo_geometry = new SphereGeometry(1.0, 48, 48)

  // Per-instance color and per-instance scale buffers. Attached to the
  // geometry as InstancedBufferAttributes (Bond.svelte pattern).
  const halo_color_buf = new Float32Array(max_capacity * 3)
  const halo_scale_buf = new Float32Array(max_capacity)
  const halo_color_attr = new InstancedBufferAttribute(halo_color_buf, 3, false)
  const halo_scale_attr = new InstancedBufferAttribute(halo_scale_buf, 1, false)
  halo_geometry.setAttribute(`haloColor`, halo_color_attr)
  halo_geometry.setAttribute(`haloScale`, halo_scale_attr)

  const halo_uniforms = { uOpacity: { value: 0 } }

  const halo_vertex = `
    attribute vec3 haloColor;
    attribute float haloScale;
    varying vec3 vColor;
    varying vec3 vViewNormal;
    varying vec3 vViewPos;
    void main() {
      vColor = haloColor;
      // Apply our per-instance scale to the unit sphere first, then the
      // instanceMatrix (translation only — Three.js auto-injects this).
      vec3 scaled = position * haloScale;
      vec4 mv = modelViewMatrix * instanceMatrix * vec4(scaled, 1.0);
      vViewPos = mv.xyz;
      // instanceMatrix is translation only (uniform-1 scale baked into our
      // own attribute), so plain normalMatrix * normal is correct.
      vViewNormal = normalize(normalMatrix * normal);
      gl_Position = projectionMatrix * mv;
    }
  `

  const halo_fragment = `
    uniform float uOpacity;
    varying vec3 vColor;
    varying vec3 vViewNormal;
    varying vec3 vViewPos;
    void main() {
      vec3 viewDir = normalize(-vViewPos);
      float NdotV = abs(dot(normalize(vViewNormal), viewDir));
      // Fresnel rises near silhouette (NdotV near 0). Exponent 2.5 →
      // a clean readable ring without the heavy "shell" look that 1.0–2.0
      // gives, while still wider than the unreadable 4.0 we tried.
      float fresnel = pow(1.0 - NdotV, 2.5);
      float a = fresnel * uOpacity;
      if (a < 0.02) discard;
      gl_FragColor = vec4(vColor, a);
    }
  `

  const halo_material = new ShaderMaterial({
    vertexShader: halo_vertex,
    fragmentShader: halo_fragment,
    uniforms: halo_uniforms,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    blending: NormalBlending,
  })

  // Reactively pump pulse_opacity into the uniform — no shader recompile.
  $effect(() => {
    halo_uniforms.uOpacity.value = pulse_opacity
    mark_dirty()
  })

  // ─── Sync builder ───
  // Walks selected_sites + active_sites, writes per-instance translation
  // matrix, color, and scale, then sets mesh.count.
  $effect(() => {
    if (!mesh) return
    const m = mesh
    if (!structure?.sites) {
      m.count = 0
      mark_dirty()
      return
    }

    // Track reactive deps explicitly so Svelte refires when these change.
    const _struct = structure
    const _overrides = realtime_position_overrides
    const _ovr_size = realtime_position_overrides?.size ?? 0
    const _pos_map_size = position_by_site_idx.size
    const _rad_map_size = radius_by_site_idx.size
    const _is_manip = is_rotating_atoms || is_dragging_atom
    const _atom_r = atom_radius
    void _struct; void _overrides; void _ovr_size; void _pos_map_size; void _rad_map_size; void _atom_r

    __selected_color_obj.set(selection_highlight_color)
    __active_color_obj.set(active_highlight_color)

    const depth_range: [number, number] = _is_manip && selected_sites.length > 0 && camera
      ? compute_depth_range(selected_sites, realtime_position_overrides, structure, camera)
      : [0, 0]

    let write = 0
    const total_requested = selected_sites.length + active_sites.length
    if (total_requested > max_capacity && import.meta.env?.DEV) {
      // eslint-disable-next-line no-console
      console.warn(
        `[SelectionHighlights] selection size (${total_requested}) exceeds ` +
          `max_capacity (${max_capacity}); truncating. Increase the prop ` +
          `or split into batches if this is intentional.`,
      )
    }

    const write_one = (idx: number, base_color: Color) => {
      if (write >= max_capacity) return
      const xyz = realtime_position_overrides?.get(idx)
        ?? position_by_site_idx.get(idx)
        ?? structure?.sites?.[idx]?.xyz
      if (!xyz) return

      // Halo radius: ≈1.25× the visually-rendered atom radius. radius_map
      // stores `atom.radius` which AtomInstancedRenderer renders at HALF
      // (VISUAL_RADIUS_SCALE = 0.5). So multiply by 0.5 * 1.25 = 0.625.
      // Need a wider band than atom-edge so the fresnel ring has room to
      // breathe — at the atom edge (multiplier 0.525) the ring fits in
      // a sub-pixel strip and visually disappears.
      const halo_radius = (radius_by_site_idx.get(idx) ?? atom_radius) * 0.625

      // instanceMatrix carries translation only; scale lives in haloScale.
      __scratch_xyz.set(xyz[0], xyz[1], xyz[2])
      __scratch_matrix.compose(__scratch_xyz, __scratch_quat, __scratch_unit_scale)
      m.setMatrixAt(write, __scratch_matrix)

      // Per-instance color: depth-tinted during manipulation, base color
      // otherwise. get_depth_color returns a hex string.
      if (_is_manip && camera) {
        const tinted = get_depth_color(xyz, camera, depth_range, base_color === __selected_color_obj
          ? selection_highlight_color
          : active_highlight_color)
        __scratch_color.set(tinted)
      } else {
        __scratch_color.copy(base_color)
      }
      halo_color_buf[write * 3]     = __scratch_color.r
      halo_color_buf[write * 3 + 1] = __scratch_color.g
      halo_color_buf[write * 3 + 2] = __scratch_color.b
      halo_scale_buf[write] = halo_radius
      write++
    }

    for (let i = 0; i < selected_sites.length; i++) {
      write_one(selected_sites[i], __selected_color_obj)
    }
    for (let i = 0; i < active_sites.length; i++) {
      write_one(active_sites[i], __active_color_obj)
    }
    // Hover halo: render only when the cursor is over an atom and that
    // atom isn't already in selected/active (skip duplicate draw).
    if (
      hovered_site_idx !== null &&
      hovered_site_idx !== undefined &&
      !selected_sites.includes(hovered_site_idx) &&
      !active_sites.includes(hovered_site_idx)
    ) {
      write_one(hovered_site_idx, __selected_color_obj)
    }

    m.count = write
    m.instanceMatrix.needsUpdate = true
    halo_color_attr.needsUpdate = true
    halo_scale_attr.needsUpdate = true
    mark_dirty()
  })
</script>

<!-- Halo InstancedMesh. Geometry + ShaderMaterial passed via args so
     Threlte attaches them up front (matches Bond.svelte). renderOrder=1
     so the halo paints after opaque atoms. -->
<T.InstancedMesh
  args={[halo_geometry, halo_material, max_capacity]}
  bind:ref={mesh}
  frustumCulled={false}
  raycast={null}
  renderOrder={1}
/>

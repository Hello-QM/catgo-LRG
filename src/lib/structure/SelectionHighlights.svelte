<script lang="ts">
  /**
   * R7 — Instanced selection-highlight mesh.
   *
   * Replaces N per-atom `<T.Mesh>` highlights (one geometry, one material,
   * one draw call per selected atom) with a single InstancedMesh. Selected
   * + active atoms share one geometry, one material, one draw call;
   * per-instance position+scale via instanceMatrix; per-instance color via
   * Three.js's built-in `instanceColor` attribute.
   *
   * Why this matters:
   *   - Selection toggle no longer mounts/unmounts N <T.Mesh> components.
   *   - The pulse $effect in StructureScene writes ONE `material.opacity`
   *     value per frame (was N per frame, one per highlight material).
   *   - select_all on a 100+ atom structure during orbit becomes O(1) draw
   *     calls instead of O(N).
   *
   * Caller contract: parent owns the pulse opacity ($state) and passes it
   * via the `pulse_opacity` prop. We bind it to the single shared
   * MeshBasicMaterial; Threlte's prop watcher triggers the per-frame paint
   * automatically.
   *
   * Capacity: fixed `max_capacity` (default 4096). Selecting more than that
   * truncates silently with a console warning. Realistic ceiling — even
   * select_all on a 4096-atom slab fits.
   */

  import type { AnyStructure, Vec3 } from '$lib'
  import { T } from '@threlte/core'
  import type { Camera, InstancedMesh } from 'three'
  import { Color, InstancedBufferAttribute, Matrix4, Quaternion, Vector3 } from 'three'
  import { compute_depth_range, get_depth_color } from './depth-cue-helpers'

  interface Props {
    structure: AnyStructure | undefined
    selected_sites: number[]
    active_sites: number[]
    selection_highlight_color: string
    active_highlight_color: string
    /** Per-frame pulse opacity (0..1), driven by the parent's $effect.
     *  Bound to the shared material; Threlte auto-invalidates on change. */
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
    /** Imperative GPU writes (instanceMatrix, instanceColor) bypass the
     *  <T.> prop chain — caller passes its mark_dirty so we can request a
     *  paint after each rebuild. */
    mark_dirty: () => void
    max_capacity?: number
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
  }: Props = $props()

  let mesh = $state<InstancedMesh | undefined>()

  // Reusable scratch objects — zero per-frame allocations.
  const __scratch_xyz = new Vector3()
  const __scratch_quat = new Quaternion() // identity, never modified
  const __scratch_scale = new Vector3()
  const __scratch_matrix = new Matrix4()
  const __scratch_color = new Color()
  // Pre-parsed base colors. Recomputed only when the input string props change.
  const __selected_color_obj = new Color()
  const __active_color_obj = new Color()

  // Track whether instanceColor attribute has been initialized on the mesh.
  // Three.js auto-creates one when you assign mesh.instanceColor = ..., but
  // we own the lifecycle here so we can grow + write into our own buffer.
  let __instance_color_buf: Float32Array | null = null

  // Sync builder: walks selected_sites + active_sites, writes per-instance
  // matrix + color, sets mesh.count, calls mark_dirty(). Runs whenever any
  // tracked input changes — Svelte's $effect handles the dependency graph.
  $effect(() => {
    if (!mesh) return
    // Local const so closures inside this effect can read it without
    // re-checking undefined (Svelte 5's narrowing doesn't propagate
    // across closure boundaries).
    const m = mesh
    if (!structure?.sites) {
      m.count = 0
      mark_dirty()
      return
    }

    // Track reactive deps explicitly. Without these reads, Svelte won't
    // re-fire this effect when overrides / position map / structure update.
    const _struct = structure
    const _overrides = realtime_position_overrides
    const _ovr_size = realtime_position_overrides?.size ?? 0
    const _pos_map_size = position_by_site_idx.size
    const _rad_map_size = radius_by_site_idx.size
    const _is_manip = is_rotating_atoms || is_dragging_atom
    const _atom_r = atom_radius
    void _struct; void _overrides; void _ovr_size; void _pos_map_size; void _rad_map_size; void _atom_r

    // Re-parse the base colors in case prop strings changed.
    __selected_color_obj.set(selection_highlight_color)
    __active_color_obj.set(active_highlight_color)

    // Depth tinting is only meaningful while the user is manipulating
    // selected atoms (rotation / drag). The depth_range gives near/far
    // bounds for normalizing each atom's distance.
    const depth_range: [number, number] = _is_manip && selected_sites.length > 0 && camera
      ? compute_depth_range(selected_sites, realtime_position_overrides, structure, camera)
      : [0, 0]

    // Ensure instanceColor buffer matches mesh capacity.
    if (!__instance_color_buf || __instance_color_buf.length !== max_capacity * 3) {
      __instance_color_buf = new Float32Array(max_capacity * 3)
      const attr = new InstancedBufferAttribute(__instance_color_buf, 3, false)
      m.instanceColor = attr
    }

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
      const r = (radius_by_site_idx.get(idx) ?? atom_radius) * 1.3
      __scratch_xyz.set(xyz[0], xyz[1], xyz[2])
      __scratch_scale.set(r, r, r)
      __scratch_matrix.compose(__scratch_xyz, __scratch_quat, __scratch_scale)
      m.setMatrixAt(write, __scratch_matrix)
      // Per-instance color: depth-tinted during manipulation, base
      // color otherwise. get_depth_color returns a hex string; parse.
      if (_is_manip && camera) {
        const tinted = get_depth_color(xyz, camera, depth_range, base_color === __selected_color_obj
          ? selection_highlight_color
          : active_highlight_color)
        __scratch_color.set(tinted)
      } else {
        __scratch_color.copy(base_color)
      }
      __instance_color_buf![write * 3] = __scratch_color.r
      __instance_color_buf![write * 3 + 1] = __scratch_color.g
      __instance_color_buf![write * 3 + 2] = __scratch_color.b
      write++
    }

    for (let i = 0; i < selected_sites.length; i++) {
      write_one(selected_sites[i], __selected_color_obj)
    }
    for (let i = 0; i < active_sites.length; i++) {
      write_one(active_sites[i], __active_color_obj)
    }

    m.count = write
    m.instanceMatrix.needsUpdate = true
    if (m.instanceColor) m.instanceColor.needsUpdate = true
    mark_dirty()
  })
</script>

<!-- Single InstancedMesh shared across selected + active highlights.
     wireframe + transparent matches the legacy per-mesh appearance.
     vertexColors=true tells MeshBasicMaterial to use instanceColor. -->
<T.InstancedMesh
  args={[undefined, undefined, max_capacity]}
  bind:ref={mesh}
  frustumCulled={false}
  raycast={null}
>
  <T.SphereGeometry args={[0.5, 16, 16]} />
  <T.MeshBasicMaterial
    wireframe
    transparent
    opacity={pulse_opacity}
    vertexColors
  />
</T.InstancedMesh>

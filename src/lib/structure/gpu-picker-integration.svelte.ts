// GPU picker integration extracted from StructureScene.svelte.
// Manages GPUPicker lifecycle, hover detection switching between
// analytic ray-sphere and GPU picking based on structure size.

import type { Vec3 } from '$lib'
import { GPUPicker } from './gpu-picker'
import { is_atom_pickable_pure } from './scene'
import { Vector3, Euler, Quaternion, Matrix4 } from 'three'
import type { Camera, WebGLRenderer } from 'three'
import type { ImageAtomLayout } from './bonding/image-atom-layout'
import type { BondManager } from './bonding/bond-manager.svelte'
import type { PartnerDrawnLookup } from './bonding/bond-instanced-renderer'

/** Visibility info for a single site in the cutting plane. */
export type CuttingVisInfo = { inside: boolean; opacity: number; saturation: number }

/** Threshold above which GPU picking is used instead of analytic ray-sphere. */
export const LARGE_STRUCTURE_THRESHOLD = 2000

/** Atom data entry (subset of fields needed by hover detection). */
export interface AtomEntry {
  site_idx: number
  position: Vec3
  radius: number
}

/**
 * Dependencies that must be passed from the component context.
 * Uses getters so reactive values are read at call-time.
 */
export interface GpuPickerDeps {
  get_threlte: () => {
    renderer?: WebGLRenderer | null
    camera: { current: Camera | null }
    invalidate: () => void
  }
  get_atom_data: () => AtomEntry[]
  get_filtered_bond_pairs: () => {
    transform_matrix: Float32Array
    pos_1: Vec3
    pos_2: Vec3
    jimage?: [number, number, number]
  }[]
  /**
   * Lattice as a 3×3 row-major Float64Array of length 9 (rows are vectors
   * a, b, c). Required to compute `b_eff = pos_b + lattice·jimage` for
   * cross-cell bonds. `null` for molecules (no lattice).
   */
  get_lattice_matrix: () => Float64Array | null
  /**
   * Phase 6 incomplete-edge stub mode. When `mode` is true, cross-cell
   * bonds (jimage ≠ 0) render only Half A scaled by `scale`; Half B is
   * hidden. The picker mirrors this so a hidden half is unpickable.
   */
  get_incomplete_edge: () => { mode: boolean; scale: number } | null
  /**
   * Phase 7e dependencies. When all three are non-null, the picker also
   * emits cylinder transforms for the image-atom decorator instances and
   * resolves hits through `slot_to_filtered_idx` so the user can click /
   * hover decorator stubs and end up on the same logical bond as the
   * cell-internal halves they decorate.
   */
  get_image_atom_layout?: () => ImageAtomLayout | null
  get_bond_manager?: () => BondManager | null
  get_partner_drawn_lookup?: () => PartnerDrawnLookup | null
  get_slot_to_filtered_idx?: () => Int32Array | null
  get_bond_thickness: () => number
  get_external_dragging: () => boolean
  get_is_rotating_atoms: () => boolean
  get_is_box_selecting: () => boolean
  get_camera_is_moving: () => boolean
  get_show_bulk_atoms: () => boolean
  get_is_large_structure: () => boolean
  get_cutting_active: () => boolean
  get_cutting_visibility_map: () => Map<number, CuttingVisInfo>
  get_rotation: () => Vec3
  get_rotation_target: () => Vec3 | undefined
  get_realtime_position_overrides: () => Map<number, Vec3> | null
  get_structure: () => { sites?: { xyz?: Vec3 }[] } | undefined
  set_hovered_idx: (v: number | null) => void
  get_hovered_idx: () => number | null
  set_active_tooltip: (v: 'atom' | 'bond' | null) => void
  /** Find hit atom via analytic ray-sphere (used for small structures). */
  find_hit_atom_from_event: (event: PointerEvent | MouseEvent) => { site_idx: number; position: Vec3 } | null
}

/**
 * Create the GPU picker instance and its state.
 * Call from component `<script>` context.
 */
export function create_gpu_picker() {
  const gpu_picker = new GPUPicker()
  let picker_dirty = $state(true)
  return { gpu_picker, get picker_dirty() { return picker_dirty }, set picker_dirty(v: boolean) { picker_dirty = v } }
}

/**
 * Check if an atom is pickable (not hidden by cutting plane).
 */
export function is_atom_pickable(
  site_idx: number,
  cutting_active: boolean,
  cutting_visibility_map: Map<number, CuttingVisInfo>,
): boolean {
  return is_atom_pickable_pure(site_idx, cutting_active, cutting_visibility_map)
}

// Scratch instances reused across update_gpu_picker invocations to avoid
// per-bond allocation. compose() does not retain references.
const __pick_up_y = new Vector3(0, 1, 0)
const __pick_quat = new Quaternion()
const __pick_dir = new Vector3()
const __pick_scale = new Vector3()
const __pick_mid = new Vector3()
const __pick_mat = new Matrix4()

const __ZERO_MATRIX = new Float32Array(16) // all zeros = zero-scale matrix → invisible to GPU picker

/**
 * Compose the two half-bond cylinder transforms for a single logical bond,
 * mirroring the math in `bond-instanced-renderer.ts:#write_slot`. Returns
 * `[half_a_matrix, half_b_matrix]` as fresh Float32Array(16) instances —
 * the GPU picker holds them across frames, so we cannot share scratch.
 *
 * In incomplete-edge stub mode (Phase 6) for cross-cell bonds, Half A is
 * shortened by `stub.scale` and Half B is replaced with a zero-scale
 * matrix (rasterizes nothing → not pickable, matching the visible scene).
 */
function compute_half_bond_transforms(
  pos_a: Vec3,
  pos_b: Vec3,
  jimage: [number, number, number],
  lattice: Float64Array | null,
  stub: { mode: boolean; scale: number } | null,
): [Float32Array, Float32Array] {
  const ax = pos_a[0], ay = pos_a[1], az = pos_a[2]
  const bx_base = pos_b[0], by_base = pos_b[1], bz_base = pos_b[2]
  let bx = bx_base, by = by_base, bz = bz_base
  const dx = jimage[0], dy = jimage[1], dz = jimage[2]
  const is_periodic = (dx | dy | dz) !== 0
  if (is_periodic && lattice !== null) {
    bx += dx * lattice[0] + dy * lattice[3] + dz * lattice[6]
    by += dx * lattice[1] + dy * lattice[4] + dz * lattice[7]
    bz += dx * lattice[2] + dy * lattice[5] + dz * lattice[8]
  }

  const fx = bx - ax
  const fy = by - ay
  const fz = bz - az
  const length = Math.hypot(fx, fy, fz)
  const half_length = length * 0.5

  if (length < 1e-8) __pick_dir.set(0, 1, 0)
  else __pick_dir.set(fx / length, fy / length, fz / length)
  __pick_quat.setFromUnitVectors(__pick_up_y, __pick_dir)

  const stub_active = stub !== null && stub.mode && is_periodic

  if (is_periodic) {
    // Paired stubs: each atom gets its own visible stub anchored at the
    // cell-internal position. Mirrors bond-instanced-renderer.ts.
    const stub_scale = stub_active ? stub.scale : 1.0
    const stub_len = half_length * stub_scale
    __pick_scale.set(1, stub_len, 1)
    const half_stub = stub_len * 0.5

    __pick_mid.set(
      ax + __pick_dir.x * half_stub,
      ay + __pick_dir.y * half_stub,
      az + __pick_dir.z * half_stub,
    )
    __pick_mat.compose(__pick_mid, __pick_quat, __pick_scale)
    const m_a = new Float32Array(16)
    __pick_mat.toArray(m_a)

    __pick_mid.set(
      bx_base - __pick_dir.x * half_stub,
      by_base - __pick_dir.y * half_stub,
      bz_base - __pick_dir.z * half_stub,
    )
    __pick_mat.compose(__pick_mid, __pick_quat, __pick_scale)
    const m_b = new Float32Array(16)
    __pick_mat.toArray(m_b)

    return [m_a, m_b]
  }

  // Intra-cell: classic two-half meeting at midpoint.
  const mx = (ax + bx) * 0.5
  const my = (ay + by) * 0.5
  const mz = (az + bz) * 0.5

  __pick_scale.set(1, half_length, 1)
  __pick_mid.set((ax + mx) * 0.5, (ay + my) * 0.5, (az + mz) * 0.5)
  __pick_mat.compose(__pick_mid, __pick_quat, __pick_scale)
  const m_a = new Float32Array(16)
  __pick_mat.toArray(m_a)

  __pick_mid.set((mx + bx) * 0.5, (my + by) * 0.5, (mz + bz) * 0.5)
  __pick_mat.compose(__pick_mid, __pick_quat, __pick_scale)
  const m_b = new Float32Array(16)
  __pick_mat.toArray(m_b)

  return [m_a, m_b]
}

/**
 * Phase 7e — compose the two cylinder transforms for one image-atom
 * decorator (one image_atom × one incident bond). Mirrors
 * `bond-instanced-renderer.ts:#write_image_slot`. When `is_partner_drawn`
 * is `false`, only the anchor side gets a visible stub (length scaled by
 * `stub_scale`); the other half is a zero matrix so it's invisible to the
 * picker — matching what the user sees on screen.
 */
function compute_image_decorator_transforms(
  pos_a: Vec3,
  pos_b: Vec3,
  bond_jimage: [number, number, number],
  jimage_img: [number, number, number],
  anchor_is_a: boolean,
  lattice: Float64Array | null,
  is_partner_drawn: boolean,
  stub_scale: number,
): [Float32Array, Float32Array] {
  const [bdx, bdy, bdz] = bond_jimage
  const [jx, jy, jz] = jimage_img
  const oax = anchor_is_a ? jx : jx - bdx
  const oay = anchor_is_a ? jy : jy - bdy
  const oaz = anchor_is_a ? jz : jz - bdz
  const obx = anchor_is_a ? jx + bdx : jx
  const oby = anchor_is_a ? jy + bdy : jy
  const obz = anchor_is_a ? jz + bdz : jz

  let ax = pos_a[0], ay = pos_a[1], az = pos_a[2]
  let bx = pos_b[0], by = pos_b[1], bz = pos_b[2]
  if (lattice !== null) {
    if ((oax | oay | oaz) !== 0) {
      ax += oax * lattice[0] + oay * lattice[3] + oaz * lattice[6]
      ay += oax * lattice[1] + oay * lattice[4] + oaz * lattice[7]
      az += oax * lattice[2] + oay * lattice[5] + oaz * lattice[8]
    }
    if ((obx | oby | obz) !== 0) {
      bx += obx * lattice[0] + oby * lattice[3] + obz * lattice[6]
      by += obx * lattice[1] + oby * lattice[4] + obz * lattice[7]
      bz += obx * lattice[2] + oby * lattice[5] + obz * lattice[8]
    }
  }

  const fx = bx - ax, fy = by - ay, fz = bz - az
  const length = Math.hypot(fx, fy, fz)
  if (length < 1e-8) {
    return [new Float32Array(16), new Float32Array(16)]
  }
  const half_length = length * 0.5
  __pick_dir.set(fx / length, fy / length, fz / length)
  __pick_quat.setFromUnitVectors(__pick_up_y, __pick_dir)

  if (is_partner_drawn) {
    const mx = (ax + bx) * 0.5, my = (ay + by) * 0.5, mz = (az + bz) * 0.5
    __pick_scale.set(1, half_length, 1)
    __pick_mid.set((ax + mx) * 0.5, (ay + my) * 0.5, (az + mz) * 0.5)
    __pick_mat.compose(__pick_mid, __pick_quat, __pick_scale)
    const m_a = new Float32Array(16)
    __pick_mat.toArray(m_a)

    __pick_mid.set((mx + bx) * 0.5, (my + by) * 0.5, (mz + bz) * 0.5)
    __pick_mat.compose(__pick_mid, __pick_quat, __pick_scale)
    const m_b = new Float32Array(16)
    __pick_mat.toArray(m_b)
    return [m_a, m_b]
  }

  // Incomplete-edge stub: only the anchor's side renders.
  const stub_len = half_length * stub_scale
  const half_stub = stub_len * 0.5
  __pick_scale.set(1, stub_len, 1)
  if (anchor_is_a) {
    __pick_mid.set(
      ax + __pick_dir.x * half_stub,
      ay + __pick_dir.y * half_stub,
      az + __pick_dir.z * half_stub,
    )
    __pick_mat.compose(__pick_mid, __pick_quat, __pick_scale)
    const m_a = new Float32Array(16)
    __pick_mat.toArray(m_a)
    return [m_a, new Float32Array(16)]
  }
  __pick_mid.set(
    bx - __pick_dir.x * half_stub,
    by - __pick_dir.y * half_stub,
    bz - __pick_dir.z * half_stub,
  )
  __pick_mat.compose(__pick_mid, __pick_quat, __pick_scale)
  const m_b = new Float32Array(16)
  __pick_mat.toArray(m_b)
  return [new Float32Array(16), m_b]
}

/**
 * Rebuild the GPU picker scene from current atom data and bond transforms.
 *
 * Half-bond model: each logical bond pushes 2 cylinder instances (anchored
 * at atom A and atom B respectively). The picker decode (`>>> 1` in
 * gpu-picker.ts) folds both halves back to the same logical bond, so
 * hovering / clicking either half resolves to the same bond key.
 */
export function update_gpu_picker(
  gpu_picker: GPUPicker,
  atom_data: AtomEntry[],
  filtered_bond_pairs: {
    transform_matrix: Float32Array
    pos_1: Vec3
    pos_2: Vec3
    jimage?: [number, number, number]
    site_idx_1?: number
    site_idx_2?: number
  }[],
  bond_thickness: number,
  realtime_position_overrides: Map<number, Vec3> | null,
  cutting_active: boolean,
  cutting_visibility_map: Map<number, CuttingVisInfo>,
  lattice_matrix: Float64Array | null,
  incomplete_edge: { mode: boolean; scale: number } | null,
  image_atom_layout: ImageAtomLayout | null = null,
  bond_manager: BondManager | null = null,
  partner_drawn_lookup: PartnerDrawnLookup | null = null,
  slot_to_filtered_idx: Int32Array | null = null,
): void {
  const positions = atom_data.map(a =>
    realtime_position_overrides?.get(a.site_idx) ?? a.position,
  )
  // Set radius to 0 for atoms outside the slab so GPU picker ignores them
  const radii = atom_data.map(a =>
    is_atom_pickable(a.site_idx, cutting_active, cutting_visibility_map) ? a.radius * 0.5 : 0,
  )

  // Phase 7e: total picker bond instance count = cell-internal halves +
  // image-atom decorator halves. The decorator block immediately follows
  // the cell-internal block, mirroring `BondInstancedRenderer`'s mesh
  // layout so the per-instance index maps cleanly to a filtered_bond_pairs
  // index via `instance_to_filtered_idx`.
  const cell_count = filtered_bond_pairs.length * 2
  const decorator_count =
    image_atom_layout !== null && bond_manager !== null
      ? image_atom_layout.bonds_csr.length * 2
      : 0
  const bond_xforms: Float32Array[] = new Array(cell_count + decorator_count)
  const instance_to_filtered_idx = new Int32Array(cell_count + decorator_count)
  instance_to_filtered_idx.fill(-1)

  for (let i = 0; i < filtered_bond_pairs.length; i++) {
    const b = filtered_bond_pairs[i]
    const ji = b.jimage ?? [0, 0, 0]
    const pa = realtime_position_overrides?.get(b.site_idx_1 ?? -1) ?? b.pos_1
    const pb = realtime_position_overrides?.get(b.site_idx_2 ?? -1) ?? b.pos_2
    const [m_a, m_b] = compute_half_bond_transforms(pa, pb, ji, lattice_matrix, incomplete_edge)
    bond_xforms[i * 2] = m_a
    bond_xforms[i * 2 + 1] = m_b
    instance_to_filtered_idx[i * 2] = i
    instance_to_filtered_idx[i * 2 + 1] = i
  }

  if (decorator_count > 0 && image_atom_layout !== null && bond_manager !== null) {
    const layout = image_atom_layout
    const pairs = bond_manager.pairs_buffer
    const jimg = bond_manager.jimages_buffer
    const stub_scale = incomplete_edge !== null ? incomplete_edge.scale : 0.5
    // Build site_idx → world position lookup. Atom positions arrive via
    // atom_data; decorator atoms reference the same site indices, so a
    // single map covers both endpoints.
    const pos_by_site = new Map<number, Vec3>()
    for (let i = 0; i < atom_data.length; i++) {
      pos_by_site.set(atom_data[i].site_idx, positions[i])
    }
    let dec_inst = cell_count
    for (let img = 0; img < layout.n_image_atoms; img++) {
      const orig_idx = layout.orig_site_indices[img]
      const jx = layout.jimage_offsets[img * 3]
      const jy = layout.jimage_offsets[img * 3 + 1]
      const jz = layout.jimage_offsets[img * 3 + 2]
      const csr_lo = layout.row_offsets[img]
      const csr_hi = layout.row_offsets[img + 1]
      for (let k = csr_lo; k < csr_hi; k++) {
        const slot = layout.bonds_csr[k]
        const a = pairs[slot * 2]
        const b = pairs[slot * 2 + 1]
        const ji_b = slot * 3
        const bdx = jimg[ji_b]
        const bdy = jimg[ji_b + 1]
        const bdz = jimg[ji_b + 2]
        const anchor_is_a = a === (orig_idx >>> 0)
        const partner_idx = anchor_is_a ? b : a
        const pjx = anchor_is_a ? jx + bdx : jx - bdx
        const pjy = anchor_is_a ? jy + bdy : jy - bdy
        const pjz = anchor_is_a ? jz + bdz : jz - bdz
        const is_partner_drawn =
          partner_drawn_lookup === null ||
          partner_drawn_lookup(partner_idx, pjx, pjy, pjz)

        const pos_a = pos_by_site.get(a) ?? [0, 0, 0]
        const pos_b = pos_by_site.get(b) ?? [0, 0, 0]
        const [m_a, m_b] = compute_image_decorator_transforms(
          pos_a, pos_b,
          [bdx, bdy, bdz],
          [jx, jy, jz],
          anchor_is_a,
          lattice_matrix,
          is_partner_drawn,
          stub_scale,
        )
        bond_xforms[dec_inst] = m_a
        bond_xforms[dec_inst + 1] = m_b
        // Resolve slot → filtered_bond_pairs index. -1 left in place when
        // shadow sync hasn't yet propagated the slot or the bond was
        // hidden (cutting plane / element filter dropped it from the
        // filtered list before the layout could be rebuilt).
        const fidx =
          slot_to_filtered_idx !== null && slot < slot_to_filtered_idx.length
            ? slot_to_filtered_idx[slot]
            : -1
        instance_to_filtered_idx[dec_inst] = fidx
        instance_to_filtered_idx[dec_inst + 1] = fidx
        dec_inst += 2
      }
    }
  }

  gpu_picker.update(positions, radii, bond_xforms, bond_thickness, instance_to_filtered_idx)
}

/**
 * Set up canvas-level hover detection.
 * For small structures (<2000 atoms): uses analytic ray-sphere (fast enough).
 * For large structures (>=2000 atoms): uses GPU picking (O(1) per pixel).
 *
 * Returns a cleanup function. Must be called inside a component `$effect`.
 */
export function setup_hover_detection(
  deps: GpuPickerDeps,
  picker: ReturnType<typeof create_gpu_picker>,
): (() => void) | undefined {
  const threlte = deps.get_threlte()
  const canvas = threlte.renderer?.domElement
  if (!canvas) return

  // R8.1: rAF-throttle the hover handler. Browsers can deliver pointermove
  // events faster than the display refresh; the listener captures the latest
  // event coordinates, and a single in-flight rAF drains them once per frame.
  // This collapses N pointermoves-per-frame into exactly 1 hit-test per frame.
  // Mirrors the rAF-batching pattern in controllers/interaction.svelte.ts
  // (pending_drag_raf_id / pending_rotation_raf_id).
  let pending_x = 0
  let pending_y = 0
  let hover_dirty = false
  let raf_id = 0

  function run_hit_test() {
    raf_id = 0
    if (!hover_dirty) return
    hover_dirty = false
    const x = pending_x
    const y = pending_y

    // R8.2: bail on camera_is_moving — the tooltip is hidden during orbit
    // (StructureScene.svelte:3411) so the picker work is pure waste.
    if (
      deps.get_external_dragging() ||
      deps.get_is_rotating_atoms() ||
      deps.get_is_box_selecting() ||
      deps.get_camera_is_moving()
    ) return
    // Skip hover detection when bulk atoms are hidden (e.g. slab preview mode)
    if (!deps.get_show_bulk_atoms()) {
      if (deps.get_hovered_idx() !== null) {
        deps.set_hovered_idx(null)
        deps.set_active_tooltip(null)
      }
      return
    }

    const atom_data = deps.get_atom_data()

    if (deps.get_is_large_structure()) {
      // GPU picking path for large structures
      const threlte_now = deps.get_threlte()
      const renderer = threlte_now.renderer
      const cam = threlte_now.camera.current
      if (!renderer || !cam) return

      // Update picker scene if dirty
      if (picker.picker_dirty) {
        update_gpu_picker(
          picker.gpu_picker,
          atom_data,
          deps.get_filtered_bond_pairs(),
          deps.get_bond_thickness(),
          deps.get_realtime_position_overrides(),
          deps.get_cutting_active(),
          deps.get_cutting_visibility_map(),
          deps.get_lattice_matrix(),
          deps.get_incomplete_edge(),
          deps.get_image_atom_layout?.() ?? null,
          deps.get_bond_manager?.() ?? null,
          deps.get_partner_drawn_lookup?.() ?? null,
          deps.get_slot_to_filtered_idx?.() ?? null,
        )
        picker.picker_dirty = false
      }

      const rect = canvas!.getBoundingClientRect()
      const ndc_x = ((x - rect.left) / rect.width) * 2 - 1
      const ndc_y = -((y - rect.top) / rect.height) * 2 + 1

      const result = picker.gpu_picker.pick(ndc_x, ndc_y, cam, renderer)
      const picked_atom = result?.type === `atom` ? atom_data[result.index] : null
      if (picked_atom && is_atom_pickable(picked_atom.site_idx, deps.get_cutting_active(), deps.get_cutting_visibility_map())) {
        if (deps.get_hovered_idx() !== picked_atom.site_idx) {
          deps.set_hovered_idx(picked_atom.site_idx)
          deps.set_active_tooltip(`atom`)
        }
      } else {
        if (deps.get_hovered_idx() !== null) {
          deps.set_hovered_idx(null)
          deps.set_active_tooltip(null)
        }
      }
    } else {
      // Analytic ray-sphere path for small structures.
      // Synthesize a minimal MouseEvent-shaped object from the pending coords
      // so find_hit_atom_from_event (which reads clientX/clientY) keeps working.
      const synthetic = { clientX: x, clientY: y } as unknown as PointerEvent
      const hit = deps.find_hit_atom_from_event(synthetic)
      if (hit) {
        if (deps.get_hovered_idx() !== hit.site_idx) {
          deps.set_hovered_idx(hit.site_idx)
          deps.set_active_tooltip(`atom`)
        }
      } else {
        if (deps.get_hovered_idx() !== null) {
          deps.set_hovered_idx(null)
          deps.set_active_tooltip(null)
        }
      }
    }
  }

  function handle_hover(event: PointerEvent) {
    pending_x = event.clientX
    pending_y = event.clientY
    hover_dirty = true
    if (raf_id === 0) {
      raf_id = requestAnimationFrame(run_hit_test)
    }
  }

  function handle_hover_leave() {
    if (deps.get_hovered_idx() !== null) {
      deps.set_hovered_idx(null)
      deps.set_active_tooltip(null)
    }
  }

  canvas.addEventListener(`pointermove`, handle_hover)
  canvas.addEventListener(`pointerleave`, handle_hover_leave)
  return () => {
    canvas.removeEventListener(`pointermove`, handle_hover)
    canvas.removeEventListener(`pointerleave`, handle_hover_leave)
    if (raf_id !== 0) {
      cancelAnimationFrame(raf_id)
      raf_id = 0
    }
    hover_dirty = false
  }
}

/**
 * Analytic ray-sphere intersection for hover detection (canvas-level).
 * Uses event clientX/clientY to build a ray and test against atom_data.
 */
export function find_hit_atom_from_event(
  event: PointerEvent | MouseEvent,
  threlte: { renderer?: { domElement: HTMLCanvasElement } | null; camera: { current: Camera | null } },
  structure: { sites?: any[] } | undefined,
  atom_data: AtomEntry[],
  rotation: Vec3,
  rotation_target: Vec3 | undefined,
  realtime_position_overrides: Map<number, Vec3> | null,
  cutting_active: boolean,
  cutting_visibility_map: Map<number, CuttingVisInfo>,
): { site_idx: number; position: Vec3 } | null {
  const canvas = threlte.renderer?.domElement
  const cam = threlte.camera.current
  if (!canvas || !cam || !structure?.sites) return null

  const rect = canvas.getBoundingClientRect()
  const ndc_x = ((event.clientX - rect.left) / rect.width) * 2 - 1
  const ndc_y = -((event.clientY - rect.top) / rect.height) * 2 + 1

  // Build ray from camera
  const ray_origin = new Vector3()
  const ray_dir = new Vector3()

  if (`isPerspectiveCamera` in cam && (cam as any).isPerspectiveCamera) {
    ray_origin.setFromMatrixPosition(cam.matrixWorld)
    ray_dir.set(ndc_x, ndc_y, 0.5).unproject(cam).sub(ray_origin).normalize()
  } else {
    const ortho = cam as any
    ray_dir.set(0, 0, -1).transformDirection(cam.matrixWorld)
    const cam_right = new Vector3(1, 0, 0).applyQuaternion(cam.quaternion)
    const cam_up = new Vector3(0, 1, 0).applyQuaternion(cam.quaternion)
    const left = ortho.left ?? -1
    const right_val = ortho.right ?? 1
    const top_val = ortho.top ?? 1
    const bottom = ortho.bottom ?? -1
    const zoom = ortho.zoom ?? 1
    const half_w = (right_val - left) / (2 * zoom)
    const half_h = (top_val - bottom) / (2 * zoom)
    ray_origin.copy(cam.position)
      .addScaledVector(cam_right, ndc_x * half_w)
      .addScaledVector(cam_up, ndc_y * half_h)
  }

  // Transform ray into the rotated structure's local space
  const rot_euler = new Euler(...(rotation ?? [0, 0, 0]))
  const rot_quat = new Quaternion().setFromEuler(rot_euler)
  const inv_quat = rot_quat.clone().invert()
  const rt = rotation_target ?? [0, 0, 0]
  const local_origin = ray_origin.clone().sub(new Vector3(...rt))
  const rotated_origin = local_origin.applyQuaternion(inv_quat).add(new Vector3(...rt))
  const local_dir = ray_dir.clone().applyQuaternion(inv_quat)

  // Analytic ray-sphere intersection against all visible atoms
  let best_t = Infinity
  let best_idx: number | null = null
  let best_pos: Vec3 | null = null
  const tmp = new Vector3()

  for (const atom of atom_data) {
    if (!is_atom_pickable(atom.site_idx, cutting_active, cutting_visibility_map)) continue
    const pos = realtime_position_overrides?.get(atom.site_idx) ?? atom.position
    tmp.set(pos[0], pos[1], pos[2]).sub(rotated_origin)
    const proj = tmp.dot(local_dir)
    if (proj < 0) continue // Behind the camera
    const perp_sq = tmp.lengthSq() - proj * proj
    const r = atom.radius * 0.5
    if (perp_sq > r * r) continue // Ray misses sphere
    const t = proj - Math.sqrt(r * r - perp_sq)
    if (t < best_t) {
      best_t = t
      best_idx = atom.site_idx
      best_pos = pos
    }
  }

  if (best_idx !== null && best_pos !== null) {
    return { site_idx: best_idx, position: best_pos }
  }
  return null
}

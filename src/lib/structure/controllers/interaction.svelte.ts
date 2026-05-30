/**
 * 交互处理器模块 — 鼠标/键盘/拖拽/旋转/框选/裁剪
 *
 * 管理 Structure.svelte 中所有用户交互:
 * - 原子拖拽 (Shift+Alt+移动鼠标): 拖动选中的原子
 * - 原子旋转 (Shift+click+drag): 围绕选中原子质心旋转
 * - 键盘移动 (Shift+Alt+方向键): 按相机方向移动选中原子
 * - 键盘旋转 (Shift+方向键): 围绕选中原子质心旋转
 * - 轴锁定旋转 (X/Y/Z+拖拽): 锁定单轴旋转场景
 * - 框选 (Cmd/Ctrl+拖拽): 矩形选区选择原子和键
 * - 裁剪导出 (crop mode): 绘制矩形区域导出 PNG
 * - 快捷键 (Ctrl+Z/C/V, Escape, Delete, 方向键等)
 * - 坐标变换工具 (project_to_screen, local_to_world, get_3d_position_from_click)
 *
 * UX 改进:
 * - handleShiftClickCapture 和 onmousedown 中重复的「开始原子旋转」代码
 *   (~40行×2) 统一到 start_atom_rotation() 内部方法
 * - commit_drag/rotation/keyboard_move 中重复的「应用 overrides → 清除状态」
 *   统一到 apply_overrides_to_structure() 内部方法
 * - Ctrl+C/V 中重复的「flush 待处理的键盘移动/旋转」
 *   统一到 flush_pending_keyboard_ops() 内部方法
 *
 * 使用 .svelte.ts 后缀因为内部用 $state 管理交互状态
 *
 * 依赖:
 * - structure, camera, wrapper, orbit_controls 等通过 deps getter/setter 访问
 * - move_atom, delete_atoms, extract_clipboard_sites 等纯函数直接 import
 */

import type { AnyStructure, Vec3 } from '$lib'
import type { PymatgenStructure } from '$lib/structure'
import type { CropRegion } from '$lib/io/export'
import type { ManualBond, BondPair, SelectedBond } from '../index'
import type { AtomArrayInverse } from '../state/selection-state.svelte'
import { move_atom, extract_clipboard_sites, insert_clipboard_sites, delete_atoms, get_default_bond_length } from '../atom-manipulation'
import type { AtomFastOps, AtomMoveSpec } from '../atoms/atom-manager.svelte'
import { get_bond_key } from '../bonding'
import { get_movement_step } from '../manipulation'
import { get_center_of_mass, get_rotation_center } from '$lib/structure'
import { atom_clipboard } from '$lib/state.svelte'
import { Euler, Plane, Quaternion, Raycaster, Vector2, Vector3 } from 'three'
import {
  screen_frame_from_camera,
  pick_locked_axis,
  rotate_points,
  drag_delta_for_axis,
  type LockAxis,
} from '$lib/structure/rotation-math'
import type { ElementSymbol } from '$lib'
import type { AtomManipulationEvent } from '../index'
import type { GestureConfig } from '$lib/gesture/gesture-types'

// ─── 模块级状态: 追踪最后交互的 wrapper，用于 Ctrl+C/V 路由到正确的 pane ───
let _active_interaction_wrapper: HTMLElement | null = null

// ─── 类型 ───

/** 工厂函数的依赖接口 — 按逻辑分组的 getter/setter 闭包 */
export interface InteractionDeps {
  // ── 核心结构数据 ──
  get_structure: () => AnyStructure | undefined
  set_structure: (s: AnyStructure) => void
  get_displayed_structure: () => AnyStructure | undefined
  get_selected_sites: () => number[]
  set_selected_sites: (s: number[]) => void

  // ── 3D 场景 ──
  get_camera: () => any  // PerspectiveCamera
  get_wrapper: () => HTMLDivElement | undefined
  get_orbit_controls: () => any  // OrbitControls
  get_scene_props: () => any
  set_scene_props_rotation: (r: [number, number, number]) => void
  get_rotation_target_ref: () => [number, number, number] | undefined

  // ── Undo 系统 ──
  push_to_undo: () => void
  /**
   * Push a sparse 'atom' undo entry (removed Site objects + indices).
   * Used by atom-delete paths instead of `push_to_undo()` to avoid an
   * O(N) structure snapshot on every Delete keystroke.
   */
  push_atom_entry: (atom_inverse: AtomArrayInverse) => void
  undo: () => void
  redo: () => void
  get_redo_length: () => number
  push_selection_to_undo: () => void
  get_structure_history_length: () => number
  get_opacity_history: () => { atoms: Map<number, number>; bonds: Map<string, number> }[]
  set_opacity_history: (h: { atoms: Map<number, number>; bonds: Map<string, number> }[]) => void
  get_selection_history: () => number[][]
  set_selection_history: (h: number[][]) => void
  get_atom_opacity_overrides: () => Map<number, number>
  set_atom_opacity_overrides: (m: Map<number, number>) => void
  get_bond_opacity_overrides: () => Map<string, number>
  set_bond_opacity_overrides: (m: Map<string, number>) => void

  // ── 选中状态 ──
  get_selected_bonds: () => SelectedBond[]
  set_selected_bonds: (b: SelectedBond[]) => void
  get_scene_bond_pairs: () => BondPair[]
  get_selection_opacity: () => number
  set_selection_opacity: (v: number) => void

  // ── 面板/模式状态 ──
  get_chat_pane_open: () => boolean
  set_chat_pane_open: (v: boolean) => void
  get_gesture_active: () => boolean
  set_gesture_active: (v: boolean) => void
  get_gesture_config: () => GestureConfig
  set_gesture_config: (c: GestureConfig) => void
  get_info_pane_open: () => boolean
  set_info_pane_open: (v: boolean) => void
  get_controls_open: () => boolean
  set_controls_open: (v: boolean) => void
  get_hovered: () => boolean
  get_fullscreen_toggle: () => any
  get_enable_info_pane: () => boolean
  toggle_fullscreen_fn: () => void
  get_lattice_alignment_rotation: () => Vec3

  // ── 铅笔模式 (Phase 5 前需要读取的状态) ──
  get_pencil_mode_active: () => boolean
  set_pencil_mode_active: (v: boolean) => void
  get_pencil_drag_active: () => boolean
  set_pencil_drag_active: (v: boolean) => void
  get_pencil_anchor_idx: () => number | null
  set_pencil_anchor_idx: (v: number | null) => void
  get_pencil_ghost_atom: () => any
  set_pencil_ghost_atom: (v: any) => void
  get_pencil_add_mode: () => string
  set_pencil_add_mode: (v: string) => void
  complete_pencil_drag: () => void

  // ── 键编辑模式 ──
  get_bond_first_atom: () => number | null
  set_bond_first_atom: (v: number | null) => void
  get_bond_drag_active: () => boolean
  reset_bond_drag: (clear_first_atom: boolean) => void
  delete_selected_bonds: () => void

  // ── 吸附位放置模式 ──
  get_adsorbate_placement_mode_active: () => boolean
  set_adsorbate_placement_mode_active: (v: boolean) => void

  // ── 测量模式 ──
  get_selected_measurement_id: () => string | null
  delete_measurement: (id: string) => void
  get_measured_sites: () => number[]
  set_measured_sites: (s: number[]) => void

  // ── 右键菜单 ──
  set_context_menu_position: (pos: { x: number; y: number }) => void
  set_context_menu_3d_position: (pos: [number, number, number]) => void
  set_context_menu_target_site: (idx: number | null) => void
  set_context_menu_visible: (v: boolean) => void

  // ── 回调 props ──
  get_on_atoms_manipulated: () => ((event: AtomManipulationEvent) => void) | undefined
  get_on_atoms_deleted: () => ((event: { site_indices: number[] }) => void) | undefined

  /**
   * Reindex index-keyed edit state (manual bonds / deleted-bond keys / hidden
   * sites) after an atom delete. Must be called with the OLD-index deleted list
   * (the `sorted_indices` this path already computes), so the controller has no
   * direct access to pencil/hidden_sites — it delegates to Structure.svelte.
   */
  reindex_edits_after_delete: (deleted: number[]) => void

  // ── 原子操作工具 ──
  get_original_atoms_only: (indices: number[]) => number[]

  // ── 缓存旋转目标 (拖拽时锁定相机) ──
  set_cached_rotation_target: (v: [number, number, number] | null) => void

  // ── saved_selection (保存选区以便结构更新后恢复) ──
  set_saved_selection: (v: number[] | null) => void

  // ── Phase X6 fast-path hook (null until StructureScene's $effect
  //    populates it; also null when USE_NEW_ATOM_SYSTEM is off). Optional. ──
  get_atom_fast_ops?: () => AtomFastOps | null
}

// ─── 工厂函数 ───

/**
 * 创建交互控制器 — 管理所有鼠标/键盘/拖拽/旋转/框选交互
 *
 * 使用方式:
 * ```ts
 * const interaction = create_interaction_controller({ ... })
 * // 模板: onpointerdowncapture={interaction.handleShiftClickCapture}
 * //        onpointerupcapture={interaction.handlePointerUpCapture}
 * // 全局事件通过 setup_global_listeners() effect 自动注册
 * ```
 */
export function create_interaction_controller(deps: InteractionDeps) {

  // ── 平台检测 ──
  const is_mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent)

  function is_box_select_modifier(event: MouseEvent | KeyboardEvent): boolean {
    return is_mac ? event.metaKey : event.ctrlKey
  }

  /** Find the main 3D viewer canvas, skipping preview canvases in sub-panes. */
  function get_main_canvas(w: HTMLElement): HTMLCanvasElement | null {
    for (const c of w.querySelectorAll('canvas')) {
      if (!c.closest('.preview-container') && !c.closest('.mol-preview')) return c as HTMLCanvasElement
    }
    return null
  }

  // ═══════════════════════════════════════════════════════════════════
  // 轴锁定旋转状态 — 按住 X/Y/Z 键 + 拖拽鼠标旋转场景的单个轴
  // ═══════════════════════════════════════════════════════════════════
  let axis_lock_key = $state<'x' | 'y' | 'z' | null>(null)
  let is_rotating = $state(false)
  let rotation_start_x = $state(0)
  let rotation_start_y = $state(0)
  let rotation_start_values = $state<[number, number, number]>([0, 0, 0])

  // ═══════════════════════════════════════════════════════════════════
  // 原子拖拽状态 — Shift+Alt+移动鼠标拖动选中原子
  // ═══════════════════════════════════════════════════════════════════
  let is_dragging_atom = $state(false)
  let dragged_atom_indices = $state<number[]>([])
  let drag_start_mouse_position = $state<[number, number, number] | null>(null)
  let drag_plane_reference = $state<[number, number, number] | null>(null)
  let drag_camera_quaternion = $state<Quaternion | null>(null)
  let drag_camera_snapshot = $state<any>(null)
  let drag_initial_atom_positions = $state<Map<number, [number, number, number]>>(new Map())

  // ═══════════════════════════════════════════════════════════════════
  // 原子旋转状态 — Shift+drag 围绕选中原子质心旋转
  // Shift + 左键拖拽: pitch/yaw (绕相机 up/right 轴)
  // Shift + 右键拖拽: roll (绕相机 forward 轴)
  // ═══════════════════════════════════════════════════════════════════
  let is_rotating_atoms = $state(false)
  let atom_rotation_center = $state<[number, number, number] | null>(null)
  let atom_rotation_initial_positions = $state<Map<number, [number, number, number]>>(new Map())
  let atom_rotation_camera_quat = $state<Quaternion | null>(null)
  let atom_rotation_used_right = $state(false)
  let atom_rotation_axis = $state<[number, number, number] | null>(null)
  let atom_rotation_angle_deg = $state<number>(0)
  let atom_rotation_start_x = $state(0)
  let atom_rotation_start_y = $state(0)
  let atom_rotation_locked_axis = $state<LockAxis | null>(null)

  // ═══════════════════════════════════════════════════════════════════
  // RAF 批处理 — 拖拽/旋转时用 requestAnimationFrame 批量更新位置,
  // 避免每像素移动都触发 structure 更新 (大结构性能瓶颈)
  // ═══════════════════════════════════════════════════════════════════
  let pending_rotation_update = $state(false)
  let pending_rotation_positions = $state<Map<number, [number, number, number]>>(new Map())
  let pending_drag_update = $state(false)
  let pending_drag_positions = $state<Map<number, [number, number, number]>>(new Map())
  let pending_drag_raf_id = 0
  let pending_rotation_raf_id = 0

  // 实时位置覆盖 — 拖拽/旋转期间的视觉反馈，不触发完整 structure 更新
  let realtime_position_overrides = $state<Map<number, [number, number, number]>>(new Map())

  // ═══════════════════════════════════════════════════════════════════
  // 键盘移动状态 — Shift+Alt+方向键/WS 按相机方向移动选中原子
  // ═══════════════════════════════════════════════════════════════════
  let keyboard_move_pending = $state(false)
  let keyboard_move_displacement = $state<[number, number, number]>([0, 0, 0])
  let keyboard_undo_saved = $state(false)
  const KEYBOARD_THROTTLE_MS = 50

  // 累积键盘位移 — 用于 realtime overrides
  let keyboard_cumulative_displacement = $state<[number, number, number]>([0, 0, 0])
  let keyboard_initial_positions = $state<Map<number, [number, number, number]>>(new Map())

  // 键盘旋转状态 — Shift+方向键围绕选中原子质心旋转
  let keyboard_rotation_initial_positions = $state<Map<number, [number, number, number]>>(new Map())
  let keyboard_rotation_center = $state<[number, number, number] | null>(null)
  let keyboard_rotation_undo_saved = $state(false)
  let keyboard_rotation_timeout: ReturnType<typeof setTimeout> | null = null
  const KEYBOARD_ROTATION_STEP = 0.05 // ~3 degrees per key press
  const AXIS_LOCK_DEADZONE_PX = 4 // left-drag must exceed this before an axis locks

  // ═══════════════════════════════════════════════════════════════════
  // 框选状态 — Cmd/Ctrl+拖拽矩形选择多个原子
  // ═══════════════════════════════════════════════════════════════════
  let is_box_selecting = $state(false)
  let box_select_start = $state<{ x: number; y: number } | null>(null)
  let box_select_end = $state<{ x: number; y: number } | null>(null)
  // performance.now() timestamp of the most recent committed box-select. Used by
  // the WebGPU overlay's empty-space-clear path: the overlay watches window
  // pointerup and (lacking the box-select modifier check) can misclassify a small
  // /dense Cmd/Ctrl+drag box-select as a background click → its async pick returns
  // -1 → the parent would clear the selection the box just set. The parent reads
  // this stamp and suppresses that one clear. -Infinity = never box-selected.
  let last_box_select_commit_ms = $state(-Infinity)

  // ═══════════════════════════════════════════════════════════════════
  // 裁剪导出状态 — 绘制矩形区域 → 导出 PNG → 退出
  // ═══════════════════════════════════════════════════════════════════
  let crop_mode_active = $state(false)
  let crop_region = $state<CropRegion | null>(null)
  let crop_drawing = $state(false)
  let crop_draw_start = $state<{ x: number; y: number } | null>(null)
  let crop_draw_end = $state<{ x: number; y: number } | null>(null)

  // ═══════════════════════════════════════════════════════════════════
  // 内部工具方法 — 消除代码重复
  // ═══════════════════════════════════════════════════════════════════

  /** 坐标变换: 局部坐标 → 世界坐标 (考虑 scene rotation) */
  function local_to_world(local_pos: [number, number, number]): [number, number, number] {
    const rot = deps.get_scene_props().rotation || [0, 0, 0]
    const target = deps.get_rotation_target_ref() || [0, 0, 0]

    if (rot[0] === 0 && rot[1] === 0 && rot[2] === 0) {
      return local_pos
    }

    const euler = new Euler(rot[0], rot[1], rot[2], 'XYZ')
    const quat = new Quaternion().setFromEuler(euler)
    const offset = new Vector3(
      local_pos[0] - target[0],
      local_pos[1] - target[1],
      local_pos[2] - target[2],
    )
    offset.applyQuaternion(quat)
    return [
      target[0] + offset.x,
      target[1] + offset.y,
      target[2] + offset.z,
    ]
  }

  /** 3D → 2D 投影 (使用 canvas rect 确保 split-view 下坐标正确) */
  function project_to_screen(pos: [number, number, number]): { x: number; y: number } | null {
    const camera = deps.get_camera()
    const wrapper = deps.get_wrapper()
    if (!camera || !wrapper) return null

    camera.updateMatrixWorld()

    const canvas_el = get_main_canvas(wrapper)
    const rect = canvas_el?.getBoundingClientRect() ?? wrapper.getBoundingClientRect()
    const world_pos = local_to_world(pos)
    const vec = new Vector3(world_pos[0], world_pos[1], world_pos[2])

    // 跳过相机后方的原子 (cam_z > 0 = 在相机后面)
    const cam_z = vec.clone().applyMatrix4(camera.matrixWorldInverse).z
    if (cam_z > 0) return null

    vec.project(camera)
    const x = (vec.x * 0.5 + 0.5) * rect.width
    const y = (-vec.y * 0.5 + 0.5) * rect.height
    return { x, y }
  }

  /** 点是否在矩形内 */
  function is_in_rect(
    point: { x: number; y: number },
    start: { x: number; y: number },
    end: { x: number; y: number },
  ): boolean {
    const min_x = Math.min(start.x, end.x)
    const max_x = Math.max(start.x, end.x)
    const min_y = Math.min(start.y, end.y)
    const max_y = Math.max(start.y, end.y)
    return point.x >= min_x && point.x <= max_x && point.y >= min_y && point.y <= max_y
  }

  /** 2D 点击 → 3D 射线投射，返回平面交点 */
  function get_3d_position_from_click(
    event: MouseEvent,
    custom_plane_center?: [number, number, number],
    fixed_quaternion?: Quaternion | null,
    fixed_camera?: any,
  ): [number, number, number] | null {
    const camera = deps.get_camera()
    const wrapper = deps.get_wrapper()
    const cam = fixed_camera || camera
    if (!cam || !wrapper) return null

    const canvas_el = get_main_canvas(wrapper)
    const rect = canvas_el?.getBoundingClientRect() ?? wrapper.getBoundingClientRect()

    const mouse = new Vector2()
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1

    cam.updateMatrixWorld?.(true)

    const raycaster = new Raycaster()
    raycaster.setFromCamera(mouse, cam)

    const structure = deps.get_structure()
    let plane_center: [number, number, number] = custom_plane_center || [0, 0, 0]
    if (!custom_plane_center && structure && structure.sites.length > 0) {
      plane_center = get_rotation_center(structure)
    }

    const quaternion_to_use = fixed_quaternion || camera.quaternion
    const cam_forward = new Vector3(0, 0, -1).applyQuaternion(quaternion_to_use)
    const plane_normal = cam_forward.clone().negate()
    const plane = new Plane(plane_normal, 0)
    plane.translate(new Vector3(...plane_center))

    const intersection_point = new Vector3()
    const hit = raycaster.ray.intersectPlane(plane, intersection_point)

    if (hit) {
      return [intersection_point.x, intersection_point.y, intersection_point.z]
    }

    // 正交相机降级: 反投影鼠标位置并投射到平面上
    const unprojected = new Vector3(mouse.x, mouse.y, 0).unproject(cam)
    const t = new Vector3(...plane_center).sub(unprojected).dot(cam_forward)
    const result = unprojected.addScaledVector(cam_forward, t)
    return [result.x, result.y, result.z]
  }

  // ═══════════════════════════════════════════════════════════════════
  // DRY: 通用 override → structure 提交逻辑
  // commit_drag/rotation/keyboard_move 都遵循相同模式:
  // 1. 计算位移 2. 应用 overrides 到 structure 3. 清除 overrides 4. 触发回调
  // ═══════════════════════════════════════════════════════════════════

  /** 从 realtime overrides 计算每个原子的位移向量 */
  function compute_displacements_from_overrides(): Map<number, Vec3> {
    const disps = new Map<number, Vec3>()
    const structure = deps.get_structure()
    if (!structure) return disps
    for (const [idx, new_pos] of realtime_position_overrides) {
      const old = structure.sites[idx]?.xyz
      if (!old) continue
      disps.set(idx, [new_pos[0] - old[0], new_pos[1] - old[1], new_pos[2] - old[2]])
    }
    return disps
  }

  /** 将 realtime_position_overrides 应用到 structure，清除 overrides，触发回调 */
  function apply_overrides_to_structure() {
    const structure = deps.get_structure()
    if (realtime_position_overrides.size === 0 || !structure) {
      realtime_position_overrides = new Map()
      return
    }

    const displacements = compute_displacements_from_overrides()

    let new_structure = structure
    for (const [idx, new_pos] of realtime_position_overrides) {
      new_structure = move_atom(new_structure, idx, new_pos)
    }

    // Phase X6: fire the fast path BEFORE set_structure. Order is load-
    // bearing — see Structure.svelte.delete_selected for the same pattern.
    // This path fires at drag-commit (pointerup) and keyboard-arrow moves,
    // NOT per-frame during a drag — that still goes through
    // realtime_position_overrides. The X6b drag fast-path will write moves
    // straight into overrides and skip `move_atom` entirely per-frame; this
    // hook is the final commit step.
    const move_specs: AtomMoveSpec[] = []
    for (const [idx, new_pos] of realtime_position_overrides) {
      move_specs.push({
        site_id: idx,
        new_position: [new_pos[0], new_pos[1], new_pos[2]] as const,
      })
    }
    if (move_specs.length > 0) {
      deps.get_atom_fast_ops?.()?.try_move(move_specs, new_structure.sites)
    }

    deps.set_structure(new_structure)
    // Fire the trajectory write path FIRST while the overrides still mask
    // the edited atoms in Structure.svelte's Phase-2 loop. handle_atoms_-
    // manipulated synchronously mirrors the edit into position_cache[idx];
    // only after that is it safe to clear the overrides — otherwise Phase-2
    // re-asserts the pre-edit cache slice for one frame (issue #51 defect C
    // snap-back). For non-trajectory structures the callback is undefined
    // and this is a no-op, so set_structure already covers it.
    if (displacements.size > 0) deps.get_on_atoms_manipulated()?.({ displacements })
    // 安全: StructureScene 的位置快速路径同步更新 last_bond_structure
    realtime_position_overrides = new Map()
  }

  // ═══════════════════════════════════════════════════════════════════
  // DRY: 开始原子旋转 — handleShiftClickCapture 和 onmousedown
  // 都需要初始化旋转状态，之前各写了 ~40 行几乎相同的代码
  // ═══════════════════════════════════════════════════════════════════

  function start_atom_rotation(event: MouseEvent | PointerEvent, save_undo: boolean) {
    const structure = deps.get_structure()
    const camera = deps.get_camera()
    const orbit_controls = deps.get_orbit_controls()
    if (!structure || !camera) return false

    const original_indices = deps.get_original_atoms_only(deps.get_selected_sites())
    if (original_indices.length === 0) return false

    if (orbit_controls) orbit_controls.enabled = false
    if (save_undo) deps.push_to_undo()

    is_rotating_atoms = true
    atom_rotation_start_x = event.clientX
    atom_rotation_start_y = event.clientY
    // Default to left-drag (unlocked); the mousedown handlers override to 'x'
    // for the right-button roll path AFTER this function returns.
    atom_rotation_locked_axis = null
    atom_rotation_camera_quat = camera.quaternion.clone()
    atom_rotation_axis = null
    atom_rotation_angle_deg = 0

    // 计算选中原子的几何中心
    let center: [number, number, number] = [0, 0, 0]
    for (const idx of original_indices) {
      const site = structure.sites[idx]
      center[0] += site.xyz[0]
      center[1] += site.xyz[1]
      center[2] += site.xyz[2]
    }
    const count = original_indices.length
    atom_rotation_center = [center[0] / count, center[1] / count, center[2] / count]

    // 存储初始位置
    atom_rotation_initial_positions = new Map()
    for (const idx of original_indices) {
      const pos = structure.sites[idx].xyz
      atom_rotation_initial_positions.set(idx, [pos[0], pos[1], pos[2]])
    }

    return true
  }

  // ═══════════════════════════════════════════════════════════════════
  // DRY: Flush 待处理的键盘操作 — Ctrl+C/V 前需要提交位置
  // ═══════════════════════════════════════════════════════════════════

  function flush_pending_keyboard_ops() {
    if (realtime_position_overrides.size > 0) {
      if (keyboard_undo_timeout) { clearTimeout(keyboard_undo_timeout); keyboard_undo_timeout = null }
      if (keyboard_rotation_timeout) { clearTimeout(keyboard_rotation_timeout); keyboard_rotation_timeout = null }
      if (keyboard_initial_positions.size > 0) commit_keyboard_move_to_structure()
      else if (keyboard_rotation_initial_positions.size > 0) commit_keyboard_rotation_to_structure()
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // RAF 批处理函数
  // ═══════════════════════════════════════════════════════════════════

  function apply_pending_rotation() {
    if (pending_rotation_positions.size === 0 || !deps.get_structure()) {
      pending_rotation_update = false
      return
    }
    const new_overrides = new Map(realtime_position_overrides)
    for (const [idx, new_pos] of pending_rotation_positions) {
      new_overrides.set(idx, new_pos)
    }
    realtime_position_overrides = new_overrides
    pending_rotation_positions = new Map()
    pending_rotation_update = false
  }

  function apply_pending_drag() {
    if (pending_drag_positions.size === 0 || !deps.get_structure()) {
      pending_drag_update = false
      return
    }
    const new_overrides = new Map(realtime_position_overrides)
    for (const [idx, new_pos] of pending_drag_positions) {
      new_overrides.set(idx, new_pos)
    }
    realtime_position_overrides = new_overrides
    pending_drag_positions = new Map()
    pending_drag_update = false
  }

  // ═══════════════════════════════════════════════════════════════════
  // 提交/终止函数
  // ═══════════════════════════════════════════════════════════════════

  /** 提交旋转变更到 structure */
  function commit_rotation_to_structure() {
    deps.set_saved_selection([...deps.get_selected_sites()])
    apply_overrides_to_structure()
  }

  /** 提交拖拽变更到 structure */
  function commit_drag_to_structure() {
    apply_overrides_to_structure()
  }

  /** 集中清理: 取消 RAF → 刷新缓冲 → 提交到 structure → 重置状态 → 恢复 orbit */
  function finish_drag() {
    cancelAnimationFrame(pending_drag_raf_id)
    if (pending_drag_positions.size > 0) apply_pending_drag()
    commit_drag_to_structure()
    is_dragging_atom = false
    dragged_atom_indices = []
    drag_start_mouse_position = null
    drag_plane_reference = null
    drag_camera_quaternion = null
    drag_camera_snapshot = null
    drag_initial_atom_positions = new Map()
    const orbit_controls = deps.get_orbit_controls()
    if (orbit_controls) orbit_controls.enabled = true
  }

  /** 集中清理: 取消 RAF → 刷新缓冲 → 提交到 structure → 重置旋转状态 → 恢复 orbit */
  function finish_rotation() {
    cancelAnimationFrame(pending_rotation_raf_id)
    if (pending_rotation_positions.size > 0) apply_pending_rotation()
    commit_rotation_to_structure()
    is_rotating_atoms = false
    atom_rotation_center = null
    atom_rotation_initial_positions = new Map()
    atom_rotation_camera_quat = null
    atom_rotation_axis = null
    atom_rotation_angle_deg = 0
    atom_rotation_locked_axis = null
    atom_rotation_start_x = 0
    atom_rotation_start_y = 0
    pending_rotation_positions = new Map()
    pending_rotation_update = false
    const orbit_controls = deps.get_orbit_controls()
    if (orbit_controls) orbit_controls.enabled = true
  }

  // ═══════════════════════════════════════════════════════════════════
  // 键盘移动
  // ═══════════════════════════════════════════════════════════════════

  let keyboard_undo_timeout: ReturnType<typeof setTimeout> | null = null

  function apply_keyboard_move() {
    const structure = deps.get_structure()
    if (!structure || (keyboard_move_displacement[0] === 0 && keyboard_move_displacement[1] === 0 && keyboard_move_displacement[2] === 0)) {
      keyboard_move_pending = false
      return
    }

    const original_indices = deps.get_original_atoms_only(deps.get_selected_sites())
    if (original_indices.length === 0) {
      keyboard_move_pending = false
      keyboard_move_displacement = [0, 0, 0]
      return
    }

    if (keyboard_initial_positions.size === 0) {
      for (const idx of original_indices) {
        const pos = structure.sites[idx].xyz
        keyboard_initial_positions.set(idx, [pos[0], pos[1], pos[2]])
      }
    }

    keyboard_cumulative_displacement = [
      keyboard_cumulative_displacement[0] + keyboard_move_displacement[0],
      keyboard_cumulative_displacement[1] + keyboard_move_displacement[1],
      keyboard_cumulative_displacement[2] + keyboard_move_displacement[2],
    ]

    const new_overrides = new Map(realtime_position_overrides)
    for (const idx of original_indices) {
      const initial_pos = keyboard_initial_positions.get(idx)
      if (initial_pos) {
        new_overrides.set(idx, [
          initial_pos[0] + keyboard_cumulative_displacement[0],
          initial_pos[1] + keyboard_cumulative_displacement[1],
          initial_pos[2] + keyboard_cumulative_displacement[2],
        ])
      }
    }
    realtime_position_overrides = new_overrides
    deps.set_saved_selection([...deps.get_selected_sites()])
    keyboard_move_displacement = [0, 0, 0]
    keyboard_move_pending = false
  }

  function commit_keyboard_move_to_structure() {
    keyboard_initial_positions = new Map()
    keyboard_cumulative_displacement = [0, 0, 0]
    apply_overrides_to_structure()
  }

  function schedule_keyboard_undo_save() {
    if (keyboard_undo_timeout) clearTimeout(keyboard_undo_timeout)
    keyboard_undo_timeout = setTimeout(() => {
      commit_keyboard_move_to_structure()
      keyboard_undo_saved = false
      keyboard_undo_timeout = null
    }, 300)
  }

  // ═══════════════════════════════════════════════════════════════════
  // 键盘旋转
  // ═══════════════════════════════════════════════════════════════════

  function rotate_selected_atoms_keyboard(direction: 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Forward' | 'Backward') {
    const structure = deps.get_structure()
    const camera = deps.get_camera()
    if (!structure || !camera || deps.get_selected_sites().length === 0) return

    const original_indices = deps.get_original_atoms_only(deps.get_selected_sites())
    if (original_indices.length === 0) return

    if (keyboard_rotation_initial_positions.size === 0) {
      let center: [number, number, number] = [0, 0, 0]
      for (const idx of original_indices) {
        const pos = structure.sites[idx].xyz
        center[0] += pos[0]; center[1] += pos[1]; center[2] += pos[2]
      }
      const count = original_indices.length
      keyboard_rotation_center = [center[0] / count, center[1] / count, center[2] / count]

      for (const idx of original_indices) {
        const pos = structure.sites[idx].xyz
        keyboard_rotation_initial_positions.set(idx, [pos[0], pos[1], pos[2]])
      }

      if (!keyboard_rotation_undo_saved) {
        deps.push_to_undo()
        keyboard_rotation_undo_saved = true
      }
    }

    if (!keyboard_rotation_center) return

    // Same fixed screen frame as the drag path: x = screen normal toward
    // viewer, y = screen right, z = screen up.
    const frame = screen_frame_from_camera(camera.quaternion)

    let rotation_axis: Vector3
    let angle = KEYBOARD_ROTATION_STEP
    // Left/Right = yaw about screen-up (z); Up/Down = pitch about screen-right
    // (y); Forward/Backward = roll about screen-normal (x).
    if (direction === 'ArrowLeft') { rotation_axis = frame.z; angle = KEYBOARD_ROTATION_STEP }
    else if (direction === 'ArrowRight') { rotation_axis = frame.z; angle = -KEYBOARD_ROTATION_STEP }
    else if (direction === 'ArrowUp') { rotation_axis = frame.y; angle = KEYBOARD_ROTATION_STEP }
    else if (direction === 'ArrowDown') { rotation_axis = frame.y; angle = -KEYBOARD_ROTATION_STEP }
    else if (direction === 'Forward') { rotation_axis = frame.x; angle = KEYBOARD_ROTATION_STEP }
    else { rotation_axis = frame.x; angle = -KEYBOARD_ROTATION_STEP }

    const rotation_quat = new Quaternion().setFromAxisAngle(rotation_axis, angle)
    const new_overrides = new Map(realtime_position_overrides)
    const center_vec = new Vector3(keyboard_rotation_center[0], keyboard_rotation_center[1], keyboard_rotation_center[2])

    for (const idx of original_indices) {
      const current_pos = realtime_position_overrides.get(idx) ?? keyboard_rotation_initial_positions.get(idx)
      if (!current_pos) continue
      const pos_vec = new Vector3(current_pos[0], current_pos[1], current_pos[2])
      pos_vec.sub(center_vec)
      pos_vec.applyQuaternion(rotation_quat)
      pos_vec.add(center_vec)
      new_overrides.set(idx, [pos_vec.x, pos_vec.y, pos_vec.z])
    }
    realtime_position_overrides = new_overrides

    if (keyboard_rotation_timeout) clearTimeout(keyboard_rotation_timeout)
    keyboard_rotation_timeout = setTimeout(() => {
      commit_keyboard_rotation_to_structure()
    }, 300)
  }

  function commit_keyboard_rotation_to_structure() {
    keyboard_rotation_initial_positions = new Map()
    keyboard_rotation_center = null
    keyboard_rotation_undo_saved = false
    apply_overrides_to_structure()
  }

  /** Shift+Alt+方向键/WS: 按相机方向移动选中原子 */
  function move_selected_atoms_keyboard(key: string, step: number) {
    const structure = deps.get_structure()
    const camera = deps.get_camera()
    if (!structure || !camera) return

    const original_indices = deps.get_original_atoms_only(deps.get_selected_sites())
    if (original_indices.length === 0) return

    const camera_right = new Vector3(1, 0, 0).applyQuaternion(camera.quaternion).normalize()
    const camera_up = new Vector3(0, 1, 0).applyQuaternion(camera.quaternion).normalize()
    const camera_forward = new Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize()

    let dir: Vector3 | null = null
    const key_lower = key.toLowerCase()
    if (key === 'ArrowLeft') dir = camera_right.clone().multiplyScalar(-step)
    else if (key === 'ArrowRight') dir = camera_right.clone().multiplyScalar(step)
    else if (key === 'ArrowUp') dir = camera_up.clone().multiplyScalar(step)
    else if (key === 'ArrowDown') dir = camera_up.clone().multiplyScalar(-step)
    else if (key_lower === 'w') dir = camera_forward.clone().multiplyScalar(step)
    else if (key_lower === 's') dir = camera_forward.clone().multiplyScalar(-step)
    if (!dir) return

    const displacement: [number, number, number] = [dir.x, dir.y, dir.z]

    if (keyboard_initial_positions.size === 0) {
      for (const idx of original_indices) {
        const pos = structure.sites[idx].xyz
        keyboard_initial_positions.set(idx, [pos[0], pos[1], pos[2]])
      }
      if (!keyboard_undo_saved) {
        deps.push_to_undo()
        keyboard_undo_saved = true
        const orbit_controls = deps.get_orbit_controls()
        if (orbit_controls?.target) {
          deps.set_cached_rotation_target([orbit_controls.target.x, orbit_controls.target.y, orbit_controls.target.z])
        } else {
          const rtr = deps.get_rotation_target_ref()
          if (rtr) deps.set_cached_rotation_target([...rtr] as [number, number, number])
        }
      }
    }

    keyboard_cumulative_displacement = [
      keyboard_cumulative_displacement[0] + displacement[0],
      keyboard_cumulative_displacement[1] + displacement[1],
      keyboard_cumulative_displacement[2] + displacement[2],
    ]

    const new_overrides = new Map(realtime_position_overrides)
    for (const idx of original_indices) {
      const initial_pos = keyboard_initial_positions.get(idx)
      if (initial_pos) {
        new_overrides.set(idx, [
          initial_pos[0] + keyboard_cumulative_displacement[0],
          initial_pos[1] + keyboard_cumulative_displacement[1],
          initial_pos[2] + keyboard_cumulative_displacement[2],
        ])
      }
    }
    realtime_position_overrides = new_overrides
    deps.set_saved_selection([...deps.get_selected_sites()])
    schedule_keyboard_undo_save()
  }

  // ═══════════════════════════════════════════════════════════════════
  // 事件处理器
  // ═══════════════════════════════════════════════════════════════════

  function onkeydown(event: KeyboardEvent) {
    if (!event.key) return
    const target = event.target as HTMLElement
    const is_input_focused = target.tagName === `INPUT` || target.tagName === `TEXTAREA`

    // Ctrl/Cmd+Z 撤销
    const is_undo_key = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !event.shiftKey
    if (is_undo_key) {
      if (deps.get_structure_history_length() > 0) {
        event.preventDefault()
        event.stopImmediatePropagation()
        deps.undo()
      } else if (deps.get_opacity_history().length > 0) {
        event.preventDefault()
        event.stopImmediatePropagation()
        const history = deps.get_opacity_history()
        const prev = history[history.length - 1]
        deps.set_atom_opacity_overrides(prev.atoms)
        deps.set_bond_opacity_overrides(prev.bonds)
        deps.set_opacity_history(history.slice(0, -1))
      } else if (deps.get_selection_history().length > 0) {
        event.preventDefault()
        event.stopImmediatePropagation()
        const history = deps.get_selection_history()
        deps.set_selected_sites(history[history.length - 1])
        deps.set_selection_history(history.slice(0, -1))
      }
      return
    }

    // Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y — redo (structure changes)
    const is_redo_key = (event.ctrlKey || event.metaKey) &&
      ((event.key.toLowerCase() === 'z' && event.shiftKey) || event.key.toLowerCase() === 'y')
    if (is_redo_key) {
      if (deps.get_redo_length() > 0) {
        event.preventDefault()
        event.stopImmediatePropagation()
        deps.redo()
      }
      return
    }

    // Ctrl/Cmd+/ 切换 AI 聊天面板
    if ((event.ctrlKey || event.metaKey) && event.key === `/`) {
      event.preventDefault()
      deps.set_chat_pane_open(!deps.get_chat_pane_open())
      return
    }

    if (is_input_focused) return

    // 阻止 Ctrl+A 全选 — 会引发虚假拖拽事件
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault()
      return
    }

    // Ctrl/Cmd+C: 复制选中原子到剪贴板
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
      const wrapper = deps.get_wrapper()
      // 跳过隐藏/inert 或非活跃 pane — 只让用户最后点击的 pane 处理
      if (wrapper?.closest(`[inert]`)) return
      if (_active_interaction_wrapper && _active_interaction_wrapper !== wrapper && document.contains(_active_interaction_wrapper)) return
      const structure = deps.get_structure()
      if (structure && deps.get_selected_sites().length > 0) {
        event.preventDefault()
        event.stopImmediatePropagation()
        flush_pending_keyboard_ops()
        const original_indices = deps.get_original_atoms_only(deps.get_selected_sites())
        if (original_indices.length > 0) {
          atom_clipboard.sites = extract_clipboard_sites(structure, original_indices)
          atom_clipboard.paste_count = 0
        }
      }
      return
    }

    // Ctrl/Cmd+V: 粘贴原子
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') {
      const wrapper = deps.get_wrapper()
      // 跳过隐藏/inert 或非活跃 pane — 只让用户最后点击的 pane 处理
      if (wrapper?.closest(`[inert]`)) return
      if (_active_interaction_wrapper && _active_interaction_wrapper !== wrapper && document.contains(_active_interaction_wrapper)) return
      if (atom_clipboard.sites) {
        event.preventDefault()
        event.stopImmediatePropagation()
        flush_pending_keyboard_ops()
        // flush 后重新获取 structure — flush 可能已更新 reactive structure
        const structure = deps.get_structure()
        if (!structure) return
        deps.push_to_undo()
        atom_clipboard.paste_count++
        const result = insert_clipboard_sites(structure, atom_clipboard.sites, atom_clipboard.paste_count)
        deps.set_structure(result.structure)
        deps.set_selected_sites(result.new_indices)
      }
      return
    }

    // 方向键: 只在有选中原子或 viewer 悬停时处理
    const is_arrow_key = [`ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight`].includes(event.key)
    if (is_arrow_key && deps.get_selected_sites().length === 0 && !deps.get_hovered()) {
      return
    }

    // 轴锁定 (X/Y/Z)
    const key_lower = event.key.toLowerCase()
    if ([`x`, `y`, `z`].includes(key_lower) && !event.repeat) {
      event.preventDefault()
      axis_lock_key = key_lower as 'x' | 'y' | 'z'
      return
    }

    // Shift+Alt+方向键/WS: 移动选中原子
    if (
      event.shiftKey && event.altKey &&
      deps.get_selected_sites().length > 0 &&
      [`ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight`, `w`, `s`].includes(event.key)
    ) {
      event.preventDefault()
      const step = get_movement_step(false, event.ctrlKey || event.metaKey, deps.get_scene_props().keyboard_movement_step)
      move_selected_atoms_keyboard(event.key, step)
      return
    }

    // Shift+方向键 (不含 Alt): 旋转选中原子
    if (
      event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey &&
      is_arrow_key && deps.get_structure() && deps.get_camera() && deps.get_selected_sites().length > 0
    ) {
      event.preventDefault()
      rotate_selected_atoms_keyboard(event.key as 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight')
      return
    }

    // Shift+WS (不含 Alt): 绕深度轴旋转
    if (
      event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey &&
      [`w`, `s`].includes(key_lower) && deps.get_structure() && deps.get_camera() && deps.get_selected_sites().length > 0
    ) {
      event.preventDefault()
      rotate_selected_atoms_keyboard(key_lower === 'w' ? 'Forward' : 'Backward')
      return
    }

    // 旧版 Ctrl+方向键也能移动原子 (向后兼容)
    if (
      (event.ctrlKey || event.metaKey) && !event.shiftKey &&
      deps.get_selected_sites().length > 0 &&
      [`ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight`, `w`, `s`].includes(event.key)
    ) {
      event.preventDefault()
      const step = get_movement_step(false, true, deps.get_scene_props().keyboard_movement_step)
      move_selected_atoms_keyboard(event.key, step)
      return
    }

    // 界面快捷键
    if (event.key === `g` && !event.ctrlKey && !event.metaKey && !is_input_focused) {
      event.preventDefault()
      const new_val = !deps.get_gesture_active()
      deps.set_gesture_active(new_val)
      deps.set_gesture_config({ ...deps.get_gesture_config(), enabled: new_val })
    }
    else if (event.key === `f` && deps.get_fullscreen_toggle()) deps.toggle_fullscreen_fn()
    else if (event.key === `i` && deps.get_enable_info_pane()) {
      // toggle_info
      if (deps.get_info_pane_open()) deps.set_info_pane_open(false)
      else { deps.set_info_pane_open(true); deps.set_controls_open(false) }
    }
    else if (event.key === `r` && !event.ctrlKey && !event.metaKey) {
      event.preventDefault()
      deps.set_scene_props_rotation([...deps.get_lattice_alignment_rotation()] as [number, number, number])
    } else if (event.key === `Escape`) {
      // 优先级: 吸附位放置 > 键选择 > 键第一原子 > 键模式 > 选区 > 铅笔 > 面板 > 全屏
      if (deps.get_adsorbate_placement_mode_active()) {
        deps.set_adsorbate_placement_mode_active(false)
      } else if (deps.get_pencil_add_mode() === 'bonds' && deps.get_bond_drag_active()) {
        deps.reset_bond_drag(true)
      } else if (deps.get_pencil_add_mode() === 'bonds' && deps.get_selected_bonds().length > 0) {
        deps.set_selected_bonds([])
      } else if (deps.get_pencil_add_mode() === 'bonds' && deps.get_bond_first_atom() !== null) {
        deps.set_bond_first_atom(null)
      } else if (deps.get_pencil_add_mode() === 'bonds') {
        deps.set_pencil_add_mode('atom')
      } else if (deps.get_selected_bonds().length > 0 || deps.get_selected_sites().length > 0) {
        deps.set_selected_bonds([])
        deps.set_selected_sites([])
        deps.set_selection_opacity(1.0)
      } else if (deps.get_pencil_mode_active()) {
        deps.set_pencil_mode_active(false)
        deps.set_pencil_drag_active(false)
        deps.set_pencil_anchor_idx(null)
        deps.set_pencil_ghost_atom(null)
      } else if (deps.get_info_pane_open()) deps.set_info_pane_open(false)
      else if (deps.get_controls_open()) deps.set_controls_open(false)
    } else if ((event.key === `Delete` || event.key === `Backspace`) && deps.get_selected_measurement_id()) {
      event.preventDefault()
      deps.delete_measurement(deps.get_selected_measurement_id()!)
    } else if ((event.key === `Delete` || event.key === `Backspace`) && (deps.get_selected_bonds().length > 0 || deps.get_selected_sites().length > 0) && deps.get_structure()) {
      event.preventDefault()
      if (deps.get_selected_bonds().length > 0) {
        const keys_to_delete = deps.get_selected_bonds().map(b => b.key)
        const new_bond_overrides = new Map(deps.get_bond_opacity_overrides())
        for (const k of keys_to_delete) new_bond_overrides.delete(k)
        deps.set_bond_opacity_overrides(new_bond_overrides)
        deps.delete_selected_bonds()
      }
      if (deps.get_selected_sites().length > 0) {
        const original_indices = deps.get_original_atoms_only(deps.get_selected_sites())
        if (original_indices.length > 0) {
          const structure = deps.get_structure()!
          // Sort ascending so reinsertion on undo iterates in index order
          // (earlier inserts correctly shift later target indices).
          const sorted_indices = [...original_indices].sort((a, b) => a - b)
          // Capture Site objects + orphaned opacity overrides BEFORE mutating.
          const removed_sites = sorted_indices.map((idx) => structure.sites[idx])
          const prev_overrides = deps.get_atom_opacity_overrides()
          const removed_atom_opacity_entries: Array<[number, number]> = []
          for (const idx of sorted_indices) {
            const v = prev_overrides.get(idx)
            if (v !== undefined) removed_atom_opacity_entries.push([idx, v])
          }
          // Push sparse atom-kind undo entry (replaces the O(N) snapshot).
          deps.push_atom_entry({
            removed_sites,
            removed_indices: sorted_indices,
            removed_atom_opacity_entries,
          })
          // Prune orphaned opacity overrides for the atoms being removed.
          if (removed_atom_opacity_entries.length > 0) {
            const new_atom_overrides = new Map(prev_overrides)
            for (const idx of sorted_indices) new_atom_overrides.delete(idx)
            deps.set_atom_opacity_overrides(new_atom_overrides)
          }
          // Reindex index-keyed edit state with the OLD-index deleted list.
          deps.reindex_edits_after_delete(sorted_indices)
          deps.set_structure(delete_atoms(structure, sorted_indices))
          deps.get_on_atoms_deleted()?.({ site_indices: sorted_indices })
          deps.set_selected_sites([])
          deps.set_measured_sites([])
        }
      }
      deps.set_selection_opacity(1.0)
    }
  }

  function onkeyup(event: KeyboardEvent) {
    if (!event.key) return
    const key_lower = event.key.toLowerCase()
    if ([`x`, `y`, `z`].includes(key_lower)) {
      axis_lock_key = null
      is_rotating = false
    }

    if (is_dragging_atom && (key_lower === `shift` || key_lower === `alt` || key_lower === `meta`)) {
      finish_drag()
    }

    if (is_rotating_atoms && (key_lower === `shift` || key_lower === `meta`)) {
      finish_rotation()
    }
  }

  function handlePointerUpCapture(event: PointerEvent) {
    // 裁剪区域完成
    if (crop_drawing && crop_draw_start && crop_draw_end) {
      event.stopPropagation()
      event.preventDefault()
      const x = Math.min(crop_draw_start.x, crop_draw_end.x)
      const y = Math.min(crop_draw_start.y, crop_draw_end.y)
      const width = Math.abs(crop_draw_end.x - crop_draw_start.x)
      const height = Math.abs(crop_draw_end.y - crop_draw_start.y)
      crop_drawing = false
      crop_draw_start = null
      crop_draw_end = null
      if (width > 10 && height > 10) {
        crop_region = { x, y, width, height }
      }
      return
    }

    if (is_rotating_atoms) finish_rotation()
  }

  function handleShiftClickCapture(event: PointerEvent) {
    const wrapper = deps.get_wrapper()

    // 裁剪模式
    if (crop_mode_active && event.button === 0 && wrapper) {
      event.stopPropagation()
      event.preventDefault()
      const canvas_el = get_main_canvas(wrapper)
      const rect = canvas_el?.getBoundingClientRect() ?? wrapper.getBoundingClientRect()
      crop_drawing = true
      crop_draw_start = { x: event.clientX - rect.left, y: event.clientY - rect.top }
      crop_draw_end = { ...crop_draw_start }
      return
    }

    // 框选 (Cmd/Ctrl+click) — skip if click is inside terminal/editor side panels
    const target_el = event.target as HTMLElement
    if (target_el?.closest(`.terminal-panel`) || target_el?.closest(`.xterm`) || target_el?.closest(`.monaco-editor`) || target_el?.closest(`.file-preview-panel`)) {
      return
    }
    if (is_box_select_modifier(event) && !event.shiftKey && event.button === 0 && wrapper) {
      event.stopPropagation()
      event.preventDefault()
      const canvas_el = get_main_canvas(wrapper)
      const rect = canvas_el?.getBoundingClientRect() ?? wrapper.getBoundingClientRect()
      is_box_selecting = true
      box_select_start = { x: event.clientX - rect.left, y: event.clientY - rect.top }
      box_select_end = { ...box_select_start }
      return
    }

    // Shift+click 开始原子旋转 (capture phase，在 TrackballControls 前拦截)
    // 左键 = pitch/yaw, 右键 = roll
    if (event.shiftKey && !event.altKey && deps.get_selected_sites().length >= 1 && (event.button === 0 || event.button === 2) && deps.get_structure()) {
      const started = start_atom_rotation(event, true)
      if (started) {
        if (event.button === 2) {
          atom_rotation_used_right = true
          atom_rotation_locked_axis = 'x' // roll = rotate about screen normal
        }
        event.stopPropagation()
        event.preventDefault()
      }
      return
    }
  }

  function onmousedown(event: MouseEvent) {
    // 框选 fallback (capture handler 已处理大部分情况)
    // Skip if click is inside terminal/editor side panels
    const mousedown_target = event.target as HTMLElement
    if (mousedown_target?.closest(`.terminal-panel`) || mousedown_target?.closest(`.xterm`) || mousedown_target?.closest(`.monaco-editor`) || mousedown_target?.closest(`.file-preview-panel`)) {
      return
    }
    if (is_box_select_modifier(event) && !event.shiftKey && event.button === 0 && deps.get_wrapper()) {
      const wrapper = deps.get_wrapper()!
      const canvas_el = get_main_canvas(wrapper)
      const rect = canvas_el?.getBoundingClientRect() ?? wrapper.getBoundingClientRect()
      is_box_selecting = true
      box_select_start = { x: event.clientX - rect.left, y: event.clientY - rect.top }
      box_select_end = { ...box_select_start }
      event.preventDefault()
      event.stopPropagation()
      return
    }

    // 原子旋转 fallback
    // 左键 = pitch/yaw, 右键 = roll
    if (event.shiftKey && !event.altKey && deps.get_selected_sites().length >= 1 && (event.button === 0 || event.button === 2) && deps.get_structure() && deps.get_camera()) {
      const started = start_atom_rotation(event, !is_rotating_atoms)
      if (started) {
        if (event.button === 2) {
          atom_rotation_used_right = true
          atom_rotation_locked_axis = 'x' // roll = rotate about screen normal
        }
        event.preventDefault()
        event.stopPropagation()
      }
      return
    }

    // 轴锁定旋转开始
    if (axis_lock_key && event.button === 0) {
      is_rotating = true
      rotation_start_x = event.clientX
      rotation_start_y = event.clientY
      rotation_start_values = [...(deps.get_scene_props().rotation || [0, 0, 0])] as [number, number, number]
      event.preventDefault()
    }
  }

  function onmousemove(event: MouseEvent) {
    // 框选更新
    if (is_box_selecting && box_select_start && deps.get_wrapper()) {
      event.preventDefault()
      const wrapper = deps.get_wrapper()!
      const canvas_el = get_main_canvas(wrapper)
      const rect = canvas_el?.getBoundingClientRect() ?? wrapper.getBoundingClientRect()
      box_select_end = { x: event.clientX - rect.left, y: event.clientY - rect.top }
      return
    }

    // 轴锁定旋转
    if (!is_rotating || !axis_lock_key) return

    const delta_x = event.clientX - rotation_start_x
    const delta_y = event.clientY - rotation_start_y
    const sensitivity = 0.01
    const delta = Math.abs(delta_x) > Math.abs(delta_y) ? delta_x : -delta_y
    const rotation_delta = delta * sensitivity

    const axis_index = { x: 0, y: 1, z: 2 }[axis_lock_key]
    const new_rotation: [number, number, number] = [...rotation_start_values] as [number, number, number]
    new_rotation[axis_index] = rotation_start_values[axis_index] + rotation_delta
    deps.set_scene_props_rotation(new_rotation)
  }

  function onmouseup() {
    // 框选结束
    if (is_box_selecting && box_select_start && box_select_end && deps.get_structure()) {
      const structure = deps.get_structure()!
      const atoms_in_box: number[] = []
      for (let idx = 0; idx < structure.sites.length; idx++) {
        const site = structure.sites[idx]
        const screen_pos = project_to_screen(site.xyz as [number, number, number])
        if (screen_pos && is_in_rect(screen_pos, box_select_start!, box_select_end!)) {
          atoms_in_box.push(idx)
        }
      }

      const new_selection = [...deps.get_selected_sites()]
      for (const idx of atoms_in_box) {
        if (!new_selection.includes(idx)) new_selection.push(idx)
      }
      deps.set_selected_sites(new_selection)

      // 选中框内的键
      const existing_bond_keys = new Set(deps.get_selected_bonds().map(b => b.key))
      const new_bonds = [...deps.get_selected_bonds()]
      for (const bond of deps.get_scene_bond_pairs()) {
        const midpoint: [number, number, number] = [
          (bond.pos_1[0] + bond.pos_2[0]) / 2,
          (bond.pos_1[1] + bond.pos_2[1]) / 2,
          (bond.pos_1[2] + bond.pos_2[2]) / 2,
        ]
        const screen_pos = project_to_screen(midpoint)
        if (screen_pos && is_in_rect(screen_pos, box_select_start!, box_select_end!)) {
          const key = get_bond_key(bond.site_idx_1, bond.site_idx_2)
          if (!existing_bond_keys.has(key)) {
            existing_bond_keys.add(key)
            new_bonds.push({ type: 'auto', site_idx_1: bond.site_idx_1, site_idx_2: bond.site_idx_2, key })
          }
        }
      }
      deps.set_selected_bonds(new_bonds)

      // Stamp the commit so the WebGPU overlay's async empty-space clear (which
      // can fire for this same pointerup on a small/dense box) is suppressed by
      // the parent. Stamp even when the box caught nothing — a Cmd/Ctrl+drag that
      // selected zero atoms must still NOT be reinterpreted as a clear-all click.
      last_box_select_commit_ms = (typeof performance !== `undefined` ? performance.now() : Date.now())

      is_box_selecting = false
      box_select_start = null
      box_select_end = null
    } else if (is_box_selecting) {
      is_box_selecting = false
      box_select_start = null
      box_select_end = null
    }

    if (is_dragging_atom) finish_drag()
    if (is_rotating_atoms) finish_rotation()
    if (is_rotating) is_rotating = false
  }

  function onpointermove(event: PointerEvent) {
    // 裁剪预览更新
    if (crop_drawing && crop_draw_start && deps.get_wrapper()) {
      const rect = deps.get_wrapper()!.getBoundingClientRect()
      crop_draw_end = {
        x: Math.max(0, Math.min(event.clientX - rect.left, rect.width)),
        y: Math.max(0, Math.min(event.clientY - rect.top, rect.height)),
      }
      return
    }

    // 自动开始拖拽: Shift+Alt 按住时有选中原子即开始
    if (!is_dragging_atom && event.shiftKey && event.altKey && deps.get_selected_sites().length >= 1 && deps.get_structure() && deps.get_camera()) {
      const original_indices = deps.get_original_atoms_only(deps.get_selected_sites())
      if (original_indices.length > 0) {
        const structure = deps.get_structure()!
        const camera = deps.get_camera()
        const orbit_controls = deps.get_orbit_controls()
        if (orbit_controls) orbit_controls.enabled = false

        deps.push_to_undo()
        is_dragging_atom = true
        dragged_atom_indices = original_indices

        drag_initial_atom_positions = new Map()
        for (const idx of dragged_atom_indices) {
          const pos = structure.sites[idx].xyz
          drag_initial_atom_positions.set(idx, [pos[0], pos[1], pos[2]])
        }

        const local_reference = structure.sites[dragged_atom_indices[0]].xyz
        const world_reference = local_to_world([local_reference[0], local_reference[1], local_reference[2]])
        drag_plane_reference = world_reference

        drag_camera_quaternion = camera.quaternion.clone()
        drag_camera_snapshot = camera.clone()
        drag_camera_snapshot.matrixWorld.copy(camera.matrixWorld)
        drag_camera_snapshot.matrixWorldInverse.copy(camera.matrixWorldInverse)
        drag_camera_snapshot.projectionMatrix.copy(camera.projectionMatrix)
        drag_camera_snapshot.projectionMatrixInverse.copy(camera.projectionMatrixInverse)

        drag_start_mouse_position = get_3d_position_from_click(event, drag_plane_reference, drag_camera_quaternion, drag_camera_snapshot)

        if (orbit_controls?.target) {
          deps.set_cached_rotation_target([orbit_controls.target.x, orbit_controls.target.y, orbit_controls.target.z])
        } else {
          const rtr = deps.get_rotation_target_ref()
          if (rtr) deps.set_cached_rotation_target([...rtr] as [number, number, number])
        }
        return
      }
    }

    // 拖拽中
    if (is_dragging_atom && dragged_atom_indices.length > 0 && deps.get_structure() && drag_start_mouse_position && drag_plane_reference && drag_camera_quaternion) {
      if (!event.shiftKey || !event.altKey) {
        finish_drag()
        return
      }

      const current_mouse_position = get_3d_position_from_click(event, drag_plane_reference, drag_camera_quaternion, drag_camera_snapshot)

      if (current_mouse_position) {
        let world_displacement: [number, number, number] = [
          current_mouse_position[0] - drag_start_mouse_position[0],
          current_mouse_position[1] - drag_start_mouse_position[1],
          current_mouse_position[2] - drag_start_mouse_position[2],
        ]

        const rot = deps.get_scene_props().rotation || [0, 0, 0]
        let local_displacement = world_displacement
        if (rot[0] !== 0 || rot[1] !== 0 || rot[2] !== 0) {
          const euler = new Euler(rot[0], rot[1], rot[2], 'XYZ')
          const quat = new Quaternion().setFromEuler(euler)
          quat.invert()
          const disp_vec = new Vector3(world_displacement[0], world_displacement[1], world_displacement[2])
          disp_vec.applyQuaternion(quat)
          local_displacement = [disp_vec.x, disp_vec.y, disp_vec.z]
        }

        for (const idx of dragged_atom_indices) {
          const initial_pos = drag_initial_atom_positions.get(idx)
          if (initial_pos) {
            pending_drag_positions.set(idx, [
              initial_pos[0] + local_displacement[0],
              initial_pos[1] + local_displacement[1],
              initial_pos[2] + local_displacement[2],
            ])
          }
        }

        if (!pending_drag_update && pending_drag_positions.size > 0) {
          pending_drag_update = true
          pending_drag_raf_id = requestAnimationFrame(apply_pending_drag)
        }
      }
      return
    }

    // 原子旋转中 — 固定屏幕坐标系，单轴锁定
    if (is_rotating_atoms && atom_rotation_center && deps.get_structure()) {
      if (!event.shiftKey || event.altKey) {
        finish_rotation()
        return
      }

      // Total displacement from the fixed mousedown anchor (not per-frame).
      const total_dx = event.clientX - atom_rotation_start_x
      const total_dy = event.clientY - atom_rotation_start_y

      // Lock the axis once for left-drag (roll already locked to 'x').
      if (atom_rotation_locked_axis === null) {
        atom_rotation_locked_axis = pick_locked_axis(total_dx, total_dy, AXIS_LOCK_DEADZONE_PX)
        if (atom_rotation_locked_axis === null) return // still inside dead zone
      }
      const axis = atom_rotation_locked_axis

      const sensitivity = 0.01
      const cam_quat = atom_rotation_camera_quat
        || (deps.get_camera() ? deps.get_camera().quaternion : new Quaternion())
      const frame = screen_frame_from_camera(cam_quat)
      const axis_vec = frame[axis]

      const angle = drag_delta_for_axis(axis, total_dx, total_dy) * sensitivity

      // Visual feedback.
      atom_rotation_axis = [axis_vec.x, axis_vec.y, axis_vec.z]
      atom_rotation_angle_deg = Math.abs(angle) * 180 / Math.PI

      // Recompute every frame from the stored initial positions — idempotent,
      // no incremental quaternion product.
      const indices = [...atom_rotation_initial_positions.keys()]
      const initial = indices.map((idx) => atom_rotation_initial_positions.get(idx)!)
      const rotated = rotate_points(initial, atom_rotation_center, axis_vec, angle)
      for (let i = 0; i < indices.length; i++) {
        pending_rotation_positions.set(indices[i], rotated[i])
      }

      if (!pending_rotation_update && pending_rotation_positions.size > 0) {
        pending_rotation_update = true
        pending_rotation_raf_id = requestAnimationFrame(apply_pending_rotation)
      }
    }
  }

  /** 右键菜单触发 */
  function oncontextmenu(event: MouseEvent) {
    if (is_rotating || axis_lock_key) return
    if (atom_rotation_used_right) {
      event.preventDefault()
      atom_rotation_used_right = false
      return
    }

    event.preventDefault()
    event.stopPropagation()
    deps.set_context_menu_position({ x: event.clientX, y: event.clientY })

    const clicked_3d_position = get_3d_position_from_click(event)
    if (clicked_3d_position) {
      deps.set_context_menu_3d_position(clicked_3d_position)
    } else {
      const structure = deps.get_structure()
      if (structure && structure.sites.length > 0) {
        const center = get_center_of_mass(structure)
        deps.set_context_menu_3d_position([center[0], center[1], center[2] + 2])
      } else {
        deps.set_context_menu_3d_position([0, 0, 0])
      }
    }
    deps.set_context_menu_target_site(null)
    deps.set_context_menu_visible(true)
  }

  /** StructureScene 中右键点击原子时的 handler */
  function on_atom_context_menu(
    site_idx: number,
    position: [number, number, number],
    event: MouseEvent,
  ) {
    event.preventDefault()
    event.stopPropagation()
    deps.set_context_menu_position({ x: event.clientX, y: event.clientY })
    deps.set_context_menu_target_site(site_idx)
    deps.set_context_menu_3d_position(position)
    deps.set_context_menu_visible(true)
  }

  // ═══════════════════════════════════════════════════════════════════
  // 全局事件监听器注册 (通过 $effect 管理生命周期)
  // ═══════════════════════════════════════════════════════════════════

  /**
   * 设置全局事件监听器 — 必须在 Structure.svelte 的 $effect 中调用
   * 返回 cleanup 函数用于 $effect 的 return
   */
  function setup_global_listeners(): () => void {
    // 全局 mouseup/blur/visibility 重置拖拽状态
    function reset_drag_state() {
      if (deps.get_pencil_drag_active()) deps.complete_pencil_drag()
      if (is_dragging_atom) finish_drag()
      if (is_rotating_atoms) finish_rotation()
      if (is_box_selecting) {
        is_box_selecting = false
        box_select_start = null
        box_select_end = null
      }
      if (is_rotating) is_rotating = false
    }

    function on_visibility_change() {
      if (document.hidden) reset_drag_state()
    }

    window.addEventListener('mouseup', reset_drag_state)
    window.addEventListener('blur', reset_drag_state)
    document.addEventListener('visibilitychange', on_visibility_change)

    // 追踪用户最后点击的 wrapper — 用于 Ctrl+C/V 路由到正确的 pane
    function on_pointerdown_track(event: PointerEvent) {
      const wrapper = deps.get_wrapper()
      if (wrapper?.contains(event.target as Node)) {
        _active_interaction_wrapper = wrapper
      }
    }

    // 注册 document-level 事件 (支持多 Structure 实例共存)
    document.addEventListener('pointerdown', on_pointerdown_track, true)
    document.addEventListener('keydown', onkeydown)
    document.addEventListener('keyup', onkeyup)
    document.addEventListener('mousemove', onmousemove)
    document.addEventListener('mouseup', onmouseup)
    document.addEventListener('pointermove', onpointermove)

    return () => {
      window.removeEventListener('mouseup', reset_drag_state)
      window.removeEventListener('blur', reset_drag_state)
      document.removeEventListener('visibilitychange', on_visibility_change)
      document.removeEventListener('pointerdown', on_pointerdown_track, true)
      document.removeEventListener('keydown', onkeydown)
      document.removeEventListener('keyup', onkeyup)
      document.removeEventListener('mousemove', onmousemove)
      document.removeEventListener('mouseup', onmouseup)
      document.removeEventListener('pointermove', onpointermove)
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // 公开接口
  // ═══════════════════════════════════════════════════════════════════

  return {
    // ── 状态 getters (外部只读) ──
    get is_dragging_atom() { return is_dragging_atom },
    get is_rotating_atoms() { return is_rotating_atoms },
    get is_box_selecting() { return is_box_selecting },
    get box_select_start() { return box_select_start },
    get box_select_end() { return box_select_end },
    get last_box_select_commit_ms() { return last_box_select_commit_ms },
    get crop_mode_active() { return crop_mode_active },
    set crop_mode_active(v: boolean) { crop_mode_active = v },
    get crop_region() { return crop_region },
    set crop_region(v: CropRegion | null) { crop_region = v },
    get crop_drawing() { return crop_drawing },
    get crop_draw_start() { return crop_draw_start },
    get crop_draw_end() { return crop_draw_end },
    get axis_lock_key() { return axis_lock_key },
    get realtime_position_overrides() { return realtime_position_overrides },
    get atom_rotation_used_right() { return atom_rotation_used_right },
    set atom_rotation_used_right(v: boolean) { atom_rotation_used_right = v },
    get atom_rotation_center() { return atom_rotation_center },
    get atom_rotation_axis() { return atom_rotation_axis },
    get atom_rotation_angle_deg() { return atom_rotation_angle_deg },

    // ── 事件处理器 (绑定到 template) ──
    handleShiftClickCapture,
    handlePointerUpCapture,
    oncontextmenu,
    on_atom_context_menu,

    // ── 全局事件注册 ──
    setup_global_listeners,

    // ── 坐标工具 (供其他模块使用) ──
    local_to_world,
    project_to_screen,
    is_in_rect,
    get_3d_position_from_click,

    // ── 操作方法 ──
    finish_drag,
    finish_rotation,
    /** 清除 realtime overrides (结构变化时调用，防止过期索引导致原子跳位) */
    clear_realtime_overrides() { realtime_position_overrides = new Map() },
  }
}

/** create_interaction_controller 的返回类型 */
export type InteractionController = ReturnType<typeof create_interaction_controller>

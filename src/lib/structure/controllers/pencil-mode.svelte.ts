/**
 * 铅笔/键编辑模式控制器
 *
 * 管理铅笔画原子/片段和键编辑的所有状态与交互:
 * - 铅笔模式: 点击原子→拖拽→放置新原子/分子片段 (atom/fragment 子模式)
 * - 键编辑: click-click 和 drag-to-connect 两种创建键方式
 * - ghost atom/bond 预览: 拖拽过程中显示半透明预览
 * - bond 增删改: manual_bonds + deleted_bond_keys 持久化存储
 * - undo 集成: push_bond_undo / pop_bond_undo 与结构 undo 栈并行
 *
 * 使用 .svelte.ts 后缀因为内部用 $state 管理 reactive 状态
 *
 * UX 改进:
 * - create_bond_between() 统一了 click-click 和 drag-to-connect 中重复的键创建逻辑
 */

import type { AnyStructure, ElementSymbol, Vec3 } from '$lib'
import type { ManualBond, SelectedBond, BondPair } from '../index'
import type { MolecularFragment } from './fragments'
import { add_atom, add_atoms, get_default_bond_length } from '../atom-manipulation'
import { get_bond_key } from '../bonding'
import { Euler, Quaternion, Vector3 } from 'three'
import type { PerspectiveCamera } from 'three'
import { BondManager } from '../bonding/bond-manager.svelte'
import { BondUndoStack } from '../bonding/bond-undo-stack'
import type { BondArrayInverse } from '../state/selection-state.svelte'
import type { AtomAddSpec, AtomFastOps } from '../atoms/atom-manager.svelte'

// ─── 类型 ───

/** 铅笔模式子模式 */
export type PencilAddMode = 'atom' | 'fragment' | 'bonds'

/** 工厂函数的依赖接口 — 通过 getter/setter 闭包访问组件状态 */
export interface PencilModeDeps {
  // ── 核心结构数据 ──
  get_structure: () => AnyStructure | undefined
  set_structure: (s: AnyStructure) => void
  get_displayed_structure: () => AnyStructure | undefined
  /** Push a 'structure' undo entry (full structure snapshot + bond-array snapshot). Used by atom/lattice edits. */
  push_to_undo: () => void
  /**
   * Push a 'bond' undo entry for a bond-array mutation. The manager-side
   * rollback is recorded separately on the internal `BondUndoStack` and
   * replayed by the global `undo()` dispatcher.
   */
  push_bond_entry: (array_inverse: BondArrayInverse) => void

  // ── 3D 场景 ──
  get_camera: () => PerspectiveCamera | undefined
  get_wrapper: () => HTMLElement | undefined
  get_orbit_controls: () => any
  get_scene_props: () => { rotation?: [number, number, number] }
  get_rotation_target_ref: () => Vec3

  // ── 交互控制器 (坐标变换) ──
  /** local → world 空间变换 (来自 interaction controller) */
  local_to_world: (pos: Vec3) => Vec3
  /** 从鼠标位置获取 3D 坐标 (来自 interaction controller) */
  get_3d_position_from_click: (
    event: MouseEvent,
    anchor?: [number, number, number],
    camera_quat?: Quaternion | null,
    camera_snapshot?: any,
  ) => Vec3 | null

  // ── 元素 & 片段 ──
  get_selected_add_element: () => ElementSymbol
  get_selected_fragment: () => MolecularFragment

  // ── 回调 props ──
  get_on_atom_added: () => ((event: { element: ElementSymbol; position: Vec3 }) => void) | undefined

  // ── Phase X6 fast-path hook (null until StructureScene's $effect
  //    populates it; also null when USE_NEW_ATOM_SYSTEM is off). Optional. ──
  get_atom_fast_ops?: () => AtomFastOps | null
}

// ─── 常量 ───

/** 最小拖拽像素距离 — 低于此阈值视为点击而非拖拽 */
const PENCIL_MIN_DRAG_DISTANCE = 10

/** bond undo 栈最大深度 */
const MAX_UNDO_HISTORY = 50

// ─── 工厂函数 ───

/**
 * 创建铅笔/键编辑控制器 — 管理画原子/片段/键的所有交互和状态
 *
 * 使用方式:
 * ```ts
 * const pencil = create_pencil_mode_controller({
 *   get_structure: () => structure,
 *   set_structure: (s) => { structure = s },
 *   push_to_undo: () => push_to_undo(), // 会调 pencil.push_bond_undo()
 *   local_to_world: (pos) => interaction.local_to_world(pos),
 *   get_3d_position_from_click: (...args) => interaction.get_3d_position_from_click(...args),
 *   // ...
 * })
 * // 模板: on_pencil_atom_click={pencil.handle_pencil_atom_click}
 * //        on_bond_atom_click={pencil.handle_bond_atom_click}
 * ```
 */
export function create_pencil_mode_controller(deps: PencilModeDeps) {

  // ═══ 铅笔模式状态 ═══

  let pencil_mode_active = $state(false)
  let pencil_drag_active = $state(false)
  let pencil_anchor_idx = $state<number | null>(null)
  let pencil_bond_length = $state<number>(1.5)
  let pencil_did_drag = $state(false)
  let pencil_drag_start_screen = $state<{ x: number; y: number } | null>(null)
  let pencil_just_completed = $state(false)
  let pencil_ghost_atom = $state<{
    element: ElementSymbol
    position: Vec3
    visible: boolean
    anchor_position: Vec3 | null
    anchor_idx: number | null
  } | null>(null)
  let pencil_add_mode = $state<PencilAddMode>('atom')

  // ═══ 键编辑状态 ═══

  let manual_bonds: ManualBond[] = $state([])
  let deleted_bond_keys: Set<string> = $state(new Set())
  let selected_bonds: SelectedBond[] = $state([])
  let bond_first_atom: number | null = $state(null)
  let bond_drag_active = $state(false)
  let bond_ghost_end: Vec3 | null = $state(null)
  let bond_drag_start_screen: { x: number; y: number } | null = $state(null)
  let bond_did_drag = $state(false)
  let bond_just_completed = $state(false)
  let scene_bond_pairs: BondPair[] = $state([])
  let bond_edit_history: { manual_bonds: ManualBond[]; deleted_bond_keys: Set<string> }[] = $state([])

  // ═══ 新 SoA 键存储 (Phase 1: 仅实例化, 暂无消费者) ═══

  const bond_manager = new BondManager()
  const bond_undo = new BondUndoStack(bond_manager)

  // ═══ 相机快照 (铅笔 + 键拖拽共享) ═══

  let drag_camera_quaternion = $state<Quaternion | null>(null)
  let drag_camera_snapshot = $state<any>(null)

  // ═══ 坐标变换工具 ═══

  /**
   * world → local 空间变换 (local_to_world 的逆操作)
   * 用于将 raycast 得到的世界坐标转换回结构的局部坐标
   */
  function world_to_local(world_pos: Vec3): Vec3 {
    const rot = deps.get_scene_props().rotation
    if (!rot || (rot[0] === 0 && rot[1] === 0 && rot[2] === 0)) return world_pos
    const target = deps.get_rotation_target_ref() ?? [0, 0, 0] as Vec3
    const euler = new Euler(rot[0], rot[1], rot[2], `XYZ`)
    const quat = new Quaternion().setFromEuler(euler).invert()
    const offset = new Vector3(
      world_pos[0] - target[0], world_pos[1] - target[1], world_pos[2] - target[2],
    )
    offset.applyQuaternion(quat)
    return [target[0] + offset.x, target[1] + offset.y, target[2] + offset.z]
  }

  // ═══ 铅笔模式: document-level 监听器 ═══

  function handle_pencil_window_move(event: PointerEvent) {
    update_pencil_ghost_position(event)
  }

  function handle_pencil_window_up(_event: PointerEvent) {
    complete_pencil_drag()
  }

  function add_pencil_window_listeners() {
    document.addEventListener('pointermove', handle_pencil_window_move)
    document.addEventListener('pointerup', handle_pencil_window_up)
  }

  function remove_pencil_window_listeners() {
    document.removeEventListener('pointermove', handle_pencil_window_move)
    document.removeEventListener('pointerup', handle_pencil_window_up)
  }

  // ═══ 铅笔模式: 点击原子开始拖拽 ═══

  function handle_pencil_atom_click(
    site_idx: number,
    position: Vec3,
    event: PointerEvent,
  ) {
    const structure = deps.get_structure()
    if (!pencil_mode_active || !structure || pencil_drag_active || pencil_just_completed) return

    pencil_drag_active = true
    pencil_did_drag = false
    pencil_anchor_idx = site_idx

    // 根据模式计算默认键长
    const anchor_site = structure.sites[site_idx]
    const anchor_element = anchor_site?.species[0]?.element ?? `C`

    let default_bond_length: number
    if (pencil_add_mode === 'fragment') {
      default_bond_length = deps.get_selected_fragment().bond_length
    } else {
      default_bond_length = get_default_bond_length(
        anchor_element as ElementSymbol,
        deps.get_selected_add_element(),
      )
    }
    pencil_bond_length = default_bond_length

    // 从点击位置确定放置方向
    let placement_dir: Vec3 = [0, 0, 1]
    let got_click_dir = false
    const camera = deps.get_camera()
    const wrapper = deps.get_wrapper()

    if (camera && wrapper) {
      const anchor_world = deps.local_to_world(position)
      const click_world = deps.get_3d_position_from_click(
        event, anchor_world as [number, number, number],
      )
      if (click_world) {
        const click_local = world_to_local(click_world as Vec3)
        const dx = click_local[0] - position[0]
        const dy = click_local[1] - position[1]
        const dz = click_local[2] - position[2]
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
        if (dist > 0.01) {
          placement_dir = [dx / dist, dy / dist, dz / dist]
          got_click_dir = true
        }
      }
    }

    // Fallback: 远离邻居方向 或 相机右方向
    if (!got_click_dir) {
      const neighbor_threshold = 3.0
      const neighbors: Vec3[] = []
      for (let i = 0; i < structure.sites.length; i++) {
        if (i === site_idx) continue
        const other_pos = structure.sites[i].xyz
        const dx = other_pos[0] - position[0]
        const dy = other_pos[1] - position[1]
        const dz = other_pos[2] - position[2]
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
        if (dist < neighbor_threshold && dist > 0.1) {
          neighbors.push([dx / dist, dy / dist, dz / dist])
        }
      }
      if (neighbors.length > 0) {
        let avg_x = 0, avg_y = 0, avg_z = 0
        for (const n of neighbors) {
          avg_x += n[0]; avg_y += n[1]; avg_z += n[2]
        }
        avg_x /= neighbors.length; avg_y /= neighbors.length; avg_z /= neighbors.length
        const away_len = Math.sqrt(avg_x * avg_x + avg_y * avg_y + avg_z * avg_z)
        if (away_len > 0.001) {
          placement_dir = [-avg_x / away_len, -avg_y / away_len, -avg_z / away_len]
        }
      } else if (camera) {
        const cam_right = new Vector3(1, 0, 0).applyQuaternion(camera.quaternion)
        const rot = deps.get_scene_props().rotation
        if (rot && (rot[0] !== 0 || rot[1] !== 0 || rot[2] !== 0)) {
          const euler = new Euler(rot[0], rot[1], rot[2], `XYZ`)
          const inv_quat = new Quaternion().setFromEuler(euler).invert()
          cam_right.applyQuaternion(inv_quat)
        }
        placement_dir = [cam_right.x, cam_right.y, cam_right.z]
      }
    }

    // Ghost atom 初始位置
    const initial_ghost_pos: Vec3 = [
      position[0] + placement_dir[0] * default_bond_length,
      position[1] + placement_dir[1] * default_bond_length,
      position[2] + placement_dir[2] * default_bond_length,
    ]

    const ghost_element = pencil_add_mode === 'fragment'
      ? deps.get_selected_fragment().sites[deps.get_selected_fragment().connect_idx].element
      : deps.get_selected_add_element()

    pencil_ghost_atom = {
      element: ghost_element,
      position: initial_ghost_pos,
      visible: false,
      anchor_position: position,
      anchor_idx: site_idx,
    }

    // 禁用轨道控制
    const orbit_controls = deps.get_orbit_controls()
    if (orbit_controls) orbit_controls.enabled = false

    drag_camera_quaternion = deps.get_camera()?.quaternion?.clone() ?? null
    pencil_drag_start_screen = { x: event.clientX, y: event.clientY }
    add_pencil_window_listeners()
  }

  // ═══ 铅笔模式: 拖拽过程更新 ghost atom 位置 ═══

  function update_pencil_ghost_position(event: MouseEvent) {
    if (!pencil_drag_active || !pencil_ghost_atom || !pencil_ghost_atom.anchor_position) return

    // 最小拖拽距离检查
    if (!pencil_did_drag && pencil_drag_start_screen) {
      const dx = event.clientX - pencil_drag_start_screen.x
      const dy = event.clientY - pencil_drag_start_screen.y
      if (Math.sqrt(dx * dx + dy * dy) < PENCIL_MIN_DRAG_DISTANCE) return
      pencil_did_drag = true
    }

    const anchor_pos = pencil_ghost_atom.anchor_position
    const anchor_world = deps.local_to_world(anchor_pos)

    const clicked_3d_position = deps.get_3d_position_from_click(event, anchor_world, drag_camera_quaternion)
    if (!clicked_3d_position) return

    const clicked_local = world_to_local(clicked_3d_position)

    // 计算从锚点到鼠标位置的方向
    const dir: Vec3 = [
      clicked_local[0] - anchor_pos[0],
      clicked_local[1] - anchor_pos[1],
      clicked_local[2] - anchor_pos[2],
    ]
    const distance = Math.sqrt(dir[0] ** 2 + dir[1] ** 2 + dir[2] ** 2)
    if (distance < 0.01) return

    const norm_dir: Vec3 = [dir[0] / distance, dir[1] / distance, dir[2] / distance]

    // 按数据库键长放置 ghost（而非鼠标距离）
    const ghost_pos: Vec3 = [
      anchor_pos[0] + norm_dir[0] * pencil_bond_length,
      anchor_pos[1] + norm_dir[1] * pencil_bond_length,
      anchor_pos[2] + norm_dir[2] * pencil_bond_length,
    ]

    pencil_ghost_atom = {
      ...pencil_ghost_atom,
      position: ghost_pos,
      visible: true,
    }
  }

  // ═══ 铅笔模式: 完成拖拽 → 放置原子/片段 ═══

  function complete_pencil_drag() {
    const structure = deps.get_structure()
    if (!pencil_drag_active || !pencil_ghost_atom || !structure) {
      reset_pencil_drag()
      return
    }

    deps.push_to_undo()

    if (pencil_add_mode === 'atom') {
      const next_structure = add_atom(
        structure,
        pencil_ghost_atom.element,
        pencil_ghost_atom.position,
      )
      // Phase X6: fast path BEFORE set_structure. Order load-bearing.
      const new_site_id = next_structure.sites.length - 1
      const spec: AtomAddSpec = {
        site_id: new_site_id,
        position: [
          pencil_ghost_atom.position[0],
          pencil_ghost_atom.position[1],
          pencil_ghost_atom.position[2],
        ] as const,
        element: pencil_ghost_atom.element,
      }
      deps.get_atom_fast_ops?.()?.try_add([spec], next_structure.sites)
      deps.set_structure(next_structure)
      deps.get_on_atom_added()?.({ element: pencil_ghost_atom.element, position: pencil_ghost_atom.position })
    } else {
      // 放置分子片段
      const anchor_pos = pencil_ghost_atom.anchor_position
      const ghost_pos = pencil_ghost_atom.position
      if (!anchor_pos) {
        reset_pencil_drag()
        return
      }

      const bond_dir: Vec3 = [
        ghost_pos[0] - anchor_pos[0],
        ghost_pos[1] - anchor_pos[1],
        ghost_pos[2] - anchor_pos[2],
      ]
      const bond_len = Math.sqrt(bond_dir[0] ** 2 + bond_dir[1] ** 2 + bond_dir[2] ** 2)
      if (bond_len < 0.01) {
        reset_pencil_drag()
        return
      }

      const norm_dir: Vec3 = [bond_dir[0] / bond_len, bond_dir[1] / bond_len, bond_dir[2] / bond_len]

      const fragment = deps.get_selected_fragment()
      const connect_offset = fragment.sites[fragment.connect_idx].xyz

      // Y 轴旋转对齐
      const angle = Math.atan2(norm_dir[0], norm_dir[2])
      const cos_a = Math.cos(angle)
      const sin_a = Math.sin(angle)

      const atoms_to_add = fragment.sites.map((frag_site) => {
        const rel_pos: Vec3 = [
          frag_site.xyz[0] - connect_offset[0],
          frag_site.xyz[1] - connect_offset[1],
          frag_site.xyz[2] - connect_offset[2],
        ]
        const rotated_pos: Vec3 = [
          rel_pos[0] * cos_a + rel_pos[2] * sin_a,
          rel_pos[1],
          -rel_pos[0] * sin_a + rel_pos[2] * cos_a,
        ]
        return {
          element: frag_site.element,
          xyz: [
            ghost_pos[0] + rotated_pos[0],
            ghost_pos[1] + rotated_pos[1],
            ghost_pos[2] + rotated_pos[2],
          ] as Vec3,
        }
      })
      const next_structure = add_atoms(structure, atoms_to_add)
      // Phase X6: fast path BEFORE set_structure. Fragments are a bulk add —
      // N atoms appended at the tail, site_ids are old_len..new_len-1.
      const base_id = structure.sites.length
      const specs: AtomAddSpec[] = atoms_to_add.map((a, i) => ({
        site_id: base_id + i,
        position: [a.xyz[0], a.xyz[1], a.xyz[2]] as const,
        element: a.element,
      }))
      deps.get_atom_fast_ops?.()?.try_add(specs, next_structure.sites)
      deps.set_structure(next_structure)
      // Plan v3 follow-up: fragment add must fire on_atom_added so
      // Trajectory.svelte's W5 resume_disabled flag is set when the user
      // adds a fragment during paused trajectory playback. Single-atom
      // path at line 383 does this; the fragment path was missing the
      // call (false-negative for resume_disabled). The callback receives
      // a representative atom (the first one) — Trajectory.svelte's
      // handler only uses the call as a topology-altered signal, not the
      // payload contents.
      const first = atoms_to_add[0]
      if (first) {
        deps.get_on_atom_added()?.({ element: first.element, position: first.xyz })
      }
    }

    reset_pencil_drag()
  }

  // ═══ 铅笔模式: 重置拖拽状态 ═══

  function reset_pencil_drag() {
    remove_pencil_window_listeners()
    pencil_drag_active = false
    pencil_did_drag = false
    pencil_anchor_idx = null
    pencil_ghost_atom = null
    pencil_bond_length = 1.5
    pencil_drag_start_screen = null
    drag_camera_quaternion = null

    pencil_just_completed = true
    setTimeout(() => { pencil_just_completed = false }, 50)

    const orbit_controls = deps.get_orbit_controls()
    if (orbit_controls) orbit_controls.enabled = true
  }

  // ═══ 键编辑: 统一的键创建逻辑 ═══
  // UX 改进: 原 click-click 和 drag-to-connect 各有一份相同的键创建代码，统一到此函数

  function create_bond_between(idx_a: number, idx_b: number): boolean {
    const key = get_bond_key(idx_a, idx_b)
    const already_manual = manual_bonds.some(b => get_bond_key(b.site_idx_1, b.site_idx_2) === key)
    if (already_manual) return false

    deps.push_to_undo()
    const new_bond: ManualBond = {
      site_idx_1: Math.min(idx_a, idx_b),
      site_idx_2: Math.max(idx_a, idx_b),
      id: `bond_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    }
    manual_bonds = [...manual_bonds, new_bond]
    if (deleted_bond_keys.has(key)) {
      deleted_bond_keys = new Set([...deleted_bond_keys].filter(k => k !== key))
    }
    return true
  }

  // ═══ 键编辑: click-click 模式 ═══

  function handle_bond_atom_click(site_idx: number) {
    const structure = deps.get_structure()
    if (!structure || pencil_add_mode !== 'bonds') return
    if (bond_drag_active) return

    if (bond_first_atom === null) {
      if (bond_just_completed) return
      bond_first_atom = site_idx
      selected_bonds = []
    } else if (bond_first_atom === site_idx) {
      if (bond_just_completed) return
      bond_first_atom = null
    } else {
      create_bond_between(bond_first_atom, site_idx)
      bond_first_atom = null
    }
  }

  // ═══ 键编辑: drag-to-connect 模式 ═══

  function handle_bond_drag_start(site_idx: number, event: PointerEvent) {
    const structure = deps.get_structure()
    if (!structure || pencil_add_mode !== `bonds`) return
    if (bond_first_atom !== null && bond_first_atom !== site_idx) return

    bond_first_atom = site_idx
    bond_drag_active = true
    bond_did_drag = false
    bond_ghost_end = null
    selected_bonds = []
    bond_drag_start_screen = { x: event.clientX, y: event.clientY }

    const camera = deps.get_camera()
    if (camera) {
      drag_camera_quaternion = (camera as any).quaternion.clone()
      drag_camera_snapshot = (camera as any).clone()
    }

    const orbit_controls = deps.get_orbit_controls()
    if (orbit_controls) (orbit_controls as any).enabled = false

    window.addEventListener(`pointermove`, update_bond_ghost_position)
    window.addEventListener(`pointerup`, handle_bond_window_up)
  }

  function update_bond_ghost_position(event: PointerEvent) {
    if (!bond_drag_active || bond_first_atom === null) return

    if (!bond_did_drag && bond_drag_start_screen) {
      const dx = event.clientX - bond_drag_start_screen.x
      const dy = event.clientY - bond_drag_start_screen.y
      if (Math.sqrt(dx * dx + dy * dy) < PENCIL_MIN_DRAG_DISTANCE) return
      bond_did_drag = true
    }

    const sites = (deps.get_displayed_structure() as any)?.sites
    if (!sites?.[bond_first_atom]) return
    const first_local_pos = sites[bond_first_atom].xyz as Vec3
    const first_world_pos = deps.local_to_world(first_local_pos)

    const world_pos = deps.get_3d_position_from_click(
      event,
      first_world_pos as [number, number, number],
      drag_camera_quaternion,
      drag_camera_snapshot,
    )
    if (!world_pos) return

    bond_ghost_end = world_to_local(world_pos as Vec3)
  }

  function handle_bond_drag_end(site_idx: number) {
    if (!bond_drag_active || bond_first_atom === null) return
    if (bond_did_drag && site_idx !== bond_first_atom) {
      create_bond_between(bond_first_atom, site_idx)
      reset_bond_drag(true)
    } else {
      reset_bond_drag(false)
    }
  }

  function handle_bond_window_up() {
    if (!bond_drag_active) return
    if (bond_did_drag) {
      reset_bond_drag(true)
    } else {
      reset_bond_drag(false)
    }
  }

  function reset_bond_drag(clear_first_atom: boolean) {
    window.removeEventListener(`pointermove`, update_bond_ghost_position)
    window.removeEventListener(`pointerup`, handle_bond_window_up)
    bond_drag_active = false
    bond_ghost_end = null
    bond_drag_start_screen = null
    const did_drag = bond_did_drag
    bond_did_drag = false
    drag_camera_quaternion = null
    drag_camera_snapshot = null

    if (!did_drag) {
      bond_just_completed = true
      setTimeout(() => { bond_just_completed = false }, 50)
    }

    const orbit_controls = deps.get_orbit_controls()
    if (orbit_controls) (orbit_controls as any).enabled = true
    if (clear_first_atom) bond_first_atom = null
  }

  // ═══ 键编辑: 选择 & 删除 ═══

  function handle_bond_select(bond: SelectedBond | null) {
    if (!bond) {
      selected_bonds = []
    } else {
      const exists = selected_bonds.some(b => b.key === bond.key)
      selected_bonds = exists
        ? selected_bonds.filter(b => b.key !== bond.key)
        : [...selected_bonds, bond]
    }
    bond_first_atom = null
  }

  function delete_selected_bonds() {
    if (selected_bonds.length === 0) return

    // Route deletes through bond_undo for the incremental GPU sync (sparse
    // dirty_slots → coalesced addUpdateRange upload). Push a 'bond' undo
    // entry carrying the array inverse so Ctrl+Z can reverse the
    // manual_bonds / deleted_bond_keys mutation without a full snapshot.
    // The manager-side rollback replays the inverse ops recorded on
    // bond_undo.
    const keys_arr = selected_bonds.map(b => b.key)
    const keys = new Set(keys_arr)

    // Capture inverse BEFORE mutating arrays.
    const restore_manual_bonds = manual_bonds.filter(b =>
      keys.has(get_bond_key(b.site_idx_1, b.site_idx_2))
    )
    const remove_deleted_keys = keys_arr.filter(k => !deleted_bond_keys.has(k))
    deps.push_bond_entry({ restore_manual_bonds, remove_deleted_keys })

    // Manager-side: record inverse on bond_undo and apply sparse removes.
    const n = selected_bonds.length
    const pair_buf = new Uint32Array(n * 2)
    for (let i = 0; i < n; i++) {
      pair_buf[i * 2]     = selected_bonds[i].site_idx_1
      pair_buf[i * 2 + 1] = selected_bonds[i].site_idx_2
    }
    const slots_raw = bond_manager.find_slots_by_pairs(pair_buf)
    // Filter out -1 (bonds not found in manager — e.g. stale selection)
    const valid: number[] = []
    for (let i = 0; i < slots_raw.length; i++) {
      if (slots_raw[i] >= 0) valid.push(slots_raw[i])
    }
    if (valid.length > 0) bond_undo.remove_bonds(valid)

    // Mutate arrays so filtered_bond_pairs stays consistent with the
    // manager. Without this, a later manual-bond-add would retrigger the
    // diff shadow sync against stale filtered_bond_pairs and resurrect
    // deleted bonds as zombies. After this, the diff sync sees "no delta"
    // and no-ops.
    manual_bonds = manual_bonds.filter(b => !keys.has(get_bond_key(b.site_idx_1, b.site_idx_2)))
    deleted_bond_keys = new Set([...deleted_bond_keys, ...keys])

    selected_bonds = []
  }

  /**
   * Reverse the `manual_bonds` / `deleted_bond_keys` mutation performed
   * by `delete_selected_bonds` (flag-on path). Called by the global
   * `undo()` dispatcher AFTER `bond_undo.undo()` has already restored
   * the `BondManager` state — so the diff shadow sync must observe
   * matching arrays here, otherwise it would re-remove the bonds it
   * just saw restored.
   *
   * Mirrors the inverse-data shape captured in `delete_selected_bonds`:
   * restore the removed manual bonds by concatenation, and filter out
   * only the keys the delete newly added — leaving keys that were
   * already in `deleted_bond_keys` beforehand untouched (those belong
   * to earlier history entries).
   */
  function apply_bond_array_inverse(inv: BondArrayInverse): void {
    if (inv.restore_manual_bonds.length > 0) {
      manual_bonds = [...manual_bonds, ...inv.restore_manual_bonds]
    }
    if (inv.remove_deleted_keys.length > 0) {
      const to_remove = new Set(inv.remove_deleted_keys)
      deleted_bond_keys = new Set([...deleted_bond_keys].filter(k => !to_remove.has(k)))
    }
  }

  // ═══ Undo 集成 ═══

  /** 保存当前 bond 编辑状态到 undo 栈（由 Structure.svelte 的 push_to_undo 调用） */
  function push_bond_undo() {
    const bond_hist = bond_edit_history.length >= MAX_UNDO_HISTORY
      ? bond_edit_history.slice(-MAX_UNDO_HISTORY + 1)
      : bond_edit_history
    bond_edit_history = [...bond_hist, {
      manual_bonds: $state.snapshot(manual_bonds) as ManualBond[],
      deleted_bond_keys: new Set($state.snapshot(deleted_bond_keys) as Set<string>),
    }]
  }

  /** 从 undo 栈恢复 bond 编辑状态（由 Structure.svelte 的 undo 调用） */
  function pop_bond_undo() {
    if (bond_edit_history.length > 0) {
      const prev = bond_edit_history[bond_edit_history.length - 1]
      bond_edit_history = bond_edit_history.slice(0, -1)
      manual_bonds = prev.manual_bonds
      deleted_bond_keys = prev.deleted_bond_keys
    }
    selected_bonds = []
    bond_first_atom = null
  }

  // ═══ 公开接口 ═══

  return {
    // ── 铅笔模式状态 (getter+setter 支持 bind:) ──
    get pencil_mode_active() { return pencil_mode_active },
    set pencil_mode_active(v: boolean) { pencil_mode_active = v },
    get pencil_drag_active() { return pencil_drag_active },
    set pencil_drag_active(v: boolean) { pencil_drag_active = v },
    get pencil_anchor_idx() { return pencil_anchor_idx },
    set pencil_anchor_idx(v: number | null) { pencil_anchor_idx = v },
    get pencil_ghost_atom() { return pencil_ghost_atom },
    set pencil_ghost_atom(v: typeof pencil_ghost_atom) { pencil_ghost_atom = v },
    get pencil_add_mode() { return pencil_add_mode },
    set pencil_add_mode(v: PencilAddMode) { pencil_add_mode = v },

    // ── 键编辑状态 (getter+setter) ──
    get manual_bonds() { return manual_bonds },
    set manual_bonds(v: ManualBond[]) { manual_bonds = v },
    get deleted_bond_keys() { return deleted_bond_keys },
    set deleted_bond_keys(v: Set<string>) { deleted_bond_keys = v },
    get selected_bonds() { return selected_bonds },
    set selected_bonds(v: SelectedBond[]) { selected_bonds = v },
    get bond_first_atom() { return bond_first_atom },
    set bond_first_atom(v: number | null) { bond_first_atom = v },
    get bond_drag_active() { return bond_drag_active },
    get bond_ghost_end() { return bond_ghost_end },
    get scene_bond_pairs() { return scene_bond_pairs },
    set scene_bond_pairs(v: BondPair[]) { scene_bond_pairs = v },
    get bond_edit_history() { return bond_edit_history },
    set bond_edit_history(v: typeof bond_edit_history) { bond_edit_history = v },

    // ── 相机快照 (只读 — 仅内部设置) ──
    get drag_camera_quaternion() { return drag_camera_quaternion },
    get drag_camera_snapshot() { return drag_camera_snapshot },

    // ── 铅笔模式 handler ──
    handle_pencil_atom_click,
    complete_pencil_drag,
    reset_pencil_drag,
    world_to_local,

    // ── 键编辑 handler ──
    handle_bond_atom_click,
    handle_bond_drag_start,
    handle_bond_drag_end,
    handle_bond_select,
    delete_selected_bonds,
    reset_bond_drag,

    // ── Undo 集成 ──
    push_bond_undo,
    pop_bond_undo,
    apply_bond_array_inverse,

    // ── 新 SoA 键存储 (Phase 1: 仅暴露, 暂无消费者) ──
    get bond_manager() { return bond_manager },
    get bond_undo() { return bond_undo },
  }
}

/** create_pencil_mode_controller 的返回类型 */
export type PencilModeController = ReturnType<typeof create_pencil_mode_controller>

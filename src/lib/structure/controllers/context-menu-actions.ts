/**
 * 右键菜单动作分发模块
 *
 * 处理结构查看器右键菜单的所有动作:
 * - Add Atom: 在指定 3D 位置添加原子
 * - Edit Atoms: 删除/替换选中原子
 * - Selection: 反选/按元素选/全选/清除
 * - Charge Label: 显示/隐藏/设置 Bader 电荷标签
 * - Atom Color: 自定义原子颜色
 * - Constraints: VASP selective dynamics 冻结/解冻
 * - Import: 导入分子/电荷文件
 *
 * UX 改进:
 * - Constraints 区域原来有 4 处相同的「获取目标原子 + 映射 image 原子」代码，
 *   现在统一到 get_target_indices() 内部方法，消除重复。
 *
 * 依赖:
 * - 通过 deps getter/setter 访问组件内的 reactive 状态
 * - 纯函数模块，不使用 Svelte runes
 */

import type { AnyStructure, ElementSymbol, Vec3 } from '$lib'
import type { AtomArrayInverse } from '$lib/structure/state/selection-state.svelte'
import { add_atom, delete_atoms, replace_atom } from '$lib/structure/atom-manipulation'
import type {
  AtomAddSpec,
  AtomFastOps,
  AtomReplaceSpec,
} from '$lib/structure/atoms/atom-manager.svelte'

// ─── 类型 ───

/** 工厂函数的依赖接口 */
export interface ContextMenuDeps {
  // ── 结构 & 选择 ──
  get_structure: () => AnyStructure | undefined
  set_structure: (s: AnyStructure) => void
  get_selected_sites: () => number[]
  set_selected_sites: (s: number[]) => void
  get_displayed_structure: () => AnyStructure | undefined

  // ── 右键菜单状态 ──
  get_context_menu_3d_position: () => Vec3 | null
  get_context_menu_target_site: () => number | null
  get_context_menu_visible: () => boolean
  set_context_menu_visible: (v: boolean) => void
  get_context_menu_position: () => { x: number; y: number }
  set_context_menu_position: (p: { x: number; y: number }) => void

  // ── 铅笔模式 ──
  get_selected_add_element: () => ElementSymbol

  // ── 原子颜色 ──
  get_site_color_overrides: () => Map<number, string>
  get_color_picker_input: () => HTMLInputElement | null
  set_color_picker_targets: (targets: number[]) => void

  // ── 电荷标签 ──
  get_visible_charge_labels: () => Set<number>
  set_visible_charge_labels: (s: Set<number>) => void

  // ── 导入元素引用 ──
  get_molecule_import_input: () => HTMLInputElement | null
  set_molecule_import_position: (p: Vec3 | null) => void
  get_charges_import_input: () => HTMLInputElement | null

  // ── 撤销 ──
  push_to_undo: () => void
  /**
   * Push a sparse 'atom' undo entry (removed Site objects + indices).
   * Used by atom-delete paths instead of `push_to_undo()` to avoid an
   * O(N) structure snapshot on every delete.
   */
  push_atom_entry: (atom_inverse: AtomArrayInverse) => void
  /**
   * Read the current atom_opacity_overrides so we can capture
   * orphaned entries into the atom-kind undo inverse before pruning.
   */
  get_atom_opacity_overrides: () => Map<number, number>
  /** Replace atom_opacity_overrides (used to prune orphaned entries on delete). */
  set_atom_opacity_overrides: (m: Map<number, number>) => void
  push_selection_to_undo: () => void

  // ── 原子可见性 ──
  get_hidden_sites: () => Set<number>
  set_hidden_sites: (s: Set<number>) => void

  // ── 缺陷/虚化原子 ──
  get_ghost_atom_indices: () => Set<number>
  set_ghost_atom_indices: (s: Set<number>) => void

  // ── 原子类型判断 ──
  is_image_atom: (idx: number) => boolean
  get_original_atoms_only: (indices: number[]) => number[]

  // ── Phase X6 fast-path hook (null until StructureScene's $effect
  //    populates it; also null when USE_NEW_ATOM_SYSTEM is off). Optional
  //    so tests / legacy callers can skip wiring it. ──
  get_atom_fast_ops?: () => AtomFastOps | null

  // ── 回调 props (wrapped in getters for reactivity) ──
  get_on_atom_added?: () => ((info: { element: ElementSymbol; position: Vec3 }) => void) | undefined
  get_on_atoms_deleted?: () => ((info: { site_indices: number[] }) => void) | undefined
  get_on_atom_replaced?: () => ((info: { site_indices: number[]; new_element: ElementSymbol }) => void) | undefined
  get_on_save_to_project?: () => ((structure: Record<string, unknown>) => void) | undefined
  get_on_save_to_database?: () => ((structure: Record<string, unknown>) => void) | undefined
  get_on_export_to_hpc?: () => ((structure: Record<string, unknown>) => void) | undefined
  get_on_export_to_file?: () => ((structure: Record<string, unknown>) => void) | undefined
  get_on_edit_as_text?: () => ((structure: Record<string, unknown>) => void) | undefined
  get_supercell_structure?: () => AnyStructure | undefined
}

// ─── 工厂函数 ───

/**
 * 创建右键菜单动作处理器
 *
 * 使用方式:
 * ```ts
 * const ctx_actions = create_context_menu_actions({ ... })
 * // 模板: on_select={ctx_actions.handle_select}
 * ```
 */
export function create_context_menu_actions(deps: ContextMenuDeps) {

  /**
   * 获取右键操作的目标原子索引列表
   * 统一处理: 单个右键目标 vs 多选原子 + image 原子映射到原始原子
   *
   * @param map_images 是否将 image 原子映射到原始原子（Constraints 等需要映射）
   */
  function get_target_indices(map_images = false): number[] {
    const target = deps.get_context_menu_target_site()
    const selected = deps.get_selected_sites()

    // 确定原始目标列表
    const raw_indices = target !== null
      ? (selected.includes(target) && selected.length > 0 ? selected : [target])
      : selected.length > 0
        ? selected
        : []

    if (!map_images) return raw_indices

    // 映射 image 原子到原始原子
    const displayed = deps.get_displayed_structure() as any
    const mapped = raw_indices.map((idx) => {
      if (deps.is_image_atom(idx) && displayed?.image_to_original_map) {
        const num_orig = displayed.num_original_sites ?? 0
        return displayed.image_to_original_map[idx - num_orig] ?? idx
      }
      return idx
    })
    const structure = deps.get_structure()
    const max_idx = structure?.sites?.length ?? 0
    return [...new Set(mapped.filter((idx) => idx < max_idx))]
  }

  /**
   * Capture a sparse atom-delete undo entry BEFORE the structure is mutated.
   * Records the Site objects at `sorted_indices` (must be sorted ascending)
   * plus any orphaned `atom_opacity_overrides` entries, then pushes an
   * 'atom'-kind undo entry. Also prunes the orphaned opacity overrides so
   * stale entries don't linger after the delete.
   */
  function push_atom_delete_entry(
    structure: AnyStructure,
    sorted_indices: number[],
  ): void {
    if (sorted_indices.length === 0) return
    const removed_sites = sorted_indices.map((idx) => structure.sites[idx])
    const prev_overrides = deps.get_atom_opacity_overrides()
    const removed_atom_opacity_entries: Array<[number, number]> = []
    for (const idx of sorted_indices) {
      const v = prev_overrides.get(idx)
      if (v !== undefined) removed_atom_opacity_entries.push([idx, v])
    }
    deps.push_atom_entry({
      removed_sites,
      removed_indices: sorted_indices,
      removed_atom_opacity_entries,
    })
    if (removed_atom_opacity_entries.length > 0) {
      const next = new Map(prev_overrides)
      for (const idx of sorted_indices) next.delete(idx)
      deps.set_atom_opacity_overrides(next)
    }
  }

  /**
   * 映射单个 image 原子索引到原始原子索引
   * 用于 Charge Label 等操作
   */
  function map_to_original(target_idx: number): number {
    const displayed = deps.get_displayed_structure() as any
    if (deps.is_image_atom(target_idx) && displayed?.image_to_original_map) {
      const num_orig = displayed.num_original_sites ?? 0
      return displayed.image_to_original_map[target_idx - num_orig] ?? target_idx
    }
    return target_idx
  }

  // ── 各 section 的处理函数 ──

  function handle_add_atom(option: { value: string }) {
    const structure = deps.get_structure()
    const pos = deps.get_context_menu_3d_position()
    if (option.value !== `add` || !structure || !pos) return

    const element = deps.get_selected_add_element()
    const next_structure = add_atom(structure, element, pos)
    // Phase X6: fire the fast path BEFORE the canonical sites mutation.
    // Order is load-bearing — see Structure.svelte.delete_selected for the
    // same pattern. No-ops when USE_NEW_ATOM_SYSTEM is off.
    const new_site_id = next_structure.sites.length - 1
    const spec: AtomAddSpec = {
      site_id: new_site_id,
      position: [pos[0], pos[1], pos[2]] as const,
      element,
    }
    deps.get_atom_fast_ops?.()?.try_add([spec], next_structure.sites)
    deps.set_structure(next_structure)
    deps.get_on_atom_added?.()?.({ element, position: pos })
  }

  function handle_edit_atoms(option: { value: string }) {
    const structure = deps.get_structure()
    if (!structure) return
    const target = deps.get_context_menu_target_site()

    if (option.value === `delete`) {
      // Phase X5: fire delete fast path BEFORE canonical mutation (load-bearing
      // ordering — fingerprint pre-bump skips next-tick bond recompute).
      const run_delete = (sorted_indices: number[]) => {
        const deleted_set = new Set(sorted_indices)
        const next_structure = delete_atoms(structure, sorted_indices)
        deps.get_atom_fast_ops?.()?.try_delete(sorted_indices, next_structure.sites)
        deps.set_structure(next_structure)
        deps.get_on_atoms_deleted?.()?.({ site_indices: sorted_indices })
        deps.set_selected_sites(deps.get_selected_sites().filter((idx) => !deleted_set.has(idx)))
      }
      if (target !== null) {
        if (deps.is_image_atom(target)) return
        push_atom_delete_entry(structure, [target])
        run_delete([target])
      } else {
        const original = deps.get_original_atoms_only(deps.get_selected_sites())
        if (original.length === 0) return
        const sorted = [...original].sort((a, b) => a - b)
        push_atom_delete_entry(structure, sorted)
        run_delete(sorted)
      }
    } else if (option.value === `replace`) {
      const indices = deps.get_original_atoms_only(
        target !== null ? [target] : deps.get_selected_sites(),
      )
      if (indices.length === 0) return
      const element = deps.get_selected_add_element()
      let new_structure = structure
      for (const idx of indices) {
        new_structure = replace_atom(new_structure, idx, element)
      }
      // Phase X6: fire replace fast path BEFORE the canonical mutation.
      const specs: AtomReplaceSpec[] = indices.map((site_id) => ({
        site_id,
        new_element: element,
      }))
      deps.get_atom_fast_ops?.()?.try_replace(specs, new_structure.sites)
      deps.set_structure(new_structure)
      deps.get_on_atom_replaced?.()?.({ site_indices: indices, new_element: element })
    } else if (option.value === `hide`) {
      const indices = get_target_indices()
      if (indices.length === 0) return
      const hidden = new Set(deps.get_hidden_sites())
      for (const idx of indices) hidden.add(idx)
      deps.set_hidden_sites(hidden)
      // Clear selection for hidden atoms
      deps.set_selected_sites(deps.get_selected_sites().filter((idx) => !hidden.has(idx)))
    } else if (option.value === `show_all`) {
      deps.set_hidden_sites(new Set())
    }
  }

  function handle_selection(option: { value: string }) {
    deps.push_selection_to_undo()
    const structure = deps.get_structure()

    if (option.value === 'Invert' && structure) {
      const inverted = structure.sites
        .map((_, idx) => idx)
        .filter((idx) => !deps.get_selected_sites().includes(idx))
      deps.set_selected_sites(inverted)
    } else if (option.value.startsWith('select_element_') && structure) {
      const element = option.value.replace('select_element_', '')
      deps.set_selected_sites(
        structure.sites
          .map((site, idx) => ({ site, idx }))
          .filter(({ site }) => site.species?.[0]?.element === element)
          .map(({ idx }) => idx),
      )
    } else if (option.value === 'select_all' && structure) {
      deps.set_selected_sites(structure.sites.map((_, idx) => idx))
    } else if (option.value === 'clear') {
      deps.set_selected_sites([])
    }
  }

  function handle_charge_label(option: { value: string }) {
    const structure = deps.get_structure()
    const raw_target = deps.get_context_menu_target_site()

    if (option.value === `toggle_charge_label`) {
      if (raw_target === null) return
      const target = map_to_original(raw_target)
      const labels = new Set(deps.get_visible_charge_labels())
      if (labels.has(target)) labels.delete(target)
      else labels.add(target)
      deps.set_visible_charge_labels(labels)
    } else if (option.value === `set_charge_value`) {
      if (raw_target === null || !structure) return
      const target = map_to_original(raw_target)
      const current = structure.sites[target]?.properties?.bader_charge
      const input = prompt(`Enter charge value (e):`, typeof current === `number` ? String(current) : ``)
      if (input === null) return
      const val = parseFloat(input)
      if (isNaN(val)) return
      deps.push_to_undo()
      const new_sites = structure.sites.map((site, idx) =>
        idx === target
          ? { ...site, properties: { ...site.properties, bader_charge: val } }
          : site,
      )
      deps.set_structure({ ...structure, sites: new_sites })
      deps.set_visible_charge_labels(new Set([...deps.get_visible_charge_labels(), target]))
    } else if (option.value === `show_all_charge_labels`) {
      if (!structure) return
      const with_charges = new Set<number>()
      structure.sites.forEach((site, idx) => {
        if (typeof site.properties?.bader_charge === `number`) with_charges.add(idx)
      })
      deps.set_visible_charge_labels(with_charges)
    } else if (option.value === `hide_all_charge_labels`) {
      deps.set_visible_charge_labels(new Set())
    }
  }

  function handle_atom_color(option: { value: string }) {
    if (option.value === `set_color`) {
      const targets = get_target_indices()
      if (targets.length === 0) return
      deps.set_color_picker_targets(targets)
      const input = deps.get_color_picker_input()
      if (input) {
        const first_override = deps.get_site_color_overrides().get(targets[0])
        input.value = first_override ?? `#ff69b4`
        // Prefer the modern `showPicker()` API — explicitly designed to
        // open the native picker dialog without the user-activation
        // ambiguity of .click(). Chrome 99+ / Firefox 101+ / Tauri
        // webview all support it. Falls back to .click() for very old
        // webviews. Either path needs the input to be on-screen (see
        // Structure.svelte: input is positioned at fixed 0,0 with 1px
        // size + opacity 0, NOT off-viewport — Tauri refuses to open
        // pickers for offscreen inputs).
        const inputWithPicker = input as HTMLInputElement & { showPicker?: () => void }
        if (typeof inputWithPicker.showPicker === `function`) {
          try {
            inputWithPicker.showPicker()
          } catch (err) {
            // showPicker throws InvalidStateError if user-activation lost
            console.warn(`[Set Color] showPicker failed, falling back to .click()`, err)
            input.click()
          }
        } else {
          input.click()
        }
      }
    } else if (option.value === `reset_color`) {
      const targets = get_target_indices()
      const overrides = deps.get_site_color_overrides()
      for (const idx of targets) overrides.delete(idx)
    } else if (option.value === `reset_all_colors`) {
      deps.get_site_color_overrides().clear()
    }
  }

  function handle_constraints(option: { value: string }) {
    const structure = deps.get_structure()
    if (!structure) return
    deps.push_to_undo()

    if (option.value.startsWith(`toggle_freeze_`)) {
      const axis_idx = option.value === `toggle_freeze_x` ? 0
        : option.value === `toggle_freeze_y` ? 1 : 2
      const indices = get_target_indices(true)
      if (indices.length === 0) return
      const new_sites = structure.sites.map((site, idx) => {
        const existing = (site.properties?.selective_dynamics as [boolean, boolean, boolean]) ?? [true, true, true]
        if (!indices.includes(idx)) {
          // Ensure ALL sites have selective_dynamics when any are constrained
          return { ...site, properties: { ...site.properties, selective_dynamics: existing } }
        }
        const new_sd = [...existing] as [boolean, boolean, boolean]
        new_sd[axis_idx] = !new_sd[axis_idx]
        return { ...site, properties: { ...site.properties, selective_dynamics: new_sd } }
      })
      deps.set_structure({ ...structure, sites: new_sites })
    } else if (option.value === `freeze_all`) {
      const indices = get_target_indices(true)
      if (indices.length === 0) return
      const new_sites = structure.sites.map((site, idx) =>
        indices.includes(idx)
          ? { ...site, properties: { ...site.properties, selective_dynamics: [false, false, false] as [boolean, boolean, boolean] } }
          : { ...site, properties: { ...site.properties, selective_dynamics: (site.properties?.selective_dynamics as [boolean, boolean, boolean]) ?? [true, true, true] } },
      )
      deps.set_structure({ ...structure, sites: new_sites })
    } else if (option.value === `unfreeze_selected`) {
      const indices = get_target_indices(true)
      if (indices.length === 0) return
      const new_sites = structure.sites.map((site, idx) =>
        indices.includes(idx)
          ? { ...site, properties: { ...site.properties, selective_dynamics: [true, true, true] as [boolean, boolean, boolean] } }
          : { ...site, properties: { ...site.properties, selective_dynamics: (site.properties?.selective_dynamics as [boolean, boolean, boolean]) ?? [true, true, true] } },
      )
      deps.set_structure({ ...structure, sites: new_sites })
    } else if (option.value === `unfreeze_all`) {
      const new_sites = structure.sites.map((site) => ({
        ...site,
        properties: {
          ...site.properties,
          selective_dynamics: [true, true, true] as [boolean, boolean, boolean],
        },
      }))
      deps.set_structure({ ...structure, sites: new_sites })
    }
  }

  function handle_defect_mark(option: { value: string }) {
    if (option.value === `toggle_ghost`) {
      const indices = get_target_indices()
      if (indices.length === 0) return
      const ghosts = new Set(deps.get_ghost_atom_indices())
      const all_ghosted = indices.every((idx) => ghosts.has(idx))
      if (all_ghosted) {
        for (const idx of indices) ghosts.delete(idx)
      } else {
        for (const idx of indices) ghosts.add(idx)
      }
      deps.set_ghost_atom_indices(ghosts)
    } else if (option.value === `clear_all_ghosts`) {
      deps.set_ghost_atom_indices(new Set())
    }
  }

  function handle_import(option: { value: string }) {
    if (option.value === 'import_molecule') {
      const pos = deps.get_context_menu_3d_position()
      if (!pos) return
      deps.set_molecule_import_position(pos)
      deps.get_molecule_import_input()?.click()
    } else if (option.value === 'load_charges') {
      deps.get_charges_import_input()?.click()
    }
  }

  // ── 主分发函数 ──

  /**
   * 处理右键菜单项选择
   * 根据 section_title 分发到对应的处理函数
   */
  function handle_select(section_title: string, option: { value: string }) {
    // 结构性修改需要 undo（选择/标签/约束/颜色/缺陷标记除外）
    if (section_title !== 'Selection' && section_title !== `Charge Label`
        && section_title !== `Constraints` && section_title !== `Atom Color`
        && section_title !== `Defect Atom`) {
      deps.push_to_undo()
    }

    switch (section_title) {
      case `Add Atom`: handle_add_atom(option); break
      case `Edit Atoms`: handle_edit_atoms(option); break
      case `Selection`: handle_selection(option); break
      case `Charge Label`: handle_charge_label(option); break
      case `Atom Color`: handle_atom_color(option); break
      case `Constraints`: handle_constraints(option); break
      case `Defect Atom`: handle_defect_mark(option); break
      case `Import`: handle_import(option); break
    }

    // 特殊: Save / Export
    if (option.value === `save_to_project`) {
      const s = (deps.get_supercell_structure?.() ?? deps.get_structure()) as Record<string, unknown> | undefined
      if (s) deps.get_on_save_to_project?.()?.(s)
      deps.set_context_menu_visible(false)
      return
    }
    if (option.value === `save_to_database`) {
      const s = (deps.get_supercell_structure?.() ?? deps.get_structure()) as Record<string, unknown> | undefined
      if (s) deps.get_on_save_to_database?.()?.(s)
      deps.set_context_menu_visible(false)
      return
    }
    if (option.value === `export_to_hpc`) {
      const s = (deps.get_supercell_structure?.() ?? deps.get_structure()) as Record<string, unknown> | undefined
      if (s) deps.get_on_export_to_hpc?.()?.(s)
      deps.set_context_menu_visible(false)
      return
    }
    if (option.value === `export_to_file`) {
      const s = (deps.get_supercell_structure?.() ?? deps.get_structure()) as Record<string, unknown> | undefined
      if (s) deps.get_on_export_to_file?.()?.(s)
      deps.set_context_menu_visible(false)
      return
    }
    if (option.value === `edit_as_text`) {
      const s = (deps.get_supercell_structure?.() ?? deps.get_structure()) as Record<string, unknown> | undefined
      if (s) deps.get_on_edit_as_text?.()?.(s)
      deps.set_context_menu_visible(false)
      return
    }

    // toggle 类选项: 关闭后重新打开菜单以刷新状态
    if (option.value.startsWith(`toggle_`)) {
      const saved_position = { ...deps.get_context_menu_position() }
      deps.set_context_menu_visible(false)
      requestAnimationFrame(() => {
        deps.set_context_menu_position(saved_position)
        deps.set_context_menu_visible(true)
      })
    } else {
      deps.set_context_menu_visible(false)
    }
  }

  return { handle_select }
}

/** create_context_menu_actions 的返回类型 */
export type ContextMenuActions = ReturnType<typeof create_context_menu_actions>

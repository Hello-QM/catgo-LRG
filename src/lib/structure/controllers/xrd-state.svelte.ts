/**
 * XRD（X 射线衍射）状态管理模块
 *
 * 管理 XRD 图谱的计算、缓存、固定（pin）和可视化数据:
 * - xrd_pattern: 当前结构的 XRD 计算结果（800ms 去抖）
 * - pinned_xrd_patterns: 用户固定的图谱（用于多图谱叠加比较）
 * - xrd_bar_series: 合并后的柱状图数据（供 BarPlot 消费）
 * - xrd_angle_range: 自动计算的 2θ 角度范围
 *
 * 依赖:
 * - structure（当前晶体结构）
 * - analysis_pane_open + active_analysis_tab（仅在 Spectrum 标签打开时计算）
 *
 * 使用 .svelte.ts 后缀因为内部用 $state/$derived/$effect 管理 reactive 状态
 */

import type { BarSeries } from '$lib/plot'
import type { AnyStructure, PymatgenStructure } from '$lib/structure'
import { is_ok, wasm_compute_xrd } from '$lib/structure/ferrox-wasm'
import type { Hkl, RadiationKey, XrdPattern } from '$lib/xrd'
import { WAVELENGTHS } from '$lib/xrd/calc-xrd'
import { PLOT_COLORS } from '$lib/colors'
import { get_electro_neg_formula } from '$lib/composition/parse'
import { format_value } from '$lib/labels'

// ─── 类型 ───

/** 用户固定的 XRD 图谱，用于多图谱叠加比较 */
export interface PinnedXrdPattern {
  id: string
  label: string
  pattern: XrdPattern
  radiation: RadiationKey
  color: string
  visible: boolean
}

/** 工厂函数的依赖接口 — 通过 getter 访问组件内的 reactive 状态 */
export interface XrdControllerDeps {
  /** 当前活跃的结构数据 */
  get_structure: () => AnyStructure | undefined
  /** Analysis 面板是否打开 */
  get_analysis_open: () => boolean
  /** 当前活跃的 Analysis 子标签页 */
  get_active_tab: () => string
}

// ─── HKL 格式化工具 ───

/**
 * 将 Miller 指数格式化为带上划线的 Unicode 字符串
 * 例: [1, -2, 0] → "1 2̄ 0"（负数用上划线表示）
 */
export function format_hkl(hkl: Hkl): string {
  return hkl.map((v) => {
    if (v < 0) {
      const digits = String(Math.abs(v))
      return digits.split(``).map((d) => `${d}\u0305`).join(``)
    }
    return `${v}`
  }).join(``)
}

// ─── 工厂函数 ───

/**
 * 创建 XRD 控制器 — 管理 XRD 计算和图谱状态
 *
 * 使用方式:
 * ```ts
 * const xrd = create_xrd_controller({
 *   get_structure: () => structure,
 *   get_analysis_open: () => analysis_pane_open,
 *   get_active_tab: () => active_analysis_tab,
 * })
 * // 访问状态: xrd.pattern, xrd.loading, xrd.bar_series, ...
 * // 调用方法: xrd.pin_current(), xrd.unpin(id), ...
 * ```
 */
export function create_xrd_controller(deps: XrdControllerDeps) {
  // ── reactive 状态 ──
  let radiation = $state<RadiationKey>(`CuKa`)
  let pattern = $state<XrdPattern | null>(null)
  let loading = $state(false)
  let error = $state<string | undefined>(undefined)
  let layout = $state<`horizontal` | `vertical`>(`horizontal`)
  let pinned_patterns = $state<PinnedXrdPattern[]>([])

  // ── derived: 结构是否有晶格（分子没有，不能算 XRD） ──
  let has_lattice = $derived((() => {
    const s = deps.get_structure()
    return !!s && `lattice` in s && !!(s as PymatgenStructure).lattice
  })())

  // ── derived: 是否显示 XRD split-view 面板 ──
  let show_panel = $derived(
    pattern !== null && deps.get_active_tab() === `spectrum` && deps.get_analysis_open(),
  )

  // ── XRD 计算 effect（800ms 去抖，避免编辑时频繁触发 WASM） ──
  let prev_key = ``
  let debounce_timer: ReturnType<typeof setTimeout> | null = null

  $effect(() => {
    const structure = deps.get_structure()

    if (!structure || !has_lattice) {
      pattern = null
      error = undefined
      loading = false
      prev_key = ``
      if (debounce_timer) clearTimeout(debounce_timer)
      return
    }

    // 仅在用户打开 Analysis > Spectrum 标签时才计算
    if (!deps.get_analysis_open() || deps.get_active_tab() !== `spectrum`) {
      if (debounce_timer) clearTimeout(debounce_timer)
      return
    }

    const struct_id = (structure as PymatgenStructure).id ?? ``
    const site_count = structure.sites.length
    const key = `${struct_id}:${site_count}:${radiation}`
    if (key === prev_key) return
    prev_key = key

    if (debounce_timer) clearTimeout(debounce_timer)

    const current_structure = structure as PymatgenStructure
    debounce_timer = setTimeout(() => {
      debounce_timer = null
      loading = true
      error = undefined

      wasm_compute_xrd(current_structure, {
        wavelength: WAVELENGTHS[radiation],
      }).then((result) => {
        if (is_ok(result)) {
          pattern = result.ok as XrdPattern
          error = undefined
        } else {
          error = result.error
          pattern = null
        }
      }).catch((err) => {
        error = err instanceof Error ? err.message : String(err)
        pattern = null
      }).finally(() => {
        loading = false
      })
    }, 800)
  })

  // ── 固定/取消固定图谱 ──

  function pin_current() {
    const structure = deps.get_structure()
    if (!pattern || !structure) return
    const label = get_electro_neg_formula(structure, true) + ` (${radiation})`
    const used = new Set(pinned_patterns.map((p) => p.color))
    const color = PLOT_COLORS.find((c) => !used.has(c))
      ?? PLOT_COLORS[pinned_patterns.length % PLOT_COLORS.length]
    pinned_patterns = [...pinned_patterns, {
      id: crypto.randomUUID(),
      label,
      pattern: structuredClone($state.snapshot(pattern)),
      radiation,
      color,
      visible: true,
    }]
  }

  function unpin(id: string) {
    pinned_patterns = pinned_patterns.filter((p) => p.id !== id)
  }

  function toggle_pinned_visibility(id: string) {
    pinned_patterns = pinned_patterns.map((p) =>
      p.id === id ? { ...p, visible: !p.visible } : p,
    )
  }

  // ── derived: 合并后的 BarSeries（供 BarPlot 组件消费） ──

  const bar_series = $derived.by<BarSeries[]>(() => {
    const series: BarSeries[] = []
    const has_pinned = pinned_patterns.length > 0

    // 固定图谱先渲染（叠加模式下显示在底层）
    for (const pinned of pinned_patterns) {
      if (!pinned.visible) continue
      series.push({
        id: pinned.id,
        x: pinned.pattern.x,
        y: pinned.pattern.y,
        label: pinned.label,
        color: pinned.color,
        bar_width: 0.8,
        visible: true,
        metadata: pinned.pattern.x.map((_, idx) => ({
          series_label: pinned.label,
          hkls: pinned.pattern.hkls?.[idx]?.map((h) => h.hkl) ?? [],
          d: pinned.pattern.d_hkls?.[idx],
        })),
      })
    }

    // 当前图谱在最上层
    if (pattern) {
      const { x, y, hkls } = pattern

      // 标注强度最高的 5 个峰的 hkl 指数
      const top_indices = new Set(
        y.map((val, idx) => [val, idx] as const)
          .sort((a, b) => b[0] - a[0])
          .slice(0, 5)
          .map(([, idx]) => idx),
      )

      const labels: (string | null)[] = x.map((angle, idx) => {
        if (!top_indices.has(idx)) return null
        const hkl_objs = hkls?.[idx] ?? []
        const hkl_text = hkl_objs
          .map((h) => format_hkl(h.hkl))
          .join(`, `)
        return hkl_text || `${format_value(angle, `.1f`)}°`
      })

      const metadata = x.map((_, idx) => ({
        series_label: has_pinned ? `Current` : undefined,
        hkls: hkls?.[idx]?.map((h) => h.hkl) ?? [],
        d: pattern!.d_hkls?.[idx],
      }))

      series.push({
        id: `live`,
        x,
        y,
        label: has_pinned ? `Current` : ``,
        color: `#4e79a7`,
        bar_width: 0.8,
        visible: true,
        metadata,
        labels,
      })
    }

    return series
  })

  // ── derived: 自动计算 2θ 角度范围（取所有系列中的最大值，向上取整） ──

  const angle_range = $derived.by<[number, number]>(() => {
    const all_x: number[] = []
    for (const s of bar_series) {
      if (s.visible && s.x.length > 0) all_x.push(Math.max(...s.x))
    }
    if (all_x.length === 0) return [0, 90]
    return [0, Math.ceil(Math.max(...all_x))]
  })

  // ── 切换布局方向 ──

  function toggle_layout() {
    layout = layout === `horizontal` ? `vertical` : `horizontal`
  }

  // ── 公开接口 ──

  return {
    // 状态 getters（外部只读）
    get radiation() { return radiation },
    set radiation(v: RadiationKey) { radiation = v },
    get pattern() { return pattern },
    get loading() { return loading },
    get error() { return error },
    get layout() { return layout },
    get pinned_patterns() { return pinned_patterns },
    get has_lattice() { return has_lattice },
    get show_panel() { return show_panel },
    get bar_series() { return bar_series },
    get angle_range() { return angle_range },

    // 方法
    pin_current,
    unpin,
    toggle_pinned_visibility,
    toggle_layout,
  }
}

/** create_xrd_controller 的返回类型 */
export type XrdController = ReturnType<typeof create_xrd_controller>

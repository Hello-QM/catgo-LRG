/** 双模式工具面板基础设施 — pane 作用域 PanelInstance 模型 + 持久化。
 *
 * v2 (per-pane): 每个 (panel_type, pane_id) 一个实例, pane_id = 稳定
 * `${tab_id}:${leaf_id}`。四宫格四个 pane 的开关/宽度/停靠边/模式/悬浮位置
 * 完全隔离 — 所有更新 API 显式携带实例 id, 禁止全局单例控制所有 pane。
 *
 * 停靠参与所在 pane 的内部布局 (只压缩本 pane 视口); 悬浮 absolute 于
 * pane 内, 以 pane 尺寸为碰撞边界。两种模式渲染同一实例 — 模式切换只换
 * 渲染槽位 (同 pane 内 DOM reparent), 绝不销毁重建。
 *
 * 持久化: leaf id 为会话内随机铸造 (pane 树不跨重启持久), 因此按 pane 的
 * 精确恢复只在会话内有效; 跨重启持久化"每类型模板" (最近一次的
 * mode/width/dock_side), 新实例以模板深拷贝初始化。v1 全局 schema 自动迁移
 * 为模板, 不会让多个 pane 借旧数据重新共享状态。 */
import type {
  OverlayTargetContext,
  OverlayTargetPolicy,
} from '$lib/overlay/overlay-target.svelte'

export type PanelMode = `docked` | `floating`
export type PanelDockSide = `left` | `right` | `top` | `bottom`

export interface FloatingBounds {
  /** pane 内坐标 (px, 相对 pane 左上角) */
  x: number
  y: number
  width: number
  height: number
}

export interface HostSize {
  w: number
  h: number
}

export interface PanelInstance {
  id: string
  panel_type: string
  /** 所属 pane 的稳定标识 `${tab_id}:${leaf_id}` */
  pane_id: string
  mode: PanelMode
  dock_side: PanelDockSide
  target: OverlayTargetContext | null
  target_policy: OverlayTargetPolicy
  is_open: boolean
  /** 左右停靠的宽度 */
  docked_width: number
  /** 上下停靠的高度 — 与 width 独立记忆 */
  docked_height: number
  floating_bounds: FloatingBounds
  z_index: number
  created_at: number
}

/** 停靠尺寸界限 (pane 作用域): 上限受 60% pane 与视口保底双重约束
 * — 3D 视口永远保住 MIN_VIEWPORT_*, 不被挤没。左右停靠用 width,
 * 上下停靠用 height — 两维独立记忆, 切向不串值 */
export const DOCKED_MIN_WIDTH = 180
export const DOCKED_DEFAULT_WIDTH = 260
export const DOCKED_MAX_WIDTH = 420
export const MIN_VIEWPORT_WIDTH = 160
export const DOCKED_MIN_HEIGHT = 120
export const DOCKED_DEFAULT_HEIGHT = 200
export const DOCKED_MAX_HEIGHT = 360
export const MIN_VIEWPORT_HEIGHT = 160
export const FLOATING_DEFAULT = { width: 340, height: 380 }
export const FLOATING_MIN = { width: 240, height: 200 }
const PAD = 8

const STORAGE_KEY = `catgo:panels`
const STORAGE_VERSION = 2

interface PanelTemplate {
  mode?: PanelMode
  dock_side?: PanelDockSide
  docked_width?: number
  docked_height?: number
  floating_bounds?: Partial<FloatingBounds>
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** 停靠宽度钳位 — host_w 为所在 pane 宽度, 不是窗口宽度 */
export function clamp_docked_width(w: number, host_w: number): number {
  const hi = Math.max(
    DOCKED_MIN_WIDTH,
    Math.min(DOCKED_MAX_WIDTH, host_w * 0.6, host_w - MIN_VIEWPORT_WIDTH),
  )
  return Math.round(clamp(w, DOCKED_MIN_WIDTH, hi))
}

/** 停靠高度钳位 (top/bottom) — host_h 为所在 pane 高度 */
export function clamp_docked_height(h: number, host_h: number): number {
  const hi = Math.max(
    DOCKED_MIN_HEIGHT,
    Math.min(DOCKED_MAX_HEIGHT, host_h * 0.6, host_h - MIN_VIEWPORT_HEIGHT),
  )
  return Math.round(clamp(h, DOCKED_MIN_HEIGHT, hi))
}

/** 悬浮边界钳位 — host 为所在 pane 尺寸; 面板不得跨出 pane */
export function clamp_floating_bounds(
  b: Partial<FloatingBounds>,
  host: HostSize,
): FloatingBounds {
  const width = Math.round(
    clamp(b.width ?? FLOATING_DEFAULT.width, FLOATING_MIN.width, Math.max(FLOATING_MIN.width, host.w - 2 * PAD)),
  )
  const height = Math.round(
    clamp(b.height ?? FLOATING_DEFAULT.height, FLOATING_MIN.height, Math.max(FLOATING_MIN.height, host.h - 2 * PAD)),
  )
  const x = Math.round(clamp(b.x ?? PAD, PAD, Math.max(PAD, host.w - width - PAD)))
  const y = Math.round(clamp(b.y ?? PAD, PAD, Math.max(PAD, host.h - height - PAD)))
  return { x, y, width, height }
}

/** 纯函数解析持久化 JSON (v2 模板; v1 全局 schema 迁移为模板) — 损坏回退默认 */
export function parse_persisted(raw: string | null): Record<string, PanelTemplate> {
  if (!raw) return {}
  try {
    const data = JSON.parse(raw)
    const src = data?.version === STORAGE_VERSION
      ? data.templates
      : data?.version === 1
      ? data.panels // v1 → 模板迁移: 旧全局几何作为新实例初值, 不再共享对象
      : null
    if (!src || typeof src !== `object`) return {}
    const out: Record<string, PanelTemplate> = {}
    for (const [type, p] of Object.entries(src as Record<string, PanelTemplate>)) {
      if (!p || typeof p !== `object`) continue
      const entry: PanelTemplate = {}
      if (p.mode === `docked` || p.mode === `floating`) entry.mode = p.mode
      if (
        p.dock_side === `left` || p.dock_side === `right` ||
        p.dock_side === `top` || p.dock_side === `bottom`
      ) entry.dock_side = p.dock_side
      if (typeof p.docked_width === `number` && Number.isFinite(p.docked_width)) {
        entry.docked_width = Math.round(
          clamp(p.docked_width, DOCKED_MIN_WIDTH, DOCKED_MAX_WIDTH),
        )
      }
      if (typeof p.docked_height === `number` && Number.isFinite(p.docked_height)) {
        entry.docked_height = Math.round(
          clamp(p.docked_height, DOCKED_MIN_HEIGHT, DOCKED_MAX_HEIGHT),
        )
      }
      const fb = p.floating_bounds
      if (
        fb && typeof fb === `object` &&
        [fb.width, fb.height].every((v) => typeof v === `number` && Number.isFinite(v))
      ) {
        entry.floating_bounds = { width: fb.width, height: fb.height }
      }
      out[type] = entry
    }
    return out
  } catch {
    return {}
  }
}

function load_templates(): Record<string, PanelTemplate> {
  if (typeof localStorage === `undefined`) return {}
  return parse_persisted(localStorage.getItem(STORAGE_KEY))
}

const panels = $state<Record<string, PanelInstance>>({})
let z_seq = 10
let id_seq = 0

/** 每类型模板落盘 (最近一次使用的 mode/width/side) — 拖拽结束才调用 */
function persist_template(p: PanelInstance): void {
  if (typeof localStorage === `undefined`) return
  try {
    const templates = load_templates()
    templates[p.panel_type] = {
      mode: p.mode,
      dock_side: p.dock_side,
      docked_width: p.docked_width,
      docked_height: p.docked_height,
      floating_bounds: {
        width: p.floating_bounds.width,
        height: p.floating_bounds.height,
      },
    }
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: STORAGE_VERSION, templates }),
    )
  } catch { /* storage unavailable — non-fatal */ }
}

export function panel_state(): { panels: Record<string, PanelInstance> } {
  return {
    get panels() {
      return panels
    },
  }
}

/** 某 pane 上某类型的实例 (每 (type, pane) 至多一个) */
export function get_pane_panel(panel_type: string, pane_id: string): PanelInstance | null {
  return Object.values(panels)
    .find((p) => p.panel_type === panel_type && p.pane_id === pane_id) ?? null
}

export function panels_for_pane(pane_id: string): PanelInstance[] {
  return Object.values(panels).filter((p) => p.pane_id === pane_id)
}

/** 打开 (或复用) 某 pane 上的面板 — 深拷贝模板初始化, 绝不共享对象引用 */
export function open_panel(args: {
  panel_type: string
  pane_id: string
  target_policy?: OverlayTargetPolicy
  target?: OverlayTargetContext | null
  preferred_mode?: PanelMode
}): PanelInstance {
  const existing = get_pane_panel(args.panel_type, args.pane_id)
  if (existing) {
    existing.is_open = true
    if (args.target !== undefined) existing.target = args.target
    bring_to_front(existing.id)
    return existing
  }
  const tpl = load_templates()[args.panel_type] ?? {}
  id_seq += 1
  const inst: PanelInstance = {
    id: `panel-${id_seq}`,
    panel_type: args.panel_type,
    pane_id: args.pane_id,
    mode: tpl.mode ?? args.preferred_mode ?? `docked`,
    dock_side: tpl.dock_side ?? `left`,
    target: args.target ?? null,
    target_policy: args.target_policy ?? `fixed`,
    is_open: true,
    docked_width: tpl.docked_width ?? DOCKED_DEFAULT_WIDTH,
    docked_height: tpl.docked_height ?? DOCKED_DEFAULT_HEIGHT,
    floating_bounds: {
      x: PAD,
      y: PAD,
      width: tpl.floating_bounds?.width ?? FLOATING_DEFAULT.width,
      height: tpl.floating_bounds?.height ?? FLOATING_DEFAULT.height,
    },
    z_index: ++z_seq,
    created_at: Date.now(),
  }
  panels[inst.id] = inst
  persist_template(inst)
  return inst
}

/** 收起 = 完全退出布局 (宿主只留 reveal 按钮); 实例与内容状态保留 */
export function close_panel(id: string): void {
  const p = panels[id]
  if (!p) return
  p.is_open = false
}

export function toggle_panel(id: string): void {
  const p = panels[id]
  if (!p) return
  p.is_open = !p.is_open
  if (p.is_open) bring_to_front(id)
}

/** 模式切换 — 同一实例只改 mode 与槽位, id/target/内容状态全保留 */
export function set_panel_mode(id: string, mode: PanelMode, host?: HostSize): void {
  const p = panels[id]
  if (!p || p.mode === mode) return
  p.mode = mode
  if (mode === `floating` && host) {
    p.floating_bounds = clamp_floating_bounds(p.floating_bounds, host)
    bring_to_front(id)
  }
  persist_template(p)
}

export function set_dock_side(id: string, side: PanelDockSide): void {
  const p = panels[id]
  if (!p || p.dock_side === side) return
  p.dock_side = side
  persist_template(p)
}

/** 停靠宽度 (host_w = 本 pane 宽度); 拖拽中 commit=false, 结束 commit=true 落盘 */
export function set_docked_width(id: string, width: number, host_w: number, commit = true): void {
  const p = panels[id]
  if (!p) return
  p.docked_width = clamp_docked_width(width, host_w)
  if (commit) persist_template(p)
}

/** 悬浮位置/尺寸 (pane 内坐标, host = 本 pane 尺寸); 释放时 commit=true */
export function set_floating_bounds(
  id: string,
  bounds: Partial<FloatingBounds>,
  host: HostSize,
  commit = true,
): void {
  const p = panels[id]
  if (!p) return
  p.floating_bounds = clamp_floating_bounds({ ...p.floating_bounds, ...bounds }, host)
  if (commit) persist_template(p)
}

/** 停靠高度 (top/bottom; host_h = 本 pane 高度); 释放时 commit=true */
export function set_docked_height(id: string, height: number, host_h: number, commit = true): void {
  const p = panels[id]
  if (!p) return
  p.docked_height = clamp_docked_height(height, host_h)
  if (commit) persist_template(p)
}

export function bring_to_front(id: string): void {
  const p = panels[id]
  if (!p) return
  p.z_index = ++z_seq
}

export function set_panel_target(id: string, target: OverlayTargetContext | null): void {
  const p = panels[id]
  if (!p) return
  p.target = target
}

/** pane 尺寸变化 → 只重新钳位该 pane 的实例 (各 pane 独立 ResizeObserver 调用) */
export function ensure_pane_panels_within(pane_id: string, host: HostSize): void {
  for (const p of panels_for_pane(pane_id)) {
    p.floating_bounds = clamp_floating_bounds(p.floating_bounds, host)
    p.docked_width = clamp_docked_width(p.docked_width, host.w)
    p.docked_height = clamp_docked_height(p.docked_height, host.h)
  }
}

/** pane 被删除 → 清理其全部面板实例 (不留失效 pane_id 状态) */
export function remove_pane_panels(pane_id: string): void {
  for (const p of panels_for_pane(pane_id)) delete panels[p.id]
}

/** tab 被关闭 → 清理该 tab 下所有 pane 的面板实例 */
export function remove_tab_panels(tab_id: string): void {
  for (const p of Object.values(panels)) {
    if (p.pane_id.startsWith(`${tab_id}:`)) delete panels[p.id]
  }
}

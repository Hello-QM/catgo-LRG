/** 双模式工具面板基础设施 — PanelInstance 模型 + 持久化。
 *
 * 面板 (工作流/属性/测量等"工具型面板") 可停靠为左侧持久侧栏 (docked),
 * 也可脱离为可拖拽缩放的悬浮窗 (floating)。两种模式渲染同一个内容组件、
 * 同一个 PanelInstance — 模式切换只换渲染宿主 (DOM reparent), 绝不销毁重建。
 *
 * 目标上下文复用 overlay-target 基础设施 (OverlayTargetContext / 稳定窗口
 * 编号 / 失效判定), 不另造一套。业务操作一律用 instance.target, 禁止提交时
 * 重读全局 current/active。
 *
 * 持久化: 单键 `catgo:panels` 版本化 JSON, 按 panel_type 存
 * {mode, docked_width, floating_bounds, collapsed}; 拖拽结束才 commit,
 * 恢复时逐字段校验越界/损坏回退默认。 */
import type {
  OverlayTargetContext,
  OverlayTargetPolicy,
} from '$lib/overlay/overlay-target.svelte'

export type PanelMode = `docked` | `floating`

export interface FloatingBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface PanelInstance {
  id: string
  panel_type: string
  mode: PanelMode
  target: OverlayTargetContext | null
  target_policy: OverlayTargetPolicy
  is_open: boolean
  is_collapsed: boolean
  docked_width: number
  floating_bounds: FloatingBounds
  z_index: number
  created_at: number
}

export const DOCKED_MIN_WIDTH = 280
export const DOCKED_DEFAULT_WIDTH = 320
export const DOCKED_MAX_WIDTH = 480
export const FLOATING_DEFAULT = { width: 520, height: 430 }
export const FLOATING_MIN = { width: 360, height: 260 }
/** 拖到边缘后必须保留可抓取的标题栏可见量 (px) */
const EDGE_KEEP = 80
const TITLE_KEEP = 40

const STORAGE_KEY = `catgo:panels`
const STORAGE_VERSION = 1

interface PersistedPanel {
  mode?: PanelMode
  docked_width?: number
  floating_bounds?: Partial<FloatingBounds>
  collapsed?: boolean
}

function host_size(): { w: number; h: number } {
  if (typeof window === `undefined`) return { w: 1920, h: 1080 }
  return { w: window.innerWidth, h: window.innerHeight }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** 停靠宽度: [280, min(480, 40% 宿主宽)] — 窗口过窄时上限自动收紧 */
export function clamp_docked_width(w: number, host_w = host_size().w): number {
  const hi = Math.max(DOCKED_MIN_WIDTH, Math.min(DOCKED_MAX_WIDTH, host_w * 0.4))
  return Math.round(clamp(w, DOCKED_MIN_WIDTH, hi))
}

/** 悬浮边界: 尺寸 [360×260, 90% 宿主], 位置保证标题栏始终可见可抓 */
export function clamp_floating_bounds(
  b: Partial<FloatingBounds>,
  host = host_size(),
): FloatingBounds {
  const width = Math.round(
    clamp(b.width ?? FLOATING_DEFAULT.width, FLOATING_MIN.width, host.w * 0.9),
  )
  const height = Math.round(
    clamp(b.height ?? FLOATING_DEFAULT.height, FLOATING_MIN.height, host.h * 0.9),
  )
  const x = Math.round(
    clamp(b.x ?? (host.w - width) / 2, EDGE_KEEP - width, host.w - EDGE_KEEP),
  )
  const y = Math.round(clamp(b.y ?? (host.h - height) / 2, 8, host.h - TITLE_KEEP))
  return { x, y, width, height }
}

/** 纯函数解析持久化 JSON — 损坏/越界一律回退默认 (可单测) */
export function parse_persisted(raw: string | null): Record<string, PersistedPanel> {
  if (!raw) return {}
  try {
    const data = JSON.parse(raw)
    if (data?.version !== STORAGE_VERSION || typeof data.panels !== `object`) return {}
    const out: Record<string, PersistedPanel> = {}
    for (const [type, p] of Object.entries(data.panels as Record<string, PersistedPanel>)) {
      if (!p || typeof p !== `object`) continue
      const entry: PersistedPanel = {}
      if (p.mode === `docked` || p.mode === `floating`) entry.mode = p.mode
      if (typeof p.docked_width === `number` && Number.isFinite(p.docked_width)) {
        entry.docked_width = clamp_docked_width(p.docked_width)
      }
      const fb = p.floating_bounds
      if (
        fb && typeof fb === `object` &&
        [fb.x, fb.y, fb.width, fb.height].every((v) => typeof v === `number` && Number.isFinite(v))
      ) {
        entry.floating_bounds = clamp_floating_bounds(fb as FloatingBounds)
      }
      if (typeof p.collapsed === `boolean`) entry.collapsed = p.collapsed
      out[type] = entry
    }
    return out
  } catch {
    return {}
  }
}

function load_persisted(): Record<string, PersistedPanel> {
  if (typeof localStorage === `undefined`) return {}
  return parse_persisted(localStorage.getItem(STORAGE_KEY))
}

const panels = $state<Record<string, PanelInstance>>({})
let z_seq = 10
let id_seq = 0

function persist(): void {
  if (typeof localStorage === `undefined`) return
  try {
    const out: Record<string, PersistedPanel> = {}
    for (const p of Object.values(panels)) {
      out[p.panel_type] = {
        mode: p.mode,
        docked_width: p.docked_width,
        floating_bounds: p.floating_bounds,
        collapsed: p.is_collapsed,
      }
    }
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: STORAGE_VERSION, panels: out }),
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

export function get_panel_by_type(panel_type: string): PanelInstance | null {
  return Object.values(panels).find((p) => p.panel_type === panel_type) ?? null
}

/** 打开 (或激活) 某类型的面板 — 每类型单实例; 恢复上次模式/尺寸 */
export function open_panel(args: {
  panel_type: string
  target_policy?: OverlayTargetPolicy
  target?: OverlayTargetContext | null
  preferred_mode?: PanelMode
}): PanelInstance {
  const existing = get_panel_by_type(args.panel_type)
  if (existing) {
    existing.is_open = true
    existing.is_collapsed = false
    if (args.target !== undefined) existing.target = args.target
    bring_to_front(existing.id)
    persist()
    return existing
  }
  const saved = load_persisted()[args.panel_type] ?? {}
  id_seq += 1
  const inst: PanelInstance = {
    id: `panel-${id_seq}`,
    panel_type: args.panel_type,
    mode: saved.mode ?? args.preferred_mode ?? `docked`,
    target: args.target ?? null,
    target_policy: args.target_policy ?? `user-selectable`,
    is_open: true,
    is_collapsed: false,
    docked_width: saved.docked_width ?? DOCKED_DEFAULT_WIDTH,
    floating_bounds: clamp_floating_bounds(saved.floating_bounds ?? {}),
    z_index: ++z_seq,
    created_at: Date.now(),
  }
  panels[inst.id] = inst
  persist()
  return inst
}

export function close_panel(id: string): void {
  const p = panels[id]
  if (!p) return
  p.is_open = false
  persist()
}

export function toggle_panel_collapsed(id: string): void {
  const p = panels[id]
  if (!p) return
  p.is_collapsed = !p.is_collapsed
  persist()
}

/** 模式切换 — 同一实例只改 mode 与宿主, id/target/内容状态全保留 */
export function set_panel_mode(id: string, mode: PanelMode): void {
  const p = panels[id]
  if (!p || p.mode === mode) return
  p.mode = mode
  if (mode === `floating`) {
    p.floating_bounds = clamp_floating_bounds(p.floating_bounds)
    bring_to_front(id)
  }
  persist()
}

/** 停靠宽度; 拖拽中 commit=false (只更新), 拖拽结束 commit=true 才落盘 */
export function set_docked_width(id: string, width: number, commit = true): void {
  const p = panels[id]
  if (!p) return
  p.docked_width = clamp_docked_width(width)
  if (commit) persist()
}

/** 悬浮位置/尺寸; 拖拽/缩放过程 commit=false, 释放时 commit=true */
export function set_floating_bounds(
  id: string,
  bounds: Partial<FloatingBounds>,
  commit = true,
): void {
  const p = panels[id]
  if (!p) return
  p.floating_bounds = clamp_floating_bounds({ ...p.floating_bounds, ...bounds })
  if (commit) persist()
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

/** 窗口 resize 后把所有面板重新约束进宿主 (悬浮 clamp + 停靠宽度收紧) */
export function ensure_panels_within_host(): void {
  for (const p of Object.values(panels)) {
    p.floating_bounds = clamp_floating_bounds(p.floating_bounds)
    p.docked_width = clamp_docked_width(p.docked_width)
  }
}

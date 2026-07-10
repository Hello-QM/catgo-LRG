/** 工具栏"自定义"弹窗状态 — v2: 按 pane 独立。
 *
 * 停靠位置 (顶/底/左/右)、各模式勾选集 (视图/编辑工具)、收起状态全部
 * 按 pane_id (`tab:leaf`) 键控 — 四宫格四套配置同存互不影响, API 显式
 * 携带 pane_id, 无全局单例。弹窗开合本就是组件局部状态 (每 pane 自己的
 * StructureToolbar 实例), 天然独立。
 *
 * 持久化: leaf id 会话内随机 → 跨重启存"模板" (沿用原 catgo:toolbar:* 键,
 * 老数据即模板, 含旧扁平清单的并集迁移); 新 pane 以模板深拷贝初始化。 */

const COLLAPSED_KEY = `catgo:toolbar:collapsed`
const HIDDEN_KEY = `catgo:toolbar:hidden-tools`
const DOCK_KEY = `catgo:toolbar:dock`
const HIDDEN_BY_DOCK_KEY = `catgo:toolbar:hidden-by-dock`

export type ToolbarDock = `top` | `bottom` | `left` | `right`

export interface PaneToolbarState {
  collapsed: boolean
  dock: ToolbarDock
  hidden_by_dock: Record<ToolbarDock, string[]>
}

// 每个模式只显示该模式相关的功能: 紧凑横排默认隐去低频工具, 侧边栏默认全量
const DEFAULT_HIDDEN_BY_DOCK: Record<ToolbarDock, string[]> = {
  top: [`gauge`, `molstar`, `plugin_hub`, `upload_hpc`, `fullscreen`],
  bottom: [`gauge`, `molstar`, `plugin_hub`, `upload_hpc`, `fullscreen`],
  left: [],
  right: [],
}

function load_dock(): ToolbarDock {
  if (typeof localStorage === `undefined`) return `right`
  const v = localStorage.getItem(DOCK_KEY)
  return v === `top` || v === `bottom` || v === `left` || v === `right` ? v : `right`
}

function load_legacy_hidden(): string[] {
  if (typeof localStorage === `undefined`) return []
  try {
    const parsed = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? `[]`)
    return Array.isArray(parsed) ? parsed.filter((t) => typeof t === `string`) : []
  } catch {
    return []
  }
}

function load_hidden_by_dock(): Record<ToolbarDock, string[]> {
  const dflt = {
    top: [...DEFAULT_HIDDEN_BY_DOCK.top],
    bottom: [...DEFAULT_HIDDEN_BY_DOCK.bottom],
    left: [...DEFAULT_HIDDEN_BY_DOCK.left],
    right: [...DEFAULT_HIDDEN_BY_DOCK.right],
  }
  if (typeof localStorage === `undefined`) return dflt
  try {
    const raw = localStorage.getItem(HIDDEN_BY_DOCK_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      for (const dock of [`top`, `bottom`, `left`, `right`] as ToolbarDock[]) {
        if (Array.isArray(parsed?.[dock])) {
          dflt[dock] = parsed[dock].filter((t: unknown) => typeof t === `string`)
        }
      }
      return dflt
    }
  } catch { /* fall through to legacy/defaults */ }
  // 迁移: 旧扁平清单并集应用, 保留 top/bottom 紧凑默认
  const legacy = load_legacy_hidden()
  if (legacy.length > 0) {
    return {
      top: [...new Set([...DEFAULT_HIDDEN_BY_DOCK.top, ...legacy])],
      bottom: [...new Set([...DEFAULT_HIDDEN_BY_DOCK.bottom, ...legacy])],
      left: [...legacy],
      right: [...legacy],
    }
  }
  return dflt
}

/** 模板深拷贝 — 新 pane 初始化, 绝不共享对象引用 */
function template(): PaneToolbarState {
  const h = load_hidden_by_dock()
  return {
    collapsed: typeof localStorage !== `undefined` &&
      localStorage.getItem(COLLAPSED_KEY) === `1`,
    dock: load_dock(),
    hidden_by_dock: {
      top: [...h.top],
      bottom: [...h.bottom],
      left: [...h.left],
      right: [...h.right],
    },
  }
}

const states = $state<Record<string, PaneToolbarState>>({})

/** 取 (或按模板创建) 某 pane 的工具栏状态 — 组件 init 期调用 */
export function pane_toolbar(pane_id: string): PaneToolbarState {
  if (!states[pane_id]) states[pane_id] = template()
  return states[pane_id]
}

/** 模板落盘 (最近改动的 pane 即模板; 沿用原键名兼容旧数据) */
function persist_template(s: PaneToolbarState): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, s.collapsed ? `1` : `0`)
    localStorage.setItem(HIDDEN_BY_DOCK_KEY, JSON.stringify(s.hidden_by_dock))
    localStorage.setItem(DOCK_KEY, s.dock)
    localStorage.removeItem(HIDDEN_KEY) // 迁移后清旧键
  } catch { /* localStorage unavailable — non-fatal */ }
}

export function set_toolbar_collapsed(pane_id: string, collapsed: boolean) {
  const s = pane_toolbar(pane_id)
  s.collapsed = collapsed
  persist_template(s)
}

export function toggle_toolbar_tool(pane_id: string, id: string) {
  const s = pane_toolbar(pane_id)
  const cur = s.hidden_by_dock[s.dock]
  s.hidden_by_dock = {
    ...s.hidden_by_dock,
    [s.dock]: cur.includes(id) ? cur.filter((t) => t !== id) : [...cur, id],
  }
  persist_template(s)
}

export function set_toolbar_dock(pane_id: string, dock: ToolbarDock) {
  const s = pane_toolbar(pane_id)
  s.dock = dock
  persist_template(s)
}

/** 该工具在指定 pane 的当前 dock 模式下是否被隐藏 (读 $state, 响应式) */
export function toolbar_tool_hidden(pane_id: string, id: string): boolean {
  const s = pane_toolbar(pane_id)
  return s.hidden_by_dock[s.dock].includes(id)
}

/** pane 删除时清理 (pane-manager / tab-manager 调用) */
export function remove_pane_toolbar(pane_id: string): void {
  delete states[pane_id]
}

export function remove_tab_toolbars(tab_id: string): void {
  for (const key of Object.keys(states)) {
    if (key.startsWith(`${tab_id}:`)) delete states[key]
  }
}

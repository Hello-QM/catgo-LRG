/** 工具栏收起 + 按钮自定义的共享状态。
 *
 * StructureToolbar.svelte(自身按钮)与 Structure.svelte(children 里带
 * 自有 toggle 的面板:OptimizationPane / StructureInfoPane / StructureControls)
 * 都读这份状态,所以"自定义显示哪些按钮"能覆盖整条工具栏。
 * localStorage 持久化;父组件 hidden_toolbar_items 的强制隐藏在组件侧另行合并。 */

const COLLAPSED_KEY = `catgo:toolbar:collapsed`
const HIDDEN_KEY = `catgo:toolbar:hidden-tools`
const DOCK_KEY = `catgo:toolbar:dock`

export type ToolbarDock = `top` | `left` | `right`

function load_dock(): ToolbarDock {
  if (typeof localStorage === `undefined`) return `right`
  const v = localStorage.getItem(DOCK_KEY)
  return v === `top` || v === `left` || v === `right` ? v : `right`
}

function load_hidden(): string[] {
  if (typeof localStorage === `undefined`) return []
  try {
    const parsed = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? `[]`)
    return Array.isArray(parsed) ? parsed.filter((t) => typeof t === `string`) : []
  } catch {
    return []
  }
}

const HIDDEN_BY_DOCK_KEY = `catgo:toolbar:hidden-by-dock`
// 每个模式只显示该模式相关的功能: 紧凑的顶部横排默认隐去低频工具,
// 侧边栏默认全量; 用户在某模式下的勾选只改该模式的集合。
const DEFAULT_HIDDEN_BY_DOCK: Record<ToolbarDock, string[]> = {
  top: [`gauge`, `molstar`, `plugin_hub`, `upload_hpc`, `fullscreen`],
  left: [],
  right: [],
}

function load_hidden_by_dock(): Record<ToolbarDock, string[]> {
  const dflt = {
    top: [...DEFAULT_HIDDEN_BY_DOCK.top],
    left: [...DEFAULT_HIDDEN_BY_DOCK.left],
    right: [...DEFAULT_HIDDEN_BY_DOCK.right],
  }
  if (typeof localStorage === `undefined`) return dflt
  try {
    const raw = localStorage.getItem(HIDDEN_BY_DOCK_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      for (const dock of [`top`, `left`, `right`] as ToolbarDock[]) {
        if (Array.isArray(parsed?.[dock])) {
          dflt[dock] = parsed[dock].filter((t: unknown) => typeof t === `string`)
        }
      }
      return dflt
    }
  } catch { /* fall through to legacy/defaults */ }
  // 迁移: 旧的扁平列表 (catgo:toolbar:hidden-tools) 应用到所有模式
  const legacy = load_hidden()
  if (legacy.length > 0) {
    return { top: [...legacy], left: [...legacy], right: [...legacy] }
  }
  return dflt
}

export const toolbar_state = $state({
  collapsed: typeof localStorage !== `undefined` &&
    localStorage.getItem(COLLAPSED_KEY) === `1`,
  hidden_by_dock: load_hidden_by_dock(),
  dock: load_dock(),
})

function persist() {
  try {
    localStorage.setItem(COLLAPSED_KEY, toolbar_state.collapsed ? `1` : `0`)
    localStorage.setItem(HIDDEN_BY_DOCK_KEY, JSON.stringify(toolbar_state.hidden_by_dock))
    localStorage.setItem(DOCK_KEY, toolbar_state.dock)
  } catch { /* localStorage unavailable — non-fatal */ }
}

export function set_toolbar_collapsed(collapsed: boolean) {
  toolbar_state.collapsed = collapsed
  persist()
}

export function toggle_toolbar_tool(id: string) {
  const dock = toolbar_state.dock
  const cur = toolbar_state.hidden_by_dock[dock]
  toolbar_state.hidden_by_dock = {
    ...toolbar_state.hidden_by_dock,
    [dock]: cur.includes(id) ? cur.filter((t) => t !== id) : [...cur, id],
  }
  persist()
}

export function set_toolbar_dock(dock: ToolbarDock) {
  toolbar_state.dock = dock
  persist()
}

/** 模板里用:该工具在当前 dock 模式下是否被隐藏 (读 $state,响应式) */
export function toolbar_tool_hidden(id: string): boolean {
  return toolbar_state.hidden_by_dock[toolbar_state.dock].includes(id)
}

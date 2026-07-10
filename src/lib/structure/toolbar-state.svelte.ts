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

export const toolbar_state = $state({
  collapsed: typeof localStorage !== `undefined` &&
    localStorage.getItem(COLLAPSED_KEY) === `1`,
  hidden: load_hidden(),
  dock: load_dock(),
})

function persist() {
  try {
    localStorage.setItem(COLLAPSED_KEY, toolbar_state.collapsed ? `1` : `0`)
    localStorage.setItem(HIDDEN_KEY, JSON.stringify(toolbar_state.hidden))
    localStorage.setItem(DOCK_KEY, toolbar_state.dock)
  } catch { /* localStorage unavailable — non-fatal */ }
}

export function set_toolbar_collapsed(collapsed: boolean) {
  toolbar_state.collapsed = collapsed
  persist()
}

export function toggle_toolbar_tool(id: string) {
  toolbar_state.hidden = toolbar_state.hidden.includes(id)
    ? toolbar_state.hidden.filter((t) => t !== id)
    : [...toolbar_state.hidden, id]
  persist()
}

export function set_toolbar_dock(dock: ToolbarDock) {
  toolbar_state.dock = dock
  persist()
}

/** 模板里用:该工具是否被用户隐藏 (读 $state,响应式) */
export function toolbar_tool_hidden(id: string): boolean {
  return toolbar_state.hidden.includes(id)
}

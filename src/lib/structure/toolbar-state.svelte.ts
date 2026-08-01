export const TOOLBAR_GROUPS = [
  { id: `view`, label_key: `structure.toolbar_group_view` },
  { id: `editing`, label_key: `structure.toolbar_group_editing` },
  { id: `analysis`, label_key: `structure.toolbar_group_analysis` },
  { id: `compute`, label_key: `structure.toolbar_group_compute` },
  { id: `assistant`, label_key: `structure.toolbar_group_assistant` },
] as const

export type ToolbarGroupId = typeof TOOLBAR_GROUPS[number][`id`]

export const TOOLBAR_TOOLS = [
  { id: `reset_camera`, group: `view`, label_key: `structure.toolbar_tool_reset_camera` },
  { id: `view_angles`, group: `view`, label_key: `structure.toolbar_tool_view_angles` },
  { id: `fullscreen`, group: `view`, label_key: `structure.toolbar_tool_fullscreen` },
  { id: `info`, group: `view`, label_key: `structure.toolbar_tool_info` },
  { id: `controls`, group: `view`, label_key: `structure.toolbar_tool_controls` },
  { id: `gauge`, group: `view`, label_key: `structure.toolbar_tool_performance` },
  { id: `molstar`, group: `view`, label_key: `structure.toolbar_tool_molstar` },
  { id: `gesture`, group: `editing`, label_key: `structure.toolbar_tool_gesture` },
  { id: `touch`, group: `editing`, label_key: `structure.toolbar_tool_touch` },
  { id: `pencil`, group: `editing`, label_key: `structure.toolbar_tool_draw` },
  { id: `build`, group: `editing`, label_key: `structure.toolbar_tool_build` },
  { id: `optimize`, group: `editing`, label_key: `structure.toolbar_tool_optimize` },
  { id: `analysis`, group: `analysis`, label_key: `structure.toolbar_tool_analysis` },
  { id: `measure`, group: `analysis`, label_key: `structure.toolbar_tool_measure` },
  { id: `workflow`, group: `compute`, label_key: `structure.toolbar_tool_workflow` },
  { id: `server`, group: `compute`, label_key: `structure.toolbar_tool_server` },
  { id: `upload_hpc`, group: `compute`, label_key: `structure.toolbar_tool_upload_hpc` },
  { id: `terminal`, group: `compute`, label_key: `structure.toolbar_tool_terminal` },
  { id: `io`, group: `compute`, label_key: `structure.toolbar_tool_io` },
  { id: `remote_save`, group: `compute`, label_key: `structure.toolbar_tool_remote_save` },
  { id: `chat`, group: `assistant`, label_key: `structure.toolbar_tool_chat` },
  { id: `plugin_hub`, group: `assistant`, label_key: `structure.toolbar_tool_plugin_hub` },
] as const satisfies readonly {
  id: string
  group: ToolbarGroupId
  label_key: string
}[]

export type ToolbarToolId = typeof TOOLBAR_TOOLS[number][`id`]
export type PaneToolbarState = { collapsed: boolean; hidden: ToolbarToolId[] }

const STORAGE_KEY = `catgo:structure-toolbar:v1`
const LEGACY_COLLAPSED_KEY = `catgo:toolbar:collapsed`
const LEGACY_HIDDEN_KEY = `catgo:toolbar:hidden-tools`
const KNOWN_TOOL_IDS = new Set<string>(TOOLBAR_TOOLS.map((tool) => tool.id))
const DEFAULT_STATE: PaneToolbarState = { collapsed: false, hidden: [] }

let pane_states = $state<Record<string, PaneToolbarState>>({})

function filtered_hidden(value: unknown): ToolbarToolId[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item): item is ToolbarToolId =>
    typeof item === `string` && KNOWN_TOOL_IDS.has(item)))]
}

function read_default_state(): PaneToolbarState {
  if (typeof localStorage === `undefined`) return { ...DEFAULT_STATE }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PaneToolbarState>
      return {
        collapsed: parsed.collapsed === true,
        hidden: filtered_hidden(parsed.hidden),
      }
    }

    const legacy_collapsed = localStorage.getItem(LEGACY_COLLAPSED_KEY)
    const legacy_hidden = localStorage.getItem(LEGACY_HIDDEN_KEY)
    if (legacy_collapsed !== null || legacy_hidden !== null) {
      const migrated = {
        collapsed: legacy_collapsed === `true`,
        hidden: filtered_hidden(legacy_hidden ? JSON.parse(legacy_hidden) : []),
      }
      persist_default_state(migrated)
      localStorage.removeItem(LEGACY_COLLAPSED_KEY)
      localStorage.removeItem(LEGACY_HIDDEN_KEY)
      return migrated
    }
  } catch {
    // Invalid or unavailable storage falls back to the product defaults.
  }
  return { ...DEFAULT_STATE }
}

function persist_default_state(state: PaneToolbarState) {
  if (typeof localStorage === `undefined`) return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      collapsed: state.collapsed,
      hidden: state.hidden,
    }))
  } catch {
    // The toolbar remains usable when storage is blocked or full.
  }
}

export function pane_toolbar(pane_key: string): PaneToolbarState {
  return pane_states[pane_key] ?? read_default_state()
}

/** Snapshot the persisted defaults for a pane without doing work during render. */
export function register_toolbar_pane(pane_key: string) {
  if (!pane_states[pane_key]) pane_states[pane_key] = read_default_state()
}

function update_pane(pane_key: string, next: PaneToolbarState) {
  pane_states[pane_key] = next
  persist_default_state(next)
}

export function set_toolbar_collapsed(pane_key: string, collapsed: boolean) {
  register_toolbar_pane(pane_key)
  const current = pane_toolbar(pane_key)
  update_pane(pane_key, { ...current, collapsed })
}

export function set_toolbar_tool_visible(
  pane_key: string,
  tool_id: ToolbarToolId,
  visible: boolean,
) {
  register_toolbar_pane(pane_key)
  const current = pane_toolbar(pane_key)
  const hidden = new Set(current.hidden)
  if (visible) hidden.delete(tool_id)
  else hidden.add(tool_id)
  update_pane(pane_key, { ...current, hidden: [...hidden] })
}

export function toolbar_tool_hidden(pane_key: string, tool_id: ToolbarToolId): boolean {
  return pane_toolbar(pane_key).hidden.includes(tool_id)
}

export function reset_toolbar(pane_key: string) {
  register_toolbar_pane(pane_key)
  update_pane(pane_key, { ...DEFAULT_STATE })
}

/** Test-only reset. Kept exported so state tests do not depend on module reload order. */
export function _reset_toolbar_state_for_test() {
  pane_states = {}
  if (typeof localStorage !== `undefined`) {
    localStorage.removeItem(STORAGE_KEY)
    localStorage.removeItem(LEGACY_COLLAPSED_KEY)
    localStorage.removeItem(LEGACY_HIDDEN_KEY)
  }
}

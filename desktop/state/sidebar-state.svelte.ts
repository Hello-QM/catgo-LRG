/**
 * Sidebar reactive state — extracted from App.svelte.
 * Holds sidebar layout, editor overlay, and preview overlay state.
 */
declare const __CATGO_STATIC_ONLY__: boolean

const SIDEBAR_KEY = `catgo-sidebar`

function load_sidebar_prefs(): { collapsed: boolean; width: number } {
  try {
    const saved = localStorage.getItem(SIDEBAR_KEY)
    if (saved) return JSON.parse(saved)
  } catch {}
  return { collapsed: false, width: 240 }
}

const prefs = typeof window !== `undefined` ? load_sidebar_prefs() : { collapsed: false, width: 240 }

class SidebarState {
  collapsed = $state(prefs.collapsed)
  width = $state(prefs.width)
  source = $state(typeof __CATGO_STATIC_ONLY__ !== `undefined` && __CATGO_STATIC_ONLY__ ? `catgo` : `localdb`)
  is_resizing = $state(false)
  refresh_counter = $state(0)

  // Editor overlay
  editor_open = $state(false)
  editor_content = $state(``)
  editor_filename = $state(``)
  editor_file_path = $state(``)
  editor_session_id = $state(``)
  editor_local_path = $state(``)
  editor_on_save: ((content: string) => void) | null = $state(null)

  // Preview overlay
  preview_open = $state(false)
  preview_mode = $state<'image' | 'pdf' | 'markdown' | 'csv' | 'excel' | 'text'>(`text`)
  preview_content = $state(``)
  preview_binary_data = $state(``)
  preview_mime_type = $state(``)
  preview_filename = $state(``)
  preview_file_path = $state(``)
  preview_session_id = $state(``)

  // Path state shared with export
  hpc_path = $state(`~`)
  fs_path = $state(``)

  /** Persist collapsed/width to localStorage. Call from $effect in App.svelte. */
  persist() {
    try {
      localStorage.setItem(SIDEBAR_KEY, JSON.stringify({ collapsed: this.collapsed, width: this.width }))
    } catch {}
  }
}

export const sidebar = new SidebarState()

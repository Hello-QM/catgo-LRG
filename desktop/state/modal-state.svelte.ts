/**
 * Modal reactive state — extracted from App.svelte.
 */

class ModalState {
  search_visible = $state(false)
  search_provider = $state(``)
  paste_content_visible = $state(false)
  import_target_tab = $state(`structure-1`)
  import_target_pane = $state(0)
  optimade_search_element = $state(``)
  // Close-all dialog
  close_all_visible = $state(false)
  close_all_entries = $state<CloseAllEntry[]>([])
  close_all_saving = $state(false)
  close_all_error = $state(``)
}

export interface CloseAllEntry {
  tab_id: string
  label: string
  pane_idx: number
  formula: string
  save_target: `local` | `hpc` | `database` | `none`
  save_path?: string
  checked: boolean
}

export const modal = new ModalState()

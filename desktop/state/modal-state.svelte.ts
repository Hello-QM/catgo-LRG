/**
 * Modal reactive state — extracted from App.svelte.
 */

interface PreviewDetailRow {
  label: string
  value: string
  mono?: boolean
}

interface PreviewLatticeParams {
  a: number
  b: number
  c: number
  alpha: number
  beta: number
  gamma: number
}

class ModalState {
  search_visible = $state(false)
  search_provider = $state(``)
  paste_content_visible = $state(false)
  import_target_tab = $state(`structure-1`)
  import_target_leaf = $state('')
  optimade_search_element = $state(``)
  // Database import preview
  db_preview_visible = $state(false)
  db_preview_pymatgen = $state<unknown>(null)
  db_preview_title = $state(`Preview Structure Import`)
  db_preview_formula = $state(``)
  db_preview_details = $state<PreviewDetailRow[]>([])
  db_preview_lattice = $state<PreviewLatticeParams | null>(null)
  // Close-all dialog
  close_all_visible = $state(false)
  close_all_entries = $state<CloseAllEntry[]>([])
  close_all_saving = $state(false)
  close_all_error = $state(``)
}

export interface CloseAllEntry {
  tab_id: string
  label: string
  leaf_id: string
  formula: string
  save_target: `local` | `hpc` | `database` | `none`
  save_path?: string
  checked: boolean
}

export const modal = new ModalState()

/**
 * Export / Save dialog reactive state — extracted from App.svelte.
 */

import type { ProjectSummary } from '$lib/api/project'

class ExportState {
  dialog = $state<{ mode: `hpc` | `file` | `project`; filename: string; format: string } | null>(null)
  saving = $state(false)
  error = $state(``)

  /** Structure passed from right-click callback (includes supercell). */
  pending_structure = $state<Record<string, unknown> | null>(null)

  // Filesystem directory picker state
  fs_dir = $state(``)
  fs_items = $state<{ name: string; type: string; path: string }[]>([])
  fs_loading = $state(false)

  // Close-after-export linkage
  close_after = $state<{ tab_id: string; leaf_id: string } | null>(null)

  // Save-on-close state
  close_save_projects = $state<ProjectSummary[]>([])
  close_save_project_id = $state<string | null>(null)
  close_saving = $state(false)
  close_save_target = $state<`project` | `local` | `hpc`>(`project`)
}

export const exp = new ExportState()

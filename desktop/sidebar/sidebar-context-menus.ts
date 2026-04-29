/**
 * 5C: Context menu state and action dispatchers for the localdb sidebar section.
 * Extracted from Sidebar.svelte.
 *
 * Pure functions and state types — no $state here (plain TS file).
 */

import type { CtxTarget } from '../sidebar-data'
import type { DbResult, DbWorkflow } from '../sidebar-data'
import type { LocalFile } from '../sidebar-data'

// --- Context menu open/close helpers (pure functions) ---

export function make_project_target(project_id: string): CtxTarget {
  return { type: `project`, id: project_id }
}

export function make_result_target(result: DbResult, parent_id: string): CtxTarget {
  return { type: `result`, result, parent_id }
}

export function make_workflow_target(wf: DbWorkflow): CtxTarget {
  return { type: `workflow`, wf }
}

export function open_context_menu(
  e: MouseEvent,
  target: CtxTarget,
): { x: number; y: number; target: CtxTarget } {
  e.preventDefault()
  e.stopPropagation()
  return { x: e.clientX, y: e.clientY, target }
}

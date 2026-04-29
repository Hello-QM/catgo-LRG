/**
 * Shared reactive workflow state, keyed per-tab.
 *
 * WorkflowEditor owns all graph state locally. This module exposes a
 * per-tab `WorkflowSlice` so that multiple workflow tabs can coexist
 * without cross-talk: writes in tab A's editor no longer appear in tab B's
 * ChatPane workflow context, MCP workflow pushes land in the tab that
 * originated them, etc.
 *
 * Tab-keying migrates the four state objects that used to be module
 * singletons:
 *   - `active_workflow`            — currently open workflow graph
 *   - `pending_navigate_workflow`  — "open this workflow" signal from MCP
 *   - `workflow_reload_seq`        — counter that nudges the editor to
 *                                    re-fetch after a server-side mutation
 *   - `workflow_events`            — notification queue for CatBot
 *
 * Two state objects stay as genuine globals because they don't benefit
 * from per-tab scoping:
 *   - `pending_open_structure`     — "open this structure in a NEW tab"
 *                                    signal; the source tab is not the
 *                                    destination, so a per-tab queue is
 *                                    meaningless. Kept global.
 *   - `active_project_context`     — "which project are we viewing?" UI
 *                                    singleton; only ProjectDashboard
 *                                    writes it, only the tool executor
 *                                    reads it. Kept global.
 *
 * Callers that used to import `active_workflow` etc. directly now call
 * `get_workflow_slice(tab_id)` and read the slice's fields. For components
 * that don't have a tab_id (legacy / standalone / popout contexts) pass
 * the literal `"default"` — the slice is lazily created on first access.
 */

import { untrack } from 'svelte'
import { SvelteMap } from 'svelte/reactivity'
import type { WorkflowStatus, StepStatus } from './workflow-types'
import type { AnyStructure } from '$lib'

// ─── Slice type ───

export interface ActiveWorkflowNode {
  id: string
  type: string
  label: string
  params: Record<string, unknown>
}

export interface ActiveWorkflowEdge {
  id: string
  from: string
  to: string
}

export interface ActiveWorkflow {
  id: string
  name: string
  status: WorkflowStatus | string
  nodes: ActiveWorkflowNode[]
  edges: ActiveWorkflowEdge[]
  node_statuses: Record<string, StepStatus | string>
  error: string | null
}

export interface WorkflowEvent {
  type: `step_failed` | `step_completed` | `workflow_completed` | `workflow_failed`
  step_id?: string
  step_label?: string
  error?: string
  timestamp: number
}

const EMPTY_WORKFLOW: ActiveWorkflow = {
  id: ``,
  name: ``,
  status: `draft`,
  nodes: [],
  edges: [],
  node_statuses: {},
  error: null,
}

export interface WorkflowSlice {
  /** Currently open workflow graph — written by WorkflowEditor's sync effect. */
  active_workflow: ActiveWorkflow
  /** Navigation signal — tool executor / MCP bridge sets .id, App.svelte watches. */
  pending_navigate_workflow: { id: string }
  /** Reload counter — bumped on MCP writes; WorkflowEditor re-fetches when seq changes. */
  workflow_reload_seq: { seq: number }
  /** Event queue — workflow-execution push()es, ChatPane renders. */
  workflow_events: { queue: WorkflowEvent[] }
}

// ─── Per-tab slice Map ───

/**
 * Using SvelteMap rather than a plain Map so that iteration-based effects
 * (e.g. App.svelte watching `pending_navigate_workflow.id` across all tabs)
 * re-run when slices are added / removed.
 */
const workflow_slices = new SvelteMap<string, WorkflowSlice>()

function make_workflow_slice(): WorkflowSlice {
  // Each field is its own $state container so that changes to one don't
  // invalidate consumers of the others. The container object itself is
  // NOT wrapped in $state — only the fields need reactivity.
  //
  // Svelte 5 rejects `$state(...)` as an object-literal property value
  // (error "state_invalid_placement"): it must be a variable-declaration
  // initializer or a class field. So we bind each reactive container to
  // its own `const` first and then assemble the slice. Returning the
  // proxies preserves their identity — `slice.active_workflow.id = ...`
  // still notifies subscribers.
  const active_workflow: ActiveWorkflow = $state({ ...EMPTY_WORKFLOW })
  const pending_navigate_workflow = $state({ id: `` })
  const workflow_reload_seq = $state({ seq: 0 })
  const workflow_events = $state({ queue: [] as WorkflowEvent[] })
  return {
    active_workflow,
    pending_navigate_workflow,
    workflow_reload_seq,
    workflow_events,
  }
}

// Pre-register the "default" slice so legacy callers that read it inside
// a $derived don't trigger a SvelteMap mutation — Svelte 5 throws
// `state_unsafe_mutation` on $state writes inside derivations.
workflow_slices.set(`default`, make_workflow_slice())

/**
 * Get the slice for a tab. Lazily created on first access with the write
 * wrapped in `untrack` so it's safe to call from inside a `$derived`.
 *
 * In the normal flow, `tab-manager.create_tab` eagerly calls
 * `ensure_workflow_slice(id)` when a tab opens, so App.svelte's fan-in
 * effect picks up the new slice's `pending_navigate_workflow.id` on the
 * very next flush. The lazy path is a safety net for edge cases
 * (popouts, hash-route opens).
 */
export function get_workflow_slice(tab_id: string): WorkflowSlice {
  let slice = workflow_slices.get(tab_id)
  if (!slice) {
    slice = make_workflow_slice()
    const created = slice
    untrack(() => workflow_slices.set(tab_id, created))
  }
  return slice
}

/**
 * Eagerly create a slice for a tab. Safe to call from event handlers and
 * lifecycle callbacks (not inside a $derived). Used by tab-manager to
 * ensure App.svelte's fan-in effect sees the new slice as soon as it
 * becomes addressable.
 */
export function ensure_workflow_slice(tab_id: string): WorkflowSlice {
  let slice = workflow_slices.get(tab_id)
  if (!slice) {
    slice = make_workflow_slice()
    workflow_slices.set(tab_id, slice)
  }
  return slice
}

/** Iterate all slices (used by App.svelte's pending_navigate fan-in effect). */
export function iter_workflow_slices(): IterableIterator<[string, WorkflowSlice]> {
  return workflow_slices.entries()
}

/** Drop a slice when its tab closes. Called by tab-manager.close_tab. */
export function remove_workflow_slice(tab_id: string): void {
  workflow_slices.delete(tab_id)
}

// ─── Slice-scoped mutator helpers ───

export function sync_workflow_state(tab_id: string, data: Partial<ActiveWorkflow>): void {
  Object.assign(get_workflow_slice(tab_id).active_workflow, data)
}

export function clear_workflow_state(tab_id: string): void {
  Object.assign(get_workflow_slice(tab_id).active_workflow, { ...EMPTY_WORKFLOW })
}

export function push_workflow_event(
  tab_id: string,
  event: Omit<WorkflowEvent, 'timestamp'>,
): void {
  const slice = get_workflow_slice(tab_id)
  slice.workflow_events.queue = [
    ...slice.workflow_events.queue,
    { ...event, timestamp: Date.now() },
  ]
}

export function clear_workflow_events(tab_id: string): void {
  get_workflow_slice(tab_id).workflow_events.queue = []
}

// ─── Genuinely global signals (not per-tab) ───

/**
 * "Open this structure in a new tab" signal, set by NodeStatusPanel /
 * EngineTaskEditor / BatchStatusSection, consumed by App.svelte.
 *
 * The *source* tab is not the *destination* tab — the destination is a
 * brand-new structure tab App.svelte creates when it sees a seq bump. So
 * this signal naturally belongs to no single tab. Kept module-global.
 */
export const pending_open_structure = $state<{
  structure: AnyStructure | null
  label: string
  seq: number
}>({ structure: null, label: ``, seq: 0 })

/**
 * Current project the user is viewing (ProjectDashboard). The AI workflow
 * tool executor reads this to auto-assign newly-created workflows to the
 * active project. It's a UI singleton — only one project is "active" at a
 * time across the whole app — so per-tab keying would be meaningless.
 */
export const active_project_context = $state<{ id: string }>({ id: `` })

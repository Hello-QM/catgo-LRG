# Unified Node Monitoring — Implementation Plan

**Date:** 2026-03-29
**Branch:** `split-files`
**Goal:** Merge TaskDetailPanel into NodeStatusPanel so ONE component handles both V1 (GUI-created) workflow steps and V2 (engine-created) tasks. Delete TaskDetailPanel when complete.

## Motivation

Currently two panels exist:
- **NodeStatusPanel.svelte** (1400+ lines) — rich UI: VSCode-style file tree, convergence plots (VASP + ORCA), frequency viewer with vibration animation, force vectors, structure preview, Gibbs calculator, energy diagrams, batch execution, retry/rerun, HPC status
- **TaskDetailPanel.svelte** (~600 lines) — inferior UI: flat file list, basic convergence, crude frequency table, chip-grid params, no force vectors, no structure loading via StepFileTree

Maintaining two panels means every improvement must be done twice. The engine task panel always lags behind.

## Architecture Decision

**Extend NodeStatusPanel** to accept engine tasks via an adapter layer. Do NOT rewrite from scratch.

Key insight: NodeStatusPanel already handles diverse node types (VASP, ORCA, MLP, NEB, IRC, UV-Vis, freq, free_energy, gibbs_energy, surface_energy, batch). Adding engine task support is adding one more data source, not a new UI paradigm.

## Data Shape Comparison

### V1 Step (NodeStatusPanel currently expects)

```typescript
// Identity
node_id: string           // step UUID
workflow_id: string       // V1 workflow UUID
node_type: string         // 'geo_opt', 'freq', etc.
node_label: string        // display name
status: string            // lowercase: 'running', 'completed', 'failed'
node_params: Record       // VASP/ORCA params (ENCUT, EDIFFG, etc.)

// Data fetched internally
step_info: StepInfo       // from api.list_steps() — has result_json, hpc_job_id, etc.
convergence: { points, converged }  // from api.get_convergence()
files: FileEntry[]        // from api.get_step_files()
vasp_freq_data            // from api.get_vasp_frequencies()
```

### V2 Task (TaskDetailPanel currently expects)

```typescript
// Identity
task_id: string           // engine task UUID
task.workflow_id: string  // engine workflow UUID
task.task_type: string    // 'geo_opt', 'freq', etc.
task.name: string | null  // display name
task.status: string       // UPPERCASE: 'RUNNING', 'COMPLETED', 'FAILED'
task.params_json: string  // JSON string of params

// Data fetched internally
convergence: { points, converged }  // from get_engine_task_convergence()
files: TaskFileEntry[]    // from get_engine_task_files()
freq_data                 // from get_engine_task_frequencies()
result: Record            // from get_v2_task_result()
```

### Key Differences to Bridge

| Aspect | V1 Step | V2 Task | Resolution |
|--------|---------|---------|------------|
| Status case | lowercase (`running`) | UPPERCASE (`RUNNING`) | Adapter normalizes to lowercase |
| Params | `node_params` object | `params_json` string | Adapter parses JSON |
| Files API | `get_step_files(wf_id, step_id)` returns `{name,size,modified,permissions}` | `get_engine_task_files(task_id)` returns `{name,path,is_dir,size_bytes,modified_time}` | Adapter normalizes to common shape |
| Convergence API | `get_convergence(wf_id, step_id)` | `get_engine_task_convergence(task_id)` | Same response shape, adapter routes call |
| File content | `get_step_output(wf_id, step_id, filename)` | `get_engine_task_file_content(task_id, path)` | Adapter normalizes |
| Step info | `list_steps()` returns StepInfo with result_json | `get_v2_task()` returns task + parents + children | Adapter builds pseudo-StepInfo |
| Confirm gate | N/A | PENDING_REVIEW status + confirm_engine_task() | New section in NodeStatusPanel |
| Retry | `POST /workflow/{wf}/steps/{step}/retry` | `retry_v2_task(task_id)` | Adapter routes |

---

## Phase 1: API Adapter Layer

**Goal:** Create a unified data-fetching interface that NodeStatusPanel calls instead of directly calling V1 or V2 APIs.

### Task 1.1 — Create `src/lib/api/task-adapter.ts`

**New file:** `src/lib/api/task-adapter.ts`

This module exports functions that accept a `TaskRef` discriminated union and route to the correct API.

```typescript
// src/lib/api/task-adapter.ts
import * as v1 from './workflow'
import * as v2 from './workflow-v2'

// --- Discriminated union for task identity ---

export type TaskRef =
  | { mode: 'step'; workflow_id: string; node_id: string }
  | { mode: 'task'; task_id: string }

// --- Normalized types ---

export interface NormalizedFileEntry {
  name: string
  size: string          // human-readable string (matches V1 format)
  size_bytes: number    // numeric bytes
  modified: string      // ISO timestamp
  is_dir: boolean
  permissions?: string
}

export interface NormalizedConvergence {
  points: v1.ConvergencePoint[]
  converged: boolean
  message?: string
}

export interface NormalizedFileContent {
  path: string
  content: string
}

// --- Adapter functions ---

/** List files in the task's work directory */
export async function get_files(
  ref: TaskRef,
  subdir?: string,
): Promise<{ files: NormalizedFileEntry[]; work_dir: string }> {
  if (ref.mode === 'step') {
    const data = await v1.get_step_files(ref.workflow_id, ref.node_id, subdir)
    return {
      work_dir: data.work_dir ?? '',
      files: (data.files ?? [])
        .filter(f => f.name !== '.' && f.name !== '..')
        .map(f => ({
          name: f.name,
          size: f.size ?? '0',
          size_bytes: parseInt(f.size ?? '0') || 0,
          modified: f.modified ?? '',
          is_dir: f.permissions?.startsWith('d') ?? false,
          permissions: f.permissions,
        })),
    }
  } else {
    const data = await v2.get_engine_task_files(ref.task_id, subdir ?? '')
    return {
      work_dir: data.work_dir ?? data.resolved_path ?? '',
      files: data.files.map(f => ({
        name: f.name,
        size: format_bytes(f.size_bytes),
        size_bytes: f.size_bytes,
        modified: f.modified_time ?? '',
        is_dir: f.is_dir,
      })),
    }
  }
}

/** Get convergence data */
export async function get_convergence(ref: TaskRef): Promise<NormalizedConvergence> {
  if (ref.mode === 'step') {
    return v1.get_convergence(ref.workflow_id, ref.node_id)
  } else {
    const data = await v2.get_engine_task_convergence(ref.task_id)
    return { points: data.points, converged: data.converged, message: data.message }
  }
}

/** Read file content */
export async function get_file_content(
  ref: TaskRef,
  filename: string,
): Promise<NormalizedFileContent> {
  if (ref.mode === 'step') {
    const data = await v1.get_step_output(ref.workflow_id, ref.node_id, filename)
    return { path: filename, content: data.content }
  } else {
    const data = await v2.get_engine_task_file_content(ref.task_id, filename)
    return { path: data.path, content: data.content }
  }
}

/** Write file content */
export async function put_file_content(
  ref: TaskRef,
  filename: string,
  content: string,
): Promise<void> {
  if (ref.mode === 'step') {
    // V1 has no write-back endpoint -- this is a new capability
    throw new Error('File editing not supported for V1 steps (SSH read-only)')
  } else {
    await v2.put_engine_task_file_content(ref.task_id, filename, content)
  }
}

/** Get frequency data */
export async function get_frequencies(ref: TaskRef): Promise<Record<string, unknown>> {
  if (ref.mode === 'step') {
    // V1 uses workflow-level frequency fetch
    // Caller must pass workflow_id via the ref
    const step_ref = ref as { mode: 'step'; workflow_id: string; node_id: string }
    return v1.get_vasp_frequencies(step_ref.workflow_id, step_ref.node_id)
  } else {
    return v2.get_engine_task_frequencies(ref.task_id)
  }
}

/** Retry / rerun from this node */
export async function retry(ref: TaskRef): Promise<{ message: string }> {
  if (ref.mode === 'step') {
    const res = await fetch(
      `${(await import('./config')).API_BASE}/workflow/${ref.workflow_id}/steps/${ref.node_id}/retry`,
      { method: 'POST' },
    )
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail ?? res.statusText)
    const data = await res.json()
    return { message: `Reset ${data.reset_nodes?.length ?? 0} nodes to pending` }
  } else {
    const data = await v2.retry_v2_task(ref.task_id)
    return { message: `Reset ${data.reset_tasks?.length ?? 0} tasks` }
  }
}

/** Cancel a running task (engine only) */
export async function cancel(ref: TaskRef): Promise<void> {
  if (ref.mode === 'step') {
    throw new Error('Cancel not supported for V1 steps')
  } else {
    await v2.cancel_v2_task(ref.task_id)
  }
}

/** Confirm a PENDING_REVIEW task (engine only) */
export async function confirm(ref: TaskRef): Promise<void> {
  if (ref.mode === 'step') {
    throw new Error('Confirm not supported for V1 steps')
  } else {
    await v2.confirm_engine_task(ref.task_id)
  }
}

/** Get ORCA convergence / progress (V1 only — engine uses unified endpoint) */
export async function get_orca_progress(ref: TaskRef): Promise<NormalizedConvergence> {
  if (ref.mode === 'step') {
    return v1.get_orca_progress(ref.workflow_id, ref.node_id)
  } else {
    // Engine tasks use the same convergence endpoint for all software
    return get_convergence(ref)
  }
}

/** Get step results from DB (V1 only — engine has result endpoint) */
export async function get_step_results(ref: TaskRef): Promise<NormalizedConvergence> {
  if (ref.mode === 'step') {
    return v1.get_step_results(ref.workflow_id, ref.node_id)
  } else {
    return get_convergence(ref)
  }
}

// --- Helpers ---

function format_bytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}K`
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`
}
```

### Task 1.2 — Add normalized status helper

Engine tasks use UPPERCASE statuses (`RUNNING`, `COMPLETED`, `FAILED`, `PENDING_REVIEW`). V1 uses lowercase (`running`, `completed`, `failed`). Add to `task-adapter.ts`:

```typescript
/** Normalize engine task status to V1-style lowercase */
export function normalize_status(status: string): string {
  const lower = status.toLowerCase()
  // Map engine-specific statuses to V1 equivalents
  const MAP: Record<string, string> = {
    'remote_error': 'failed',
    'pending_review': 'pending_review',  // new — not in V1
    'waiting': 'pending',
    'ready': 'pending',
    'generating': 'running',
    'uploading': 'running',
    'submitted': 'queued',
    'queued': 'queued',
    'completed_remote': 'running',
    'collecting': 'running',
    'cancelled': 'failed',
    'paused': 'pending',
  }
  return MAP[lower] ?? lower
}
```

### Verification

- `pnpm check` passes with no type errors in the new file
- Import from both NodeStatusPanel and TaskDetailPanel works

---

## Phase 2: NodeStatusPanel Engine Task Support

**Goal:** Make NodeStatusPanel accept either a V1 step or an engine task, using the adapter layer.

### Task 2.1 — Add `mode` prop and engine task identity

**File:** `src/lib/workflow/NodeStatusPanel.svelte`

Change the props interface to accept an optional `mode` and `task_id`:

```typescript
// Add to imports
import type { TaskRef } from '$lib/api/task-adapter'
import * as adapter from '$lib/api/task-adapter'
import { normalize_status } from '$lib/api/task-adapter'
import { get_v2_task, get_v2_task_result, confirm_engine_task, type V2Task } from '$lib/api/workflow-v2'

// Extend props
let {
  // ... existing props ...
  mode = 'step',       // NEW: 'step' (V1) or 'task' (V2 engine)
  task_id,             // NEW: engine task UUID (only when mode='task')
  onconfirm,           // NEW: callback after PENDING_REVIEW confirm
}: {
  // ... existing prop types ...
  mode?: 'step' | 'task'
  task_id?: string
  onconfirm?: () => void
} = $props()
```

### Task 2.2 — Build TaskRef from props

Add a derived `task_ref` that the adapter functions use:

```typescript
const task_ref = $derived<TaskRef>(
  mode === 'task' && task_id
    ? { mode: 'task', task_id }
    : { mode: 'step', workflow_id, node_id }
)
```

### Task 2.3 — Engine task metadata loading

When `mode === 'task'`, we don't have `step_info` from `api.list_steps()`. Instead, load the V2 task object and build a pseudo-StepInfo:

```typescript
// Engine task state
let engine_task = $state<V2Task | null>(null)
let engine_result = $state<Record<string, unknown> | null>(null)

// In fetch_data(), add engine task branch:
if (mode === 'task' && task_id) {
  try {
    const data = await get_v2_task(task_id)
    engine_task = data.task

    // Build pseudo-StepInfo from engine task
    step_info = {
      id: task_id,
      workflow_id: data.task.workflow_id,
      node_id: task_id,
      node_type: data.task.task_type,
      status: normalize_status(data.task.status),
      hpc_job_id: data.task.hpc_job_id ?? undefined,
      work_dir: data.task.work_dir ?? undefined,
      started_at: data.task.created_at ?? undefined,
      result_json: null,  // engine stores results separately
      error_message: data.task.error_message ?? undefined,
    } as StepInfo

    // Load result for completed tasks
    if (data.task.status === 'COMPLETED') {
      try {
        engine_result = await get_v2_task_result(task_id)
        // Inject result_json into step_info for cached_summary
        if (engine_result) {
          step_info = { ...step_info, result_json: JSON.stringify(engine_result) } as StepInfo
        }
      } catch { engine_result = null }
    }
  } catch (err) {
    if (gen !== fetch_gen) return
    fetch_error = String(err)
  }
}
```

### Task 2.4 — Replace direct API calls with adapter

In `fetch_data()`, replace:

```typescript
// BEFORE (V1 only):
api.get_step_files(workflow_id, node_id).then(data => { ... })

// AFTER (unified):
adapter.get_files(task_ref).then(data => {
  if (gen !== fetch_gen) return
  if (data?.files?.length > 0) {
    files = data.files
    work_dir = data.work_dir
    _files_cache.set(effective_id, { files, work_dir })
  }
}).catch(...)
```

Similarly for convergence:

```typescript
// BEFORE:
api.get_convergence(workflow_id, node_id)

// AFTER:
adapter.get_convergence(task_ref)
```

And for ORCA progress:

```typescript
// BEFORE:
api.get_orca_progress(workflow_id, node_id)

// AFTER:
adapter.get_orca_progress(task_ref)
```

### Task 2.5 — Override node_type/node_label from engine task

When `mode === 'task'`, derive `node_type` and `node_label` from the engine task:

```typescript
// Effective values (engine task overrides props if available)
const effective_node_type = $derived(
  mode === 'task' && engine_task ? engine_task.task_type : node_type
)
const effective_node_label = $derived(
  mode === 'task' && engine_task
    ? (engine_task.name ?? engine_task.task_type)
    : node_label
)
const effective_status = $derived(
  mode === 'task' && engine_task
    ? normalize_status(engine_task.status)
    : status
)
const effective_node_params = $derived.by(() => {
  if (mode === 'task' && engine_task?.params_json) {
    try { return JSON.parse(engine_task.params_json) } catch { return {} }
  }
  return node_params ?? {}
})
const effective_id = $derived(mode === 'task' ? task_id ?? '' : node_id)
```

Then replace all references to `node_type`, `node_label`, `status`, `node_params`, and `node_id` in the template with the `effective_*` versions. This is the largest mechanical change but is straightforward find-and-replace.

### Task 2.6 — PENDING_REVIEW confirmation UI

Add a new section in the template, after the header and before the main body:

```svelte
<!-- PENDING_REVIEW gate (engine tasks only) -->
{#if mode === 'task' && engine_task?.status === 'PENDING_REVIEW'}
  <div class="sp-section sp-review-banner">
    <div class="sp-review-message">
      Verify structure and parameters before submitting to HPC.
    </div>
    <button
      class="sp-confirm-btn"
      onclick={async () => {
        if (!task_id) return
        confirming_task = true
        try {
          await adapter.confirm(task_ref)
          onconfirm?.()
          // Refresh data
          const gen = ++fetch_gen
          fetch_data(gen)
        } catch (e) {
          fetch_error = String(e)
        } finally {
          confirming_task = false
        }
      }}
      disabled={confirming_task}
    >
      {confirming_task ? 'Confirming...' : 'Confirm & Submit'}
    </button>
  </div>
{/if}
```

Add state: `let confirming_task = $state(false)`

### Task 2.7 — Cancel button for engine tasks

Add alongside the existing "Rerun from here" button:

```svelte
{#if mode === 'task' && engine_task && !['COMPLETED', 'FAILED', 'CANCELLED'].includes(engine_task.status)}
  <div class="sp-section">
    <button class="sp-cancel-button" onclick={async () => {
      try {
        await adapter.cancel(task_ref)
        const gen = ++fetch_gen
        fetch_data(gen)
      } catch (e) { fetch_error = String(e) }
    }}>
      Cancel Task
    </button>
  </div>
{/if}
```

### Task 2.8 — Engine task result display

For engine tasks, show the result object (energy, structure, etc.) similar to TaskDetailPanel's result section. Reuse cached_summary when result_json is injected (Task 2.3), which means the existing VASP/ORCA result display sections already work.

For engine-specific result fields not covered by cached_summary, add a fallback:

```svelte
{#if mode === 'task' && engine_result && !cached_summary.energy && !cached_summary.energy_eh}
  <div class="sp-section">
    <div class="sp-section-title">Result</div>
    <div class="sp-info-grid">
      {#each Object.entries(engine_result) as [k, v]}
        {#if k !== 'task_id' && k !== 'workflow_id' && k !== 'structure_json'}
          <div class="sp-info-row">
            <span class="sp-info-label">{k}</span>
            <span class="sp-info-value mono">{format_result_value(v)}</span>
          </div>
        {/if}
      {/each}
    </div>
  </div>
{/if}
```

### Task 2.9 — Engine task structure preview

Engine tasks store structures in `params_json.structure` (input) and `result.structure_json` (output). Add structure buttons for engine tasks:

```svelte
{#if mode === 'task'}
  {@const input_str = effective_node_params.structure}
  {@const output_str = engine_result?.structure_json}
  {#if input_str || output_str}
    <div class="sp-section">
      <div class="sp-section-title">Structure</div>
      <div class="sp-structure-row">
        {#if input_str && is_structure_string(input_str)}
          <button class="sp-struct-btn" onclick={() => open_structure_from_string(input_str)}>
            Input Structure
          </button>
        {/if}
        {#if output_str && is_structure_string(output_str)}
          <button class="sp-struct-btn" onclick={() => open_structure_from_string(output_str)}>
            Output Structure
          </button>
        {/if}
      </div>
    </div>
  {/if}
{/if}
```

The `open_structure_from_string` helper parses JSON or POSCAR and sets `pending_open_structure` (same pattern TaskDetailPanel uses).

### Verification

- NodeStatusPanel renders correctly for V1 steps (existing behavior unchanged)
- NodeStatusPanel renders engine tasks with: status badge, convergence plot, file tree, retry/cancel/confirm
- `pnpm check` passes

---

## Phase 3: StepFileTree Enhancement

**Goal:** Make StepFileTree work for both V1 and V2 tasks; add file transfer progress and better editing.

### Task 3.1 — Accept custom fetch function prop

**File:** `src/lib/workflow/StepFileTree.svelte`

Currently StepFileTree imports `* as api from '$lib/api/workflow'` and calls `api.get_step_files()` directly. Change it to accept an optional fetch function:

```typescript
// Add to props
let {
  // ... existing props ...
  fetch_files,     // NEW: custom file fetcher (for engine tasks)
  fetch_subdir,    // NEW: custom subdirectory fetcher
}: {
  // ... existing types ...
  fetch_files?: (subdir?: string) => Promise<{ files: FileEntry[]; work_dir: string }>
  fetch_subdir?: (dir_name: string) => Promise<FileEntry[]>
} = $props()
```

When `fetch_files` is provided, use it instead of the hardcoded V1 API call. When not provided, fall back to existing behavior (backward compatible).

### Task 3.2 — File transfer loading indicator

**File:** `src/lib/workflow/StepFileTree.svelte`

Add a loading state for individual file views:

```svelte
{#if file_loading}
  <div class="sft-file-loading">
    <div class="sft-spinner"></div>
    <span>Loading file...</span>
  </div>
{/if}
```

CSS for spinner:

```css
.sft-spinner {
  width: 16px; height: 16px;
  border: 2px solid #333;
  border-top-color: #3b82f6;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
```

### Task 3.3 — NodeStatusPanel passes adapter to StepFileTree

In NodeStatusPanel, when rendering StepFileTree for engine tasks, pass the adapter-based fetch:

```svelte
<StepFileTree
  {files}
  work_dir={effective_work_dir}
  status={effective_status}
  node_id={effective_id}
  workflow_id={mode === 'task' ? '' : workflow_id}
  bind:poll_enabled
  bind:poll_interval_ms
  bind:expanded_dirs
  fetch_files={mode === 'task' ? (subdir) => adapter.get_files(task_ref, subdir).then(d => ({
    files: d.files.map(f => ({ ...f, is_dir: f.is_dir })),
    work_dir: d.work_dir,
  })) : undefined}
  onview_file={onview_file ? (id, name) => onview_file!(effective_id, name) : undefined}
  onload_structure={onload_structure ? (id, name) => onload_structure!(effective_id, name) : undefined}
  ondownload={ondownload ? (id, name) => ondownload!(effective_id, name) : undefined}
  onrefresh={manual_refresh}
/>
```

### Verification

- StepFileTree works for V1 steps (no regression)
- StepFileTree works for engine tasks when fetch_files is provided
- Loading spinner shows during file fetch

---

## Phase 4: DAG Viewer Enhancements

**Goal:** Show inline information on DAG nodes (energy, progress, species).

### Task 4.1 — Fetch task results for inline display

**File:** `src/lib/workflow/WorkflowDAGViewer.svelte`

After loading the DAG, batch-fetch results for completed tasks:

```typescript
// After load()
let task_results = $state<Map<string, Record<string, unknown>>>(new Map())

async function load_results() {
  const completed = tasks.filter(t => t.status === 'COMPLETED')
  // Fetch in parallel, max 10 concurrent
  const batch_size = 10
  for (let i = 0; i < completed.length; i += batch_size) {
    const batch = completed.slice(i, i + batch_size)
    const results = await Promise.allSettled(
      batch.map(t => get_v2_task_result(t.id).then(r => [t.id, r] as const))
    )
    for (const r of results) {
      if (r.status === 'fulfilled') {
        task_results.set(r.value[0], r.value[1])
        task_results = new Map(task_results) // trigger reactivity
      }
    }
  }
}
```

Call `load_results()` after `load()` completes.

### Task 4.2 — Show energy on completed nodes

In the SVG node rendering, add an energy label:

```svelte
<!-- After status text line -->
{@const result = task_results.get(task.id)}
{#if result?.energy !== undefined}
  <text x={NW / 2} y={50} fill="#22c55e" font-size="10" text-anchor="middle" font-family="monospace">
    {(result.energy as number).toFixed(4)} eV
  </text>
{:else if result?.energy_ev !== undefined}
  <text x={NW / 2} y={50} fill="#22c55e" font-size="10" text-anchor="middle" font-family="monospace">
    {(result.energy_ev as number).toFixed(4)} eV
  </text>
{:else}
  <!-- Existing status text -->
  <text x={NW / 2} y={50} fill="var(--text-color-dim, #999)" font-size="10" text-anchor="middle">
    {task.status}
  </text>
{/if}
```

### Task 4.3 — Show species on adsorbate_place nodes

Parse the task params to extract the adsorbate species:

```svelte
{#if task.name}
  <text x={NW / 2} y={64} fill="var(--text-color-dim, #888)" font-size="9" text-anchor="middle">
    {task.name}
  </text>
{:else}
  <!-- Try to extract species from params -->
  {@const species = (() => {
    if (task.task_type !== 'adsorbate_place') return null
    try {
      const p = JSON.parse(task.params_json ?? '{}')
      return p.adsorbate_species ?? p.species ?? p.adsorbate ?? null
    } catch { return null }
  })()}
  {#if species}
    <text x={NW / 2} y={64} fill="#34d399" font-size="10" text-anchor="middle" font-weight="600">
      {species}
    </text>
  {/if}
{/if}
```

### Task 4.4 — Workflow progress bar

Add a progress bar to the confirm-all bar area:

```svelte
{@const status_counts = (() => {
  const c = { total: tasks.length, completed: 0, running: 0, failed: 0, pending: 0 }
  for (const t of tasks) {
    if (t.task_type.startsWith('__')) continue  // skip control nodes
    if (t.status === 'COMPLETED') c.completed++
    else if (t.status === 'RUNNING' || t.status === 'QUEUED' || t.status === 'SUBMITTED') c.running++
    else if (t.status === 'FAILED' || t.status === 'REMOTE_ERROR') c.failed++
    else c.pending++
  }
  return c
})()}

<div class="wf-progress-bar">
  <div class="wf-progress-fill completed" style="width:{status_counts.completed / status_counts.total * 100}%"></div>
  <div class="wf-progress-fill running" style="width:{status_counts.running / status_counts.total * 100}%"></div>
  <div class="wf-progress-fill failed" style="width:{status_counts.failed / status_counts.total * 100}%"></div>
</div>
<div class="wf-progress-label">
  {status_counts.completed}/{status_counts.total} tasks complete
  {#if status_counts.running > 0} | {status_counts.running} running{/if}
  {#if status_counts.failed > 0} | {status_counts.failed} failed{/if}
</div>
```

### Task 4.5 — Batch retry all failed

Add a "Retry All Failed" button next to "Confirm All":

```svelte
{@const has_failed = tasks.some(t => t.status === 'FAILED' || t.status === 'REMOTE_ERROR')}
{#if has_failed}
  <button class="retry-all-btn" onclick={retry_all_failed} disabled={retrying_all}>
    {retrying_all ? 'Retrying...' : 'Retry All Failed'}
  </button>
{/if}
```

Implementation:

```typescript
let retrying_all = $state(false)

async function retry_all_failed() {
  retrying_all = true
  try {
    const failed = tasks.filter(t => t.status === 'FAILED' || t.status === 'REMOTE_ERROR')
    await Promise.allSettled(failed.map(t => retry_v2_task(t.id)))
    await load()
  } catch (e: any) {
    error = e.message
  } finally {
    retrying_all = false
  }
}
```

Import `retry_v2_task` from `$lib/api/workflow-v2`.

### Verification

- Completed nodes show energy values
- adsorbate_place nodes show species (OH, O, OOH)
- Progress bar reflects workflow completion
- "Retry All Failed" resets all failed tasks
- No performance issues (results fetched lazily)

---

## Phase 5: NodeStatusPanel Polish

**Goal:** Improve parameter display and add desktop notifications.

### Task 5.1 — VASP parameter form (engine tasks)

For engine tasks, TaskDetailPanel currently shows params as a chip grid or raw JSON. Replace with labeled form fields:

```svelte
{#if mode === 'task' && Object.keys(vasp_param_entries).length > 0}
  <div class="sp-section">
    <div class="sp-section-title">
      VASP Parameters
      {#if can_edit_params}
        <button class="sp-edit-btn" onclick={() => editing_engine_params = true}>Edit</button>
      {/if}
    </div>
    {#if editing_engine_params}
      <div class="sp-param-form">
        {#each Object.entries(vasp_param_entries) as [key, value]}
          <div class="sp-param-field">
            <label class="sp-param-label">{key}</label>
            <input
              class="sp-param-input"
              value={String(value)}
              onchange={(e) => { edited_params[key] = parse_param_value(e.currentTarget.value) }}
            />
          </div>
        {/each}
        <div class="sp-param-actions">
          <button class="sp-save-btn" onclick={save_engine_params}>Save</button>
          <button class="sp-cancel-btn" onclick={() => editing_engine_params = false}>Cancel</button>
        </div>
      </div>
    {:else}
      <div class="sp-param-grid">
        {#each Object.entries(vasp_param_entries) as [key, value]}
          <div class="sp-param-row">
            <span class="sp-param-key">{key}</span>
            <span class="sp-param-val">{String(value)}</span>
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/if}
```

The `vasp_param_entries` derived separates VASP keys from structure blobs:

```typescript
const VASP_KEYS = new Set([
  'ENCUT', 'EDIFF', 'EDIFFG', 'NSW', 'IBRION', 'ISIF', 'ISMEAR', 'SIGMA',
  'PREC', 'ALGO', 'LREAL', 'LWAVE', 'LCHARG', 'NELM', 'NELMIN', 'NCORE',
  'KPAR', 'ISPIN', 'MAGMOM', 'LDAU', 'LDAUU', 'LDAUJ', 'LDAUL', 'IVDW',
  'GGA', 'METAGGA', 'LASPH', 'LORBIT', 'NEDOS', 'EMIN', 'EMAX',
])

const vasp_param_entries = $derived.by(() => {
  const entries: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(effective_node_params)) {
    if (k === 'structure') continue
    if (VASP_KEYS.has(k.toUpperCase())) entries[k] = v
  }
  return entries
})
```

### Task 5.2 — Desktop notifications

Add notification support for job completion/failure. Only fires when the browser tab is not focused:

```typescript
// In the auto-refresh effect or WebSocket handler:
function notify_job_event(status: string, label: string) {
  if (document.hasFocus()) return
  if (!('Notification' in window)) return
  if (Notification.permission === 'default') {
    Notification.requestPermission()
    return
  }
  if (Notification.permission !== 'granted') return

  const title = status === 'completed'
    ? `Job completed: ${label}`
    : `Job failed: ${label}`
  const icon = status === 'completed' ? undefined : undefined
  new Notification(title, {
    body: `CatGo workflow node "${label}" ${status}`,
    tag: `catgo-${effective_id}`,  // prevents duplicate notifications
  })
}
```

Call this when status transitions to completed or failed (compare previous status in the polling effect).

### Task 5.3 — Request notification permission on first workflow view

**File:** `src/lib/workflow/WorkflowEditor.svelte` (or wherever the workflow view mounts)

```typescript
import { onMount } from 'svelte'
onMount(() => {
  if ('Notification' in window && Notification.permission === 'default') {
    // Don't prompt immediately — wait until user starts a run
  }
})

// In the "Run" button handler:
if ('Notification' in window && Notification.permission === 'default') {
  Notification.requestPermission()
}
```

### Verification

- VASP params display as labeled rows, not JSON
- Param editing works for engine tasks in WAITING/READY/PAUSED status
- Desktop notification fires when job completes while tab is backgrounded

---

## Phase 6: Cleanup

**Goal:** Delete TaskDetailPanel and update all imports.

### Task 6.1 — Update workflow-v2 page

**File:** `src/routes/workflow-v2/+page.svelte`

Replace TaskDetailPanel with NodeStatusPanel:

```svelte
<!-- BEFORE -->
<script>
  import TaskDetailPanel from '$lib/workflow/TaskDetailPanel.svelte'
</script>
<TaskDetailPanel task_id={selected_task} onclose={() => { selected_task = null }} onload_structure={handle_load_structure} />

<!-- AFTER -->
<script>
  import NodeStatusPanel from '$lib/workflow/NodeStatusPanel.svelte'
</script>
{#if selected_task}
  <NodeStatusPanel
    mode="task"
    task_id={selected_task}
    node_id={selected_task}
    node_type=""
    node_label=""
    workflow_id={selected_wf ?? ''}
    onload_structure={(id, filename) => {
      // Use the structure loading from WorkflowDAGViewer
    }}
  />
{:else}
  <div class="empty-panel">
    <div class="empty-icon">Select a task node to view details.</div>
  </div>
{/if}
```

### Task 6.2 — Update WorkflowDAGViewer if it references TaskDetailPanel

Check if WorkflowDAGViewer imports or references TaskDetailPanel. Currently it does not -- it only emits `onselect_task` for the parent to handle. No change needed.

### Task 6.3 — Delete TaskDetailPanel

```bash
git rm src/lib/workflow/TaskDetailPanel.svelte
```

### Task 6.4 — Search for stale references

```bash
grep -r "TaskDetailPanel" src/ --include="*.svelte" --include="*.ts"
```

Fix any remaining imports.

### Verification

- `pnpm check` passes with zero errors
- workflow-v2 page renders engine tasks using NodeStatusPanel
- All existing V1 workflow functionality unchanged
- TaskDetailPanel.svelte is gone from the repo

---

## Implementation Order & Estimated Effort

| Phase | Tasks | Estimated LOC Changed | Risk |
|-------|-------|----------------------|------|
| 1: API Adapter | 1.1 - 1.2 | ~200 new | Low — new file, no existing code touched |
| 2: NodeStatusPanel Props | 2.1 - 2.9 | ~150 modified, ~100 new | Medium — touching the 1400-line file |
| 3: StepFileTree | 3.1 - 3.3 | ~50 modified | Low — backward compatible |
| 4: DAG Viewer | 4.1 - 4.5 | ~150 new | Low — additive changes |
| 5: Polish | 5.1 - 5.3 | ~100 new | Low — new sections |
| 6: Cleanup | 6.1 - 6.4 | ~30 modified, -600 deleted | Low — straightforward replacement |

**Total: ~780 lines changed/added, ~600 lines deleted. Net: ~180 lines added.**

## Recommended Execution Sequence

1. **Phase 1** first (adapter layer) — foundation for everything else
2. **Phase 2** next (NodeStatusPanel engine support) — the core change
3. **Phase 3** (StepFileTree) — can be done in parallel with Phase 2
4. **Phase 6** (cleanup) — immediately after Phase 2 is verified
5. **Phase 4** (DAG enhancements) — independent, can be done anytime
6. **Phase 5** (polish) — independent, can be done anytime

Phases 4 and 5 are independent of each other and of Phase 6. They can be done in any order or in parallel.

## Key Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Breaking existing V1 NodeStatusPanel | All engine-task code is gated behind `mode === 'task'`. Default mode is `'step'`. Zero behavior change when `mode` is not set. |
| Status case mismatch causing broken display | `normalize_status()` handles all known engine statuses. Unknown statuses pass through as lowercase. |
| StepFileTree breaking with new fetch function | `fetch_files` prop is optional. When undefined, StepFileTree uses existing V1 behavior. |
| Engine task params_json too large for display | Skip `structure` key in param display (already done in current code). |
| Notification permission denied | Graceful degradation — no notification, no error. |

## Files Modified (Summary)

New:
- `src/lib/api/task-adapter.ts`

Modified:
- `src/lib/workflow/NodeStatusPanel.svelte` (props + engine task sections)
- `src/lib/workflow/StepFileTree.svelte` (optional fetch function prop)
- `src/lib/workflow/WorkflowDAGViewer.svelte` (inline info + batch ops)
- `src/routes/workflow-v2/+page.svelte` (use NodeStatusPanel instead of TaskDetailPanel)

Deleted:
- `src/lib/workflow/TaskDetailPanel.svelte`

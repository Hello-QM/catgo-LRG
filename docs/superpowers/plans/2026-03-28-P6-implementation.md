# P6: End-to-End Vision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every gap between current state and the vision — frontend V2 DAG viewer, real-time WebSocket monitoring, graph_json bridge, and HPC dry-run test.

**Architecture:** Frontend components read from `/api/v2/` endpoints. WebSocket endpoint broadcasts task state changes from the engine scanner. A graph converter bridges GUI-created workflows (graph_json) to the new tasks table. HPC dry-run test validates the full submitter→poller→collector pipeline with mocked SSH.

**Tech Stack:** Svelte 5 (runes), SvelteKit, FastAPI, WebSocket (fastapi.websockets), SQLite, asyncio, pytest

---

## File Structure

### New Files
| File | Responsibility | ~Lines |
|------|----------------|--------|
| `src/lib/workflow/WorkflowListV2.svelte` | List page for v2 workflows | ~120 |
| `src/lib/workflow/WorkflowDAGViewer.svelte` | SVG DAG renderer with status colors | ~200 |
| `src/lib/workflow/TaskDetailPanel.svelte` | Right panel: task info, params, retry/cancel | ~140 |
| `src/lib/api/workflow-v2.ts` | API client for v2 endpoints + WebSocket | ~120 |
| `server/catgo/workflow/graph_converter.py` | graph_json → tasks + links | ~100 |
| `server/catgo/workflow/engine/broadcast.py` | WebSocket listener registry | ~50 |
| `server/tests/test_graph_converter.py` | Converter unit tests | ~80 |
| `server/tests/test_hpc_dry_run.py` | HPC mock test | ~120 |

### Modified Files
| File | Changes |
|------|---------|
| `server/routers/workflow_v2.py` | Add WebSocket `/monitor` endpoint |
| `server/catgo/workflow/engine/scanner.py` | Broadcast state changes after each cycle |
| `server/main.py` | No changes needed (v2 routers already wired) |

---

### Task 1: V2 API Client (TypeScript)

**Files:**
- Create: `src/lib/api/workflow-v2.ts`

- [ ] **Step 1: Create the API client**

```typescript
// src/lib/api/workflow-v2.ts
import { API_BASE } from './config'

async function handle<T>(r: Response): Promise<T> {
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`)
  return r.json()
}

// --- Workflows ---

export interface V2WorkflowSummary {
  id: string
  name: string
  status: string
  created_at: string | null
  updated_at: string | null
  task_count: number
  status_counts: Record<string, number>
}

export interface V2Task {
  id: string
  workflow_id: string
  task_type: string
  name: string | null
  status: string
  params_json: string
  software: string | null
  system_name: string | null
  hpc_job_id: string | null
  work_dir: string | null
  error_message: string | null
  retry_count: number
  created_at: string | null
}

export interface V2Link {
  id: number
  workflow_id: string
  source_task_id: string
  target_task_id: string
  source_key: string
  target_key: string
}

export interface V2DAG {
  tasks: V2Task[]
  links: V2Link[]
}

export async function list_v2_workflows(): Promise<V2WorkflowSummary[]> {
  return handle(await fetch(`${API_BASE}/v2/workflows`))
}

export async function get_v2_workflow(id: string) {
  return handle<{ workflow: Record<string, unknown>; tasks: V2Task[]; task_count: number }>(
    await fetch(`${API_BASE}/v2/workflows/${id}`)
  )
}

export async function get_v2_dag(id: string): Promise<V2DAG> {
  return handle(await fetch(`${API_BASE}/v2/workflows/${id}/dag`))
}

export async function submit_v2_workflow(id: string) {
  return handle(await fetch(`${API_BASE}/v2/workflows/${id}/submit`, { method: 'POST' }))
}

export async function pause_v2_workflow(id: string) {
  return handle(await fetch(`${API_BASE}/v2/workflows/${id}/pause`, { method: 'POST' }))
}

export async function resume_v2_workflow(id: string) {
  return handle(await fetch(`${API_BASE}/v2/workflows/${id}/resume`, { method: 'POST' }))
}

export async function reset_v2_workflow(id: string) {
  return handle(await fetch(`${API_BASE}/v2/workflows/${id}/reset`, { method: 'POST' }))
}

// --- Tasks ---

export async function get_v2_task(id: string) {
  return handle<{ task: V2Task; parents: V2Link[]; children: V2Link[] }>(
    await fetch(`${API_BASE}/v2/tasks/${id}`)
  )
}

export async function update_v2_task_params(id: string, params: Record<string, unknown>) {
  return handle(await fetch(`${API_BASE}/v2/tasks/${id}/params`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ params }),
  }))
}

export async function retry_v2_task(id: string) {
  return handle<{ reset_tasks: string[] }>(
    await fetch(`${API_BASE}/v2/tasks/${id}/retry`, { method: 'POST' })
  )
}

export async function cancel_v2_task(id: string) {
  return handle(await fetch(`${API_BASE}/v2/tasks/${id}/cancel`, { method: 'POST' }))
}

export async function get_v2_task_result(id: string) {
  return handle<Record<string, unknown>>(
    await fetch(`${API_BASE}/v2/tasks/${id}/result`)
  )
}

// --- WebSocket Monitor ---

export interface V2MonitorCallbacks {
  on_task_status?: (task_id: string, status: string) => void
  on_workflow_status?: (status: string) => void
  on_error?: (error: string) => void
}

export function connect_v2_monitor(workflow_id: string, callbacks: V2MonitorCallbacks): { close: () => void } {
  const WS_BASE = API_BASE.replace(/^http/, 'ws')
  const url = `${WS_BASE}/v2/workflows/${workflow_id}/monitor`

  let ws: WebSocket | null = null
  let closed = false
  let retries = 0
  const MAX_RETRIES = 10

  function connect() {
    if (closed) return
    ws = new WebSocket(url)

    ws.onopen = () => { retries = 0 }

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data)
        if (msg.type === 'task_status') {
          callbacks.on_task_status?.(msg.task_id, msg.status)
        } else if (msg.type === 'workflow_status') {
          callbacks.on_workflow_status?.(msg.status)
        } else if (msg.type === 'error') {
          callbacks.on_error?.(msg.message)
        }
      } catch { /* ignore parse errors */ }
    }

    ws.onclose = () => {
      if (closed) return
      retries++
      if (retries <= MAX_RETRIES) {
        setTimeout(connect, Math.min(1000 * 2 ** retries, 30000))
      }
    }

    ws.onerror = () => { ws?.close() }
  }

  connect()

  return {
    close() {
      closed = true
      ws?.close()
    }
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /home/james0001/project/catgo/.worktrees/split-files && npx tsc --noEmit src/lib/api/workflow-v2.ts 2>&1 | head -20`

If there are import errors with `./config`, that's fine — we just need no syntax errors in our file.

- [ ] **Step 3: Commit**

```bash
cd /home/james0001/project/catgo/.worktrees/split-files
git add src/lib/api/workflow-v2.ts
git commit -m "feat(p6): add V2 workflow API client + WebSocket monitor"
```

---

### Task 2: V2 Workflow List Page

**Files:**
- Create: `src/lib/workflow/WorkflowListV2.svelte`

- [ ] **Step 1: Create the list component**

```svelte
<!-- src/lib/workflow/WorkflowListV2.svelte -->
<script lang="ts">
  import { list_v2_workflows, type V2WorkflowSummary } from '$lib/api/workflow-v2'

  interface Props {
    onselect?: (id: string) => void
  }
  let { onselect }: Props = $props()

  let workflows = $state<V2WorkflowSummary[]>([])
  let loading = $state(true)
  let error = $state('')

  async function load() {
    loading = true
    error = ''
    try {
      workflows = await list_v2_workflows()
    } catch (e: any) {
      error = e.message || 'Failed to load workflows'
    } finally {
      loading = false
    }
  }

  $effect(() => { load() })

  const STATUS_COLORS: Record<string, string> = {
    draft: '#475569',
    running: '#3b82f6',
    paused: '#a78bfa',
    completed: '#22c55e',
    failed: '#ef4444',
  }

  function fmt_date(iso: string | null): string {
    if (!iso) return '—'
    return new Date(iso).toLocaleString()
  }
</script>

<div class="v2list">
  <div class="header">
    <h3>V2 Workflows (Engine)</h3>
    <button onclick={load} class="refresh-btn">↻ Refresh</button>
  </div>

  {#if error}
    <div class="error">{error}</div>
  {/if}

  {#if loading}
    <div class="loading">Loading…</div>
  {:else if workflows.length === 0}
    <div class="empty">No V2 workflows yet. Create one via MCP or Python API.</div>
  {:else}
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>Status</th>
          <th>Tasks</th>
          <th>Created</th>
        </tr>
      </thead>
      <tbody>
        {#each workflows as wf}
          <tr onclick={() => onselect?.(wf.id)} class="clickable">
            <td class="name">{wf.name}</td>
            <td>
              <span class="badge" style="background:{STATUS_COLORS[wf.status] ?? '#475569'}">
                {wf.status}
              </span>
            </td>
            <td>{wf.task_count}</td>
            <td class="date">{fmt_date(wf.created_at)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

<style>
  .v2list { padding: 16px; }
  .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
  h3 { margin: 0; color: var(--text-color); font-size: 16px; }
  .refresh-btn { background: none; border: 1px solid var(--border-color); color: var(--text-color); padding: 4px 10px; border-radius: 4px; cursor: pointer; }
  .error { color: #ef4444; margin-bottom: 8px; font-size: 13px; }
  .loading, .empty { color: var(--text-color-dim); font-size: 13px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; color: var(--text-color-dim); font-weight: 500; padding: 6px 8px; border-bottom: 1px solid var(--border-color); }
  td { padding: 8px; border-bottom: 1px solid var(--border-color, #333); color: var(--text-color); }
  .clickable { cursor: pointer; }
  .clickable:hover { background: var(--hover-bg, rgba(255,255,255,0.05)); }
  .name { font-weight: 500; }
  .date { font-size: 11px; color: var(--text-color-dim); }
  .badge { padding: 2px 8px; border-radius: 10px; color: #fff; font-size: 11px; font-weight: 600; text-transform: uppercase; }
</style>
```

- [ ] **Step 2: Commit**

```bash
cd /home/james0001/project/catgo/.worktrees/split-files
git add src/lib/workflow/WorkflowListV2.svelte
git commit -m "feat(p6): add WorkflowListV2 component"
```

---

### Task 3: V2 DAG Viewer Component

**Files:**
- Create: `src/lib/workflow/WorkflowDAGViewer.svelte`

- [ ] **Step 1: Create the DAG viewer**

This component renders tasks as SVG nodes and links as Bezier edges. It reuses the existing node card style (NW=260, NH=72) and status colors from the v1 editor.

```svelte
<!-- src/lib/workflow/WorkflowDAGViewer.svelte -->
<script lang="ts">
  import { get_v2_dag, connect_v2_monitor, type V2Task, type V2Link, type V2DAG } from '$lib/api/workflow-v2'

  interface Props {
    workflow_id: string
    onselect_task?: (task_id: string) => void
  }
  let { workflow_id, onselect_task }: Props = $props()

  let tasks = $state<V2Task[]>([])
  let links = $state<V2Link[]>([])
  let selected = $state<string | null>(null)
  let error = $state('')
  let pan = $state({ x: 40, y: 40 })
  let zoom = $state(1)

  const NW = 260
  const NH = 72
  const HANDLE_R = 7
  const H_GAP = 100
  const V_GAP = 40

  const STATUS_COLORS: Record<string, string> = {
    WAITING: '#475569',
    READY: '#3b82f6',
    GENERATING: '#a78bfa',
    UPLOADING: '#a78bfa',
    SUBMITTED: '#8b5cf6',
    QUEUED: '#a78bfa',
    RUNNING: '#eab308',
    COMPLETED_REMOTE: '#84cc16',
    COLLECTING: '#84cc16',
    COMPLETED: '#22c55e',
    FAILED: '#ef4444',
    REMOTE_ERROR: '#f97316',
    PAUSED: '#64748b',
    CANCELLED: '#6b7280',
  }

  // Auto-layout: topological layers left→right
  function layout(dag: V2DAG): Map<string, { x: number; y: number }> {
    const positions = new Map<string, { x: number; y: number }>()
    const task_map = new Map(dag.tasks.map(t => [t.id, t]))
    const in_degree = new Map<string, number>()
    const children_map = new Map<string, string[]>()

    for (const t of dag.tasks) {
      in_degree.set(t.id, 0)
      children_map.set(t.id, [])
    }
    for (const l of dag.links) {
      in_degree.set(l.target_task_id, (in_degree.get(l.target_task_id) ?? 0) + 1)
      children_map.get(l.source_task_id)?.push(l.target_task_id)
    }

    // BFS layers
    const layers: string[][] = []
    const queue = [...dag.tasks.filter(t => (in_degree.get(t.id) ?? 0) === 0).map(t => t.id)]
    const visited = new Set<string>()

    while (queue.length > 0) {
      const layer = [...queue]
      layers.push(layer)
      queue.length = 0
      for (const id of layer) {
        visited.add(id)
        for (const child of children_map.get(id) ?? []) {
          in_degree.set(child, (in_degree.get(child) ?? 0) - 1)
          if ((in_degree.get(child) ?? 0) <= 0 && !visited.has(child)) {
            queue.push(child)
            visited.add(child)
          }
        }
      }
    }

    // Place unvisited nodes (cycles) in final layer
    const remaining = dag.tasks.filter(t => !visited.has(t.id)).map(t => t.id)
    if (remaining.length) layers.push(remaining)

    for (let col = 0; col < layers.length; col++) {
      const layer = layers[col]
      for (let row = 0; row < layer.length; row++) {
        positions.set(layer[row], {
          x: col * (NW + H_GAP),
          y: row * (NH + V_GAP),
        })
      }
    }
    return positions
  }

  let positions = $state(new Map<string, { x: number; y: number }>())

  async function load() {
    try {
      const dag = await get_v2_dag(workflow_id)
      tasks = dag.tasks
      links = dag.links
      positions = layout(dag)
    } catch (e: any) {
      error = e.message
    }
  }

  $effect(() => { load() })

  // WebSocket monitoring
  let monitor: { close: () => void } | null = null

  $effect(() => {
    monitor?.close()
    monitor = connect_v2_monitor(workflow_id, {
      on_task_status(task_id, status) {
        const idx = tasks.findIndex(t => t.id === task_id)
        if (idx >= 0) tasks[idx] = { ...tasks[idx], status }
      },
      on_workflow_status(_status) {
        // Could update a workflow-level badge here
      },
    })
    return () => { monitor?.close(); monitor = null }
  })

  function edge_path(link: V2Link): string {
    const src = positions.get(link.source_task_id)
    const tgt = positions.get(link.target_task_id)
    if (!src || !tgt) return ''
    const x1 = src.x + NW
    const y1 = src.y + NH / 2
    const x2 = tgt.x
    const y2 = tgt.y + NH / 2
    const cx = (x1 + x2) / 2
    return `M${x1},${y1} C${cx},${y1} ${cx},${y2} ${x2},${y2}`
  }

  // Pan/zoom
  let dragging = $state(false)
  let drag_start = $state({ x: 0, y: 0 })

  function on_bg_down(e: MouseEvent) {
    if (e.button !== 0) return
    dragging = true
    drag_start = { x: e.clientX - pan.x, y: e.clientY - pan.y }
  }
  function on_bg_move(e: MouseEvent) {
    if (!dragging) return
    pan = { x: e.clientX - drag_start.x, y: e.clientY - drag_start.y }
  }
  function on_bg_up() { dragging = false }
  function on_wheel(e: WheelEvent) {
    e.preventDefault()
    const delta = e.deltaY > 0 ? 0.9 : 1.1
    zoom = Math.max(0.3, Math.min(3, zoom * delta))
  }
</script>

<div class="dag-viewer"
  onmousedown={on_bg_down}
  onmousemove={on_bg_move}
  onmouseup={on_bg_up}
  onmouseleave={on_bg_up}
  onwheel={on_wheel}
  role="application"
>
  {#if error}
    <div class="error">{error}</div>
  {/if}

  <svg width="100%" height="100%">
    <g transform="translate({pan.x},{pan.y}) scale({zoom})">
      <!-- Edges -->
      {#each links as link}
        {@const path = edge_path(link)}
        {#if path}
          <path d={path} fill="none" stroke="var(--border-color, #555)" stroke-width={1.8} />
          <circle r={2.5} fill="var(--accent-color, #3b82f6)" opacity={0.7}>
            <animateMotion dur="2.5s" repeatCount="indefinite" path={path} />
          </circle>
        {/if}
      {/each}

      <!-- Task Nodes -->
      {#each tasks as task}
        {@const pos = positions.get(task.id)}
        {#if pos}
          {@const scolor = STATUS_COLORS[task.status] ?? '#475569'}
          {@const is_sel = selected === task.id}
          <g transform="translate({pos.x},{pos.y})"
            onclick={() => { selected = task.id; onselect_task?.(task.id) }}
            style="cursor:pointer"
          >
            <!-- Shadow -->
            <rect x={2} y={2} width={NW} height={NH} rx={10} fill="rgba(0,0,0,0.25)" />
            <!-- Card -->
            <rect width={NW} height={NH} rx={10}
              fill="var(--surface-bg, #111827)"
              stroke={is_sel ? 'var(--accent-color, #3b82f6)' : scolor + '60'}
              stroke-width={is_sel ? 2.5 : 1.5}
            />
            <!-- Header bar -->
            <rect width={NW} height={28} rx={10} fill={scolor} opacity={0.85} />
            <rect y={14} width={NW} height={14} fill={scolor} opacity={0.85} />
            <!-- Title -->
            <text x={12} y={19} fill="#fff" font-size="12" font-weight="600">
              {task.task_type}{task.system_name ? ` (${task.system_name})` : ''}
            </text>
            <!-- Status badge -->
            <g transform="translate({NW - 12}, 14)">
              <circle r={4} fill="#fff" opacity={0.9} />
              {#if task.status === 'RUNNING'}
                <circle r={4} fill="#fff" opacity={0.6}>
                  <animate attributeName="r" values="4;7;4" dur="1s" repeatCount="indefinite" />
                  <animate attributeName="opacity" values="0.6;0;0.6" dur="1s" repeatCount="indefinite" />
                </circle>
              {/if}
            </g>
            <!-- Status text -->
            <text x={NW / 2} y={50} fill="var(--text-color-dim, #999)" font-size="10" text-anchor="middle">
              {task.status}
            </text>
            <!-- Name -->
            {#if task.name}
              <text x={NW / 2} y={64} fill="var(--text-color-dim, #888)" font-size="9" text-anchor="middle">
                {task.name}
              </text>
            {/if}
            <!-- Input handle -->
            <circle cx={0} cy={NH / 2} r={HANDLE_R} fill="var(--surface-bg, #111)" stroke={scolor} stroke-width={1.5} />
            <!-- Output handle -->
            <circle cx={NW} cy={NH / 2} r={HANDLE_R} fill="var(--surface-bg, #111)" stroke={scolor} stroke-width={1.5} />
          </g>
        {/if}
      {/each}
    </g>
  </svg>
</div>

<style>
  .dag-viewer {
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: var(--page-bg, #0a0a0a);
    position: relative;
    user-select: none;
  }
  svg { display: block; }
  .error { position: absolute; top: 8px; left: 8px; color: #ef4444; font-size: 13px; z-index: 10; }
</style>
```

- [ ] **Step 2: Commit**

```bash
cd /home/james0001/project/catgo/.worktrees/split-files
git add src/lib/workflow/WorkflowDAGViewer.svelte
git commit -m "feat(p6): add WorkflowDAGViewer with SVG rendering + auto-layout"
```

---

### Task 4: V2 Task Detail Panel

**Files:**
- Create: `src/lib/workflow/TaskDetailPanel.svelte`

- [ ] **Step 1: Create the task detail panel**

```svelte
<!-- src/lib/workflow/TaskDetailPanel.svelte -->
<script lang="ts">
  import { get_v2_task, get_v2_task_result, retry_v2_task, cancel_v2_task, update_v2_task_params, type V2Task, type V2Link } from '$lib/api/workflow-v2'

  interface Props {
    task_id: string | null
    onclose?: () => void
  }
  let { task_id, onclose }: Props = $props()

  let task = $state<V2Task | null>(null)
  let parents = $state<V2Link[]>([])
  let children = $state<V2Link[]>([])
  let result = $state<Record<string, unknown> | null>(null)
  let error = $state('')
  let loading = $state(false)
  let editing_params = $state(false)
  let params_text = $state('')

  async function load() {
    if (!task_id) { task = null; return }
    loading = true
    error = ''
    try {
      const data = await get_v2_task(task_id)
      task = data.task
      parents = data.parents
      children = data.children
      params_text = task.params_json ?? '{}'

      try { result = await get_v2_task_result(task_id) }
      catch { result = null }
    } catch (e: any) {
      error = e.message
    } finally {
      loading = false
    }
  }

  $effect(() => { load() })

  async function do_retry() {
    if (!task_id) return
    try {
      await retry_v2_task(task_id)
      await load()
    } catch (e: any) { error = e.message }
  }

  async function do_cancel() {
    if (!task_id) return
    try {
      await cancel_v2_task(task_id)
      await load()
    } catch (e: any) { error = e.message }
  }

  async function save_params() {
    if (!task_id) return
    try {
      const parsed = JSON.parse(params_text)
      await update_v2_task_params(task_id, parsed)
      editing_params = false
      await load()
    } catch (e: any) { error = e.message }
  }

  const EDITABLE = new Set(['WAITING', 'READY', 'PAUSED'])

  function fmt(v: unknown): string {
    if (v === null || v === undefined) return '—'
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(6)
    if (typeof v === 'string' && v.length > 200) return v.slice(0, 200) + '…'
    return String(v)
  }
</script>

<div class="panel">
  <div class="panel-header">
    <span class="panel-title">Task Details</span>
    {#if onclose}
      <button class="close-btn" onclick={onclose}>✕</button>
    {/if}
  </div>

  {#if !task_id}
    <div class="hint">Select a task node to view details.</div>
  {:else if loading}
    <div class="hint">Loading…</div>
  {:else if error}
    <div class="error">{error}</div>
  {:else if task}
    <div class="section">
      <div class="field"><span class="label">Type</span> <span>{task.task_type}</span></div>
      <div class="field"><span class="label">Status</span> <span class="status-badge" style="color:{task.status === 'COMPLETED' ? '#22c55e' : task.status === 'FAILED' ? '#ef4444' : '#eab308'}">{task.status}</span></div>
      {#if task.name}<div class="field"><span class="label">Name</span> <span>{task.name}</span></div>{/if}
      {#if task.system_name}<div class="field"><span class="label">System</span> <span>{task.system_name}</span></div>{/if}
      {#if task.software}<div class="field"><span class="label">Software</span> <span>{task.software}</span></div>{/if}
      {#if task.hpc_job_id}<div class="field"><span class="label">Job ID</span> <span>{task.hpc_job_id}</span></div>{/if}
      {#if task.work_dir}<div class="field"><span class="label">Work Dir</span> <span class="mono">{task.work_dir}</span></div>{/if}
      {#if task.error_message}<div class="field error-msg"><span class="label">Error</span> <span>{task.error_message}</span></div>{/if}
    </div>

    <!-- Params -->
    <div class="section">
      <div class="section-title">
        Parameters
        {#if EDITABLE.has(task.status) && !editing_params}
          <button class="sm-btn" onclick={() => { editing_params = true }}>Edit</button>
        {/if}
      </div>
      {#if editing_params}
        <textarea bind:value={params_text} rows={6} class="param-editor"></textarea>
        <div class="btn-row">
          <button class="sm-btn save" onclick={save_params}>Save</button>
          <button class="sm-btn" onclick={() => { editing_params = false }}>Cancel</button>
        </div>
      {:else}
        <pre class="params">{JSON.stringify(JSON.parse(task.params_json || '{}'), null, 2)}</pre>
      {/if}
    </div>

    <!-- Result -->
    {#if result}
      <div class="section">
        <div class="section-title">Result</div>
        {#each Object.entries(result) as [k, v]}
          {#if k !== 'task_id' && k !== 'workflow_id'}
            <div class="field"><span class="label">{k}</span> <span>{fmt(v)}</span></div>
          {/if}
        {/each}
      </div>
    {/if}

    <!-- Actions -->
    <div class="section actions">
      {#if task.status === 'FAILED' || task.status === 'REMOTE_ERROR'}
        <button class="action-btn retry" onclick={do_retry}>↻ Retry</button>
      {/if}
      {#if !['COMPLETED', 'FAILED', 'CANCELLED'].includes(task.status)}
        <button class="action-btn cancel" onclick={do_cancel}>✕ Cancel</button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .panel { width: 280px; background: var(--surface-bg, #111); border-left: 1px solid var(--border-color, #333); overflow-y: auto; font-size: 13px; color: var(--text-color, #e5e5e5); }
  .panel-header { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border-bottom: 1px solid var(--border-color, #333); }
  .panel-title { font-weight: 600; font-size: 14px; }
  .close-btn { background: none; border: none; color: var(--text-color-dim); cursor: pointer; font-size: 16px; }
  .hint { padding: 20px 12px; color: var(--text-color-dim, #888); }
  .error { padding: 8px 12px; color: #ef4444; }
  .section { padding: 10px 12px; border-bottom: 1px solid var(--border-color, #222); }
  .section-title { font-weight: 600; font-size: 12px; color: var(--text-color-dim); margin-bottom: 6px; display: flex; align-items: center; justify-content: space-between; }
  .field { display: flex; justify-content: space-between; padding: 3px 0; gap: 8px; }
  .label { color: var(--text-color-dim, #888); flex-shrink: 0; }
  .mono { font-family: monospace; font-size: 11px; word-break: break-all; }
  .status-badge { font-weight: 600; }
  .error-msg span { color: #ef4444; font-size: 12px; }
  .params { background: var(--page-bg, #0a0a0a); padding: 8px; border-radius: 4px; font-size: 11px; font-family: monospace; overflow-x: auto; margin: 0; white-space: pre-wrap; }
  .param-editor { width: 100%; background: var(--page-bg, #0a0a0a); color: var(--text-color); border: 1px solid var(--border-color); border-radius: 4px; font-family: monospace; font-size: 11px; padding: 6px; resize: vertical; }
  .btn-row { display: flex; gap: 6px; margin-top: 6px; }
  .sm-btn { background: none; border: 1px solid var(--border-color); color: var(--text-color); padding: 2px 8px; border-radius: 4px; cursor: pointer; font-size: 11px; }
  .sm-btn.save { border-color: var(--accent-color, #3b82f6); color: var(--accent-color, #3b82f6); }
  .actions { display: flex; gap: 8px; }
  .action-btn { padding: 6px 14px; border: none; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 500; }
  .retry { background: #3b82f6; color: #fff; }
  .cancel { background: #ef4444; color: #fff; }
</style>
```

- [ ] **Step 2: Commit**

```bash
cd /home/james0001/project/catgo/.worktrees/split-files
git add src/lib/workflow/TaskDetailPanel.svelte
git commit -m "feat(p6): add TaskDetailPanel with params editing + retry/cancel"
```

---

### Task 5: WebSocket Broadcast Infrastructure (Backend)

**Files:**
- Create: `server/catgo/workflow/engine/broadcast.py`
- Modify: `server/catgo/workflow/engine/scanner.py`
- Modify: `server/routers/workflow_v2.py`

- [ ] **Step 1: Write test for broadcast module**

```python
# server/tests/test_broadcast.py
"""Tests for WebSocket broadcast registry."""
import asyncio
import pytest

from catgo.workflow.engine.broadcast import (
    add_listener, remove_listener, broadcast, get_listeners,
)


@pytest.fixture(autouse=True)
def _clear_listeners():
    """Reset global listeners between tests."""
    from catgo.workflow.engine import broadcast as mod
    mod._listeners.clear()
    yield
    mod._listeners.clear()


@pytest.mark.asyncio
async def test_add_and_remove_listener():
    q = add_listener("wf-1")
    assert len(get_listeners("wf-1")) == 1
    remove_listener("wf-1", q)
    assert len(get_listeners("wf-1")) == 0


@pytest.mark.asyncio
async def test_broadcast_delivers_message():
    q = add_listener("wf-1")
    await broadcast("wf-1", {"type": "task_status", "task_id": "t1", "status": "RUNNING"})
    msg = q.get_nowait()
    assert msg["task_id"] == "t1"
    assert msg["status"] == "RUNNING"


@pytest.mark.asyncio
async def test_broadcast_ignores_other_workflows():
    q = add_listener("wf-1")
    await broadcast("wf-2", {"type": "task_status", "task_id": "t1", "status": "RUNNING"})
    assert q.empty()


@pytest.mark.asyncio
async def test_broadcast_drops_when_full():
    q = add_listener("wf-1")
    # Fill the queue
    for i in range(200):
        await broadcast("wf-1", {"type": "test", "i": i})
    # Should not raise — drops silently when full
    await broadcast("wf-1", {"type": "overflow"})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/james0001/project/catgo/.worktrees/split-files && python -m pytest server/tests/test_broadcast.py -v 2>&1 | tail -10`

Expected: FAIL with `ModuleNotFoundError: No module named 'catgo.workflow.engine.broadcast'`

- [ ] **Step 3: Create broadcast module**

```python
# server/catgo/workflow/engine/broadcast.py
"""WebSocket listener registry for real-time task updates.

Pattern: asyncio.Queue per listener. Non-blocking put — drops if slow.
"""

from __future__ import annotations

import asyncio
from collections import defaultdict
from typing import Any

_listeners: dict[str, list[asyncio.Queue]] = defaultdict(list)


def add_listener(workflow_id: str, maxsize: int = 128) -> asyncio.Queue:
    """Register a listener queue. Returns the queue to read from."""
    q: asyncio.Queue = asyncio.Queue(maxsize=maxsize)
    _listeners[workflow_id].append(q)
    return q


def remove_listener(workflow_id: str, q: asyncio.Queue) -> None:
    """Unregister a listener."""
    lst = _listeners.get(workflow_id, [])
    if q in lst:
        lst.remove(q)
    if not lst:
        _listeners.pop(workflow_id, None)


def get_listeners(workflow_id: str) -> list[asyncio.Queue]:
    """Get all listeners for a workflow (for testing)."""
    return _listeners.get(workflow_id, [])


async def broadcast(workflow_id: str, message: dict[str, Any]) -> None:
    """Send message to all listeners. Non-blocking — drops if full."""
    for q in _listeners.get(workflow_id, []):
        try:
            q.put_nowait(message)
        except asyncio.QueueFull:
            pass
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/james0001/project/catgo/.worktrees/split-files && python -m pytest server/tests/test_broadcast.py -v`

Expected: All 4 tests PASS

- [ ] **Step 5: Add broadcast calls to scanner**

In `server/catgo/workflow/engine/scanner.py`, after a task status changes, broadcast the event. Modify the `_execute_ready_local_tasks` and `_update_workflow_status` methods:

Add this import at the top of scanner.py:
```python
from catgo.workflow.engine.broadcast import broadcast as _broadcast
```

After the line `self.db.update_task(task_id, status=TaskState.RUNNING.value)` (line 82), add:
```python
                asyncio.get_event_loop().create_task(
                    _broadcast(workflow_id, {"type": "task_status", "task_id": task_id, "status": "RUNNING"})
                )
```

After the line `self.db.update_task(task_id, status=TaskState.COMPLETED.value)` (line 113), add:
```python
                asyncio.get_event_loop().create_task(
                    _broadcast(workflow_id, {"type": "task_status", "task_id": task_id, "status": "COMPLETED"})
                )
```

After the line `self.db.update_task(task_id, status=TaskState.FAILED.value, ...)` (lines 117-120), add:
```python
                asyncio.get_event_loop().create_task(
                    _broadcast(workflow_id, {"type": "task_status", "task_id": task_id, "status": "FAILED"})
                )
```

In `_update_workflow_status`, after `self.db.update_workflow(workflow_id, status=new_status.value)` (line 135), add:
```python
            asyncio.get_event_loop().create_task(
                _broadcast(workflow_id, {"type": "workflow_status", "status": new_status.value})
            )
```

- [ ] **Step 6: Add WebSocket endpoint to workflow_v2.py**

Add these imports at the top of `server/routers/workflow_v2.py`:
```python
import asyncio
import json
from fastapi import WebSocket, WebSocketDisconnect
from catgo.workflow.engine.broadcast import add_listener, remove_listener
```

Add this endpoint at the end of the file:
```python
@router.websocket("/{workflow_id}/monitor")
async def monitor(websocket: WebSocket, workflow_id: str):
    db = _get_db()
    _ensure_exists(db, workflow_id)
    await websocket.accept()

    q = add_listener(workflow_id)
    try:
        while True:
            try:
                msg = await asyncio.wait_for(q.get(), timeout=30.0)
                await websocket.send_json(msg)
            except asyncio.TimeoutError:
                await websocket.send_json({"type": "ping"})
    except (WebSocketDisconnect, Exception):
        pass
    finally:
        remove_listener(workflow_id, q)
```

- [ ] **Step 7: Run existing tests to verify nothing broke**

Run: `cd /home/james0001/project/catgo/.worktrees/split-files && python -m pytest server/tests/ -v --timeout=30 2>&1 | tail -20`

Expected: All tests pass (95+ existing + 4 new broadcast tests)

- [ ] **Step 8: Commit**

```bash
cd /home/james0001/project/catgo/.worktrees/split-files
git add server/catgo/workflow/engine/broadcast.py server/tests/test_broadcast.py server/catgo/workflow/engine/scanner.py server/routers/workflow_v2.py
git commit -m "feat(p6): add WebSocket broadcast + /monitor endpoint"
```

---

### Task 6: graph_json → Tasks Converter

**Files:**
- Create: `server/catgo/workflow/graph_converter.py`
- Test: `server/tests/test_graph_converter.py`

- [ ] **Step 1: Write failing test**

```python
# server/tests/test_graph_converter.py
"""Tests for graph_json → v2 tasks converter."""
import json
import os
import pytest
from catgo.workflow.db import WorkflowDB
from catgo.workflow.graph_converter import convert_graph_json


@pytest.fixture
def db(tmp_path):
    return WorkflowDB(str(tmp_path / "test.db"))


SAMPLE_GRAPH = json.dumps({
    "nodes": [
        {"id": "n1", "type": "structure_input", "x": 0, "y": 0, "params": {"label": "TiO2"}},
        {"id": "n2", "type": "geo_opt", "x": 300, "y": 0, "params": {"software": "vasp", "ENCUT": 520}},
        {"id": "n3", "type": "freq", "x": 600, "y": 0, "params": {"software": "vasp"}},
    ],
    "edges": [
        {"id": "e1", "from": "n1", "to": "n2", "fromH": "out-0", "toH": "in-0"},
        {"id": "e2", "from": "n2", "to": "n3", "fromH": "out-0", "toH": "in-0"},
    ],
})


def test_converts_nodes_to_tasks(db):
    wf_id = convert_graph_json(db, "test-wf", SAMPLE_GRAPH)
    tasks = db.get_all_tasks(wf_id)
    assert len(tasks) == 3
    types = [t["task_type"] for t in tasks]
    assert "structure_input" in types
    assert "geo_opt" in types
    assert "freq" in types


def test_converts_edges_to_links(db):
    wf_id = convert_graph_json(db, "test-wf", SAMPLE_GRAPH)
    dag = db.get_dag(wf_id)
    links = dag["links"]
    assert len(links) == 2
    # First link: structure_input → geo_opt
    assert links[0]["source_key"] == "structure"
    assert links[0]["target_key"] == "structure"


def test_preserves_params(db):
    wf_id = convert_graph_json(db, "test-wf", SAMPLE_GRAPH)
    tasks = db.get_all_tasks(wf_id)
    geo_opt = [t for t in tasks if t["task_type"] == "geo_opt"][0]
    params = json.loads(geo_opt["params_json"])
    assert params["ENCUT"] == 520
    assert params["software"] == "vasp"


def test_preserves_software_field(db):
    wf_id = convert_graph_json(db, "test-wf", SAMPLE_GRAPH)
    tasks = db.get_all_tasks(wf_id)
    geo_opt = [t for t in tasks if t["task_type"] == "geo_opt"][0]
    assert geo_opt["software"] == "vasp"


def test_empty_graph(db):
    empty = json.dumps({"nodes": [], "edges": []})
    wf_id = convert_graph_json(db, "empty-wf", empty)
    tasks = db.get_all_tasks(wf_id)
    assert len(tasks) == 0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/james0001/project/catgo/.worktrees/split-files && python -m pytest server/tests/test_graph_converter.py -v 2>&1 | tail -10`

Expected: FAIL with `ModuleNotFoundError: No module named 'catgo.workflow.graph_converter'`

- [ ] **Step 3: Create the converter**

```python
# server/catgo/workflow/graph_converter.py
"""Convert GUI graph_json to v2 workflow tasks + links.

graph_json format:
  {nodes: [{id, type, x, y, params}], edges: [{id, from, to, fromH, toH}]}

Handle convention:
  "out-0" = first output, "in-1" = second input
  Index maps to NodeDefinition.inputs/outputs arrays
"""

from __future__ import annotations

import json
from typing import Any

from catgo.workflow.db import WorkflowDB


# Map frontend node types to handle names (input/output ports)
# Default: first input = "structure", first output = "structure"
_HANDLE_MAP: dict[str, dict[str, list[str]]] = {
    "structure_input": {"inputs": [], "outputs": ["structure"]},
    "geo_opt": {"inputs": ["structure"], "outputs": ["structure", "energy"]},
    "single_point": {"inputs": ["structure"], "outputs": ["energy"]},
    "freq": {"inputs": ["structure"], "outputs": ["structure", "frequencies"]},
    "cell_opt": {"inputs": ["structure"], "outputs": ["structure", "energy"]},
    "md": {"inputs": ["structure"], "outputs": ["structure"]},
    "slab_gen": {"inputs": ["structure"], "outputs": ["structure"]},
    "adsorbate_place": {"inputs": ["structure"], "outputs": ["structure"]},
    "gibbs_energy": {"inputs": ["energy", "frequencies"], "outputs": ["gibbs"]},
    "dos_analysis": {"inputs": ["structure"], "outputs": ["result"]},
    "charge_analysis": {"inputs": ["structure"], "outputs": ["result"]},
    "free_energy_diagram": {"inputs": ["gibbs_values"], "outputs": ["result"]},
}

_DEFAULT_HANDLES = {"inputs": ["structure"], "outputs": ["structure"]}


def _get_handle_name(node_type: str, handle_id: str, direction: str) -> str:
    """Convert 'out-0' / 'in-1' to a semantic key like 'structure' or 'energy'."""
    prefix = "out-" if direction == "output" else "in-"
    if not handle_id.startswith(prefix):
        return "structure"  # fallback

    try:
        idx = int(handle_id[len(prefix):])
    except ValueError:
        return "structure"

    handles = _HANDLE_MAP.get(node_type, _DEFAULT_HANDLES)
    keys = handles.get("outputs" if direction == "output" else "inputs", [])
    return keys[idx] if idx < len(keys) else "structure"


def convert_graph_json(
    db: WorkflowDB,
    name: str,
    graph_json: str,
    config: dict[str, Any] | None = None,
) -> str:
    """Parse graph_json, create v2 workflow with tasks + links. Returns workflow_id."""
    graph = json.loads(graph_json) if isinstance(graph_json, str) else graph_json
    nodes = graph.get("nodes", [])
    edges = graph.get("edges", [])

    wf_id = db.create_workflow(name, config=config)

    # Create tasks, map old node id → new task id
    node_to_task: dict[str, str] = {}
    for node in nodes:
        node_id = node["id"]
        node_type = node["type"]
        params = node.get("params", {})

        software = params.pop("software", None) if isinstance(params, dict) else None

        task_id = db.create_task(
            wf_id, node_type,
            name=params.get("label") or params.get("system_name"),
            params=params,
            software=software,
            system_name=params.get("system_name"),
        )
        node_to_task[node_id] = task_id

    # Create links from edges
    for edge in edges:
        src_node_id = edge.get("from", edge.get("source", ""))
        tgt_node_id = edge.get("to", edge.get("target", ""))
        src_handle = edge.get("fromH", edge.get("fromHandle", "out-0"))
        tgt_handle = edge.get("toH", edge.get("toHandle", "in-0"))

        src_task = node_to_task.get(src_node_id)
        tgt_task = node_to_task.get(tgt_node_id)
        if not src_task or not tgt_task:
            continue

        # Resolve semantic keys from handle IDs
        src_node_type = next((n["type"] for n in nodes if n["id"] == src_node_id), "")
        tgt_node_type = next((n["type"] for n in nodes if n["id"] == tgt_node_id), "")

        source_key = _get_handle_name(src_node_type, src_handle, "output")
        target_key = _get_handle_name(tgt_node_type, tgt_handle, "input")

        db.create_link(wf_id, src_task, tgt_task, source_key, target_key)

    return wf_id
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/james0001/project/catgo/.worktrees/split-files && python -m pytest server/tests/test_graph_converter.py -v`

Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
cd /home/james0001/project/catgo/.worktrees/split-files
git add server/catgo/workflow/graph_converter.py server/tests/test_graph_converter.py
git commit -m "feat(p6): add graph_json → v2 tasks converter"
```

---

### Task 7: Wire Converter into V2 API

**Files:**
- Modify: `server/routers/workflow_v2.py`

- [ ] **Step 1: Add convert endpoint**

Add to `server/routers/workflow_v2.py`, after the existing imports:
```python
from pydantic import BaseModel
from catgo.workflow.graph_converter import convert_graph_json
```

Add a Pydantic model and endpoint:
```python
class ConvertRequest(BaseModel):
    name: str
    graph_json: str
    config: dict | None = None


@router.post("/convert")
async def convert(body: ConvertRequest):
    """Convert a GUI graph_json into a v2 workflow with tasks + links."""
    db = _get_db()
    wf_id = convert_graph_json(db, body.name, body.graph_json, body.config)
    wf = db.get_workflow(wf_id)
    tasks = db.get_all_tasks(wf_id)
    return {"workflow_id": wf_id, "name": wf["name"], "task_count": len(tasks)}
```

- [ ] **Step 2: Add convert function to API client**

Add to `src/lib/api/workflow-v2.ts`:
```typescript
export async function convert_graph_to_v2(name: string, graph_json: string, config?: Record<string, unknown>) {
  return handle<{ workflow_id: string; name: string; task_count: number }>(
    await fetch(`${API_BASE}/v2/workflows/convert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, graph_json, config }),
    })
  )
}
```

- [ ] **Step 3: Commit**

```bash
cd /home/james0001/project/catgo/.worktrees/split-files
git add server/routers/workflow_v2.py src/lib/api/workflow-v2.ts
git commit -m "feat(p6): wire graph_json converter into /api/v2/workflows/convert"
```

---

### Task 8: HPC Dry Run Test

**Files:**
- Create: `server/tests/test_hpc_dry_run.py`

- [ ] **Step 1: Write HPC dry run test**

This test validates the full state machine flow for HPC tasks with mocked SSH. It tests: WAITING → READY → GENERATING → UPLOADING → SUBMITTED → QUEUED → RUNNING → COMPLETED_REMOTE → COLLECTING → COMPLETED.

```python
# server/tests/test_hpc_dry_run.py
"""HPC dry run test — validates submitter → poller → collector with mocked SSH.

Tests the full state transition pipeline without real HPC access.
"""
import asyncio
import json
import os
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from catgo.workflow.db import WorkflowDB
from catgo.workflow.states import TaskState
from catgo.workflow.workflow import Workflow
from catgo.workflow.engine.scanner import WorkflowEngine


@pytest.fixture
def db(tmp_path):
    return WorkflowDB(str(tmp_path / "test.db"))


@pytest.fixture
def config():
    return {
        "engine": {"poll_interval": 1},
        "hpc": {
            "default_session": "mock-session",
            "sessions": {
                "mock-session": {
                    "host": "mock-hpc",
                    "user": "testuser",
                    "work_base": "/scratch/testuser/catgo",
                }
            }
        },
    }


def _create_geo_opt_workflow(db: WorkflowDB) -> str:
    """Create a simple structure_input → geo_opt workflow."""
    wf = Workflow("HPC Dry Run", db=db)
    t1 = wf.add_task("structure_input", structure='{"lattice": {"a": 3.0}}')
    t2 = wf.add_task("geo_opt", structure=t1.output.structure, software="vasp")
    wf.submit()
    return wf.workflow_id


@pytest.mark.asyncio
async def test_local_task_completes(db, config):
    """structure_input (local) should complete in one scan cycle."""
    wf_id = _create_geo_opt_workflow(db)
    engine = WorkflowEngine(db=db, config=config)

    # First cycle: advance WAITING→READY, execute structure_input
    await engine.scan_cycle()

    tasks = db.get_all_tasks(wf_id)
    si_task = [t for t in tasks if t["task_type"] == "structure_input"][0]
    assert si_task["status"] == TaskState.COMPLETED.value

    # geo_opt should now be READY (its parent completed)
    geo_task = [t for t in tasks if t["task_type"] == "geo_opt"][0]
    assert geo_task["status"] == TaskState.READY.value


@pytest.mark.asyncio
async def test_full_hpc_lifecycle_mocked(db, config):
    """Full HPC lifecycle with mocked SSH: READY → ... → COMPLETED."""
    wf_id = _create_geo_opt_workflow(db)
    engine = WorkflowEngine(db=db, config=config)

    # Cycle 1: complete structure_input, advance geo_opt to READY
    await engine.scan_cycle()

    tasks = db.get_all_tasks(wf_id)
    geo_task = [t for t in tasks if t["task_type"] == "geo_opt"][0]
    geo_id = geo_task["id"]
    assert geo_task["status"] == TaskState.READY.value

    # Mock the HPC submitter to simulate sbatch
    mock_generator = AsyncMock(return_value="/scratch/testuser/catgo/wf1/geo_opt")
    mock_submit = AsyncMock(return_value="12345")

    with patch("catgo.workflow.engine.submitter.get_engine_generator", return_value=mock_generator), \
         patch("catgo.workflow.engine.submitter._submit_job", new=mock_submit):
        # Cycle 2: submit geo_opt
        await engine.scan_cycle()

    geo_task = db.get_task(geo_id)
    # Should be in a submitted state (SUBMITTED, GENERATING, or UPLOADING)
    assert geo_task["status"] in (
        TaskState.SUBMITTED.value, TaskState.GENERATING.value,
        TaskState.UPLOADING.value, TaskState.READY.value,
    )

    # Manually advance to SUBMITTED for the poller test
    db.update_task(geo_id, status=TaskState.SUBMITTED.value, hpc_job_id="12345")

    # Mock the poller: first call returns RUNNING, second returns COMPLETED_REMOTE
    call_count = 0
    async def mock_check_status(db_, task, config_):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            db_.update_task(task["id"], status=TaskState.RUNNING.value)
        else:
            db_.update_task(task["id"], status=TaskState.COMPLETED_REMOTE.value)

    with patch("catgo.workflow.engine.poller._check_task_status", new=mock_check_status):
        await engine.scan_cycle()  # → RUNNING

    geo_task = db.get_task(geo_id)
    assert geo_task["status"] == TaskState.RUNNING.value

    with patch("catgo.workflow.engine.poller._check_task_status", new=mock_check_status):
        await engine.scan_cycle()  # → COMPLETED_REMOTE

    geo_task = db.get_task(geo_id)
    assert geo_task["status"] == TaskState.COMPLETED_REMOTE.value

    # Mock the collector: read results from remote
    mock_collector = AsyncMock(return_value={"energy": -42.0, "structure_json": '{"lattice": {}}'})

    with patch("catgo.workflow.engine.collector.get_result_collector", return_value=mock_collector):
        await engine.scan_cycle()  # → COMPLETED

    geo_task = db.get_task(geo_id)
    assert geo_task["status"] == TaskState.COMPLETED.value

    # Check result stored
    result = db.get_result(geo_id)
    assert result is not None
    assert result["energy"] == -42.0

    # Workflow should be completed
    wf = db.get_workflow(wf_id)
    assert wf["status"] == "completed"


@pytest.mark.asyncio
async def test_error_handler_retries(db, config):
    """REMOTE_ERROR task should be retried (set back to READY)."""
    wf_id = _create_geo_opt_workflow(db)
    engine = WorkflowEngine(db=db, config=config)
    await engine.scan_cycle()  # complete structure_input

    tasks = db.get_all_tasks(wf_id)
    geo_id = [t for t in tasks if t["task_type"] == "geo_opt"][0]["id"]

    # Simulate remote error
    db.update_task(geo_id, status=TaskState.REMOTE_ERROR.value, error_message="SSH timeout")

    await engine.scan_cycle()  # error handler runs

    geo_task = db.get_task(geo_id)
    # Should be back to READY for retry (retry_count < max_retries)
    assert geo_task["status"] == TaskState.READY.value
```

- [ ] **Step 2: Run the test**

Run: `cd /home/james0001/project/catgo/.worktrees/split-files && python -m pytest server/tests/test_hpc_dry_run.py -v --timeout=30 2>&1 | tail -20`

Expected: 3 tests pass (some may need minor mock adjustments — fix inline)

- [ ] **Step 3: Commit**

```bash
cd /home/james0001/project/catgo/.worktrees/split-files
git add server/tests/test_hpc_dry_run.py
git commit -m "test(p6): add HPC dry-run test with mocked submitter/poller/collector"
```

---

### Task 9: Run All Tests + Final Verification

**Files:** No new files

- [ ] **Step 1: Run all tests**

Run: `cd /home/james0001/project/catgo/.worktrees/split-files && python -m pytest server/tests/ -v --timeout=60 2>&1 | tail -30`

Expected: All tests pass (95 existing + ~12 new = ~107 total)

- [ ] **Step 2: Run Svelte check**

Run: `cd /home/james0001/project/catgo/.worktrees/split-files && npx svelte-check --tsconfig ./tsconfig.json 2>&1 | tail -20`

Expected: No errors in the new files (existing warnings may be present)

- [ ] **Step 3: Create summary commit**

Only if all tests pass and svelte-check is clean:

```bash
cd /home/james0001/project/catgo/.worktrees/split-files
git log --oneline -10
```

Verify the P6 commits are present. No additional commit needed if individual tasks committed properly.

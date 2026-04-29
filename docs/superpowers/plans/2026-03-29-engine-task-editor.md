# Engine Task Editor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current barebones engine task side panel with a full editing environment that matches or exceeds the GUI workflow editor — reusing every existing component, writing zero new 3D/editing code.

**Architecture:** Create `EngineTaskEditor.svelte` — a new container that replaces the 340px side panel. When a user clicks an engine task node, the right side opens a full-height editor with three zones: (1) structure 3D preview/edit at top, (2) task-specific tool pane (MillerSlabCutterPane for slab_gen, AdsorbatePlacementPane for adsorbate_place, VASP param form for geo_opt/freq), (3) NodeStatusPanel at bottom for monitoring. All structure edits write back to the engine task via PUT `/api/engine/tasks/{id}/params`.

**Tech Stack:** Svelte 5, existing components (StructureEditModal, MillerSlabCutterPane, AdsorbatePlacementPane, StepFileTree, NodeStatusPanel), task-adapter.ts, workflow-v2 API.

**Core Principle:** 复用 > 适配 > 重写。Every component already exists in the GUI workflow. We're wiring them to engine tasks, not rebuilding them.

---

## File Structure

| File | Responsibility | Action |
|------|---------------|--------|
| `src/lib/workflow/EngineTaskEditor.svelte` | Container that shows the right editor based on task_type | **Create** (~300 lines) |
| `desktop/WorkflowView.svelte` | Replace 340px NodeStatusPanel side panel with EngineTaskEditor | **Modify** |
| `src/routes/workflow-v2/+page.svelte` | Same replacement for web route | **Modify** |
| `src/lib/workflow/NodeStatusPanel.svelte` | Remove inline StructurePreview (now handled by EngineTaskEditor) | **Modify** |
| `src/lib/api/workflow-v2.ts` | Add `update_engine_task_params()` for writing edits back | **Modify** |

---

### Task 1: Add `update_engine_task_params` API function

**Files:**
- Modify: `src/lib/api/workflow-v2.ts`

- [ ] **Step 1: Add the function**

In `src/lib/api/workflow-v2.ts`, add:

```typescript
/** Update task params (only WAITING/READY/PENDING_REVIEW tasks) */
export async function update_engine_task_params(
  task_id: string,
  params: Record<string, unknown>,
): Promise<{ task_id: string; status: string }> {
  const { API_BASE } = await import('./config')
  const r = await fetch(`${API_BASE}/engine/tasks/${task_id}/params`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ params }),
  })
  return handle<{ task_id: string; status: string }>(r)
}
```

- [ ] **Step 2: Verify the backend endpoint exists**

Run: `grep -n "update_params\|PUT.*params" server/catgo/routers/workflow_engine_tasks.py`

The endpoint `PUT /api/engine/tasks/{id}/params` already exists (line 84). Verify it accepts `{ params: dict }` body.

- [ ] **Step 3: Commit**

```bash
git add src/lib/api/workflow-v2.ts
git commit -m "feat: add update_engine_task_params API function"
```

---

### Task 2: Create EngineTaskEditor.svelte

**Files:**
- Create: `src/lib/workflow/EngineTaskEditor.svelte`

This is the main deliverable. It replaces the 340px side panel with a full editing environment.

- [ ] **Step 1: Create the file with the component skeleton**

```svelte
<script lang="ts">
  import type { PymatgenStructure } from '$lib'
  import type { AdsorptionSite } from '$lib/structure/ferrox-wasm-types'
  import { get_v2_task, get_v2_task_result, confirm_engine_task, update_engine_task_params } from '$lib/api/workflow-v2'
  import type { V2Task } from '$lib/api/workflow-v2'
  import { pending_open_structure } from './workflow-state.svelte'
  import NodeStatusPanel from './NodeStatusPanel.svelte'
  import StructurePreview from '$lib/structure/StructurePreview.svelte'

  interface Props {
    task_id: string | null
    workflow_id: string
    onclose?: () => void
    onrefresh?: () => void
  }
  let { task_id, workflow_id, onclose, onrefresh }: Props = $props()

  // --- Task state ---
  let task = $state<V2Task | null>(null)
  let result = $state<Record<string, unknown> | null>(null)
  let loading = $state(false)
  let error = $state('')

  // --- Structure state ---
  let preview_structure = $state<PymatgenStructure | null>(null)
  let input_structure = $state<PymatgenStructure | null>(null)
  let output_structure = $state<PymatgenStructure | null>(null)

  // --- Editor state ---
  let active_tab = $state<'structure' | 'params' | 'monitor'>('structure')
  let StructureEditorComponent = $state<typeof import('$lib/structure/Structure.svelte').default | null>(null)
  let show_full_editor = $state(false)

  // --- Lazy-load heavy components ---
  let MillerSlabCutterPaneComponent = $state<typeof import('$lib/structure/MillerSlabCutterPane.svelte').default | null>(null)
  let AdsorbatePlacementPaneComponent = $state<typeof import('$lib/structure/AdsorbatePlacementPane.svelte').default | null>(null)

  // --- Load task data ---
  async function load_task() {
    if (!task_id) { task = null; result = null; return }
    loading = true
    error = ''
    try {
      const data = await get_v2_task(task_id)
      task = data.task

      // Parse structures from params and result
      const params = task.params_json ? JSON.parse(task.params_json) : {}
      if (params.structure) {
        input_structure = typeof params.structure === 'string'
          ? JSON.parse(params.structure)
          : params.structure
      }

      if (task.status === 'COMPLETED') {
        try {
          result = await get_v2_task_result(task_id)
          if (result?.structure_json) {
            output_structure = typeof result.structure_json === 'string'
              ? JSON.parse(result.structure_json as string)
              : result.structure_json as PymatgenStructure
          }
        } catch { result = null }
      }

      // Choose best structure to preview
      preview_structure = output_structure ?? input_structure

      // Lazy-load task-specific components
      if (task.task_type === 'slab_gen' && !MillerSlabCutterPaneComponent) {
        import('$lib/structure/MillerSlabCutterPane.svelte').then(m => {
          MillerSlabCutterPaneComponent = m.default
        })
      }
      if (task.task_type === 'adsorbate_place' && !AdsorbatePlacementPaneComponent) {
        import('$lib/structure/AdsorbatePlacementPane.svelte').then(m => {
          AdsorbatePlacementPaneComponent = m.default
        })
      }
    } catch (e: any) {
      error = e.message
    } finally {
      loading = false
    }
  }

  $effect(() => { void task_id; load_task() })

  // --- Helpers ---
  const task_type = $derived(task?.task_type ?? '')
  const task_label = $derived(task?.name ?? task?.task_type ?? '')
  const task_status = $derived(task?.status ?? '')
  const task_params = $derived.by(() => {
    if (!task?.params_json) return {}
    try { return JSON.parse(task.params_json) } catch { return {} }
  })
  const is_editable = $derived(['WAITING', 'READY', 'PENDING_REVIEW'].includes(task_status))

  // --- Write params back to engine ---
  async function save_params(updates: Record<string, unknown>) {
    if (!task_id || !is_editable) return
    try {
      const merged = { ...task_params, ...updates }
      await update_engine_task_params(task_id, merged)
      await load_task()
      onrefresh?.()
    } catch (e: any) {
      error = e.message
    }
  }

  // --- Confirm PENDING_REVIEW ---
  async function do_confirm() {
    if (!task_id) return
    try {
      await confirm_engine_task(task_id)
      await load_task()
      onrefresh?.()
    } catch (e: any) {
      error = e.message
    }
  }

  // --- Open full Structure.svelte editor ---
  async function open_full_editor() {
    if (!StructureEditorComponent) {
      const mod = await import('$lib/structure/Structure.svelte')
      StructureEditorComponent = mod.default
    }
    show_full_editor = true
  }

  function handle_structure_change(struct: PymatgenStructure) {
    preview_structure = struct
    // Save structure back to task params
    save_params({ structure: JSON.stringify(struct) })
  }
</script>

{#if !task_id}
  <div class="ete-empty">
    <span>Select a task node to view details</span>
  </div>
{:else if loading && !task}
  <div class="ete-empty"><span>Loading...</span></div>
{:else if error && !task}
  <div class="ete-empty"><span style="color:#ef4444;">{error}</span></div>
{:else if task}
  <div class="ete-container">
    <!-- Header -->
    <div class="ete-header">
      <div class="ete-title">{task_label}</div>
      <div class="ete-subtitle">{task_type} · {task_id.slice(0, 8)}</div>
      <div class="ete-status" class:completed={task_status === 'COMPLETED'}
           class:running={task_status === 'RUNNING'}
           class:failed={task_status === 'FAILED' || task_status === 'REMOTE_ERROR'}
           class:review={task_status === 'PENDING_REVIEW'}>
        {task_status}
      </div>
      <button class="ete-close" onclick={onclose}>×</button>
    </div>

    <!-- PENDING_REVIEW Banner -->
    {#if task_status === 'PENDING_REVIEW'}
      <div class="ete-review-banner">
        <span>Review structure and parameters before submitting to HPC</span>
        <button class="ete-confirm-btn" onclick={do_confirm}>Confirm & Submit</button>
      </div>
    {/if}

    <!-- Tab Bar -->
    <div class="ete-tabs">
      <button class="ete-tab" class:active={active_tab === 'structure'} onclick={() => active_tab = 'structure'}>
        Structure
      </button>
      <button class="ete-tab" class:active={active_tab === 'params'} onclick={() => active_tab = 'params'}>
        Parameters
      </button>
      <button class="ete-tab" class:active={active_tab === 'monitor'} onclick={() => active_tab = 'monitor'}>
        Monitor
      </button>
    </div>

    <!-- Tab Content -->
    <div class="ete-content">
      {#if active_tab === 'structure'}
        <!-- Structure Preview + Task-Specific Tools -->
        {#if preview_structure?.sites?.length}
          <div class="ete-structure-preview">
            <StructurePreview structure={preview_structure} />
          </div>
          <div class="ete-structure-actions">
            <button class="ete-action-btn" onclick={open_full_editor}>
              Open Full Editor
            </button>
            <button class="ete-action-btn" onclick={() => {
              if (preview_structure) {
                pending_open_structure.structure = preview_structure
                pending_open_structure.label = task_label
                pending_open_structure.seq++
              }
            }}>
              Open in New Tab
            </button>
          </div>
          <div class="ete-atom-info">
            {preview_structure.sites.length} atoms
            {#if preview_structure.lattice}
              · {preview_structure.lattice.a?.toFixed(2) ?? '?'}×{preview_structure.lattice.b?.toFixed(2) ?? '?'}×{preview_structure.lattice.c?.toFixed(2) ?? '?'} Å
            {/if}
          </div>
        {:else}
          <div class="ete-no-structure">No structure available</div>
        {/if}

        <!-- Task-specific editing tools -->
        {#if task_type === 'slab_gen' && is_editable && MillerSlabCutterPaneComponent && input_structure}
          <div class="ete-tool-section">
            <div class="ete-tool-title">Slab Cutter</div>
            <MillerSlabCutterPaneComponent
              bind:structure={preview_structure}
              bulk_structure={input_structure}
              pane_open={true}
              embedded={true}
              on_structure_change={handle_structure_change}
            />
          </div>
        {/if}

        {#if task_type === 'adsorbate_place' && is_editable && AdsorbatePlacementPaneComponent && preview_structure}
          <div class="ete-tool-section">
            <div class="ete-tool-title">Adsorbate Placement</div>
            <AdsorbatePlacementPaneComponent
              bind:structure={preview_structure}
              pane_open={true}
              embedded={true}
              on_structure_change={handle_structure_change}
            />
          </div>
        {/if}

      {:else if active_tab === 'params'}
        <!-- VASP / task parameters -->
        <div class="ete-params-section">
          {#each Object.entries(task_params).filter(([k]) => k !== 'structure' && k !== 'structure_json') as [key, value]}
            <div class="ete-param-row">
              <span class="ete-param-key">{key}</span>
              {#if is_editable}
                <input class="ete-param-input" value={String(value)}
                  onblur={(e) => save_params({ [key]: parse_param(e.currentTarget.value) })}
                />
              {:else}
                <span class="ete-param-value">{String(value)}</span>
              {/if}
            </div>
          {/each}
        </div>

      {:else if active_tab === 'monitor'}
        <!-- Full NodeStatusPanel for monitoring -->
        <NodeStatusPanel
          mode="task"
          task_id={task_id}
          node_id={task_id}
          node_type=""
          node_label=""
          workflow_id={workflow_id}
        />
      {/if}
    </div>
  </div>

  <!-- Full Structure Editor Modal -->
  {#if show_full_editor && StructureEditorComponent && preview_structure}
    <div class="ete-editor-overlay">
      <div class="ete-editor-header">
        <span>{task_label} — Full Editor</span>
        <div style="display:flex;gap:8px;">
          {#if is_editable}
            <button class="ete-save-btn" onclick={() => {
              handle_structure_change(preview_structure!)
              show_full_editor = false
            }}>Save & Close</button>
          {/if}
          <button class="ete-close-btn" onclick={() => show_full_editor = false}>Close</button>
        </div>
      </div>
      <div class="ete-editor-body">
        <StructureEditorComponent bind:structure={preview_structure} />
      </div>
    </div>
  {/if}
{/if}

<script>
  function parse_param(val: string): unknown {
    if (val === 'true') return true
    if (val === 'false') return false
    if (val === 'null') return null
    const num = Number(val)
    if (!isNaN(num) && val.trim() !== '') return num
    try { return JSON.parse(val) } catch { return val }
  }
</script>

<style>
  .ete-container { display: flex; flex-direction: column; height: 100%; background: var(--surface-bg, #111); }
  .ete-empty { display: flex; align-items: center; justify-content: center; height: 100%; color: var(--text-color-dim, #666); font-size: 13px; background: var(--surface-bg, #111); }

  .ete-header { padding: 12px 14px 8px; border-bottom: 1px solid var(--border-color, #333); flex-shrink: 0; position: relative; }
  .ete-title { font-size: 15px; font-weight: 600; color: var(--text-color, #e5e5e5); }
  .ete-subtitle { font-size: 11px; color: var(--text-color-dim, #888); margin-top: 2px; font-family: monospace; }
  .ete-status { display: inline-block; margin-top: 6px; padding: 2px 10px; border-radius: 12px; font-size: 11px; font-weight: 600; }
  .ete-status.completed { background: rgba(34,197,94,0.15); color: #22c55e; }
  .ete-status.running { background: rgba(234,179,8,0.15); color: #eab308; }
  .ete-status.failed { background: rgba(239,68,68,0.15); color: #ef4444; }
  .ete-status.review { background: rgba(245,158,11,0.15); color: #f59e0b; }
  .ete-close { position: absolute; top: 8px; right: 8px; background: none; border: none; color: var(--text-color-dim, #888); font-size: 20px; cursor: pointer; padding: 2px 6px; border-radius: 4px; }
  .ete-close:hover { background: rgba(255,255,255,0.08); color: var(--text-color); }

  .ete-review-banner { padding: 10px 14px; background: rgba(245,158,11,0.1); border-bottom: 1px solid #f59e0b; display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-shrink: 0; }
  .ete-review-banner span { color: #f59e0b; font-size: 12px; font-weight: 500; }
  .ete-confirm-btn { background: #f59e0b; color: #000; border: none; border-radius: 6px; padding: 6px 16px; font-size: 12px; font-weight: 600; cursor: pointer; white-space: nowrap; }
  .ete-confirm-btn:hover { background: #d97706; }

  .ete-tabs { display: flex; border-bottom: 1px solid var(--border-color, #333); flex-shrink: 0; }
  .ete-tab { flex: 1; padding: 8px 0; background: none; border: none; border-bottom: 2px solid transparent; color: var(--text-color-dim, #888); font-size: 12px; font-weight: 500; cursor: pointer; transition: all 0.15s; }
  .ete-tab:hover { color: var(--text-color, #e5e5e5); }
  .ete-tab.active { color: var(--accent-color, #3b82f6); border-bottom-color: var(--accent-color, #3b82f6); }

  .ete-content { flex: 1; overflow-y: auto; }

  .ete-structure-preview { height: 280px; border-bottom: 1px solid var(--border-color, #333); }
  .ete-structure-actions { display: flex; gap: 6px; padding: 8px 12px; border-bottom: 1px solid var(--border-color, #333); }
  .ete-action-btn { flex: 1; padding: 6px 0; background: none; border: 1px solid var(--border-color, #444); border-radius: 6px; color: var(--text-color, #e5e5e5); font-size: 11px; cursor: pointer; }
  .ete-action-btn:hover { background: rgba(255,255,255,0.05); }
  .ete-atom-info { padding: 4px 12px 8px; font-size: 11px; color: var(--text-color-dim, #888); }
  .ete-no-structure { padding: 40px 20px; text-align: center; color: var(--text-color-dim, #666); font-size: 12px; }

  .ete-tool-section { border-top: 1px solid var(--border-color, #333); }
  .ete-tool-title { padding: 8px 12px; font-size: 12px; font-weight: 600; color: var(--text-color-muted, #aaa); text-transform: uppercase; letter-spacing: 0.5px; }

  .ete-params-section { padding: 8px 12px; }
  .ete-param-row { display: flex; align-items: center; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid var(--border-color, #222); }
  .ete-param-key { font-size: 12px; color: var(--text-color-dim, #888); font-family: monospace; }
  .ete-param-value { font-size: 12px; color: var(--text-color, #e5e5e5); font-family: monospace; }
  .ete-param-input { background: var(--input-bg, #1a1a1a); border: 1px solid var(--border-color, #333); border-radius: 4px; padding: 3px 8px; color: var(--text-color, #e5e5e5); font-size: 12px; font-family: monospace; width: 120px; text-align: right; }
  .ete-param-input:focus { border-color: var(--accent-color, #3b82f6); outline: none; }

  .ete-editor-overlay { position: fixed; inset: 0; z-index: 200; background: var(--page-bg, #0a0a0a); display: flex; flex-direction: column; }
  .ete-editor-header { display: flex; align-items: center; justify-content: space-between; padding: 8px 16px; border-bottom: 1px solid var(--border-color, #333); background: var(--surface-bg, #111); flex-shrink: 0; }
  .ete-editor-header span { font-size: 14px; font-weight: 600; color: var(--text-color, #e5e5e5); }
  .ete-save-btn { background: #22c55e; color: #000; border: none; border-radius: 6px; padding: 5px 14px; font-size: 12px; font-weight: 600; cursor: pointer; }
  .ete-close-btn { background: none; border: 1px solid var(--border-color, #444); border-radius: 6px; padding: 5px 14px; font-size: 12px; color: var(--text-color, #e5e5e5); cursor: pointer; }
  .ete-editor-body { flex: 1; min-height: 0; }
</style>
```

- [ ] **Step 2: Verify it compiles**

Run: `pnpm check 2>&1 | grep EngineTaskEditor`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/lib/workflow/EngineTaskEditor.svelte
git commit -m "feat: create EngineTaskEditor with 3D preview, tool panes, and param editing"
```

---

### Task 3: Replace side panel in desktop/WorkflowView.svelte

**Files:**
- Modify: `desktop/WorkflowView.svelte`

- [ ] **Step 1: Replace the NodeStatusPanel side panel with EngineTaskEditor**

Find the `{:else if view === 'v2_dag'}` block (around line 348). Replace the 340px side panel:

```svelte
<!-- BEFORE (around line 359-377): -->
{#if v2_selected_task}
  <div style="width:340px;border-left:...">
    <div style="display:flex;justify-content:flex-end;...">
      <button ... onclick={() => { v2_selected_task = null }}>×</button>
    </div>
    <NodeStatusPanel mode="task" task_id={v2_selected_task} ... />
  </div>
{:else}
  <div style="width:340px;...">Select a task node</div>
{/if}

<!-- AFTER: -->
<div style="width:{v2_selected_task ? '420px' : '340px'};border-left:1px solid var(--border-color,#333);overflow-y:auto;background:var(--surface-bg,#111);flex-shrink:0;transition:width 0.2s;">
  <EngineTaskEditor
    task_id={v2_selected_task}
    workflow_id={v2_workflow_id}
    onclose={() => { v2_selected_task = null }}
    onrefresh={() => { /* DAG viewer auto-refreshes via WebSocket */ }}
  />
</div>
```

Add import at top:
```typescript
import EngineTaskEditor from '$lib/workflow/EngineTaskEditor.svelte'
```

Remove the now-unused NodeStatusPanel import (if only used here for v2_dag view).

- [ ] **Step 2: Verify desktop frontend renders**

Open `http://localhost:3100`, navigate to an engine workflow, click a task node. Verify:
- Structure preview appears in the right panel
- Tab bar (Structure / Parameters / Monitor) works
- Close button works

- [ ] **Step 3: Commit**

```bash
git add desktop/WorkflowView.svelte
git commit -m "feat: use EngineTaskEditor in desktop WorkflowView"
```

---

### Task 4: Replace side panel in workflow-v2 page

**Files:**
- Modify: `src/routes/workflow-v2/+page.svelte`

- [ ] **Step 1: Same replacement as Task 3**

Replace the NodeStatusPanel usage with EngineTaskEditor. The changes mirror Task 3 exactly.

Replace import:
```typescript
// Remove: import NodeStatusPanel from '$lib/workflow/NodeStatusPanel.svelte'
import EngineTaskEditor from '$lib/workflow/EngineTaskEditor.svelte'
```

Replace the detail-panel / empty-panel block:
```svelte
<div class="detail-panel" style="width:{selected_task ? '420px' : '340px'};">
  <EngineTaskEditor
    task_id={selected_task}
    workflow_id={selected_wf}
    onclose={() => { selected_task = null }}
  />
</div>
```

Update CSS `.detail-panel` width to be dynamic via inline style.

- [ ] **Step 2: Commit**

```bash
git add src/routes/workflow-v2/+page.svelte
git commit -m "feat: use EngineTaskEditor in workflow-v2 page"
```

---

### Task 5: Fix structure caching per task_id

**Files:**
- Modify: `src/lib/workflow/EngineTaskEditor.svelte`

- [ ] **Step 1: Add module-level structure cache**

At the top of the script, add a module-level cache to prevent re-parsing on tab switches:

```typescript
// Module-level cache — survives component remounts (tab switches)
const _struct_cache = new Map<string, {
  input: PymatgenStructure | null
  output: PymatgenStructure | null
  params: Record<string, unknown>
}>()
```

In `load_task()`, check cache first:
```typescript
const cached = _struct_cache.get(task_id)
if (cached) {
  input_structure = cached.input
  output_structure = cached.output
  preview_structure = cached.output ?? cached.input
  // Still fetch fresh task status (but skip structure parsing)
}
```

After parsing structures, save to cache:
```typescript
_struct_cache.set(task_id, { input: input_structure, output: output_structure, params: task_params })
```

- [ ] **Step 2: Invalidate cache on structure edit**

In `handle_structure_change()`, update the cache entry:
```typescript
if (task_id) {
  const cached = _struct_cache.get(task_id)
  if (cached) {
    cached.input = preview_structure
    _struct_cache.set(task_id, cached)
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/workflow/EngineTaskEditor.svelte
git commit -m "fix: cache structures per task_id to eliminate switching delay"
```

---

### Task 6: Clean up NodeStatusPanel inline preview

**Files:**
- Modify: `src/lib/workflow/NodeStatusPanel.svelte`

- [ ] **Step 1: Remove the inline StructurePreview**

In NodeStatusPanel, find the `<!-- Structure Preview (engine tasks) -->` section (around line 739) and remove it entirely. EngineTaskEditor now handles structure display.

Keep the NodeStatusPanel engine task support (mode='task', VASP params, convergence, files, etc.) — it's still used inside EngineTaskEditor's Monitor tab.

- [ ] **Step 2: Remove the lazy StructurePreview import**

Remove the `{#await import('$lib/structure/StructurePreview.svelte')}` block and any related state.

- [ ] **Step 3: Commit**

```bash
git add src/lib/workflow/NodeStatusPanel.svelte
git commit -m "refactor: remove inline StructurePreview from NodeStatusPanel (now in EngineTaskEditor)"
```

---

### Task 7: Test end-to-end

- [ ] **Step 1: Start the backend**

```bash
conda activate catgo && cd server && python main.py
```

- [ ] **Step 2: Start the frontend**

```bash
pnpm desktop:dev
```

- [ ] **Step 3: Test slab_gen node**

Navigate to IrO2(110) OER workflow → Click slab_gen → Verify:
- [x] 3D structure preview (280px height) shows IrO2(110) slab
- [x] "Open Full Editor" button opens full-screen Structure.svelte
- [x] Parameters tab shows miller, layers, vacuum
- [x] Monitor tab shows NodeStatusPanel with convergence/files

- [ ] **Step 4: Test adsorbate_place node**

Click adsorbate_place (*OH) → Verify:
- [x] 3D preview shows slab with OH
- [x] AdsorbatePlacementPane is accessible

- [ ] **Step 5: Test geo_opt node (PENDING_REVIEW)**

Click geo_opt (clean slab) → Verify:
- [x] PENDING_REVIEW banner with "Confirm & Submit" button
- [x] Structure preview shows input slab
- [x] Parameters tab shows VASP params, editable
- [x] Edit a param → save → refresh → verify saved

- [ ] **Step 6: Test switching speed**

Click rapidly between 5+ nodes → Verify:
- [x] No visible delay (structures cached)
- [x] No stale structure from previous node
- [x] No console errors

- [ ] **Step 7: Commit final state**

```bash
git add -A
git commit -m "test: verify EngineTaskEditor end-to-end"
```

---

## Implementation Order

| Task | Est. LOC | Risk | Depends On |
|------|----------|------|-----------|
| 1: API function | ~15 | Low | None |
| 2: EngineTaskEditor | ~300 | Medium | Task 1 |
| 3: Desktop integration | ~20 | Low | Task 2 |
| 4: Web integration | ~15 | Low | Task 2 |
| 5: Cache fix | ~30 | Low | Task 2 |
| 6: NSP cleanup | ~-40 | Low | Task 2 |
| 7: E2E test | 0 | Low | Tasks 3-6 |

**Total: ~340 lines added, ~40 deleted. Net: +300 lines.**

Tasks 3+4 are independent and can run in parallel.
Tasks 5+6 are independent and can run in parallel.

## Key Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| MillerSlabCutterPane doesn't work with `embedded=true` in side panel | It has `embedded` prop specifically for this. Test with simple structure first. If panel layout breaks in 420px width, increase panel width or use a modal. |
| Threlte Canvas inside side panel causes rendering issues | StructurePreview is already used in OptimadePreviewModal (similar constrained context). Known to work. |
| Structure cache grows unbounded | Use `Map` with max 50 entries, evict oldest on overflow. |
| PENDING_REVIEW confirm + edit race condition | Disable confirm button while save is in progress. Backend rejects confirm for non-PENDING_REVIEW tasks. |

## Future Enhancements (NOT in this plan)

- StepFileTree integration for INCAR/POSCAR editing (requires HPC connection)
- MillerSlabCutterPane with full cutting plane visualization (requires shared 3D scene)
- Convergence plot in Structure tab (inline, not in Monitor tab)
- Energy diagram inline editor for completed OER workflows

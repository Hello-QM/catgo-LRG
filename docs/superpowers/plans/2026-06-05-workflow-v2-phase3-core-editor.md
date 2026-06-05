# Workflow V2 Phase 3-core — Editor V2-Native Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the CatGo workflow **editor (UI 1)** V2-native — it receives live status from the V2 monitor (`initial_state` + `task_status` frames), keys node status by `node_id`, and any V2 workflow (GUI-created or engine-created) opens in the editor — without regressing authoring and without deleting UI 2.

**Architecture:** Additive-first swap. We add a V2-native monitor path (`connect_v2_monitor`) inside `workflow-execution.svelte.ts` behind a feature flag (`use_v2_monitor`), prove it in the browser, then flip the flag on by default and retire the V1 monitor call. The `node_statuses` record stays keyed by **bare `node_id`** (which equals `V2Task.node_id` and the suffix of the namespaced `task.id` after `:`), so no downstream consumer (NodeStatusPanel TaskRef, pause dialog, result polling) needs rekeying. `normalize_status` (task-adapter.ts) remains the single V2→coarse collapse point; `STATUS_COLORS` already renders both vocabularies (Phase-3-prep, merged). View routing is unified so the editor opens both sources; UI 2 (WorkflowDAGViewer/EngineTaskEditor) is kept as a complementary "open in DAG viewer" choice, not the default.

**Tech Stack:** SvelteKit 2 / Svelte 5 runes, TypeScript, Vitest, FastAPI (Python) backend, WebSocket monitor, chrome-devtools MCP for the live-status browser-verification gate.

---

## Background facts (verified against the tree — read these before starting)

These are load-bearing. Do not re-derive them; they were confirmed during investigation.

1. **`node_statuses` is keyed by bare `node_id`.** `workflow-execution.svelte.ts:110` declares `node_statuses: Record<string, string>`; `:148-150` and `:184-185` seed it with `s.id` (the V1 step id, which the v1_compat shim returns as `task.node_id or task.id` — see `server/catgo/workflow/v1_compat.py:24,57`). The V2 `V2Task` carries `node_id` separately (`workflow-v2.ts:25`), and `task.id` is the namespaced `{workflow_id}:{node_id}` (`server/catgo/workflow/task_ids.py:12-14`). **Therefore the editor must continue keying by `node_id` — never by the namespaced `task.id`.**

2. **The V2 monitor WS URL in `connect_v2_monitor` is WRONG.** `workflow-v2.ts:326` builds `${WS_BASE}/v2/workflows/{id}/monitor` → resolves to `ws://host:8000/api/v2/workflows/...`. The actual backend route is mounted at `/api/engine/workflows/{id}/monitor` (`server/catgo/routers/workflow_engine.py:23` `prefix="/api/engine/workflows"`, `:431` `@router.websocket("/{workflow_id}/monitor")`). There is **no `/api/v2/` alias** anywhere in `server/`. The only current caller is `WorkflowDAGViewer.svelte:166`, which masks the bug by seeding initial state via the `get_v2_dag` REST call (`:159`) and silently auto-reconnecting. The editor's live-status path depends on the WS `initial_state` + `task_status` frames, so this URL **must be fixed first** (Task 1). The handoff spec line 58's example URL (`ws://localhost:8000/v2/workflows/...`) is likewise wrong; the correct path is `/api/engine/workflows/{wf}/monitor`.

3. **The V2 monitor frames** (`server/catgo/routers/workflow_engine.py:419-428,431-445`): on connect it sends `{type:"initial_state", tasks:[...], links:[...]}` (same shape as `GET /api/engine/workflows/{id}/dag`), then streams `{type:"task_status", task_id, status}` (task_id is namespaced — `server/catgo/workflow/engine/broadcast.py:46-59`) and `{type:"workflow_status", status}`. The FE parser is already wired in `workflow-v2.ts:360-375`.

4. **The V1 monitor path still works** (`workflow.ts:538-546` → `/workflow/{id}/monitor`, routes through v1_compat → V2 tasks, emits `on_step_status(step_id=node_id, ...)`). We keep it as the fallback during the additive phase and as the rollback target.

5. **Status vocabulary:** the V2 WS emits **UPPERCASE** `TaskState` values (`RUNNING`, `COMPLETED`, `PENDING_REVIEW`, `WAITING`, `READY`, `GENERATING`, `UPLOADING`, `SUBMITTED`, `QUEUED`, `COMPLETED_REMOTE`, `COLLECTING`, `FAILED`, `REMOTE_ERROR`, `PAUSED`, `CANCELLED`). The editor's logic (terminal-set, `has_running_jobs`, event pushes) uses **lowercase** coarse values. `normalize_status` (`task-adapter.ts:213-230`) collapses V2→coarse. Every status that enters `node_statuses` from the V2 path **must pass through `normalize_status` first.**

6. **View routing** lives in `desktop/WorkflowView.svelte`: `unified_workflows` (`:151-176`) tags each entry `source: 'GUI' | 'Engine'`; the list-item click handler (the `wf.source === 'Engine'` branch around `:445-449`) and `ProjectDashboard`'s `on_open_engine_workflow` (`:389`) send Engine workflows to `view = 'v2_dag'`. GUI workflows go to `view = 'editor'` (`:293-296`). To converge, **default both to `editor`** and keep `v2_dag` reachable via an explicit secondary action.

7. **The editor loads its graph** via V1 `api.get_workflow(workflow_id)` → `graph_json` (`WorkflowEditor.svelte:1861-1864`). For an engine-created workflow this requires the V1 `GET /api/workflow/{id}` route to return a `graph_json` for V2 rows. **This is an open question (see Open Questions #1) — Task 9 verifies it in the browser and the plan branches on the result.**

---

## File Structure

Files this plan creates or modifies, and each one's responsibility:

- **`src/lib/api/workflow-v2.ts`** (modify) — fix the monitor WS path; add `list_engine_task_statuses` helper for the V2 stale-check. The single FE source of V2 engine API calls.
- **`src/lib/workflow/workflow-execution.svelte.ts`** (modify) — the heart of the change. Add a V2-native monitor path + V2 stale-check + V2 pause-dialog job lookup, gated by `use_v2_monitor`. Keeps `node_statuses` keyed by `node_id`.
- **`src/lib/workflow/workflow-execution.svelte.ts` tests** (create) — `src/lib/workflow/workflow-execution.v2monitor.test.ts`: pure unit tests for the V2 frame → `node_statuses` reducers (extracted as pure functions so they're testable without Svelte runtime).
- **`desktop/WorkflowView.svelte`** (modify) — unify routing so both sources default to the editor; keep a secondary "Open in DAG viewer" path for UI 2.
- **`docs/superpowers/plans/2026-06-05-workflow-v2-phase3-core-editor.md`** (this file).

We deliberately do **not** touch `NodeStatusPanel.svelte`, `task-adapter.ts`, `ForceViewerControls.svelte`, `GibbsCalculator.svelte`, or `ProjectDashboard.svelte` in this plan — their V1↔V2 panel-data migration is Phase-2/Phase-4 work (see the investigation's "Editor + Panels V1 to V2 API Migration" area). Phase 3-core is scoped to **live status + view routing**. Mixing panel-data migration in would balloon risk; it is explicitly out of scope here.

---

## Pure-function extraction strategy (so the live-status path is unit-testable)

The investigation flagged that "automated tests cannot cover the Svelte live-status path." That is true for the `$state` reactivity and WebSocket lifecycle. But the **reducers** — "given an `initial_state` DAG, produce the next `node_statuses` / `workflow_status`" and "given a `task_status` frame, produce the next `node_statuses`" — are pure and MUST be extracted and unit-tested. The browser gate then covers the wiring (reactivity + WS).

These pure functions live at the top of `workflow-execution.svelte.ts` (module scope, exported), so Vitest imports them directly without instantiating the factory.

---

## Task 1: Fix the V2 monitor WebSocket path

**Files:**
- Modify: `src/lib/api/workflow-v2.ts:324-326`
- Test: `src/lib/api/workflow-v2.url.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `src/lib/api/workflow-v2.url.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { v2_monitor_ws_url } from './workflow-v2'

describe('v2_monitor_ws_url', () => {
  it('targets the engine router mount, not a /v2 alias', () => {
    const url = v2_monitor_ws_url('http://localhost:8000/api', 'wf_abc')
    expect(url).toBe('ws://localhost:8000/api/engine/workflows/wf_abc/monitor')
  })

  it('encodes the workflow id and converts https→wss', () => {
    const url = v2_monitor_ws_url('https://h:8000/api', 'a b:c')
    expect(url).toBe('wss://h:8000/api/engine/workflows/a%20b%3Ac/monitor')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk proxy pnpm exec vitest run src/lib/api/workflow-v2.url.test.ts`
Expected: FAIL with "v2_monitor_ws_url is not a function" (not yet exported).

- [ ] **Step 3: Extract and fix the URL builder**

In `src/lib/api/workflow-v2.ts`, add this exported helper directly above `connect_v2_monitor` (currently line 324):

```typescript
/** Build the V2 monitor WebSocket URL. The engine router is mounted at
 *  /api/engine/workflows (workflow_engine.py prefix), so the monitor lives at
 *  /api/engine/workflows/{id}/monitor — NOT a /v2 alias (none exists). */
export function v2_monitor_ws_url(api_base: string, workflow_id: string): string {
  const ws_base = api_base.replace(/^http/, 'ws')
  return `${ws_base}/engine/workflows/${encodeURIComponent(workflow_id)}/monitor`
}
```

Then replace the two URL lines inside `connect_v2_monitor` (currently lines 325-326):

```typescript
export function connect_v2_monitor(workflow_id: string, callbacks: V2MonitorCallbacks): { close: () => void } {
  const url = v2_monitor_ws_url(API_BASE, workflow_id)
```

(Delete the old `const WS_BASE = API_BASE.replace(...)` and `const url = ...` lines — the helper now owns both.)

- [ ] **Step 4: Run test to verify it passes**

Run: `rtk proxy pnpm exec vitest run src/lib/api/workflow-v2.url.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Type-check**

Run: `rtk proxy pnpm exec svelte-check --tsconfig ./tsconfig.json --threshold error 2>&1 | tail -5`
Expected: no new errors referencing `workflow-v2.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/api/workflow-v2.ts src/lib/api/workflow-v2.url.test.ts
git commit -m "fix(workflow-v2): point V2 monitor WS at /api/engine/workflows (not /v2 alias)

The /v2/workflows monitor URL never existed on the backend; the DAG viewer
masked it via a REST seed. The editor's live-status path needs this frame.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Browser-verify the fixed V2 monitor (BLOCKING GATE for the rest)

This proves the WS frames actually flow before we build the editor on top of them. **Do not proceed to Task 3 until this passes.**

**Files:** none (verification only).

- [ ] **Step 1: Start the dev stack**

Run (background): `rtk proxy pnpm desktop:serve`
Then poll until the backend is up:
Run: `bash -c 'until curl -sf http://localhost:8000/api/health >/dev/null; do sleep 2; done; echo backend-up'`
Expected: `backend-up`. Frontend dev server on the Vite port (printed in the `desktop:serve` log; typically 3100 in this worktree — confirm in the log).

- [ ] **Step 2: Confirm at least one V2 (engine) workflow exists with a known id**

Run: `curl -s http://localhost:8000/api/engine/workflows | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d)); print(d[0]['id'] if d else 'NONE')"`
Expected: a count ≥ 1 and an id. If `NONE`, create one first via the MCP `catgo_workflow_engine` tool or by converting a saved graph (`POST /api/engine/workflows/convert`), then re-run.

- [ ] **Step 3: Open a page and assert the monitor frames arrive**

Use chrome-devtools MCP:
- `new_page` → the frontend URL (e.g. `http://localhost:3100`).
- `evaluate_script` with this probe (substitute the real workflow id from Step 2):

```javascript
async () => {
  const { connect_v2_monitor } = await import('/src/lib/api/workflow-v2.ts')
  const wf = '__WF_ID__'
  const got = { initial: false, n_tasks: 0, statuses: [] }
  await new Promise((resolve) => {
    const h = connect_v2_monitor(wf, {
      on_initial_state: (dag) => { got.initial = true; got.n_tasks = dag.tasks.length },
      on_task_status: (id, st) => { got.statuses.push([id, st]) },
    })
    setTimeout(() => { h.close(); resolve() }, 3000)
  })
  return got
}
```

Expected: `got.initial === true` and `got.n_tasks >= 1`. (No `task_status` is required unless the workflow is mid-run; the `initial_state` frame is the gate.)

- [ ] **Step 4: Check the network tab for the correct WS URL**

`list_network_requests` filtered to WebSocket — confirm a connection to `…/api/engine/workflows/__WF_ID__/monitor` opened (status 101), and that there is **no** failed `…/api/v2/workflows/…` attempt.

- [ ] **Step 5: Record the result inline in the plan**

If PASS, check this box and proceed. If FAIL, STOP and debug Task 1 (use superpowers:systematic-debugging) — every later task depends on this.

---

## Task 3: Extract pure reducers for the V1 monitor path (refactor, no behavior change)

This makes the existing V1 behavior testable and gives us the template the V2 reducers must match. We extract the `initial_state`→`{node_statuses, workflow_status, ...}` and `step_status`→`node_statuses` logic into pure functions, then have the existing callbacks call them. Behavior is identical.

**Files:**
- Modify: `src/lib/workflow/workflow-execution.svelte.ts` (add module-scope pure fns; rewire `start_monitoring` callbacks to call them)
- Test: `src/lib/workflow/workflow-execution.reducers.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `src/lib/workflow/workflow-execution.reducers.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import {
  TERMINAL_STATES,
  is_terminal,
  reduce_v1_initial_state,
  reduce_status_update,
} from './workflow-execution.svelte'

describe('TERMINAL_STATES', () => {
  it('matches the V1 terminal vocabulary', () => {
    expect([...TERMINAL_STATES].sort()).toEqual(
      ['cancelled', 'completed', 'failed', 'mapped', 'skipped'].sort(),
    )
  })
})

describe('reduce_v1_initial_state', () => {
  it('keys node_statuses by step id and surfaces workflow_status', () => {
    const out = reduce_v1_initial_state({
      workflow_status: 'running',
      steps: [
        { id: 'geo', status: 'completed' },
        { id: 'stat', status: 'running' },
      ],
    })
    expect(out.node_statuses).toEqual({ geo: 'completed', stat: 'running' })
    expect(out.workflow_status).toBe('running')
    expect(out.has_active).toBe(true)
  })
})

describe('reduce_status_update', () => {
  it('overlays a single status onto the prior map (immutably)', () => {
    const prev = { a: 'pending', b: 'running' }
    const next = reduce_status_update(prev, 'b', 'completed')
    expect(next).toEqual({ a: 'pending', b: 'completed' })
    expect(next).not.toBe(prev)
  })
})

describe('is_terminal', () => {
  it('treats running/queued as non-terminal', () => {
    expect(is_terminal('running')).toBe(false)
    expect(is_terminal('completed')).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk proxy pnpm exec vitest run src/lib/workflow/workflow-execution.reducers.test.ts`
Expected: FAIL with import errors (functions not exported).

- [ ] **Step 3: Add the pure reducers at module scope**

In `src/lib/workflow/workflow-execution.svelte.ts`, directly after the imports block (after line 28, before `export interface WorkflowExecution`), add:

```typescript
/** Terminal task states — everything else means "still in progress".
 *  Shared by the V1 and V2 monitor paths and the stale-check. */
export const TERMINAL_STATES = new Set([
  `completed`, `failed`, `skipped`, `cancelled`, `mapped`,
])

export function is_terminal(status: string): boolean {
  return TERMINAL_STATES.has(status)
}

interface V1Step { id: string; status: string; hpc_job_id?: string; error_message?: string }

/** Pure reducer: V1 initial_state frame → next editor status view. */
export function reduce_v1_initial_state(
  data: { workflow_status: string; steps: V1Step[] },
): {
  node_statuses: Record<string, string>
  workflow_status: string
  has_active: boolean
  failed_step?: V1Step
} {
  const node_statuses: Record<string, string> = {}
  for (const s of data.steps) node_statuses[s.id] = s.status
  const has_active = data.steps.some(
    s => s.status === `running` || s.status === `queued`
      || s.status === `retrying` || s.status === `submitting` || s.status === `pending`,
  )
  const failed_step = data.steps.find(s => s.status === `failed` && s.error_message)
  return { node_statuses, workflow_status: data.workflow_status, has_active, failed_step }
}

/** Pure reducer: overlay one node's status onto the prior map, immutably. */
export function reduce_status_update(
  prev: Record<string, string>,
  node_id: string,
  status: string,
): Record<string, string> {
  return { ...prev, [node_id]: status }
}
```

- [ ] **Step 4: Rewire `start_monitoring`'s V1 `on_initial_state` to use the reducer**

In `start_monitoring` (currently `:181-228`), replace the body of `on_initial_state(data)` down to where it sets `node_statuses` with a call to the reducer. Specifically, replace lines 182-186:

```typescript
      on_initial_state(data) {
        const r = reduce_v1_initial_state(data)
        workflow_status = r.workflow_status
        node_statuses = r.node_statuses
```

Leave the rest of the `on_initial_state` body (the active/terminal branching at `:187-227`) unchanged — it already reads `data.steps` and `data.workflow_status`, which still exist.

- [ ] **Step 5: Rewire `on_step_status` to use `reduce_status_update`**

In `on_step_status` (currently `:229`), replace line 230:

```typescript
      on_step_status(step_id, status, _job_id, message) {
        node_statuses = reduce_status_update(node_statuses, step_id, status)
```

Leave the rest of the handler unchanged.

- [ ] **Step 6: Run reducer tests + full suite**

Run: `rtk proxy pnpm exec vitest run src/lib/workflow/workflow-execution.reducers.test.ts`
Expected: PASS (5 tests).
Run: `rtk proxy pnpm exec vitest run`
Expected: no NEW failures vs baseline (pre-existing failures noted in the handoff spec §5 are acceptable).

- [ ] **Step 7: Commit**

```bash
git add src/lib/workflow/workflow-execution.svelte.ts src/lib/workflow/workflow-execution.reducers.test.ts
git commit -m "refactor(workflow): extract pure monitor reducers (V1 path, no behavior change)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Add the V2 frame reducers (pure, tested)

Now add the V2 counterparts: `initial_state` (tasks/links, namespaced ids + node_id) and `task_status` (namespaced task_id) → `node_statuses` keyed by **node_id**, statuses run through `normalize_status`.

**Files:**
- Modify: `src/lib/workflow/workflow-execution.svelte.ts` (add V2 reducers; import `normalize_status` and `node_id_from_task_id` helper)
- Test: `src/lib/workflow/workflow-execution.v2reducers.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `src/lib/workflow/workflow-execution.v2reducers.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import {
  node_id_from_task_id,
  reduce_v2_initial_state,
  reduce_v2_task_status,
} from './workflow-execution.svelte'
import type { V2DAG } from '$lib/api/workflow-v2'

describe('node_id_from_task_id', () => {
  it('strips the {workflow_id}: prefix', () => {
    expect(node_id_from_task_id('wf_123:geo_opt')).toBe('geo_opt')
  })
  it('returns a bare id unchanged (legacy rows)', () => {
    expect(node_id_from_task_id('geo_opt')).toBe('geo_opt')
  })
  it('keeps only the final segment when node ids contain colons', () => {
    // task_ids.py splits on the FIRST colon; node ids never contain ':'.
    expect(node_id_from_task_id('wf_123:n1')).toBe('n1')
  })
})

const dag = (tasks: Array<Partial<{ id: string; node_id: string; status: string; error_message: string }>>): V2DAG =>
  ({ tasks: tasks as any, links: [] })

describe('reduce_v2_initial_state', () => {
  it('keys by node_id (preferring the explicit field) and normalizes status', () => {
    const out = reduce_v2_initial_state(dag([
      { id: 'wf:geo', node_id: 'geo', status: 'COMPLETED' },
      { id: 'wf:stat', node_id: 'stat', status: 'RUNNING' },
    ]))
    expect(out.node_statuses).toEqual({ geo: 'completed', stat: 'running' })
    expect(out.has_active).toBe(true)
  })

  it('falls back to splitting task.id when node_id is missing', () => {
    const out = reduce_v2_initial_state(dag([
      { id: 'wf:geo', status: 'WAITING' },
    ]))
    expect(out.node_statuses).toEqual({ geo: 'pending' })
    expect(out.has_active).toBe(false)
  })

  it('surfaces the first failed task with an error message', () => {
    const out = reduce_v2_initial_state(dag([
      { id: 'wf:a', node_id: 'a', status: 'FAILED', error_message: 'boom' },
    ]))
    expect(out.failed?.node_id).toBe('a')
    expect(out.failed?.error_message).toBe('boom')
  })
})

describe('reduce_v2_task_status', () => {
  it('overlays normalized status keyed by node_id derived from namespaced id', () => {
    const next = reduce_v2_task_status({ a: 'pending' }, 'wf_x:a', 'RUNNING')
    expect(next).toEqual({ a: 'running' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk proxy pnpm exec vitest run src/lib/workflow/workflow-execution.v2reducers.test.ts`
Expected: FAIL (functions not exported).

- [ ] **Step 3: Implement the V2 reducers**

In `src/lib/workflow/workflow-execution.svelte.ts`, add to the imports near the top (after line 25's `dry_run_workflow` import):

```typescript
import { normalize_status } from '$lib/api/task-adapter'
import type { V2DAG, V2Task } from '$lib/api/workflow-v2'
```

Then add, after the `reduce_status_update` function from Task 3:

```typescript
/** Recover the graph-local node id from a namespaced V2 task id.
 *  Mirrors server/catgo/workflow/task_ids.py:node_id_from_task_id — splits on
 *  the FIRST ':' (node ids never contain ':'); bare ids pass through. */
export function node_id_from_task_id(task_id: string): string {
  const i = task_id.indexOf(`:`)
  return i === -1 ? task_id : task_id.slice(i + 1)
}

/** The bare node id for a V2 task: prefer the explicit node_id column, else
 *  derive from the namespaced task.id. */
function task_node_id(t: Pick<V2Task, 'id' | 'node_id'>): string {
  return t.node_id ?? node_id_from_task_id(t.id)
}

/** Pure reducer: V2 initial_state DAG → next editor status view.
 *  Keys by node_id; collapses V2 UPPERCASE states to V1 coarse via
 *  normalize_status (the single collapse point). */
export function reduce_v2_initial_state(dag: V2DAG): {
  node_statuses: Record<string, string>
  has_active: boolean
  failed?: { node_id: string; error_message?: string }
} {
  const node_statuses: Record<string, string> = {}
  let has_active = false
  let failed: { node_id: string; error_message?: string } | undefined
  for (const t of dag.tasks) {
    const nid = task_node_id(t)
    const coarse = normalize_status(t.status)
    node_statuses[nid] = coarse
    if (coarse === `running` || coarse === `queued` || coarse === `submitting` || coarse === `pending`) {
      has_active = true
    }
    if (!failed && coarse === `failed` && t.error_message) {
      failed = { node_id: nid, error_message: t.error_message ?? undefined }
    }
  }
  return { node_statuses, has_active, failed }
}

/** Pure reducer: V2 task_status frame → next node_statuses (keyed by node_id). */
export function reduce_v2_task_status(
  prev: Record<string, string>,
  task_id: string,
  raw_status: string,
): Record<string, string> {
  return reduce_status_update(prev, node_id_from_task_id(task_id), normalize_status(raw_status))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `rtk proxy pnpm exec vitest run src/lib/workflow/workflow-execution.v2reducers.test.ts`
Expected: PASS (7 tests). If `normalize_status('WAITING')` does not return `pending`, re-read `task-adapter.ts:213-230` — the MAP has `waiting→pending`, so it should. If `RUNNING`/`COMPLETED` map via `??lower` to `running`/`completed`, they pass.

- [ ] **Step 5: Type-check**

Run: `rtk proxy pnpm exec svelte-check --tsconfig ./tsconfig.json --threshold error 2>&1 | tail -5`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/workflow/workflow-execution.svelte.ts src/lib/workflow/workflow-execution.v2reducers.test.ts
git commit -m "feat(workflow): pure V2 monitor reducers (node_id keyed, normalize_status collapse)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Add a V2 status-list helper for the stale-check

The V1 stale-check calls `api.list_steps` (`workflow-execution.svelte.ts:143`). The V2 equivalent is `get_v2_dag` (already returns `{tasks, links}`). Add a thin helper that returns `{ node_id, status }[]` so the V2 stale-check mirrors the V1 one.

**Files:**
- Modify: `src/lib/api/workflow-v2.ts` (add `list_engine_task_statuses`)
- Test: `src/lib/api/workflow-v2.statuses.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `src/lib/api/workflow-v2.statuses.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest'
import { list_engine_task_statuses } from './workflow-v2'

afterEach(() => vi.restoreAllMocks())

describe('list_engine_task_statuses', () => {
  it('maps the DAG tasks to {node_id, status} preferring node_id', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      tasks: [
        { id: 'wf:geo', node_id: 'geo', status: 'COMPLETED' },
        { id: 'wf:stat', status: 'RUNNING' },
      ],
      links: [],
    }), { status: 200, headers: { 'content-type': 'application/json' } })))
    const out = await list_engine_task_statuses('wf')
    expect(out).toEqual([
      { node_id: 'geo', status: 'COMPLETED' },
      { node_id: 'stat', status: 'RUNNING' },
    ])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk proxy pnpm exec vitest run src/lib/api/workflow-v2.statuses.test.ts`
Expected: FAIL (not exported).

- [ ] **Step 3: Implement the helper**

In `src/lib/api/workflow-v2.ts`, after `get_v2_dag` (currently `:79-81`), add:

```typescript
/** Stale-check helper: current task statuses keyed by graph node_id.
 *  Mirrors the V1 list_steps shape the editor's stale-check consumes, but
 *  reads the V2 DAG so it works for engine-created workflows too. Returns
 *  the RAW V2 status — the caller runs it through normalize_status. */
export async function list_engine_task_statuses(
  workflow_id: string,
): Promise<Array<{ node_id: string; status: string }>> {
  const dag = await get_v2_dag(workflow_id)
  return dag.tasks.map(t => ({
    node_id: t.node_id ?? (t.id.includes(':') ? t.id.slice(t.id.indexOf(':') + 1) : t.id),
    status: t.status,
  }))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `rtk proxy pnpm exec vitest run src/lib/api/workflow-v2.statuses.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/api/workflow-v2.ts src/lib/api/workflow-v2.statuses.test.ts
git commit -m "feat(workflow-v2): list_engine_task_statuses helper for the V2 stale-check

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Wire the V2 monitor into the execution module behind a flag

Add a `use_v2_monitor` flag (default **false** for now — additive) and a `start_monitoring_v2` that uses `connect_v2_monitor` + the Task-4 reducers + a V2 stale-check using the Task-5 helper. `start_monitoring` dispatches on the flag. The pause-dialog job lookup gains a V2 branch that reads `hpc_job_id` from the DAG tasks.

**Files:**
- Modify: `src/lib/workflow/workflow-execution.svelte.ts`

- [ ] **Step 1: Add the flag + a setter to the factory and interface**

In `workflow-execution.svelte.ts`, inside `create_workflow_execution` near the other `$state` declarations (after line 116's `result_poll_timers`), add:

```typescript
  // #224 Phase 3-core: when true, the editor monitors via the V2-native WS
  // (connect_v2_monitor → initial_state + task_status) instead of the V1
  // compat WS. Default off during the additive phase; flipped on in Task 8.
  let use_v2_monitor = $state(false)
```

Add to the `WorkflowExecution` interface (after `set_node_statuses` at line 50):

```typescript
  set_use_v2_monitor(v: boolean): void
  readonly use_v2_monitor: boolean
```

Add to the returned object (after `set_node_statuses` at line 819):

```typescript
    get use_v2_monitor() { return use_v2_monitor },
    set_use_v2_monitor(v) { use_v2_monitor = v },
```

- [ ] **Step 2: Import the V2 monitor + helper**

In the imports, the line 25 already imports `dry_run_workflow` from `$lib/api/workflow-v2`. Extend that import:

```typescript
import { dry_run_workflow, connect_v2_monitor, list_engine_task_statuses } from '$lib/api/workflow-v2'
```

- [ ] **Step 3: Add `start_monitoring_v2`**

Add a new function next to `start_monitoring` (after `:269`). This mirrors `start_monitoring`'s structure but uses the V2 monitor and reducers:

```typescript
  function start_monitoring_v2(
    workflow_id: string,
    nodes: WfNode[],
  ) {
    if (!workflow_id) return
    stop_monitoring()
    _monitor_workflow_id = workflow_id
    execution_error = null
    monitor_handle = connect_v2_monitor(workflow_id, {
      on_initial_state(dag) {
        const r = reduce_v2_initial_state(dag)
        node_statuses = r.node_statuses
        if (r.failed) {
          execution_error = `Step ${r.failed.node_id}: ${r.failed.error_message ?? `failed`}`
          push_workflow_event(tab_id, { type: `workflow_failed` })
        }
        if (r.has_active) {
          schedule_stale_check()
        } else {
          const all_terminal = Object.values(node_statuses).every(is_terminal)
          if (all_terminal && sim_running) {
            sim_running = false
            const has_failed = Object.values(node_statuses).some(s => s === `failed`)
            workflow_status = has_failed ? `failed` : `completed`
            stop_monitoring()
          }
        }
      },
      on_task_status(task_id, status) {
        const nid = node_id_from_task_id(task_id)
        node_statuses = reduce_v2_task_status(node_statuses, task_id, status)
        const coarse = normalize_status(status)
        if (coarse === `running` || coarse === `queued`) schedule_stale_check()
        const node = nodes.find(n => n.id === nid)
        const label = node ? (NODE_DEFINITIONS[node.type]?.label ?? node.type) : nid
        if (coarse === `failed`) {
          push_workflow_event(tab_id, { type: `step_failed`, step_id: nid, step_label: label })
        } else if (coarse === `completed`) {
          push_workflow_event(tab_id, { type: `step_completed`, step_id: nid, step_label: label })
          setup_result_polling(workflow_id, nid)
        }
        if (workflow_status === `paused` && (coarse === `completed` || coarse === `failed`)) {
          const still_active = Object.values(node_statuses).some(
            s => s === `running` || s === `queued` || s === `submitting`,
          )
          if (!still_active) stop_monitoring()
        }
      },
      on_workflow_status(status) {
        // V2 emits UPPERCASE workflow status too; collapse it.
        const coarse = normalize_status(status)
        workflow_status = coarse
        if (coarse === `completed` || coarse === `failed` || coarse === `not_converged`) {
          sim_running = false
          stop_monitoring()
          push_workflow_event(tab_id, { type: coarse === `completed` ? `workflow_completed` : `workflow_failed` })
        } else if (coarse === `paused`) {
          sim_running = false
        }
      },
      on_error(error) {
        execution_error = error
        console.error(`[Workflow V2]`, error)
      },
    })
  }
```

Note: `setup_result_polling(workflow_id, nid)` passes the **bare node_id** — `fetch_task_results` (`:676`) already namespaces it as `${workflow_id}:${task_id}` when hitting `/engine/tasks/.../result`, so passing the node_id is correct (do not pre-namespace).

- [ ] **Step 4: Dispatch in `start_monitoring`**

At the very top of `start_monitoring` (`:173`), before `if (!workflow_id) return`, add the dispatch:

```typescript
  function start_monitoring(
    workflow_id: string,
    nodes: WfNode[],
  ) {
    if (use_v2_monitor) { start_monitoring_v2(workflow_id, nodes); return }
```

- [ ] **Step 5: Add a V2 branch to the stale-check**

In `check_stale_running_impl` (`:140-164`), replace the `api.list_steps` call so it uses the V2 helper when the flag is on. Replace lines 143-151 with:

```typescript
      const steps = use_v2_monitor
        ? await list_engine_task_statuses(_monitor_workflow_id)
        : await api.list_steps(_monitor_workflow_id)
      if (!steps?.length) return
      for (const s of steps) {
        // V1 list_steps returns coarse status already; V2 helper returns raw
        // UPPERCASE — collapse here so node_statuses stays coarse.
        const node_id = (s as { node_id?: string; id?: string }).node_id ?? (s as { id?: string }).id ?? ``
        const status = use_v2_monitor ? normalize_status(s.status) : s.status
        if (status !== node_statuses[node_id]) {
          node_statuses = { ...node_statuses, [node_id]: status }
        }
      }
```

(Delete the old `const TERMINAL = new Set([...])` line at `:146` — use the module-scope `TERMINAL_STATES`/`is_terminal` instead. Update line 152's `.every(s => TERMINAL.has(s))` to `.every(is_terminal)`.)

- [ ] **Step 6: Add a V2 branch to the pause-dialog job lookup**

In `open_pause_dialog_impl` (`:292-318`), the V1 path calls `api.list_steps` to read `hpc_job_id`/`hpc_session_id` per step. Add a V2 branch that reads them from the DAG tasks. Replace line 297 (`const steps = await api.list_steps(workflow_id)`) with:

```typescript
      const steps = use_v2_monitor
        ? (await import('$lib/api/workflow-v2')).get_v2_dag(workflow_id).then(d => d.tasks.map(t => ({
            id: t.node_id ?? node_id_from_task_id(t.id),
            hpc_job_id: t.hpc_job_id ?? ``,
            hpc_session_id: (() => { try { return (JSON.parse(t.params_json || '{}').hpc_session_id) as string } catch { return undefined } })(),
          })))
        : api.list_steps(workflow_id)
      const resolved_steps = await steps
```

Then update the `.find` on `:303` to use `resolved_steps`:

```typescript
          const step = resolved_steps.find(st => st.id === id)
```

(Both shapes expose `id`, `hpc_job_id`, `hpc_session_id`, so the rest of the mapping at `:304-312` is unchanged.)

- [ ] **Step 7: Type-check**

Run: `rtk proxy pnpm exec svelte-check --tsconfig ./tsconfig.json --threshold error 2>&1 | tail -10`
Expected: no new errors. If `s.status` is flagged as possibly-untyped in the stale-check, annotate the helper's return type (already typed in Task 5) — re-check the import resolves.

- [ ] **Step 8: Run the full unit suite**

Run: `rtk proxy pnpm exec vitest run`
Expected: no new failures (the new monitor path is inert while `use_v2_monitor` is false).

- [ ] **Step 9: Commit**

```bash
git add src/lib/workflow/workflow-execution.svelte.ts
git commit -m "feat(workflow): V2-native monitor path behind use_v2_monitor flag (default off)

start_monitoring_v2 + V2 stale-check + V2 pause-dialog job lookup, all keyed
by node_id with normalize_status collapse. Inert until the flag flips.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Browser-verify the V2 monitor path live (BLOCKING GATE)

Temporarily flip the flag at runtime (not in source) and watch a real run drive `node_statuses` from V2. This is the core live-status proof.

**Files:** none (runtime verification).

- [ ] **Step 1: Ensure the dev stack is running** (from Task 2; restart if needed and wait for `backend-up`).

- [ ] **Step 2: Open the editor on a small workflow**

chrome-devtools MCP:
- `new_page` → frontend URL.
- Navigate to the workflows view, open (or create via the palette) a 2-node workflow: `structure_input` → `geo_opt` (or any built-in calc node). Use `take_snapshot` to find the palette items and `drag`/`click` to author it. Save (the editor autosaves via `schedule_save`).

- [ ] **Step 3: Force the V2 monitor on for this editor instance**

`evaluate_script`:

```javascript
async () => {
  // The editor exposes its execution module per-tab; flip the flag via the
  // module's setter on the active instance. If no global hook exists, set a
  // window override the editor reads on next start_monitoring (see Step 3a).
  window.__CATGO_FORCE_V2_MONITOR__ = true
  return window.__CATGO_FORCE_V2_MONITOR__
}
```

- [ ] **Step 3a: If no runtime hook exists, add a one-line dev override (temporary)**

If the editor has no way to flip the flag at runtime, add this guarded read in `create_workflow_execution` (right after the `use_v2_monitor` declaration) — it is dev-only and harmless in prod:

```typescript
  if (typeof window !== `undefined` && (window as any).__CATGO_FORCE_V2_MONITOR__) {
    use_v2_monitor = true
  }
```

Reload the page after adding it so the editor instantiates with the flag on. (This stays in — it is a deliberate, documented dev escape hatch; Task 8 makes V2 the default anyway.)

- [ ] **Step 4: Run the workflow and watch live status**

Click Run → confirm the Run dialog → Execute. Then poll the DOM for node status classes/colors:

`evaluate_script` (run a few times over ~30s, or use `wait_for`):

```javascript
async () => {
  // Node status is rendered via STATUS_COLORS; scrape the per-node status badges.
  const nodes = [...document.querySelectorAll('[data-node-id]')].map(el => ({
    id: el.getAttribute('data-node-id'),
    status: el.getAttribute('data-status') || getComputedStyle(el).getPropertyValue('--node-status') || '',
  }))
  return nodes
}
```

Expected progression for at least one node: `pending` → `running`/`queued` → `completed` (or `failed`). The transition MUST be driven by the WS (not a poll) — confirm in `list_network_requests` that the active WS is `…/api/engine/workflows/{id}/monitor` and that `task_status` frames arrive (use `get_network_request` on the WS to inspect frames, or add a temporary `console.log` in `on_task_status` and read it via `list_console_messages`).

NOTE on selectors: if `[data-node-id]`/`data-status` attributes don't exist on the node elements, first add them to the node `<g>`/`<rect>` in `WorkflowEditor.svelte`'s node render (`data-node-id={n.id} data-status={node_statuses[n.id] ?? 'pending'}`) — this is a small, legitimate test-affordance improvement; commit it as part of this task. Verify the exact node markup with `take_snapshot` before deciding.

- [ ] **Step 5: Assert no console errors + correct WS**

`list_console_messages` → no uncaught errors, no `effect_update_depth_exceeded`, no 404/connection errors for `…/monitor`. `take_screenshot` for the record.

- [ ] **Step 6: Gate**

If live status flows from the V2 WS with no console errors → check this box and proceed. If not → STOP, debug with superpowers:systematic-debugging (most likely culprits: Task-1 URL, `normalize_status` mapping, or a node_id mismatch — log `node_id_from_task_id` output).

- [ ] **Step 7: Commit any test affordances added**

```bash
git add -A
git commit -m "test(workflow): data-node-id/data-status affordances + dev V2-monitor override

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Flip `use_v2_monitor` on by default

With the live path proven, make V2 the default. Keep the V1 path callable for rollback (the dispatch in `start_monitoring` stays).

**Files:**
- Modify: `src/lib/workflow/workflow-execution.svelte.ts`

- [ ] **Step 1: Change the default**

Change the declaration added in Task 6 from:

```typescript
  let use_v2_monitor = $state(false)
```

to:

```typescript
  // #224 Phase 3-core: V2-native monitor is the default. The V1 compat path
  // (start_monitoring's else branch) is retained as the rollback target.
  let use_v2_monitor = $state(true)
```

- [ ] **Step 2: Run the full unit suite**

Run: `rtk proxy pnpm exec vitest run`
Expected: no new failures (reducers + helpers covered; the inert/active distinction doesn't change pure-fn tests).

- [ ] **Step 3: Type-check**

Run: `rtk proxy pnpm exec svelte-check --tsconfig ./tsconfig.json --threshold error 2>&1 | tail -5`
Expected: no new errors.

- [ ] **Step 4: Browser re-verify WITHOUT the override**

Restart the dev stack (or reload). Do NOT set `window.__CATGO_FORCE_V2_MONITOR__`. Repeat Task 7 Steps 2,4,5 — confirm live status still flows from the V2 WS by default. This is the gate that the default flip works for a fresh editor instance.

- [ ] **Step 5: Commit**

```bash
git add src/lib/workflow/workflow-execution.svelte.ts
git commit -m "feat(workflow): make V2-native monitor the editor default (#224 Phase 3-core)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Verify engine-created workflows load in the editor (investigation gate)

Before changing routing, confirm the editor can actually render an engine-created workflow's graph. The editor loads via `api.get_workflow` → `graph_json` (`WorkflowEditor.svelte:1861-1864`). Engine workflows live in the V2 tables; whether the V1 `GET /api/workflow/{id}` returns a usable `graph_json` for them is the key open question.

**Files:** none yet (verification decides Task 10's shape).

- [ ] **Step 1: Pick an engine workflow id** (from Task 2 Step 2).

- [ ] **Step 2: Probe the V1 get_workflow route for that id**

Run: `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8000/api/workflow/__ENGINE_WF_ID__`
Then: `curl -s http://localhost:8000/api/workflow/__ENGINE_WF_ID__ | python3 -c "import sys,json; d=json.load(sys.stdin); g=json.loads(d.get('graph_json') or '{}'); print('nodes', len(g.get('nodes',[])), 'edges', len(g.get('edges',[])))"`

- [ ] **Step 3: Branch on the result**

- **Case A — returns 200 with non-empty nodes:** the editor will render it as-is. Task 10 only changes routing. Note this in the plan and proceed.
- **Case B — returns 404 or empty graph_json:** the editor cannot load it via V1. We need a graph reconstruction path. The DAG-from-tasks builder already exists (`get_v2_dag` → tasks/links). Add Task 10b (below) to reconstruct `graph_json` from the V2 DAG in `load_workflow`. Decide based on this probe — do NOT speculatively build 10b if Case A holds.

- [ ] **Step 4: Open the engine workflow in the editor via URL/state and screenshot**

chrome-devtools MCP: navigate the editor with the engine workflow id (set `active_workflow_id` via the list, or hash `#workflow?id=__ENGINE_WF_ID__`). `take_snapshot` + `take_screenshot`. Confirm nodes render (Case A) or capture the empty-canvas failure (Case B) for the handoff.

- [ ] **Step 5: Record the verdict (A or B) inline** so Task 10 picks the right path.

---

## Task 10: Unify view routing — both sources default to the editor

Change `desktop/WorkflowView.svelte` so engine workflows open in the editor by default, while keeping an explicit secondary action to open the V2 DAG viewer (UI 2 is preserved per the locked decision).

**Files:**
- Modify: `desktop/WorkflowView.svelte:389,445-449` (and the unified-list click handler)

- [ ] **Step 1: Route the unified-list click to the editor for both sources**

Find the click handler in the unified list that currently branches on `wf.source === 'Engine'` (around `:445-449`). Replace the branch so both sources set `view = 'editor'`:

```svelte
            onclick={() => {
              active_workflow_id = wf.id
              view = `editor`
            }}
```

(Remove the `if (wf.source === 'Engine') { v2_workflow_id = ...; view = 'v2_dag' }` branch.)

- [ ] **Step 2: Route the project-dashboard engine callback to the editor**

Change `:389` from:

```svelte
      on_open_engine_workflow={(id) => { v2_workflow_id = id; v2_selected_task = null; view = `v2_dag` }}
```

to:

```svelte
      on_open_engine_workflow={(id) => { active_workflow_id = id; view = `editor` }}
```

- [ ] **Step 3: Keep UI 2 reachable via an explicit secondary action**

In the unified-list row, add a small secondary button (next to the existing delete button) that opens the DAG viewer, so the data-driven observer is still one click away. Add inside the row actions:

```svelte
            <button
              class="dag-btn"
              title={t('app.open_in_dag_viewer') || 'Open in DAG viewer'}
              onclick={(e) => { e.stopPropagation(); v2_workflow_id = wf.id; v2_selected_task = null; view = `v2_dag` }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="6" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="12" cy="18" r="2"/><path d="M6 8v2a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8M12 14v4"/></svg>
            </button>
```

Add the i18n key `app.open_in_dag_viewer` to BOTH `src/lib/i18n/en/app.ts` and `src/lib/i18n/zh/app.ts` (keep en/zh in parity per CLAUDE.md). en: `'Open in DAG viewer'`; zh: `'在 DAG 视图中打开'`.

- [ ] **Step 4: (Case B only, from Task 9) Reconstruct graph_json from the V2 DAG**

ONLY if Task 9 returned Case B. In `WorkflowEditor.svelte`'s `load_workflow` (`:1857`), wrap the `api.get_workflow` call: if it 404s or yields an empty graph, fall back to building nodes/edges from `get_v2_dag`. Add after the failed V1 fetch:

```typescript
    // Engine-created workflows have no V1 row — reconstruct the editor graph
    // from the V2 DAG (tasks → nodes, links → edges). node_id is the editor id.
    const { get_v2_dag } = await import('$lib/api/workflow-v2')
    const dag = await get_v2_dag(workflow_id)
    nodes = dag.tasks.map((tk, i) => {
      const nid = tk.node_id ?? (tk.id.includes(':') ? tk.id.slice(tk.id.indexOf(':') + 1) : tk.id)
      let params: Record<string, unknown> = {}
      try { params = JSON.parse(tk.params_json || '{}') } catch { /* keep {} */ }
      const def = NODE_DEFINITIONS[tk.task_type]
      return {
        id: nid,
        type: tk.task_type,
        x: 0, y: 0,
        params: def?.default_params ? { ...def.default_params, ...params } : params,
      } as WfNode
    })
    edges = dag.links.map((l, i) => ({
      id: `e${i}`,
      from: l.source_task_id.includes(':') ? l.source_task_id.slice(l.source_task_id.indexOf(':') + 1) : l.source_task_id,
      to: l.target_task_id.includes(':') ? l.target_task_id.slice(l.target_task_id.indexOf(':') + 1) : l.target_task_id,
      fromH: l.source_key || 'out-0',
      toH: l.target_key || 'in-0',
    } as WfEdge))
    do_auto_layout()
    is_loaded = true
```

(Auto-layout because reconstructed nodes have no coordinates.) Skip this entirely for Case A.

- [ ] **Step 5: Type-check + unit suite**

Run: `rtk proxy pnpm exec svelte-check --tsconfig ./tsconfig.json --threshold error 2>&1 | tail -10`
Run: `rtk proxy pnpm exec vitest run`
Expected: no new errors/failures. Confirm i18n parity: `rtk proxy pnpm exec vitest run -t i18n` (if an i18n-parity test exists) or eyeball both app.ts files contain the new key.

- [ ] **Step 6: Commit**

```bash
git add desktop/WorkflowView.svelte src/lib/i18n/en/app.ts src/lib/i18n/zh/app.ts src/lib/workflow/WorkflowEditor.svelte
git commit -m "feat(workflow): open any workflow in the editor; keep DAG viewer as secondary action

#224 Phase 3-core: both GUI and Engine sources default to the editor view.
UI 2 (WorkflowDAGViewer/EngineTaskEditor) preserved via an explicit per-row
'Open in DAG viewer' button.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Browser-verify the convergence end-to-end (FINAL BLOCKING GATE)

The full Phase-3-core acceptance: build → run → live status from V2, AND both sources open in the editor, AND UI 2 still works.

**Files:** none (verification only).

- [ ] **Step 1: Dev stack up** (wait for `backend-up`).

- [ ] **Step 2: GUI-created workflow opens in the editor with live V2 status**

chrome-devtools MCP: from the unified list, click a **GUI** workflow row → asserts `view === 'editor'` (the editor canvas renders). Run it (small workflow) → live status flows (repeat Task 7 Step 4 assertions). `take_screenshot`.

- [ ] **Step 3: Engine-created workflow opens in the editor**

From the unified list, click an **Engine** workflow row → asserts the editor opens and renders nodes (Case A) or the reconstructed graph (Case B). `take_snapshot` confirms ≥1 node. `take_screenshot`.

- [ ] **Step 4: UI 2 still reachable and functional**

Click the per-row "Open in DAG viewer" button → asserts `view === 'v2_dag'`, WorkflowDAGViewer renders tasks, selecting a task opens EngineTaskEditor. `take_screenshot`.

- [ ] **Step 5: Authoring not regressed**

In the editor: drag a new node from the palette (`structure_input`), confirm it appears with default params (`NodeConfigPanel` shows fields), connect an edge, save. Reload → the node persists. This proves NODE_DEFINITIONS/dynamic-engine/plugin authoring still works under the V2-native editor. `take_screenshot`.

- [ ] **Step 6: Console clean**

`list_console_messages` across all four flows → no uncaught errors, no `effect_update_depth_exceeded`, no `each_key_duplicate`, no `…/monitor` connection failures.

- [ ] **Step 7: Final gate**

All of Steps 2-6 PASS → Phase 3-core is browser-verified. If any fail → STOP and debug; do not declare done.

- [ ] **Step 8: Run the full unit suite one more time**

Run: `rtk proxy pnpm exec vitest run`
Expected: no new failures vs baseline.

---

## Self-Review (run before handing off)

- **Spec coverage:** swap monitor (Tasks 1,3,4,6,8) ✓; rekey by node_id (Task 4 reducers + Task 6 wiring) ✓; render status from V2 tasks (Tasks 4,6) ✓; remove source routing split (Task 10) ✓; keep UI 2 (Task 10 Step 3) ✓; keep both authoring paths + node model (Task 11 Step 5 verifies, no node-definitions code touched) ✓; reuse Phase-3-prep enablers (`on_initial_state`, STATUS_COLORS, `/api/engine/*`) ✓; browser-verification gate per milestone (Tasks 2,7,8,9,11) ✓.
- **Type consistency:** `node_id_from_task_id`, `reduce_v2_initial_state`, `reduce_v2_task_status`, `list_engine_task_statuses`, `start_monitoring_v2`, `use_v2_monitor`/`set_use_v2_monitor`, `TERMINAL_STATES`/`is_terminal` are named identically everywhere they appear.
- **No placeholders:** every code step shows the actual code; every run step shows the command + expected output.

---

## Rollback / safety

The change is additive and reversible at three granularities:

1. **Instant runtime rollback (no rebuild):** in `create_workflow_execution`, set `use_v2_monitor = false` (Task 8's line) — the editor reverts to the V1 compat monitor (`connect_workflow_monitor` → `/workflow/{id}/monitor`), which is unchanged. The dispatch in `start_monitoring` keeps the V1 branch intact for exactly this reason.
2. **Per-task git revert:** each task is its own commit. Reverting Task 8 alone restores V1-default monitoring while keeping all V2 plumbing in place. Reverting Task 10 alone restores source-based routing while keeping the V2 monitor.
3. **Backend untouched:** this plan modifies **no Python**. The V1 monitor, v1_compat shim, and all `/api/workflow/*` routes are unchanged, so any FE rollback lands on a fully-working backend. The V2 endpoints (`/api/engine/*`) used here are Phase-2 merged and pre-existing.

Safety invariants held throughout: `node_statuses` stays keyed by **node_id** (no downstream consumer rekeyed); `normalize_status` stays the single V2→coarse collapse point; STATUS_COLORS (already merged) renders both vocabularies; the editor never sends a bare node_id to a V2 task endpoint without `fetch_task_results` namespacing it.

Concurrent-writer caution (handoff spec §5): a separate `catgo-lrg` instance under `/home/shidi/` has caused subagents to find work "already staged." After each commit, run `git show --stat HEAD` to confirm only the intended files landed.

---

## Open questions for the human

1. **Engine-workflow graph load (decides Task 10b):** Does `GET /api/workflow/{id}` return a usable `graph_json` for engine-created (V2-tables-only) workflows? Task 9 probes this. If not (Case B), Task 10 Step 4 reconstructs the graph from the V2 DAG — confirm that node coordinates being lost (auto-layout on open) is acceptable for engine-created workflows, or whether the backend should persist layout into `task.params` / a `graph_json` mirror.
2. **Editing an engine-created workflow:** Once open in the editor, should the user be able to *edit* an engine-created workflow (drag nodes, change params, re-save)? Re-saving goes through V1 `update_workflow` (`graph_json`); for a V2-only workflow there may be no V1 row to update. If editing engine workflows is in-scope, a follow-up is needed to round-trip edits back to the V2 tables. (This plan keeps engine workflows *viewable + runnable* in the editor; full edit round-trip is flagged, not built.)
3. **`workflow_status` UPPERCASE handling:** the V2 `on_workflow_status` frame — is it UPPERCASE (`COMPLETED`) like task status, or already lowercase? Task 6 Step 3 runs it through `normalize_status` defensively (harmless if already lowercase). Confirm the backend's `workflow_status` broadcast casing so we don't double-handle.
4. **Result polling for V2 sub-steps:** fan-out sub-steps key as `{node_id}__sub_N` (per NodeStatusPanel:85-86). The V2 monitor emits `task_status` for parent tasks; confirm whether sub-step statuses arrive as separate `task_status` frames (so the editor needs to handle `__sub_N` keys) or are aggregated. Out of scope for the live-status swap but flagged for Phase 4.
5. **Dev override escape hatch:** Task 7 Step 3a adds `window.__CATGO_FORCE_V2_MONITOR__`. Keep it (cheap, dev-only) or strip it once the default flip (Task 8) is proven? Recommend keep for the V1↔V2 A/B window.

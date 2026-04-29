# HPC Job Status Recheck Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When CatGo reopens after being closed, detect HPC jobs that completed/failed while offline and update workflow state accordingly.

**Architecture:** One backend endpoint `POST /workflow/{id}/recheck-jobs` queries the actual HPC scheduler (squeue/sacct) for steps stuck in `running/queued`. Frontend auto-calls it when opening a workflow with stale steps. If a job completed, collect results (CONTCAR, energy) the same way `hpc_execute.py` does after polling.

**Tech Stack:** Python (FastAPI), asyncssh (existing HPC connections), Svelte 5 (frontend)

---

## Context

### What already exists

- `recover_workflows()` in `engine.py` — runs at backend startup, marks running workflows as paused, does basic sacct check
- `detect_orphan_steps()` in `engine.py` — runs every 5 minutes, checks steps with no heartbeat for >30 min
- `_watch_job_completion()` in `hpc_poll.py` — spawned during pause for still-running jobs
- DB stores `hpc_job_id`, `hpc_session_id`, `work_dir`, `last_polled_at` per step

### What's missing

The existing recovery mechanisms don't handle the primary scenario: user closes CatGo, jobs finish on HPC, user opens CatGo again. The 5-minute orphan scan is too slow and doesn't collect results (CONTCAR/energy). The startup recovery only does sacct status check, not full result collection.

### Design decisions

- **Reuse `hpc_execute.py` result collection logic** — don't duplicate CONTCAR reading, energy extraction, frequency parsing. Extract it into a callable function.
- **Trigger on workflow page open** — not on backend startup (too early, HPC might not be connected yet)
- **One endpoint, one function** — `recheck_stale_jobs()` does everything: check status, collect results if completed, update DB, broadcast via WebSocket

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `server/workflow/job_recheck.py` | **Create** | Core recheck logic: query scheduler, collect results, update DB |
| `server/routers/workflow.py` | Modify | Add `POST /{id}/recheck-jobs` endpoint |
| `server/workflow/hpc_execute.py` | Modify | Extract result collection into reusable `collect_completed_results()` |
| `src/lib/api/workflow.ts` | Modify | Add `recheck_jobs()` API call |
| `src/lib/workflow/workflow-execution.svelte.ts` | Modify | Auto-trigger recheck on monitoring start |

---

### Task 1: Extract result collection from hpc_execute.py

The code at `hpc_execute.py:688-780` (read CONTCAR, extract energy, parse frequencies) is currently inline in `_execute_hpc_node`. Extract it so `job_recheck.py` can reuse it.

**Files:**
- Modify: `server/workflow/hpc_execute.py:688-780`

- [ ] **Step 1: Create `collect_completed_results()` function**

Extract lines 688-780 into a standalone async function. Keep the original code calling this new function.

```python
# At module level in hpc_execute.py, add:

async def collect_completed_results(
    hpc, work_dir: str, node_id: str, node_type: str, params: dict,
    session_id: str, job_id: str,
) -> dict:
    """Read output files from a completed HPC job and return step_results dict.

    Reads CONTCAR/output structure, extracts energy from OUTCAR,
    parses frequencies for freq nodes. Called after job completion
    by both the polling loop and the recheck mechanism.
    """
    result = {
        "status": "completed",
        "work_dir": work_dir,
        "job_id": job_id,
        "session_id": session_id,
        "node_type": node_type,
    }

    if params.get("system_name"):
        result["system_name"] = params["system_name"]

    # Read output structure (CONTCAR etc.)
    output_structure = await _try_read_output_structure(hpc, work_dir, node_type)
    if output_structure:
        result["structure"] = output_structure

    engine_key = get_engine_for_node(node_type)

    # Extract energy from OUTCAR/cp2k.out
    if engine_key == "vasp":
        try:
            r = await hpc.conn.run(
                f"grep 'free  energy   TOTEN' {work_dir}/OUTCAR | tail -1",
                check=False,
            )
            if r.exit_status == 0 and r.stdout.strip():
                energy_str = r.stdout.strip().split("=")[-1].strip().split()[0]
                result["energy"] = float(energy_str)
        except Exception:
            pass

    if engine_key == "cp2k":
        try:
            r = await hpc.conn.run(
                f"grep 'ENERGY| Total' {work_dir}/cp2k.out | tail -1",
                check=False,
            )
            if r.exit_status == 0 and r.stdout.strip():
                energy_ha = float(r.stdout.strip().split()[-1])
                result["energy"] = energy_ha * 27.211386245988
        except Exception:
            pass

    # Parse frequencies for freq nodes
    if node_type == "freq" and engine_key == "vasp":
        try:
            from utils.vasp_freq_parser import parse_vasp_frequencies
            freq_data = await parse_vasp_frequencies(hpc.conn, work_dir)
            if freq_data.get("success"):
                result.update(freq_data)
        except Exception:
            pass

    return result
```

- [ ] **Step 2: Replace inline code in `_execute_hpc_node` with function call**

Replace the existing inline result collection block (lines 688-780) with:

```python
    step_results[node_id] = await collect_completed_results(
        hpc, work_dir, node_id, node_type, params, session_id, job_id,
    )
```

Keep the auto-Gibbs and provenance blocks that follow unchanged.

- [ ] **Step 3: Verify no import issues**

Run: `cd server && python -c "from workflow.hpc_execute import collect_completed_results; print('OK')"`

- [ ] **Step 4: Commit**

```bash
git add server/workflow/hpc_execute.py
git commit -m "refactor: extract collect_completed_results from hpc_execute"
```

---

### Task 2: Create job_recheck.py

**Files:**
- Create: `server/workflow/job_recheck.py`

- [ ] **Step 1: Write the recheck module**

```python
"""Recheck HPC job status for stale running/queued steps.

Called when a user opens a workflow that has steps marked as running
but the orchestrator is no longer polling (e.g., CatGo was restarted).
Queries the actual HPC scheduler and collects results if jobs completed.
"""

import json
import logging
from datetime import datetime, timezone

logger = logging.getLogger(__name__)


async def recheck_stale_jobs(workflow_id: str) -> dict:
    """Check actual HPC status for all running/queued steps.

    For each step with an hpc_job_id:
    1. Query squeue (running jobs) then sacct (finished jobs)
    2. If completed → collect results (CONTCAR, energy, frequencies)
    3. If failed/cancelled → mark failed with reason
    4. Update DB and broadcast via WebSocket

    Returns: {rechecked, updated, results: [{step_id, old_status, new_status}]}
    """
    from utils.workflow_db import list_steps, update_step
    from utils.hpc_client import pool
    from workflow.engine import _broadcast
    from workflow.hpc_execute import collect_completed_results
    from workflow.node_sets import get_engine_for_node

    steps = list_steps(workflow_id)
    active_steps = [
        s for s in steps
        if s.get("status") in ("running", "queued", "submitting")
        and s.get("hpc_job_id")
    ]

    if not active_steps:
        return {"rechecked": 0, "updated": 0, "results": []}

    results = []

    for step in active_steps:
        job_id = step["hpc_job_id"]
        session_id = step.get("hpc_session_id", "")
        step_id = step["id"]
        old_status = step["status"]

        hpc = pool.get_connection(session_id) if session_id else None
        if not hpc:
            # Try any available connection
            for sid, conn in list(pool.connections.items()):
                if conn and conn.conn:
                    hpc = conn
                    session_id = sid
                    break
        if not hpc:
            logger.warning("Recheck: no HPC connection for step %s (job %s)", step_id, job_id)
            continue

        try:
            new_status = await _check_job_actual_status(hpc, job_id)
        except Exception as e:
            logger.warning("Recheck: failed to query job %s: %s", job_id, e)
            continue

        if new_status == old_status or new_status == "running":
            # Still running/pending — no change needed
            update_step(workflow_id, step_id, {
                "last_polled_at": datetime.now(timezone.utc).isoformat(),
            })
            continue

        if new_status == "completed":
            # Job finished — collect results
            node_type = step.get("node_type", "")
            work_dir = step.get("work_dir", "")
            config_raw = step.get("config_json") or "{}"
            try:
                params = json.loads(config_raw)
            except (json.JSONDecodeError, TypeError):
                params = {}

            try:
                step_result = await collect_completed_results(
                    hpc, work_dir, step_id, node_type, params, session_id, job_id,
                )
                update_step(workflow_id, step_id, {
                    "status": "completed",
                    "result_json": json.dumps(step_result, default=str),
                    "completed_at": datetime.now(timezone.utc).isoformat(),
                    "last_polled_at": datetime.now(timezone.utc).isoformat(),
                })
            except Exception as e:
                logger.error("Recheck: result collection failed for %s: %s", step_id, e)
                update_step(workflow_id, step_id, {
                    "status": "completed",
                    "completed_at": datetime.now(timezone.utc).isoformat(),
                    "error_message": f"Job completed but result collection failed: {e}",
                })

        elif new_status == "failed":
            update_step(workflow_id, step_id, {
                "status": "failed",
                "error_message": f"Job {job_id} failed on HPC (detected on recheck)",
                "completed_at": datetime.now(timezone.utc).isoformat(),
            })

        results.append({
            "step_id": step_id,
            "job_id": job_id,
            "old_status": old_status,
            "new_status": new_status,
        })

        await _broadcast(workflow_id, {
            "type": "step_status",
            "step_id": step_id,
            "status": new_status,
        })

        logger.info(
            "Recheck: step %s job %s: %s → %s",
            step_id, job_id, old_status, new_status,
        )

    return {
        "rechecked": len(active_steps),
        "updated": len(results),
        "results": results,
    }


async def _check_job_actual_status(hpc, job_id: str) -> str:
    """Query scheduler for actual job status. Returns: running/completed/failed."""
    # Try squeue first (for running/pending jobs)
    try:
        job_info = await hpc.scheduler.get_job_status(hpc.conn, job_id)
        if job_info:
            s = job_info.status.upper() if job_info.status else ""
            if s in ("COMPLETED", "CD"):
                return "completed"
            if s in ("FAILED", "F", "NODE_FAIL", "NF", "TIMEOUT", "TO",
                      "CANCELLED", "CA", "OOM", "OUT_OF_MEMORY"):
                return "failed"
            return "running"  # PENDING, RUNNING, etc.
    except Exception:
        pass

    # Job not in squeue — try sacct (finished jobs history)
    if hasattr(hpc.scheduler, "get_job_status_sacct"):
        try:
            sacct_info = await hpc.scheduler.get_job_status_sacct(hpc.conn, job_id)
            if sacct_info and sacct_info.status:
                s = sacct_info.status.upper()
                if s in ("COMPLETED", "CD"):
                    return "completed"
                if s in ("FAILED", "F", "NODE_FAIL", "NF", "TIMEOUT", "TO",
                          "CANCELLED", "CA"):
                    return "failed"
        except Exception:
            pass

    # Can't determine — assume still running (don't falsely mark as failed)
    return "running"
```

- [ ] **Step 2: Commit**

```bash
git add server/workflow/job_recheck.py
git commit -m "feat: add job_recheck module for detecting completed HPC jobs after restart"
```

---

### Task 3: Add backend endpoint

**Files:**
- Modify: `server/routers/workflow.py`

- [ ] **Step 1: Add the recheck endpoint after the reset endpoint**

```python
@router.post("/{workflow_id}/recheck-jobs")
async def api_recheck_jobs(workflow_id: str):
    """Check actual HPC status for running/queued steps.

    Called when user opens a workflow that may have stale step statuses
    (e.g., after CatGo restart). Queries scheduler and collects results
    for any jobs that completed while CatGo was offline.
    """
    try:
        wf = get_workflow(workflow_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Workflow {workflow_id} not found")

    from workflow.job_recheck import recheck_stale_jobs
    result = await recheck_stale_jobs(workflow_id)
    return result
```

- [ ] **Step 2: Commit**

```bash
git add server/routers/workflow.py
git commit -m "feat: add POST /workflow/{id}/recheck-jobs endpoint"
```

---

### Task 4: Add frontend API call and auto-trigger

**Files:**
- Modify: `src/lib/api/workflow.ts`
- Modify: `src/lib/workflow/workflow-execution.svelte.ts`

- [ ] **Step 1: Add API function**

In `src/lib/api/workflow.ts`, after `reset_workflow`:

```typescript
export async function recheck_jobs(id: string): Promise<{
  rechecked: number
  updated: number
  results: Array<{ step_id: string; job_id: string; old_status: string; new_status: string }>
}> {
  const response = await fetch(`${API_BASE}/workflow/${encodeURIComponent(id)}/recheck-jobs`, {
    method: `POST`,
  })
  return handle_response(response)
}
```

- [ ] **Step 2: Auto-trigger recheck when monitoring starts**

In `src/lib/workflow/workflow-execution.svelte.ts`, modify `start_monitoring_impl` to call recheck after initial state:

Find the `on_initial_state` callback inside `start_monitoring_impl`. After the existing initial state handling, add:

```typescript
// After setting initial node_statuses from the received data:

// Auto-recheck: if any steps are running/queued, query HPC for actual status
const has_stale = Object.values(node_statuses).some(
  s => s === `running` || s === `queued` || s === `submitting`
)
if (has_stale) {
  api.recheck_jobs(workflow_id).then(result => {
    if (result.updated > 0) {
      console.log(`[Workflow] Recheck: ${result.updated} jobs updated`)
    }
  }).catch(err => {
    console.warn(`[Workflow] Recheck failed:`, err)
  })
}
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/api/workflow.ts src/lib/workflow/workflow-execution.svelte.ts
git commit -m "feat: auto-recheck HPC job status when opening workflow"
```

---

### Task 5: Add manual refresh button

**Files:**
- Modify: `src/lib/workflow/WorkflowEditor.svelte`

- [ ] **Step 1: Add refresh button next to Run/Pause/Reset in the toolbar**

Find the toolbar section (around line 1882). After the Reset button, add:

```svelte
{#if workflow_status !== `draft`}
  <button class="tbtn" onclick={async () => {
    try {
      const result = await api.recheck_jobs(workflow_id)
      if (result.updated > 0) {
        // WebSocket will update node_statuses automatically
      }
    } catch (err) {
      console.error(`Recheck failed:`, err)
    }
  }} title="Check HPC job status">🔄</button>
{/if}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/workflow/WorkflowEditor.svelte
git commit -m "feat: add manual job status refresh button"
```

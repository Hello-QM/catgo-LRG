---
name: workflow_errors
description: Diagnose and fix CatGo workflow engine errors including HPC connection failures, missing POTCARs, stuck tasks, and REMOTE_ERROR states.
---

# CatGo Workflow Engine Error Troubleshooting Skill

## When to Use

Use this skill when the problem is NOT with the DFT code itself, but with
CatGo's workflow engine, HPC connectivity, or job management. Route here when:

- Tasks are stuck in READY or SUBMITTED state
- HPC connection fails (SSH, SFTP)
- POTCAR or pseudopotential files not found
- REMOTE_ERROR status on a task
- Workflow does not start after submission
- Job disappears from queue unexpectedly

## Diagnostic Steps

### Step 1: Check system status

```json
catgo_system(action: "status")
```

This reports:
- Backend health (FastAPI server running)
- HPC connection status (SSH connected, SFTP available)
- Engine status (scanner running, poller active)

### Step 2: Check workflow and task status

```json
catgo_workflow_engine(action: "status", params: { workflow_id: "<wf_id>" })
```

### Step 3: Get recent error logs

```json
catgo_system(action: "errors")
```

---

## Error Reference

### No HPC Connection

**Symptoms:**
- Tasks stay in READY state indefinitely
- `catgo_system(action: "status")` shows no active HPC connections
- Error: "No HPC connection available"

**Diagnosis:**
```json
catgo_system(action: "status")
```

**Fixes:**
1. Verify HPC credentials are configured in the CatGo settings
2. Check that the HPC host is reachable (not under maintenance)
3. If using SSH key + OTP, ensure the OTP token is current
4. Reconnect via the CatGo HPC settings panel in the frontend

**Note:** CatGo uses asyncssh with keyboard-interactive authentication.
Some HPC systems have specific prompt formats for OTP that may need special
handling. See `server/CLAUDE.md` for the KbdintSSHClient OTP issue.

### POTCAR Not Found

**Symptoms:**
- VASP task fails immediately after submission
- Error message contains "POTCAR" or "pseudopotential"
- Error: "Could not find POTCAR for element X"

**Diagnosis:**
```json
catgo_workflow_engine(action: "get_result", params: {
  workflow_id: "<wf_id>",
  task_id: "<task_id>"
})
```

**Fixes:**
1. Check that `VASP_PP_PATH` is set correctly on the HPC:
   - Should point to the directory containing `potpaw_PBE/`, `potpaw_LDA/`
   - Each element dir must contain a `POTCAR` file

2. For CP2K, check that the basis set and pseudopotential files are in the
   CP2K data directory (usually `$CP2K_DATA_DIR`).

3. If the element was recently added to the structure (e.g., a dopant),
   the POTCAR generation may not include it. Verify the structure has
   correct elements:
```json
catgo_view(action: "get_state")
```

### Task Stuck in READY

**Symptoms:**
- Task shows `state: "READY"` for a long time
- No HPC job is submitted
- No error message

**Diagnosis:**
```json
catgo_workflow_engine(action: "status", params: { workflow_id: "<wf_id>" })
```

**Possible causes and fixes:**

1. **Upstream task not complete:** The task depends on another task that has
   not finished. Check the DAG:
```json
catgo_workflow_engine(action: "get_dag", params: { workflow_id: "<wf_id>" })
```

2. **Engine scanner not running:** The workflow engine scanner picks up READY
   tasks periodically. Check system status:
```json
catgo_system(action: "status")
```

3. **Workflow not submitted:** The workflow was created but never submitted:
```json
catgo_workflow_engine(action: "submit", params: { workflow_id: "<wf_id>" })
```

4. **Manual reset:** Force the task back to READY and re-trigger:
```json
catgo_workflow_engine(action: "reset", params: {
  workflow_id: "<wf_id>",
  task_id: "<task_id>"
})
```

### REMOTE_ERROR

**Symptoms:**
- Task status shows `state: "REMOTE_ERROR"`
- The job was submitted to HPC but something failed during execution

**Diagnosis:**
```json
catgo_workflow_engine(action: "get_result", params: {
  workflow_id: "<wf_id>",
  task_id: "<task_id>"
})
```

**Common causes:**
1. **Job killed by scheduler:** Exceeded walltime or memory limit. Increase
   resources in run_config.
2. **File system error:** HPC scratch space full or quota exceeded.
3. **Module not loaded:** Required software module not available. Check the
   HPC submission script.
4. **SFTP failure during file transfer:** CatGo could not upload input files
   or download results. The SFTP fallback (exec-based transfer) should handle
   this automatically, but some HPC systems restrict both.

**Fix:** After addressing the root cause:
```json
catgo_workflow_engine(action: "retry", params: {
  workflow_id: "<wf_id>",
  task_id: "<task_id>"
})
```

### Task Stuck in SUBMITTED / RUNNING

**Symptoms:**
- Task shows SUBMITTED or RUNNING but the HPC job has already finished
- The poller is not picking up the completed job

**Diagnosis:**
```json
catgo_system(action: "status")
```

Check if the engine poller is active. If not, the backend may need a restart.

**Fix:** Reset the task to re-trigger polling:
```json
catgo_workflow_engine(action: "reset", params: {
  workflow_id: "<wf_id>",
  task_id: "<task_id>"
})
```

### Workflow Paused Unexpectedly

An error handler may pause a workflow after task failure to prevent cascading
failures. Fix the failed task first, then resume:

```json
catgo_workflow_engine(action: "resume", params: { workflow_id: "<wf_id>" })
```

## Recovery Actions Summary

- **Retry**: `catgo_workflow_engine(action: "retry", params: {workflow_id, task_id})`
- **Reset**: `catgo_workflow_engine(action: "reset", params: {workflow_id, task_id})`
- **Modify + retry**: `modify_params` then `retry`
- **Check DAG**: `catgo_workflow_engine(action: "get_dag", params: {workflow_id})`

## When to Escalate

- Backend down: user needs to restart (`pnpm desktop:serve`)
- Repeated HPC connection failures: re-enter credentials or check maintenance
- Same REMOTE_ERROR after multiple retries: likely environmental (HPC config)

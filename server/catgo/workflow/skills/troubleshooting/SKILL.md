---
name: troubleshooting-router
description: Routes troubleshooting requests to vasp_errors, convergence_issues, or workflow_errors sub-skills based on the type of problem.
---

# Troubleshooting Router Skill

## When to Use

Use this skill when the user reports a problem with a calculation or workflow.
Route to the appropriate sub-skill based on the error type.

## Routing Decision Tree

### Step 1: Identify the error source

Ask the user or check the workflow status:

```json
catgo_workflow_engine(action: "status", params: { workflow_id: "<wf_id>" })
```

If a specific task failed, get the error details:

```json
catgo_workflow_engine(action: "get_result", params: {
  workflow_id: "<wf_id>",
  task_id: "<task_id>"
})
```

### Step 2: Route based on error type

| Error signature | Route to |
|---|---|
| VASP error messages (ZBRENT, BRMIX, EDDDAV, etc.) | `troubleshooting/vasp_errors` |
| SCF not converging, ionic relaxation oscillating | `troubleshooting/convergence_issues` |
| ORCA SCF/geometry convergence | `troubleshooting/convergence_issues` |
| CatGo engine errors (REMOTE_ERROR, stuck tasks) | `troubleshooting/workflow_errors` |
| HPC connection issues (SSH, SFTP) | `troubleshooting/workflow_errors` |
| POTCAR not found, missing files | `troubleshooting/workflow_errors` |
| Test/verify cluster config before submitting; POTCAR/pseudopotential/binary/module checks; job "completed" with no output | `troubleshooting/cluster_config_test` |

### Step 3: Gather diagnostics

Before routing, collect relevant information:

```json
catgo_workflow_engine(action: "status", params: { workflow_id: "<wf_id>" })
```

For VASP/convergence issues, check the calculation output:

```json
catgo_analyze(action: "convergence", params: {
  workflow_id: "<wf_id>",
  task_id: "<task_id>"
})
```

For system-level issues:

```json
catgo_system(action: "status")
```

```json
catgo_system(action: "errors")
```

## Common Patterns

### "My calculation failed"
1. Check workflow status to identify which task failed
2. Get the error message from the failed task
3. Route to the appropriate sub-skill

### "My calculation is taking too long"
1. Check if it is still running or stuck
2. If running: check convergence progress -> `convergence_issues`
3. If stuck in READY/QUEUED: -> `workflow_errors`

### "My results look wrong"
1. Check if the calculation converged
2. Check for warnings in the output
3. Often a convergence issue in disguise -> `convergence_issues`

### "I cannot connect to the HPC"
Direct to `workflow_errors` for SSH/connection troubleshooting.

## MCP Tool Examples

### Full diagnostic sequence

1. Get workflow overview:
```json
catgo_workflow_engine(action: "status", params: { workflow_id: "<wf_id>" })
```

2. Get failed task details:
```json
catgo_workflow_engine(action: "get_result", params: {
  workflow_id: "<wf_id>",
  task_id: "<failed_task_id>"
})
```

3. Check convergence if applicable:
```json
catgo_analyze(action: "convergence", params: {
  workflow_id: "<wf_id>",
  task_id: "<task_id>"
})
```

4. Check system health:
```json
catgo_system(action: "status")
```

5. Based on findings, route to the appropriate sub-skill and apply fixes.

### Quick retry after fixing parameters

```json
catgo_workflow_engine(action: "modify_params", params: {
  workflow_id: "<wf_id>",
  task_id: "<task_id>",
  params: { "ALGO": "All", "NELM": 200 }
})
```

```json
catgo_workflow_engine(action: "retry", params: {
  workflow_id: "<wf_id>",
  task_id: "<task_id>"
})
```

## Key Principle

Always diagnose before prescribing. Do not blindly suggest parameter changes
without first understanding what went wrong. Use the diagnostic tools
(`status`, `get_result`, `convergence` analysis) to identify the root cause,
then apply targeted fixes.

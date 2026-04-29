# P6: End-to-End Vision — Close ALL Gaps

> **For agentic workers:** Execute with subagent-driven-development.

**Goal:** Close every gap between current state and the vision. After this, a user can create a workflow in Claude Code → engine submits to HPC → frontend shows DAG + status in real-time.

**Current:** 95 tests pass, Python API works, engine executes local tasks, MCP tool defined but untested end-to-end.

---

## Task List (9 tasks, parallelizable in groups)

### Group 1: Frontend V2 Viewer (the biggest gap)

**Task 1: V2 Workflow List Page**
- Create `src/lib/workflow/WorkflowListV2.svelte` (<150 lines)
- Fetch from `GET /api/v2/workflows`
- Show table: name, status, task count, created_at
- Click → navigate to DAG view

**Task 2: V2 DAG Viewer Component**
- Create `src/lib/workflow/WorkflowDAGViewer.svelte` (<200 lines)
- Fetch from `GET /api/v2/workflows/{id}/dag`
- Render nodes (tasks) and edges (links) using SVG (reuse existing node card style)
- Color nodes by status (WAITING=gray, READY=blue, RUNNING=yellow, COMPLETED=green, FAILED=red)
- Click node → show task details panel

**Task 3: V2 Task Detail Panel**
- Create `src/lib/workflow/TaskDetailPanel.svelte` (<150 lines)
- Fetch from `GET /api/v2/tasks/{id}`
- Show: type, status, params, result (energy/structure), error message
- Edit params button (PUT /api/v2/tasks/{id}/params) for WAITING/READY tasks
- Retry button, Cancel button

### Group 2: Real-time Monitoring

**Task 4: V2 WebSocket Endpoint**
- Add `WS /api/v2/workflows/{id}/monitor` to `server/routers/workflow_v2.py`
- Scanner broadcasts status changes via asyncio.Queue (same pattern as existing v1)
- Frontend connects on DAG view open, receives step_status updates

**Task 5: V2 Status Polling (fallback)**
- In DAGViewer, poll `GET /api/v2/workflows/{id}` every 5s if WebSocket unavailable
- Update node colors on status change

### Group 3: Bridge Old GUI → New Engine

**Task 6: graph_json → tasks Converter**
- Create `server/catgo/workflow/graph_converter.py` (<120 lines)
- Parse frontend graph_json (nodes + edges) → create tasks + task_links in new DB
- Map old node types to new task types
- Called when user clicks "Run" on a GUI-created workflow

**Task 7: Wire Converter into Run Endpoint**
- Modify `server/routers/workflow.py` POST /{id}/run
- Before starting old orchestrator, also write to new tasks table
- This way both old and new systems see the workflow

### Group 4: MCP + HPC Validation

**Task 8: Test MCP with Real Claude Code**
- Create a test script that Claude Code can run via MCP:
  ```python
  # test_mcp_live.py — run this IN Claude Code
  # Uses catgo_workflow_v2 MCP tool to create a simple workflow
  # Verifies it appears in /api/v2/workflows
  ```

**Task 9: HPC Dry Run Test**
- Create `server/tests/test_hpc_dry_run.py`
- Mock HPC connection, test submitter → poller → collector flow
- Verify state transitions: READY → GENERATING → UPLOADING → SUBMITTED → RUNNING → COMPLETED_REMOTE → COMPLETED
- No real HPC needed — mock the SSH/scheduler calls

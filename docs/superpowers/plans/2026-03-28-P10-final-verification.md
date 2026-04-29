# P10: Final Verification — Fix Tests + E2E + High-Throughput

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all remaining test failures, verify the full GUI→V2 engine flow works end-to-end, and run a real high-throughput Map test on Expanse.

**Architecture:** No new features. Pure verification and bug fixes.

---

## Task 1: Fix All Remaining Test Failures

### 1A: Provenance tests (3 failing)

**Root cause:** `find_duplicate()` in `provenance.py` doesn't handle empty `input_hashes`. Also, tests may reference old table names (before v2_ prefix).

**Files:**
- `server/catgo/workflow/provenance.py` — fix `find_duplicate()` empty input_hashes path
- `server/tests/test_provenance.py` — verify all 15 tests pass

- [ ] Read `server/catgo/workflow/provenance.py`, find `find_duplicate`, fix the empty dict case
- [ ] Run: `python -m pytest server/tests/test_provenance.py -v`
- [ ] All 15 pass → commit

### 1B: While loop tests (2 failing)

**Root cause:** `test_while_iterates_until_max` and `test_while_reports_iterations` need more scan cycles. The while loop needs multiple cycles per iteration (advance children → execute → check condition → reset).

**Files:**
- `server/tests/test_while_loop.py`

- [ ] Increase scan cycles in failing tests (try 60-80 cycles for max_iterations=3)
- [ ] If still failing, add debug prints to understand the state machine flow
- [ ] Run: `python -m pytest server/tests/test_while_loop.py -v`
- [ ] All 14 pass → commit

### 1C: Batch submit tests (5 failing)

**Root cause:** Tests use `@pytest.mark.asyncio` which requires pytest-asyncio plugin. Convert to `asyncio.new_event_loop()` pattern.

**Files:**
- `server/tests/test_batch_submit.py`

- [ ] Add `_run(coro)` helper using `asyncio.new_event_loop()`
- [ ] Remove all `@pytest.mark.asyncio` decorators
- [ ] Change `async def test_*` to `def test_*`, wrap async calls with `_run()`
- [ ] Run: `python -m pytest server/tests/test_batch_submit.py -v`
- [ ] All 6 pass → commit

### 1D: AI diagnosis tests (2 failing)

**Root cause:** Same async pattern issue as batch tests.

**Files:**
- `server/tests/test_ai_diagnosis.py`

- [ ] Same fix as 1C — convert async tests to `_run()` pattern
- [ ] Run: `python -m pytest server/tests/test_ai_diagnosis.py -v`
- [ ] All 10 pass → commit

### 1E: Full test suite verification

- [ ] Run ALL workflow tests:
```bash
cd /home/james0001/project/catgo/.worktrees/split-files
python -m pytest server/tests/test_config.py server/tests/test_states.py server/tests/test_reference.py server/tests/test_task_decorator.py server/tests/test_db.py server/tests/test_workflow.py server/tests/test_engine_advancer.py server/tests/test_engine_resolver.py server/tests/test_engine_error_handler.py server/tests/test_engine_scanner.py server/tests/test_engine_lifecycle.py server/tests/test_builtins_execution.py server/tests/test_integration_local.py server/tests/test_mcp_workflow.py server/tests/test_broadcast.py server/tests/test_graph_converter.py server/tests/test_graph_converter_ids.py server/tests/test_hpc_dry_run.py server/tests/test_job_script.py server/tests/test_conditional.py server/tests/test_provenance.py server/tests/test_while_loop.py server/tests/test_map.py server/tests/test_zone.py server/tests/test_batch_submit.py server/tests/test_smart_recovery.py server/tests/test_engine_merge.py server/tests/test_state_map.py server/tests/test_v1_compat.py server/tests/test_v1_monitor.py server/tests/test_ai_diagnosis.py -v
```
- [ ] Target: ALL pass (0 failures)

---

## Task 2: End-to-End GUI Verification

**Prerequisites:** CatGo backend must be running, Expanse SSH connected.

- [ ] Start CatGo: `cd /home/james0001/project/catgo/.worktrees/split-files && pnpm desktop:serve`
- [ ] Connect Expanse SSH in CatGo HPC panel
- [ ] In Project Dashboard, create a new workflow
- [ ] Add nodes: structure_input → geo_opt (VASP, ENCUT=520, NSW=3)
- [ ] Click Run, confirm HPC params (partition=shared, account=sdp126)
- [ ] Watch server logs: should see `WorkflowEngine` / `scan_cycle` (V2 engine, NOT old engine)
- [ ] Watch NodeStatusPanel: should show convergence data when job starts
- [ ] Check V2 DAG viewer (⚡ V2 Engine button): should show same workflow with live status
- [ ] Wait for completion, verify CONTCAR/OUTCAR appear in file browser
- [ ] Test pause/resume: pause the workflow, verify tasks go to PAUSED, resume, verify they continue

---

## Task 3: High-Throughput Map Test on Expanse

**Prerequisites:** Backend running, Expanse connected, all tests passing.

- [ ] Create a test script that uses Map to fan out:

```python
# server/tests/test_map_hpc.py (manual test, not pytest)
"""High-throughput Map test — fan out 5 structures on Expanse.

Usage: python -m tests.test_map_hpc
Requires: CatGo backend running on port 8000, Expanse SSH connected.
"""
import json, requests, time

API = "http://localhost:8000/api"

# 5 simple structures (TiO2 with slightly different lattice params)
structures = []
for a in [4.5, 4.55, 4.6, 4.65, 4.7]:
    structures.append(json.dumps({
        "lattice": {"matrix": [[a,0,0],[0,a,0],[0,0,2.96]]},
        "sites": [
            {"species": [{"element": "Ti", "occu": 1}], "abc": [0,0,0], "xyz": [0,0,0]},
            {"species": [{"element": "Ti", "occu": 1}], "abc": [0.5,0.5,0.5], "xyz": [a/2,a/2,1.48]},
            {"species": [{"element": "O", "occu": 1}], "abc": [0.3,0.3,0], "xyz": [0.3*a,0.3*a,0]},
            {"species": [{"element": "O", "occu": 1}], "abc": [0.7,0.7,0], "xyz": [0.7*a,0.7*a,0]},
            {"species": [{"element": "O", "occu": 1}], "abc": [0.8,0.2,0.5], "xyz": [0.8*a,0.2*a,1.48]},
            {"species": [{"element": "O", "occu": 1}], "abc": [0.2,0.8,0.5], "xyz": [0.2*a,0.8*a,1.48]},
        ]
    }))

# Use Python API directly (not REST) to test Map
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from catgo.workflow.workflow import Workflow
from catgo.workflow.db import WorkflowDB
from catgo.workflow.config import load_config

config = load_config()
db = WorkflowDB(str(os.path.expanduser(config["paths"]["db_path"])))

wf = Workflow("Map Test — 5 TiO2 lattice params", db=db)
mapped = wf.map_task("structure_input", over={"structure": structures})
print(f"Created workflow: {wf.workflow_id}")
print(f"Map controller: {mapped.map_task_id}")
print(f"Children: {len(mapped.child_ids)}")
wf.submit()
print("Submitted! Engine will pick it up.")

# Poll status
for i in range(5):
    time.sleep(35)
    tasks = db.get_all_tasks(wf.workflow_id)
    print(f"\n--- {35*(i+1)}s ---")
    for t in tasks:
        print(f"  {t['task_type']:20s} {t['status']:15s} map_key={t.get('map_key', '-')}")
    if all(t['status'] in ('COMPLETED', 'FAILED', 'MAPPED', 'SKIPPED') for t in tasks):
        break

# Gather results
results = mapped.gather("structure_json")
print(f"\nGathered {len([r for r in results if r])} results out of {len(results)}")
```

- [ ] Run: `cd server && python -m tests.test_map_hpc`
- [ ] Verify: 5 structure_input tasks complete in parallel
- [ ] Verify: gather() returns 5 non-None results
- [ ] Check V2 DAG viewer: should show Map group with 5 children

- [ ] (Optional) Test with geo_opt if structure_input works:
```python
# Replace structure_input with geo_opt for real HPC test
mapped = wf.map_task("geo_opt",
    over={"structure": structures},
    software="vasp", ENCUT=520, NSW=3)
```
- [ ] Verify: submitter auto-promotes to array job (check server logs for "array")
- [ ] Verify: squeue shows single array job on Expanse

---

## Success Criteria

1. **ALL tests pass** — 0 failures across ~120 tests
2. **GUI Run → V2 engine** — server logs show `scan_cycle`, NOT old `start_workflow`
3. **Map fan-out works** — 5 structures → 5 completed tasks → gather returns 5 results
4. **Array job** (bonus) — geo_opt map auto-promoted to sbatch --array

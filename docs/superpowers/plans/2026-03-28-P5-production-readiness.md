# P5: Production Readiness — Complete the New Workflow Engine

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the new workflow engine (`catgo.workflow`) production-ready: all local tasks implemented, all engines registered, MCP integrated, end-to-end tested, and properly wired into the backend.

**Source:** Gap analysis at `/home/james0001/project/references/gap_analysis.md`

**Principle:** No hacks. Every fix is clean, tested, pluggable. No file >150 lines.

---

## Phase A: Core Fixes (must work before anything else)

### Task A1: Implement Local Task Functions

All local task bodies are `pass`. Implement them by calling existing backend code.

**Files:**
- Modify: `server/catgo/workflow/builtins.py`
- Create: `server/tests/test_builtins_execution.py`

- [ ] **Step 1: Implement structure_input**

```python
@task(task_type="structure_input", local=True, outputs=["structure"])
def structure_input(structure=None, **params):
    """Pass-through: provides a structure to the workflow."""
    if structure is None:
        return {"structure": None}
    # Accept JSON string or dict
    if isinstance(structure, str):
        return {"structure": structure}
    import json
    return {"structure": json.dumps(structure)}
```

- [ ] **Step 2: Implement gibbs_energy**

```python
@task(task_type="gibbs_energy", local=True, outputs=["gibbs", "zpe"])
def gibbs_energy(energy=None, frequencies=None, phase="adsorbed",
                 temperature=298.15, freq_cutoff=50, pressure_atm=1.0,
                 n_unpaired=0, system_name="", **params):
    """Compute Gibbs free energy: G = E_DFT + ZPE - TS."""
    if energy is None:
        return {"gibbs": None, "zpe": None}

    import json
    e_dft = float(energy)

    # Parse frequencies
    real_freqs_cm = []
    imag_freqs_cm = []
    if frequencies:
        freq_data = json.loads(frequencies) if isinstance(frequencies, str) else frequencies
        if isinstance(freq_data, list):
            for f in freq_data:
                if isinstance(f, dict):
                    real_freqs_cm.append(float(f.get("frequency_cm", 0)))
                else:
                    val = float(f)
                    if val < 0:
                        imag_freqs_cm.append(abs(val))
                    else:
                        real_freqs_cm.append(val)

    from utils.gibbs_calculator import calc_adsorbed, calc_gas

    if phase == "gas":
        gibbs_result = calc_gas(
            real_freqs_cm, imag_freqs_cm, [], [], [],
            T=temperature, P=pressure_atm * 101325.0,
            n_unpaired=n_unpaired,
        )
    else:
        gibbs_result = calc_adsorbed(
            real_freqs_cm, imag_freqs_cm,
            T=temperature, freq_cutoff=freq_cutoff,
        )

    zpe = gibbs_result["zpe_ev"]
    g_corr = gibbs_result["g_corr_ev"]
    g_total = e_dft + g_corr

    return {
        "gibbs": g_total,
        "zpe": zpe,
        "energy": e_dft,
        "g_corr": g_corr,
        "ts_correction": gibbs_result["h_corr_ev"] - g_corr,
        "system_name": system_name,
    }
```

- [ ] **Step 3: Implement remaining stubs with pass-through or error**

```python
@task(task_type="slab_gen", local=True, outputs=["structure"])
def slab_gen(structure=None, miller=(1, 1, 0), layers=4, vacuum=15.0, **params):
    """Generate slab — delegates to pymatgen SlabGenerator."""
    if structure is None:
        raise ValueError("slab_gen requires a structure input")
    # Import only when called (avoid slow startup)
    from pymatgen.core import Structure
    from pymatgen.core.surface import SlabGenerator
    import json

    struct_data = json.loads(structure) if isinstance(structure, str) else structure
    struct = Structure.from_dict(struct_data)
    miller_tuple = tuple(int(m) for m in miller)

    gen = SlabGenerator(struct, miller_tuple, min_slab_size=layers * 2.0,
                       min_vacuum_size=vacuum, center_slab=True)
    slabs = gen.get_slabs()
    if not slabs:
        raise RuntimeError(f"No slabs generated for miller={miller_tuple}")

    slab = slabs[0]
    return {"structure": json.dumps(slab.as_dict())}


@task(task_type="adsorbate_place", local=True, outputs=["structure"])
def adsorbate_place(structure=None, species="OH", site="all", height=2.0, **params):
    """Place adsorbate on surface — returns structure with adsorbate."""
    if structure is None:
        raise ValueError("adsorbate_place requires a structure input")
    # Minimal implementation — real placement uses WASM or pymatgen AdsorbateSiteFinder
    # For now, pass structure through (adsorbate placement is complex, deferred to WASM)
    return {"structure": structure}


@task(task_type="free_energy_diagram", local=True, outputs=["plotly_data"])
def free_energy_diagram(gibbs_values=None, step_order=None, **params):
    """Generate free energy diagram data."""
    return {"plotly_data": None}  # Implemented via frontend EnergyDiagramPlot


@task(task_type="dos_analysis", local=True, outputs=["dos_data"])
def dos_analysis(data=None, d_band=True, **params):
    """DOS analysis — requires HPC output data."""
    return {"dos_data": data}


@task(task_type="charge_analysis", local=True, outputs=["charges"])
def charge_analysis(data=None, method="bader", **params):
    """Charge analysis — requires HPC output data."""
    return {"charges": data}
```

- [ ] **Step 4: Write tests**

```python
# server/tests/test_builtins_execution.py
import pytest
from catgo.workflow.builtins import structure_input, gibbs_energy


class TestStructureInput:
    def test_string_passthrough(self):
        result = structure_input(structure='{"sites": []}')
        assert result["structure"] == '{"sites": []}'

    def test_none_returns_none(self):
        result = structure_input()
        assert result["structure"] is None

    def test_dict_serialized(self):
        result = structure_input(structure={"sites": []})
        assert '"sites"' in result["structure"]


class TestGibbsEnergy:
    def test_returns_gibbs(self):
        result = gibbs_energy(energy=-42.5, frequencies="[]", phase="adsorbed")
        assert result["gibbs"] is not None
        assert result["zpe"] is not None
        assert isinstance(result["gibbs"], float)

    def test_none_energy(self):
        result = gibbs_energy(energy=None)
        assert result["gibbs"] is None

    def test_with_frequencies(self):
        freqs = '[100.0, 200.0, 300.0, 400.0]'
        result = gibbs_energy(energy=-42.5, frequencies=freqs)
        assert result["gibbs"] != -42.5  # ZPE correction applied
        assert result["zpe"] > 0
```

- [ ] **Step 5: Run tests, commit**

```bash
cd server && PYTHONPATH=. python -m pytest tests/test_builtins_execution.py -v
git add server/catgo/workflow/builtins.py server/tests/test_builtins_execution.py
git commit -m "feat(P5): implement local task functions (structure_input, gibbs_energy, slab_gen)"
```

---

### Task A2: Register All Missing Engines

**Files:**
- Modify: `server/catgo/workflow/engine/engine_registry.py`

- [ ] **Step 1: Add all missing engine + collector registrations**

After the existing lammps registration, add:

```python
# ─── Additional engines (all use the same collector pattern) ───

@register_engine("gaussian")
async def _gen_gaussian(hpc, work_dir, node_type, params, structure_str, config, task):
    from workflow.engines.gaussian import generate_gaussian_inputs
    await generate_gaussian_inputs(hpc, work_dir, node_type, params, structure_str)

@register_collector("gaussian")
async def _collect_gaussian(hpc, work_dir, task_id, node_type, params, session_id, job_id):
    from workflow.hpc_execute import collect_completed_results
    return await collect_completed_results(hpc, work_dir, task_id, node_type, params, session_id, job_id)

@register_engine("xtb")
async def _gen_xtb(hpc, work_dir, node_type, params, structure_str, config, task):
    from workflow.engines.xtb import generate_xtb_inputs
    await generate_xtb_inputs(hpc, work_dir, node_type, params, structure_str)

@register_collector("xtb")
async def _collect_xtb(hpc, work_dir, task_id, node_type, params, session_id, job_id):
    from workflow.hpc_execute import collect_completed_results
    return await collect_completed_results(hpc, work_dir, task_id, node_type, params, session_id, job_id)

@register_engine("sella")
async def _gen_sella(hpc, work_dir, node_type, params, structure_str, config, task):
    from workflow.engines.sella import generate_sella_inputs
    await generate_sella_inputs(hpc, work_dir, node_type, params, structure_str)

@register_collector("sella")
async def _collect_sella(hpc, work_dir, task_id, node_type, params, session_id, job_id):
    from workflow.hpc_execute import collect_completed_results
    return await collect_completed_results(hpc, work_dir, task_id, node_type, params, session_id, job_id)

@register_engine("qe")
async def _gen_qe(hpc, work_dir, node_type, params, structure_str, config, task):
    from workflow.engines.qe import generate_qe_inputs
    await generate_qe_inputs(hpc, work_dir, node_type, params, structure_str)

@register_collector("qe")
async def _collect_qe(hpc, work_dir, task_id, node_type, params, session_id, job_id):
    from workflow.hpc_execute import collect_completed_results
    return await collect_completed_results(hpc, work_dir, task_id, node_type, params, session_id, job_id)

@register_engine("qchem")
async def _gen_qchem(hpc, work_dir, node_type, params, structure_str, config, task):
    from workflow.engines.qchem import generate_qchem_inputs
    await generate_qchem_inputs(hpc, work_dir, node_type, params, structure_str)

@register_collector("qchem")
async def _collect_qchem(hpc, work_dir, task_id, node_type, params, session_id, job_id):
    from workflow.hpc_execute import collect_completed_results
    return await collect_completed_results(hpc, work_dir, task_id, node_type, params, session_id, job_id)

@register_engine("amber")
async def _gen_amber(hpc, work_dir, node_type, params, structure_str, config, task):
    from workflow.engines.amber import generate_amber_inputs
    await generate_amber_inputs(hpc, work_dir, node_type, params, structure_str)

@register_collector("amber")
async def _collect_amber(hpc, work_dir, task_id, node_type, params, session_id, job_id):
    from workflow.hpc_execute import collect_completed_results
    return await collect_completed_results(hpc, work_dir, task_id, node_type, params, session_id, job_id)

@register_engine("gromacs")
async def _gen_gromacs(hpc, work_dir, node_type, params, structure_str, config, task):
    from workflow.engines.gromacs import generate_gromacs_inputs
    await generate_gromacs_inputs(hpc, work_dir, node_type, params, structure_str)

@register_collector("gromacs")
async def _collect_gromacs(hpc, work_dir, task_id, node_type, params, session_id, job_id):
    from workflow.hpc_execute import collect_completed_results
    return await collect_completed_results(hpc, work_dir, task_id, node_type, params, session_id, job_id)
```

NOTE: The engine file is getting long (>150 lines). Split into:

- `engine_registry.py` — registry infrastructure only (decorators, lookup functions)
- `engine_builtins.py` — all `@register_engine` / `@register_collector` registrations

- [ ] **Step 2: Split engine_registry.py**

```python
# server/catgo/workflow/engine/engine_registry.py (KEEP: infrastructure only)
"""Pluggable engine + collector registries."""
# ... only the decorator/lookup code, ~50 lines ...

# server/catgo/workflow/engine/engine_builtins.py (NEW: all registrations)
"""Built-in engine and collector registrations for all supported software."""
from catgo.workflow.engine.engine_registry import register_engine, register_collector
# ... all @register_engine / @register_collector blocks ...
```

- [ ] **Step 3: Commit**

```bash
git add server/catgo/workflow/engine/engine_registry.py server/catgo/workflow/engine/engine_builtins.py
git commit -m "feat(P5): register all 13 engines + split registry from registrations"
```

---

### Task A3: Wire MCP Tool into MCP Server

**Files:**
- Modify: `server/mcp_tools/server_claude_code.py`

- [ ] **Step 1: Register catgo_workflow_v2 tool**

Find `handle_list_tools` or equivalent in `server_claude_code.py`. Add:

```python
# In the tool definitions list:
try:
    from catgo.workflow.mcp_tools import get_tool_definition
    tools.append(get_tool_definition())
except ImportError:
    pass  # catgo.workflow package not available
```

Find `handle_call_tool` or equivalent. Add:

```python
elif tool_name == "catgo_workflow_v2":
    try:
        from catgo.workflow.mcp_tools import handle_tool_call
        action = arguments.get("action", "")
        action_params = arguments.get("params", {})
        result = await handle_tool_call(action, action_params)
        return [TextContent(type="text", text=json.dumps(result, indent=2, default=str))]
    except Exception as e:
        return [TextContent(type="text", text=f"Error: {e}")]
```

- [ ] **Step 2: Commit**

```bash
git add server/mcp_tools/server_claude_code.py
git commit -m "feat(P5): register catgo_workflow_v2 MCP tool in Claude Code server"
```

---

## Phase B: Robustness (production quality)

### Task B1: Fix Resolver for All Output Keys

**Files:**
- Modify: `server/catgo/workflow/engine/resolver.py`

- [ ] **Step 1: Make resolver fully generic**

Replace the hardcoded `_KEY_TO_COLUMN` dict with a dynamic approach:

```python
def resolve_task_inputs(db: WorkflowDB, task_id: str) -> dict[str, Any]:
    links = db.get_task_parents(task_id)
    if not links:
        return {}

    inputs: dict[str, Any] = {}
    for link in links:
        source_id = link["source_task_id"]
        source_key = link["source_key"]
        target_key = link["target_key"]

        result = db.get_result(source_id)
        if result is None:
            inputs[target_key] = None
            continue

        # Strategy: try multiple column name patterns
        value = None
        # 1. Direct column match
        if source_key in result and result[source_key] is not None:
            value = result[source_key]
        # 2. With _json suffix (structure → structure_json)
        elif f"{source_key}_json" in result and result[f"{source_key}_json"] is not None:
            value = result[f"{source_key}_json"]
        # 3. Known aliases
        elif source_key == "frequencies" and result.get("real_freqs_json"):
            value = result["real_freqs_json"]
        # 4. Fallback: check outputs_json
        elif result.get("outputs_json"):
            import json
            try:
                outputs = json.loads(result["outputs_json"])
                value = outputs.get(source_key)
            except (json.JSONDecodeError, TypeError):
                pass

        inputs[target_key] = value

    return inputs
```

- [ ] **Step 2: Update tests, commit**

---

### Task B2: Deduplicate Router and MCP Logic

Extract shared operations into a service layer.

**Files:**
- Create: `server/catgo/workflow/service.py` (<100 lines)

- [ ] **Step 1: Create service module**

```python
# server/catgo/workflow/service.py
"""Workflow service — shared operations used by both REST API and MCP tools.

Single source of truth for create/submit/pause/resume/reset/status operations.
Both routers/workflow_v2.py and mcp_tools.py call these functions.
"""

from __future__ import annotations
import json
from typing import Any
from catgo.workflow.db import WorkflowDB
from catgo.workflow.workflow import Workflow, TaskHandle
from catgo.workflow.reference import OutputReference
from catgo.workflow.states import TaskState
from catgo.workflow.engine.lifecycle import (
    submit_workflow, pause_workflow, resume_workflow, reset_workflow,
)


def create_workflow(db: WorkflowDB, name: str, config: dict | None = None) -> dict:
    wf = Workflow(name, db=db, config=config)
    return {"workflow_id": wf.workflow_id, "name": wf.name}


def add_task(
    db: WorkflowDB, workflow_id: str,
    task_type: str, name: str | None = None,
    system_name: str | None = None, **kwargs: Any,
) -> dict:
    # Deserialize OutputReferences from MCP JSON format
    resolved = {}
    for k, v in kwargs.items():
        if isinstance(v, dict) and "_ref" in v:
            resolved[k] = OutputReference(v["_ref"], v.get("_key"))
        else:
            resolved[k] = v

    wf = Workflow.__new__(Workflow)
    wf.db = db
    wf.workflow_id = workflow_id
    wf.name = ""
    wf.config = {}

    handle = wf.add_task(task_type, name=name, system_name=system_name, **resolved)
    return {"task_id": handle.task_id, "task_type": handle.task_type}


def get_status(db: WorkflowDB, workflow_id: str) -> dict:
    wf = db.get_workflow(workflow_id)
    tasks = db.get_all_tasks(workflow_id)
    return {
        "workflow": {"id": wf["id"], "name": wf["name"], "status": wf["status"]},
        "tasks": [{"id": t["id"], "type": t["task_type"], "name": t.get("name"),
                   "status": t["status"], "system_name": t.get("system_name")}
                  for t in tasks],
    }


def list_workflows(db: WorkflowDB) -> list[dict]:
    return [{"id": w["id"], "name": w["name"], "status": w["status"]}
            for w in db.list_workflows()]


def modify_task_params(db: WorkflowDB, task_id: str, updates: dict) -> dict:
    task = db.get_task(task_id)
    editable = {TaskState.WAITING.value, TaskState.READY.value, TaskState.PAUSED.value}
    if task["status"] not in editable:
        raise ValueError(f"Cannot edit: task is {task['status']}")
    existing = json.loads(task.get("params_json", "{}") or "{}")
    existing.update(updates)
    db.update_task(task_id, params_json=json.dumps(existing))
    return {"task_id": task_id, "params": existing}


def retry_task(db: WorkflowDB, task_id: str) -> list[str]:
    from collections import deque
    task = db.get_task(task_id)
    to_reset = set()
    queue = deque([task_id])
    while queue:
        tid = queue.popleft()
        if tid in to_reset:
            continue
        to_reset.add(tid)
        for link in db.get_task_children(tid):
            queue.append(link["target_task_id"])
    for tid in to_reset:
        db.update_task(tid, status=TaskState.WAITING.value,
                      error_message=None, error_type=None, retry_count=0)
    return list(to_reset)
```

- [ ] **Step 2: Update mcp_tools.py to use service**
- [ ] **Step 3: Update workflow_v2.py + workflow_v2_tasks.py to use service**
- [ ] **Step 4: Commit**

```bash
git add server/catgo/workflow/service.py server/catgo/workflow/mcp_tools.py server/routers/workflow_v2.py server/routers/workflow_v2_tasks.py
git commit -m "refactor(P5): extract service layer, deduplicate router + MCP logic"
```

---

### Task B3: Verify Backend Integration

**Files:**
- Modify: `server/main.py` (verify/fix)

- [ ] **Step 1: Verify v2 routers and engine startup in main.py lifespan**

Read main.py and ensure:
1. catgo.workflow.db.WorkflowDB is instantiated with correct path
2. v2 routers are included with `app.include_router()`
3. `start_engine(db, config)` is called in lifespan startup
4. `stop_engine()` is called in lifespan shutdown
5. All imports are wrapped in try/except so existing features aren't broken

- [ ] **Step 2: Commit if changes needed**

---

## Phase C: End-to-End Testing

### Task C1: Integration Test — Local Workflow

**Files:**
- Create: `server/tests/test_integration_local.py`

- [ ] **Step 1: Write full end-to-end test**

```python
# server/tests/test_integration_local.py
"""End-to-end test: create workflow via Python API, run engine, verify results."""
import asyncio
import pytest
from catgo.workflow import Workflow, WorkflowDB, load_config
from catgo.workflow.builtins import structure_input, gibbs_energy
from catgo.workflow.states import TaskState
from catgo.workflow.engine import WorkflowEngine
import catgo.workflow.builtins  # ensure registered


class TestLocalWorkflowEndToEnd:
    @pytest.fixture
    def db(self, tmp_path):
        return WorkflowDB(str(tmp_path / "test.db"))

    @pytest.fixture
    def config(self):
        return load_config(config_path=None)

    def test_structure_input_completes_in_one_cycle(self, db, config):
        """structure_input → COMPLETED after one scan cycle."""
        wf = Workflow("test", db=db)
        s = wf.add_task(structure_input, structure='{"sites": []}')
        wf.submit()

        engine = WorkflowEngine(db=db, config=config)
        asyncio.run(engine.scan_cycle())

        task = db.get_task(s.task_id)
        assert task["status"] == TaskState.COMPLETED.value

        result = db.get_result(s.task_id)
        assert result is not None

    def test_chained_local_tasks(self, db, config):
        """structure_input → gibbs_energy: both complete in two cycles."""
        wf = Workflow("test", db=db)
        s = wf.add_task(structure_input, structure='{"sites": []}')
        # gibbs_energy with no real input — should handle gracefully
        g = wf.add_task(gibbs_energy, energy=None, frequencies=None)
        wf.submit()

        engine = WorkflowEngine(db=db, config=config)
        # Cycle 1: structure_input completes
        asyncio.run(engine.scan_cycle())
        # Cycle 2: gibbs_energy becomes READY and completes
        asyncio.run(engine.scan_cycle())

        t_struct = db.get_task(s.task_id)
        t_gibbs = db.get_task(g.task_id)
        assert t_struct["status"] == TaskState.COMPLETED.value
        assert t_gibbs["status"] == TaskState.COMPLETED.value

    def test_workflow_status_updates(self, db, config):
        """Workflow status follows task states."""
        wf = Workflow("test", db=db)
        wf.add_task(structure_input, structure='{"sites": []}')
        wf.submit()

        assert db.get_workflow(wf.workflow_id)["status"] == "running"

        engine = WorkflowEngine(db=db, config=config)
        asyncio.run(engine.scan_cycle())

        assert db.get_workflow(wf.workflow_id)["status"] == "completed"

    def test_dag_with_references(self, db, config):
        """OutputReference creates correct links in DB."""
        wf = Workflow("test", db=db)
        s = wf.add_task(structure_input, structure='{"sites": []}')

        from catgo.workflow.task_decorator import task as task_decorator

        @task_decorator(task_type="_test_passthrough", local=True, outputs=["data"])
        def _passthrough(structure=None, **params):
            return {"data": structure}

        p = wf.add_task(_passthrough, structure=s.output.structure)
        wf.submit()

        dag = wf.get_dag()
        assert len(dag["links"]) == 1
        assert dag["links"][0]["source_key"] == "structure"
        assert dag["links"][0]["target_key"] == "structure"
```

- [ ] **Step 2: Run tests**

```bash
cd server && PYTHONPATH=. python -m pytest tests/test_integration_local.py -v
```

- [ ] **Step 3: Commit**

```bash
git add server/tests/test_integration_local.py
git commit -m "test(P5): end-to-end integration tests for local workflow execution"
```

---

### Task C2: Verify MCP Tool End-to-End

**Files:**
- Create: `server/tests/test_mcp_workflow.py`

- [ ] **Step 1: Test MCP tool actions**

```python
# server/tests/test_mcp_workflow.py
import asyncio
import pytest
from catgo.workflow.mcp_tools import handle_tool_call
from catgo.workflow.db import WorkflowDB
import catgo.workflow.builtins  # ensure registered


class TestMCPWorkflow:
    @pytest.fixture(autouse=True)
    def setup_db(self, tmp_path, monkeypatch):
        """Point config to temp DB."""
        db_path = str(tmp_path / "test.db")
        monkeypatch.setenv("CATGO_PATHS_DB_PATH", db_path)

    def test_create_and_add_task(self):
        result = asyncio.run(handle_tool_call("create", {"name": "test"}))
        assert "workflow_id" in result

        wf_id = result["workflow_id"]
        result2 = asyncio.run(handle_tool_call("add_task", {
            "workflow_id": wf_id,
            "task_type": "structure_input",
            "structure": '{"sites": []}',
        }))
        assert "task_id" in result2

    def test_submit_and_status(self):
        r1 = asyncio.run(handle_tool_call("create", {"name": "test"}))
        wf_id = r1["workflow_id"]
        asyncio.run(handle_tool_call("add_task", {
            "workflow_id": wf_id,
            "task_type": "structure_input",
            "structure": "{}",
        }))
        asyncio.run(handle_tool_call("submit", {"workflow_id": wf_id}))

        status = asyncio.run(handle_tool_call("status", {"workflow_id": wf_id}))
        assert status["workflow"]["status"] == "running"

    def test_list_workflows(self):
        asyncio.run(handle_tool_call("create", {"name": "wf1"}))
        asyncio.run(handle_tool_call("create", {"name": "wf2"}))
        result = asyncio.run(handle_tool_call("list", {}))
        assert len(result["workflows"]) >= 2
```

- [ ] **Step 2: Run tests, commit**

```bash
cd server && PYTHONPATH=. python -m pytest tests/test_mcp_workflow.py -v
git add server/tests/test_mcp_workflow.py
git commit -m "test(P5): MCP tool end-to-end tests"
```

---

## Phase D: Documentation + Final Polish

### Task D1: Update SKILL.md with Real Examples

Update `server/catgo/workflow/SKILL.md` with tested, working examples.

### Task D2: Add conftest.py for Test Infrastructure

```python
# server/tests/conftest.py
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))
```

### Task D3: Save Architecture Knowledge to Memory

Update the memory file `reference_workflow_engines.md` with the final implemented architecture.

---

## Summary

| Phase | Tasks | Effort | Priority |
|-------|-------|--------|----------|
| A: Core Fixes | A1 (builtins), A2 (engines), A3 (MCP wire) | ~4h | CRITICAL |
| B: Robustness | B1 (resolver), B2 (service layer), B3 (main.py) | ~3h | IMPORTANT |
| C: E2E Tests | C1 (local), C2 (MCP) | ~2h | IMPORTANT |
| D: Polish | D1 (docs), D2 (conftest), D3 (memory) | ~1h | NICE |
| **Total** | **10 tasks** | **~10h** | |

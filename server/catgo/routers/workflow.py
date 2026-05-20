"""Workflow management and execution API endpoints.

Thin FastAPI router — business logic lives in:
  - services.workflow_service  (serialization, coercion, metadata, path validation)
  - services.workflow_results  (convergence expansion, frequency fetch, Part B results)
"""

import asyncio
import json
import logging
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)
from fastapi import APIRouter, Body, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

# HPC-capable node types (computationally expensive)
HPC_NODES = {
    # Unified calc types
    "geo_opt", "single_point", "freq", "cell_opt", "md",
    "ts_search", "irc", "uvvis",
    # ORCA-specific
    "orca_opt", "orca_sp", "orca_freq", "orca_neb_ts", "orca_irc", "orca_uvvis",
    # Analysis
    "dos_analysis", "charge_analysis", "slab_gen", "adsorbate_place",
    "gibbs_energy",
}

from catgo.models.workflow import (
    WorkflowCreate,
    WorkflowUpdate,
    WorkflowDetail,
    WorkflowSummary,
    WorkflowTemplate,
    StepUpdate,
    SaveStructureRequest,
)
from catgo.models.workflow_run import (
    CALC_TYPE_CATEGORIES,
    JOB_SCRIPT_PRESETS,
    NODE_CATEGORIES,
    RECOMMENDED_POTCAR,
    StepInfo,
    WorkflowRunConfig,
    WorkflowRunStatus,
)
from catgo.utils.workflow_db import (
    create_workflow,
    list_workflows,
    get_workflow,
    update_workflow,
    delete_workflow,
    update_step,
    get_step_status,
    list_templates,
    create_from_template,
    list_steps,
    list_edges,
    list_projects,
    create_project,
    get_project,
    update_project,
    delete_project,
    assign_workflow_to_project,
)
from catgo.services.workflow_service import (
    extract_site_metadata,
    restore_site_metadata,
    coerce_node_params,
    dict_to_ase,
    ase_serialize,
    validate_local_path,
)
from catgo.services.workflow_results import (
    expand_convergence_points,
    fetch_convergence_points,
    fetch_frequencies,
    build_part_b_results,
    fetch_v2_task_results_for_project,
    fetch_v2_task_results_by_workflow,
    build_part_c_results,
)

router = APIRouter(prefix="/workflow", tags=["workflow"])


# ====== Backward-compat aliases (private names used elsewhere in codebase) ======
_extract_site_metadata = extract_site_metadata
_restore_site_metadata = restore_site_metadata
_coerce_node_params = coerce_node_params
_dict_to_ase = dict_to_ase
_ase_serialize = ase_serialize
_validate_local_path = validate_local_path
_expand_convergence_points = expand_convergence_points
_fetch_convergence_points = fetch_convergence_points
_fetch_frequencies = fetch_frequencies
_build_part_b_results = build_part_b_results


# V2 engine bridge: read steps from V2 tasks table
def _engine_list_steps(wf_id: str) -> list[dict]:
    """Read steps from V2 engine. Falls back to V1 if V2 not available."""
    from catgo.routers.workflow_engine import _db as engine_db
    if engine_db is None:
        return list_steps(wf_id)
    from catgo.workflow.v1_compat import list_steps_v1
    try:
        steps = list_steps_v1(engine_db, wf_id)
        return steps if steps else list_steps(wf_id)
    except Exception:
        return list_steps(wf_id)


def _engine_get_step_status(wf_id: str, step_id: str) -> dict:
    """Read one step from V2 engine. Falls back to V1 if V2 not available."""
    from catgo.routers.workflow_engine import _db as engine_db
    if engine_db is None:
        return get_step_status(wf_id, step_id)
    from catgo.workflow.v1_compat import get_step_status_v1
    try:
        return get_step_status_v1(engine_db, wf_id, step_id)
    except KeyError:
        return get_step_status(wf_id, step_id)


# ====== Engine status ======

@router.get("/engine-status")
def api_engine_status():
    """Pre-flight check: report workflow engine availability.

    Lets the frontend know whether the Rust engine (catgo_run) is available
    and which node types can execute locally vs require HPC/Python.
    """
    import shutil
    binary = shutil.which("catgo_run")
    return {
        "catgo_run_available": binary is not None,
        "catgo_run_path": binary,
        "python_backend": True,
        "supported_local_nodes": [
            "structure_input", "supercell_gen", "defect_gen",
            "doping_gen", "strain_deform", "energy_compare",
            "convergence", "condition", "loop", "merge",
        ],
        "hpc_nodes_require_python": [
            "vasp_relax", "vasp_static", "vasp_md", "vasp_bands", "vasp_dos",
            "orca_opt", "orca_sp", "orca_freq", "orca_ts", "orca_irc",
            "cp2k_geopt", "cp2k_energy", "cp2k_md",
            "lammps_md", "lammps_minimize",
        ],
        "hpc_dispatch_status": "tool_bridge_local_only",
    }


# ====== Pending workflow update (MCP -> frontend real-time sync) ======

from collections import deque
_pending_workflow_updates: deque[dict] = deque(maxlen=32)


@router.post("/pending-update")
def push_pending_workflow_update(data: dict):
    """MCP tools push workflow mutation notifications here for real-time frontend sync."""
    wf_id = data.get("workflow_id", "")
    if not wf_id:
        raise HTTPException(status_code=400, detail="workflow_id is required")
    _pending_workflow_updates.append({
        "workflow_id": wf_id,
        "action": data.get("action", "update"),
    })
    return {"status": "ok"}


@router.get("/pending-update")
def get_pending_workflow_update():
    """Frontend polls for pending workflow graph updates from MCP tools.
    Returns the latest workflow_id that was modified, or empty if none."""
    if not _pending_workflow_updates:
        return {"pending": False}
    latest = _pending_workflow_updates[-1]
    _pending_workflow_updates.clear()
    return {"pending": True, "workflow_id": latest["workflow_id"], "action": latest["action"]}


# ====== Workflow CRUD ======

@router.post("/", response_model=WorkflowDetail, status_code=201)
def api_create_workflow(data: WorkflowCreate):
    """Create a new workflow."""
    try:
        return create_workflow(data)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/", response_model=list[WorkflowSummary])
def api_list_workflows():
    """List all workflows."""
    return list_workflows()


@router.get("/templates", response_model=list[WorkflowTemplate])
def api_list_templates():
    """List available workflow templates."""
    return list_templates()


class QuickBuildRequest(BaseModel):
    recipe: str
    material_id: Optional[str] = None
    name: Optional[str] = None


@router.get("/quickbuild/recipes")
def api_quickbuild_recipes():
    """Return the catalogue of zero-LLM workflow recipes.

    UI surfaces these as one-click buttons that build a complete pipeline
    without round-tripping through the LLM.
    """
    from catgo.mcp_tools.server_claude_code import _quickbuild_recipes
    recipes = _quickbuild_recipes()
    return [
        {
            "id": key,
            "label": data["label"],
            "node_count": len(data["nodes"]) + 1,  # +1 for auto-added structure_input
            "edge_count": len(data["edges"]),
        }
        for key, data in recipes.items()
    ]


@router.post("/quickbuild")
async def api_quickbuild(req: QuickBuildRequest):
    """Build a complete workflow from a recipe name in one HTTP request.

    Identical recipe registry as the catgo_quickbuild MCP tool — same nodes,
    edges, defaults. Bypasses the LLM entirely when the user clicks a
    Quick-Recipe button in the UI.
    """
    import httpx
    from catgo.mcp_tools.server_claude_code import _handle_quickbuild

    async with httpx.AsyncClient(timeout=30.0) as client:
        result = await _handle_quickbuild(client, req.model_dump(exclude_none=True))
        text = result[0].text if result else ""
        # The handler returns a one-sentence confirmation; surface it
        # plus the workflow id (extracted from the confirmation string)
        import re
        m = re.search(r"id=([a-f0-9-]{8,})", text)
        return {"ok": "Built" in text, "workflow_id": m.group(1) if m else None, "message": text}


@router.get("/job-script-presets")
def api_list_job_script_presets():
    """List available job script template presets."""
    return [
        {"id": key, "name": val["name"], "template": val["template"]}
        for key, val in JOB_SCRIPT_PRESETS.items()
    ]


@router.get("/calc-type-categories")
def api_calc_type_categories():
    """List calculation type categories for template configuration."""
    return CALC_TYPE_CATEGORIES


@router.get("/node-categories")
def api_node_categories():
    """List ALL node categories — calc/build/analysis/logic/kmc.

    Sibling to /calc-type-categories: this one is the broad catalog
    consumed by MCP `node_types` action so LLM-driven workflow authoring
    sees every node type `add_node` can instantiate, not just the
    calculation subset shown in the human "Calc Type" dropdown.
    """
    return NODE_CATEGORIES


@router.get("/recommended-potcar")
def api_recommended_potcar():
    """Get recommended POTCAR variants per element (Materials Project standard)."""
    return RECOMMENDED_POTCAR


@router.get("/results")
def api_search_results(search: str = "", formula: str = "", node_type: str = "", limit: int = 100):
    """Search ASE database results across all workflows."""
    try:
        from catgo.utils.ase_db import query_results
        # Use formula filter if provided, otherwise try search as formula
        formula_filter = formula or (search.strip() if search.strip() else None)
        results = query_results(formula=formula_filter, node_type=node_type or None, limit=limit)
        return {"results": results, "count": len(results)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/from-template/{template_id}", response_model=WorkflowDetail, status_code=201)
def api_create_from_template(template_id: str, name: str = "New Workflow"):
    """Create a workflow from a template."""
    try:
        return create_from_template(template_id, name)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ─── Engine Definition Endpoints ───
# NOTE: These MUST be registered before /{workflow_id} to avoid path conflicts.

@router.get("/engine-defs")
def list_engine_defs():
    """Return metadata for all declarative engines (built-in + custom)."""
    from workflow.engine_runtime import all_runtimes
    return [rt.to_dict() for rt in all_runtimes()]


@router.get("/engine-defs/{engine_key}")
def get_engine_def(engine_key: str):
    """Return metadata for a specific declarative engine."""
    from workflow.engine_runtime import get_runtime
    rt = get_runtime(engine_key)
    if not rt:
        raise HTTPException(status_code=404, detail=f"Engine '{engine_key}' not found")
    return rt.to_dict()


@router.post("/engine-defs/custom")
def create_custom_engine(spec_dict: dict = Body(...)):
    """Create a user-defined engine from a spec dict."""
    from workflow.engine_defs.schema import validate_engine_spec, _assess_safety
    from workflow.engine_runtime import load_engine_def, ENGINE_DEFS_DIR
    import yaml

    try:
        spec = validate_engine_spec(spec_dict)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

    if "safety" not in spec_dict:
        spec_dict["safety"] = _assess_safety(spec_dict.get("run_commands", []))

    custom_dir = ENGINE_DEFS_DIR / "custom"
    custom_dir.mkdir(parents=True, exist_ok=True)
    yaml_path = custom_dir / f"{spec.engine}.yaml"
    with open(yaml_path, "w") as f:
        yaml.safe_dump(spec_dict, f, default_flow_style=False, sort_keys=False)

    rt = load_engine_def(spec_dict)

    return {"status": "created", "engine": spec.engine, "safety": spec.safety}


@router.get("/{workflow_id}", response_model=WorkflowDetail)
def api_get_workflow(workflow_id: str):
    """Get workflow details including graph."""
    try:
        return get_workflow(workflow_id)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.put("/{workflow_id}", response_model=WorkflowDetail)
def api_update_workflow(workflow_id: str, data: WorkflowUpdate):
    """Update a workflow (save graph, rename, change status)."""
    try:
        update_data = data.model_dump(exclude_none=True)
        if data.status is not None:
            update_data["status"] = data.status.value
        # Coerce param types in graph_json (AI often sends numbers as strings)
        if "graph_json" in update_data and update_data["graph_json"]:
            update_data["graph_json"] = coerce_node_params(update_data["graph_json"])
        return update_workflow(workflow_id, update_data)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/{workflow_id}", status_code=204)
def api_delete_workflow(workflow_id: str):
    """Delete a workflow."""
    try:
        delete_workflow(workflow_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/{workflow_id}/steps/{step_id}")
def api_update_step(workflow_id: str, step_id: str, data: StepUpdate):
    """Update a workflow step's config or status."""
    try:
        update_data = data.model_dump(exclude_none=True)
        if data.status is not None:
            update_data["status"] = data.status.value
        return update_step(workflow_id, step_id, update_data)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.get("/{workflow_id}/steps/{step_id}/status")
def api_get_step_status(workflow_id: str, step_id: str):
    """Get the status of a workflow step."""
    try:
        return _engine_get_step_status(workflow_id, step_id)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.post("/{workflow_id}/steps/{step_id}/retry")
def api_retry_step(workflow_id: str, step_id: str):
    """Reset a task and its downstream dependents to WAITING."""
    from catgo.routers.workflow_engine import _db as engine_db
    if engine_db is None:
        from catgo.utils.workflow_db import reset_step_and_descendants
        reset_ids = reset_step_and_descendants(workflow_id, step_id)
    else:
        from catgo.workflow.service import retry_task
        reset_ids = retry_task(engine_db, step_id)

    if not reset_ids:
        raise HTTPException(status_code=404, detail=f"Step {step_id} not found")
    return {"reset_nodes": reset_ids, "message": f"Reset {len(reset_ids)} nodes to pending"}


@router.post("/{workflow_id}/reset")
async def api_reset_workflow(workflow_id: str):
    """Reset all tasks to WAITING via V2 engine + cancel HPC jobs."""
    from catgo.routers.workflow_engine import _db as engine_db

    # Cancel HPC jobs (best-effort)
    cancelled = []
    try:
        if engine_db is not None:
            from catgo.workflow.engine.lifecycle import cancel_workflow_jobs
            cancelled = await cancel_workflow_jobs(engine_db, workflow_id)
        else:
            pass  # V1 engine removed; no-op fallback
    except Exception as e:
        logger.warning("Cancel jobs on reset failed: %s", e)

    if engine_db is None:
        # Fall back to V1 reset
        from catgo.utils.workflow_db import reset_all_steps
        count = reset_all_steps(workflow_id)
    else:
        from catgo.workflow.engine.lifecycle import reset_workflow as engine_reset
        engine_reset(engine_db, workflow_id)
        tasks = engine_db.get_all_tasks(workflow_id)
        count = len(tasks)

    return {
        "status": "reset",
        "workflow_id": workflow_id,
        "steps_reset": count,
        "jobs_cancelled": len([r for r in cancelled if r.get("success")]),
    }


@router.post("/{workflow_id}/recheck-jobs")
def api_recheck_jobs(workflow_id: str):
    """Check actual HPC status for running/queued steps.

    Called when user opens a workflow that may have stale step statuses
    (e.g., after CatGo restart). Queries scheduler and collects results
    for any jobs that completed while CatGo was offline.
    """
    try:
        wf = get_workflow(workflow_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Workflow {workflow_id} not found")

    # V2 engine handles recovery automatically via scan_cycle
    return {"workflow_id": workflow_id, "rechecked": 0, "message": "V2 engine handles recovery automatically"}


@router.post("/{workflow_id}/volcano-plot")
def api_volcano_plot(workflow_id: str, body: dict):
    """Generate volcano plot data for catalyst screening results."""
    from workflow.catalysis.volcano import generate_volcano_data
    return generate_volcano_data(
        catalyst_results=body.get("results", []),
        reaction=body.get("reaction", "OER"),
        descriptor_x=body.get("descriptor_x", "dG_OH"),
    )


@router.post("/catalysis/oer")
def api_oer_overpotential(body: dict):
    """Compute OER overpotential from adsorption free energies."""
    from workflow.catalysis.oer import compute_oer_overpotential
    return compute_oer_overpotential(
        dG_OH=body["dG_OH"], dG_O=body["dG_O"], dG_OOH=body["dG_OOH"],
        equilibrium_potential=body.get("equilibrium_potential", 1.23),
    )


@router.post("/catalysis/co2rr")
def api_co2rr(body: dict):
    """Compute CO2RR limiting potential."""
    from workflow.catalysis.co2rr import compute_co2rr_limiting_potential
    return compute_co2rr_limiting_potential(
        dG_COOH=body["dG_COOH"], dG_CO=body["dG_CO"],
        pathway=body.get("pathway", "CO"),
    )


@router.post("/catalysis/nrr")
def api_nrr(body: dict):
    """Compute NRR overpotential."""
    from workflow.catalysis.nrr import compute_nrr_overpotential
    return compute_nrr_overpotential(dG_N2H=body["dG_N2H"], **{
        k: v for k, v in body.items() if k != "dG_N2H"
    })


@router.post("/catalysis/free-energy")
def api_free_energy(body: dict):
    """Compute Gibbs free energy correction."""
    from workflow.catalysis.free_energy import gibbs_free_energy
    return gibbs_free_energy(
        e_dft=body["e_dft"],
        frequencies_cm=body.get("frequencies_cm"),
        temperature=body.get("temperature", 298.15),
    )


@router.post("/catalysis/energy-diagram")
def api_energy_diagram(body: dict):
    """Generate Plotly-compatible energy diagram JSON from pathway data."""
    from workflow.catalysis.energy_diagram import generate_energy_diagram
    pathways = body.get("pathways", [])
    config = body.get("config")
    if not pathways:
        from fastapi import HTTPException
        raise HTTPException(400, "At least one pathway is required")
    return generate_energy_diagram(pathways, config)


@router.post("/catalysis/descriptors")
def api_descriptors(body: dict):
    """Compute catalytic descriptors (d-band center, coordination, strain)."""
    from workflow.catalysis.descriptors import compute_d_band_center
    return compute_d_band_center(
        energies=body["energies"], dos_d=body["dos_d"],
        e_fermi=body.get("e_fermi", 0.0),
    )


@router.get("/vasp-presets")
def api_vasp_presets():
    """List available VASP calculation presets (legacy flat list)."""
    from workflow.presets.vasp import PRESETS
    return {name: preset for name, preset in PRESETS.items()}


@router.get("/vasp-presets/{calc_type}/{sub_name}")
def api_vasp_sub_preset(calc_type: str, sub_name: str):
    """Get a specific sub-preset's INCAR parameters for a calc type."""
    from workflow.presets.vasp import get_sub_preset
    preset = get_sub_preset(calc_type, sub_name)
    if not preset:
        from fastapi import HTTPException
        raise HTTPException(404, f"Preset '{calc_type}/{sub_name}' not found")
    return preset


@router.get("/vasp-presets/{preset_name}")
def api_vasp_preset(preset_name: str):
    """Get preset — tries sub-preset list first, then legacy flat lookup."""
    from workflow.presets.vasp import get_sub_presets, get_preset
    # If preset_name matches a calc_type, return its sub-preset options
    subs = get_sub_presets(preset_name)
    if subs:
        return {name: {"label": v["label"]} for name, v in subs.items()}
    # Legacy flat preset lookup
    preset = get_preset(preset_name)
    if not preset:
        from fastapi import HTTPException
        raise HTTPException(404, f"Preset '{preset_name}' not found")
    return preset


# ====== Batch endpoints ======


@router.get("/{workflow_id}/steps/{step_id}/batch-summary")
def api_batch_summary(workflow_id: str, step_id: str):
    """Return batch job aggregate statistics.

    Includes total, pending, running, completed, failed counts and
    energy distribution stats (min, max, mean, stdev).
    """
    from catgo.utils.batch_db import get_batch_summary
    try:
        return get_batch_summary(workflow_id, step_id)
    except Exception:
        return {"total": 0, "pending": 0, "running": 0, "completed": 0, "failed": 0}


@router.get("/{workflow_id}/steps/{step_id}/batch-results")
def api_batch_results(
    workflow_id: str, step_id: str,
    page: int = 1, per_page: int = 50,
    sort: str = "energy", order: str = "asc",
    status: str | None = None,
):
    """Paginated batch subtask results.

    Supports sorting by energy, subtask_index, status, or completed_at,
    and optional filtering by status.
    """
    from catgo.utils.batch_db import get_batch_results_page
    return get_batch_results_page(workflow_id, step_id, page, per_page, sort, order, status)


@router.get("/{workflow_id}/steps/{step_id}/batch-histogram")
def api_batch_histogram(workflow_id: str, step_id: str, bins: int = 30):
    """Energy distribution histogram (server-side computation).

    Returns bin centers and counts for plotting the energy distribution
    of completed batch subtasks.
    """
    from catgo.utils.batch_db import get_batch_energies
    energies = get_batch_energies(workflow_id, step_id)
    if not energies:
        return {"bins": [], "counts": []}
    import numpy as np
    counts, bin_edges = np.histogram(energies, bins=bins)
    return {
        "bins": [(bin_edges[i] + bin_edges[i + 1]) / 2 for i in range(len(counts))],
        "counts": counts.tolist(),
    }


@router.post("/{workflow_id}/steps/{step_id}/batch-retry")
def api_batch_retry(workflow_id: str, step_id: str, body: dict | None = None):
    """Retry failed batch subtasks.

    If body.indices is provided, only those subtasks are retried.
    Otherwise, all failed subtasks for the step are retried.
    """
    from catgo.utils.batch_db import get_failed_subtask_indices, reset_subtasks
    indices = (body or {}).get("indices") or get_failed_subtask_indices(workflow_id, step_id)
    if not indices:
        return {"retried": 0}
    reset_subtasks(workflow_id, step_id, indices)
    return {"retried": len(indices), "indices": indices}


# ====== Execution endpoints ======


@router.get("/{workflow_id}/classify")
def api_classify_workflow(workflow_id: str):
    """Classify a workflow's execution path before running.

    All workflows run through the stateless engine now.
    """
    try:
        wf = get_workflow(workflow_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Workflow {workflow_id} not found")

    return {
        "workflow_id": workflow_id,
        "path": "python_engine",
        "is_runnable": True,
        "reason": "All workflows execute via stateless engine",
        "rust_nodes": [],
        "hpc_nodes": [],
        "unsupported_nodes": [],
        "unknown_nodes": [],
        "warnings": [],
        "user_message": "Ready to run",
    }


@router.post("/{workflow_id}/test-echo")
async def api_test_echo(workflow_id: str):
    """Test endpoint to verify routing works."""
    print(f"[TEST] Echo endpoint called", flush=True)
    return {"test": "ok", "workflow_id": workflow_id}


@router.post("/{workflow_id}/run")
def api_run_workflow(workflow_id: str, config: WorkflowRunConfig):
    """Start executing a workflow via V2 stateless engine.

    1. Convert graph_json -> V2 tasks (preserving node IDs)
    2. Apply WorkflowRunConfig to V2 tasks (sessions, job params)
    3. Submit to V2 engine scanner
    """
    print(f"[DEBUG] api_run_workflow CALLED with workflow_id={workflow_id}", flush=True)
    try:
        logger.error(f"[api_run_workflow] STARTING for workflow {workflow_id}, config keys: {list(config.dict().keys())}")
        try:
            wf = get_workflow(workflow_id)
            logger.error(f"[api_run_workflow] Got workflow, status={wf.status}")
        except KeyError:
            logger.error(f"[api_run_workflow] Workflow not found: {workflow_id}")
            raise HTTPException(status_code=404, detail=f"Workflow {workflow_id} not found")

        if wf.status not in ("draft", "failed", "completed", "paused", "running"):
            logger.error(f"[api_run_workflow] Invalid status: {wf.status}")
            raise HTTPException(
                status_code=409,
                detail=f"Cannot start workflow in '{wf.status}' state."
            )
    except Exception as e:
        logger.error(f"[api_run_workflow] UNHANDLED ERROR: {type(e).__name__}: {e}", exc_info=True)
        raise

    # Pre-classify for user-facing message
    classification = None  # V2 engine handles all classification internally

    # Validate HPC session if needed
    if config.execution_mode == "hpc" and config.default_session_id:
        from catgo.utils.hpc_client import pool as hpc_pool
        hpc = hpc_pool.get_connection(config.default_session_id)
        if hpc is None:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"HPC session '{config.default_session_id}' is no longer connected. "
                    f"Please reconnect to the HPC cluster before running the workflow."
                ),
            )

    if config.execution_mode == "hpc" and not config.default_session_id:
        from catgo.utils.hpc_client import pool as hpc_pool, LOCAL_SESSION_ID
        has_remote = any(
            sid != LOCAL_SESSION_ID and conn.is_alive
            for sid, conn in hpc_pool.connections.items()
        )
        import json as _json
        try:
            _graph = _json.loads(wf.graph_json)
            hpc_types = [n.get("type", "") for n in _graph.get("nodes", []) if n.get("type", "") in HPC_NODES]
        except Exception:
            hpc_types = []
        if hpc_types and not has_remote:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"No HPC cluster connected. This workflow has nodes that require "
                    f"HPC execution: {', '.join(hpc_types)}. "
                    f"Connect to an HPC cluster first, or switch nodes to Local execution mode."
                ),
            )

    # --- V2 Engine Path ---
    try:
        from catgo.routers.workflow_engine import _db as engine_db
        if engine_db is None:
            raise HTTPException(status_code=500, detail="V2 workflow engine not initialized")

        from catgo.workflow.graph_converter import convert_graph_json
        graph = wf.graph_json

        # Check if graph has changed (different nodes) — if so, must recreate
        try:
            engine_wf = engine_db.get_workflow(workflow_id)

            graph_dict = json.loads(graph) if isinstance(graph, str) else graph
            new_node_ids = {n["id"] for n in graph_dict.get("nodes", [])}
            old_tasks = engine_db.get_all_tasks(workflow_id)
            old_task_ids = {t["id"] for t in old_tasks}

            if new_node_ids != old_task_ids:
                # Graph changed (e.g. different template loaded) — full recreate
                logger.info(
                    "Workflow %s: graph changed (%d old tasks, %d new nodes) — recreating",
                    workflow_id, len(old_task_ids), len(new_node_ids),
                )
                # Remove old tasks/links before recreating to avoid UNIQUE constraint errors
                engine_db.delete_workflow_tasks_and_links(workflow_id)
                engine_wf_id = convert_graph_json(engine_db, wf.name or workflow_id, graph,
                                               config=_run_config_to_engine_config(config),
                                               workflow_id=workflow_id)
            else:
                # Same node IDs — reset task states but preserve results.
                # Critical: also resync each task's task_type + params_json
                # from the current graph_json. Without this, changing a
                # node's calc type (e.g. md → geo_opt) or any param in
                # the editor never reaches the V2 engine — the task keeps
                # its stale task_type and the engine routes to the wrong
                # parser / engine, e.g. parser stays in MD mode even
                # though the user expects OPT force display.
                from catgo.workflow.engine.lifecycle import reset_workflow as engine_reset
                engine_reset(engine_db, workflow_id)
                engine_db.update_workflow(workflow_id,
                    config_json=json.dumps(_run_config_to_engine_config(config)))
                engine_wf_id = workflow_id
                # Resync per-task type + params from current graph_json so
                # editor edits propagate.
                old_by_id = {t["id"]: t for t in old_tasks}
                for n in graph_dict.get("nodes", []):
                    nid = n.get("id")
                    if nid not in old_by_id:
                        continue
                    old_t = old_by_id[nid]
                    new_type = n.get("type", "") or old_t.get("task_type")
                    new_params = n.get("params") or {}
                    updates: dict = {}
                    if new_type != old_t.get("task_type"):
                        updates["task_type"] = new_type
                    # Merge: preserve any per-task fields that aren't part
                    # of the graph (e.g. job_walltime/job_nodes set in the
                    # node Properties panel, structure_json from parents)
                    # by layering graph params over old params, not
                    # replacing. _apply_run_config_to_tasks below will
                    # then merge in step_job_params on top.
                    try:
                        old_params = json.loads(old_t.get("params_json", "{}") or "{}")
                    except Exception:
                        old_params = {}
                    merged = {**old_params, **new_params}
                    if merged != old_params:
                        updates["params_json"] = json.dumps(merged)
                    if updates:
                        engine_db.update_task(nid, **updates)
                        logger.info(
                            "Workflow %s: resynced task %s from graph (type=%s)",
                            workflow_id, nid[:12], new_type,
                        )
        except KeyError:
            # First run: create V2 workflow from graph_json
            engine_wf_id = convert_graph_json(engine_db, wf.name or workflow_id, graph,
                                           config=_run_config_to_engine_config(config),
                                           workflow_id=workflow_id)

        # Apply per-step HPC sessions and job params to V2 tasks
        _apply_run_config_to_tasks(engine_db, engine_wf_id, config)

        # CRITICAL: Save the run config so scanner can read user's values later
        # This ensures user's dialog values (partition, ntasks, walltime, etc.) are preserved
        # when the task is actually submitted hours/days later.
        try:
            from catgo.utils.workflow_db import update_workflow_run_config
            config_json_str = config.model_dump_json(exclude_none=True)
            update_workflow_run_config(workflow_id, config_json_str)
            logger.info(f"[api_run_workflow] Saved run config with default_job_params={config.default_job_params}")
        except Exception as e:
            logger.error(f"[api_run_workflow] Failed to save run config: {e}", exc_info=True)

        # Submit to V2 engine
        from catgo.workflow.engine.lifecycle import submit_workflow
        submit_workflow(engine_db, engine_wf_id)

        # Sync V1 workflow status so /run-status and WebSocket see "running"
        try:
            update_workflow(workflow_id, {"status": "running"})
        except Exception:
            logger.debug("Failed to sync V1 status to running", exc_info=True)

        return {
            "status": "started",
            "workflow_id": workflow_id,
            "v2_workflow_id": engine_wf_id,
            "engine_path": getattr(classification, "path", "v2_engine"),
            "routing_reason": getattr(classification, "reason", "V2 engine handles all classification"),
            "warnings": getattr(classification, "warnings", []),
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error("[api_run_workflow] Engine execution failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Workflow execution failed: {e}")


@router.post("/{workflow_id}/reconcile-from-hpc")
async def api_reconcile_from_hpc(workflow_id: str):
    """Probe SLURM for this workflow's tasks and sync DB state.

    Called by the frontend when the user opens a workflow that may have
    been running before the last CatGo shutdown. Forces one immediate
    scan cycle for the workflow on the engine loop — which polls every
    active task's hpc_job_id, runs transient-error recovery, and writes
    truth back into both V2 and V1 DBs. Without this the user has to
    wait up to `poll_interval` seconds (default 15s) before the periodic
    scanner picks it up, which feels broken right after re-opening.
    """
    try:
        from catgo.workflow.engine.lifecycle import get_engine, get_engine_loop
        engine = get_engine()
        engine_loop = get_engine_loop()
        if engine is None or engine_loop is None:
            raise HTTPException(status_code=503, detail="Workflow engine not started")

        # Verify workflow exists in V2 before scheduling work
        from catgo.routers.workflow_engine import _db as engine_db
        if engine_db is None:
            raise HTTPException(status_code=500, detail="V2 engine DB not initialized")
        try:
            engine_db.get_workflow(workflow_id)
        except KeyError:
            raise HTTPException(status_code=404, detail=f"Workflow {workflow_id} not found in engine")

        # _process_workflow is async and lives on the engine loop. Run it
        # via run_coroutine_threadsafe so this FastAPI handler doesn't
        # touch the engine's event loop directly. Time-box at 30s so a
        # hung SSH probe doesn't tie up the HTTP request indefinitely.
        future = asyncio.run_coroutine_threadsafe(
            engine._process_workflow(workflow_id), engine_loop,
        )
        try:
            await asyncio.wait_for(asyncio.wrap_future(future), timeout=30.0)
        except asyncio.TimeoutError:
            return {
                "status": "timeout",
                "message": "Reconcile is taking longer than 30s — scanner will continue in background",
            }

        # Return fresh task statuses so frontend can update without
        # waiting for its next /run-status poll.
        tasks = engine_db.get_all_tasks(workflow_id)
        return {
            "status": "ok",
            "tasks": [
                {
                    "id": t["id"],
                    "task_type": t["task_type"],
                    "status": t["status"],
                    "hpc_job_id": t.get("hpc_job_id"),
                    "error_type": t.get("error_type"),
                }
                for t in tasks
            ],
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error("[reconcile_from_hpc] %s: %s", workflow_id, e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


def _run_config_to_engine_config(config: WorkflowRunConfig) -> dict:
    """Convert V1 WorkflowRunConfig to V2 engine config dict.

    Preserves all user-configured fields from RunConfigDialog so the engine
    can resolve templates, cluster settings, account, partition, orca_dir, etc.

    Previously this function stripped everything except poll_interval and session_id,
    which caused sbatch failures (missing account) and wrong templates (fell back to
    _DEFAULT_TEMPLATE instead of user-selected ORCA template).
    """
    d = config.model_dump(exclude_none=True)

    result: dict = {
        "engine": {"poll_interval": config.poll_interval},
        "hpc": {
            "default_session_id": config.default_session_id,
            "base_work_dir": config.base_work_dir,
            "use_custodian": config.use_custodian,
            "potcar_root": "",
        },
        "execution_mode": config.execution_mode,
        "default_session_id": config.default_session_id,
        "auto_submit": True,
    }

    # Preserve the job script template selected in RunConfigDialog
    if config.job_script_template:
        result["hpc"]["job_script_template"] = config.job_script_template

    # Preserve per-engine templates (e.g. calc_templates["orca"] → ORCA SLURM template)
    if d.get("calc_templates"):
        result["calc_templates"] = d["calc_templates"]

    # Preserve per-cluster settings (account, module_loads, orca_dir, template, etc.)
    if d.get("cluster_configs"):
        result["cluster_configs"] = d["cluster_configs"]
        # Extract active cluster's settings into hpc.job_defaults so
        # job_script.py can resolve them via _get(key)
        active_cc = d["cluster_configs"].get(config.default_session_id, {})
        if active_cc:
            jd = result["hpc"].setdefault("job_defaults", {})
            for key in ("account", "module_loads", "orca_dir", "partition",
                        "potcar_root", "potcar_functional", "vasp_command",
                        "python_env"):
                val = active_cc.get(key)
                if val:
                    jd[key] = val
                    if key == "potcar_root" and val:
                        result["hpc"]["potcar_root"] = val
                    if key == "vasp_command" and val:
                        # Surface the dialog's VASP command where job_script.py
                        # looks for engine run commands so {{vasp_run_command}}
                        # / {{run_command}} render with the user's value.
                        result["hpc"].setdefault("run_commands", {})["vasp"] = val
            # Cluster-specific template overrides global
            if active_cc.get("default_template"):
                result["hpc"]["job_script_template"] = active_cc["default_template"]
            # Cluster default_job_params fills in as fallback only — user dialog values
            # (in default_job_params below) must take higher priority.
            cc_djp = active_cc.get("default_job_params")
            if isinstance(cc_djp, dict):
                for k, v in cc_djp.items():
                    if v is not None:
                        jd.setdefault(k, v)

    # Preserve global default_job_params (nodes, ntasks, walltime, partition, account, memory).
    # These come directly from the RunConfigDialog state variables and represent the user's
    # actual choices — they must OVERWRITE cluster defaults, not defer to them.
    djp = d.get("default_job_params", {})
    if djp:
        jd = result["hpc"].setdefault("job_defaults", {})
        for k, v in djp.items():
            if v is not None:
                jd[k] = v

    # Preserve orca_binary for run command resolution
    if d.get("orca_binary"):
        result["orca_binary"] = d["orca_binary"]

    return result


def _apply_run_config_to_tasks(
    db, workflow_id: str, config: WorkflowRunConfig
) -> None:
    """Apply per-step session, job params, and scripts to V2 tasks."""
    import json as _json

    tasks = db.get_all_tasks(workflow_id)
    for task in tasks:
        tid = task["id"]
        updates = {}

        # Per-step session override
        session_id = config.step_sessions.get(tid, config.default_session_id)
        if session_id:
            updates["hpc_session_id"] = session_id

        # Per-step job params — merge into params_json
        step_params = config.step_job_params.get(tid)
        step_script = config.step_scripts.get(tid)
        if step_params or step_script:
            params = _json.loads(task.get("params_json", "{}") or "{}")
            if step_params:
                params.update(step_params.model_dump(exclude_none=True))
            if step_script:
                params["job_script"] = step_script
            updates["params_json"] = _json.dumps(params)

        if updates:
            db.update_task(tid, **updates)


class PauseRequest(BaseModel):
    """Optional request body for selective job cancellation on pause."""
    cancel_step_ids: list[str] | None = None  # None = cancel all, [] = none


@router.post("/{workflow_id}/pause")
async def api_pause_workflow(workflow_id: str, req: PauseRequest = PauseRequest()):
    """Pause a running workflow via V2 engine."""
    try:
        wf = get_workflow(workflow_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Workflow {workflow_id} not found")

    if wf.status not in ("running", "paused"):
        raise HTTPException(status_code=409,
                            detail=f"Workflow is not running or paused (status: {wf.status})")

    from catgo.routers.workflow_engine import _db as engine_db
    if engine_db is None:
        raise HTTPException(status_code=500, detail="V2 engine not initialized")

    from catgo.workflow.engine.lifecycle import pause_workflow as engine_pause
    engine_pause(engine_db, workflow_id)

    # Also cancel HPC jobs if requested
    if req.cancel_step_ids is None or req.cancel_step_ids:
        try:
            from catgo.workflow.engine.lifecycle import cancel_workflow_jobs
            await cancel_workflow_jobs(engine_db, workflow_id, only_task_ids=req.cancel_step_ids)
        except Exception:
            pass  # best-effort job cancellation

    return {"status": "paused", "workflow_id": workflow_id}


@router.post("/{workflow_id}/resume")
def api_resume_workflow(workflow_id: str, config: WorkflowRunConfig):
    """Resume a paused workflow via V2 engine."""
    try:
        wf = get_workflow(workflow_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Workflow {workflow_id} not found")

    if wf.status != "paused":
        raise HTTPException(status_code=409,
                            detail=f"Workflow is not paused (status: {wf.status})")

    from catgo.routers.workflow_engine import _db as engine_db
    if engine_db is None:
        raise HTTPException(status_code=500, detail="V2 engine not initialized")

    # Re-apply config (user may have changed session/params)
    _apply_run_config_to_tasks(engine_db, workflow_id, config)

    from catgo.workflow.engine.lifecycle import resume_workflow as engine_resume
    engine_resume(engine_db, workflow_id)

    return {"status": "resumed", "workflow_id": workflow_id}


@router.get("/{workflow_id}/steps", response_model=list[StepInfo])
def api_list_steps(workflow_id: str):
    """List all steps with execution details (status, job_id, results, etc.)."""
    try:
        get_workflow(workflow_id)  # Check exists
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Workflow {workflow_id} not found")

    steps = _engine_list_steps(workflow_id)
    return [
        StepInfo(
            id=s["id"],
            node_type=s["node_type"],
            label=s.get("label", ""),
            status=s.get("status", "pending"),
            config_json=s.get("config_json", "{}"),
            hpc_job_id=s.get("hpc_job_id"),
            hpc_session_id=s.get("hpc_session_id"),
            hpc_host=s.get("hpc_host"),
            work_dir=s.get("work_dir"),
            ase_db_id=s.get("ase_db_id"),
            result_json=s.get("result_json", "{}"),
            error_message=s.get("error_message"),
            started_at=s.get("started_at"),
            completed_at=s.get("completed_at"),
        )
        for s in steps
    ]


@router.get("/{workflow_id}/run-status", response_model=WorkflowRunStatus)
def api_get_run_status(workflow_id: str):
    """Get the current execution status of a workflow with all step details."""
    try:
        wf = get_workflow(workflow_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Workflow {workflow_id} not found")

    steps = _engine_list_steps(workflow_id)
    step_infos = [
        StepInfo(
            id=s["id"],
            node_type=s["node_type"],
            label=s.get("label", ""),
            status=s.get("status", "pending"),
            config_json=s.get("config_json", "{}"),
            hpc_job_id=s.get("hpc_job_id"),
            hpc_session_id=s.get("hpc_session_id"),
            hpc_host=s.get("hpc_host"),
            work_dir=s.get("work_dir"),
            ase_db_id=s.get("ase_db_id"),
            result_json=s.get("result_json", "{}"),
            error_message=s.get("error_message"),
            started_at=s.get("started_at"),
            completed_at=s.get("completed_at"),
        )
        for s in steps
    ]

    total = len(step_infos)
    completed = sum(1 for s in step_infos if s.status == "completed")
    progress = completed / total if total > 0 else 0.0

    # Prefer V2 engine's workflow status over V1 DB (they can diverge)
    effective_status = wf.status.value
    from catgo.routers.workflow_engine import _db as engine_db
    if engine_db is not None:
        try:
            engine_wf = engine_db.get_workflow(workflow_id)
            v2_status = engine_wf.get("status", "")
            if v2_status and v2_status != effective_status:
                effective_status = v2_status
        except (KeyError, Exception):
            pass

    return WorkflowRunStatus(
        workflow_id=workflow_id,
        status=effective_status,
        steps=step_infos,
        progress=progress,
    )


@router.get("/{workflow_id}/steps/{step_id}/files")
async def api_get_step_files(workflow_id: str, step_id: str, subdir: str = ""):
    """List files in a step's remote work directory (or subdirectory)."""
    import shlex

    steps = _engine_list_steps(workflow_id)
    step = next((s for s in steps if s["id"] == step_id), None)
    if not step:
        raise HTTPException(status_code=404, detail=f"Step {step_id} not found")

    work_dir = step.get("work_dir")
    session_id = step.get("hpc_session_id")

    if not work_dir:
        return {"files": [], "work_dir": work_dir}

    # Prevent path traversal
    if subdir and (".." in subdir or subdir.startswith("/")):
        raise HTTPException(status_code=400, detail="Invalid subdirectory")

    target_dir = f"{work_dir}/{subdir}" if subdir else work_dir

    # Local execution: no HPC session, serve files from local filesystem
    if not session_id:
        import os
        from datetime import datetime as _dt
        if not os.path.realpath(target_dir).startswith(os.path.realpath(work_dir)):
            raise HTTPException(status_code=400, detail="Invalid subdirectory")
        if os.path.isdir(target_dir):
            files = []
            for entry in os.scandir(target_dir):
                try:
                    stat = entry.stat()
                    files.append({
                        "name": entry.name,
                        "size": str(stat.st_size),
                        "modified": _dt.fromtimestamp(stat.st_mtime).strftime("%b %d %H:%M"),
                        "permissions": oct(stat.st_mode)[-3:],
                    })
                except OSError:
                    pass
            return {"files": files, "work_dir": target_dir}
        return {"files": [], "work_dir": target_dir}

    try:
        from catgo.utils.hpc_client import pool
        hpc = await pool.get_connection_for_step(session_id, step.get("hpc_host"))
        if not hpc:
            raise HTTPException(status_code=503, detail="No HPC session connected")

        result = await hpc.conn.run(f"ls -la {shlex.quote(target_dir)}", check=False)
        if result.exit_status != 0:
            return {"files": [], "work_dir": target_dir, "error": result.stderr}

        files = []
        for line in result.stdout.strip().split("\n")[1:]:  # Skip 'total' line
            parts = line.split()
            if len(parts) >= 9:
                files.append({
                    "name": parts[-1],
                    "size": parts[4],
                    "modified": " ".join(parts[5:8]),
                    "permissions": parts[0],
                })
        return {"files": files, "work_dir": target_dir}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{workflow_id}/steps/{step_id}/output/{filename}")
async def api_get_step_output(workflow_id: str, step_id: str, filename: str):
    """Read a specific output file from a step's work directory.

    Common files: CONTCAR, OUTCAR, OSZICAR, INCAR, KPOINTS, submit.sh
    """
    # Validate filename to prevent path traversal
    if "/" in filename or "\\" in filename or ".." in filename:
        raise HTTPException(status_code=400, detail="Invalid filename")

    steps = _engine_list_steps(workflow_id)
    step = next((s for s in steps if s["id"] == step_id), None)
    if not step:
        raise HTTPException(status_code=404, detail=f"Step {step_id} not found")

    work_dir = step.get("work_dir")
    session_id = step.get("hpc_session_id")

    if not work_dir:
        raise HTTPException(status_code=404, detail="Step has no work directory")

    # Local execution: read file from local filesystem
    if not session_id:
        import os
        file_path = os.path.join(work_dir, filename)
        if not os.path.realpath(file_path).startswith(os.path.realpath(work_dir)):
            raise HTTPException(status_code=400, detail="Invalid filename")
        if os.path.isfile(file_path):
            with open(file_path, "r", errors="replace") as f:
                content = f.read()
            return {"filename": filename, "content": content, "work_dir": work_dir}
        raise HTTPException(status_code=404, detail=f"File {filename} not found")

    try:
        from catgo.utils.hpc_client import pool
        hpc = await pool.get_connection_for_step(session_id, step.get("hpc_host"))
        if not hpc:
            raise HTTPException(status_code=503, detail="No HPC session connected")

        from catgo.utils.job_parser import read_remote_file
        content, _ = await read_remote_file(hpc.conn, f"{work_dir}/{filename}")
        if content is None:
            raise HTTPException(status_code=404, detail=f"File {filename} not found")

        return {"filename": filename, "content": content, "work_dir": work_dir}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ====== ASE Database Results ======

@router.get("/{workflow_id}/results")
def api_get_workflow_results(workflow_id: str):
    """Get all ASE database results for a workflow."""
    try:
        from catgo.utils.ase_db import query_results
        results = query_results(workflow_id=workflow_id)
        return {"results": results, "count": len(results)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/results/{row_id}")
def api_get_result(row_id: int):
    """Get a single ASE database result by row ID."""
    try:
        from catgo.utils.ase_db import get_result
        return get_result(row_id)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/results/{row_id}/structure")
def api_get_result_structure(row_id: int):
    """Get a result as PymatgenStructure JSON (for loading into viewer)."""
    try:
        from catgo.utils.ase_db import get_result
        from catgo.utils.converter import ase_to_pymatgen

        result = get_result(row_id)
        atoms = result["atoms"]
        structure = ase_to_pymatgen(atoms)

        # Restore site properties & labels from stored metadata
        restore_site_metadata(structure, result.get("data") or {})

        return structure.model_dump()
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/results/save-structure")
def api_save_structure(request: SaveStructureRequest):
    """Save a user structure to the ASE database."""
    try:
        from catgo.models.structure import PymatgenStructure
        from catgo.utils.converter import pymatgen_to_ase
        from catgo.utils.ase_db import store_result

        structure = PymatgenStructure(**request.structure)
        atoms = pymatgen_to_ase(structure)

        # Extract site properties & labels that ASE Atoms can't preserve
        # (pseudo_h_potcar, pseudo_h_charge, selective_dynamics, custom labels)
        data_dict = extract_site_metadata(structure)

        row_id = store_result(
            atoms,
            workflow_id=request.project_id or "__user__",
            step_id="__saved__",
            node_type="user_save",
            energy=None,
            data_dict=data_dict if data_dict else None,
        )
        return {"row_id": row_id, "formula": atoms.get_chemical_formula()}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/results/{row_id}/label")
def api_update_result_label(row_id: int, label: str):
    """Update the display label of a result."""
    try:
        from catgo.utils.ase_db import update_result_label
        update_result_label(row_id, label)
        return {"row_id": row_id, "label": label}
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/results/{row_id}")
def api_delete_result(row_id: int):
    """Delete a result from the ASE database."""
    try:
        from catgo.utils.ase_db import delete_result
        delete_result(row_id)
        return {"deleted": row_id}
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# [2025-02] Changed: endpoint auto-decides copy vs move based on node_type.
# Previously always moved (updated workflow_id), which broke workflow results.
@router.put("/results/{row_id}/move/{project_id}")
def api_move_result(row_id: int, project_id: str):
    """Move or copy a result to a project.

    user_save results are moved (workflow_id updated).
    Workflow-produced results are copied (new row created) to preserve the original.
    """
    try:
        from catgo.utils.ase_db import get_result, move_result, copy_result
        result = get_result(row_id)
        node_type = result["key_value_pairs"].get("node_type", "")

        if node_type == "user_save":
            move_result(row_id, project_id)
            return {"row_id": row_id, "project_id": project_id, "action": "moved"}
        else:
            new_id = copy_result(row_id, project_id)
            return {"row_id": new_id, "project_id": project_id, "action": "copied"}
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{workflow_id}/results-enriched")
async def api_get_enriched_results(workflow_id: str):
    """Enhanced results with energy/atom, volume, cell params for dashboard.

    For ORCA optimization steps with convergence_points, expands each step
    into separate results so optimization cycles appear as separate data points.
    """
    try:
        from catgo.utils.ase_db import query_results_enriched
        from catgo.utils.workflow_db import get_db

        # Get workflow name for labeling
        wf = get_workflow(workflow_id)
        wf_name = wf.name if wf else workflow_id

        results = await asyncio.to_thread(query_results_enriched, workflow_id=workflow_id)

        # Enrich with workflow name and step labels
        steps = list_steps(workflow_id)
        step_map = {s["id"]: s.get("label", s.get("node_type", "")) for s in steps}
        step_config_map = {s["id"]: s.get("config_json") for s in steps}

        # Expand ORCA convergence points into separate results
        expanded_results = []
        with get_db() as conn:
            for r in results:
                r["workflow_name"] = wf_name
                r["step_label"] = step_map.get(r["step_id"], r["step_id"])

                # Check if this step has convergence_points (ORCA calculations)
                step_id = r["step_id"]
                config_str = step_config_map.get(step_id, "{}")
                config = json.loads(config_str) if isinstance(config_str, str) else config_str
                is_orca = config.get("software") == "orca"

                if is_orca:
                    # Fetch the step's result_json to get convergence_points
                    row = conn.execute(
                        "SELECT result_json, node_type FROM workflow_steps WHERE id = ? AND workflow_id = ?",
                        (step_id, workflow_id),
                    ).fetchone()

                    if row:
                        result_json_str = row["result_json"] if row["result_json"] else "{}"
                        result_json = json.loads(result_json_str) if result_json_str else {}
                        convergence_points = result_json.get("convergence_points", [])
                        node_type = row["node_type"] if row["node_type"] else ""

                        # For UV-Vis: DON'T expand into multiple rows (prevents initial load freeze)
                        # Full electronic state data is preserved in result_json for absorption graph
                        if node_type == "orca_uvvis":
                            # Keep as single parent row, don't expand
                            pass  # Will be appended as-is below
                        else:
                            # For optimization/IRC/NEB-TS: expand all convergence data into separate results
                            expanded = expand_convergence_points(r, convergence_points, node_type, r["step_label"])
                            if expanded:
                                expanded_results.extend(expanded)
                                continue
                            elif convergence_points and len(convergence_points) == 1:
                                # Single point: use its energy instead of ASE DB energy
                                r["energy"] = convergence_points[0].get("energy", r["energy"])

                # Non-ORCA or no convergence points: keep as is
                expanded_results.append(r)

            # Part B: Non-structure nodes (sp, uvvis, slow_growth, etc.) that have no ASE DB entry
            NON_STRUCT_NODES = {"orca_sp", "orca_freq", "orca_uvvis", "orca_irc", "orca_neb_ts", "single_point", "freq", "uvvis", "slow_growth"}
            part_b_rows = conn.execute(
                f"""
                SELECT ws.id, ws.node_type, ws.label, ws.result_json, ws.workflow_id
                FROM workflow_steps ws
                WHERE ws.workflow_id = ?
                  AND ws.status = 'completed'
                  AND ws.ase_db_id IS NULL
                  AND ws.node_type IN ({",".join("?" * len(NON_STRUCT_NODES))})
                  AND ws.result_json IS NOT NULL
                """,
                (workflow_id, *NON_STRUCT_NODES),
            ).fetchall()
            if part_b_rows:
                # Add wf_name for build_part_b_results compatibility
                part_b_dicts = []
                for row in part_b_rows:
                    d = dict(row)
                    d["wf_name"] = wf_name
                    part_b_dicts.append(d)
                part_b_results = build_part_b_results(part_b_dicts)
                # Add step_label to Part B results
                for r in part_b_results:
                    r["step_label"] = step_map.get(r.get("step_id", ""), r.get("step_id", ""))
                expanded_results.extend(part_b_results)

            # Part C: V2 engine results (task_results table)
            v2_task_rows = await asyncio.to_thread(
                fetch_v2_task_results_by_workflow, workflow_id
            )
            if v2_task_rows:
                part_c_results = await asyncio.to_thread(
                    build_part_c_results, v2_task_rows
                )
                expanded_results.extend(part_c_results)

        return {"results": expanded_results, "count": len(expanded_results)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{workflow_id}/convergence/{step_id}")
async def api_get_convergence(workflow_id: str, step_id: str):
    """Read convergence history from step's work directory.

    Dispatches by engine: VASP → OSZICAR+OUTCAR, CP2K → cp2k.out/project.out.
    Both parsers return the same ConvergenceData shape so the frontend chart
    config can be shared across engines.
    """
    try:
        step = _engine_get_step_status(workflow_id, step_id)
        if not step:
            raise HTTPException(status_code=404, detail="Step not found")

        work_dir = step.get("work_dir")
        session_id = step.get("hpc_session_id")

        if not work_dir:
            return {"points": [], "converged": False, "error": "No work directory"}

        from catgo.utils.hpc_client import pool
        hpc = await pool.get_connection_for_step(session_id, step.get("hpc_host"))
        if not hpc or not hpc.conn:
            return {"points": [], "converged": False, "error": "HPC session not connected"}

        # Decide which parser to use. Legacy `cp2k_*` task types and unified
        # nodes (geo_opt / cell_opt / single_point / md) with software=cp2k
        # both route to the CP2K parser. Everything else stays on the VASP
        # parser — that's the historical default and what ORCA/MLP rely on
        # via their own dedicated endpoints.
        node_type = step.get("node_type", "") or ""
        try:
            step_params = json.loads(step.get("config_json", "{}") or "{}")
        except Exception:
            step_params = {}
        software = (step_params.get("software") or "").lower()
        is_cp2k = node_type.startswith("cp2k_") or software == "cp2k"

        from catgo.utils.job_parser import parse_vasp_convergence, parse_cp2k_convergence
        parser = parse_cp2k_convergence if is_cp2k else parse_vasp_convergence
        try:
            conv_data = await asyncio.wait_for(
                parser(hpc.conn, work_dir), timeout=15.0
            )
        except asyncio.TimeoutError:
            return {"points": [], "converged": False, "error": "Convergence fetch timed out (15s)"}

        if not conv_data.success:
            return {"points": [], "converged": False, "error": conv_data.message}

        points = []
        prev_energy = None
        for pt in conv_data.points:
            dE = (pt.energy - prev_energy) if prev_energy is not None else 0.0
            entry = {
                "step": pt.step,
                "energy": pt.energy,
                "dE": dE,
                "energy_sigma0": pt.energy_sigma0,
                "max_force": pt.max_force,
                "rms_force": pt.rms_force,
            }
            # MD-only fields — populated by parse_cp2k_convergence's MD branch.
            # The frontend keys these by truthy >0 so emitting unconditionally
            # is fine; the VaspMonitorPlot ignores them since VASP_SERIES
            # doesn't reference them.
            if pt.temperature > 0 or pt.potential_energy != 0 or pt.kinetic_energy != 0:
                entry["temperature"] = pt.temperature
                entry["kinetic_energy"] = pt.kinetic_energy
                entry["potential_energy"] = pt.potential_energy
                entry["conserved_energy"] = pt.conserved_energy
            points.append(entry)
            prev_energy = pt.energy

        return {"points": points, "converged": conv_data.converged}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{workflow_id}/mlp-progress/{step_id}")
async def api_get_mlp_progress(workflow_id: str, step_id: str):
    """Read per-iteration progress from an MLP step's ASE optimizer log.

    Mirrors `api_get_convergence` for MLP nodes. The step's work_dir
    contains either opt.log (mlp_relax) or neb.log (mlp_neb); this
    endpoint locates it, parses each iteration line, and returns the
    same `{points, converged, message}` shape the frontend renders.

    Local-only for now — HPC-remote MLP steps return an empty result.
    """
    try:
        step = _engine_get_step_status(workflow_id, step_id)
        if not step:
            raise HTTPException(status_code=404, detail="Step not found")

        work_dir = step.get("work_dir")
        if not work_dir:
            return {"points": [], "converged": False, "message": "No work directory yet"}

        # Only local work dirs are readable here. HPC work dirs would need
        # SSH tailing — deferred until the MLP+HPC path is tested.
        if step.get("hpc_session_id"):
            return {
                "points": [], "converged": False,
                "message": "MLP progress over HPC is not yet wired",
            }

        import os
        # Pick opt.log for relax/vibrations, neb.log for NEB. The step's
        # node_type here is the ORIGINAL graph-model type (geo_opt,
        # ts_search, freq) — NEB's resolved type mlp_neb never appears
        # at this layer, so we match by keyword AND by the known
        # graph type name.
        # Explicit log-file mapping only. An earlier "any *.log in work_dir"
        # fallback was removed because os.listdir ordering is OS-dependent
        # and a stale stdout.log / lammps.log from a previous aborted run
        # could silently shadow the current neb.log / opt.log. Sticking to
        # the contract ASE actually writes is safer.
        node_type = (step.get("node_type") or "").lower()
        candidates = []
        if "neb" in node_type or node_type == "ts_search":
            candidates.append(os.path.join(work_dir, "neb.log"))
        candidates.append(os.path.join(work_dir, "opt.log"))

        log_path = next((p for p in candidates if os.path.isfile(p)), None)
        if not log_path:
            return {"points": [], "converged": False, "message": "Log file not created yet"}

        # Resolve the per-step fmax target from config_json. If we can't
        # find it we DON'T silently fall through to a 0.05 default —
        # mlp_relax uses 0.01, ts_search NEB uses 0.05, mlp_md has no
        # fmax concept. A wrong default would flip a still-running node
        # to `converged=True` and trigger the frontend's status-sync path
        # to mark the node "completed" prematurely. When we can't resolve
        # the target, return `converged=None` so the frontend keeps the
        # node in "running" and the status-sync short-circuits.
        fmax_target: float | None = None
        try:
            import json as _json
            config = _json.loads(step.get("config_json") or "{}")
            params = config.get("params") if isinstance(config.get("params"), dict) else config
            if isinstance(params, dict) and "fmax" in params:
                fmax_target = float(params["fmax"])
        except (ValueError, TypeError) as exc:
            logger.warning(
                "Could not parse fmax from step %s config_json: %s — "
                "convergence flag will be reported as null.",
                step_id, exc,
            )
        if fmax_target is None:
            # No known target → parse the log for points but skip the
            # converged check. Parser uses a sentinel fmax that's never
            # reached so `converged` will be False regardless; we override
            # to null below.
            fmax_target = -1.0

        from catgo.utils.job_parser import parse_ase_opt_log
        # Parser is synchronous & reads a local file — offload so the
        # event loop doesn't block on large log tails.
        conv_data = await asyncio.to_thread(parse_ase_opt_log, log_path, fmax_target)

        if not conv_data.success:
            return {"points": [], "converged": False, "message": conv_data.message}

        # If fmax_target was unresolvable, null out `converged` so the
        # frontend status-sync branch in NodeStatusPanel can't use it.
        unresolved_fmax = fmax_target < 0

        prev_energy = None
        points = []
        for pt in conv_data.points:
            dE = (pt.energy - prev_energy) if prev_energy is not None else 0.0
            points.append({
                "step": pt.step,
                "energy": pt.energy,
                "dE": dE,
                "energy_sigma0": pt.energy_sigma0,
                "max_force": pt.max_force,
                "rms_force": pt.rms_force,
            })
            prev_energy = pt.energy

        # When we couldn't resolve fmax_target, `converged` is meaningless
        # — null it so the frontend status-sync branch doesn't fire.
        converged_value: Optional[bool] = None if unresolved_fmax else conv_data.converged
        message = conv_data.message
        if unresolved_fmax and points:
            message = (
                f"step {points[-1]['step']} · fmax={points[-1]['max_force']:.3f} eV/Å "
                f"(target fmax not in config — convergence flag suppressed)"
            )
        return {
            "points": points,
            "converged": converged_value,
            "message": message,
        }
    except HTTPException:
        raise
    except Exception as e:
        # Log the full exception server-side; return a generic message to
        # avoid leaking internal paths in the API detail.
        logger.exception("Error in api_get_mlp_progress for %s/%s", workflow_id, step_id)
        raise HTTPException(status_code=500, detail=f"Error reading MLP progress: {type(e).__name__}")


@router.get("/{workflow_id}/forces/{step_id}")
async def api_get_step_forces(workflow_id: str, step_id: str, ionic_step: int = 0):
    """Get per-atom force vectors for a specific ionic step from OUTCAR."""
    try:
        step = _engine_get_step_status(workflow_id, step_id)
        if not step:
            raise HTTPException(status_code=404, detail="Step not found")

        work_dir = step.get("work_dir")
        session_id = step.get("hpc_session_id")

        if not work_dir:
            return {"success": False, "error": "No work directory"}

        from catgo.utils.hpc_client import pool
        hpc = await pool.get_connection_for_step(session_id, step.get("hpc_host"))
        if not hpc or not hpc.conn:
            return {"success": False, "error": "HPC session not connected"}

        from catgo.utils.job_parser import parse_vasp_forces, parse_vasp_forces_h5

        # Try H5 first (VASP 6.4+ vaspout.h5), fall back to OUTCAR AWK
        h5_result = await parse_vasp_forces_h5(hpc.conn, work_dir, ionic_step)
        if h5_result and h5_result.get("success"):
            return h5_result
        return await parse_vasp_forces(hpc.conn, work_dir, ionic_step)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{workflow_id}/vasp_frequencies/{step_id}")
async def api_get_vasp_frequencies(workflow_id: str, step_id: str):
    """Get VASP frequency data (lazy-fetch with cache in result_json)."""
    try:
        from catgo.utils.workflow_db import get_db

        with get_db() as conn:
            row = conn.execute(
                "SELECT result_json, node_type, status, work_dir, hpc_session_id, hpc_host "
                "FROM workflow_steps WHERE id = ? AND workflow_id = ?",
                (step_id, workflow_id),
            ).fetchone()

        if not row:
            raise HTTPException(status_code=404, detail="Step not found")

        result = json.loads(row["result_json"] or "{}")

        # Check cache first
        if result.get("real_freqs") is not None:
            return {
                "success": True,
                "real_freqs": result["real_freqs"],
                "imag_freqs": result.get("imag_freqs", []),
                "eigenvectors": result.get("eigenvectors", []),
                "positions": result.get("positions", []),
                "masses": result.get("masses", []),
                "ions_per_type": result.get("ions_per_type", []),
                "atom_types": result.get("atom_types", []),
                "total_atoms": result.get("total_atoms", 0),
                "num_imaginary": result.get("num_imaginary", 0),
                "free_indices": result.get("free_indices"),
            }

        # Not cached — parse from OUTCAR via SSH
        work_dir = result.get("work_dir") or row["work_dir"]
        if not work_dir:
            return {"success": False, "message": "No work directory"}

        from catgo.utils.hpc_client import pool
        hpc = await pool.get_connection_for_step(row["hpc_session_id"], row["hpc_host"])
        if not hpc or not hpc.conn:
            return {"success": False, "message": "HPC session not connected"}

        from catgo.utils.vasp_freq_parser import parse_vasp_frequencies
        freq_data = await parse_vasp_frequencies(hpc.conn, work_dir)

        if freq_data.get("success"):
            # Cache in result_json
            result.update(freq_data)
            update_step(workflow_id, step_id, {
                "result_json": json.dumps(result, default=str),
            })

        return freq_data
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class GibbsRequest(BaseModel):
    mode: str = "adsorbed"
    temperature: float = 298.15
    pressure: float = 101325.0
    freq_cutoff: float = 50.0
    n_unpaired: int = 0


@router.post("/{workflow_id}/gibbs/{step_id}")
def api_calculate_gibbs(workflow_id: str, step_id: str, req: GibbsRequest):
    """Calculate Gibbs free energy correction from stored frequency data."""
    try:
        from catgo.utils.workflow_db import get_db

        with get_db() as conn:
            row = conn.execute(
                "SELECT result_json FROM workflow_steps WHERE id = ? AND workflow_id = ?",
                (step_id, workflow_id),
            ).fetchone()

        if not row:
            raise HTTPException(status_code=404, detail="Step not found")

        result = json.loads(row["result_json"] or "{}")
        real_freqs_raw = result.get("real_freqs", [])
        imag_freqs_raw = result.get("imag_freqs", [])

        if not real_freqs_raw:
            return {"success": False, "message": "No frequency data available"}

        # Extract cm⁻¹ values (stored as list of dicts or list of floats)
        real_cm = [
            f["frequency_cm"] if isinstance(f, dict) else f for f in real_freqs_raw
        ]
        imag_cm = [
            f["frequency_cm"] if isinstance(f, dict) else f for f in imag_freqs_raw
        ]

        from catgo.utils.gibbs_calculator import calc_adsorbed, calc_gas

        if req.mode == "adsorbed":
            return calc_adsorbed(real_cm, imag_cm, req.temperature, req.freq_cutoff)
        elif req.mode == "gas":
            positions = result.get("positions", [])
            masses = result.get("masses", [])
            atom_types = result.get("atom_types", [])
            free_indices = result.get("free_indices")

            if not positions or not masses:
                return {"success": False, "message": "Position/mass data required for gas mode"}

            return calc_gas(
                real_cm, imag_cm, positions, masses, atom_types,
                T=req.temperature, P=req.pressure,
                n_unpaired=req.n_unpaired, free_indices=free_indices,
            )
        else:
            return {"success": False, "message": f"Unknown mode: {req.mode}"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{workflow_id}/step-results/{step_id}")
async def api_get_step_results(workflow_id: str, step_id: str):
    """Get completed step results from database (convergence points, energy, etc.).

    Uses V2 engine when available (reads from task_results table), falls back to
    V1 workflow_steps table for legacy workflows.
    """
    try:
        # Use V2-compatible reader (reads from task_results if available)
        step = _engine_get_step_status(workflow_id, step_id)

        if not step:
            raise HTTPException(status_code=404, detail="Step not found")

        status = step.get("status", "").lower()
        if status != "completed":
            raise HTTPException(status_code=400, detail=f"Step not completed (status: {status})")

        result_json_str = step.get("result_json", "{}") or "{}"
        result_json = json.loads(result_json_str) if isinstance(result_json_str, str) else result_json_str

        # Return convergence points if available
        return {
            "node_type": step.get("node_type"),
            "convergence_points": result_json.get("convergence_points", []),
            "energy_eh": result_json.get("energy_eh"),
            "energy_ev": result_json.get("energy_ev"),
            "converged": result_json.get("converged"),
            "n_steps": result_json.get("n_steps"),
            "full_summary": result_json,  # Include full summary for detailed analysis
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{workflow_id}/orca_progress/{step_id}")
async def api_get_orca_progress(workflow_id: str, step_id: str):
    """Read ORCA.out convergence history from step's work directory during live calculation.

    Enforces a 30-second timeout to prevent hanging on large ORCA.out files.
    Dispatches to node-type-specific parsers (opt/sp/freq vs irc vs uvvis).
    """
    try:
        step = _engine_get_step_status(workflow_id, step_id)
        if not step:
            raise HTTPException(status_code=404, detail="Step not found")

        work_dir = step.get("work_dir")
        session_id = step.get("hpc_session_id")
        node_type = step.get("node_type", "orca_opt")  # Default to opt if not specified

        # Resolve unified node types (e.g. ts_search + software=orca → orca_neb_ts)
        # so the correct parser is dispatched for NEB, IRC, UV-Vis, etc.
        from workflow.node_sets import UNIFIED_CALC_NODES, _resolve_software
        if node_type in UNIFIED_CALC_NODES:
            try:
                config_raw = step.get("config_json") or "{}"
                config = json.loads(config_raw) if isinstance(config_raw, str) else config_raw
            except Exception:
                config = {}
            node_type, _ = _resolve_software(node_type, config)

        if not work_dir:
            return {"points": [], "converged": False, "error": "No work directory"}

        from catgo.utils.hpc_client import pool
        hpc = await pool.get_connection_for_step(session_id, step.get("hpc_host"))
        if not hpc or not hpc.conn:
            return {"points": [], "converged": False, "error": "HPC session not connected"}

        from catgo.utils.job_parser import parse_orca_progress
        try:
            # Enforce 30-second timeout to prevent hanging
            orca_data = await asyncio.wait_for(
                parse_orca_progress(hpc.conn, work_dir, node_type=node_type),
                timeout=30.0
            )
        except asyncio.TimeoutError:
            return {"points": [], "converged": False, "error": "ORCA progress read timeout (check HPC connection)"}

        if not orca_data.success:
            return {"points": [], "converged": False, "error": orca_data.message}

        is_irc = node_type == "orca_irc"
        points = []
        prev_energy = None
        for pt in orca_data.points:
            p = {
                "step": pt.step,
                "energy": pt.energy,
            }
            if is_irc:
                # IRC: preserve original dE (kcal/mol relative to TS) and gradient fields
                p["dE"] = pt.dE
                p["max_gradient"] = pt.max_gradient
                p["rms_gradient"] = pt.rms_gradient
                p["is_ts"] = pt.is_ts
            else:
                # Opt/SP/Freq: sequential dE and force/step fields
                p["dE"] = (pt.energy - prev_energy) if prev_energy is not None else 0.0
                p["max_force"] = pt.max_force
                p["rms_force"] = pt.rms_force
                p["max_step"] = pt.max_step
                p["rms_step"] = pt.rms_step
            points.append(p)
            prev_energy = pt.energy

        response = {"points": points, "converged": orca_data.converged, "message": orca_data.message}
        # Include convergence thresholds for IRC gradient chart
        if orca_data.convergence_thresholds:
            response["convergence_thresholds"] = orca_data.convergence_thresholds
        # Include per-image energies from ORCA.interp for NEB live monitoring
        if orca_data.image_energies:
            response["image_energies"] = {
                str(k): [[img_idx, energy] for img_idx, energy in v]
                for k, v in orca_data.image_energies.items()
            }
        return response
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{workflow_id}/orca_uvvis_progress_light/{step_id}")
async def api_get_orca_uvvis_progress_light(workflow_id: str, step_id: str):
    """Lightweight UV-Vis progress monitoring (file size only, no parsing).

    Returns file size as a progress proxy without parsing all 100+ electronic states.
    Fast enough for 30-second polling intervals.
    """
    try:
        step = _engine_get_step_status(workflow_id, step_id)
        if not step:
            raise HTTPException(status_code=404, detail="Step not found")

        work_dir = step.get("work_dir")
        session_id = step.get("hpc_session_id")

        if not work_dir:
            return {"file_size": 0, "completed": False, "message": "No work directory"}

        from catgo.utils.hpc_client import pool
        hpc = await pool.get_connection_for_step(session_id, step.get("hpc_host"))
        if not hpc or not hpc.conn:
            return {"file_size": 0, "completed": False, "message": "HPC session not connected"}

        try:
            # Just get file size - no parsing needed
            result = await asyncio.wait_for(
                hpc.get_remote_file_size(f"{work_dir}/ORCA.out"),
                timeout=10.0
            )
            file_size = result if result else 0

            # Check for completion marker in last 500 bytes
            try:
                last_bytes = await asyncio.wait_for(
                    hpc.conn.read_remote_file(f"{work_dir}/ORCA.out", max_bytes=500, from_end=True),
                    timeout=5.0
                )
                completed = "excited states" in last_bytes.lower() and "done" in last_bytes.lower()
            except Exception as e:
                logger.debug("UV-Vis completion marker check failed: %s", e)
                completed = False

            return {
                "file_size": file_size,
                "completed": completed,
                "message": "UV-Vis running..." if not completed else "UV-Vis completed"
            }
        except asyncio.TimeoutError:
            return {"file_size": 0, "completed": False, "message": "File size check timeout"}

    except HTTPException:
        raise
    except Exception as e:
        return {"file_size": 0, "completed": False, "message": f"Error: {str(e)}"}


@router.get("/{workflow_id}/irc_trajectory/{step_id}")
async def api_get_irc_trajectory(workflow_id: str, step_id: str):
    """Download IRC full trajectory file from HPC on-demand.

    ORCA names trajectory files using the input basename: ORCA.inp → ORCA_IRC_Full_trj.xyz.
    Returns the full IRC trajectory as XYZ format for visualization in the trajectory viewer.
    """
    try:
        step = _engine_get_step_status(workflow_id, step_id)
        if not step:
            raise HTTPException(status_code=404, detail="Step not found")

        work_dir = step.get("work_dir")
        session_id = step.get("hpc_session_id")
        node_type = step.get("node_type", "")

        if node_type != "orca_irc":
            raise HTTPException(status_code=400, detail="This endpoint only supports orca_irc nodes")

        if not work_dir:
            raise HTTPException(status_code=400, detail="No work directory")

        from catgo.utils.hpc_client import pool
        hpc = await pool.get_connection_for_step(session_id, step.get("hpc_host"))
        if not hpc or not hpc.conn:
            raise HTTPException(status_code=503, detail="No HPC session connected")

        from catgo.utils.job_parser import read_remote_file
        import shlex

        safe_work_dir = shlex.quote(work_dir)

        # ORCA appends the input basename to all IRC output files.
        # The input is always written as ORCA.inp so basename = ORCA.
        # File: ORCA_IRC_Full_trj.xyz
        trajectory_path = f"{safe_work_dir}/ORCA_IRC_Full_trj.xyz"

        try:
            # Read IRC trajectory file (typically 10–200 KB for 40-step paths)
            content, _ = await read_remote_file(hpc.conn, trajectory_path, max_bytes=10 * 1024 * 1024)
            if not content:
                raise HTTPException(status_code=404, detail="ORCA_IRC_Full_trj.xyz not found on HPC")

            return {
                "content": content,
                "filename": "ORCA_IRC_Full_trj.xyz"
            }
        except asyncio.TimeoutError:
            raise HTTPException(status_code=504, detail="Timeout reading trajectory file from HPC")

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/project/{project_id}/results-enriched")
async def api_get_project_enriched_results(project_id: str):
    """Aggregate enriched results across all workflows in a project.

    Expands convergence_points for ORCA calculations into separate data points.
    """
    try:
        from catgo.utils.ase_db import query_results_enriched
        from catgo.utils.workflow_db import get_db

        # Verify project exists
        get_project(project_id)

        # Query workflows belonging to this project directly from DB
        with get_db() as conn:
            rows = conn.execute(
                "SELECT id, name FROM workflows WHERE project_id = ?",
                (project_id,),
            ).fetchall()

        all_results = []
        ORCA_WITH_CONV = {"orca_opt", "orca_neb_ts", "orca_irc"}

        # Part A: Structure-based results from ASE DB (no expansion)
        # Parallelize query_results_enriched for all workflows (avoid sequential await)
        part_a_data = await asyncio.gather(
            *[asyncio.to_thread(query_results_enriched, workflow_id=row["id"]) for row in rows]
        )

        # Parallelize list_steps calls
        steps_data = await asyncio.gather(
            *[asyncio.to_thread(list_steps, row["id"]) for row in rows]
        )

        # Batch-fetch convergence_points for opt/neb_ts/irc steps (off the async event loop)
        all_part_a_step_ids = [
            r["step_id"]
            for results_list in part_a_data
            for r in results_list
            if r.get("node_type", "") in ORCA_WITH_CONV
        ]
        conv_map = await asyncio.to_thread(fetch_convergence_points, all_part_a_step_ids)

        # Batch-fetch vibrational frequencies for orca_freq steps
        freq_step_ids = [
            r["step_id"]
            for results_list in part_a_data
            for r in results_list
            if r.get("node_type") == "orca_freq"
        ]
        freq_map = await asyncio.to_thread(fetch_frequencies, freq_step_ids)

        # Annotate Part A rows — expand convergence_points for ORCA opt/neb_ts/irc
        for row, results, steps in zip(rows, part_a_data, steps_data):
            wf_name = row["name"]
            step_map = {s["id"]: s.get("label", s.get("node_type", "")) for s in steps}

            for r in results:
                r["workflow_name"] = wf_name
                r["step_label"] = step_map.get(r["step_id"], r["step_id"])

                if r.get("node_type") in ORCA_WITH_CONV:
                    cp = conv_map.get(r["step_id"], [])
                    node_type_resolved = r.get("node_type", "")
                    expanded = expand_convergence_points(r, cp, node_type_resolved, r["step_label"])
                    if expanded:
                        all_results.extend(expanded)
                        continue
                    elif cp and len(cp) == 1:
                        r["energy"] = cp[0].get("energy", r["energy"])
                elif r.get("node_type") == "orca_freq":
                    r["frequencies"] = freq_map.get(r["step_id"], [])

                all_results.append(r)

        # Part B: Non-structure nodes (sp, freq, uvvis, slow_growth, etc.) from result_json
        NON_STRUCT_NODES = {"orca_sp", "orca_freq", "orca_uvvis", "orca_irc", "orca_neb_ts", "single_point", "freq", "uvvis", "slow_growth"}
        with get_db() as conn:
            step_rows = conn.execute(
                f"""
                SELECT ws.id, ws.node_type, ws.label, ws.result_json, ws.workflow_id, w.name as wf_name
                FROM workflow_steps ws
                JOIN workflows w ON ws.workflow_id = w.id
                WHERE w.project_id = ?
                  AND ws.status = 'completed'
                  AND ws.ase_db_id IS NULL
                  AND ws.node_type IN ({",".join("?" * len(NON_STRUCT_NODES))})
                  AND ws.result_json IS NOT NULL
                """,
                (project_id, *NON_STRUCT_NODES),
            ).fetchall()

        # Run Part B in thread pool to avoid blocking async event loop
        part_b_results = await asyncio.to_thread(build_part_b_results, step_rows)
        all_results.extend(part_b_results)

        part_a_count = len(all_results) - len(part_b_results)

        # Part C: V2 engine results from task_results table
        # V2 engine never writes to workflow_steps or ASE DB, so Parts A/B miss them entirely.
        v2_task_rows = await asyncio.to_thread(fetch_v2_task_results_for_project, project_id)
        if v2_task_rows:
            part_c_results = await asyncio.to_thread(build_part_c_results, v2_task_rows)
            all_results.extend(part_c_results)
            logger.info(f"[{project_id}] Enriched results: Part A={part_a_count}, Part B={len(part_b_results)}, Part C={len(part_c_results)}, Total={len(all_results)}")
        else:
            logger.info(f"[{project_id}] Enriched results: Part A={part_a_count}, Part B={len(part_b_results)}, Part C=0 (no V2 engine results), Total={len(all_results)}")

        return {"results": all_results, "count": len(all_results)}
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ─── Engine Definition Endpoints ───

@router.get("/engine-defs")
async def list_engine_defs():
    """Return metadata for all declarative engines (built-in + custom)."""
    try:
        from workflow.engine_runtime import all_runtimes
        runtimes = all_runtimes()
        return [rt.to_dict() for rt in runtimes]
    except Exception as e:
        import logging
        logging.getLogger(__name__).error(f"Failed to load engine defs: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to load engine definitions: {str(e)}")


@router.get("/engine-defs/{engine_key}")
async def get_engine_def(engine_key: str):
    """Return metadata for a specific declarative engine."""
    from workflow.engine_runtime import get_runtime
    rt = get_runtime(engine_key)
    if not rt:
        raise HTTPException(status_code=404, detail=f"Engine '{engine_key}' not found")
    return rt.to_dict()


@router.post("/engine-defs/custom")
async def create_custom_engine(request: Request):
    """Create a user-defined engine from a spec dict."""
    spec_dict = await request.json()
    from workflow.engine_defs.schema import validate_engine_spec, _assess_safety
    from workflow.engine_runtime import load_engine_def, ENGINE_DEFS_DIR
    import yaml

    try:
        spec = validate_engine_spec(spec_dict)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

    if "safety" not in spec_dict:
        spec_dict["safety"] = _assess_safety(spec_dict.get("run_commands", []))

    custom_dir = ENGINE_DEFS_DIR / "custom"
    custom_dir.mkdir(parents=True, exist_ok=True)
    yaml_path = custom_dir / f"{spec.engine}.yaml"
    with open(yaml_path, "w") as f:
        yaml.safe_dump(spec_dict, f, default_flow_style=False, sort_keys=False)

    rt = load_engine_def(spec_dict)

    return {"status": "created", "engine": spec.engine, "safety": spec.safety}


# ====== WebSocket for real-time monitoring ======

@router.websocket("/{workflow_id}/monitor")
async def ws_workflow_monitor(websocket: WebSocket, workflow_id: str):
    """Stream real-time workflow execution status via V2 engine broadcast.

    Sends V1-compatible wire format:
    - {"type": "initial_state", "workflow_status": "...", "steps": [...]}
    - {"type": "step_status", "step_id": "...", "status": "..."}
    - {"type": "workflow_status", "status": "..."}
    """
    await websocket.accept()

    from catgo.routers.workflow_engine import _db as engine_db
    from catgo.workflow.engine.v1_monitor import (
        build_initial_state,
        translate_broadcast_message,
    )

    # Determine which DB to read initial state from
    if engine_db is not None:
        try:
            wf = engine_db.get_workflow(workflow_id)
            tasks = engine_db.get_all_tasks(workflow_id)
            initial_status = wf["status"]
        except KeyError:
            # Workflow not in V2 DB — try V1
            try:
                wf_v1 = get_workflow(workflow_id)
                initial_status = wf_v1.status.value if hasattr(wf_v1.status, 'value') else wf_v1.status
                tasks_v1 = list_steps(workflow_id)
                # Convert V1 steps to task-like dicts for build_initial_state
                tasks = [
                    {"id": s["id"], "task_type": s["node_type"],
                     "status": s.get("status", "pending").upper(),
                     "hpc_job_id": s.get("hpc_job_id"),
                     "error_message": s.get("error_message")}
                    for s in tasks_v1
                ]
            except Exception as e:
                await websocket.send_json({"type": "error", "message": str(e)})
                await websocket.close(code=1000)
                return
    else:
        await websocket.send_json({"type": "error", "message": "V2 engine not initialized"})
        await websocket.close(code=1000)
        return

    # Send initial state
    initial_msg = build_initial_state(initial_status, tasks)
    await websocket.send_json(initial_msg)

    # If workflow already finished and not being re-run, close
    if initial_status in ("completed", "failed"):
        await websocket.send_json({"type": "workflow_status", "status": initial_status})
        await websocket.close(code=1000, reason="Workflow already finished")
        return

    # Subscribe to V2 broadcast
    from catgo.workflow.engine.broadcast import add_listener, remove_listener
    queue = add_listener(workflow_id)

    try:
        while True:
            try:
                msg = await asyncio.wait_for(queue.get(), timeout=30.0)
                v1_msg = translate_broadcast_message(msg)
                await websocket.send_json(v1_msg)
                if v1_msg.get("type") == "workflow_status" and v1_msg.get("status") in ("completed", "failed"):
                    await websocket.close(code=1000, reason="Workflow finished")
                    return
            except asyncio.TimeoutError:
                try:
                    await websocket.send_json({"type": "ping"})
                except Exception:
                    return
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.debug("Monitor WS for %s closed with error", workflow_id, exc_info=True)
    finally:
        remove_listener(workflow_id, queue)


# ====== [2025-02] Database management ======

@router.get("/db/current")
def api_get_current_db():
    """Return the current active ASE database path."""
    from catgo.utils.ase_db import get_active_db_path
    path = get_active_db_path()
    return {"path": path, "name": Path(path).stem}


@router.post("/db/new")
def api_new_db(path: str):
    """Create a new empty ASE database at the given path and switch to it."""
    from catgo.utils.ase_db import set_active_db_path
    p = Path(path)
    if not p.suffix:
        p = p.with_suffix(".db")
    # Overwrite if exists (user chose this from save dialog)
    p.parent.mkdir(parents=True, exist_ok=True)
    if p.exists():
        p.unlink()
    # Create empty ASE DB by connecting (creates file)
    from ase.db import connect
    connect(str(p))
    set_active_db_path(str(p))
    return {"path": str(p), "name": p.stem}


@router.post("/db/open")
def api_open_db(path: str):
    """Open an existing ASE database file and switch to it."""
    from catgo.utils.ase_db import set_active_db_path
    p = Path(path)
    if not p.exists():
        # Bug 3 fix: try resolving relative path from project root
        # (backend cwd may be server/, but frontend sends paths relative to project root)
        project_root = Path(__file__).resolve().parent.parent.parent
        p = project_root / path
    if not p.exists():
        raise HTTPException(status_code=404, detail=f"File not found: {path}")
    set_active_db_path(str(p.resolve()))
    return {"path": str(p.resolve()), "name": p.stem}


@router.post("/db/save-as")
def api_save_as_db(path: str):
    """Copy the current ASE database to a new path and switch to it."""
    import shutil
    from catgo.utils.ase_db import get_active_db_path, set_active_db_path
    src = Path(get_active_db_path())
    dst = Path(path)
    if not dst.suffix:
        dst = dst.with_suffix(".db")
    dst.parent.mkdir(parents=True, exist_ok=True)
    try:
        if src.exists():
            shutil.copy2(str(src), str(dst))
        else:
            from ase.db import connect
            connect(str(dst))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save: {e}")
    set_active_db_path(str(dst))
    return {"path": str(dst), "name": dst.stem}


@router.get("/db/browse")
def api_browse_directory(dir: str = "~"):
    """[2025-02] Browse a directory on the server filesystem for the file picker.
    Returns folders and .db files sorted alphabetically."""
    import os
    target = Path(os.path.expanduser(dir)).resolve()
    if not target.is_dir():
        raise HTTPException(status_code=404, detail=f"Not a directory: {dir}")
    items = []
    try:
        for entry in sorted(target.iterdir(), key=lambda e: (not e.is_dir(), e.name.lower())):
            if entry.name.startswith("."):
                continue  # skip hidden files
            if entry.is_dir():
                items.append({"name": entry.name, "type": "dir", "path": str(entry)})
            elif entry.suffix.lower() in (".db", ".sqlite", ".sqlite3"):
                items.append({"name": entry.name, "type": "file", "path": str(entry)})
    except PermissionError:
        raise HTTPException(status_code=403, detail=f"Permission denied: {target}")
    return {"dir": str(target), "parent": str(target.parent), "items": items}


@router.get("/files/browse")
def api_browse_files(dir: str = "~"):
    """Browse a directory returning ALL files (not filtered to .db).
    Used by the sidebar filesystem browser."""
    import os
    target = Path(os.path.expanduser(dir)).resolve()
    if not target.is_dir():
        raise HTTPException(status_code=404, detail=f"Not a directory: {dir}")
    items = []
    try:
        for entry in sorted(target.iterdir(), key=lambda e: (not e.is_dir(), e.name.lower())):
            if entry.name.startswith("."):
                continue
            if entry.is_dir():
                items.append({"name": entry.name, "type": "dir", "path": str(entry)})
            else:
                items.append({"name": entry.name, "type": "file", "path": str(entry)})
    except PermissionError:
        raise HTTPException(status_code=403, detail=f"Permission denied: {target}")
    return {"dir": str(target), "parent": str(target.parent), "items": items}


@router.get("/files/read")
def api_read_file(path: str):
    """Read a text file's content. Used to load structure files from the sidebar browser."""
    import os
    target = Path(os.path.expanduser(path)).resolve()
    if not target.is_file():
        raise HTTPException(status_code=404, detail=f"Not a file: {path}")
    try:
        content = target.read_text(encoding="utf-8")
    except PermissionError:
        raise HTTPException(status_code=403, detail=f"Permission denied: {target}")
    except UnicodeDecodeError:
        raise HTTPException(status_code=400, detail=f"Not a text file: {target.name}")
    return {"path": str(target), "name": target.name, "content": content}


@router.post("/files/write")
def api_write_file(body: dict = Body(...)):
    """Write text content to a file. Used for exporting structures from the viewer."""
    import os
    path = body.get("path", "")
    content = body.get("content", "")
    if not path:
        raise HTTPException(status_code=400, detail="path is required")
    target = Path(os.path.expanduser(path)).resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        target.write_text(content, encoding="utf-8")
    except PermissionError:
        raise HTTPException(status_code=403, detail=f"Permission denied: {target}")
    return {"path": str(target), "name": target.name}


@router.post("/files/export-structure")
def api_export_structure(body: dict = Body(...)):
    """Convert a pymatgen structure JSON to a file format and write to disk.
    Body: { structure: {...}, path: str, format?: 'cif'|'poscar'|'xyz'|'extxyz'|'mol2'|'pdb' }"""
    import os
    structure_dict = body.get("structure")
    path = body.get("path", "")
    fmt = body.get("format", "").lower()
    if not structure_dict or not path:
        raise HTTPException(status_code=400, detail="structure and path are required")
    target = Path(os.path.expanduser(path)).resolve()
    if not fmt:
        ext = target.suffix.lower()
        fmt = {".cif": "cif", ".poscar": "poscar", ".vasp": "poscar",
               ".xyz": "xyz", ".extxyz": "extxyz", ".mol2": "mol2",
               ".pdb": "pdb"}.get(ext, "cif")
    logger.info(f"[export-structure] path={target}, fmt={fmt}")
    try:
        atoms = dict_to_ase(structure_dict)
        content, fmt = ase_serialize(atoms, fmt)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        logger.info(f"[export-structure] written {len(content)} chars to {target}")
    except PermissionError:
        raise HTTPException(status_code=403, detail=f"Permission denied: {target}")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception(f"[export-structure] failed: {e}")
        raise HTTPException(status_code=500, detail=f"Export failed: {e}")
    return {"path": str(target), "name": target.name, "format": fmt}


@router.post("/files/serialize-structure")
def api_serialize_structure(body: dict = Body(...)):
    """Convert a pymatgen structure JSON to text content (no disk write).
    Body: { structure: {...}, format?: 'cif'|'poscar'|'xyz'|'extxyz'|'mol2'|'pdb' }
    Returns: { content: str, format: str }"""
    structure_dict = body.get("structure")
    fmt = body.get("format", "cif").lower()
    if not structure_dict:
        raise HTTPException(status_code=400, detail="structure is required")
    logger.info(f"[serialize-structure] fmt={fmt}, sites={len(structure_dict.get('sites', []))}")
    try:
        atoms = dict_to_ase(structure_dict)
        content, fmt = ase_serialize(atoms, fmt)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception(f"[serialize-structure] failed: {e}")
        raise HTTPException(status_code=500, detail=f"Serialize failed: {e}")
    return {"content": content, "format": fmt}


# ====== OLD pymatgen-based serialization (replaced 2026-03-02) ======
# Kept for reference/rollback. Remove after confirming ASE version is stable.
#
# Problems with pymatgen approach:
# 1. Species with oxidation_state:0 from frontend -> pymatgen Species("C", 0) -> "C0+" in output
# 2. _strip_oxidation_states loses site_properties during reconstruction
# 3. Molecule.from_dict fails on some frontend dicts, needs manual fallback
# 4. _serialize_extxyz uses site.species_string which includes oxidation states
# 5. No selective_dynamics -> POSCAR support
#
# def _strip_oxidation_states(struct):
#     """Remove oxidation states from all species to prevent 'C0+' in output."""
#     from pymatgen.core import Structure, Molecule, Element
#     new_species = [Element(site.specie.symbol) if hasattr(site.specie, 'symbol') else site.specie for site in struct]
#     if isinstance(struct, Structure):
#         return Structure(struct.lattice, new_species, [site.frac_coords for site in struct],
#                          site_properties={k: v for k, v in struct.site_properties.items()})
#     else:
#         return Molecule(new_species, [site.coords for site in struct],
#                         site_properties={k: v for k, v in struct.site_properties.items()})
#
# def _load_structure_or_molecule(structure_dict: dict):
#     from pymatgen.core import Structure, Molecule
#     has_lattice = "lattice" in structure_dict
#     cls_hint = structure_dict.get("@class", "")
#     if has_lattice and cls_hint != "Molecule":
#         return _strip_oxidation_states(Structure.from_dict(structure_dict))
#     try:
#         return _strip_oxidation_states(Molecule.from_dict(structure_dict))
#     except Exception:
#         species, coords = [], []
#         for site in structure_dict.get("sites", []):
#             sp = site.get("species", site.get("label", "X"))
#             if isinstance(sp, list): sp = sp[0].get("element", "X") if sp else "X"
#             species.append(sp); coords.append(site.get("xyz", [0, 0, 0]))
#         return Molecule(species, coords)
#
# def _serialize_extxyz(struct) -> str:
#     import numpy as np
#     lat = struct.lattice.matrix
#     lines = [str(len(struct))]
#     lat_str = " ".join(f"{v:.8f}" for row in lat for v in row)
#     lines.append(f'Lattice="{lat_str}" Properties=species:S:1:pos:R:3 pbc="T T T"')
#     for site in struct:
#         el = site.species_string  # BUG: includes oxidation state e.g. "C0+"
#         x, y, z = site.coords
#         lines.append(f"{el} {x:.8f} {y:.8f} {z:.8f}")
#     return "\n".join(lines)


# ====== Local File Operations ======


@router.post("/files/mkdir")
def api_files_mkdir(body: dict = Body(...)):
    """Create a directory on the local filesystem."""
    path = validate_local_path(body.get("path", ""))
    try:
        path.mkdir(parents=True, exist_ok=True)
        return {"success": True, "message": f"Created {path}"}
    except PermissionError:
        raise HTTPException(status_code=403, detail=f"Permission denied: {path}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/files/delete")
def api_files_delete(body: dict = Body(...)):
    """Delete a file or directory on the local filesystem."""
    import shutil
    path = validate_local_path(body.get("path", ""))
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"Not found: {path}")
    try:
        if path.is_dir():
            shutil.rmtree(path)
        else:
            path.unlink()
        return {"success": True, "message": f"Deleted {path}"}
    except PermissionError:
        raise HTTPException(status_code=403, detail=f"Permission denied: {path}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/files/rename")
def api_files_rename(body: dict = Body(...)):
    """Rename a file or directory on the local filesystem."""
    import os
    old_path = Path(os.path.expanduser(body.get("old_path", ""))).resolve()
    new_path = Path(os.path.expanduser(body.get("new_path", ""))).resolve()
    if not old_path.exists():
        raise HTTPException(status_code=404, detail=f"Not found: {old_path}")
    try:
        old_path.rename(new_path)
        return {"success": True, "message": f"Renamed to {new_path.name}"}
    except PermissionError:
        raise HTTPException(status_code=403, detail=f"Permission denied")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/files/copy")
def api_files_copy(body: dict = Body(...)):
    """Copy a file or directory on the local filesystem."""
    import os, shutil
    src = Path(os.path.expanduser(body.get("source", ""))).resolve()
    dst = Path(os.path.expanduser(body.get("destination", ""))).resolve()
    if not src.exists():
        raise HTTPException(status_code=404, detail=f"Not found: {src}")
    try:
        if src.is_dir():
            shutil.copytree(src, dst)
        else:
            shutil.copy2(src, dst)
        return {"success": True, "message": f"Copied to {dst}"}
    except PermissionError:
        raise HTTPException(status_code=403, detail=f"Permission denied")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/files/move")
def api_files_move(body: dict = Body(...)):
    """Move a file or directory on the local filesystem."""
    import os, shutil
    src = Path(os.path.expanduser(body.get("source", ""))).resolve()
    dst = Path(os.path.expanduser(body.get("destination", ""))).resolve()
    if not src.exists():
        raise HTTPException(status_code=404, detail=f"Not found: {src}")
    try:
        shutil.move(str(src), str(dst))
        return {"success": True, "message": f"Moved to {dst}"}
    except PermissionError:
        raise HTTPException(status_code=403, detail=f"Permission denied")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ====== Project management ======

@router.post("/project/", status_code=201)
def api_create_project(name: str, description: str = "", parent_id: str = None):
    """Create a new project (optionally nested under parent_id)."""
    try:
        return create_project(name, description, parent_id=parent_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/project/")
def api_list_projects():
    """List all projects."""
    return list_projects()


@router.get("/project/{project_id}")
def api_get_project(project_id: str):
    """Get project details."""
    try:
        return get_project(project_id)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.put("/project/{project_id}")
def api_update_project(
    project_id: str,
    name: Optional[str] = Query(None),
    description: Optional[str] = Query(None),
    parent_id: Optional[str] = Query(None),
    unset_parent: bool = Query(False),
):
    """Update a project. Use unset_parent=true to move to root level."""
    data = {}
    if name is not None:
        data["name"] = name
    if description is not None:
        data["description"] = description
    if unset_parent:
        data["parent_id"] = None
    elif parent_id is not None:
        data["parent_id"] = parent_id
    try:
        return update_project(project_id, data)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.delete("/project/{project_id}", status_code=204)
def api_delete_project(project_id: str):
    """Delete a project (workflows are kept but unassigned)."""
    try:
        delete_project(project_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/{workflow_id}/project/{project_id}")
def api_assign_workflow_to_project(workflow_id: str, project_id: str):
    """Assign a workflow to a project."""
    try:
        assign_workflow_to_project(workflow_id, project_id)
        return {"status": "assigned", "workflow_id": workflow_id, "project_id": project_id}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/{workflow_id}/project")
def api_unassign_workflow_from_project(workflow_id: str):
    """Remove a workflow from its project."""
    try:
        assign_workflow_to_project(workflow_id, None)
        return {"status": "unassigned", "workflow_id": workflow_id}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/preview-input")
def api_preview_input(body: dict = Body(...)):
    """Generate a preview of input files for ORCA, CP2K, or LAMMPS nodes.

    This is used by the frontend input file editor to show a generated preview
    that users can then customize.
    """
    software = body.get("software", "")
    node_type = body.get("node_type", "")
    params = body.get("params", {})
    structure_json = body.get("structure_json")
    structure_product_json = body.get("structure_product_json")

    try:
        if software == "orca":
            content = _preview_orca_input(node_type, params, structure_json, structure_product_json)
        elif software == "cp2k":
            content = _preview_cp2k_input(node_type, params, structure_json)
        elif software == "lammps":
            content = _preview_lammps_input(node_type, params, structure_json)
        else:
            raise HTTPException(status_code=400, detail=f"Unknown software: {software}")
        # Safety net: never return whitespace-only content so the editor is never blank.
        if not content or not content.strip():
            content = (
                f"# Preview unavailable for {node_type} (software: {software})\n"
                f"# The generator returned an empty script.\n"
                f"# You can edit this file manually and save it to the node.\n"
            )
        return {"content": content}
    except HTTPException:
        raise
    except Exception as e:
        logger.warning("preview-input failed for %s/%s: %s", software, node_type, e)
        return {"content": f"# Error generating preview: {e}\n# You can edit this file manually.\n"}


def _parse_structure_json(raw: str | dict | None) -> dict | None:
    """Parse a structure string that may be pymatgen JSON, raw POSCAR, or raw XYZ.

    The structure_json column in task_results can contain any of these formats
    depending on which code path produced it.  All ORCA preview handlers need
    to accept all three.
    """
    if not raw:
        return None
    if isinstance(raw, dict):
        return raw
    # 1. Try JSON (pymatgen dict)
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            return parsed
    except (json.JSONDecodeError, ValueError):
        pass
    # 2. Try POSCAR text → use pymatgen Structure.from_str
    #    POSCAR coordinate lines have only 3 numbers (no element prefix),
    #    so the XYZ scanner below can't parse them.
    try:
        from pymatgen.core import Structure as _PmgStructure
        struct = _PmgStructure.from_str(raw, fmt="poscar")
        if struct and len(struct.sites) > 0:
            return struct.as_dict()
    except Exception as e:
        logger.debug("_parse_structure_json: POSCAR parse failed: %s", e)
    # 3. Try XYZ text → build a minimal pymatgen-compatible dict
    #    Skip standard XYZ header lines (atom count + comment) by finding
    #    the first line that matches "Element x y z" pattern.
    try:
        lines = raw.strip().splitlines()
        sites: list[dict] = []
        for line in lines:
            parts = line.split()
            if len(parts) < 4:
                continue
            # Element symbol must start with a letter and be 1-3 chars
            sym = parts[0]
            if not sym[0].isalpha() or len(sym) > 3:
                continue
            try:
                x, y, z = float(parts[1]), float(parts[2]), float(parts[3])
                sites.append({
                    "species": [{"element": sym, "occu": 1}],
                    "xyz": [x, y, z],
                })
            except ValueError:
                continue
        if sites:
            return {"sites": sites}
    except Exception as e:
        logger.debug("_parse_structure_json: XYZ parse failed: %s", e)
    logger.warning("_parse_structure_json: could not parse structure (%d chars)", len(raw))
    return None


def _preview_orca_input(node_type: str, params: dict, structure_json: str | None, structure_product_json: str | None = None) -> str:
    """Generate ORCA input file preview text."""
    from workflow.node_sets import _resolve_software
    resolved_type, _ = _resolve_software(node_type, {**params, "software": "orca"})

    # Handle specialized ORCA node types via their dedicated generators
    if resolved_type == "orca_irc":
        import types
        from utils.orca_input import generate_orca_irc_inputs
        req = types.SimpleNamespace(
            structure=_parse_structure_json(structure_json),
            method=params.get("method", "r2SCAN-3c"),
            basis=params.get("basis_set") or params.get("basis") or "6-31G",
            charge=params.get("charge", 0),
            multiplicity=params.get("multiplicity", 1),
            max_iterations=params.get(
                "max_iterations", params.get("max_irc_iterations", 30)
            ),
            num_cores=params.get("num_cores", 4),
            max_core_mb=params.get("max_core_mb", 4000),
            wavefunction=params.get("wavefunction", None),
            uno=params.get("uno", False),
            uco=params.get("uco", False),
            dispersion=params.get("dispersion", None),
            three_body_dispersion=params.get("three_body_dispersion", False),
            grid=params.get("grid", None),
            external_ts_file=None,
        )
        return generate_orca_irc_inputs(req).get("inp", "")
    elif resolved_type == "orca_uvvis":
        import types
        from utils.orca_input import generate_orca_uvvis_inputs
        struct_data = _parse_structure_json(structure_json)
        req = types.SimpleNamespace(
            structure=struct_data,
            xyzfile_name=None if struct_data else "structure.xyz",
            method=params.get("method", "CAM-B3LYP"),
            basis_set=params.get("basis", params.get("basis_set", "def2-TZVP")),
            charge=params.get("charge", 0),
            multiplicity=params.get("multiplicity", 1),
            calc_type=params.get("calc_type", "tddft"),
            nroots=params.get("nroots", 10),
            triplets=params.get("triplets", False),
            tda=params.get("tda", True),
            donto=params.get("donto", False),
            solvation=params.get("solvation", "none"),
            solvent=params.get("solvent", "water"),
            aux_basis=params.get("aux_basis", "def2-TZVP/C"),
            num_cores=params.get("num_cores", 4),
            max_core_mb=params.get("max_core_mb", 4000),
            wavefunction=params.get("wavefunction", None),
            dispersion=params.get("dispersion", None),
            three_body_dispersion=params.get("three_body_dispersion", False),
        )
        return generate_orca_uvvis_inputs(req).get("inp", "")
    elif resolved_type == "orca_neb_ts":
        import types
        from utils.orca_input import generate_orca_neb_inputs

        req = types.SimpleNamespace(
            structure_reactant=_parse_structure_json(structure_json),
            structure_product=_parse_structure_json(structure_product_json),
            method=params.get("method", "r2SCAN-3c"),
            basis=params.get("basis", "6-31G"),
            charge=params.get("charge", 0),
            multiplicity=params.get("multiplicity", 1),
            nimages=params.get("nimages", 8),
            ts_opt=params.get("ts_opt", True),
            neb_cycles=params.get("neb_cycles", 100),
            interpolation=params.get("interpolation", "IDPP"),
            spring_k=params.get("spring_k", 0.1),
            num_cores=params.get("num_cores", 4),
            max_core_mb=params.get("max_core_mb", 4000),
            wavefunction=params.get("wavefunction", None),
            uno=params.get("uno", False),
            uco=params.get("uco", False),
            dispersion=params.get("dispersion", None),
            three_body_dispersion=params.get("three_body_dispersion", False),
            grid=params.get("grid", None),
        )
        return generate_orca_neb_inputs(req).get("inp", "")

    # opt/sp/freq — delegate to the same writer the executor uses so the preview
    # is byte-equal to what gets written to disk. Mirrors how IRC/UV-Vis/NEB-TS
    # previews already work above.
    import types
    from utils.orca_input import generate_orca_inputs

    struct_data = _parse_structure_json(structure_json) if structure_json else None

    # Map node_type → opt_type the same way engines/orca.py does.
    node_to_opt_type = {
        "orca_sp": "SP", "single_point": "SP",
        "orca_freq": "Freq", "freq": "Freq",
        "orca_opt": "MinSteps", "geo_opt": "MinSteps",
    }
    opt_type = params.get(
        "opt_type",
        node_to_opt_type.get(resolved_type, node_to_opt_type.get(node_type, "MinSteps")),
    )

    req = types.SimpleNamespace(
        structure=struct_data,
        xyzfile_name=None if struct_data else "structure.xyz",
        method=params.get("method", "B3LYP"),
        basis_set=params.get("basis", params.get("basis_set", "def2-SVP")),
        charge=params.get("charge", 0),
        multiplicity=params.get("multiplicity", 1),
        wavefunction=params.get("wavefunction", None),
        opt_type=opt_type,
        opt_convergence=params.get("opt_convergence") or None,
        cartesian_opt=params.get("cartesian_opt", False),
        uno=params.get("uno", False),
        uco=params.get("uco", False),
        dispersion=params.get("dispersion", None),
        three_body_dispersion=params.get("three_body_dispersion", False),
        grid=params.get("grid", None),
        num_cores=params.get("num_cores", 4),
        max_core_mb=params.get("max_core_mb", 4000),
        max_iterations=params.get("max_iterations", params.get("max_opt_cycles", 100)),
    )
    return generate_orca_inputs(req).get("inp", "")


def _preview_cp2k_input(node_type: str, params: dict, structure_json: str | None) -> str:
    """Generate CP2K input file preview by running the CP2K generator in-memory."""
    if not structure_json:
        return (
            "# CP2K input preview\n"
            "# No structure available — import a structure first.\n"
            "# You can also edit this file manually after importing.\n"
        )

    # Use the actual CP2K generator to produce the real input
    try:
        from pymatgen.core import Structure

        try:
            struct = Structure.from_dict(json.loads(structure_json) if isinstance(structure_json, str) else structure_json)
        except Exception:
            struct = Structure.from_str(structure_json, fmt="poscar")

        from workflow.node_sets import _resolve_software
        resolved_type, _ = _resolve_software(node_type, {**params, "software": "cp2k"})

        # Import the actual text generation (reuse the function body)
        # Since generate_cp2k_inputs is async and writes to HPC, we inline the text generation
        run_type_map = {
            "cp2k_geopt": "GEO_OPT", "cp2k_static": "ENERGY",
            "cp2k_cellopt": "CELL_OPT", "cp2k_md": "MD",
            "cp2k_freq": "VIBRATIONAL_ANALYSIS",
            "geo_opt": "GEO_OPT", "single_point": "ENERGY",
            "cell_opt": "CELL_OPT", "md": "MD", "freq": "VIBRATIONAL_ANALYSIS",
        }
        run_type = params.get("run_type", run_type_map.get(resolved_type, run_type_map.get(node_type, "ENERGY")))

        functional = params.get("functional", "PBE")
        basis_set = params.get("basis_set", "DZVP-MOLOPT-SR-GTH")
        cutoff = int(params.get("cutoff", 350))

        elements = sorted(set(str(s) for s in struct.species))
        lattice = struct.lattice

        # Build a basic CP2K input as preview
        text_lines = [
            f"# CP2K input generated by CatGO workflow editor",
            f"# Functional: {functional}  Basis: {basis_set}  Cutoff: {cutoff}",
            f"",
            f"&GLOBAL",
            f"  PROJECT project",
            f"  RUN_TYPE {run_type}",
            f"  PRINT_LEVEL LOW",
            f"&END GLOBAL",
            f"",
            f"&FORCE_EVAL",
            f"  METHOD Quickstep",
            f"  &DFT",
            f"    BASIS_SET_FILE_NAME BASIS_MOLOPT",
            f"    POTENTIAL_FILE_NAME GTH_POTENTIALS",
            f"    &MGRID",
            f"      CUTOFF {cutoff}",
            f"      REL_CUTOFF {int(params.get('rel_cutoff', 50))}",
            f"      NGRIDS 4",
            f"    &END MGRID",
            f"    &QS",
            f"      EPS_DEFAULT 1.0E-12",
            f"    &END QS",
            f"    &SCF",
            f"      EPS_SCF {float(params.get('eps_scf', 1e-6)):.1E}",
            f"      MAX_SCF {int(params.get('max_scf', 25))}",
            f"      SCF_GUESS ATOMIC",
            f"    &END SCF",
            f"    &XC",
            f"      &XC_FUNCTIONAL {functional.upper()}",
            f"      &END XC_FUNCTIONAL",
            f"    &END XC",
            f"  &END DFT",
            f"  &SUBSYS",
            f"    &CELL",
            f"      A {lattice.matrix[0][0]:.10f} {lattice.matrix[0][1]:.10f} {lattice.matrix[0][2]:.10f}",
            f"      B {lattice.matrix[1][0]:.10f} {lattice.matrix[1][1]:.10f} {lattice.matrix[1][2]:.10f}",
            f"      C {lattice.matrix[2][0]:.10f} {lattice.matrix[2][1]:.10f} {lattice.matrix[2][2]:.10f}",
            f"      PERIODIC XYZ",
            f"    &END CELL",
            f"    &COORD",
        ]
        for site in struct:
            x, y, z = site.coords
            text_lines.append(f"      {str(site.specie):>4s}  {x:.10f}  {y:.10f}  {z:.10f}")
        text_lines.append(f"    &END COORD")
        for el in elements:
            from workflow.engines.cp2k import _cp2k_valence_electrons
            func_upper = functional.upper()
            pot_prefix = "GTH-PBE" if func_upper in ("PBE", "PBE0", "REVPBE", "PBESOL", "RPBE", "HSE06", "SCAN", "R2SCAN") else "GTH-BLYP" if func_upper in ("BLYP", "B3LYP", "BP86") else "GTH-PBE"
            text_lines.append(f"    &KIND {el}")
            text_lines.append(f"      BASIS_SET {basis_set}")
            text_lines.append(f"      POTENTIAL {pot_prefix}-q{_cp2k_valence_electrons(el)}")
            text_lines.append(f"    &END KIND")
        text_lines.extend([
            f"  &END SUBSYS",
            f"&END FORCE_EVAL",
            f"",
        ])

        if run_type in ("GEO_OPT", "CELL_OPT"):
            text_lines.extend([
                f"&MOTION",
                f"  &{'GEO_OPT' if run_type == 'GEO_OPT' else 'CELL_OPT'}",
                f"    OPTIMIZER BFGS",
                f"    MAX_ITER 200",
                f"    MAX_FORCE 4.50E-04",
                f"  &END {'GEO_OPT' if run_type == 'GEO_OPT' else 'CELL_OPT'}",
                f"&END MOTION",
                f"",
            ])

        return "\n".join(text_lines)
    except Exception as e:
        return f"# Error generating CP2K preview: {e}\n# Edit this file manually.\n"


def _preview_lammps_input(node_type: str, params: dict, _structure_json: str | None) -> str:
    """Generate LAMMPS input script preview text.

    Supports the new unified potential_type system:
    - forcefield: GAFF2/OPLS-AA (auto-generates bonds/angles/charges)
    - lj: Lennard-Jones
    - charmm: CHARMM with Coulomb long-range
    - buck: Buckingham
    - eam: EAM alloy for metals
    - tersoff: Tersoff for covalent materials
    - custom: Manual pair_style/pair_coeff
    """
    from routers.forcefield_utils import get_ff_settings, _build_ff_init_lines

    potential_type = params.get("potential_type", "lj")
    # md_minimize nodes don't set potential_type — route to forcefield or custom path
    if node_type in ("md_minimize", "lammps_minimize") and "potential_type" not in params:
        potential_type = "forcefield" if params.get("use_forcefield") else "custom"
    ensemble = params.get("ensemble", "nvt")
    temperature = params.get("temperature", 300)
    pressure = params.get("pressure", 1.0)
    timestep = params.get("timestep", 0.001)
    steps = params.get("steps", 10000)
    dump_freq = params.get("dump_freq", 100)
    thermo_freq = params.get("thermo_freq", dump_freq)
    units = params.get("units", "metal")
    atom_style = params.get("atom_style", "atomic")

    lines = [
        f"# LAMMPS input script generated by CatGO workflow editor",
        f"# Node type: {node_type}",
        f"# Potential type: {potential_type}",
        f"",
    ]

    # Helper to add optional molecular styles
    def add_molecular_styles(lines_list: list[str]) -> None:
        """Add bond/angle/dihedral/improper styles if specified in params."""
        bond_style = params.get("bond_style")
        bond_coeff = params.get("bond_coeff")
        angle_style = params.get("angle_style")
        angle_coeff = params.get("angle_coeff")
        dihedral_style = params.get("dihedral_style")
        dihedral_coeff = params.get("dihedral_coeff")
        improper_style = params.get("improper_style")
        improper_coeff = params.get("improper_coeff")

        if bond_style:
            lines_list.append(f"bond_style      {bond_style}")
        if bond_coeff:
            lines_list.append(f"bond_coeff      {bond_coeff}")
        if angle_style:
            lines_list.append(f"angle_style     {angle_style}")
        if angle_coeff:
            lines_list.append(f"angle_coeff     {angle_coeff}")
        if dihedral_style:
            lines_list.append(f"dihedral_style  {dihedral_style}")
        if dihedral_coeff:
            lines_list.append(f"dihedral_coeff  {dihedral_coeff}")
        if improper_style:
            lines_list.append(f"improper_style  {improper_style}")
        if improper_coeff:
            lines_list.append(f"improper_coeff  {improper_coeff}")

    # ═══════════════════════════════════════════════════════════════════════════════
    # Forcefield path — use canonical FF settings
    # ═══════════════════════════════════════════════════════════════════════════════
    if potential_type == "forcefield":
        force_field = params.get("forcefield", "gaff2")  # NOTE: key is "forcefield", not "force_field"
        charge_method = params.get("charge_method", "gasteiger")

        # Get canonical FF settings
        ffs = get_ff_settings(force_field)

        # Add units/atom_style/boundary at the beginning
        lines.extend([
            f"units           {units}",
            f"atom_style      {atom_style}",
            f"boundary        p p p",
            f"",
        ])

        # Add FF-specific styles in correct LAMMPS order:
        # bond/angle/dihedral/improper → pair → pair_modify → special_bonds → kspace
        lines.extend([
            f"bond_style      {ffs['bond_style']}",
            f"angle_style     {ffs['angle_style']}",
            f"dihedral_style  {ffs['dihedral_style']}",
        ])

        if ffs.get("improper_style"):
            lines.append(f"improper_style  {ffs['improper_style']}")

        lines.extend([
            f"",
            f"pair_style      {ffs['pair_style']}",
        ])

        if ffs.get("pair_modify"):
            lines.append(f"pair_modify     {ffs['pair_modify']}")

        lines.append(f"special_bonds   {ffs['special_bonds']}")

        if ffs.get("kspace_style"):
            lines.append(f"kspace_style    {ffs['kspace_style']}")

        # Add manual overrides if user specified them
        add_molecular_styles(lines)

    # ═══════════════════════════════════════════════════════════════════════════════
    # Non-forcefield paths — emit in correct LAMMPS order
    # ═══════════════════════════════════════════════════════════════════════════════
    else:
        lines.extend([
            f"units           {units}",
            f"atom_style      {atom_style}",
            f"boundary        p p p",
            f"",
        ])

        # 1. Molecular interaction styles (BEFORE pair_style)
        add_molecular_styles(lines)

        # 2. Pair styles
        pair_style = None
        pair_coeff = None
        pair_modify = None
        special_bonds = None
        kspace_style = None

        if potential_type == "lj":
            cutoff = params.get("lj_cutoff", 2.5)
            eps = params.get("lj_epsilon", 0.01)
            sig = params.get("lj_sigma", 2.5)
            pair_style = f"lj/cut {cutoff}"
            pair_coeff = f"* * {eps} {sig}"

        elif potential_type == "charmm":
            inner = params.get("charmm_inner", 10.0)
            outer = params.get("charmm_outer", 10.0)
            pair_style = f"lj/charmm/coul/long {inner} {outer}"
            pair_coeff = "* * 0.0 0.0 0.0"
            special_bonds = "lj 0.0 0.0 0.0"  # No 1-4 scaling without force field
            kspace_style = "pppm 0.0001"

        elif potential_type == "buck":
            cutoff = params.get("buck_cutoff", 10.0)
            A = params.get("buck_A", 1000.0)
            rho = params.get("buck_rho", 0.3)
            C = params.get("buck_C", 0.0)
            pair_style = f"buck {cutoff}"
            pair_coeff = f"* * {A} {rho} {C}"

        elif potential_type == "eam":
            eam_file = params.get("eam_file", "")
            element = params.get("eam_element", "Cu")
            if eam_file:
                pair_style = "eam/alloy"
                pair_coeff = f"* * {eam_file}"
            else:
                pair_style = "eam/alloy"
                pair_coeff = f"* * {element}"

        elif potential_type == "tersoff":
            tersoff_file = params.get("tersoff_file", "")
            if not tersoff_file:
                lines.append(f"# WARNING: Tersoff potential requires a potential file")
                pair_style = "tersoff"
                pair_coeff = "* * path/to/potential.file"
            else:
                pair_style = "tersoff"
                pair_coeff = f"* * {tersoff_file}"

        elif potential_type == "custom":
            pair_style = params.get("pair_style", "lj/cut 2.5")
            pair_coeff = params.get("pair_coeff", "* * 1.0 1.0")
            pair_modify = params.get("pair_modify")
            special_bonds = params.get("special_bonds")

        else:
            # Fallback for old-style direct pair_style/pair_coeff
            pair_style = params.get("pair_style", "lj/cut 2.5")
            pair_coeff = params.get("pair_coeff", "* * 1.0 1.0")

        # Emit pair commands in correct order
        if pair_style:
            lines.append(f"pair_style      {pair_style}")
        if pair_coeff:
            lines.append(f"pair_coeff      {pair_coeff}")
        if pair_modify:
            lines.append(f"pair_modify     {pair_modify}")
        if special_bonds:
            lines.append(f"special_bonds   {special_bonds}")
        if kspace_style:
            lines.append(f"kspace_style    {kspace_style}")

    # ═══════════════════════════════════════════════════════════════════════════════
    # Common setup (read_data, neighbor)
    # ═══════════════════════════════════════════════════════════════════════════════
    lines.extend([
        f"",
        f"read_data       system.data",
        f"",
        f"neighbor        2.0 bin",
        f"neigh_modify    delay 0 every 1 check yes",
        f"",
    ])

    is_minimize = ensemble.startswith("minimize_") or node_type in ("md_minimize", "lammps_minimize")

    if is_minimize:
        # ═══════════════════════════════════════════════════════════════════════
        # Energy minimization path
        # ═══════════════════════════════════════════════════════════════════════
        if node_type in ("md_minimize", "lammps_minimize"):
            min_style = params.get("min_style", "cg")
            etol = params.get("etol", 1.0e-6)
            ftol = params.get("ftol", 1.0e-6)
            maxiter = int(params.get("maxiter", 10000))
            maxeval = int(params.get("maxeval", 100000))
        else:
            min_style = "sd" if ensemble == "minimize_sd" else "cg"
            etol = params.get("minimize_etol", 1.0e-6)
            ftol = params.get("minimize_ftol", 1.0e-8)
            maxiter = int(params.get("minimize_maxiter", 10000))
            maxeval = int(params.get("minimize_maxeval", 100000))

        lines.extend([
            f"thermo          {thermo_freq}",
            f"thermo_style    custom step pe ke etotal press vol density",
            f"",
            f"min_style       {min_style}",
            f"minimize        {etol} {ftol} {maxiter} {maxeval}",
            f"",
            f"write_data      system_minimized_{min_style}.data",
        ])
    else:
        # ═══════════════════════════════════════════════════════════════════════
        # Molecular dynamics path (NVE / NVT / NPT)
        # ═══════════════════════════════════════════════════════════════════════
        lines.extend([
            f"timestep        {timestep}",
            f"velocity        all create {temperature} 12345 dist gaussian",
            f"",
        ])

        if ensemble == "nve":
            fix_cmd = "fix             1 all nve"
            thermo_style = "step temp pe ke etotal press vol density"
        elif ensemble == "npt":
            fix_cmd = f"fix             1 all npt temp {temperature} {temperature} 100.0 iso {pressure} {pressure} 1000.0"
            thermo_style = "step temp pe ke etotal press vol density lx ly lz"
        else:  # nvt (default)
            fix_cmd = f"fix             1 all nvt temp {temperature} {temperature} 100.0"
            thermo_style = "step temp pe ke etotal press vol density"

        lines.extend([
            fix_cmd,
            f"",
            f"thermo          {thermo_freq}",
            f"thermo_style    custom {thermo_style}",
            f"dump            1 all custom {dump_freq} trajectory.dump id type x y z vx vy vz",
            f"",
            f"run             {steps}",
            f"",
            f"write_data      system_final.data",
        ])

    return "\n".join(lines)

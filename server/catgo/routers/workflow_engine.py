"""REST API for the state-machine workflow engine.

Endpoints:
  GET  /api/engine/workflows              — list all workflows
  GET  /api/engine/workflows/{id}         — get workflow + summary
  GET  /api/engine/workflows/{id}/dag     — get DAG (tasks + links)
  POST /api/engine/workflows/{id}/submit  — start execution
  POST /api/engine/workflows/{id}/pause   — pause workflow
  POST /api/engine/workflows/{id}/resume  — resume workflow
  POST /api/engine/workflows/{id}/reset   — reset all tasks
"""

from __future__ import annotations
import asyncio
import json
from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel
from catgo.workflow.db import WorkflowDB
from catgo.workflow import service
from catgo.workflow.engine.broadcast import add_listener, remove_listener
from catgo.workflow.graph_converter import convert_graph_json

router = APIRouter(prefix="/api/engine/workflows", tags=["workflow-engine"])

_db: WorkflowDB | None = None


def set_db(db: WorkflowDB) -> None:
    global _db
    _db = db


def _get_db() -> WorkflowDB:
    if _db is None:
        raise RuntimeError("Workflow DB not initialized")
    return _db


def _summarize_workflow(db: WorkflowDB, wf: dict) -> dict:
    tasks = db.get_all_tasks(wf["id"])
    status_counts: dict[str, int] = {}
    for t in tasks:
        s = t["status"]
        status_counts[s] = status_counts.get(s, 0) + 1
    return {
        "id": wf["id"],
        "name": wf["name"],
        "status": wf["status"],
        "created_at": wf.get("created_at"),
        "updated_at": wf.get("updated_at"),
        "task_count": len(tasks),
        "status_counts": status_counts,
        "project_id": wf.get("project_id"),
    }


@router.get("")
def list_workflows():
    db = _get_db()
    workflows = db.list_workflows()
    return [_summarize_workflow(db, wf) for wf in workflows]


@router.get("/by-project/{project_id}")
def list_workflows_for_project(project_id: str):
    """List engine workflows assigned to a specific project."""
    db = _get_db()
    workflows = db.list_workflows_for_project(project_id)
    return [_summarize_workflow(db, wf) for wf in workflows]


@router.get("/{workflow_id}")
def get_workflow(workflow_id: str):
    db = _get_db()
    try:
        wf = db.get_workflow(workflow_id)
    except KeyError:
        raise HTTPException(404, f"Workflow {workflow_id} not found")
    tasks = db.get_all_tasks(workflow_id)
    return {"workflow": wf, "tasks": tasks, "task_count": len(tasks)}


@router.get("/{workflow_id}/dag")
def get_dag(workflow_id: str):
    db = _get_db()
    try:
        db.get_workflow(workflow_id)
    except KeyError:
        raise HTTPException(404, f"Workflow {workflow_id} not found")
    return db.get_dag(workflow_id)


def _ensure_exists(db: WorkflowDB, workflow_id: str):
    try:
        db.get_workflow(workflow_id)
    except KeyError:
        raise HTTPException(404, f"Workflow {workflow_id} not found")


@router.post("/{workflow_id}/submit")
def submit(workflow_id: str):
    db = _get_db()
    _ensure_exists(db, workflow_id)
    wf = db.get_workflow(workflow_id)
    if wf["status"] == "running":
        raise HTTPException(409, "Already running")
    return {**service.submit(db, workflow_id), "workflow_id": workflow_id}


@router.post("/{workflow_id}/pause")
def pause(workflow_id: str):
    db = _get_db()
    _ensure_exists(db, workflow_id)
    return {**service.pause(db, workflow_id), "workflow_id": workflow_id}


@router.post("/{workflow_id}/resume")
def resume(workflow_id: str):
    db = _get_db()
    _ensure_exists(db, workflow_id)
    return {**service.resume(db, workflow_id), "workflow_id": workflow_id}


@router.post("/{workflow_id}/reset")
def reset(workflow_id: str):
    db = _get_db()
    _ensure_exists(db, workflow_id)
    return {**service.reset(db, workflow_id), "workflow_id": workflow_id}


@router.post("/{workflow_id}/confirm-all")
def confirm_all(workflow_id: str):
    """Confirm ALL PENDING_REVIEW tasks in a workflow, advancing them to READY."""
    db = _get_db()
    _ensure_exists(db, workflow_id)
    from catgo.workflow.states import TaskState
    pending = db.get_tasks_by_status(workflow_id, TaskState.PENDING_REVIEW.value)
    for task in pending:
        db.update_task(task["id"], status=TaskState.READY.value)
    return {"workflow_id": workflow_id, "confirmed": len(pending)}


class ConvertRequest(BaseModel):
    name: str
    graph_json: str
    config: dict | None = None
    project_id: str | None = None  # Optional: assign workflow to project on creation


@router.post("/convert")
async def convert(body: ConvertRequest):
    """Convert a GUI graph_json into an engine workflow with tasks + links.

    Optionally assigns the workflow to a project if project_id is provided.
    """
    db = _get_db()
    wf_id = convert_graph_json(db, body.name, body.graph_json, body.config)
    wf = db.get_workflow(wf_id)
    tasks = db.get_all_tasks(wf_id)

    # Assign to project if provided
    if body.project_id:
        db.assign_project(wf_id, body.project_id)

    return {"workflow_id": wf_id, "name": wf["name"], "task_count": len(tasks), "project_id": body.project_id}


# ---------------------------------------------------------------------------
# Local dry-run (#225): validate the graph + attempt per-node *local* input
# generation. NO HPC, NO DB writes, NO engine start. Pure + synchronous.
# ---------------------------------------------------------------------------

# Engine keys that have no remote inputs to generate — they validate trivially
# (structure builders, local orchestration, local analysis, polymer sims).
_LOCAL_ENGINE_KEYS = frozenset({"local", "build", "analysis", "polymer_sim"})

# Engine key -> pure input-file generator (signature: (node_type, params,
# structure_str) -> ...). Only engines with a real synchronous generator are
# listed; anything else is reported as "dry-run not supported".
_DRY_RUN_GENERATORS: dict[str, str] = {
    "vasp": "workflow.engines.vasp:generate_vasp_input_files",
    "cp2k": "workflow.engines.cp2k:generate_cp2k_input_files",
    "orca": "workflow.engines.orca:generate_orca_input_files",
    "lammps": "workflow.engines.lammps:generate_lammps_input_files",
    "mlp": "workflow.engines.mlp:generate_mlp_input_files",
    "xtb": "workflow.engines.xtb:generate_xtb_input_files",
    "sella": "workflow.engines.sella:generate_sella_input_files",
}


def _import_generator(path: str):
    """Resolve a 'module.path:attr' string to the callable, or None."""
    import importlib

    module_name, _, attr = path.partition(":")
    mod = importlib.import_module(module_name)
    return getattr(mod, attr)


def _required_inputs_for(node_type: str) -> list[str]:
    """Return required input port keys for a node type.

    Reuses the same handle map the graph converter uses so dry-run and the
    real converter agree on what an input is. Returns [] for unknown types.
    """
    from catgo.workflow.graph_converter import _HANDLE_MAP

    handles = _HANDLE_MAP.get(node_type)
    if handles is None:
        return []
    return list(handles.get("inputs", []))


def dry_run_graph(
    nodes: list[dict],
    edges: list[dict],
    structures: dict[str, str] | None = None,
) -> dict:
    """Validate a workflow graph and attempt per-node local input generation.

    Pure + synchronous. Never touches HPC, the DB, or the engine.

    Returns ``{"valid": bool, "results": {node_id: {...}}, "graph_errors": [str]}``.
    Per-node result is one of:
      - ``{"ok": True}``                       — validated (and inputs generated)
      - ``{"ok": False, "error": "<msg>"}``    — real generator error
      - ``{"ok": None, "skipped": "<why>"}``   — no upstream structure / unsupported
    """
    import tempfile

    from catgo.workflow.engine.hpc_utils import map_task_type_to_engine

    structures = structures or {}
    nodes = nodes or []
    edges = edges or []

    node_ids = [str(n.get("id")) for n in nodes if n.get("id") is not None]
    node_by_id = {str(n["id"]): n for n in nodes if n.get("id") is not None}

    # Normalize edges (accept from/to or source/target, like graph_converter).
    norm_edges: list[tuple[str, str]] = []
    for e in edges:
        src = e.get("from", e.get("source"))
        tgt = e.get("to", e.get("target"))
        if src is None or tgt is None:
            continue
        norm_edges.append((str(src), str(tgt)))

    graph_errors: list[str] = []

    # --- Build adjacency + in-degree over known nodes only. ---
    adjacency: dict[str, list[str]] = {nid: [] for nid in node_ids}
    indegree: dict[str, int] = {nid: 0 for nid in node_ids}
    incoming: dict[str, list[str]] = {nid: [] for nid in node_ids}
    for src, tgt in norm_edges:
        if src not in node_by_id or tgt not in node_by_id:
            graph_errors.append(f"edge references unknown node ({src} -> {tgt})")
            continue
        adjacency[src].append(tgt)
        indegree[tgt] += 1
        incoming[tgt].append(src)

    # --- Kahn's algorithm: topological order + cycle detection. ---
    queue = [nid for nid in node_ids if indegree[nid] == 0]
    # Stable ordering for determinism.
    queue.sort(key=lambda nid: node_ids.index(nid))
    topo_order: list[str] = []
    indeg = dict(indegree)
    while queue:
        nid = queue.pop(0)
        topo_order.append(nid)
        for nxt in adjacency[nid]:
            indeg[nxt] -= 1
            if indeg[nxt] == 0:
                queue.append(nxt)
        queue.sort(key=lambda x: node_ids.index(x))

    if len(topo_order) < len(node_ids):
        unresolved = [nid for nid in node_ids if nid not in topo_order]
        graph_errors.append(
            "cycle detected (no valid execution order): "
            + ", ".join(unresolved)
        )

    # --- Required-input connectivity check (best-effort). ---
    for nid in node_ids:
        node = node_by_id[nid]
        node_type = str(node.get("type", ""))
        required = _required_inputs_for(node_type)
        if required and not incoming.get(nid):
            graph_errors.append(
                f"node '{nid}' ({node_type}) has required input(s) "
                f"{required} but no incoming connection"
            )

    # --- Per-node local validation / input generation, in topo order. ---
    results: dict[str, dict] = {}
    # Iterate topo order first; append any nodes excluded by a cycle so they
    # still get a result entry.
    ordered = topo_order + [nid for nid in node_ids if nid not in topo_order]
    for nid in ordered:
        node = node_by_id[nid]
        node_type = str(node.get("type", ""))
        params = node.get("params") or {}
        if not isinstance(params, dict):
            params = {}

        try:
            resolved_type, engine_key = map_task_type_to_engine(node_type, params)
        except Exception as exc:  # never crash the whole dry-run
            results[nid] = {"ok": False, "error": f"engine resolution failed: {exc}"}
            continue

        # Local / non-HPC nodes: nothing to generate, validate-only.
        if engine_key in _LOCAL_ENGINE_KEYS:
            results[nid] = {"ok": True}
            continue

        gen_path = _DRY_RUN_GENERATORS.get(engine_key)
        if gen_path is None:
            results[nid] = {
                "ok": None,
                "skipped": f"dry-run not supported for {engine_key}",
            }
            continue

        structure_str = structures.get(nid)
        if not structure_str:
            results[nid] = {
                "ok": None,
                "skipped": "upstream structure not available (run upstream first)",
            }
            continue

        try:
            generator = _import_generator(gen_path)
        except Exception as exc:
            results[nid] = {
                "ok": None,
                "skipped": f"dry-run generator unavailable for {engine_key}: {exc}",
            }
            continue

        # Run the PURE generator in a throwaway temp dir. The generators are
        # pure (return {filename: content}) and do not write remote/POTCAR
        # files, but we provide an isolated cwd as a belt-and-suspenders guard.
        try:
            with tempfile.TemporaryDirectory():
                generator(resolved_type, params, structure_str)
            results[nid] = {"ok": True}
        except Exception as exc:
            results[nid] = {"ok": False, "error": str(exc) or repr(exc)}

    has_failure = any(r.get("ok") is False for r in results.values())
    valid = (not graph_errors) and (not has_failure)

    return {"valid": valid, "results": results, "graph_errors": graph_errors}


class DryRunRequest(BaseModel):
    # nodes: [{id, type, params}]; edges accept from/to or source/target
    # (+ optional fromH/toH); structures: {node_id: poscar-or-pymatgen-json}.
    # Kept as dicts so the same flexible parsing as graph_converter applies.
    nodes: list[dict] = []
    edges: list[dict] = []
    structures: dict[str, str] = {}


@router.post("/dry-run")
def dry_run(body: DryRunRequest):
    """Local dry-run: validate the graph + attempt per-node input generation.

    Stateless — does NOT submit to HPC, write the DB, or start the engine.
    """
    return dry_run_graph(body.nodes, body.edges, body.structures)


@router.put("/{workflow_id}/project/{project_id}")
def assign_project(workflow_id: str, project_id: str):
    """Assign an engine workflow to a project."""
    db = _get_db()
    _ensure_exists(db, workflow_id)
    db.assign_project(workflow_id, project_id)
    return {"status": "assigned", "workflow_id": workflow_id, "project_id": project_id}


@router.delete("/{workflow_id}/project")
def unassign_project(workflow_id: str):
    """Remove an engine workflow from its project."""
    db = _get_db()
    _ensure_exists(db, workflow_id)
    db.assign_project(workflow_id, None)
    return {"status": "unassigned", "workflow_id": workflow_id}


@router.websocket("/{workflow_id}/monitor")
async def monitor(websocket: WebSocket, workflow_id: str):
    db = _get_db()
    _ensure_exists(db, workflow_id)
    await websocket.accept()

    q = add_listener(workflow_id)

    async def _drain_client():
        """Read client messages to handle pings and prevent buffer buildup."""
        try:
            while True:
                data = await websocket.receive_json()
                if isinstance(data, dict) and data.get("type") == "ping":
                    await websocket.send_json({"type": "pong"})
        except Exception:
            pass  # Connection closed

    client_task = asyncio.create_task(_drain_client())
    try:
        while True:
            try:
                msg = await asyncio.wait_for(q.get(), timeout=30.0)
                await websocket.send_json(msg)
            except asyncio.TimeoutError:
                await websocket.send_json({"type": "heartbeat"})
    except (WebSocketDisconnect, Exception):
        pass
    finally:
        client_task.cancel()
        remove_listener(workflow_id, q)

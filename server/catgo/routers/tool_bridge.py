"""Tool bridge endpoint for Rust catgo-graph integration.

This router provides a single POST endpoint that the Rust HttpBridgeTool
calls to execute individual workflow node steps. It routes to the same
handler functions used by the Python workflow engine.

The bridge is stateless from the Python side — all scheduling, state
management, retry/repair logic is handled by the Rust catgo-graph engine.
"""

import json
import logging
import traceback
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from workflow.node_sets import (
    LOCAL_NODES,
    ANALYSIS_NODES,
    LAMMPS_NODES,
    POLYMER_SIM_NODES,
    MLP_NODES,
    VASP_CALC_NODES,
    XTB_NODES,
    SELLA_NODES,
    CP2K_NODES,
    ORCA_CALC_NODES,
    HPC_ANALYSIS_NODES,
    GAUSSIAN_CALC_NODES,
    GROMACS_NODES,
    UNIFIED_CALC_NODES,
    _resolve_software,
)
from catgo.utils.workflow_db import update_step

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/tool", tags=["tool-bridge"])


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------

class ToolExecuteRequest(BaseModel):
    """Request from Rust HttpBridgeTool."""
    node_type: str
    step_id: str
    inputs: dict[str, Any] = {}
    config: Optional[dict[str, Any]] = None


class ToolExecuteResponse(BaseModel):
    """Response to Rust HttpBridgeTool."""
    status: str  # "completed" | "failed"
    outputs: dict[str, Any] = {}
    error: Optional[str] = None
    artifacts: list[dict[str, Any]] = []


# ---------------------------------------------------------------------------
# Stub broadcast + parent helpers for handlers
# ---------------------------------------------------------------------------

async def _noop_broadcast(workflow_id: str, msg: dict):
    """No-op broadcast — Rust handles monitoring via ExecutionEvent channel."""
    pass


def _get_parent_ids_from_inputs(step_id: str, edges: list[dict]) -> list[str]:
    """Extract parent step IDs from edges list."""
    parents = []
    for e in edges:
        tgt = e.get("target") or e.get("to", "")
        src = e.get("source") or e.get("from", "")
        if tgt == step_id and src:
            parents.append(src)
    return parents


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------

@router.post("/execute")
async def execute_tool(request: ToolExecuteRequest) -> ToolExecuteResponse:
    """Execute a single workflow node step.

    Called by Rust's HttpBridgeTool. Routes to the appropriate Python
    handler based on node_type, following the same dispatch logic as
    engine.py.
    """
    node_type = request.node_type
    step_id = request.step_id
    params = request.inputs.get("params", request.inputs)
    config_dict = request.config or {}

    # Build a minimal config object
    config = _make_config(config_dict)

    # Build step_results from inputs (Rust resolves dependencies and passes
    # parent outputs in inputs.__parent_outputs)
    step_results: dict[str, dict] = request.inputs.get("__parent_outputs", {})

    # Build edges from inputs (if provided)
    edges: list[dict] = request.inputs.get("__edges", [])

    # Workflow ID (may come from inputs metadata or config)
    workflow_id = request.inputs.get("__workflow_id", "rust-bridge")

    logger.info(
        "Tool bridge: executing %s (step=%s, workflow=%s)",
        node_type, step_id, workflow_id,
    )

    try:
        # Resolve unified types
        if node_type in UNIFIED_CALC_NODES:
            node_type, _sw = _resolve_software(node_type, params)

        if node_type in LOCAL_NODES:
            from workflow.engines.local import execute_local_node
            await execute_local_node(
                workflow_id, step_id, node_type, params,
                edges, step_results, config,
                _noop_broadcast, _get_parent_ids_from_inputs,
            )
        elif node_type in ANALYSIS_NODES:
            from workflow.engines.analysis import execute_analysis_node
            await execute_analysis_node(
                workflow_id, step_id, node_type, params,
                edges, step_results, config,
                _noop_broadcast, _get_parent_ids_from_inputs,
            )
        elif (node_type in LAMMPS_NODES or node_type in POLYMER_SIM_NODES) and (
            params.get("execution_mode") == "local"
            or getattr(config, "execution_mode", "hpc") == "local"
        ):
            from workflow.engines.lammps import execute_lammps_local
            await execute_lammps_local(
                workflow_id, step_id, node_type, params,
                edges, step_results, config,
                _noop_broadcast, _get_parent_ids_from_inputs,
            )
        elif node_type in MLP_NODES and (
            params.get("execution_mode") == "local"
            or getattr(config, "execution_mode", "hpc") == "local"
        ):
            from workflow.engines.mlp import execute_mlp_local
            await execute_mlp_local(
                workflow_id, step_id, node_type, params,
                edges, step_results, config,
                _noop_broadcast, _get_parent_ids_from_inputs,
            )
        elif node_type in ORCA_CALC_NODES:
            # Route ORCA nodes to the ORCA engine
            from workflow.engines.orca import execute_orca_node
            await execute_orca_node(
                workflow_id, step_id, node_type, params,
                edges, step_results, config,
                _noop_broadcast, _get_parent_ids_from_inputs,
            )
        elif node_type in (
            VASP_CALC_NODES | MLP_NODES | XTB_NODES | SELLA_NODES |
            CP2K_NODES | HPC_ANALYSIS_NODES |
            LAMMPS_NODES | POLYMER_SIM_NODES | GAUSSIAN_CALC_NODES |
            GROMACS_NODES
        ):
            # HPC nodes require SSH + SLURM, handled by the Python engine.
            # If we reach here, it means the workflow was incorrectly routed
            # to the Rust engine instead of the Python engine.
            return ToolExecuteResponse(
                status="failed",
                error=(
                    f"HPC node '{node_type}' requires the Python workflow engine "
                    f"(SSH + SLURM/PBS integration). This node should not be "
                    f"routed through the Rust tool bridge. "
                    f"This is a routing error — workflows containing HPC nodes "
                    f"should be dispatched to the Python engine at start time. "
                    f"Check workflow/engine.py:start_workflow() routing logic."
                ),
            )
        else:
            return ToolExecuteResponse(
                status="failed",
                error=f"Unknown node type: {node_type}",
            )

        # Read back the step result from the database
        from catgo.utils.workflow_db import get_step_status
        step = get_step_status(workflow_id, step_id) or {}
        outputs = {}
        if step.get("result_json"):
            try:
                outputs = json.loads(step["result_json"])
            except (json.JSONDecodeError, TypeError):
                pass

        # Also check step_results (handlers write here too)
        if step_id in step_results:
            outputs.update(step_results[step_id])

        return ToolExecuteResponse(
            status="completed",
            outputs=outputs,
        )

    except Exception as e:
        logger.exception("Tool bridge error for %s/%s: %s", node_type, step_id, e)
        return ToolExecuteResponse(
            status="failed",
            error=str(e),
            outputs={"traceback": traceback.format_exc()},
        )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

class _MinimalConfig:
    """Minimal config object matching what handlers expect from WorkflowRunConfig."""
    def __init__(self, data: dict):
        self.work_dir = data.get("work_dir", "/tmp/catgo_work")
        self.execution_mode = data.get("execution_mode", "local")
        self.hpc_config = data.get("hpc_config", {})
        self.software = data.get("software", "vasp")
        # Allow attribute access for any other config keys
        for k, v in data.items():
            if not hasattr(self, k):
                setattr(self, k, v)


def _make_config(config_dict: dict) -> _MinimalConfig:
    """Create a minimal config object from a dict."""
    return _MinimalConfig(config_dict)

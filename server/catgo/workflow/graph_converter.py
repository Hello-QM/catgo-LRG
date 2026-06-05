"""Convert GUI graph_json to v2 workflow tasks + links.

graph_json format:
  {nodes: [{id, type, x, y, params}], edges: [{id, from, to, fromH, toH}]}

Handle convention:
  "out-0" = first output, "in-1" = second input
  Index maps to NodeDefinition.inputs/outputs arrays
"""

from __future__ import annotations

import json
from typing import Any

from catgo.workflow.db import WorkflowDB
from catgo.workflow.task_ids import make_task_id


# Map frontend node types to handle names (input/output ports)
# Default: first input = "structure", first output = "structure"
_HANDLE_MAP: dict[str, dict[str, list[str]]] = {
    "structure_input": {"inputs": [], "outputs": ["structure"]},
    "geo_opt": {"inputs": ["structure"], "outputs": ["structure", "energy"]},
    "single_point": {"inputs": ["structure"], "outputs": ["energy"]},
    "freq": {"inputs": ["structure"], "outputs": ["structure", "frequencies"]},
    "cell_opt": {"inputs": ["structure"], "outputs": ["structure", "energy"]},
    "md": {"inputs": ["structure"], "outputs": ["structure"]},
    "slab_gen": {"inputs": ["structure"], "outputs": ["structure"]},
    "adsorbate_place": {"inputs": ["structure"], "outputs": ["structure"]},
    "gibbs_energy": {"inputs": ["energy", "frequencies"], "outputs": ["gibbs", "zpe"]},
    "dos_analysis": {"inputs": ["structure"], "outputs": ["result"]},
    "charge_analysis": {"inputs": ["structure"], "outputs": ["result"]},
    "free_energy_diagram": {"inputs": ["gibbs_values"], "outputs": ["result"]},
    # Analysis nodes
    "adsorption_energy": {"inputs": ["energies"], "outputs": ["adsorption_result"]},
    "surface_energy": {"inputs": ["slab_energies"], "outputs": ["surface_energy_result"]},
    "wulff_construction": {"inputs": ["surface_energy_result"], "outputs": ["wulff_result"]},
    # Utility nodes
    "batch_slab_gen": {"inputs": ["structure"], "outputs": ["structures"]},
    "batch_coverage_gen": {"inputs": ["structure"], "outputs": ["structures"]},
    "coverage_analysis": {"inputs": ["energies"], "outputs": ["result"]},
    "aggregate": {"inputs": ["results"], "outputs": ["result"]},
    "map": {"inputs": ["items"], "outputs": ["results"]},
    # Unified calc types
    "ts_search": {"inputs": ["structure", "structure_product"], "outputs": ["structure", "energy", "frequencies", "trajectory"]},
    "irc": {"inputs": ["structure"], "outputs": ["structure"]},
    "uvvis": {"inputs": ["structure"], "outputs": ["structure", "spectrum"]},
    # ORCA-specific (legacy names, for old workflows not yet migrated)
    "orca_opt": {"inputs": ["structure"], "outputs": ["structure", "energy"]},
    "orca_sp": {"inputs": ["structure"], "outputs": ["energy"]},
    "orca_freq": {"inputs": ["structure"], "outputs": ["structure", "frequencies"]},
    "orca_neb_ts": {"inputs": ["structure", "structure_product"], "outputs": ["structure", "energy", "frequencies", "trajectory"]},
    "orca_irc": {"inputs": ["structure"], "outputs": ["structure"]},
    "orca_uvvis": {"inputs": ["structure"], "outputs": ["structure", "spectrum"]},
    "md_minimize": {
        "inputs": ["structure", "restart"],
        "outputs": ["trajectory", "energy", "log", "restart"],
    },
}

_DEFAULT_HANDLES = {"inputs": ["structure"], "outputs": ["structure"]}


def _get_handle_name(node_type: str, handle_id: str, direction: str) -> str:
    """Convert 'out-0' / 'in-1' to a semantic key like 'structure' or 'energy'."""
    prefix = "out-" if direction == "output" else "in-"
    if not handle_id.startswith(prefix):
        return "structure"  # fallback

    try:
        idx = int(handle_id[len(prefix):])
    except ValueError:
        return "structure"

    handles = _HANDLE_MAP.get(node_type, _DEFAULT_HANDLES)
    keys = handles.get("outputs" if direction == "output" else "inputs", [])
    return keys[idx] if idx < len(keys) else "structure"


def convert_graph_json(
    db: WorkflowDB,
    name: str,
    graph_json: str,
    config: dict[str, Any] | None = None,
    workflow_id: str | None = None,
) -> str:
    """Parse graph_json, create v2 workflow with tasks + links. Returns workflow_id."""
    import logging
    logger = logging.getLogger(__name__)

    try:
        graph = json.loads(graph_json) if isinstance(graph_json, str) else graph_json
        raw_json = graph_json if isinstance(graph_json, str) else json.dumps(graph_json)
        nodes = graph.get("nodes", [])
        edges = graph.get("edges", [])

        logger.error(f"[convert_graph_json] Creating workflow: name={name}, nodes={len(nodes)}, edges={len(edges)}")
        wf_id = db.create_workflow(name, config=config, graph_json=raw_json,
                                    workflow_id=workflow_id)
        logger.error(f"[convert_graph_json] Workflow created: wf_id={wf_id}")

        # Create tasks, preserving original node IDs as task IDs
        for i, node in enumerate(nodes):
            node_id = node["id"]
            node_type = node["type"]
            params = node.get("params", {})

            software = params.get("software") if isinstance(params, dict) else None

            logger.error(f"[convert_graph_json] Creating task {i+1}/{len(nodes)}: node_id={node_id}, type={node_type}, wf_id={wf_id}")
            db.create_task(
                wf_id, node_type,
                task_id=make_task_id(wf_id, node_id),
                node_id=node_id,
                name=params.get("label") or params.get("system_name"),
                params=params,
                software=software,
                system_name=params.get("system_name"),
            )
    except Exception as e:
        logger.error(f"[convert_graph_json] FAILED: {type(e).__name__}: {e}", exc_info=True)
        raise

    # Create links from edges (use node IDs directly as task IDs)
    for edge in edges:
        src_node_id = edge.get("from", edge.get("source", ""))
        tgt_node_id = edge.get("to", edge.get("target", ""))
        src_handle = edge.get("fromH", edge.get("fromHandle", "out-0"))
        tgt_handle = edge.get("toH", edge.get("toHandle", "in-0"))

        if not src_node_id or not tgt_node_id:
            continue

        # Resolve semantic keys from handle IDs
        src_node_type = next((n["type"] for n in nodes if n["id"] == src_node_id), "")
        tgt_node_type = next((n["type"] for n in nodes if n["id"] == tgt_node_id), "")

        source_key = _get_handle_name(src_node_type, src_handle, "output")
        target_key = _get_handle_name(tgt_node_type, tgt_handle, "input")

        db.create_link(
            wf_id,
            make_task_id(wf_id, src_node_id),
            make_task_id(wf_id, tgt_node_id),
            source_key, target_key,
        )

    return wf_id

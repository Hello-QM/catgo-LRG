"""Convert serialized atomate2 Flow (from flow.as_dict()) to CatGo workflow format.

Operates purely on JSON dictionaries produced by ``monty.json.MontyEncoder``.
No atomate2 installation is required.
"""

from __future__ import annotations

import json
import time
from collections import defaultdict
from typing import Any

from .maker_map import map_job_to_catgo

__all__ = [
    "atomate2_flow_to_catgo",
]


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def atomate2_flow_to_catgo(flow_dict: dict) -> dict:
    """Convert a serialized atomate2 Flow to CatGo workflow format.

    Parameters
    ----------
    flow_dict:
        The dictionary produced by ``flow.as_dict()`` / ``MontyEncoder``.
        Expected to have ``{"@class": "Flow", "jobs": [...], ...}``.

    Returns
    -------
    dict
        ``{"nodes": [...], "edges": [...]}`` in CatGo's graph format.
        Each node has ``id``, ``type``, ``x``, ``y``, ``params``.
        Each edge has ``id``, ``from``, ``to``, ``fromH``, ``toH``.
    """
    jobs = _flatten_jobs(flow_dict)
    if not jobs:
        return {"nodes": [], "edges": []}

    # Build dependency graph from OutputReferences
    # job_uuid -> set of uuids it depends on
    deps: dict[str, set[str]] = {}
    all_uuids = {j["uuid"] for j in jobs}
    for job in jobs:
        refs = _get_input_reference_uuids(job)
        # Only keep references to jobs within this flow
        deps[job["uuid"]] = refs & all_uuids

    sorted_jobs = _topological_sort(jobs, deps)

    # Assign stable node IDs
    base_ts = int(time.time() * 1000)
    uuid_to_node_id: dict[str, str] = {}
    for i, job in enumerate(sorted_jobs):
        uuid_to_node_id[job["uuid"]] = f"n{base_ts}-{i}"

    # Identify root jobs (no intra-flow dependencies)
    root_uuids = {j["uuid"] for j in sorted_jobs if not deps.get(j["uuid"])}

    # Build nodes
    nodes: list[dict[str, Any]] = []

    # Add a structure_input node if there are root jobs
    struct_node_id = f"n{base_ts}-input"
    nodes.append({
        "id": struct_node_id,
        "type": "structure_input",
        "x": 80,
        "y": 200,
        "params": {},
    })

    for i, job in enumerate(sorted_jobs):
        node_id = uuid_to_node_id[job["uuid"]]
        mapped = map_job_to_catgo(job)
        col, row = _get_layout_position(i, sorted_jobs, deps)
        nodes.append({
            "id": node_id,
            "type": mapped["type"],
            "x": col * 300 + 380,
            "y": row * 140 + 200,
            "params": mapped["params"],
        })

    # Build edges
    edges: list[dict[str, Any]] = []
    edge_set: set[tuple[str, str]] = set()

    # Connect structure_input to root jobs
    for uuid in root_uuids:
        target_id = uuid_to_node_id[uuid]
        edge_key = (struct_node_id, target_id)
        if edge_key not in edge_set:
            edge_set.add(edge_key)
            edges.append({
                "id": f"e-{struct_node_id}-{target_id}",
                "from": struct_node_id,
                "to": target_id,
                "fromH": "out-0",
                "toH": "in-0",
            })

    # Edges from OutputReference dependencies
    for job in sorted_jobs:
        target_id = uuid_to_node_id[job["uuid"]]
        for ref_uuid in deps.get(job["uuid"], set()):
            source_id = uuid_to_node_id.get(ref_uuid)
            if source_id:
                edge_key = (source_id, target_id)
                if edge_key not in edge_set:
                    edge_set.add(edge_key)
                    edges.append({
                        "id": f"e-{source_id}-{target_id}",
                        "from": source_id,
                        "to": target_id,
                        "fromH": "out-0",
                        "toH": "in-0",
                    })

    return {"nodes": nodes, "edges": edges}


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _flatten_jobs(flow_dict: dict) -> list[dict]:
    """Recursively extract all Jobs from a (possibly nested) Flow structure.

    atomate2 Flows can contain other Flows in their ``jobs`` list.
    This flattens the hierarchy into a single list while preserving
    OutputReference edges (which use UUIDs and remain valid across nesting).
    """
    jobs: list[dict] = []
    items = flow_dict.get("jobs", [])
    for item in items:
        cls = item.get("@class", "")
        if cls == "Flow":
            # Recursively flatten nested Flows
            jobs.extend(_flatten_jobs(item))
        else:
            # It's a Job (or Job-like object)
            if "uuid" in item:
                jobs.append(item)
    return jobs


def _get_input_reference_uuids(job_dict: dict) -> set[str]:
    """Scan a Job's function_args/kwargs for OutputReference UUIDs.

    OutputReference is serialized by monty as::

        {
            "@module": "jobflow.core.reference",
            "@class": "OutputReference",
            "uuid": "...",
            "attributes": [...]
        }

    These can be nested arbitrarily deep in dicts and lists.
    """
    refs: set[str] = set()

    def _scan(obj: Any) -> None:
        if isinstance(obj, dict):
            if obj.get("@class") == "OutputReference":
                uuid = obj.get("uuid")
                if uuid:
                    refs.add(uuid)
            else:
                for v in obj.values():
                    _scan(v)
        elif isinstance(obj, (list, tuple)):
            for v in obj:
                _scan(v)

    # Scan both function_args and function_kwargs
    _scan(job_dict.get("function_args", []))
    _scan(job_dict.get("function_kwargs", {}))

    # Also scan the top-level "output" field and "maker" in case references
    # are stored differently in some serialization versions
    _scan(job_dict.get("output", {}))

    return refs


def _topological_sort(
    jobs: list[dict],
    deps: dict[str, set[str]],
) -> list[dict]:
    """Sort jobs by dependency order using Kahn's algorithm.

    Jobs with no dependencies come first. Ties are broken by the original
    order in the flow to maintain the author's intent.
    """
    uuid_to_job = {j["uuid"]: j for j in jobs}
    in_degree: dict[str, int] = defaultdict(int)
    dependents: dict[str, list[str]] = defaultdict(list)

    for uuid in uuid_to_job:
        in_degree.setdefault(uuid, 0)
        for dep_uuid in deps.get(uuid, set()):
            if dep_uuid in uuid_to_job:
                dependents[dep_uuid].append(uuid)
                in_degree[uuid] += 1

    # Seed with zero-in-degree jobs, preserving original order
    original_order = {j["uuid"]: i for i, j in enumerate(jobs)}
    queue = sorted(
        [u for u in uuid_to_job if in_degree[u] == 0],
        key=lambda u: original_order.get(u, 0),
    )

    result: list[dict] = []
    while queue:
        uuid = queue.pop(0)
        result.append(uuid_to_job[uuid])
        for dependent in sorted(
            dependents.get(uuid, []),
            key=lambda u: original_order.get(u, 0),
        ):
            in_degree[dependent] -= 1
            if in_degree[dependent] == 0:
                queue.append(dependent)

    # Append any remaining jobs (shouldn't happen in acyclic flows)
    seen = {j["uuid"] for j in result}
    for job in jobs:
        if job["uuid"] not in seen:
            result.append(job)

    return result


def _get_layout_position(
    index: int,
    sorted_jobs: list[dict],
    deps: dict[str, set[str]],
) -> tuple[int, int]:
    """Calculate grid position (col, row) for a job based on DAG depth.

    Column = longest dependency chain length (depth in the DAG).
    Row = index among jobs at the same depth.
    """
    uuid_to_idx = {j["uuid"]: i for i, j in enumerate(sorted_jobs)}

    # Compute depth for the target job
    memo: dict[str, int] = {}

    def _depth(uuid: str) -> int:
        if uuid in memo:
            return memo[uuid]
        job_deps = deps.get(uuid, set())
        valid_deps = [d for d in job_deps if d in uuid_to_idx]
        if not valid_deps:
            memo[uuid] = 0
            return 0
        d = max(_depth(d) for d in valid_deps) + 1
        memo[uuid] = d
        return d

    target_uuid = sorted_jobs[index]["uuid"]
    col = _depth(target_uuid)

    # Count how many earlier jobs share the same depth for row staggering
    row = 0
    for j in sorted_jobs[:index]:
        if _depth(j["uuid"]) == col:
            row += 1

    return col, row

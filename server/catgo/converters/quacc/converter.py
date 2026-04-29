"""Convert quacc @flow-decorated function source code to CatGo workflow format.

This module provides two conversion paths:

1. **AST-based**: ``parse_quacc_flow(source_code)`` statically analyses a
   ``@flow``-decorated Python function and extracts the DAG of ``@job`` calls,
   mapping each to a CatGo workflow node via ``RECIPE_TO_CATGO``.

2. **Declarative list**: ``quacc_jobs_to_catgo(jobs)`` accepts a simple list of
   job description dicts (no AST needed) and builds the CatGo graph.

Both return ``{"nodes": [...], "edges": [...]}`` ready for the CatGo workflow
editor.
"""

from __future__ import annotations

import ast
import json
import time
from dataclasses import dataclass, field
from typing import Any

from .recipe_map import RECIPE_TO_CATGO, extract_recipe_params

__all__ = [
    "parse_quacc_flow",
    "quacc_jobs_to_catgo",
]


# ---------------------------------------------------------------------------
# Internal data structures
# ---------------------------------------------------------------------------

@dataclass
class ASTJob:
    """Intermediate representation of a single @job call found in the AST."""

    var_name: str  # e.g. "result1"
    recipe_path: str  # e.g. "quacc.recipes.vasp.core.relax_job" or just "relax_job"
    func_name: str  # short name, e.g. "relax_job"
    kwargs: dict[str, Any] = field(default_factory=dict)
    arg_names: list[str] = field(default_factory=list)  # positional arg variable names
    order: int = 0  # declaration order in the function body
    is_subflow: bool = False
    is_conditional: bool = False


# ---------------------------------------------------------------------------
# AST parsing
# ---------------------------------------------------------------------------

def _resolve_recipe_path(func_name: str, import_map: dict[str, str]) -> str:
    """Resolve a short function name to its fully-qualified recipe path.

    If the function was imported (e.g. ``from quacc.recipes.vasp.core import relax_job``),
    the *import_map* will contain ``{"relax_job": "quacc.recipes.vasp.core.relax_job"}``.
    Otherwise fall back to searching ``RECIPE_TO_CATGO`` keys that end with the name.
    """
    if func_name in import_map:
        return import_map[func_name]

    # Try suffix match against known recipes
    candidates = [k for k in RECIPE_TO_CATGO if k.endswith(f".{func_name}")]
    if len(candidates) == 1:
        return candidates[0]

    # Dotted attribute access like ``vasp.core.relax_job`` -> try as suffix
    for k in RECIPE_TO_CATGO:
        if k.endswith(func_name):
            return k

    return func_name  # unknown – will produce a fallback node


def _extract_import_map(tree: ast.Module) -> dict[str, str]:
    """Scan top-level imports to build func_name -> full_path mapping."""
    mapping: dict[str, str] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module:
            for alias in node.names:
                real_name = alias.name
                local_name = alias.asname or real_name
                mapping[local_name] = f"{node.module}.{real_name}"
    return mapping


def _extract_call_func_name(call_node: ast.Call) -> str:
    """Extract the function name from a Call node (handles Name and Attribute)."""
    if isinstance(call_node.func, ast.Name):
        return call_node.func.id
    if isinstance(call_node.func, ast.Attribute):
        parts: list[str] = []
        node: ast.expr = call_node.func
        while isinstance(node, ast.Attribute):
            parts.append(node.attr)
            node = node.value
        if isinstance(node, ast.Name):
            parts.append(node.id)
        return ".".join(reversed(parts))
    return "<unknown>"


def _extract_arg_names(call_node: ast.Call) -> list[str]:
    """Return variable names used as positional arguments in the call."""
    names: list[str] = []
    for arg in call_node.args:
        if isinstance(arg, ast.Name):
            names.append(arg.id)
        elif isinstance(arg, ast.Subscript) and isinstance(arg.value, ast.Name):
            # e.g. result1["atoms"]
            names.append(arg.value.id)
        else:
            names.append("<expr>")
    return names


def _extract_kwarg_names(call_node: ast.Call) -> dict[str, str]:
    """Return keyword argument names that reference variables."""
    refs: dict[str, str] = {}
    for kw in call_node.keywords:
        if kw.arg is None:
            continue
        if isinstance(kw.value, ast.Name):
            refs[kw.arg] = kw.value.id
        elif isinstance(kw.value, ast.Subscript) and isinstance(kw.value.value, ast.Name):
            refs[kw.arg] = kw.value.value.id
    return refs


def _parse_flow_ast(source: str) -> tuple[list[ASTJob], dict[str, str]]:
    """Parse the function body of a @flow-decorated function.

    Returns
    -------
    jobs : list[ASTJob]
        Ordered list of job calls found.
    import_map : dict[str, str]
        Function name -> fully-qualified recipe path from import statements.
    """
    tree = ast.parse(source)
    import_map = _extract_import_map(tree)

    # Find the @flow-decorated function
    flow_func: ast.FunctionDef | None = None
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            for deco in node.decorator_list:
                deco_name = ""
                if isinstance(deco, ast.Name):
                    deco_name = deco.id
                elif isinstance(deco, ast.Attribute):
                    deco_name = deco.attr
                if deco_name == "flow":
                    flow_func = node
                    break
            if flow_func:
                break

    if flow_func is None:
        # Fallback: use the first function definition
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                flow_func = node
                break

    if flow_func is None:
        return [], import_map

    jobs: list[ASTJob] = []
    order = 0

    for stmt in ast.walk(flow_func):
        # Handle: result = some_job(...)
        if isinstance(stmt, ast.Assign) and len(stmt.targets) == 1:
            target = stmt.targets[0]
            if isinstance(target, ast.Name) and isinstance(stmt.value, ast.Call):
                var_name = target.id
                func_name = _extract_call_func_name(stmt.value)
                recipe_path = _resolve_recipe_path(func_name, import_map)
                arg_names = _extract_arg_names(stmt.value)
                kwarg_refs = _extract_kwarg_names(stmt.value)
                # Merge kwarg refs into arg_names for dependency tracking
                all_refs = arg_names + list(kwarg_refs.values())

                # Detect @subflow calls
                is_subflow = "subflow" in func_name.lower()

                jobs.append(ASTJob(
                    var_name=var_name,
                    recipe_path=recipe_path,
                    func_name=func_name.split(".")[-1],
                    arg_names=all_refs,
                    order=order,
                    is_subflow=is_subflow,
                ))
                order += 1

        # Handle: for ... in ...: (potential dynamic fan-out)
        elif isinstance(stmt, ast.For):
            # Check if the for-body contains job calls -> mark as subflow
            for inner in ast.walk(stmt):
                if isinstance(inner, ast.Assign) and len(inner.targets) == 1:
                    target = inner.targets[0]
                    if isinstance(target, ast.Name) and isinstance(inner.value, ast.Call):
                        func_name = _extract_call_func_name(inner.value)
                        recipe_path = _resolve_recipe_path(func_name, import_map)
                        jobs.append(ASTJob(
                            var_name=target.id,
                            recipe_path=recipe_path,
                            func_name=func_name.split(".")[-1],
                            arg_names=_extract_arg_names(inner.value),
                            order=order,
                            is_subflow=True,
                        ))
                        order += 1

        # Handle: if/else conditional branches
        elif isinstance(stmt, ast.If):
            for branch_body in [stmt.body, stmt.orelse]:
                for inner in branch_body if isinstance(branch_body, list) else []:
                    if isinstance(inner, ast.Assign) and len(inner.targets) == 1:
                        target = inner.targets[0]
                        if isinstance(target, ast.Name) and isinstance(inner.value, ast.Call):
                            func_name = _extract_call_func_name(inner.value)
                            recipe_path = _resolve_recipe_path(func_name, import_map)
                            jobs.append(ASTJob(
                                var_name=target.id,
                                recipe_path=recipe_path,
                                func_name=func_name.split(".")[-1],
                                arg_names=_extract_arg_names(inner.value),
                                order=order,
                                is_conditional=True,
                            ))
                            order += 1

    return jobs, import_map


# ---------------------------------------------------------------------------
# Edge construction
# ---------------------------------------------------------------------------

def _build_edges(jobs: list[ASTJob]) -> list[dict[str, str]]:
    """Determine edges by checking which variable names are passed as arguments.

    If job B uses ``result_a`` as an argument and job A assigned to ``result_a``,
    then there is an edge A -> B.
    """
    var_to_job: dict[str, int] = {}
    for i, job in enumerate(jobs):
        var_to_job[job.var_name] = i

    edges: list[dict[str, str]] = []
    seen: set[tuple[int, int]] = set()

    for i, job in enumerate(jobs):
        for arg_name in job.arg_names:
            if arg_name in var_to_job:
                src_idx = var_to_job[arg_name]
                if src_idx != i and (src_idx, i) not in seen:
                    seen.add((src_idx, i))
                    edges.append({
                        "source_idx": src_idx,
                        "target_idx": i,
                    })

    return edges


# ---------------------------------------------------------------------------
# Node / edge generation
# ---------------------------------------------------------------------------

def _make_node_id(index: int) -> str:
    """Generate a stable node ID."""
    return f"n-quacc-{index}"


def _job_to_node(job: ASTJob, index: int, x: int, y: int) -> dict[str, Any]:
    """Convert an ASTJob to a CatGo WfNode dict."""
    mapping = RECIPE_TO_CATGO.get(job.recipe_path)

    if job.is_subflow:
        return {
            "id": _make_node_id(index),
            "type": "dynamic_subflow",
            "x": x,
            "y": y,
            "params": {
                "label": f"Dynamic: {job.func_name}",
                "recipe": job.recipe_path,
                "_warning": "Dynamic @subflow with fan-out cannot be fully converted. "
                            "This node represents the subflow as an opaque block.",
            },
        }

    if mapping is None:
        # Unknown recipe -> fallback
        return {
            "id": _make_node_id(index),
            "type": "custom_job",
            "x": x,
            "y": y,
            "params": {
                "label": job.func_name,
                "recipe": job.recipe_path,
                "_warning": f"Unknown quacc recipe '{job.recipe_path}'. "
                            "Created as custom_job fallback.",
            },
        }

    params = dict(mapping.default_params)
    if job.kwargs:
        extracted = extract_recipe_params(job.recipe_path, job.kwargs)
        params.update(extracted)

    if job.is_conditional:
        params["_conditional"] = True
        params["_warning"] = "This node is inside a conditional branch."

    node = {
        "id": _make_node_id(index),
        "type": mapping.catgo_type,
        "x": x,
        "y": y,
        "params": params,
    }

    if mapping.description:
        node["params"]["label"] = mapping.description

    return node


def _topological_layout(
    n_nodes: int,
    edges: list[dict],
    *,
    x_start: int = 100,
    y_start: int = 200,
    x_gap: int = 300,
    y_gap: int = 140,
) -> list[tuple[int, int]]:
    """Compute (x, y) positions via topological sort with layered layout."""
    # Build adjacency
    adj: dict[int, list[int]] = {i: [] for i in range(n_nodes)}
    in_deg: dict[int, int] = {i: 0 for i in range(n_nodes)}

    for e in edges:
        src, tgt = e["source_idx"], e["target_idx"]
        adj[src].append(tgt)
        in_deg[tgt] += 1

    # Kahn's algorithm -> layers
    layers: list[list[int]] = []
    queue = [i for i in range(n_nodes) if in_deg[i] == 0]
    assigned: set[int] = set()

    if not queue and n_nodes > 0:
        queue = [0]

    while queue:
        layers.append(list(queue))
        for idx in queue:
            assigned.add(idx)
        next_q: list[int] = []
        for idx in queue:
            for nb in adj[idx]:
                in_deg[nb] -= 1
                if in_deg[nb] <= 0 and nb not in assigned:
                    next_q.append(nb)
                    assigned.add(nb)
        queue = next_q

    # Any unassigned nodes
    for i in range(n_nodes):
        if i not in assigned:
            layers.append([i])

    positions: list[tuple[int, int]] = [(0, 0)] * n_nodes
    for col, layer in enumerate(layers):
        total_h = len(layer) * y_gap
        for row, idx in enumerate(layer):
            positions[idx] = (
                x_start + col * x_gap,
                y_start + row * y_gap - total_h // 2,
            )

    return positions


# ---------------------------------------------------------------------------
# Public API: AST-based conversion
# ---------------------------------------------------------------------------

def parse_quacc_flow(source_code: str) -> dict[str, Any]:
    """Convert a quacc ``@flow``-decorated function source to CatGo workflow format.

    Parameters
    ----------
    source_code : str
        Python source code containing a ``@flow``-decorated function with
        ``@job`` calls assigned to variables.

    Returns
    -------
    dict
        ``{"nodes": [...], "edges": [...], "warnings": [...]}`` in CatGo format.
    """
    jobs, _import_map = _parse_flow_ast(source_code)
    warnings: list[str] = []

    if not jobs:
        return {"nodes": [], "edges": [], "warnings": ["No @job calls found in the flow function."]}

    # Add a structure_input node at the beginning
    all_jobs = jobs
    has_structure_input = False

    # Check if any job has no dependencies (root nodes) - they need structure input
    edge_defs = _build_edges(all_jobs)
    targets = {e["target_idx"] for e in edge_defs}
    root_indices = [i for i in range(len(all_jobs)) if i not in targets]

    # Build positions
    # Prepend structure_input node
    n_total = len(all_jobs) + 1  # +1 for structure_input
    adjusted_edges = [
        {"source_idx": e["source_idx"] + 1, "target_idx": e["target_idx"] + 1}
        for e in edge_defs
    ]
    # Connect structure_input to root nodes
    for ri in root_indices:
        adjusted_edges.append({"source_idx": 0, "target_idx": ri + 1})

    positions = _topological_layout(n_total, adjusted_edges)

    # Create nodes
    nodes: list[dict[str, Any]] = []

    # Structure input node
    nodes.append({
        "id": _make_node_id(0),
        "type": "structure_input",
        "x": positions[0][0],
        "y": positions[0][1],
        "params": {},
    })

    for i, job in enumerate(all_jobs):
        idx = i + 1
        node = _job_to_node(job, idx, positions[idx][0], positions[idx][1])
        nodes.append(node)

        if job.is_subflow:
            warnings.append(
                f"Node '{job.func_name}' is a dynamic @subflow. "
                "Fan-out behavior cannot be statically represented."
            )
        if job.is_conditional:
            warnings.append(
                f"Node '{job.func_name}' is inside a conditional branch. "
                "Both branches are shown; mark as conditional."
            )
        mapping = RECIPE_TO_CATGO.get(job.recipe_path)
        if mapping is None and not job.is_subflow:
            warnings.append(
                f"Unknown recipe '{job.recipe_path}' mapped to custom_job fallback."
            )

    # Create edges
    edges: list[dict[str, Any]] = []
    for e in adjusted_edges:
        src_id = _make_node_id(e["source_idx"])
        tgt_id = _make_node_id(e["target_idx"])
        edges.append({
            "id": f"e-{src_id}-{tgt_id}",
            "from": src_id,
            "to": tgt_id,
            "fromH": "out-0",
            "toH": "in-0",
        })

    return {"nodes": nodes, "edges": edges, "warnings": warnings}


# ---------------------------------------------------------------------------
# Public API: Declarative job-list conversion
# ---------------------------------------------------------------------------

def quacc_jobs_to_catgo(jobs: list[dict[str, Any]]) -> dict[str, Any]:
    """Convert a list of job description dicts to a CatGo workflow graph.

    Each job dict has::

        {
            "id": "job_1",              # optional, auto-generated if missing
            "recipe": "quacc.recipes.vasp.core.relax_job",
            "kwargs": {"ENCUT": 600},   # optional
            "depends_on": ["job_0"],    # optional, list of job IDs
        }

    Parameters
    ----------
    jobs : list[dict]
        Ordered list of job descriptions.

    Returns
    -------
    dict
        ``{"nodes": [...], "edges": [...], "warnings": [...]}``
    """
    warnings: list[str] = []

    # Assign IDs if missing
    for i, job in enumerate(jobs):
        if "id" not in job:
            job["id"] = f"job_{i}"

    job_id_to_idx: dict[str, int] = {}
    for i, job in enumerate(jobs):
        job_id_to_idx[job["id"]] = i

    # Build edge list
    edge_defs: list[dict] = []
    for i, job in enumerate(jobs):
        for dep_id in job.get("depends_on", []):
            if dep_id in job_id_to_idx:
                edge_defs.append({
                    "source_idx": job_id_to_idx[dep_id] + 1,  # +1 for structure_input
                    "target_idx": i + 1,
                })

    # Find root jobs (no depends_on)
    root_indices = [i for i, job in enumerate(jobs) if not job.get("depends_on")]
    for ri in root_indices:
        edge_defs.append({"source_idx": 0, "target_idx": ri + 1})

    n_total = len(jobs) + 1
    positions = _topological_layout(n_total, edge_defs)

    # Create nodes
    nodes: list[dict[str, Any]] = []

    # Structure input
    nodes.append({
        "id": _make_node_id(0),
        "type": "structure_input",
        "x": positions[0][0],
        "y": positions[0][1],
        "params": {},
    })

    for i, job in enumerate(jobs):
        idx = i + 1
        recipe_path = job.get("recipe", "")
        kwargs = job.get("kwargs", {})
        mapping = RECIPE_TO_CATGO.get(recipe_path)

        if mapping is None:
            node_type = "custom_job"
            params = {
                "label": recipe_path.split(".")[-1] if recipe_path else f"job_{i}",
                "recipe": recipe_path,
                "_warning": f"Unknown quacc recipe '{recipe_path}'.",
            }
            warnings.append(f"Unknown recipe '{recipe_path}' for job '{job['id']}'.")
        else:
            node_type = mapping.catgo_type
            params = extract_recipe_params(recipe_path, kwargs)
            if mapping.description:
                params["label"] = mapping.description

        nodes.append({
            "id": _make_node_id(idx),
            "type": node_type,
            "x": positions[idx][0],
            "y": positions[idx][1],
            "params": params,
        })

    # Create edges
    edges: list[dict[str, Any]] = []
    for e in edge_defs:
        src_id = _make_node_id(e["source_idx"])
        tgt_id = _make_node_id(e["target_idx"])
        edges.append({
            "id": f"e-{src_id}-{tgt_id}",
            "from": src_id,
            "to": tgt_id,
            "fromH": "out-0",
            "toH": "in-0",
        })

    return {"nodes": nodes, "edges": edges, "warnings": warnings}


# ---------------------------------------------------------------------------
# Self-test
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    # Test 1: simple linear flow
    test_source = '''
from quacc.recipes.vasp.core import relax_job, static_job

@flow
def my_flow(atoms):
    result1 = relax_job(atoms)
    result2 = static_job(result1["atoms"])
    return result2
'''
    result = parse_quacc_flow(test_source)
    assert len(result["nodes"]) == 3, f"Expected 3 nodes, got {len(result['nodes'])}"
    assert len(result["edges"]) == 2, f"Expected 2 edges, got {len(result['edges'])}"
    assert result["nodes"][0]["type"] == "structure_input"
    assert result["nodes"][1]["type"] == "geo_opt"
    assert result["nodes"][2]["type"] == "single_point"
    print("Test 1 (linear flow) passed")

    # Test 2: fan-out flow
    test_source_2 = '''
from quacc.recipes.vasp.core import static_job, non_scf_job

@flow
def band_flow(atoms):
    result1 = static_job(atoms)
    result2 = non_scf_job(result1)
    result3 = non_scf_job(result1)
    return result3
'''
    result2 = parse_quacc_flow(test_source_2)
    assert len(result2["nodes"]) == 4  # input + 3 jobs
    print("Test 2 (fan-out) passed")

    # Test 3: declarative job list
    test_jobs = [
        {"recipe": "quacc.recipes.vasp.core.relax_job", "kwargs": {"ENCUT": 600}},
        {"recipe": "quacc.recipes.vasp.core.static_job", "depends_on": ["job_0"]},
    ]
    result3 = quacc_jobs_to_catgo(test_jobs)
    assert len(result3["nodes"]) == 3
    assert len(result3["edges"]) == 2
    print("Test 3 (declarative) passed")

    print("All converter tests passed.")

"""Resolve task inputs by reading parent task results from DB."""
from __future__ import annotations
import json
from typing import Any
from catgo.workflow.db import WorkflowDB

_ALIASES = {"frequencies": "real_freqs_json"}

# Map builtin result keys to DB column names
_KEY_TO_COLUMN = {
    "structure": "structure_json",
    "frequencies": "real_freqs_json",
    "imag_frequencies": "imag_freqs_json",
    "positions": "positions_json",
    "masses": "masses_json",
}


def _extract_value(result: dict, source_key: str) -> Any:
    """Look up source_key in a task_results row, trying multiple strategies."""
    # 1. Direct column match
    if source_key in result:
        return result[source_key]
    # 2. Try with _json suffix
    json_key = source_key + "_json"
    if json_key in result:
        return result[json_key]
    # 3. Known aliases
    alias = _ALIASES.get(source_key)
    if alias and alias in result:
        return result[alias]
    # 4. Fallback: parse outputs_json
    raw = result.get("outputs_json")
    if raw:
        try:
            outputs = json.loads(raw)
            if source_key in outputs:
                return outputs[source_key]
        except (json.JSONDecodeError, TypeError):
            pass
    return None


def primary_structure_input(structure_value: Any) -> Any:
    """When several parents connect to the same ``structure`` port, the value is a list.

    Engines that expect a single structure string should use the first entry.
    """
    if isinstance(structure_value, list) and structure_value:
        return structure_value[0]
    return structure_value


def resolve_task_inputs(db: WorkflowDB, task_id: str) -> dict[str, Any]:
    """Resolve all input references for a task.

    Reads task_links to find parent tasks, then reads their results
    from task_results table. Returns {target_key: value}.

    If multiple links share the same ``target_key`` (e.g. many Structure Input
    nodes into one ``structure`` port), values are collected in **list** order.
    """
    links = db.get_task_parents(task_id)
    if not links:
        return {}
    buckets: dict[str, list[Any]] = {}
    for link in links:
        tk = link["target_key"]
        result = db.get_result(link["source_task_id"])
        if result is None:
            val = None
        else:
            val = _extract_value(result, link["source_key"])
        buckets.setdefault(tk, []).append(val)

    inputs: dict[str, Any] = {}
    for tk, vals in buckets.items():
        non_null = [v for v in vals if v is not None]
        if not non_null:
            inputs[tk] = None
        elif len(non_null) == 1:
            inputs[tk] = non_null[0]
        else:
            inputs[tk] = non_null
    return inputs

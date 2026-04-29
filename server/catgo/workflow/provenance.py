"""Lightweight provenance tracking — hash-based lineage for task results."""

from __future__ import annotations

import hashlib
import json
import logging
from typing import Any

from catgo.workflow.db import WorkflowDB

logger = logging.getLogger(__name__)


def _extract_result_value(result: dict, source_key: str) -> Any:
    """Look up source_key in a task_results row, trying _json suffix fallback.

    Mirrors resolver._extract_value logic but avoids circular import.
    """
    if source_key in result:
        return result[source_key]
    json_key = source_key + "_json"
    if json_key in result:
        return result[json_key]
    raw = result.get("outputs_json")
    if raw:
        try:
            outputs = json.loads(raw)
            if source_key in outputs:
                return outputs[source_key]
        except (json.JSONDecodeError, TypeError):
            pass
    return None


def _hash_value(value: Any) -> str:
    """SHA-256 hash of a value (first 16 hex chars)."""
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, default=str).encode()
    ).hexdigest()[:16]


def record_provenance(
    db: WorkflowDB,
    workflow_id: str,
    task_id: str,
    results: dict,
    task: dict,
) -> None:
    """Record provenance for all output keys of a completed task.

    Called after store_result in the scanner. For each key in results,
    computes a content hash and records the hashes of upstream inputs
    that fed into this task.
    """
    # Build input_hashes from parent links
    input_hashes: dict[str, str] = {}
    for link in db.get_task_parents(task_id):
        parent_result = db.get_result(link["source_task_id"])
        if parent_result:
            parent_val = _extract_result_value(parent_result, link["source_key"])
            if parent_val is not None:
                input_hashes[link["source_key"]] = _hash_value(parent_val)

    for key, value in results.items():
        if value is None:
            continue
        value_hash = _hash_value(value)
        db.record_provenance(
            workflow_id=workflow_id,
            task_id=task_id,
            output_key=key,
            value_hash=value_hash,
            input_hashes=json.dumps(input_hashes),
            software=task.get("software"),
        )

    logger.debug("Recorded provenance for task %s (%d keys)", task_id, len(results))


def trace_provenance(
    db: WorkflowDB,
    task_id: str,
    output_key: str,
) -> dict | None:
    """Trace where a specific result came from.

    Returns a dict with task info, input lineage, and output hash,
    or None if no provenance record exists.
    """
    records = db.get_provenance(task_id, output_key)
    if not records:
        return None

    record = records[0]
    input_hashes = json.loads(record.get("input_hashes") or "{}")

    # Resolve each input hash to its source task
    inputs: dict[str, dict] = {}
    for key, h in input_hashes.items():
        sources = db.find_provenance_by_hash(h)
        if sources:
            src = sources[0]
            inputs[key] = {
                "from_task": src["task_id"],
                "output_key": src["output_key"],
                "hash": h,
            }
        else:
            inputs[key] = {"hash": h}

    try:
        task = db.get_task(task_id)
        task_type = task.get("task_type")
    except KeyError:
        task_type = None

    return {
        "task_id": task_id,
        "task_type": task_type,
        "output_key": output_key,
        "output_hash": record.get("value_hash"),
        "software": record.get("software"),
        "inputs": inputs,
        "created_at": record.get("created_at"),
    }


def find_duplicate(
    db: WorkflowDB,
    task_type: str,
    input_hashes: dict[str, str],
    params_hash: str,
) -> str | None:
    """Check if an identical computation already exists.

    Searches provenance records for a task of the same type whose
    input hashes and parameter hash match exactly. Returns the
    existing task_id or None.
    """
    # Build a combined fingerprint: task_type + sorted input hashes + params
    fingerprint = _hash_value({
        "task_type": task_type,
        "input_hashes": input_hashes,
        "params_hash": params_hash,
    })

    # Search all provenance records that share any input hash
    candidate_tasks: set[str] = set()
    if not input_hashes:
        # No input constraint — scan all provenance records for matching task_type
        conn = db._get_conn()
        rows = conn.execute(
            "SELECT DISTINCT task_id FROM provenance WHERE software IS NOT NULL"
        ).fetchall()
        conn.close()
        for row in rows:
            candidate_tasks.add(row["task_id"])
    else:
        for h in input_hashes.values():
            for rec in db.find_provenance_by_hash(h):
                candidate_tasks.add(rec["task_id"])

    # Check each candidate for full match
    for cand_task_id in candidate_tasks:
        try:
            cand_task = db.get_task(cand_task_id)
        except KeyError:
            continue
        if cand_task.get("task_type") != task_type:
            continue

        # Check that this candidate's provenance has matching input hashes
        cand_records = db.get_provenance(cand_task_id)
        if not cand_records:
            continue

        cand_input_hashes = json.loads(cand_records[0].get("input_hashes") or "{}")

        # Also hash the candidate's params for comparison
        cand_params = json.loads(cand_task.get("params_json") or "{}")
        cand_params_hash = _hash_value(cand_params)

        cand_fingerprint = _hash_value({
            "task_type": task_type,
            "input_hashes": cand_input_hashes,
            "params_hash": cand_params_hash,
        })

        if cand_fingerprint == fingerprint:
            logger.info("Found duplicate: task %s matches %s", cand_task_id, task_type)
            return cand_task_id

    return None

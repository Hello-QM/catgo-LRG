#!/usr/bin/env python3
"""Publish a finished compute node's result to the CatGo viewer.

A workflow node used to end at `db.store_result(...)`: the outputs went into
SQLite and stopped. Seeing them required a human to open the workflow editor and
click the node, so an agent running a campaign unattended showed nothing while
it worked. This turns node completion into a viewer event.

Called from `WorkflowDB.store_result` — the single method every collector
(result_handler, collector, scanner, control_flow) funnels through.

Design rules:
  * never raise — a display side-effect must not fail a run that already
    completed on HPC;
  * never re-derive physics — forward what the collector actually stored, plus
    the field names it stored, so the UI can say what arrived without guessing;
  * carry geometry verbatim (the collectors store it as XYZ text or as a dict),
    and let the frontend's existing parsers handle the format.
"""

from __future__ import annotations

import json
import logging
from typing import Any

logger = logging.getLogger(__name__)

# Result fields worth surfacing directly; everything else is reported by name
# only. Keep this list to values a viewer can act on, not a metadata dump.
_SCALARS = (
    "energy", "final_energy", "converged", "band_gap", "barrier",
    "n_images", "n_frames", "max_force", "task_type", "software",
)


def _as_obj(value: Any) -> Any:
    """outputs_json arrives as a JSON string from most collectors and as a dict
    from a few. Accept both; never guess at a malformed one."""
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, str):
        try:
            return json.loads(value)
        except (TypeError, ValueError):
            return None
    return None


def build_payload(task_id: str, workflow_id: str, fields: dict) -> dict | None:
    """Shape one node result for the viewer. Returns None when there is nothing
    to show (an empty write, or a collector that stored only an error)."""
    if not isinstance(fields, dict) or not fields:
        return None

    outputs = _as_obj(fields.get("outputs_json"))
    payload: dict[str, Any] = {
        "task_id": str(task_id),
        "workflow_id": str(workflow_id),
        "fields": sorted(k for k in fields if fields[k] not in (None, "")),
    }

    if isinstance(outputs, dict):
        # A collector that failed stores {"error": ...} instead of results —
        # forward it as an error rather than a result nobody can read.
        if outputs.get("error"):
            payload["error"] = str(outputs["error"])
        payload["outputs"] = sorted(outputs)
        for key in _SCALARS:
            if key in outputs and isinstance(outputs[key], (int, float, str, bool)):
                payload[key] = outputs[key]
        # series a plot can draw immediately (NEB image energies, opt traces)
        for key in ("image_energies", "energies", "frequencies"):
            seq = outputs.get(key)
            if isinstance(seq, list) and seq and all(
                isinstance(v, (int, float)) for v in seq
            ):
                payload[key] = seq

    geometry = fields.get("structure_json")
    parsed_geometry = _as_obj(geometry)
    if isinstance(parsed_geometry, dict) and parsed_geometry:
        # a serialized structure dict — check this BEFORE the text branch, or a
        # JSON payload would be shipped as if it were XYZ and fail to parse
        payload["structure"] = parsed_geometry
    elif isinstance(geometry, str) and geometry.strip():
        # collectors store the converged geometry as XYZ text (e.g. the ORCA
        # NEB-TS structure); the frontend already parses every format it needs
        payload["structure_text"] = geometry
        payload["structure_filename"] = f"{task_id}.xyz"

    # Nothing a viewer can act on and nothing to report: stay quiet.
    if len(payload) == 3 and not payload["fields"]:
        return None
    return payload


def announce_node_result(task_id: str, workflow_id: str, fields: dict) -> None:
    """Publish, best-effort. Import is lazy so the workflow DB stays usable in
    contexts with no FastAPI app (CLI, tests, offline analysis)."""
    try:
        payload = build_payload(task_id, workflow_id, fields)
        if payload is None:
            return
        from catgo.routers import view_state

        view_state.announce_result("node", payload)
    except Exception:  # pragma: no cover - display must never break compute
        logger.debug("announce_node_result(%s) failed", task_id, exc_info=True)


if __name__ == "__main__":
    ok = build_payload("t1", "wf1", {
        "outputs_json": json.dumps({
            "energy": -123.45, "converged": True,
            "image_energies": [0.0, 0.31, 0.12],
            "note": "ignored-by-name-only",
        }),
        "structure_json": "3\nTS\nO 0 0 0\nH 0 0 1\nH 0 1 0\n",
    })
    assert ok["energy"] == -123.45 and ok["converged"] is True, ok
    assert ok["image_energies"] == [0.0, 0.31, 0.12], ok
    assert ok["structure_text"].startswith("3\n") and ok["structure_filename"] == "t1.xyz"
    assert "note" in ok["outputs"] and "note" not in ok  # named, not inlined

    err = build_payload("t2", "wf1", {"outputs_json": json.dumps({"error": "boom"})})
    assert err["error"] == "boom" and "energy" not in err, err

    assert build_payload("t3", "wf1", {}) is None
    assert build_payload("t4", "wf1", {"outputs_json": "not json"})["fields"] == ["outputs_json"]

    d = build_payload("t5", "wf1", {"structure_json": {"sites": [{"label": "Pt"}]}})
    assert d["structure"]["sites"][0]["label"] == "Pt", d

    announce_node_result("t6", "wf1", {"outputs_json": "{}"})  # no viewer: must not raise
    print("viewer_publish self-test OK — forwards what the collector stored, "
          "names the rest, reports errors as errors, and never raises")

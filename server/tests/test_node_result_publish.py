"""A finished compute node must reach the viewer, not just SQLite.

Before this, `db.store_result(...)` was the end of the line: outputs went into
the database and the only way to see them was for a human to open the workflow
editor and click the node — which an unattended agent run never does.
`store_result` is the one method every collector funnels through
(result_handler, collector, scanner, control_flow), so it is where the viewer
event belongs.
"""

import asyncio
import json

import pytest

from catgo.routers import view_state
from catgo.workflow.viewer_publish import announce_node_result, build_payload


def setup_function():
    view_state.reset()


def teardown_function():
    view_state.reset()


def _drain(q: asyncio.Queue) -> list[dict]:
    out = []
    while not q.empty():
        out.append(q.get_nowait())
    return out


# ---- payload shaping ------------------------------------------------------
def test_scalars_and_series_the_ui_can_draw_are_forwarded():
    p = build_payload("t1", "wf1", {"outputs_json": json.dumps({
        "energy": -876.5, "converged": True, "barrier": 0.83,
        "image_energies": [0.0, 0.42, 0.83, 0.31, 0.0],
        "raw_blob": {"huge": "nested"},
    })})
    assert p["energy"] == -876.5 and p["converged"] is True and p["barrier"] == 0.83
    assert p["image_energies"] == [0.0, 0.42, 0.83, 0.31, 0.0]
    # a nested blob is named, never inlined — the event stays small
    assert "raw_blob" in p["outputs"] and "raw_blob" not in p


def test_a_collector_error_is_reported_as_an_error():
    p = build_payload("t2", "wf1", {"outputs_json": json.dumps(
        {"error": "Result collection failed: no such file", "error_type": "OSError"})})
    assert p["error"].startswith("Result collection failed")


def test_converged_geometry_rides_along_in_whatever_form_it_was_stored():
    xyz = "3\nTS\nO 0 0 0\nH 0 0 1\nH 0 1 0\n"
    p = build_payload("neb-1", "wf1", {"structure_json": xyz})
    assert p["structure_text"] == xyz and p["structure_filename"] == "neb-1.xyz"

    d = build_payload("t3", "wf1", {"structure_json": {"sites": [{"label": "Pt"}]}})
    assert d["structure"]["sites"][0]["label"] == "Pt"

    j = build_payload("t4", "wf1", {"structure_json": json.dumps({"sites": [{"label": "Ir"}]})})
    assert j["structure"]["sites"][0]["label"] == "Ir"


def test_an_empty_write_produces_no_event():
    assert build_payload("t5", "wf1", {}) is None


def test_malformed_outputs_still_report_which_fields_arrived():
    p = build_payload("t6", "wf1", {"outputs_json": "<not json>"})
    assert p["fields"] == ["outputs_json"] and "outputs" not in p


# ---- transport ------------------------------------------------------------
def test_announce_reaches_the_panel_the_user_is_on():
    view_state.mark_active("structure-1")
    q = view_state.subscribe("structure-1")

    announce_node_result("t7", "wf1", {"outputs_json": json.dumps({"energy": -1.0})})

    events = _drain(q)
    assert [e["event"] for e in events] == ["result"]
    assert events[0]["data"]["kind"] == "node"
    assert events[0]["data"]["task_id"] == "t7" and events[0]["data"]["energy"] == -1.0


def test_publishing_never_breaks_the_run_that_produced_the_data(monkeypatch):
    monkeypatch.setattr(
        view_state, "announce_result",
        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")),
    )
    announce_node_result("t8", "wf1", {"outputs_json": "{}"})  # must not raise


def test_store_result_publishes_from_the_one_method_every_collector_uses(tmp_path):
    # The behaviour under test is the wiring itself: result_handler, collector,
    # scanner and control_flow all call db.store_result, so hooking it covers
    # every engine without touching a single collector.
    from catgo.workflow.db import WorkflowDB

    db = WorkflowDB(str(tmp_path / "wf.db"))
    wf_id = db.create_workflow("t")
    task_id = db.create_task(wf_id, "geo_opt", task_id="task-9")
    assert task_id == "task-9"
    view_state.mark_active("default")
    q = view_state.subscribe("default")

    db.store_result("task-9", wf_id, outputs_json=json.dumps({"energy": -42.0}))

    events = _drain(q)
    assert [e["data"]["task_id"] for e in events] == ["task-9"]
    assert events[0]["data"]["energy"] == -42.0
    # and it really did persist — the display hook must not replace the write
    assert db.get_result("task-9") is not None


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))

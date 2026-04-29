"""Tests for map_task fan-out operation."""

import asyncio
import json
import os
import tempfile

from catgo.workflow.db import WorkflowDB
from catgo.workflow.workflow import Workflow, MapHandle
from catgo.workflow.engine.scanner import WorkflowEngine


def _make_db():
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    return WorkflowDB(path), path


def test_map_creates_children():
    db, path = _make_db()
    try:
        wf = Workflow("map test", db=db)
        mapped = wf.map_task(
            "structure_input",
            over={"structure": ['{"a":1}', '{"a":2}', '{"a":3}']},
        )
        assert isinstance(mapped, MapHandle)
        assert len(mapped.child_ids) == 3

        children = db.get_children_of(mapped.map_task_id)
        assert len(children) == 3
        assert children[0]["map_key"] == "0"
        assert children[1]["map_key"] == "1"
        assert children[2]["map_key"] == "2"

        # Controller task should be in MAPPED state
        controller = db.get_task(mapped.map_task_id)
        assert controller["status"] == "MAPPED"
        assert controller["task_type"] == "__map__"
    finally:
        os.unlink(path)


def test_map_over_must_have_one_key():
    db, path = _make_db()
    try:
        wf = Workflow("map bad", db=db)
        try:
            wf.map_task("structure_input", over={"a": [1], "b": [2]})
            assert False, "Should have raised ValueError"
        except ValueError as e:
            assert "exactly one key" in str(e)
    finally:
        os.unlink(path)


def test_map_children_execute():
    db, path = _make_db()
    try:
        wf = Workflow("map exec", db=db)
        mapped = wf.map_task(
            "structure_input",
            over={"structure": ['{"a":1}', '{"a":2}', '{"a":3}']},
        )
        wf.submit()

        engine = WorkflowEngine(db=db)
        loop = asyncio.new_event_loop()
        # First cycle: advance WAITING -> READY
        loop.run_until_complete(engine.scan_cycle())
        # Second cycle: execute READY local tasks
        loop.run_until_complete(engine.scan_cycle())
        loop.close()

        # All children should complete
        children = db.get_children_of(mapped.map_task_id)
        completed = [c for c in children if c["status"] == "COMPLETED"]
        assert len(completed) == 3
    finally:
        os.unlink(path)


def test_map_gather():
    db, path = _make_db()
    try:
        wf = Workflow("gather test", db=db)
        mapped = wf.map_task(
            "structure_input",
            over={"structure": ['{"a":1}', '{"a":2}']},
        )
        wf.submit()

        engine = WorkflowEngine(db=db)
        loop = asyncio.new_event_loop()
        loop.run_until_complete(engine.scan_cycle())
        loop.run_until_complete(engine.scan_cycle())
        loop.close()

        results = mapped.gather("structure_json")
        assert len(results) == 2
        assert results[0] == '{"a":1}'
        assert results[1] == '{"a":2}'
    finally:
        os.unlink(path)


def test_map_with_common_kwargs():
    """Verify that common kwargs are passed to all children."""
    db, path = _make_db()
    try:
        wf = Workflow("map common", db=db)
        mapped = wf.map_task(
            "single_point",
            over={"ENCUT": [400, 500, 600]},
            NSW=0,
        )
        assert len(mapped.child_ids) == 3

        # Check that each child has the common params
        for cid in mapped.child_ids:
            task = db.get_task(cid)
            params = json.loads(task["params_json"])
            assert params["NSW"] == 0
            assert "ENCUT" in params
    finally:
        os.unlink(path)


def test_map_controller_name():
    db, path = _make_db()
    try:
        wf = Workflow("map name", db=db)
        mapped = wf.map_task(
            "structure_input",
            over={"structure": ['a', 'b']},
        )
        controller = db.get_task(mapped.map_task_id)
        assert "map(structure_input, n=2)" in controller["name"]
    finally:
        os.unlink(path)

"""Tests for Zone (named task groups) — P8 Feature 2."""

import asyncio
import pytest

from catgo.workflow.db import WorkflowDB
from catgo.workflow.workflow import Workflow, Zone
from catgo.workflow.states import TaskState
from catgo.workflow.reference import OutputReference

# Ensure builtins are registered (structure_input, __zone__, etc.)
import catgo.workflow.builtins  # noqa: F401


class TestZoneCreation:
    """Zone API and DB structure tests."""

    @pytest.fixture
    def db(self, tmp_path):
        return WorkflowDB(str(tmp_path / "test.db"))

    def test_zone_creates_zone_task(self, db):
        """zone() should create a __zone__ task in the DB."""
        wf = Workflow("test", db=db)
        z = wf.zone("relaxation")

        task = db.get_task(z.zone_task_id)
        assert task["task_type"] == "__zone__"
        assert task["name"] == "relaxation"
        assert task["workflow_id"] == wf.workflow_id

    def test_zone_children_have_parent_set(self, db):
        """Tasks added via zone.add_task() should have parent_task_id set."""
        wf = Workflow("test", db=db)
        z = wf.zone("opt_group")

        h1 = z.add_task("structure_input", structure={"fake": True})
        h2 = z.add_task("structure_input", structure={"fake": True})

        t1 = db.get_task(h1.task_id)
        t2 = db.get_task(h2.task_id)
        assert t1["parent_task_id"] == z.zone_task_id
        assert t2["parent_task_id"] == z.zone_task_id

    def test_zone_children_tracked_internally(self, db):
        """Zone._child_ids should track all children in order."""
        wf = Workflow("test", db=db)
        z = wf.zone("group")

        h1 = z.add_task("structure_input", structure={})
        h2 = z.add_task("structure_input", structure={})

        assert z._child_ids == [h1.task_id, h2.task_id]

    def test_zone_output_forwards_to_last_child(self, db):
        """zone.output should reference the last child task."""
        wf = Workflow("test", db=db)
        z = wf.zone("group")

        h1 = z.add_task("structure_input", structure={})
        h2 = z.add_task("structure_input", structure={})

        ref = z.output
        assert isinstance(ref, OutputReference)
        assert ref.task_id == h2.task_id

    def test_zone_output_empty_zone(self, db):
        """Empty zone output should reference the zone task itself."""
        wf = Workflow("test", db=db)
        z = wf.zone("empty")

        ref = z.output
        assert isinstance(ref, OutputReference)
        assert ref.task_id == z.zone_task_id

    def test_get_children_of(self, db):
        """DB.get_children_of should return zone children."""
        wf = Workflow("test", db=db)
        z = wf.zone("group")

        h1 = z.add_task("structure_input", structure={})
        h2 = z.add_task("structure_input", structure={})

        children = db.get_children_of(z.zone_task_id)
        child_ids = {c["id"] for c in children}
        assert child_ids == {h1.task_id, h2.task_id}


class TestZoneScanner:
    """Zone completion/failure tracking via the scanner."""

    @pytest.fixture
    def db(self, tmp_path):
        return WorkflowDB(str(tmp_path / "test.db"))

    def _run_scan(self, db, wf_id, config=None):
        """Run one scan cycle synchronously."""
        from catgo.workflow.engine.scanner import WorkflowEngine
        engine = WorkflowEngine(db, config or {})
        loop = asyncio.new_event_loop()
        try:
            loop.run_until_complete(engine.scan_cycle())
        finally:
            loop.close()

    def test_empty_zone_completes_immediately(self, db):
        """A zone with no children should complete on the first scan."""
        wf_id = db.create_workflow("test")
        db.update_workflow(wf_id, status="running")
        zone_id = db.create_task(wf_id, "__zone__", name="empty")

        # First scan: WAITING -> READY (no link parents)
        self._run_scan(db, wf_id)
        # Second scan: zone sees no children -> COMPLETED
        self._run_scan(db, wf_id)

        task = db.get_task(zone_id)
        assert task["status"] == TaskState.COMPLETED.value

    def test_zone_completes_when_children_done(self, db):
        """Zone should complete when all children are COMPLETED."""
        wf = Workflow("test", db=db)
        z = wf.zone("group")
        h1 = z.add_task("structure_input", structure={"fake": True})
        h2 = z.add_task("structure_input", structure={"fake": True})
        wf.submit()

        # Run multiple scans to let children advance and complete
        for _ in range(5):
            self._run_scan(db, wf.workflow_id)

        # Children should be COMPLETED (structure_input is local)
        t1 = db.get_task(h1.task_id)
        t2 = db.get_task(h2.task_id)
        assert t1["status"] == TaskState.COMPLETED.value
        assert t2["status"] == TaskState.COMPLETED.value

        # Zone should also be COMPLETED
        zone_task = db.get_task(z.zone_task_id)
        assert zone_task["status"] == TaskState.COMPLETED.value

    def test_zone_fails_when_child_fails(self, db):
        """Zone should FAIL if any child is FAILED."""
        wf_id = db.create_workflow("test")
        db.update_workflow(wf_id, status="running")

        zone_id = db.create_task(wf_id, "__zone__", name="group")
        c1 = db.create_task(wf_id, "structure_input")
        c2 = db.create_task(wf_id, "structure_input")
        db.update_task(c1, parent_task_id=zone_id)
        db.update_task(c2, parent_task_id=zone_id)

        # Simulate: c1 completed, c2 failed
        db.update_task(c1, status=TaskState.COMPLETED.value)
        db.update_task(c2, status=TaskState.FAILED.value)

        # Advance zone to READY first
        self._run_scan(db, wf_id)
        # Now zone should see the failed child
        self._run_scan(db, wf_id)

        zone_task = db.get_task(zone_id)
        assert zone_task["status"] == TaskState.FAILED.value

    def test_zone_waits_while_children_running(self, db):
        """Zone should stay WAITING while children are still active."""
        wf_id = db.create_workflow("test")
        db.update_workflow(wf_id, status="running")

        zone_id = db.create_task(wf_id, "__zone__", name="group")
        c1 = db.create_task(wf_id, "structure_input")
        c2 = db.create_task(wf_id, "structure_input")
        db.update_task(c1, parent_task_id=zone_id)
        db.update_task(c2, parent_task_id=zone_id)

        # Only c1 completed, c2 still running
        db.update_task(c1, status=TaskState.COMPLETED.value)
        db.update_task(c2, status=TaskState.RUNNING.value)

        # Advance zone to READY
        self._run_scan(db, wf_id)
        # Zone should go back to WAITING
        self._run_scan(db, wf_id)

        zone_task = db.get_task(zone_id)
        assert zone_task["status"] == TaskState.WAITING.value

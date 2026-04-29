"""Tests for WhileLoop (iterative convergence) — P8 Feature 3."""

import asyncio
import json
import pytest

from catgo.workflow.db import WorkflowDB
from catgo.workflow.workflow import Workflow, WhileLoop
from catgo.workflow.states import TaskState
from catgo.workflow.reference import OutputReference

# Ensure builtins are registered (structure_input, __while__, etc.)
import catgo.workflow.builtins  # noqa: F401


class TestWhileLoopCreation:
    """WhileLoop API and DB structure tests."""

    @pytest.fixture
    def db(self, tmp_path):
        return WorkflowDB(str(tmp_path / "test.db"))

    def test_while_creates_loop_task(self, db):
        """while_loop() should create a __while__ task in the DB."""
        wf = Workflow("test", db=db)
        loop = wf.while_loop("convergence", max_iterations=5)

        task = db.get_task(loop.loop_task_id)
        assert task["task_type"] == "__while__"
        assert task["name"] == "convergence"
        assert task["workflow_id"] == wf.workflow_id

        params = json.loads(task["params_json"])
        assert params["max_iterations"] == 5
        assert params["condition_key"] == "converged"
        assert params["condition_value"] is True

    def test_while_children_have_parent_set(self, db):
        """Tasks added via loop.add_task() should have parent_task_id set."""
        wf = Workflow("test", db=db)
        loop = wf.while_loop("loop")

        h1 = loop.add_task("structure_input", structure={"fake": True})
        h2 = loop.add_task("structure_input", structure={"fake": True})

        t1 = db.get_task(h1.task_id)
        t2 = db.get_task(h2.task_id)
        assert t1["parent_task_id"] == loop.loop_task_id
        assert t2["parent_task_id"] == loop.loop_task_id

    def test_while_children_tracked_internally(self, db):
        """WhileLoop._child_ids should track all children in order."""
        wf = Workflow("test", db=db)
        loop = wf.while_loop("loop")

        h1 = loop.add_task("structure_input", structure={})
        h2 = loop.add_task("structure_input", structure={})

        assert loop._child_ids == [h1.task_id, h2.task_id]

    def test_while_output_forwards_to_last_child(self, db):
        """loop.output should reference the last child task."""
        wf = Workflow("test", db=db)
        loop = wf.while_loop("loop")

        h1 = loop.add_task("structure_input", structure={})
        h2 = loop.add_task("structure_input", structure={})

        ref = loop.output
        assert isinstance(ref, OutputReference)
        assert ref.task_id == h2.task_id

    def test_while_output_empty_loop(self, db):
        """Empty loop output should reference the loop task itself."""
        wf = Workflow("test", db=db)
        loop = wf.while_loop("empty")

        ref = loop.output
        assert isinstance(ref, OutputReference)
        assert ref.task_id == loop.loop_task_id

    def test_get_children_of(self, db):
        """DB.get_children_of should return loop children."""
        wf = Workflow("test", db=db)
        loop = wf.while_loop("loop")

        h1 = loop.add_task("structure_input", structure={})
        h2 = loop.add_task("structure_input", structure={})

        children = db.get_children_of(loop.loop_task_id)
        child_ids = {c["id"] for c in children}
        assert child_ids == {h1.task_id, h2.task_id}

    def test_while_custom_condition(self, db):
        """while_loop should accept custom condition_key and condition_value."""
        wf = Workflow("test", db=db)
        loop = wf.while_loop(
            "custom",
            max_iterations=20,
            condition_key="max_force",
            condition_value=0.0,
        )

        task = db.get_task(loop.loop_task_id)
        params = json.loads(task["params_json"])
        assert params["condition_key"] == "max_force"
        assert params["condition_value"] == 0.0
        assert params["max_iterations"] == 20

    def test_feedback_creates_link(self, db):
        """loop.feedback() should create a task link."""
        wf = Workflow("test", db=db)
        loop = wf.while_loop("loop")

        h1 = loop.add_task("structure_input", structure={})
        h2 = loop.add_task("structure_input", structure={})

        loop.feedback(h2.output.structure, to_task=h1, key="structure")

        links = db.get_task_parents(h1.task_id)
        assert len(links) == 1
        assert links[0]["source_task_id"] == h2.task_id
        assert links[0]["target_key"] == "structure"


class TestWhileLoopScanner:
    """While loop iteration and convergence via the scanner."""

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

    def test_empty_while_completes_immediately(self, db):
        """A while loop with no children should complete on the first scan pass."""
        wf_id = db.create_workflow("test")
        db.update_workflow(wf_id, status="running")
        loop_id = db.create_task(
            wf_id, "__while__", name="empty",
            params={"max_iterations": 5, "condition_key": "converged", "condition_value": True},
        )

        # First scan: WAITING -> READY
        self._run_scan(db, wf_id)
        # Second scan: loop sees no children -> COMPLETED
        self._run_scan(db, wf_id)

        task = db.get_task(loop_id)
        assert task["status"] == TaskState.COMPLETED.value

        # Should have result with iterations=0
        result = db.get_result(loop_id)
        assert result is not None
        outputs = json.loads(result["outputs_json"])
        assert outputs["iterations"] == 0
        assert outputs["converged"] is True

    def test_while_completes_on_condition(self, db):
        """While loop should complete when condition is met after first iteration."""
        from catgo.workflow.task_decorator import task as task_decorator

        # Register a local task that returns converged=True
        @task_decorator(task_type="__test_converge__", local=True, outputs=["converged"])
        def test_converge(**kwargs):
            return {"converged": True}

        wf = Workflow("test", db=db)
        loop = wf.while_loop("conv-test", max_iterations=5)
        h1 = loop.add_task("structure_input", structure={"fake": True})
        h2 = loop.add_task("__test_converge__")
        wf.submit()

        # Run enough scans to let children complete and loop evaluate
        for _ in range(20):
            self._run_scan(db, wf.workflow_id)

        loop_task = db.get_task(loop.loop_task_id)
        assert loop_task["status"] == TaskState.COMPLETED.value

        result = db.get_result(loop.loop_task_id)
        assert result is not None
        outputs = json.loads(result["outputs_json"])
        assert outputs["converged"] is True
        assert outputs["iterations"] == 1

    def test_while_iterates_until_max(self, db):
        """While loop should iterate max_iterations times when condition never met."""
        from catgo.workflow.task_decorator import task as task_decorator

        # Register a local task that never converges
        @task_decorator(task_type="__test_no_converge__", local=True, outputs=["converged"])
        def test_no_converge(**kwargs):
            return {"converged": False}

        wf = Workflow("test", db=db)
        loop = wf.while_loop("no-conv", max_iterations=3)
        h1 = loop.add_task("structure_input", structure={"fake": True})
        h2 = loop.add_task("__test_no_converge__")
        wf.submit()

        # Run many scans to let it iterate (needs enough cycles for 3 full iterations)
        for _ in range(50):
            self._run_scan(db, wf.workflow_id)

        loop_task = db.get_task(loop.loop_task_id)
        assert loop_task["status"] == TaskState.COMPLETED.value

        result = db.get_result(loop.loop_task_id)
        assert result is not None
        outputs = json.loads(result["outputs_json"])
        assert outputs["converged"] is False
        assert outputs["iterations"] == 3

    def test_while_fails_on_child_failure(self, db):
        """While loop should FAIL if any child fails."""
        wf_id = db.create_workflow("test")
        db.update_workflow(wf_id, status="running")

        loop_id = db.create_task(
            wf_id, "__while__", name="fail-test",
            params={"max_iterations": 5, "condition_key": "converged", "condition_value": True},
        )
        c1 = db.create_task(wf_id, "structure_input")
        c2 = db.create_task(wf_id, "structure_input")
        db.update_task(c1, parent_task_id=loop_id)
        db.update_task(c2, parent_task_id=loop_id)

        # Simulate: c1 completed, c2 failed
        db.update_task(c1, status=TaskState.COMPLETED.value)
        db.update_task(c2, status=TaskState.FAILED.value)

        # Advance loop to READY first
        self._run_scan(db, wf_id)
        # Now loop should see the failed child
        self._run_scan(db, wf_id)

        loop_task = db.get_task(loop_id)
        assert loop_task["status"] == TaskState.FAILED.value

    def test_while_reports_iterations(self, db):
        """After completion, result should contain iteration count and converged flag."""
        from catgo.workflow.task_decorator import task as task_decorator

        # Register a task that converges on 2nd iteration (via a counter hack)
        _counter = {"n": 0}

        @task_decorator(task_type="__test_converge_2nd__", local=True, outputs=["converged"])
        def test_converge_2nd(**kwargs):
            _counter["n"] += 1
            return {"converged": _counter["n"] >= 2}

        wf = Workflow("test", db=db)
        loop = wf.while_loop("2nd-conv", max_iterations=5)
        loop.add_task("__test_converge_2nd__")
        wf.submit()

        for _ in range(40):
            self._run_scan(db, wf.workflow_id)

        loop_task = db.get_task(loop.loop_task_id)
        assert loop_task["status"] == TaskState.COMPLETED.value

        result = db.get_result(loop.loop_task_id)
        assert result is not None
        outputs = json.loads(result["outputs_json"])
        assert outputs["converged"] is True
        assert outputs["iterations"] == 2

    def test_while_waits_while_children_running(self, db):
        """While loop should stay WAITING while children are still active."""
        wf_id = db.create_workflow("test")
        db.update_workflow(wf_id, status="running")

        loop_id = db.create_task(
            wf_id, "__while__", name="wait-test",
            params={"max_iterations": 5, "condition_key": "converged", "condition_value": True},
        )
        c1 = db.create_task(wf_id, "structure_input")
        c2 = db.create_task(wf_id, "structure_input")
        db.update_task(c1, parent_task_id=loop_id)
        db.update_task(c2, parent_task_id=loop_id)

        # Only c1 completed, c2 still running
        db.update_task(c1, status=TaskState.COMPLETED.value)
        db.update_task(c2, status=TaskState.RUNNING.value)

        # Advance loop to READY
        self._run_scan(db, wf_id)
        # Loop should go back to WAITING
        self._run_scan(db, wf_id)

        loop_task = db.get_task(loop_id)
        assert loop_task["status"] == TaskState.WAITING.value

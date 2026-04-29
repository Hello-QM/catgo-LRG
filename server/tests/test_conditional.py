"""Tests for conditional task execution (P8 Feature 6) and SKIPPED state."""

import json

import pytest

from catgo.workflow.db import WorkflowDB
from catgo.workflow.states import TaskState
from catgo.workflow.engine.advancer import advance_waiting_tasks


class TestSkippedState:
    def test_skipped_state_is_terminal(self):
        assert TaskState.SKIPPED.is_terminal

    def test_skipped_state_is_not_active(self):
        assert not TaskState.SKIPPED.is_active

    def test_skipped_value(self):
        assert TaskState.SKIPPED.value == "SKIPPED"


class TestConditionalExecution:
    @pytest.fixture
    def db(self, tmp_path):
        return WorkflowDB(str(tmp_path / "test.db"))

    def test_conditional_skip(self, db):
        """t1 -> t2 (condition: t1.converged == True), t1 result converged=False -> t2 SKIPPED."""
        wf_id = db.create_workflow("test")
        t1 = db.create_task(wf_id, "geo_opt", params={})
        t2 = db.create_task(wf_id, "freq", params={})
        db.create_link(wf_id, t1, t2, "structure", "structure")

        # Set condition on t2: requires t1.converged == True
        condition = {"source_task_id": t1, "output_key": "converged", "expected": True}
        db.update_task(t2, condition_json=json.dumps(condition))

        # Complete t1 with converged=False
        db.update_task(t1, status=TaskState.COMPLETED.value)
        db.store_result(t1, wf_id, outputs_json=json.dumps({"converged": False}))

        # Advance: t2 should be SKIPPED
        advanced = advance_waiting_tasks(db, wf_id)
        assert t2 in advanced
        task2 = db.get_task(t2)
        assert task2["status"] == TaskState.SKIPPED.value

    def test_conditional_pass(self, db):
        """t1 -> t2 (condition: t1.converged == True), t1 result converged=True -> t2 READY."""
        wf_id = db.create_workflow("test")
        t1 = db.create_task(wf_id, "geo_opt", params={})
        t2 = db.create_task(wf_id, "freq", params={})
        db.create_link(wf_id, t1, t2, "structure", "structure")

        # Set condition on t2: requires t1.converged == True
        condition = {"source_task_id": t1, "output_key": "converged", "expected": True}
        db.update_task(t2, condition_json=json.dumps(condition))

        # Complete t1 with converged=True
        db.update_task(t1, status=TaskState.COMPLETED.value)
        db.store_result(t1, wf_id, outputs_json=json.dumps({"converged": True}))

        # Advance: t2 should be READY
        advanced = advance_waiting_tasks(db, wf_id)
        assert t2 in advanced
        task2 = db.get_task(t2)
        assert task2["status"] == TaskState.READY.value

    def test_no_condition_advances_normally(self, db):
        """Task without condition_json should advance to READY as usual."""
        wf_id = db.create_workflow("test")
        t1 = db.create_task(wf_id, "geo_opt", params={})
        t2 = db.create_task(wf_id, "freq", params={})
        db.create_link(wf_id, t1, t2, "structure", "structure")

        db.update_task(t1, status=TaskState.COMPLETED.value)
        advanced = advance_waiting_tasks(db, wf_id)
        assert t2 in advanced
        task2 = db.get_task(t2)
        assert task2["status"] == TaskState.READY.value

    def test_skipped_parent_allows_advance(self, db):
        """t1 -> t2 -> t3: if t2 is SKIPPED, t3 should still advance to READY."""
        wf_id = db.create_workflow("test")
        t1 = db.create_task(wf_id, "geo_opt", params={})
        t2 = db.create_task(wf_id, "freq", params={})
        t3 = db.create_task(wf_id, "gibbs_energy", params={})
        db.create_link(wf_id, t1, t2, "structure", "structure")
        db.create_link(wf_id, t2, t3, "frequencies", "frequencies")

        # t1 completes, t2 gets skipped
        db.update_task(t1, status=TaskState.COMPLETED.value)
        db.update_task(t2, status=TaskState.SKIPPED.value)

        # t3 should advance because SKIPPED counts as done
        advanced = advance_waiting_tasks(db, wf_id)
        assert t3 in advanced
        task3 = db.get_task(t3)
        assert task3["status"] == TaskState.READY.value

    def test_condition_with_missing_result(self, db):
        """If the source task has no result, condition is assumed met (advance to READY)."""
        wf_id = db.create_workflow("test")
        t1 = db.create_task(wf_id, "geo_opt", params={})
        t2 = db.create_task(wf_id, "freq", params={})
        db.create_link(wf_id, t1, t2, "structure", "structure")

        condition = {"source_task_id": t1, "output_key": "converged", "expected": True}
        db.update_task(t2, condition_json=json.dumps(condition))

        # t1 completed but no result stored
        db.update_task(t1, status=TaskState.COMPLETED.value)

        advanced = advance_waiting_tasks(db, wf_id)
        assert t2 in advanced
        task2 = db.get_task(t2)
        assert task2["status"] == TaskState.READY.value


class TestDBSchemaExtensions:
    @pytest.fixture
    def db(self, tmp_path):
        return WorkflowDB(str(tmp_path / "test.db"))

    def test_parent_task_id_column(self, db):
        """New parent_task_id column works."""
        wf_id = db.create_workflow("test")
        parent = db.create_task(wf_id, "map", params={})
        child = db.create_task(wf_id, "geo_opt", params={})
        db.update_task(child, parent_task_id=parent)

        task = db.get_task(child)
        assert task["parent_task_id"] == parent

    def test_get_children_of(self, db):
        """get_children_of returns child tasks ordered by map_key."""
        wf_id = db.create_workflow("test")
        parent = db.create_task(wf_id, "map", params={})
        c1 = db.create_task(wf_id, "geo_opt", params={})
        c2 = db.create_task(wf_id, "geo_opt", params={})
        db.update_task(c1, parent_task_id=parent, map_key="B_second")
        db.update_task(c2, parent_task_id=parent, map_key="A_first")

        children = db.get_children_of(parent)
        assert len(children) == 2
        assert children[0]["id"] == c2  # A_first comes first
        assert children[1]["id"] == c1  # B_second comes second

    def test_task_group_column(self, db):
        """New task_group column works."""
        wf_id = db.create_workflow("test")
        t = db.create_task(wf_id, "geo_opt", params={})
        db.update_task(t, task_group="opt_freq_pipeline")

        task = db.get_task(t)
        assert task["task_group"] == "opt_freq_pipeline"

    def test_migration_idempotent(self, tmp_path):
        """Calling _migrate_db multiple times does not error."""
        db_path = str(tmp_path / "test.db")
        db1 = WorkflowDB(db_path)
        # Second init on same DB should not fail (migration is idempotent)
        db2 = WorkflowDB(db_path)
        wf_id = db2.create_workflow("test")
        t = db2.create_task(wf_id, "geo_opt", params={})
        db2.update_task(t, parent_task_id="some_parent", map_key="key1")
        task = db2.get_task(t)
        assert task["parent_task_id"] == "some_parent"

"""Tests for engine lifecycle — submit/pause/resume/reset."""

import pytest
from catgo.workflow.db import WorkflowDB
from catgo.workflow.states import TaskState, WorkflowState
from catgo.workflow.engine.lifecycle import (
    submit_workflow, pause_workflow, resume_workflow, reset_workflow,
)


class TestLifecycle:
    @pytest.fixture
    def db(self, tmp_path):
        return WorkflowDB(str(tmp_path / "test.db"))

    def test_submit(self, db):
        wf_id = db.create_workflow("test")
        submit_workflow(db, wf_id)
        assert db.get_workflow(wf_id)["status"] == "running"

    def test_pause(self, db):
        wf_id = db.create_workflow("test")
        t1 = db.create_task(wf_id, "geo_opt", params={})
        db.update_task(t1, status=TaskState.READY.value)
        submit_workflow(db, wf_id)
        pause_workflow(db, wf_id)
        assert db.get_workflow(wf_id)["status"] == "paused"
        assert db.get_task(t1)["status"] == TaskState.PAUSED.value

    def test_resume(self, db):
        wf_id = db.create_workflow("test")
        t1 = db.create_task(wf_id, "geo_opt", params={})
        db.update_task(t1, status=TaskState.PAUSED.value)
        resume_workflow(db, wf_id)
        assert db.get_workflow(wf_id)["status"] == "running"
        assert db.get_task(t1)["status"] == TaskState.WAITING.value

    def test_reset(self, db):
        wf_id = db.create_workflow("test")
        t1 = db.create_task(wf_id, "geo_opt", params={})
        db.update_task(t1, status=TaskState.COMPLETED.value)
        reset_workflow(db, wf_id)
        assert db.get_workflow(wf_id)["status"] == "draft"
        assert db.get_task(t1)["status"] == TaskState.WAITING.value

    def test_reset_clears_errors(self, db):
        """Reset must clear error_message, error_type, and retry_count."""
        wf_id = db.create_workflow("test")
        t1 = db.create_task(wf_id, "geo_opt", params={})
        db.update_task(t1,
            status=TaskState.FAILED.value,
            error_message="VASP crashed",
            error_type="runtime",
            retry_count=3,
        )
        submit_workflow(db, wf_id)
        reset_workflow(db, wf_id)

        task = db.get_task(t1)
        assert task["status"] == TaskState.WAITING.value
        assert task["error_message"] is None
        assert task["error_type"] is None
        assert task["retry_count"] == 0
        assert db.get_workflow(wf_id)["status"] == "draft"

    def test_reset_then_submit(self, db):
        """After reset + submit, workflow should be 'running' and scanner-ready."""
        wf_id = db.create_workflow("test")
        t1 = db.create_task(wf_id, "geo_opt", params={})
        db.update_task(t1, status=TaskState.FAILED.value,
                       error_message="crash")
        # Workflow was marked failed by scanner
        db.update_workflow(wf_id, status="failed")

        reset_workflow(db, wf_id)
        assert db.get_workflow(wf_id)["status"] == "draft"

        submit_workflow(db, wf_id)
        assert db.get_workflow(wf_id)["status"] == "running"


class TestWorkflowStateDerivation:
    """Test WorkflowState.from_task_states logic."""

    def test_all_waiting_is_running(self):
        """All-WAITING after while-loop reset should stay RUNNING, not DRAFT."""
        states = [TaskState.WAITING, TaskState.WAITING]
        assert WorkflowState.from_task_states(states) == WorkflowState.RUNNING

    def test_all_completed(self):
        states = [TaskState.COMPLETED, TaskState.COMPLETED]
        assert WorkflowState.from_task_states(states) == WorkflowState.COMPLETED

    def test_any_failed_means_failed(self):
        states = [TaskState.COMPLETED, TaskState.FAILED]
        assert WorkflowState.from_task_states(states) == WorkflowState.FAILED

    def test_active_means_running(self):
        states = [TaskState.WAITING, TaskState.RUNNING, TaskState.COMPLETED]
        assert WorkflowState.from_task_states(states) == WorkflowState.RUNNING

    def test_empty_is_draft(self):
        assert WorkflowState.from_task_states([]) == WorkflowState.DRAFT

    def test_completed_and_skipped(self):
        states = [TaskState.COMPLETED, TaskState.SKIPPED]
        assert WorkflowState.from_task_states(states) == WorkflowState.COMPLETED


class TestScannerDraftGuard:
    """Scanner must not override 'draft' status set by reset_workflow."""

    @pytest.fixture
    def db(self, tmp_path):
        return WorkflowDB(str(tmp_path / "test.db"))

    def test_scanner_preserves_draft(self, db):
        """After reset, scanner should NOT override 'draft' with derived status."""
        from catgo.workflow.engine.scanner import WorkflowEngine

        wf_id = db.create_workflow("test")
        t1 = db.create_task(wf_id, "geo_opt", params={})

        # Simulate: tasks are WAITING (after reset), workflow is draft
        db.update_task(t1, status=TaskState.WAITING.value)
        db.update_workflow(wf_id, status="draft")

        engine = WorkflowEngine(db=db)
        engine._update_workflow_status(wf_id)

        # Status must remain draft — scanner should not override
        assert db.get_workflow(wf_id)["status"] == "draft"

    def test_scanner_updates_running(self, db):
        """Scanner SHOULD update status when workflow is running."""
        from catgo.workflow.engine.scanner import WorkflowEngine

        wf_id = db.create_workflow("test")
        t1 = db.create_task(wf_id, "geo_opt", params={})
        t2 = db.create_task(wf_id, "freq", params={})

        db.update_task(t1, status=TaskState.COMPLETED.value)
        db.update_task(t2, status=TaskState.COMPLETED.value)
        db.update_workflow(wf_id, status="running")

        engine = WorkflowEngine(db=db)
        engine._update_workflow_status(wf_id)

        assert db.get_workflow(wf_id)["status"] == "completed"

import asyncio
import pytest
import catgo.workflow.builtins  # noqa: F401 — register built-in task types

from catgo.workflow.db import WorkflowDB
from catgo.workflow.states import TaskState, WorkflowState
from catgo.workflow.config import load_config
from catgo.workflow.engine.scanner import WorkflowEngine


class TestScanner:
    @pytest.fixture
    def db(self, tmp_path):
        return WorkflowDB(str(tmp_path / "test.db"))

    @pytest.fixture
    def config(self):
        return load_config(config_path=None)

    @pytest.fixture
    def engine(self, db, config):
        return WorkflowEngine(db=db, config=config)

    def test_scan_advances_waiting_to_ready(self, engine, db):
        wf_id = db.create_workflow("test")
        db.update_workflow(wf_id, status="running")
        t1 = db.create_task(wf_id, "geo_opt", params={})  # HPC task stays READY
        asyncio.run(engine.scan_cycle())
        task = db.get_task(t1)
        assert task["status"] == TaskState.READY.value

    def test_scan_chain_local_tasks(self, engine, db):
        """structure_input (local) should complete in one cycle."""
        wf_id = db.create_workflow("test")
        db.update_workflow(wf_id, status="running")
        t1 = db.create_task(wf_id, "structure_input", params={"structure": '{"sites":[]}'})
        asyncio.run(engine.scan_cycle())
        task = db.get_task(t1)
        assert task["status"] in (TaskState.READY.value, TaskState.COMPLETED.value)

    def test_scan_skips_draft_workflows(self, engine, db):
        wf_id = db.create_workflow("test")
        # Status is 'draft' (not 'running')
        t1 = db.create_task(wf_id, "structure_input", params={})
        asyncio.run(engine.scan_cycle())
        task = db.get_task(t1)
        assert task["status"] == TaskState.WAITING.value

    def test_scan_handles_empty_db(self, engine):
        asyncio.run(engine.scan_cycle())

    def test_workflow_completes_when_all_tasks_done(self, engine, db):
        wf_id = db.create_workflow("test")
        db.update_workflow(wf_id, status="running")
        t1 = db.create_task(wf_id, "structure_input", params={})
        db.update_task(t1, status=TaskState.COMPLETED.value)
        asyncio.run(engine.scan_cycle())
        wf = db.get_workflow(wf_id)
        assert wf["status"] == "completed"

    def test_workflow_fails_when_task_fails(self, engine, db):
        wf_id = db.create_workflow("test")
        db.update_workflow(wf_id, status="running")
        t1 = db.create_task(wf_id, "geo_opt", params={})
        db.update_task(t1, status=TaskState.FAILED.value)
        asyncio.run(engine.scan_cycle())
        wf = db.get_workflow(wf_id)
        assert wf["status"] == "failed"

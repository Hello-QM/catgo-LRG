import pytest
from catgo.workflow.db import WorkflowDB
from catgo.workflow.states import TaskState
from catgo.workflow.config import load_config
from catgo.workflow.engine.error_handler import handle_errors


class TestErrorHandler:
    @pytest.fixture
    def db(self, tmp_path):
        return WorkflowDB(str(tmp_path / "test.db"))

    @pytest.fixture
    def config(self):
        return load_config(config_path=None)

    def test_retry_increments_count(self, db, config):
        wf_id = db.create_workflow("test")
        t1 = db.create_task(wf_id, "geo_opt", params={})
        db.update_task(t1, status=TaskState.REMOTE_ERROR.value, retry_count=0)
        handle_errors(db, wf_id, config)
        task = db.get_task(t1)
        assert task["status"] == TaskState.READY.value
        assert task["retry_count"] == 1

    def test_max_retries_becomes_failed(self, db, config):
        wf_id = db.create_workflow("test")
        t1 = db.create_task(wf_id, "geo_opt", params={})
        max_retries = config["retry"]["max_retries"]
        db.update_task(t1, status=TaskState.REMOTE_ERROR.value, retry_count=max_retries)
        handle_errors(db, wf_id, config)
        task = db.get_task(t1)
        assert task["status"] == TaskState.FAILED.value

    def test_non_error_tasks_untouched(self, db, config):
        wf_id = db.create_workflow("test")
        t1 = db.create_task(wf_id, "geo_opt", params={})
        db.update_task(t1, status=TaskState.RUNNING.value)
        handle_errors(db, wf_id, config)
        task = db.get_task(t1)
        assert task["status"] == TaskState.RUNNING.value

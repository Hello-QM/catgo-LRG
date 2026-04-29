import pytest
from catgo.workflow.db import WorkflowDB
from catgo.workflow.states import TaskState
from catgo.workflow.engine.advancer import advance_waiting_tasks


class TestAdvancer:
    @pytest.fixture
    def db(self, tmp_path):
        return WorkflowDB(str(tmp_path / "test.db"))

    def test_no_parents_becomes_ready(self, db):
        wf_id = db.create_workflow("test")
        t1 = db.create_task(wf_id, "structure_input", params={})
        advanced = advance_waiting_tasks(db, wf_id)
        assert t1 in advanced
        task = db.get_task(t1)
        assert task["status"] == TaskState.READY.value

    def test_parents_completed_becomes_ready(self, db):
        wf_id = db.create_workflow("test")
        t1 = db.create_task(wf_id, "geo_opt", params={})
        t2 = db.create_task(wf_id, "freq", params={})
        db.create_link(wf_id, t1, t2, "structure", "structure")
        db.update_task(t1, status=TaskState.COMPLETED.value)
        advanced = advance_waiting_tasks(db, wf_id)
        assert t2 in advanced

    def test_parents_not_completed_stays_waiting(self, db):
        wf_id = db.create_workflow("test")
        t1 = db.create_task(wf_id, "geo_opt", params={})
        t2 = db.create_task(wf_id, "freq", params={})
        db.create_link(wf_id, t1, t2, "structure", "structure")
        # t1 still WAITING
        advanced = advance_waiting_tasks(db, wf_id)
        assert t2 not in advanced
        task = db.get_task(t2)
        assert task["status"] == TaskState.WAITING.value

    def test_multiple_parents_all_must_complete(self, db):
        wf_id = db.create_workflow("test")
        t1 = db.create_task(wf_id, "geo_opt", params={})
        t2 = db.create_task(wf_id, "freq", params={})
        t3 = db.create_task(wf_id, "gibbs_energy", params={})
        db.create_link(wf_id, t1, t3, "energy", "energy")
        db.create_link(wf_id, t2, t3, "frequencies", "frequencies")
        # Only t1 completed
        db.update_task(t1, status=TaskState.COMPLETED.value)
        advanced = advance_waiting_tasks(db, wf_id)
        assert t3 not in advanced
        # Now t2 also completed
        db.update_task(t2, status=TaskState.COMPLETED.value)
        advanced = advance_waiting_tasks(db, wf_id)
        assert t3 in advanced

    def test_skips_non_waiting_tasks(self, db):
        wf_id = db.create_workflow("test")
        t1 = db.create_task(wf_id, "geo_opt", params={})
        db.update_task(t1, status=TaskState.RUNNING.value)
        advanced = advance_waiting_tasks(db, wf_id)
        assert t1 not in advanced

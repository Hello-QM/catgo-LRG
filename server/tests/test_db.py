import pytest
from catgo.workflow.states import TaskState
from catgo.workflow.db import WorkflowDB


class TestDB:
    @pytest.fixture
    def db(self, tmp_path):
        db_path = str(tmp_path / "test.db")
        return WorkflowDB(db_path)

    def test_create_workflow(self, db):
        wf_id = db.create_workflow("test workflow")
        wf = db.get_workflow(wf_id)
        assert wf["name"] == "test workflow"
        assert wf["status"] == "draft"

    def test_create_task(self, db):
        wf_id = db.create_workflow("test")
        task_id = db.create_task(
            workflow_id=wf_id,
            task_type="geo_opt",
            name="relax *OH",
            params={"ENCUT": 520, "EDIFF": 1e-5},
            software="vasp",
        )
        task = db.get_task(task_id)
        assert task["task_type"] == "geo_opt"
        assert task["status"] == TaskState.WAITING.value
        assert task["software"] == "vasp"

    def test_create_link(self, db):
        wf_id = db.create_workflow("test")
        t1 = db.create_task(wf_id, "geo_opt", params={})
        t2 = db.create_task(wf_id, "freq", params={})
        db.create_link(wf_id, t1, t2, "structure", "structure")
        links = db.get_task_parents(t2)
        assert len(links) == 1
        assert links[0]["source_task_id"] == t1
        assert links[0]["source_key"] == "structure"

    def test_update_task_status(self, db):
        wf_id = db.create_workflow("test")
        task_id = db.create_task(wf_id, "geo_opt", params={})
        db.update_task(task_id, status=TaskState.READY.value)
        task = db.get_task(task_id)
        assert task["status"] == TaskState.READY.value

    def test_store_and_get_result(self, db):
        wf_id = db.create_workflow("test")
        task_id = db.create_task(wf_id, "geo_opt", params={})
        db.store_result(task_id, wf_id, energy=-42.5, structure_json='{"sites":[]}')
        result = db.get_result(task_id)
        assert result["energy"] == -42.5

    def test_get_tasks_by_status(self, db):
        wf_id = db.create_workflow("test")
        t1 = db.create_task(wf_id, "geo_opt", params={})
        t2 = db.create_task(wf_id, "freq", params={})
        db.update_task(t1, status=TaskState.READY.value)
        ready = db.get_tasks_by_status(wf_id, TaskState.READY.value)
        assert len(ready) == 1
        assert ready[0]["id"] == t1

    def test_get_workflow_dag(self, db):
        wf_id = db.create_workflow("test")
        t1 = db.create_task(wf_id, "geo_opt", params={})
        t2 = db.create_task(wf_id, "freq", params={})
        db.create_link(wf_id, t1, t2, "structure", "structure")
        dag = db.get_dag(wf_id)
        assert len(dag["tasks"]) == 2
        assert len(dag["links"]) == 1

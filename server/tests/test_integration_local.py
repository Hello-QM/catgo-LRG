import asyncio
import pytest
from catgo.workflow import Workflow, WorkflowDB, load_config
from catgo.workflow.builtins import structure_input, gibbs_energy
from catgo.workflow.states import TaskState
from catgo.workflow.engine import WorkflowEngine
import catgo.workflow.builtins  # ensure registered


class TestLocalWorkflowEndToEnd:
    @pytest.fixture
    def db(self, tmp_path):
        return WorkflowDB(str(tmp_path / "test.db"))

    @pytest.fixture
    def config(self):
        return load_config(config_path=None)

    def test_structure_input_completes(self, db, config):
        wf = Workflow("test", db=db)
        s = wf.add_task(structure_input, structure='{"sites": []}')
        wf.submit()
        engine = WorkflowEngine(db=db, config=config)
        asyncio.run(engine.scan_cycle())
        task = db.get_task(s.task_id)
        assert task["status"] == TaskState.COMPLETED.value

    def test_chained_local_tasks(self, db, config):
        wf = Workflow("test", db=db)
        s = wf.add_task(structure_input, structure='{"sites": []}')
        g = wf.add_task(gibbs_energy, energy=None, frequencies=None)
        wf.submit()
        engine = WorkflowEngine(db=db, config=config)
        asyncio.run(engine.scan_cycle())  # structure_input completes
        asyncio.run(engine.scan_cycle())  # gibbs_energy becomes READY and completes
        assert db.get_task(s.task_id)["status"] == TaskState.COMPLETED.value
        assert db.get_task(g.task_id)["status"] == TaskState.COMPLETED.value

    def test_workflow_status_auto_completes(self, db, config):
        wf = Workflow("test", db=db)
        wf.add_task(structure_input, structure='{"sites": []}')
        wf.submit()
        engine = WorkflowEngine(db=db, config=config)
        asyncio.run(engine.scan_cycle())
        assert db.get_workflow(wf.workflow_id)["status"] == "completed"

    def test_output_reference_links(self, db, config):
        wf = Workflow("test", db=db)
        s = wf.add_task(structure_input, structure='{"sites": [{"species": [{"element": "Cu"}], "abc": [0,0,0], "xyz": [0,0,0]}]}')
        g = wf.add_task(gibbs_energy, energy=s.output.energy, frequencies=None, system_name="test")
        wf.submit()

        dag = wf.get_dag()
        assert len(dag["links"]) == 1

        engine = WorkflowEngine(db=db, config=config)
        asyncio.run(engine.scan_cycle())  # s completes
        asyncio.run(engine.scan_cycle())  # g completes

        g_task = db.get_task(g.task_id)
        assert g_task["status"] == TaskState.COMPLETED.value

    def test_multiple_scan_cycles_are_idempotent(self, db, config):
        wf = Workflow("test", db=db)
        wf.add_task(structure_input, structure='{"sites": []}')
        wf.submit()
        engine = WorkflowEngine(db=db, config=config)
        asyncio.run(engine.scan_cycle())
        asyncio.run(engine.scan_cycle())  # Extra cycle should be harmless
        asyncio.run(engine.scan_cycle())  # And another
        assert db.get_workflow(wf.workflow_id)["status"] == "completed"

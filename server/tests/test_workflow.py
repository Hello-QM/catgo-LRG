import pytest
from catgo.workflow.reference import OutputReference
from catgo.workflow.db import WorkflowDB
from catgo.workflow.workflow import Workflow
from catgo.workflow.task_decorator import task as task_decorator


# Register test task types for this test module
@task_decorator(software="vasp", task_type="t_geo_opt", outputs=["structure", "energy"])
def _t_geo_opt(structure, ENCUT=520, **params):
    pass

@task_decorator(software="vasp", task_type="t_freq", outputs=["frequencies", "zpe"])
def _t_freq(structure, IBRION=5, **params):
    pass

@task_decorator(task_type="t_gibbs", local=True, outputs=["gibbs"])
def _t_gibbs(energy, frequencies, temperature=298.15):
    pass


class TestWorkflow:
    @pytest.fixture
    def db(self, tmp_path):
        return WorkflowDB(str(tmp_path / "test.db"))

    def test_create_workflow(self, db):
        wf = Workflow("test", db=db)
        assert wf.name == "test"
        assert wf.workflow_id is not None

    def test_add_task_by_type_string(self, db):
        wf = Workflow("test", db=db)
        handle = wf.add_task("structure_input", structure='{"sites":[]}')
        assert handle.task_id is not None
        assert isinstance(handle.output, OutputReference)

    def test_add_task_by_decorated_function(self, db):
        wf = Workflow("test", db=db)
        handle = wf.add_task(_t_geo_opt, structure="test", ENCUT=600)
        assert handle.task_id is not None
        task = db.get_task(handle.task_id)
        assert task["task_type"] == "t_geo_opt"

    def test_output_reference_creates_link(self, db):
        wf = Workflow("test", db=db)
        opt = wf.add_task(_t_geo_opt, structure="test")
        frq = wf.add_task(_t_freq, structure=opt.output.structure)
        # Check link was created in DB
        parents = db.get_task_parents(frq.task_id)
        assert len(parents) == 1
        assert parents[0]["source_task_id"] == opt.task_id
        assert parents[0]["source_key"] == "structure"
        assert parents[0]["target_key"] == "structure"

    def test_multiple_references(self, db):
        wf = Workflow("test", db=db)
        opt = wf.add_task(_t_geo_opt, structure="test")
        frq = wf.add_task(_t_freq, structure=opt.output.structure)
        gib = wf.add_task(_t_gibbs,
            energy=opt.output.energy,
            frequencies=frq.output.frequencies,
        )
        parents = db.get_task_parents(gib.task_id)
        assert len(parents) == 2
        source_keys = {p["source_key"] for p in parents}
        assert source_keys == {"energy", "frequencies"}

    def test_submit_sets_status(self, db):
        wf = Workflow("test", db=db)
        wf.add_task("structure_input", structure="test")
        wf.submit()
        wf_data = db.get_workflow(wf.workflow_id)
        assert wf_data["status"] == "running"

    def test_dag_structure(self, db):
        wf = Workflow("test", db=db)
        opt = wf.add_task(_t_geo_opt, structure="test", system_name="*OH")
        frq = wf.add_task(_t_freq, structure=opt.output.structure)
        dag = wf.get_dag()
        assert len(dag["tasks"]) == 2
        assert len(dag["links"]) == 1


class TestIntegration:
    """Full end-to-end: create workflow with built-in tasks, submit, verify DB."""

    def test_oer_workflow(self, tmp_path):
        from catgo.workflow import task, Workflow
        from catgo.workflow.db import WorkflowDB
        from catgo.workflow.builtins import geo_opt, freq, gibbs_energy

        db = WorkflowDB(str(tmp_path / "test.db"))
        wf = Workflow("RuO2 OER", db=db)

        # Build OER workflow
        slab = wf.add_task("structure_input", structure='{"sites":[]}')
        for ads in ["OH", "O"]:
            opt = wf.add_task(geo_opt,
                structure=slab.output.structure,
                system_name=f"*{ads}",
                ENCUT=520,
            )
            frq = wf.add_task(freq,
                structure=opt.output.structure,
                system_name=f"*{ads}",
            )
            gib = wf.add_task(gibbs_energy,
                energy=opt.output.energy,
                frequencies=frq.output.frequencies,
                system_name=f"*{ads}",
            )

        wf.submit()

        # Verify
        dag = wf.get_dag()
        assert len(dag["tasks"]) == 7  # 1 slab + 2*(opt+freq+gibbs)
        # slab->opt1, slab->opt2, opt1->frq1, opt2->frq2, opt1->gib1(energy), frq1->gib1(freq), opt2->gib2, frq2->gib2
        assert len(dag["links"]) == 8

        status = wf.get_status()
        assert status["workflow"]["status"] == "running"
        assert all(t["status"] == "WAITING" for t in status["tasks"])

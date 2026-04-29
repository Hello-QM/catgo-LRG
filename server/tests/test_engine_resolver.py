import json
import pytest
from catgo.workflow.db import WorkflowDB
from catgo.workflow.states import TaskState
from catgo.workflow.engine.resolver import resolve_task_inputs


class TestResolver:
    @pytest.fixture
    def db(self, tmp_path):
        return WorkflowDB(str(tmp_path / "test.db"))

    def test_direct_column_match(self, db):
        """source_key 'energy' matches column 'energy' directly."""
        wf_id = db.create_workflow("test")
        t1 = db.create_task(wf_id, "geo_opt", params={})
        t2 = db.create_task(wf_id, "freq", params={})
        db.create_link(wf_id, t1, t2, "energy", "energy")
        db.store_result(t1, wf_id, energy=-42.5)

        inputs = resolve_task_inputs(db, t2)
        assert inputs["energy"] == -42.5

    def test_json_suffix_match(self, db):
        """source_key 'structure' resolves via 'structure_json' column."""
        wf_id = db.create_workflow("test")
        t1 = db.create_task(wf_id, "geo_opt", params={})
        t2 = db.create_task(wf_id, "freq", params={})
        db.create_link(wf_id, t1, t2, "structure", "structure")
        db.store_result(t1, wf_id, structure_json='{"sites": [1,2,3]}')

        inputs = resolve_task_inputs(db, t2)
        assert inputs["structure"] == '{"sites": [1,2,3]}'

    def test_alias_match(self, db):
        """source_key 'frequencies' resolves via alias to 'real_freqs_json'."""
        wf_id = db.create_workflow("test")
        t1 = db.create_task(wf_id, "freq", params={})
        t2 = db.create_task(wf_id, "gibbs_energy", params={})
        db.create_link(wf_id, t1, t2, "frequencies", "frequencies")
        db.store_result(t1, wf_id, real_freqs_json='[100, 200, 300]')

        inputs = resolve_task_inputs(db, t2)
        assert inputs["frequencies"] == '[100, 200, 300]'

    def test_fallback_to_outputs_json(self, db):
        """Unknown source_key falls back to outputs_json dict."""
        wf_id = db.create_workflow("test")
        t1 = db.create_task(wf_id, "custom_task", params={})
        t2 = db.create_task(wf_id, "consumer", params={})
        db.create_link(wf_id, t1, t2, "band_gap", "band_gap")
        db.store_result(
            t1, wf_id, outputs_json=json.dumps({"band_gap": 1.12})
        )

        inputs = resolve_task_inputs(db, t2)
        assert inputs["band_gap"] == 1.12

    def test_multiple_inputs(self, db):
        """Task with multiple parent links resolves all inputs."""
        wf_id = db.create_workflow("test")
        t_opt = db.create_task(wf_id, "geo_opt", params={})
        t_frq = db.create_task(wf_id, "freq", params={})
        t_gib = db.create_task(wf_id, "gibbs_energy", params={})
        db.create_link(wf_id, t_opt, t_gib, "energy", "energy")
        db.create_link(wf_id, t_frq, t_gib, "frequencies", "frequencies")
        db.store_result(t_opt, wf_id, energy=-42.5)
        db.store_result(t_frq, wf_id, real_freqs_json='[100, 200, 300]')

        inputs = resolve_task_inputs(db, t_gib)
        assert inputs["energy"] == -42.5
        assert inputs["frequencies"] == '[100, 200, 300]'

    def test_resolve_no_parents(self, db):
        wf_id = db.create_workflow("test")
        t1 = db.create_task(wf_id, "structure_input", params={})
        inputs = resolve_task_inputs(db, t1)
        assert inputs == {}

    def test_resolve_missing_result_returns_none(self, db):
        wf_id = db.create_workflow("test")
        t1 = db.create_task(wf_id, "geo_opt", params={})
        t2 = db.create_task(wf_id, "freq", params={})
        db.create_link(wf_id, t1, t2, "structure", "structure")
        # No result stored for t1
        inputs = resolve_task_inputs(db, t2)
        assert inputs["structure"] is None

    def test_duplicate_target_key_collects_list(self, db):
        """Several parents into the same ``structure`` port → list (Packmol multi-template)."""
        wf_id = db.create_workflow("test")
        ta = db.create_task(wf_id, "structure_input", params={})
        tb = db.create_task(wf_id, "structure_input", params={})
        t_md = db.create_task(wf_id, "md_minimize", params={})
        db.create_link(wf_id, ta, t_md, "structure", "structure")
        db.create_link(wf_id, tb, t_md, "structure", "structure")
        db.store_result(ta, wf_id, structure_json='{"a": 1}')
        db.store_result(tb, wf_id, structure_json='{"b": 2}')

        inputs = resolve_task_inputs(db, t_md)
        assert inputs["structure"] == ['{"a": 1}', '{"b": 2}']

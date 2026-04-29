"""Tests for three-tier smart error recovery."""

import json

import pytest
from catgo.workflow.db import WorkflowDB
from catgo.workflow.states import TaskState
from catgo.workflow.config import load_config
from catgo.workflow.engine.error_handler import handle_errors
from catgo.workflow.engine.smart_recovery import diagnose_and_fix, apply_fix


class TestDiagnoseAndFix:
    """Unit tests for diagnose_and_fix()."""

    @pytest.fixture
    def db(self, tmp_path):
        return WorkflowDB(str(tmp_path / "test.db"))

    @pytest.fixture
    def config(self):
        return load_config(config_path=None)

    def test_diagnose_zbrent(self, db, config):
        """ZBRENT error -> tier 2 with IBRION=1, POTIM=0.1."""
        task = {"error_message": "ZBRENT: fatal error in bracketing", "software": "vasp"}
        result = diagnose_and_fix(db, task, config)
        assert result is not None
        assert result["tier"] == 2
        assert result["fixes"]["IBRION"] == 1
        assert result["fixes"]["POTIM"] == 0.1
        assert "ZBRENT" in result["diagnosis"]

    def test_diagnose_scf_not_converged(self, db, config):
        """SCF 'not converge' error -> tier 2 with ALGO=All, NELM=300."""
        task = {"error_message": "WARNING: electronic SCF did not converge", "software": "vasp"}
        result = diagnose_and_fix(db, task, config)
        assert result is not None
        assert result["tier"] == 2
        assert result["fixes"]["ALGO"] == "All"
        assert result["fixes"]["NELM"] == 300

    def test_diagnose_brmix(self, db, config):
        """BRMIX error -> tier 2 with mixing params."""
        task = {"error_message": "BRMIX: very serious problems", "software": "vasp"}
        result = diagnose_and_fix(db, task, config)
        assert result is not None
        assert result["tier"] == 2
        assert result["fixes"]["AMIX"] == 0.1

    def test_diagnose_edddav(self, db, config):
        """EDDDAV error -> tier 2 with ALGO=All."""
        task = {"error_message": "WARNING in EDDDAV: sub-space rotation", "software": "vasp"}
        result = diagnose_and_fix(db, task, config)
        assert result is not None
        assert result["tier"] == 2
        assert result["fixes"]["ALGO"] == "All"

    def test_diagnose_unknown_error(self, db, config):
        """Unknown error message -> returns None."""
        task = {"error_message": "Some completely unknown error XYZ123", "software": "vasp"}
        result = diagnose_and_fix(db, task, config)
        assert result is None

    def test_diagnose_rspher_escalates(self, db, config):
        """RSPHER error -> tier 3, no fixes (escalate)."""
        task = {"error_message": "RSPHER: internal error", "software": "vasp"}
        result = diagnose_and_fix(db, task, config)
        assert result is not None
        assert result["tier"] == 3
        assert result["fixes"] == {}

    def test_diagnose_pricel(self, db, config):
        """PRICEL error -> tier 2 with SYMPREC + ISYM."""
        task = {"error_message": "internal error in subroutine PRICEL", "software": "vasp"}
        result = diagnose_and_fix(db, task, config)
        assert result is not None
        assert result["tier"] == 2
        assert result["fixes"]["ISYM"] == 0

    def test_diagnose_nsw_exceeded(self, db, config):
        """NSW exceeded -> tier 2 with NSW=500."""
        task = {"error_message": "ionic relaxation: max steps exceeded", "software": "vasp"}
        result = diagnose_and_fix(db, task, config)
        assert result is not None
        assert result["tier"] == 2
        assert result["fixes"]["NSW"] == 500

    def test_diagnose_orca_scf(self, db, config):
        """ORCA SCF NOT CONVERGED -> tier 2."""
        task = {"error_message": "SCF NOT CONVERGED AFTER 125 CYCLES", "software": "orca"}
        result = diagnose_and_fix(db, task, config)
        assert result is not None
        assert result["tier"] == 2
        assert result["fixes"]["scf_max_iter"] == 500

    def test_diagnose_orca_abnormal_escalates(self, db, config):
        """ORCA TERMINATED ABNORMALLY -> tier 3."""
        task = {"error_message": "ORCA TERMINATED ABNORMALLY", "software": "orca"}
        result = diagnose_and_fix(db, task, config)
        assert result is not None
        assert result["tier"] == 3
        assert result["fixes"] == {}

    def test_diagnose_unknown_software(self, db, config):
        """Unknown software -> returns None (no fix database)."""
        task = {"error_message": "ZBRENT failure", "software": "gaussian"}
        result = diagnose_and_fix(db, task, config)
        assert result is None

    def test_diagnose_no_error_message(self, db, config):
        """Empty/missing error message -> returns None."""
        task = {"error_message": "", "software": "vasp"}
        result = diagnose_and_fix(db, task, config)
        assert result is None

    def test_diagnose_case_insensitive(self, db, config):
        """Pattern matching is case-insensitive."""
        task = {"error_message": "zbrent: fatal error", "software": "vasp"}
        result = diagnose_and_fix(db, task, config)
        assert result is not None
        assert result["tier"] == 2


class TestApplyFix:
    """Unit tests for apply_fix()."""

    @pytest.fixture
    def db(self, tmp_path):
        return WorkflowDB(str(tmp_path / "test.db"))

    def test_apply_fix_merges_params(self, db):
        """Fixes are merged into existing params, not replacing them."""
        wf_id = db.create_workflow("test")
        t_id = db.create_task(wf_id, "geo_opt", params={"ENCUT": 400, "IBRION": 2})
        apply_fix(db, t_id, {"IBRION": 1, "POTIM": 0.1})
        task = db.get_task(t_id)
        params = json.loads(task["params_json"])
        assert params["ENCUT"] == 400  # preserved
        assert params["IBRION"] == 1  # overwritten
        assert params["POTIM"] == 0.1  # added

    def test_apply_fix_empty_params(self, db):
        """Fixes applied to task with no existing params."""
        wf_id = db.create_workflow("test")
        t_id = db.create_task(wf_id, "geo_opt", params={})
        apply_fix(db, t_id, {"ALGO": "All"})
        task = db.get_task(t_id)
        params = json.loads(task["params_json"])
        assert params["ALGO"] == "All"


class TestErrorHandlerWithSmartRecovery:
    """Integration tests: error_handler using smart_recovery."""

    @pytest.fixture
    def db(self, tmp_path):
        return WorkflowDB(str(tmp_path / "test.db"))

    @pytest.fixture
    def config(self):
        return load_config(config_path=None)

    def test_zbrent_gets_smart_fix_and_retry(self, db, config):
        """REMOTE_ERROR with ZBRENT -> READY with updated params."""
        wf_id = db.create_workflow("test")
        t_id = db.create_task(wf_id, "geo_opt", params={"ENCUT": 400}, software="vasp")
        db.update_task(t_id,
            status=TaskState.REMOTE_ERROR.value,
            retry_count=0,
            error_message="ZBRENT: fatal error in bracketing",
        )

        retried = handle_errors(db, wf_id, config)

        assert t_id in retried
        task = db.get_task(t_id)
        assert task["status"] == TaskState.READY.value
        assert task["retry_count"] == 1
        assert "Auto-fix applied" in task["error_message"]
        params = json.loads(task["params_json"])
        assert params["IBRION"] == 1
        assert params["POTIM"] == 0.1
        assert params["ENCUT"] == 400  # original param preserved

    def test_rspher_escalates_to_paused(self, db, config):
        """REMOTE_ERROR with RSPHER -> PAUSED (tier 3 escalation)."""
        wf_id = db.create_workflow("test")
        t_id = db.create_task(wf_id, "geo_opt", params={}, software="vasp")
        db.update_task(t_id,
            status=TaskState.REMOTE_ERROR.value,
            retry_count=0,
            error_message="RSPHER: internal error",
        )

        retried = handle_errors(db, wf_id, config)

        assert t_id not in retried
        task = db.get_task(t_id)
        assert task["status"] == TaskState.PAUSED.value
        assert "Needs manual review" in task["error_message"]
        assert "augmentation sphere" in task["error_message"]

    def test_unknown_error_simple_retry(self, db, config):
        """REMOTE_ERROR with unknown message -> simple retry (no param changes)."""
        wf_id = db.create_workflow("test")
        t_id = db.create_task(wf_id, "geo_opt", params={"ENCUT": 400}, software="vasp")
        db.update_task(t_id,
            status=TaskState.REMOTE_ERROR.value,
            retry_count=0,
            error_message="Some random HPC error",
        )

        retried = handle_errors(db, wf_id, config)

        assert t_id in retried
        task = db.get_task(t_id)
        assert task["status"] == TaskState.READY.value
        assert task["retry_count"] == 1
        # Params unchanged for unknown errors
        params = json.loads(task["params_json"])
        assert params == {"ENCUT": 400}

    def test_max_retries_still_fails(self, db, config):
        """REMOTE_ERROR at max retries -> FAILED regardless of diagnosis."""
        wf_id = db.create_workflow("test")
        max_retries = config["retry"]["max_retries"]
        t_id = db.create_task(wf_id, "geo_opt", params={}, software="vasp")
        db.update_task(t_id,
            status=TaskState.REMOTE_ERROR.value,
            retry_count=max_retries,
            error_message="ZBRENT: fatal error",
        )

        retried = handle_errors(db, wf_id, config)

        assert t_id not in retried
        task = db.get_task(t_id)
        assert task["status"] == TaskState.FAILED.value

    def test_orca_scf_smart_fix(self, db, config):
        """ORCA SCF NOT CONVERGED -> READY with fix params."""
        wf_id = db.create_workflow("test")
        t_id = db.create_task(wf_id, "single_point", params={}, software="orca")
        db.update_task(t_id,
            status=TaskState.REMOTE_ERROR.value,
            retry_count=0,
            error_message="SCF NOT CONVERGED AFTER 125 CYCLES",
        )

        retried = handle_errors(db, wf_id, config)

        assert t_id in retried
        task = db.get_task(t_id)
        assert task["status"] == TaskState.READY.value
        params = json.loads(task["params_json"])
        assert params["scf_max_iter"] == 500

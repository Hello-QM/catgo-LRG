"""Edited input files must sync back into task params (DB) so they survive regenerate."""
import json, tempfile
from catgo.routers.workflow_engine_tasks import _sync_input_file_to_params
from catgo.workflow.db import WorkflowDB
from catgo.workflow import service


def _setup():
    db = WorkflowDB(tempfile.mktemp(suffix=".db"))
    wf = service.create_workflow(db, "sync-test", None)
    t = service.add_task(db, wf["workflow_id"], "single_point", software="vasp")
    return db, t["task_id"]


def _params(db, tid):
    return json.loads(db.get_task(tid)["params_json"] or "{}")


def test_poscar_sync_updates_structure_json():
    db, tid = _setup()
    poscar = "Pt\n1.0\n0 1.96 1.96\n1.96 0 1.96\n1.96 1.96 0\nPt\n1\nDirect\n0 0 0\n"
    _sync_input_file_to_params(db, tid, db.get_task(tid), "POSCAR", poscar)
    p = _params(db, tid)
    assert "structure_json" in p
    assert p["structure_json"]["sites"][0]["species"][0]["element"] == "Pt"


def test_incar_sync_updates_params():
    db, tid = _setup()
    _sync_input_file_to_params(db, tid, db.get_task(tid), "INCAR", "ENCUT = 450\nISMEAR = 1\nLH5 = .FALSE.\n")
    p = _params(db, tid)
    assert p.get("ENCUT") == 450
    assert "LH5" in p


def test_kpoints_sync_updates_kpoints():
    db, tid = _setup()
    _sync_input_file_to_params(db, tid, db.get_task(tid), "KPOINTS", "Auto\n0\nGamma\n5 5 5\n0 0 0\n")
    assert _params(db, tid).get("kpoints") == "5 5 5"


def test_unknown_file_not_synced():
    db, tid = _setup()
    before = _params(db, tid)
    _sync_input_file_to_params(db, tid, db.get_task(tid), "POTCAR", "junk")
    assert _params(db, tid) == before  # POTCAR/unknown not synced

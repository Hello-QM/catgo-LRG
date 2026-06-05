"""Regression test for the active-workflow-DB persistence fix.

Bug: a fresh backend defaulted to the packaged DB while the frontend later
re-opened the user's project DB, so workflows created via the API before the
switch were orphaned in the wrong file and vanished from the list. Fix persists
the active DB path and restores it at startup.
"""
import importlib


def _fresh_ase_db(monkeypatch, tmp_path):
    ase_db = importlib.import_module("catgo.utils.ase_db")
    wf_db = importlib.import_module("catgo.utils.workflow_db")
    # isolate the persisted-state file to a tmp location
    monkeypatch.setattr(ase_db, "_ACTIVE_DB_STATE", tmp_path / ".active_db_path")
    monkeypatch.setattr(ase_db, "_active_db_path", None)
    monkeypatch.setattr(wf_db, "_active_wf_db_path", None)
    return ase_db, wf_db


def test_set_persists_and_resolves_absolute(monkeypatch, tmp_path):
    ase_db, wf_db = _fresh_ase_db(monkeypatch, tmp_path)
    dbfile = tmp_path / "proj" / "catgo_results.db"
    dbfile.parent.mkdir()
    dbfile.touch()

    # pass a non-resolved path; expect absolute resolution + both stores aligned
    ase_db.set_active_db_path(str(dbfile))
    abs_expected = str(dbfile.resolve())
    assert ase_db.get_active_db_path() == abs_expected
    assert wf_db.get_active_wf_db_path() == abs_expected
    # persisted to the state file
    assert ase_db._ACTIVE_DB_STATE.read_text().strip() == abs_expected


def test_restore_after_restart(monkeypatch, tmp_path):
    ase_db, wf_db = _fresh_ase_db(monkeypatch, tmp_path)
    dbfile = tmp_path / "proj" / "catgo_results.db"
    dbfile.parent.mkdir()
    dbfile.touch()
    ase_db.set_active_db_path(str(dbfile))

    # simulate restart: globals reset, state file remains
    monkeypatch.setattr(ase_db, "_active_db_path", None)
    monkeypatch.setattr(wf_db, "_active_wf_db_path", None)
    assert ase_db.get_active_db_path() == str(ase_db.DB_PATH)  # reverted to default

    restored = ase_db.restore_active_db_path()
    assert restored == str(dbfile.resolve())
    # create/list/get now agree on the restored file
    assert ase_db.get_active_db_path() == str(dbfile.resolve())
    assert wf_db.get_active_wf_db_path() == str(dbfile.resolve())


def test_restore_ignores_stale_path(monkeypatch, tmp_path):
    ase_db, _ = _fresh_ase_db(monkeypatch, tmp_path)
    (tmp_path / ".active_db_path").write_text(str(tmp_path / "gone" / "missing.db"))
    assert ase_db.restore_active_db_path() is None
    assert ase_db.get_active_db_path() == str(ase_db.DB_PATH)  # default kept

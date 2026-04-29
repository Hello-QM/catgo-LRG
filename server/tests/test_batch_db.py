"""Tests for batch subtask database operations.

Uses a test-specific temporary DB to avoid interfering with production data.
"""
import os
import tempfile

import pytest


@pytest.fixture(autouse=True)
def _use_temp_db(monkeypatch, tmp_path):
    """Redirect batch_db (and workflow_db) to a temporary SQLite file."""
    db_path = str(tmp_path / "test_batch.db")
    # Patch the workflow_db module-level variable so batch_db._get_db_path()
    # returns our temp path instead of the production DB.
    import catgo.utils.workflow_db as wf_db
    monkeypatch.setattr(wf_db, "_active_wf_db_path", db_path)


@pytest.fixture
def batch_setup():
    from catgo.utils.batch_db import ensure_batch_tables
    ensure_batch_tables()
    wf_id = "test-wf-batch"
    step_id = "test-step-batch"
    return wf_id, step_id


def test_insert_and_summary(batch_setup):
    from catgo.utils.batch_db import insert_subtasks_batch, get_batch_summary
    wf_id, step_id = batch_setup
    insert_subtasks_batch(wf_id, step_id, 100)
    summary = get_batch_summary(wf_id, step_id)
    assert summary["total"] == 100
    assert summary["pending"] == 100
    assert summary["completed"] == 0


def test_update_statuses(batch_setup):
    from catgo.utils.batch_db import (insert_subtasks_batch, update_subtask_statuses,
                                 get_batch_summary)
    wf_id, step_id = batch_setup
    insert_subtasks_batch(wf_id, step_id, 10)
    update_subtask_statuses(wf_id, step_id, {0: "COMPLETED", 1: "FAILED", 2: "RUNNING"})
    summary = get_batch_summary(wf_id, step_id)
    assert summary["completed"] >= 1
    assert summary["failed"] >= 1


def test_pagination(batch_setup):
    from catgo.utils.batch_db import insert_subtasks_batch, get_batch_results_page
    wf_id, step_id = batch_setup
    insert_subtasks_batch(wf_id, step_id, 200)
    page = get_batch_results_page(wf_id, step_id, page=1, per_page=50)
    assert len(page["items"]) == 50
    assert page["total"] == 200


def test_failed_indices(batch_setup):
    from catgo.utils.batch_db import (insert_subtasks_batch, update_subtask_statuses,
                                 get_failed_subtask_indices)
    wf_id, step_id = batch_setup
    insert_subtasks_batch(wf_id, step_id, 5)
    update_subtask_statuses(wf_id, step_id, {1: "FAILED", 3: "FAILED"})
    failed = get_failed_subtask_indices(wf_id, step_id)
    assert set(failed) == {1, 3}

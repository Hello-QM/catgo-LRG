"""Deletion safety and batch semantics for Engine workflows."""

import sqlite3

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import catgo.routers.workflow_engine as workflow_engine
from catgo.workflow.db import WorkflowDB


@pytest.fixture
def db(tmp_path):
    return WorkflowDB(str(tmp_path / "engine-delete.db"))


@pytest.fixture
def client(db):
    workflow_engine.set_db(db)
    app = FastAPI()
    app.include_router(workflow_engine.router)
    return TestClient(app)


def _create_workflow_with_data(db: WorkflowDB, name: str) -> str:
    workflow_id = db.create_workflow(name)
    source = db.create_task(workflow_id, "geo_opt")
    target = db.create_task(workflow_id, "freq")
    db.create_link(workflow_id, source, target, "structure", "structure")
    db.store_result(source, workflow_id, energy=-1.25)
    db.record_provenance(
        workflow_id=workflow_id,
        task_id=source,
        output_key="energy",
        value_hash="test-hash",
    )
    return workflow_id


def test_db_delete_cascades_all_engine_workflow_data(db):
    workflow_id = _create_workflow_with_data(db, "delete-all-data")

    assert db.delete_workflows([workflow_id]) == [workflow_id]

    with pytest.raises(KeyError):
        db.get_workflow(workflow_id)
    with sqlite3.connect(db.db_path) as conn:
        for table in ("tasks", "task_links", "task_results", "provenance"):
            count = conn.execute(
                f"SELECT COUNT(*) FROM {table} WHERE workflow_id = ?",
                (workflow_id,),
            ).fetchone()[0]
            assert count == 0, table


def test_single_delete_endpoint_removes_draft(client, db):
    workflow_id = db.create_workflow("single-delete")

    response = client.delete(f"/api/engine/workflows/{workflow_id}")

    assert response.status_code == 204
    with pytest.raises(KeyError):
        db.get_workflow(workflow_id)


def test_batch_delete_is_atomic_and_leaves_unselected_workflow(client, db):
    first = db.create_workflow("batch-first")
    second = db.create_workflow("batch-second")
    untouched = db.create_workflow("untouched")

    response = client.post(
        "/api/engine/workflows/batch-delete",
        json={"workflow_ids": [first, second, first]},
    )

    assert response.status_code == 200
    assert response.json() == {
        "deleted_ids": [first, second],
        "deleted_count": 2,
    }
    assert db.get_workflow(untouched)["name"] == "untouched"
    with pytest.raises(KeyError):
        db.get_workflow(first)
    with pytest.raises(KeyError):
        db.get_workflow(second)


def test_batch_delete_rejects_active_workflow_without_partial_delete(client, db):
    draft = db.create_workflow("draft")
    active = db.create_workflow("active")
    db.update_workflow(active, status="running")

    response = client.post(
        "/api/engine/workflows/batch-delete",
        json={"workflow_ids": [draft, active]},
    )

    assert response.status_code == 409
    assert db.get_workflow(draft)["name"] == "draft"
    assert db.get_workflow(active)["name"] == "active"


def test_stale_draft_with_active_task_is_still_protected(client, db):
    workflow_id = db.create_workflow("stale-draft")
    task_id = db.create_task(workflow_id, "geo_opt")
    db.update_task(task_id, status="SUBMITTED")

    response = client.delete(f"/api/engine/workflows/{workflow_id}")

    assert response.status_code == 409
    assert db.get_workflow(workflow_id)["name"] == "stale-draft"


def test_paused_workflow_is_deletable_even_with_stale_active_task(client, db):
    workflow_id = db.create_workflow("paused-delete")
    task_id = db.create_task(workflow_id, "geo_opt")
    db.update_task(task_id, status="RUNNING", hpc_job_id="old-job")
    db.update_workflow(workflow_id, status="paused")

    response = client.delete(f"/api/engine/workflows/{workflow_id}")

    assert response.status_code == 204
    with pytest.raises(KeyError):
        db.get_workflow(workflow_id)


def test_review_gated_workflow_displays_check_and_is_deletable(client, db):
    workflow_id = db.create_workflow("waiting-for-check")
    task_id = db.create_task(workflow_id, "geo_opt")
    db.update_task(task_id, status="PENDING_REVIEW")
    db.update_workflow(workflow_id, status="running")

    summary = next(
        item for item in client.get("/api/engine/workflows").json()
        if item["id"] == workflow_id
    )
    assert summary["status"] == "running"
    assert summary["display_status"] == "check"
    assert summary["delete_blocked"] is False
    assert summary["delete_block_reason"] is None

    response = client.delete(f"/api/engine/workflows/{workflow_id}")
    assert response.status_code == 204


def test_terminal_workflow_ignores_stale_active_task_state(client, db):
    workflow_id = db.create_workflow("old-failed-run")
    task_id = db.create_task(workflow_id, "geo_opt")
    db.update_task(task_id, status="RUNNING", hpc_job_id="old-job")
    db.update_workflow(workflow_id, status="failed")

    summary = next(
        item for item in client.get("/api/engine/workflows").json()
        if item["id"] == workflow_id
    )
    assert summary["display_status"] == "failed"
    assert summary["delete_blocked"] is False

    response = client.delete(f"/api/engine/workflows/{workflow_id}")
    assert response.status_code == 204


def test_stalled_error_workflow_displays_failed_and_is_deletable(client, db):
    workflow_id = db.create_workflow("stalled-errors")
    completed = db.create_task(workflow_id, "structure_input")
    remote_error = db.create_task(workflow_id, "freq")
    failed = db.create_task(workflow_id, "freq")
    downstream = db.create_task(workflow_id, "gibbs_energy")
    db.update_task(completed, status="COMPLETED")
    db.update_task(remote_error, status="REMOTE_ERROR", error_type="transient")
    db.update_task(failed, status="FAILED")
    db.update_task(downstream, status="WAITING")
    db.update_workflow(workflow_id, status="running")

    summary = next(
        item for item in client.get("/api/engine/workflows").json()
        if item["id"] == workflow_id
    )
    assert summary["status"] == "running"
    assert summary["display_status"] == "failed"
    assert summary["delete_blocked"] is False

    response = client.delete(f"/api/engine/workflows/{workflow_id}")
    assert response.status_code == 204


def test_remote_error_with_unresolved_job_stays_delete_protected(client, db):
    workflow_id = db.create_workflow("unresolved-remote-job")
    task_id = db.create_task(workflow_id, "geo_opt")
    db.update_task(
        task_id,
        status="REMOTE_ERROR",
        hpc_job_id="possibly-still-running",
        error_type="transient",
    )
    db.update_workflow(workflow_id, status="running")

    summary = next(
        item for item in client.get("/api/engine/workflows").json()
        if item["id"] == workflow_id
    )
    assert summary["display_status"] == "failed"
    assert summary["delete_blocked"] is True
    assert summary["delete_block_reason"] == "remote job status is unresolved"

    response = client.delete(f"/api/engine/workflows/{workflow_id}")
    assert response.status_code == 409


def test_failed_branch_does_not_hide_runnable_work(client, db):
    workflow_id = db.create_workflow("failed-and-ready")
    failed = db.create_task(workflow_id, "geo_opt")
    ready = db.create_task(workflow_id, "geo_opt")
    db.update_task(failed, status="FAILED")
    db.update_task(ready, status="READY")
    db.update_workflow(workflow_id, status="running")

    summary = next(
        item for item in client.get("/api/engine/workflows").json()
        if item["id"] == workflow_id
    )
    assert summary["display_status"] == "running"
    assert summary["delete_blocked"] is True

# server/tests/test_hpc_dry_run.py
"""HPC dry run test -- validates submitter -> poller -> collector with mocked SSH.

Tests the full state transition pipeline without real HPC access.
"""
import asyncio
import json
import pytest
from unittest.mock import AsyncMock, patch

from catgo.workflow.db import WorkflowDB
from catgo.workflow.states import TaskState
from catgo.workflow.workflow import Workflow
from catgo.workflow.engine.scanner import WorkflowEngine


@pytest.fixture
def db(tmp_path):
    return WorkflowDB(str(tmp_path / "test.db"))


@pytest.fixture
def config():
    return {
        "engine": {"poll_interval": 1},
        "hpc": {
            "default_session": "mock-session",
            "sessions": {
                "mock-session": {
                    "host": "mock-hpc",
                    "user": "testuser",
                    "work_base": "/scratch/testuser/catgo",
                }
            }
        },
    }


def _create_geo_opt_workflow(db: WorkflowDB) -> str:
    """Create a simple structure_input -> geo_opt workflow."""
    wf = Workflow("HPC Dry Run", db=db)
    t1 = wf.add_task("structure_input", structure='{"lattice": {"a": 3.0}}')
    t2 = wf.add_task("geo_opt", structure=t1.output.structure, software="vasp")
    wf.submit()
    return wf.workflow_id


def _run(coro):
    """Run async code in sync test."""
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


def _mock_hpc_patches():
    """Return context managers that mock all HPC-related scanner functions."""
    return (
        patch("catgo.workflow.engine.submitter.submit_ready_tasks", new_callable=AsyncMock, return_value=[]),
        patch("catgo.workflow.engine.poller.poll_active_tasks", new_callable=AsyncMock),
        patch("catgo.workflow.engine.collector.collect_completed_tasks", new_callable=AsyncMock, return_value=[]),
    )


def test_local_task_completes(db, config):
    """structure_input (local) should complete in one scan cycle."""
    wf_id = _create_geo_opt_workflow(db)
    engine = WorkflowEngine(db=db, config=config)

    # Cycle 1: advance → execute structure_input (COMPLETED)
    # Cycle 2: advance geo_opt WAITING→READY (parent now COMPLETED)
    p1, p2, p3 = _mock_hpc_patches()
    with p1, p2, p3:
        _run(engine.scan_cycle())
        _run(engine.scan_cycle())

    tasks = db.get_all_tasks(wf_id)
    si_task = [t for t in tasks if t["task_type"] == "structure_input"][0]
    assert si_task["status"] == TaskState.COMPLETED.value

    geo_task = [t for t in tasks if t["task_type"] == "geo_opt"][0]
    assert geo_task["status"] == TaskState.READY.value


def test_full_hpc_lifecycle_mocked(db, config):
    """Full HPC lifecycle with mocked SSH: READY -> ... -> COMPLETED."""
    wf_id = _create_geo_opt_workflow(db)
    engine = WorkflowEngine(db=db, config=config)

    # Cycles 1+2: complete structure_input, then advance geo_opt to READY
    p1, p2, p3 = _mock_hpc_patches()
    with p1, p2, p3:
        _run(engine.scan_cycle())
        _run(engine.scan_cycle())

    tasks = db.get_all_tasks(wf_id)
    geo_task = [t for t in tasks if t["task_type"] == "geo_opt"][0]
    geo_id = geo_task["id"]
    assert geo_task["status"] == TaskState.READY.value

    # Mock submitter: simulate successful submission
    async def mock_submit(db_, wf_id_, config_):
        ready = db_.get_tasks_by_status(wf_id_, TaskState.READY.value)
        for t in ready:
            from catgo.workflow.task_decorator import get_task_definition
            defn = get_task_definition(t["task_type"])
            if defn and defn.local:
                continue
            db_.update_task(t["id"],
                status=TaskState.SUBMITTED.value,
                hpc_job_id="12345",
                work_dir="/scratch/testuser/catgo/wf1/geo_opt",
            )

    with patch("catgo.workflow.engine.submitter.submit_ready_tasks", new=mock_submit), \
         patch("catgo.workflow.engine.poller.poll_active_tasks", new_callable=AsyncMock), \
         patch("catgo.workflow.engine.collector.collect_completed_tasks", new_callable=AsyncMock):
        _run(engine.scan_cycle())

    geo_task = db.get_task(geo_id)
    assert geo_task["status"] == TaskState.SUBMITTED.value

    # Mock poller: SUBMITTED -> RUNNING
    async def mock_poll_running(db_, wf_id_, config_):
        for t in db_.get_all_tasks(wf_id_):
            if t["status"] == TaskState.SUBMITTED.value:
                db_.update_task(t["id"], status=TaskState.RUNNING.value)

    with patch("catgo.workflow.engine.submitter.submit_ready_tasks", new_callable=AsyncMock), \
         patch("catgo.workflow.engine.poller.poll_active_tasks", new=mock_poll_running), \
         patch("catgo.workflow.engine.collector.collect_completed_tasks", new_callable=AsyncMock):
        _run(engine.scan_cycle())

    assert db.get_task(geo_id)["status"] == TaskState.RUNNING.value

    # Mock poller: RUNNING -> COMPLETED_REMOTE
    async def mock_poll_completed(db_, wf_id_, config_):
        for t in db_.get_all_tasks(wf_id_):
            if t["status"] == TaskState.RUNNING.value:
                db_.update_task(t["id"], status=TaskState.COMPLETED_REMOTE.value)

    with patch("catgo.workflow.engine.submitter.submit_ready_tasks", new_callable=AsyncMock), \
         patch("catgo.workflow.engine.poller.poll_active_tasks", new=mock_poll_completed), \
         patch("catgo.workflow.engine.collector.collect_completed_tasks", new_callable=AsyncMock):
        _run(engine.scan_cycle())

    assert db.get_task(geo_id)["status"] == TaskState.COMPLETED_REMOTE.value

    # Mock collector: COMPLETED_REMOTE -> COMPLETED with result
    async def mock_collect(db_, wf_id_, config_):
        for t in db_.get_tasks_by_status(wf_id_, TaskState.COMPLETED_REMOTE.value):
            db_.update_task(t["id"], status=TaskState.COLLECTING.value)
            db_.store_result(t["id"], wf_id_, energy=-42.0, structure_json='{"lattice": {}}')
            db_.update_task(t["id"], status=TaskState.COMPLETED.value)

    with patch("catgo.workflow.engine.submitter.submit_ready_tasks", new_callable=AsyncMock), \
         patch("catgo.workflow.engine.poller.poll_active_tasks", new_callable=AsyncMock), \
         patch("catgo.workflow.engine.collector.collect_completed_tasks", new=mock_collect):
        _run(engine.scan_cycle())

    assert db.get_task(geo_id)["status"] == TaskState.COMPLETED.value

    # Check result stored
    result = db.get_result(geo_id)
    assert result is not None
    assert result["energy"] == -42.0

    # Workflow should be completed
    assert db.get_workflow(wf_id)["status"] == "completed"


def test_error_handler_retries(db, config):
    """REMOTE_ERROR task should be retried (set back to READY)."""
    wf_id = _create_geo_opt_workflow(db)
    engine = WorkflowEngine(db=db, config=config)

    # Complete structure_input (2 cycles to advance downstream)
    p1, p2, p3 = _mock_hpc_patches()
    with p1, p2, p3:
        _run(engine.scan_cycle())
        _run(engine.scan_cycle())

    tasks = db.get_all_tasks(wf_id)
    geo_id = [t for t in tasks if t["task_type"] == "geo_opt"][0]["id"]

    # Simulate remote error
    db.update_task(geo_id, status=TaskState.REMOTE_ERROR.value, error_message="SSH timeout")

    # Run another cycle -- error handler should retry
    p1, p2, p3 = _mock_hpc_patches()
    with p1, p2, p3:
        _run(engine.scan_cycle())

    geo_task = db.get_task(geo_id)
    assert geo_task["status"] == TaskState.READY.value


def test_poller_marks_remote_error_when_no_connection(db, config):
    """Poller should mark RUNNING tasks as REMOTE_ERROR when HPC connection is lost.

    This prevents tasks from getting stuck in RUNNING forever when the SSH
    session is recycled or disconnected.
    """
    from catgo.workflow.engine.poller import poll_active_tasks

    wf_id = _create_geo_opt_workflow(db)
    engine = WorkflowEngine(db=db, config=config)

    # Complete structure_input, advance geo_opt to READY
    p1, p2, p3 = _mock_hpc_patches()
    with p1, p2, p3:
        _run(engine.scan_cycle())
        _run(engine.scan_cycle())

    tasks = db.get_all_tasks(wf_id)
    geo_id = [t for t in tasks if t["task_type"] == "geo_opt"][0]["id"]

    # Simulate: task was submitted and reached RUNNING
    db.update_task(geo_id,
        status=TaskState.RUNNING.value,
        hpc_job_id="99999",
        hpc_session_id="dead-session-id",
    )

    # Poll with no HPC connection available (get_hpc_connection returns None)
    with patch("catgo.workflow.engine.poller.get_hpc_connection", new_callable=AsyncMock, return_value=None):
        _run(poll_active_tasks(db, wf_id, config))

    geo_task = db.get_task(geo_id)
    assert geo_task["status"] == TaskState.REMOTE_ERROR.value
    assert "connection lost" in geo_task["error_message"].lower()


def test_poller_lost_connection_triggers_retry_to_ready(db, config):
    """Full cycle: RUNNING -> (no connection) -> REMOTE_ERROR -> READY (retry).

    Verifies the fix for the bug where tasks get stuck in RUNNING when the
    HPC session is recycled.
    """
    from catgo.workflow.engine.poller import poll_active_tasks
    from catgo.workflow.engine.error_handler import handle_errors

    wf_id = _create_geo_opt_workflow(db)
    engine = WorkflowEngine(db=db, config=config)

    # Complete structure_input, advance geo_opt to READY
    p1, p2, p3 = _mock_hpc_patches()
    with p1, p2, p3:
        _run(engine.scan_cycle())
        _run(engine.scan_cycle())

    tasks = db.get_all_tasks(wf_id)
    geo_id = [t for t in tasks if t["task_type"] == "geo_opt"][0]["id"]

    # Simulate: task was submitted and reached RUNNING
    db.update_task(geo_id,
        status=TaskState.RUNNING.value,
        hpc_job_id="99999",
        hpc_session_id="dead-session-id",
    )

    # Step 1: Poller detects no connection -> REMOTE_ERROR
    with patch("catgo.workflow.engine.poller.get_hpc_connection", new_callable=AsyncMock, return_value=None):
        _run(poll_active_tasks(db, wf_id, config))

    assert db.get_task(geo_id)["status"] == TaskState.REMOTE_ERROR.value

    # Step 2: Error handler retries -> READY
    handle_errors(db, wf_id, config)

    geo_task = db.get_task(geo_id)
    assert geo_task["status"] == TaskState.READY.value
    assert geo_task["retry_count"] == 1


def test_hpc_config_default_session_key(db, config):
    """get_hpc_connection should accept both default_session and default_session_id."""
    import sys
    from types import ModuleType

    task = {"id": "t1"}  # no hpc_session_id
    config_with_default = {"hpc": {"default_session": "some-session"}}

    mock_conn = type("MockConn", (), {"is_alive": True})()
    mock_pool = type("MockPool", (), {
        "get_connection": lambda self, sid: mock_conn if sid == "some-session" else None,
        "connections": {},
    })()

    # Create a fake utils.hpc_client module so the deferred import works
    fake_mod = ModuleType("utils.hpc_client")
    fake_mod.pool = mock_pool
    fake_mod.LOCAL_SESSION_ID = "__local__"

    with patch.dict(sys.modules, {
        "catgo.utils.hpc_client": fake_mod,
        "catgo.utils": ModuleType("catgo.utils"),
    }):
        # Re-import to pick up the mocked module
        import importlib
        import catgo.workflow.engine.hpc_utils as hpc_mod
        importlib.reload(hpc_mod)
        result = _run(hpc_mod.get_hpc_connection(task, config_with_default))
        assert result == mock_conn

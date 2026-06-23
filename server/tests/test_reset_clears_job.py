"""reset_workflow must clear hpc_job_id/work_dir so a re-run submits fresh.

Regression: after a reset, tasks kept their old hpc_job_id. On the next run the
engine polled that finished/cancelled job, found it gone, and marked the task
FAILED instead of resubmitting — the whole workflow failed without launching a
new calculation.
"""

import pytest

from catgo.workflow.db import WorkflowDB
from catgo.workflow.states import TaskState
from catgo.workflow.engine.lifecycle import reset_workflow


@pytest.fixture
def db(tmp_path):
    return WorkflowDB(str(tmp_path / "test.db"))


def test_reset_clears_hpc_job_id_and_work_dir(db):
    wf_id = db.create_workflow("test")
    t1 = db.create_task(wf_id, "geo_opt", params={})
    # Simulate a prior run: task finished/cancelled with a stale job binding.
    db.update_task(
        t1,
        status=TaskState.FAILED.value,
        hpc_job_id="51381735",
        work_dir="/expanse/.../old",
        error_message="job vanished",
    )

    reset_workflow(db, wf_id)

    task = db.get_task(t1)
    assert task["status"] == TaskState.WAITING.value
    assert not task.get("hpc_job_id"), "stale hpc_job_id not cleared"
    assert not task.get("work_dir"), "stale work_dir not cleared"
    assert not task.get("error_message")

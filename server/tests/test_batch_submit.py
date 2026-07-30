# server/tests/test_batch_submit.py
"""Tests for batch submission — SLURM array jobs for high-throughput fan-out."""

import asyncio
import json
import tempfile
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from catgo.workflow.db import WorkflowDB
from catgo.workflow.states import TaskState
from catgo.workflow.engine.batch_submitter import submit_batch_tasks, ARRAY_JOB_THRESHOLD


def _run(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


@pytest.fixture
def db(tmp_path):
    """In-memory workflow DB seeded with a workflow."""
    _db = WorkflowDB(str(tmp_path / "test.db"))
    return _db


@pytest.fixture
def workflow_id(db):
    return db.create_workflow("test-batch")


@pytest.fixture
def config():
    return {
        "paths": {"base_dir": "/scratch/catgo"},
        "hpc": {
            "job_defaults": {
                "partition": "compute",
                "nodes": 1,
                "ntasks": 32,
                "walltime": "04:00:00",
                "max_concurrent": 20,
            },
        },
    }


def _make_tasks(
    db, workflow_id, n=5, task_type="geo_opt", software="vasp", params=None,
):
    """Create n READY tasks of the same type."""
    ids = []
    for i in range(n):
        tid = db.create_task(
            workflow_id, task_type,
            name=f"task_{i}",
            params={"software": software, **(params or {})},
        )
        db.update_task(tid, status=TaskState.READY.value)
        ids.append(tid)
    return ids


def _mock_hpc():
    """Build a mock HPC connection that records commands."""
    hpc = MagicMock()
    hpc.conn = AsyncMock()
    # sbatch returns a fake job ID
    sbatch_result = SimpleNamespace(stdout="Submitted batch job 99887766")
    hpc.conn.run = AsyncMock(return_value=sbatch_result)

    async def _run_on_owner(coro_factory):
        return await coro_factory()

    hpc.run_on_owner = AsyncMock(side_effect=_run_on_owner)
    return hpc


def test_batch_creates_array_script(db, workflow_id, config):
    """Verify the generated script has --array directive and array-aware cd."""
    task_ids = _make_tasks(db, workflow_id, n=5)
    hpc = _mock_hpc()

    with patch("catgo.workflow.engine.batch_submitter.get_hpc_connection", new_callable=AsyncMock, return_value=hpc), \
         patch("catgo.workflow.engine.batch_submitter.get_engine_generator") as mock_gen, \
         patch("catgo.workflow.engine.batch_submitter.resolve_task_inputs", return_value={}), \
         patch("catgo.workflow.engine.batch_submitter.map_task_type_to_engine", return_value=("vasp_relax", "vasp")):

        # Engine generator is a no-op async function
        mock_gen.return_value = AsyncMock()

        job_id = _run(submit_batch_tasks(db, task_ids, workflow_id, config))

    assert job_id == "99887766"

    # Find the "cat > ... << 'CATGO_EOF'" call that wrote the script
    script_content = None
    for call in hpc.conn.run.call_args_list:
        cmd = call[0][0] if call[0] else call[1].get("cmd", "")
        if "CATGO_EOF" in str(cmd):
            script_content = str(cmd)
            break

    assert script_content is not None, "Expected script upload via heredoc"
    assert "#SBATCH --array=0-4%20" in script_content
    assert 'SLURM_ARRAY_TASK_ID' in script_content


def test_batch_updates_all_tasks(db, workflow_id, config):
    """Verify all tasks get SUBMITTED status with array job IDs."""
    task_ids = _make_tasks(db, workflow_id, n=4)
    hpc = _mock_hpc()

    with patch("catgo.workflow.engine.batch_submitter.get_hpc_connection", new_callable=AsyncMock, return_value=hpc), \
         patch("catgo.workflow.engine.batch_submitter.get_engine_generator") as mock_gen, \
         patch("catgo.workflow.engine.batch_submitter.resolve_task_inputs", return_value={}), \
         patch("catgo.workflow.engine.batch_submitter.map_task_type_to_engine", return_value=("vasp_relax", "vasp")):

        mock_gen.return_value = AsyncMock()
        job_id = _run(submit_batch_tasks(db, task_ids, workflow_id, config))

    assert job_id == "99887766"

    for i, tid in enumerate(task_ids):
        task = db.get_task(tid)
        assert task["status"] == TaskState.SUBMITTED.value
        assert task["hpc_job_id"] == f"99887766_{i}"


def test_batch_uses_resolved_command_manifest_and_job_default_potcar(
    db, workflow_id, config,
):
    config["hpc"].update({
        "use_custodian": True,
        "run_commands": {"vasp": "srun rc_vasp_std"},
    })
    config["hpc"]["job_defaults"].update({
        "vasp_command": "srun jd_vasp_std",
        "potcar_root": "/opt/potcars",
        "potcar_functional": "potpaw_PBE_54",
    })
    task_ids = _make_tasks(
        db,
        workflow_id,
        n=3,
        params={
            "run_command": "srun --hint=nomultithread vasp_ncl",
            "required_incar_tags": ["ENCUT", "EDIFF"],
            "kpoints_policy": "explicit_regular_mesh",
        },
    )
    hpc = _mock_hpc()

    with patch(
        "catgo.workflow.engine.batch_submitter.get_hpc_connection",
        new_callable=AsyncMock,
        return_value=hpc,
    ), patch(
        "catgo.workflow.engine.batch_submitter.get_engine_generator",
        return_value=AsyncMock(),
    ), patch(
        "catgo.workflow.engine.batch_submitter.resolve_task_inputs",
        return_value={},
    ), patch(
        "catgo.workflow.engine.batch_submitter.map_task_type_to_engine",
        return_value=("vasp_relax", "vasp"),
    ), patch(
        "catgo.workflow.engine.submitter._generate_potcar",
        new_callable=AsyncMock,
    ) as generate_potcar, patch(
        "catgo.workflow.engine.vasp_submission._audit_vasp_inputs",
        new_callable=AsyncMock,
    ) as audit_inputs:
        job_id = _run(submit_batch_tasks(db, task_ids, workflow_id, config))

    assert job_id == "99887766"
    assert generate_potcar.await_count == 3
    assert audit_inputs.await_count == 3
    generate_potcar.assert_any_await(
        hpc, f"/scratch/catgo/{workflow_id}/batch_geo_opt/000000",
        "/opt/potcars", "potpaw_PBE_54",
    )

    commands = [
        str(call.args[0])
        for call in hpc.conn.run.call_args_list
        if call.args
    ]
    manifests = [cmd for cmd in commands if "CATGO_VASP_PREFLIGHT" in cmd]
    custodians = [
        cmd for cmd in commands
        if "/run_custodian.py << 'CATGO_EOF'" in cmd
    ]
    assert len(manifests) == 3
    assert len(custodians) == 3
    assert all("srun --hint=nomultithread vasp_ncl" in cmd for cmd in manifests)
    assert all("ENCUT" in cmd and "EDIFF" in cmd for cmd in manifests)
    assert all("explicit_regular_mesh" in cmd for cmd in manifests)
    assert all("vasp_ncl" in cmd for cmd in custodians)
    assert all("which" not in cmd for cmd in manifests)
    sbatch_index = next(
        i for i, cmd in enumerate(commands)
        if "&& sbatch submit_array.sh" in cmd
    )
    assert max(commands.index(cmd) for cmd in manifests) < sbatch_index


@pytest.mark.parametrize(
    "mixed_params",
    [
        {"run_command": "srun vasp_ncl"},
        {"use_custodian": True},
    ],
)
def test_batch_rejects_mixed_vasp_execution_fingerprints(
    db, workflow_id, config, mixed_params,
):
    task_ids = _make_tasks(db, workflow_id, n=3)
    db.update_task(
        task_ids[1],
        params_json=json.dumps({"software": "vasp", **mixed_params}),
    )
    get_hpc = AsyncMock()

    with patch(
        "catgo.workflow.engine.batch_submitter.get_hpc_connection",
        get_hpc,
    ), patch(
        "catgo.workflow.engine.batch_submitter.map_task_type_to_engine",
        return_value=("vasp_relax", "vasp"),
    ):
        with pytest.raises(
            ValueError,
            match="identical resolved run commands, binary tokens, and custodian modes",
        ):
            _run(submit_batch_tasks(db, task_ids, workflow_id, config))

    get_hpc.assert_not_awaited()
    assert all(
        db.get_task(task_id)["status"] == TaskState.READY.value
        for task_id in task_ids
    )


def test_batch_returns_none_on_empty(db, workflow_id, config):
    """Empty task list returns None without errors."""
    result = _run(submit_batch_tasks(db, [], workflow_id, config))
    assert result is None


def test_batch_rejects_vacuous_input_policy_before_hpc(
    db, workflow_id, config,
):
    task_ids = _make_tasks(
        db,
        workflow_id,
        n=3,
        params={"required_incar_tags": []},
    )
    get_hpc = AsyncMock()
    with patch(
        "catgo.workflow.engine.batch_submitter.get_hpc_connection",
        get_hpc,
    ), patch(
        "catgo.workflow.engine.batch_submitter.map_task_type_to_engine",
        return_value=("vasp_relax", "vasp"),
    ):
        with pytest.raises(ValueError, match="empty declared contract"):
            _run(submit_batch_tasks(db, task_ids, workflow_id, config))
    get_hpc.assert_not_awaited()


def test_batch_returns_none_when_no_hpc(db, workflow_id, config):
    """Returns None when no HPC connection is available."""
    task_ids = _make_tasks(db, workflow_id, n=4)

    with patch("catgo.workflow.engine.batch_submitter.get_hpc_connection", new_callable=AsyncMock, return_value=None), \
         patch("catgo.workflow.engine.batch_submitter.map_task_type_to_engine", return_value=("vasp_relax", "vasp")):
        result = _run(submit_batch_tasks(db, task_ids, workflow_id, config))

    assert result is None


def test_batch_marks_tasks_error_on_sbatch_failure(db, workflow_id, config):
    """When sbatch fails (no job ID in output), tasks get REMOTE_ERROR."""
    task_ids = _make_tasks(db, workflow_id, n=4)
    hpc = _mock_hpc()
    # sbatch returns an error, no job ID
    hpc.conn.run = AsyncMock(return_value=SimpleNamespace(stdout="sbatch: error: invalid partition"))

    with patch("catgo.workflow.engine.batch_submitter.get_hpc_connection", new_callable=AsyncMock, return_value=hpc), \
         patch("catgo.workflow.engine.batch_submitter.get_engine_generator") as mock_gen, \
         patch("catgo.workflow.engine.batch_submitter.resolve_task_inputs", return_value={}), \
         patch("catgo.workflow.engine.batch_submitter.map_task_type_to_engine", return_value=("vasp_relax", "vasp")):

        mock_gen.return_value = AsyncMock()
        job_id = _run(submit_batch_tasks(db, task_ids, workflow_id, config))

    assert job_id is None
    for tid in task_ids:
        task = db.get_task(tid)
        assert task["status"] == TaskState.REMOTE_ERROR.value


def test_array_job_threshold():
    """Verify the threshold constant is sensible."""
    assert ARRAY_JOB_THRESHOLD >= 2
    assert ARRAY_JOB_THRESHOLD <= 10

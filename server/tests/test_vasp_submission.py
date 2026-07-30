"""Unit coverage for VASP pre-submit command/manifest handling."""

import asyncio
import hashlib
import json
import subprocess
import sys
import types
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from catgo.workflow.engine.submitter import (
    _submit_one,
    _validate_explicit_vasp_job_script,
)
from catgo.workflow.engine.vasp_submission import (
    VASP_INPUT_MANIFEST,
    build_vasp_input_manifest_command,
    resolve_vasp_command,
    validate_vasp_job_script,
)
from catgo.workflow.states import TaskState


def _write_inputs(work_dir, names=("INCAR", "POSCAR", "POTCAR", "KPOINTS")):
    for name in names:
        (work_dir / name).write_text(f"{name}\n", encoding="utf-8")


def test_job_script_rejects_hidden_or_second_vasp_execution_path():
    resolution = resolve_vasp_command({}, {})
    with pytest.raises(ValueError, match="control flow"):
        validate_vasp_job_script(
            "if false; then\nsrun vasp_std\nfi\nsrun vasp_ncl\n",
            resolution,
            False,
        )
    with pytest.raises(ValueError, match="differs from the manifest"):
        validate_vasp_job_script(
            "srun vasp_std\nsrun vasp_ncl\n", resolution, False,
        )


@pytest.mark.parametrize(
    "command",
    [
        "true || srun vasp_std",
        "srun vasp_std || true",
        "srun vasp_std; srun vasp_ncl",
        "srun vasp_std && rm -f OUTCAR",
        "srun vasp_std | tee vasp.log",
        "srun vasp_std &",
        "srun vasp_std\ntrue",
    ],
)
def test_resolver_rejects_controlled_or_multi_path_commands(command):
    with pytest.raises(ValueError, match="not auditable|physical shell line"):
        resolve_vasp_command({"run_command": command}, {})


def test_manifest_shell_records_inputs_hashes_and_declared_binary(tmp_path):
    _write_inputs(tmp_path)
    resolution = resolve_vasp_command(
        {"run_command": "srun --hint=nomultithread vasp_ncl"},
        {},
    )
    command = build_vasp_input_manifest_command(str(tmp_path), resolution)

    result = subprocess.run(
        ["/bin/sh", "-c", command],
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    manifest = json.loads((tmp_path / VASP_INPUT_MANIFEST).read_text())
    assert manifest["resolved_run_command"] == "srun --hint=nomultithread vasp_ncl"
    assert manifest["binary"] == "vasp_ncl"
    assert manifest["binary_token"] == "vasp_ncl"
    assert manifest["binary_declared"] is True
    assert manifest["hash_algorithm"] == "sha256"
    assert manifest["hash_available"] is True
    assert manifest["ready"] is True
    assert manifest["missing_mandatory_inputs"] == []
    for name in ("INCAR", "POSCAR", "POTCAR", "KPOINTS"):
        entry = manifest["inputs"][name]
        assert entry["mandatory"] is True
        assert entry["exists"] is True
        if entry["sha256"] is not None:
            expected = hashlib.sha256((tmp_path / name).read_bytes()).hexdigest()
            assert entry["sha256"] == expected

    # Module-loaded binaries are declared only; preflight must not resolve them.
    assert "command -v vasp_ncl" not in command
    assert "which" not in command


def test_manifest_shell_writes_audit_then_fails_closed_on_missing_input(tmp_path):
    _write_inputs(tmp_path, names=("INCAR", "POSCAR", "POTCAR"))
    resolution = resolve_vasp_command({}, {})
    command = build_vasp_input_manifest_command(str(tmp_path), resolution)

    result = subprocess.run(
        ["/bin/sh", "-c", command],
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 66
    assert "missing mandatory inputs: KPOINTS" in result.stderr
    manifest = json.loads((tmp_path / VASP_INPUT_MANIFEST).read_text())
    assert manifest["ready"] is False
    assert manifest["missing_mandatory_inputs"] == ["KPOINTS"]
    assert manifest["inputs"]["KPOINTS"]["exists"] is False


def test_manifest_marks_ambiguous_wrapper_binary_unknown(tmp_path):
    _write_inputs(tmp_path)
    resolution = resolve_vasp_command(
        {"run_command": "bash run_calculation.sh"},
        {},
    )
    command = build_vasp_input_manifest_command(str(tmp_path), resolution)

    result = subprocess.run(
        ["/bin/sh", "-c", command],
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 65
    assert "binary token is unknown; set params.vasp_executable" in result.stderr
    manifest = json.loads((tmp_path / VASP_INPUT_MANIFEST).read_text())
    assert manifest["binary"] is None
    assert manifest["binary_token"] is None
    assert manifest["binary_declared"] is False
    assert manifest["ready"] is False


def test_manifest_rejects_opaque_wrapper_even_with_binary_declaration(tmp_path):
    _write_inputs(tmp_path)
    resolution = resolve_vasp_command(
        {
            "run_command": "bash run_calculation.sh",
            "vasp_executable": "vasp.6.4.2-cp",
        },
        {},
    )
    command = build_vasp_input_manifest_command(str(tmp_path), resolution)

    result = subprocess.run(
        ["/bin/sh", "-c", command],
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 65
    manifest = json.loads((tmp_path / VASP_INPUT_MANIFEST).read_text())
    assert manifest["binary_token"] is None
    assert manifest["binary_declared"] is False
    assert manifest["ready"] is False


def test_explicit_vasp_job_script_rejects_command_drift():
    resolution = resolve_vasp_command(
        {"run_command": "srun --hint=nomultithread vasp_ncl"},
        {},
    )

    with pytest.raises(
        ValueError,
        match="must contain the resolved execution command",
    ):
        _validate_explicit_vasp_job_script(
            "#!/bin/bash\n#SBATCH --time=01:00:00\nsrun vasp_std\n",
            resolution,
            use_custodian=False,
        )


def test_single_submit_uses_resolver_for_custodian_and_preflight_before_submit():
    task = {
        "id": "single-vasp-task",
        "node_id": "single-vasp-no-preview",
        "task_type": "geo_opt",
        "status": TaskState.READY.value,
    }
    params = {
        "software": "vasp",
        "use_custodian": True,
        "job_script": (
            "#!/bin/bash\n"
            "#SBATCH --time=01:00:00\n"
            "cd /scratch/test/single\n"
            "python run_custodian.py\n"
        ),
    }
    config = {
        "hpc": {
            "use_custodian": True,
            "job_defaults": {
                "vasp_command": "srun --hint=nomultithread vasp_ncl",
            },
            "run_commands": {"vasp": "srun rc_vasp_std"},
        },
    }

    db = MagicMock()
    db.get_task.return_value = task
    db.get_workflow.return_value = {"config_json": "{}"}

    hpc = MagicMock()
    hpc.session_id = "test-session"
    hpc.conn.run = AsyncMock(return_value=SimpleNamespace(stdout=""))

    async def run_on_owner(coro_factory):
        return await coro_factory()

    hpc.run_on_owner = AsyncMock(side_effect=run_on_owner)
    events = []

    async def record_manifest(*args, **kwargs):
        events.append("manifest")

    async def record_submit(*args):
        events.append("submit")
        return True, "ok", "12345"

    fake_poller = types.ModuleType("catgo.workflow.engine.poller")
    fake_poller._check_job = AsyncMock(return_value="QUEUED")
    fake_broadcast = types.ModuleType("catgo.workflow.engine.broadcast")
    fake_broadcast.broadcast_stage_message = AsyncMock()
    fake_broadcast.broadcast = AsyncMock()

    with patch(
        "catgo.workflow.engine.submitter.get_hpc_connection",
        new_callable=AsyncMock,
        return_value=hpc,
    ), patch(
        "catgo.workflow.engine.submitter.map_task_type_to_engine",
        return_value=("vasp_relax", "vasp"),
    ), patch(
        "catgo.workflow.engine.submitter.resolve_task_inputs",
        return_value={},
    ), patch(
        "catgo.workflow.engine.submitter.resolve_work_dir",
        return_value="/scratch/test/single",
    ), patch(
        "catgo.workflow.engine.engine_registry.get_engine_generator",
        return_value=AsyncMock(),
    ), patch(
        "catgo.workflow.engine.submitter.write_vasp_input_manifest",
        new_callable=AsyncMock,
        side_effect=record_manifest,
    ) as write_manifest, patch(
        "catgo.workflow.engine.submitter._submit_job",
        new_callable=AsyncMock,
        side_effect=record_submit,
    ), patch.dict(
        sys.modules,
        {
            "catgo.workflow.engine.poller": fake_poller,
            "catgo.workflow.engine.broadcast": fake_broadcast,
        },
    ):
        asyncio.run(_submit_one(db, task, "workflow-1", params, config))

    assert events == ["manifest", "submit"]
    resolution = write_manifest.await_args.args[2]
    assert resolution.command == "srun --hint=nomultithread vasp_ncl"
    assert resolution.binary_token == "vasp_ncl"
    assert resolution.source == "hpc.job_defaults.vasp_command"
    assert write_manifest.await_args.kwargs == {"use_custodian": True}

    custodian_uploads = [
        str(call.args[0])
        for call in hpc.conn.run.call_args_list
        if call.args and "run_custodian.py" in str(call.args[0])
    ]
    assert len(custodian_uploads) == 1
    assert "srun --hint=nomultithread vasp_ncl" in custodian_uploads[0]

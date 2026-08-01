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
    VaspInputPolicy,
    build_vasp_input_manifest_command,
    resolve_vasp_command,
    resolve_vasp_input_policy,
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


@pytest.mark.parametrize("hidden", [
    'echo "hidden: $(srun rogue_vasp)"',
    "echo `srun rogue_vasp`",
    'echo "finished: $(date; srun rogue_vasp)"',
    "echo <(srun rogue_vasp)",
    "echo >(srun rogue_vasp)",
])
def test_job_script_rejects_shell_substitution_hidden_in_echo(hidden):
    resolution = resolve_vasp_command({}, {})
    with pytest.raises(ValueError, match="shell substitution"):
        validate_vasp_job_script(
            f"srun vasp_std\n{hidden}\n", resolution, False,
        )


def test_job_script_allows_the_shipped_timestamp_substitution():
    resolution = resolve_vasp_command({}, {})
    validate_vasp_job_script(
        'srun vasp_std\necho "Calculation finished on $(date)."\n',
        resolution,
        False,
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
    policy = manifest["input_policy"]
    assert policy["schema_version"] == 1
    assert policy["required_keys"] is None
    assert policy["kpoints_policy"] == "vasp_default"
    assert policy["artifact_kind"] == "exact"
    assert policy["checked"] is True
    assert policy["verdicts"] == {"P4": "PASS", "P17": "SKIP"}
    assert policy["violations"] == []
    assert (
        policy["materialization"]["materialized_sha256"]
        == manifest["inputs"]["INCAR"]["sha256"]
    )
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


def test_input_policy_resolver_is_tristate_normalized_and_precedence_aware():
    config = {
        "defaults": {
            "vasp": {
                "required_incar_tags": ["algo"],
                "kpoints_policy": "explicit_regular_mesh",
            },
        },
        "hpc": {
            "job_defaults": {
                "required_incar_tags": ["encut", "ediff"],
                "kpoints_policy": "vasp_default",
            },
        },
    }
    policy = resolve_vasp_input_policy({}, config)
    assert policy == VaspInputPolicy(
        required_keys=("ENCUT", "EDIFF"),
        kpoints_policy="vasp_default",
    )
    policy = resolve_vasp_input_policy(
        {
            "required_incar_tags": None,
            "kpoints_policy": "explicit_regular_mesh",
        },
        config,
    )
    assert policy == VaspInputPolicy(
        required_keys=None,
        kpoints_policy="explicit_regular_mesh",
    )
    for invalid in (
        {"required_incar_tags": []},
        {"required_incar_tags": ["ENCUT", "encut"]},
        {"required_incar_tags": "ENCUT"},
        {"kpoints_policy": "unknown"},
    ):
        with pytest.raises(ValueError):
            resolve_vasp_input_policy(invalid, {})


def test_manifest_enforces_nonblank_required_keys_on_final_incar(tmp_path):
    for name, content in {
        "INCAR": "ENCUT=520;EDIFF=1E-5\nEDIFF=\n",
        "POSCAR": "structure\n",
        "POTCAR": "potential\n",
        "KPOINTS": "mesh\n0\nG\n4 4 1\n",
    }.items():
        (tmp_path / name).write_text(content, encoding="utf-8")
    resolution = resolve_vasp_command({}, {})
    policy = VaspInputPolicy(required_keys=("encut", "ediff"))
    command = build_vasp_input_manifest_command(
        str(tmp_path), resolution, input_policy=policy,
    )
    failed = subprocess.run(
        ["/bin/sh", "-c", command],
        text=True,
        capture_output=True,
        check=False,
    )
    assert failed.returncode == 68
    manifest = json.loads((tmp_path / VASP_INPUT_MANIFEST).read_text())
    assert manifest["ready"] is False
    assert manifest["input_policy"]["required_keys"] == ["ENCUT", "EDIFF"]
    assert manifest["input_policy"]["verdicts"]["P17"] == "FAIL"
    assert manifest["input_policy"]["violations"] == [
        "P17:required_key_missing_or_blank:EDIFF",
    ]

    (tmp_path / "INCAR").write_text(
        "ENCUT=520;EDIFF=1E-5\n", encoding="utf-8",
    )
    passed = subprocess.run(
        ["/bin/sh", "-c", command],
        text=True,
        capture_output=True,
        check=False,
    )
    assert passed.returncode == 0, passed.stderr
    manifest = json.loads((tmp_path / VASP_INPUT_MANIFEST).read_text())
    assert manifest["input_policy"]["verdicts"]["P17"] == "PASS"
    assert manifest["input_policy"]["violations"] == []


def test_manifest_rejects_malformed_final_required_value(tmp_path):
    for name, content in {
        "INCAR": "ENCUT=520\nEDIFF=1E-5\nEDIFF==\n",
        "POSCAR": "structure\n",
        "POTCAR": "potential\n",
        "KPOINTS": "mesh\n0\nG\n4 4 1\n",
    }.items():
        (tmp_path / name).write_text(content, encoding="utf-8")
    command = build_vasp_input_manifest_command(
        str(tmp_path),
        resolve_vasp_command({}, {}),
        input_policy=VaspInputPolicy(required_keys=("ENCUT", "EDIFF")),
    )
    failed = subprocess.run(
        ["/bin/sh", "-c", command],
        text=True,
        capture_output=True,
        check=False,
    )
    assert failed.returncode == 68
    manifest = json.loads((tmp_path / VASP_INPUT_MANIFEST).read_text())
    assert manifest["input_policy"]["verdicts"]["P17"] == "FAIL"
    assert manifest["input_policy"]["violations"] == [
        "P17:required_key_missing_or_blank:EDIFF",
    ]


def test_explicit_regular_mesh_policy_blocks_fallback_but_allows_redundant_tags(
    tmp_path,
):
    for name, content in {
        "INCAR": "ENCUT=520\nKSPACING=0.25\nKGAMMA=.TRUE.\n",
        "POSCAR": "structure\n",
        "POTCAR": "potential\n",
    }.items():
        (tmp_path / name).write_text(content, encoding="utf-8")
    resolution = resolve_vasp_command({}, {})
    policy = VaspInputPolicy(kpoints_policy="explicit_regular_mesh")
    command = build_vasp_input_manifest_command(
        str(tmp_path), resolution, input_policy=policy,
    )
    missing = subprocess.run(
        ["/bin/sh", "-c", command],
        text=True,
        capture_output=True,
        check=False,
    )
    assert missing.returncode == 68
    manifest = json.loads((tmp_path / VASP_INPUT_MANIFEST).read_text())
    assert manifest["inputs"]["KPOINTS"]["mandatory"] is True
    assert manifest["input_policy"]["violations"] == [
        "P4:explicit_kpoints_missing",
    ]

    (tmp_path / "KPOINTS").write_text(
        "\n0\nM\n4 4 1\n0 0 0\n", encoding="utf-8",
    )
    passed = subprocess.run(
        ["/bin/sh", "-c", command],
        text=True,
        capture_output=True,
        check=False,
    )
    assert passed.returncode == 0, passed.stderr
    manifest = json.loads((tmp_path / VASP_INPUT_MANIFEST).read_text())
    assert manifest["input_policy"]["verdicts"]["P4"] == "PASS"
    assert manifest["input_policy"]["violations"] == []

    (tmp_path / "KPOINTS").write_text("   \n", encoding="utf-8")
    malformed = subprocess.run(
        ["/bin/sh", "-c", command],
        text=True,
        capture_output=True,
        check=False,
    )
    assert malformed.returncode == 68
    manifest = json.loads((tmp_path / VASP_INPUT_MANIFEST).read_text())
    assert manifest["input_policy"]["violations"] == [
        "P4:explicit_regular_mesh_malformed",
    ]

    (tmp_path / "KPOINTS").write_text(
        "mesh\n0\nM\n٤ ٤ ١\n0 0 0\n", encoding="utf-8",
    )
    malformed_unicode = subprocess.run(
        ["/bin/sh", "-c", command],
        text=True,
        capture_output=True,
        check=False,
    )
    assert malformed_unicode.returncode == 68
    manifest = json.loads((tmp_path / VASP_INPUT_MANIFEST).read_text())
    assert manifest["input_policy"]["violations"] == [
        "P4:explicit_regular_mesh_malformed",
    ]

    (tmp_path / "KPOINTS").write_text(
        "mesh\n0\nM\n4 4 1\n1_0 0 0\n", encoding="utf-8",
    )
    malformed_numeric = subprocess.run(
        ["/bin/sh", "-c", command],
        text=True,
        capture_output=True,
        check=False,
    )
    assert malformed_numeric.returncode == 68
    manifest = json.loads((tmp_path / VASP_INPUT_MANIFEST).read_text())
    assert manifest["input_policy"]["violations"] == [
        "P4:explicit_regular_mesh_malformed",
    ]


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
        "required_incar_tags": ["encut", "ediff"],
        "kpoints_policy": "explicit_regular_mesh",
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
    assert write_manifest.await_args.kwargs == {
        "use_custodian": True,
        "input_policy": VaspInputPolicy(
            required_keys=("ENCUT", "EDIFF"),
            kpoints_policy="explicit_regular_mesh",
        ),
    }

    custodian_uploads = [
        str(call.args[0])
        for call in hpc.conn.run.call_args_list
        if call.args and "run_custodian.py" in str(call.args[0])
    ]
    assert len(custodian_uploads) == 1
    assert "srun --hint=nomultithread vasp_ncl" in custodian_uploads[0]

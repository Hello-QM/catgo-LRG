# server/tests/test_job_script.py
"""Tests for auto job script generation."""
import pytest
from catgo.workflow.engine.job_script import generate_job_script
from catgo.workflow.engine.vasp_submission import resolve_vasp_command


@pytest.fixture
def task():
    return {"id": "abc12345def67890", "task_type": "geo_opt"}


@pytest.fixture
def config():
    return {
        "hpc": {
            "job_defaults": {
                "partition": "shared",
                "account": "sdp126",
                "nodes": 1,
                "ntasks": 32,
                "walltime": "24:00:00",
                "module_loads": "module load slurm cpu/0.17.3b",
                "env_setup": "source /home/gliu3/intel/oneapi/setvars.sh",
            },
            "run_commands": {
                "vasp": "srun --mpi=pmi2 vasp_std",
            },
        }
    }


def test_generates_sbatch_headers(task, config):
    script = generate_job_script("vasp", "/work/test", task, {}, config)
    assert "#!/bin/bash" in script
    assert "#SBATCH --partition=shared" in script
    assert "#SBATCH --account=sdp126" in script
    assert "#SBATCH --nodes=1" in script
    assert "#SBATCH --ntasks=32" in script
    assert "#SBATCH --time=24:00:00" in script


def test_includes_run_command(task, config):
    script = generate_job_script("vasp", "/work/test", task, {}, config)
    assert "srun --mpi=pmi2 vasp_std" in script


def test_includes_module_loads(task, config):
    script = generate_job_script("vasp", "/work/test", task, {}, config)
    assert "module load slurm cpu/0.17.3b" in script


def test_includes_env_setup(task, config):
    script = generate_job_script("vasp", "/work/test", task, {}, config)
    assert "source /home/gliu3/intel/oneapi/setvars.sh" in script


def test_params_override_defaults(task, config):
    params = {"ntasks": 64, "partition": "compute", "walltime": "02:00:00"}
    script = generate_job_script("vasp", "/work/test", task, params, config)
    assert "#SBATCH --ntasks=64" in script
    assert "#SBATCH --partition=compute" in script
    assert "#SBATCH --time=02:00:00" in script


def test_custodian_overrides_vasp_command(task, config):
    params = {"use_custodian": True}
    script = generate_job_script("vasp", "/work/test", task, params, config)
    assert "python run_custodian.py" in script
    assert "vasp_std" not in script


def test_vasp_executable_override(task, config):
    params = {"vasp_executable": "vasp_gam"}
    script = generate_job_script("vasp", "/work/test", task, params, config)
    assert "vasp_gam" in script


def test_vasp_executable_override_preserves_configured_binary_directory():
    config = {
        "hpc": {
            "job_defaults": {
                "vasp_command": "srun $VASP_HOME/bin/vasp_std",
            },
        },
    }
    resolved = resolve_vasp_command({"vasp_executable": "vasp_ncl"}, config)
    assert resolved.command == "srun $VASP_HOME/bin/vasp_ncl"
    assert resolved.binary_token == "$VASP_HOME/bin/vasp_ncl"


def test_vasp_binary_token_keeps_cp_build_identity():
    resolved = resolve_vasp_command(
        {"run_command": "srun /opt/vasp/bin/vasp.6.4.2-cp"},
        {},
    )
    assert resolved.binary_token == "/opt/vasp/bin/vasp.6.4.2-cp"


def test_vasp_binary_token_uses_launcher_executable_not_trailing_argument():
    resolved = resolve_vasp_command(
        {"run_command": "mpirun -np 32 custom_vasp input.dat > vasp.out"},
        {},
    )
    assert resolved.binary_token == "custom_vasp"


def test_vasp_binary_token_is_unknown_when_wrapper_is_ambiguous():
    resolved = resolve_vasp_command(
        {"run_command": "bash run_calculation.sh"},
        {},
    )
    assert resolved.binary_token is None


def test_vasp_binary_token_rejects_opaque_wrapper_declaration():
    resolved = resolve_vasp_command(
        {
            "run_command": "bash run_calculation.sh",
            "vasp_executable": "vasp.6.4.2-cp",
        },
        {},
    )
    assert resolved.command == "bash run_calculation.sh"
    assert resolved.binary_token is None


def test_vasp_command_resolver_precedence(task):
    config = {
        "hpc": {
            "job_defaults": {"vasp_command": "srun jd_vasp"},
            "run_commands": {"vasp": "srun rc_vasp"},
        },
    }

    resolved = resolve_vasp_command({"run_command": "srun param_vasp"}, config)
    assert resolved.command == "srun param_vasp"
    assert resolved.source == "params.run_command"

    resolved = resolve_vasp_command({}, config)
    assert resolved.command == "srun jd_vasp"
    assert resolved.source == "hpc.job_defaults.vasp_command"
    assert "srun jd_vasp" in generate_job_script("vasp", "/work/test", task, {}, config)

    del config["hpc"]["job_defaults"]["vasp_command"]
    assert resolve_vasp_command({}, config).command == "srun rc_vasp"

    del config["hpc"]["run_commands"]["vasp"]
    assert resolve_vasp_command({}, config).command == "srun vasp_std"


def test_custom_template(task, config):
    params = {"job_script_template": "#!/bin/bash\n#SBATCH --time={{walltime}}\n{{run_command}}"}
    script = generate_job_script("vasp", "/work/test", task, params, config)
    assert "#SBATCH --time=24:00:00" in script
    assert "srun --mpi=pmi2 vasp_std" in script


def test_default_engine_commands(task):
    config = {"hpc": {}}
    script = generate_job_script("cp2k", "/work/test", task, {}, config)
    assert "srun cp2k.popt" in script


def test_strips_empty_sbatch_lines(task):
    config = {"hpc": {"job_defaults": {"account": ""}}}
    script = generate_job_script("vasp", "/work/test", task, {}, config)
    assert "#SBATCH --account=" not in script

import inspect

import pytest

from catgo.mcp_tools.workflow_tools import _normalize_run_config_aliases
from catgo.workflow.engine.job_script import generate_job_script
from catgo.workflow.engine.submitter import _submit_job


class _Result:
    def __init__(self, stdout="", stderr="", exit_status=0):
        self.stdout = stdout
        self.stderr = stderr
        self.exit_status = exit_status


class _Conn:
    def __init__(self):
        self.commands = []

    async def run(self, command, check=False):
        self.commands.append(command)
        if "qsub submit.sh" in command:
            return _Result(stdout="12345.server\n")
        return _Result()


class _Scheduler:
    def __init__(self):
        self.calls = []

    async def submit_job(self, *args, **kwargs):
        self.calls.append(kwargs)
        return True, "Job submitted: 99", "99"


class _Hpc:
    def __init__(self):
        self.conn = _Conn()
        self.scheduler = _Scheduler()

    async def run_on_owner(self, fn):
        result = fn()
        if inspect.isawaitable(result):
            return await result
        return result


@pytest.mark.asyncio
async def test_pbs_directive_script_uses_qsub_without_wrapping():
    hpc = _Hpc()
    script = """#!/bin/bash
#PBS -N catgo-test
#PBS -l nodes=2:ppn=8
#PBS -l walltime=12:00:00

echo run
"""

    success, _message, job_id = await _submit_job(
        hpc, "/work/calc", "geo_opt", script, {}, {}
    )

    assert success
    assert job_id == "12345.server"
    assert any("qsub submit.sh" in cmd for cmd in hpc.conn.commands)
    assert hpc.scheduler.calls == []


@pytest.mark.asyncio
async def test_scheduler_auto_header_uses_job_defaults_and_ppn_alias():
    hpc = _Hpc()
    config = {
        "hpc": {
            "job_defaults": {
                "nodes": 3,
                "ppn": 12,
                "walltime": "08:30:00",
                "queue": "batch",
            }
        }
    }

    success, _message, job_id = await _submit_job(
        hpc, "/work/calc", "geo_opt", "echo run", {}, config
    )

    assert success
    assert job_id == "99"
    call = hpc.scheduler.calls[0]
    assert call["nodes"] == 3
    assert call["cpus_per_task"] == 12
    assert call["time_limit"] == "08:30:00"
    assert call["partition"] == "batch"


def test_mcp_run_config_accepts_pbs_aliases():
    config = _normalize_run_config_aliases({
        "hpc_session_id": "sess-pbs",
        "queue": "batch",
        "nodes": 2,
        "ppn": 16,
        "walltime": "10:00:00",
        "modules": "module load vasp",
        "env_commands": "source ~/.bashrc",
    })

    assert config["execution_mode"] == "hpc"
    assert config["default_session_id"] == "sess-pbs"
    assert config["default_job_params"] == {
        "partition": "batch",
        "nodes": 2,
        "cpus_per_task": 16,
        "walltime": "10:00:00",
    }
    assert config["cluster_configs"]["sess-pbs"]["module_loads"] == "module load vasp"
    assert config["cluster_configs"]["sess-pbs"]["python_env"] == "source ~/.bashrc"


def test_pbs_template_accepts_ppn_queue_aliases():
    script = generate_job_script(
        "vasp",
        "/work/calc",
        {"id": "task-12345678", "task_type": "geo_opt"},
        {},
        {
            "hpc": {
                "job_script_template": (
                    "#!/bin/bash\n"
                    "#PBS -N {{job_name}}\n"
                    "#PBS -l nodes={{nodes}}:ppn={{cpus_per_task}}\n"
                    "#PBS -l walltime={{walltime}}\n"
                    "#PBS -q {{partition}}\n"
                    "cd {{work_dir}}\n"
                    "{{run_command}}\n"
                ),
                "job_defaults": {
                    "nodes": 4,
                    "ppn": 10,
                    "time_limit": "02:15:00",
                    "queue": "workq",
                },
            }
        },
    )

    assert "#PBS -l nodes=4:ppn=10" in script
    assert "#PBS -l walltime=02:15:00" in script
    assert "#PBS -q workq" in script

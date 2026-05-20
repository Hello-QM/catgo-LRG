"""Tests for ops_submit — handler + helpers for `catgo submit`."""
from __future__ import annotations

import pytest

from pymatgen.core import Lattice, Structure
from catgo.cli.session import Session
from catgo.models.hpc import AuthMethod, HPCProfile, SchedulerType


# ============================================================================
# fixtures
# ============================================================================


def _cu():
    return Structure(Lattice.cubic(3.61), ["Cu"], [[0, 0, 0]])


def _profile_ssh_config(name="lab"):
    return HPCProfile(
        name=name, host="lab.example.com", username="me",
        auth_method=AuthMethod.SSH_CONFIG, ssh_alias=name,
        scheduler=SchedulerType.SLURM,
    )


def _profile_password():
    return HPCProfile(
        name="oldhost", host="oldhost.example.com", username="me",
        auth_method=AuthMethod.PASSWORD,
    )


# ============================================================================
# D6 — SLURM script templates
# ============================================================================


def test_slurm_script_vasp_minimal():
    from catgo.cli.ops_submit import _slurm_script
    script = _slurm_script(code="vasp", job_name="catgo_Cu", nodes=1,
                           walltime_h=24, queue="", prefix="calc")
    lines = script.splitlines()
    assert lines[0] == "#!/bin/bash"
    assert any(line.startswith("#SBATCH --job-name=catgo_Cu") for line in lines)
    assert any(line.startswith("#SBATCH --nodes=1") for line in lines)
    assert any(line.startswith("#SBATCH --time=24:00:00") for line in lines)
    # Body should run VASP with mpirun and capture output
    body = "\n".join(lines)
    assert "mpirun" in body and "vasp_std" in body
    # No partition line when queue is empty
    assert not any("-p " in line and line.startswith("#SBATCH") for line in lines)


def test_slurm_script_vasp_with_queue():
    from catgo.cli.ops_submit import _slurm_script
    script = _slurm_script(code="vasp", job_name="j", nodes=2,
                           walltime_h=12, queue="gpu", prefix="calc")
    assert "#SBATCH -p gpu" in script
    assert "#SBATCH --nodes=2" in script
    assert "#SBATCH --time=12:00:00" in script


def test_slurm_script_cp2k_uses_psmp_and_prefix():
    from catgo.cli.ops_submit import _slurm_script
    script = _slurm_script(code="cp2k", job_name="j", nodes=1,
                           walltime_h=24, queue="", prefix="myrun")
    assert "cp2k.psmp" in script
    assert "myrun.inp" in script
    assert "myrun.out" in script

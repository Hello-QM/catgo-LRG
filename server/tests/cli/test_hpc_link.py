"""Tests for catgo.cli.hpc_link — synchronous ssh/scp/sbatch driver.

All subprocess.run calls are monkeypatched; nothing reaches the network.
"""
from __future__ import annotations

import pytest

from catgo.models.hpc import AuthMethod, HPCProfile, SchedulerType


def _ssh_config_profile() -> HPCProfile:
    return HPCProfile(
        name="lab",
        host="lab.example.com",
        username="me",
        auth_method=AuthMethod.SSH_CONFIG,
        ssh_alias="lab",
        scheduler=SchedulerType.SLURM,
    )


def _key_profile() -> HPCProfile:
    return HPCProfile(
        name="cluster",
        host="cluster.example.com",
        port=2222,
        username="me",
        auth_method=AuthMethod.KEY,
        key_file="/home/me/.ssh/id_rsa_cluster",
        scheduler=SchedulerType.SLURM,
    )


def _password_profile() -> HPCProfile:
    return HPCProfile(
        name="oldhost",
        host="oldhost.example.com",
        username="me",
        auth_method=AuthMethod.PASSWORD,
    )


# ============================================================================
# D1 — auth validation
# ============================================================================


def test_init_accepts_ssh_config_and_key():
    from catgo.cli.hpc_link import HpcLink
    HpcLink(_ssh_config_profile())   # no raise
    HpcLink(_key_profile())          # no raise


def test_init_rejects_password_auth():
    from catgo.cli.hpc_link import HpcError, HpcLink
    with pytest.raises(HpcError) as ei:
        HpcLink(_password_profile())
    msg = str(ei.value)
    assert "password" in msg
    assert "ssh_config or key" in msg

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


# ============================================================================
# D2 — ssh/scp argv builders
# ============================================================================


def test_ssh_argv_for_ssh_config():
    from catgo.cli.hpc_link import HpcLink
    argv = HpcLink(_ssh_config_profile())._ssh_argv("ls /tmp")
    assert argv[0] == "ssh"
    assert "-o" in argv and "BatchMode=yes" in argv
    assert "lab" in argv
    # Remote command wrapped in login shell (so PATH includes sbatch et al.)
    assert any("bash -l -c" in a for a in argv)
    assert any("ls /tmp" in a for a in argv)


def test_ssh_argv_for_key_auth():
    from catgo.cli.hpc_link import HpcLink
    argv = HpcLink(_key_profile())._ssh_argv("echo hi")
    assert argv[0] == "ssh"
    assert "-i" in argv
    i = argv.index("-i")
    assert argv[i + 1] == "/home/me/.ssh/id_rsa_cluster"
    assert "-o" in argv and "BatchMode=yes" in argv
    # ssh uses -p for port
    assert "-p" in argv
    p = argv.index("-p")
    assert argv[p + 1] == "2222"
    assert "me@cluster.example.com" in argv


def test_scp_argv_for_ssh_config():
    from catgo.cli.hpc_link import HpcLink
    argv = HpcLink(_ssh_config_profile())._scp_argv("/tmp/x", "/remote/y")
    assert argv[0] == "scp"
    assert "-o" in argv and "BatchMode=yes" in argv
    assert "/tmp/x" in argv
    assert "lab:/remote/y" in argv


def test_scp_argv_for_key_auth():
    from catgo.cli.hpc_link import HpcLink
    argv = HpcLink(_key_profile())._scp_argv("/tmp/x", "/remote/y")
    assert argv[0] == "scp"
    assert "-i" in argv
    # scp uses -P (capital) for port
    assert "-P" in argv
    p = argv.index("-P")
    assert argv[p + 1] == "2222"
    assert "me@cluster.example.com:/remote/y" in argv

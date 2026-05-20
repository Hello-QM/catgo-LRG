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


# ============================================================================
# D3 — preflight + mkdir_p
# ============================================================================


def _capture_subprocess(monkeypatch, results):
    """Install a fake subprocess.run that pops from `results` (list of
    CompletedProcess-like (rc, stdout, stderr) tuples) and records the
    argv each call received. Returns the recorder list.
    """
    import subprocess as sp

    class _CP:
        def __init__(self, rc, out, err):
            self.returncode = rc
            self.stdout = out
            self.stderr = err

    recorded: list[list[str]] = []

    def fake_run(argv, **kwargs):
        recorded.append(list(argv))
        rc, out, err = results.pop(0)
        return _CP(rc, out, err)

    monkeypatch.setattr(sp, "run", fake_run)
    monkeypatch.setattr("catgo.cli.hpc_link.subprocess.run", fake_run)
    return recorded


def test_preflight_returns_home(monkeypatch):
    from catgo.cli.hpc_link import HpcLink
    rec = _capture_subprocess(monkeypatch, [(0, "/home/u\n", "")])
    link = HpcLink(_ssh_config_profile())
    assert link.preflight() == "/home/u"
    assert rec and rec[0][0] == "ssh"
    assert any("echo $HOME" in a for a in rec[0])


def test_preflight_nonzero_raises_hpcerror(monkeypatch):
    from catgo.cli.hpc_link import HpcError, HpcLink
    _capture_subprocess(monkeypatch, [(255, "", "Permission denied\n")])
    link = HpcLink(_ssh_config_profile())
    with pytest.raises(HpcError) as ei:
        link.preflight()
    msg = str(ei.value)
    assert "lab" in msg
    assert "Permission denied" in msg


def test_preflight_timeout_raises_hpcerror(monkeypatch):
    import subprocess as sp
    from catgo.cli.hpc_link import HpcError, HpcLink

    def fake_run(argv, **kwargs):
        raise sp.TimeoutExpired(cmd=argv, timeout=1)

    monkeypatch.setattr("catgo.cli.hpc_link.subprocess.run", fake_run)
    link = HpcLink(_ssh_config_profile(), timeout=1)
    with pytest.raises(HpcError) as ei:
        link.preflight()
    assert "timed out" in str(ei.value).lower()


# ============================================================================
# D4 — put_text via scp
# ============================================================================


# ============================================================================
# D5 — sbatch
# ============================================================================


def test_sbatch_parses_job_id(monkeypatch):
    from catgo.cli.hpc_link import HpcLink
    rec = _capture_subprocess(
        monkeypatch, [(0, "Submitted batch job 12345\n", "")]
    )
    link = HpcLink(_ssh_config_profile())
    jid = link.sbatch("/work/dir", "catgo_submit.sh")
    assert jid == "12345"
    full = " ".join(rec[0])
    assert "cd /work/dir" in full
    assert "sbatch" in full
    assert "catgo_submit.sh" in full


def test_sbatch_no_job_id_raises_hpcerror(monkeypatch):
    from catgo.cli.hpc_link import HpcError, HpcLink
    _capture_subprocess(monkeypatch, [(0, "weird success\n", "")])
    link = HpcLink(_ssh_config_profile())
    with pytest.raises(HpcError) as ei:
        link.sbatch("/d", "s.sh")
    msg = str(ei.value)
    assert "could not parse job id" in msg
    assert "weird success" in msg


def test_sbatch_nonzero_raises_hpcerror(monkeypatch):
    from catgo.cli.hpc_link import HpcError, HpcLink
    _capture_subprocess(monkeypatch, [(1, "", "Invalid partition\n")])
    link = HpcLink(_ssh_config_profile())
    with pytest.raises(HpcError) as ei:
        link.sbatch("/d", "s.sh")
    msg = str(ei.value)
    assert "sbatch" in msg
    assert "Invalid partition" in msg


def test_put_text_writes_temp_then_scp(monkeypatch, tmp_path):
    from catgo.cli.hpc_link import HpcLink
    rec = _capture_subprocess(monkeypatch, [(0, "", "")])
    link = HpcLink(_ssh_config_profile())
    link.put_text("hello world\n", "/remote/dir/file.txt")
    assert len(rec) == 1
    argv = rec[0]
    assert argv[0] == "scp"
    # Last arg is target; second-to-last is the local tempfile path.
    assert argv[-1] == "lab:/remote/dir/file.txt"
    local = argv[-2]
    # Tempfile must have been unlinked after the call (so we can't read
    # contents now); just verify it WAS a local path string.
    assert local.startswith("/") and not local.startswith("lab:")


def test_put_text_writes_content_visible_to_scp(monkeypatch, tmp_path):
    """The tempfile must exist with the expected content at scp-call
    time. We capture the content from inside the fake before the
    HpcLink unlinks the file."""
    import subprocess as sp
    from catgo.cli.hpc_link import HpcLink
    from pathlib import Path

    captured_content: dict = {}

    class _CP:
        returncode = 0
        stdout = ""
        stderr = ""

    def fake_run(argv, **kwargs):
        # Read the local tempfile (second-to-last argv entry) while it
        # is still on disk.
        local = argv[-2]
        captured_content["text"] = Path(local).read_text()
        return _CP()

    monkeypatch.setattr("catgo.cli.hpc_link.subprocess.run", fake_run)
    link = HpcLink(_ssh_config_profile())
    link.put_text("alpha beta\n", "/r/a.txt")
    assert captured_content["text"] == "alpha beta\n"


def test_put_text_scp_failure_raises_hpcerror(monkeypatch):
    from catgo.cli.hpc_link import HpcError, HpcLink
    _capture_subprocess(monkeypatch, [(1, "", "No such file or directory\n")])
    link = HpcLink(_ssh_config_profile())
    with pytest.raises(HpcError) as ei:
        link.put_text("x", "/no/such/path/file.txt")
    msg = str(ei.value)
    assert "scp" in msg
    assert "lab" in msg
    assert "No such file" in msg


def test_mkdir_p_uses_ssh_mkdir_minus_p(monkeypatch):
    from catgo.cli.hpc_link import HpcLink
    rec = _capture_subprocess(monkeypatch, [(0, "", "")])
    link = HpcLink(_ssh_config_profile())
    link.mkdir_p("~/catgo-jobs/foo bar")
    assert rec and rec[0][0] == "ssh"
    # quoted path appears in the remote command
    full = " ".join(rec[0])
    assert "mkdir -p" in full
    assert "foo bar" in full  # shlex.quote keeps the visible chars


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

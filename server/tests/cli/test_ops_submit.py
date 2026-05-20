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


# ============================================================================
# D7 — deck generators (in-process adapter)
# ============================================================================


def test_generate_vasp_deck_returns_inputs():
    from catgo.cli.ops_submit import _generate_vasp_deck
    deck = _generate_vasp_deck(_cu())
    # Three core VASP files
    for key in ("INCAR", "POSCAR", "KPOINTS"):
        assert key in deck and deck[key].strip(), f"{key} empty"
    # Marker file lists the element so the user knows what POTCAR to fetch
    assert "POTCAR_NEEDED" in deck
    assert "Cu" in deck["POTCAR_NEEDED"]


def test_generate_cp2k_deck_returns_inp_with_prefix():
    from catgo.cli.ops_submit import _generate_cp2k_deck
    deck = _generate_cp2k_deck(_cu(), prefix="myrun")
    assert "myrun.inp" in deck
    assert "&FORCE_EVAL" in deck["myrun.inp"]


# ============================================================================
# D8 — happy paths
# ============================================================================


class _FakeLink:
    """Records every public HpcLink call for the test to inspect."""

    def __init__(self, profile, timeout=60):
        self.profile = profile
        self.timeout = timeout
        self.calls: list[tuple] = []
        self.job_id = "99"

    def preflight(self):
        self.calls.append(("preflight",))
        return "/home/me"

    def mkdir_p(self, remote_dir):
        self.calls.append(("mkdir_p", remote_dir))

    def put_text(self, content, remote_path):
        self.calls.append(("put_text", remote_path, content))

    def sbatch(self, remote_dir, script_name):
        self.calls.append(("sbatch", remote_dir, script_name))
        return self.job_id


@pytest.fixture
def _stub_profile_and_link(monkeypatch):
    """Common setup: one ssh_config profile + fake HpcLink."""
    profile = _profile_ssh_config("lab")
    monkeypatch.setattr(
        "catgo.cli.ops_submit.load_profiles", lambda: [profile]
    )

    created = {}

    def _make(prof, timeout=60):
        link = _FakeLink(prof, timeout=timeout)
        created["link"] = link
        return link

    monkeypatch.setattr("catgo.cli.ops_submit.HpcLink", _make)
    return profile, created


def test_submit_vasp_happy_path(_stub_profile_and_link, tmp_path,
                                  monkeypatch):
    profile, created = _stub_profile_and_link
    monkeypatch.chdir(tmp_path)

    from catgo.cli import ops_submit
    sess = Session()
    sess.structure = _cu()
    res = ops_submit.submit(sess, {
        "code": "vasp", "host": "lab", "queue": "",
        "walltime": 24, "nodes": 1, "remote_dir": "", "job_name": "",
    })

    assert res.ok
    assert "submitted vasp" in res.message
    assert "Cu" in res.message
    assert "job=99" in res.message
    assert "host=lab" in res.message

    link = created["link"]
    method_seq = [c[0] for c in link.calls]
    assert method_seq[0] == "preflight"
    assert method_seq[1] == "mkdir_p"
    # 4 deck files (INCAR/POSCAR/KPOINTS/POTCAR_NEEDED) + 1 submit script
    put_calls = [c for c in link.calls if c[0] == "put_text"]
    put_names = sorted(c[1].rsplit("/", 1)[-1] for c in put_calls)
    assert "INCAR" in put_names
    assert "POSCAR" in put_names
    assert "KPOINTS" in put_names
    assert "POTCAR_NEEDED" in put_names
    assert "catgo_submit.sh" in put_names
    assert method_seq[-1] == "sbatch"

    # Local artifact directory exists in cwd
    artifact = tmp_path / "catgo-submit-99"
    assert artifact.is_dir()
    for f in ("INCAR", "POSCAR", "KPOINTS", "POTCAR_NEEDED",
              "catgo_submit.sh"):
        assert (artifact / f).exists(), f"local copy missing: {f}"
    assert res.artifact == artifact


# ============================================================================
# D9 — precondition / error surfaces
# ============================================================================


def test_submit_no_profiles_errors(monkeypatch):
    from catgo.cli import ops_submit
    from catgo.cli.adapter import OpError
    monkeypatch.setattr(
        "catgo.cli.ops_submit.load_profiles", lambda: []
    )
    sess = Session(); sess.structure = _cu()
    with pytest.raises(OpError) as ei:
        ops_submit.submit(sess, {"code": "vasp", "host": ""})
    msg = str(ei.value)
    assert "no HPC profiles" in msg


def test_submit_unknown_host_errors(monkeypatch):
    from catgo.cli import ops_submit
    from catgo.cli.adapter import OpError
    monkeypatch.setattr(
        "catgo.cli.ops_submit.load_profiles",
        lambda: [_profile_ssh_config("lab")],
    )
    sess = Session(); sess.structure = _cu()
    with pytest.raises(OpError) as ei:
        ops_submit.submit(sess, {"code": "vasp", "host": "nosuch"})
    msg = str(ei.value)
    assert "host 'nosuch' not found" in msg
    assert "lab" in msg  # available list


def test_submit_unsupported_auth_errors(monkeypatch):
    from catgo.cli import ops_submit
    from catgo.cli.adapter import OpError
    monkeypatch.setattr(
        "catgo.cli.ops_submit.load_profiles",
        lambda: [_profile_password()],
    )
    sess = Session(); sess.structure = _cu()
    with pytest.raises(OpError) as ei:
        ops_submit.submit(sess, {"code": "vasp", "host": "oldhost"})
    msg = str(ei.value)
    assert "oldhost" in msg
    assert "password" in msg
    assert "ssh_config or key" in msg


def test_submit_no_structure_and_no_input_errors(monkeypatch):
    from catgo.cli import ops_submit
    from catgo.cli.adapter import OpError
    monkeypatch.setattr(
        "catgo.cli.ops_submit.load_profiles",
        lambda: [_profile_ssh_config("lab")],
    )
    sess = Session()   # no structure
    with pytest.raises(OpError) as ei:
        ops_submit.submit(sess, {"code": "vasp", "host": "lab"})
    msg = str(ei.value)
    assert "requires <input> file or a loaded session structure" in msg


def test_submit_input_file_missing_errors(monkeypatch, tmp_path):
    from catgo.cli import ops_submit
    from catgo.cli.adapter import OpError
    monkeypatch.setattr(
        "catgo.cli.ops_submit.load_profiles",
        lambda: [_profile_ssh_config("lab")],
    )
    sess = Session()
    with pytest.raises(OpError) as ei:
        ops_submit.submit(sess, {
            "code": "vasp", "host": "lab",
            "input": str(tmp_path / "no-such.vasp"),
        })
    assert "submit input not found" in str(ei.value)


def test_submit_unsupported_code_errors(_stub_profile_and_link):
    from catgo.cli import ops_submit
    from catgo.cli.adapter import OpError
    sess = Session(); sess.structure = _cu()
    with pytest.raises(OpError) as ei:
        ops_submit.submit(sess, {"code": "orca", "host": "lab"})
    assert "unsupported code" in str(ei.value)


def test_submit_cp2k_happy_path(_stub_profile_and_link, tmp_path,
                                  monkeypatch):
    profile, created = _stub_profile_and_link
    monkeypatch.chdir(tmp_path)

    from catgo.cli import ops_submit
    sess = Session()
    sess.structure = _cu()
    res = ops_submit.submit(sess, {
        "code": "cp2k", "host": "lab", "queue": "",
        "walltime": 12, "nodes": 1, "remote_dir": "", "job_name": "",
    })
    assert res.ok
    assert "submitted cp2k" in res.message
    link = created["link"]
    put_names = sorted(
        c[1].rsplit("/", 1)[-1] for c in link.calls if c[0] == "put_text"
    )
    # One .inp + one submit script
    assert any(n.endswith(".inp") for n in put_names)
    assert "catgo_submit.sh" in put_names
    # No INCAR/POSCAR/KPOINTS for CP2K
    assert "INCAR" not in put_names

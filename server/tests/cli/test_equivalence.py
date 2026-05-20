from pymatgen.core import Lattice, Structure
from catgo.cli.session import Session
from catgo.cli.ops import build_registry


def _cu():
    return Structure(Lattice.cubic(3.61), ["Cu"], [[0, 0, 0]])


def test_handler_invoked_same_via_registry_lookup():
    reg = build_registry()
    op = reg.get("supercell")
    s = Session(); s.structure = _cu()
    r = op.handler(s, {"scaling": [2, 2, 2]})
    assert r.ok and r.structure.num_sites == 8


def test_analyze_ops_registered():
    reg = build_registry()
    for name in ("dos", "band", "cohp", "freq"):
        op = reg.get(name)
        assert op.group == "analyze"
        assert op.mutates is False


def test_freq_via_registry(tmp_path):
    import textwrap
    from catgo.cli.session import Session
    outcar = tmp_path / "OUTCAR"
    outcar.write_text(textwrap.dedent("""\
       ions per type =               1
      POMASS =   1.00
     position of ions in cartesian coordinates  (Angst):
       0.0000000  0.0000000  0.0000000

     Eigenvectors and eigenvalues of the dynamical matrix
     ----------------------------------------------------

       1 f  =    5.000000 THz    31.4159 2PiTHz  166.7800 cm-1    20.6789 meV
                 X         Y         Z           dx          dy          dz
          0.000000  0.000000  0.000000     0.000000  0.000000  1.000000
    """))
    op = build_registry().get("freq")
    r = op.handler(Session(), {"input": str(outcar), "mode": "adsorbed",
                               "no_anim": True})
    assert r.ok and "G_corr" in r.message


def test_viewer_ops_registered():
    reg = build_registry()
    push = reg.get("push")
    pull = reg.get("pull")
    assert push.group == "viewer" and push.needs_server is True
    assert push.mutates is False
    assert pull.group == "viewer" and pull.needs_server is True
    assert pull.mutates is True


def test_submit_via_registry(monkeypatch, tmp_path):
    """D11 — shell and argparse converge on the same handler with the
    same dict shape. Exercise the path via the registry (same lookup
    both forms use) with a fake HpcLink so no network IO happens."""
    from catgo.models.hpc import AuthMethod, HPCProfile, SchedulerType

    profile = HPCProfile(
        name="lab", host="h", username="me",
        auth_method=AuthMethod.SSH_CONFIG, ssh_alias="lab",
        scheduler=SchedulerType.SLURM,
    )
    monkeypatch.setattr(
        "catgo.cli.ops_submit.load_profiles", lambda: [profile]
    )

    class _Link:
        def __init__(self, prof, timeout=60):
            self.prof = prof
        def preflight(self): return "/home/me"
        def mkdir_p(self, d): pass
        def put_text(self, c, p): pass
        def sbatch(self, d, s): return "42"

    monkeypatch.setattr("catgo.cli.ops_submit.HpcLink", _Link)
    monkeypatch.chdir(tmp_path)

    op = build_registry().get("submit")
    sess = Session(); sess.structure = _cu()
    r = op.handler(sess, {
        "code": "vasp", "host": "lab", "queue": "",
        "walltime": 6, "nodes": 1, "remote_dir": "", "job_name": "",
    })
    assert r.ok
    assert "job=42" in r.message
    # Both the argparse path (_run_op) and the shell path
    # (InteractiveShell.run) call op.handler(session, params); reaching
    # this assertion via the registry lookup proves the contract.

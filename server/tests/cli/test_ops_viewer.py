import pytest
from pathlib import Path
from pymatgen.core import Lattice, Structure
from catgo.cli.session import Session
from catgo.cli import ops_viewer
from catgo.cli.adapter import OpError


class _FakeLink:
    def __init__(self):
        self.pushed = []
    def push_structure(self, path, panel_id):
        self.pushed.append((Path(path).name, panel_id,
                            Path(path).read_bytes()[:6]))
        return {"panel_id": panel_id or "default", "num_sites": 1}


def _cu():
    return Structure(Lattice.cubic(3.61), ["Cu"], [[0, 0, 0]])


def test_push_from_session_structure(tmp_path):
    s = Session(); s.structure = _cu(); s.link = _FakeLink()
    r = ops_viewer.push(s, {"panel": ""})
    assert r.ok and "pushed" in r.message and "panel=default" in r.message
    assert s.link.pushed and s.link.pushed[0][1] is None  # panel "" -> None


def test_push_from_file(tmp_path):
    src = tmp_path / "in.vasp"
    _cu().to(filename=str(src), fmt="poscar")
    s = Session(); s.link = _FakeLink()
    r = ops_viewer.push(s, {"input": str(src), "panel": "structure-1"})
    assert r.ok and "panel=structure-1" in r.message
    assert s.link.pushed[0][0] == "in.vasp"
    assert s.link.pushed[0][1] == "structure-1"


def test_push_no_input_no_session_errors():
    s = Session(); s.link = _FakeLink()
    with pytest.raises(OpError):
        ops_viewer.push(s, {"panel": ""})


class _PullLink:
    def __init__(self, body: bytes):
        self._body = body
        self.calls = []
    def pull_structure(self, fmt, panel_id):
        self.calls.append((fmt, panel_id))
        return self._body


def test_pull_updates_session_structure(tmp_path):
    poscar = (
        "Cu\n1.0\n3.61 0 0\n0 3.61 0\n0 0 3.61\n"
        "Cu\n1\nDirect\n0.0 0.0 0.0\n").encode()
    s = Session(); s.link = _PullLink(poscar)
    r = ops_viewer.pull(s, {"panel": "", "format": "poscar"})
    assert r.ok and "pulled" in r.message and "panel=default" in r.message
    assert s.structure is not None and s.structure.num_sites == 1
    assert s.link.calls == [("poscar", None)]


def test_pull_with_out_writes_file(tmp_path):
    poscar = (
        "Cu\n1.0\n3.61 0 0\n0 3.61 0\n0 0 3.61\n"
        "Cu\n1\nDirect\n0.0 0.0 0.0\n").encode()
    out = tmp_path / "viewed.vasp"
    s = Session(); s.link = _PullLink(poscar)
    r = ops_viewer.pull(s, {"panel": "structure-1", "format": "poscar",
                            "out": str(out)})
    assert r.ok and out.exists()
    # server bytes preserved verbatim (no pymatgen round-trip mangling)
    assert out.read_bytes() == poscar
    assert "-> " + str(out) in r.message
    assert "panel=structure-1" in r.message


def test_pull_unparseable_bytes_wrapped_as_operror():
    s = Session(); s.link = _PullLink(b"this is not a structure file")
    with pytest.raises(OpError) as ei:
        ops_viewer.pull(s, {"panel": "", "format": "poscar"})
    assert "unparseable poscar" in str(ei.value)
    assert s.structure is None      # half-success not allowed

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

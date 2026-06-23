"""freeze_mode=adsorbate fixes the whole slab, frees only tagged adsorbate atoms."""
import json

from pymatgen.core import Lattice, Structure

from workflow.engines.vasp import generate_vasp_input_files


def _tagged_structure() -> str:
    lat = Lattice.from_parameters(3, 3, 20, 90, 90, 90)
    s = Structure(lat, ["Pt", "Pt", "Pt", "O", "H"],
                  [[0, 0, 0.2], [0, 0, 0.3], [0, 0, 0.4], [0, 0, 0.6], [0, 0, 0.65]])
    s.add_site_property("is_adsorbate", [False, False, False, True, True])
    return json.dumps(s.as_dict())


def _counts(poscar: str):
    lines = poscar.splitlines()
    fff = sum(1 for l in lines if "F F F" in l)
    ttt = sum(1 for l in lines if "T T T" in l)
    hdr = any("elective" in l for l in lines[:9])
    return hdr, fff, ttt


def test_adsorbate_mode_freezes_slab_frees_adsorbate():
    files, _, _ = generate_vasp_input_files("freq", {"freeze_mode": "adsorbate"}, _tagged_structure())
    hdr, fff, ttt = _counts(files["POSCAR"])
    assert hdr and fff == 3 and ttt == 2   # 3 slab fixed, 2 adsorbate free


def test_adsorbate_mode_without_tag_warns_and_freezes_nothing():
    lat = Lattice.from_parameters(3, 3, 20, 90, 90, 90)
    s = Structure(lat, ["Pt", "O"], [[0, 0, 0.2], [0, 0, 0.6]])
    files, _, _ = generate_vasp_input_files("freq", {"freeze_mode": "adsorbate"}, json.dumps(s.as_dict()))
    _, fff, _ = _counts(files["POSCAR"])
    assert fff == 0   # no tag -> nothing frozen

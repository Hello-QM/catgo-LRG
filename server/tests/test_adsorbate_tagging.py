"""run_adsorbate_place must tag adsorbate atoms with is_adsorbate=True."""
import json

from pymatgen.core import Lattice, Structure

from catgo.workflow.builtins_impl import run_adsorbate_place


def _slab_json() -> str:
    lat = Lattice.from_parameters(3, 3, 20, 90, 90, 90)
    s = Structure(lat, ["Pt"] * 4, [[0, 0, 0.2], [0, 0, 0.3], [0, 0, 0.4], [0, 0, 0.5]])
    s.add_site_property("selective_dynamics", [[False] * 3, [False] * 3, [True] * 3, [True] * 3])
    return json.dumps(s.as_dict())


def test_adsorbate_atoms_are_tagged():
    out = run_adsorbate_place(structure=_slab_json(), species="OH", site="ontop", height=2.0)
    s = Structure.from_dict(json.loads(out["structure"]))
    tag = s.site_properties.get("is_adsorbate")
    assert tag is not None, "is_adsorbate property missing"
    assert len(tag) == len(s)
    assert tag[:4] == [False, False, False, False]   # slab
    assert all(tag[4:]) and len(tag) > 4              # adsorbate (OH = 2 atoms)

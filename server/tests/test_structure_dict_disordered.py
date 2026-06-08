"""Regression: `_structure_to_pymatgen_dict` must not crash on disordered sites.

Bug (2026-06-04): the workflow engine called `site.specie` on every site. For a
disordered / partial-occupancy `PeriodicSite`, pymatgen's `.specie` property
raises AttributeError (falls through to `__getattr__`), so VASP input generation
died with `AttributeError: attr='specie' not found on PeriodicSite` and the node
retried forever.
"""

from pymatgen.core import Lattice, Structure

from workflow.engines.vasp import _structure_to_pymatgen_dict


def test_disordered_site_does_not_raise():
    """A site shared by two partial-occupancy species must convert cleanly."""
    lattice = Lattice.cubic(3.9)
    struct = Structure(lattice, [{"Pt": 0.5, "Au": 0.5}], [[0.0, 0.0, 0.0]])

    result = _structure_to_pymatgen_dict(struct)

    assert len(result["sites"]) == 1
    elem = result["sites"][0]["species"][0]["element"]
    assert elem in ("Pt", "Au")


def test_ordered_site_still_resolves_element():
    """Ordered sites (the common case) keep returning their element."""
    lattice = Lattice.cubic(3.9)
    struct = Structure(lattice, ["Pt"], [[0.0, 0.0, 0.0]])

    result = _structure_to_pymatgen_dict(struct)

    assert result["sites"][0]["species"][0]["element"] == "Pt"

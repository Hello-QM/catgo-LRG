"""MOFX-DB search wrapper tests (mofdb_client is mocked — no live network)."""
import os
import sys
import types

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest
from pymatgen.core import Structure


class _FakeMof:
    def __init__(self, id, name, database, elements, cif):
        self.id = id
        self.name = name
        self.database = database
        self.elements = elements
        self.cif = cif


_CIF = """data_test
_cell_length_a 10.0
_cell_length_b 10.0
_cell_length_c 10.0
_cell_angle_alpha 90
_cell_angle_beta 90
_cell_angle_gamma 90
_symmetry_space_group_name_H-M 'P 1'
loop_
_atom_site_label
_atom_site_fract_x
_atom_site_fract_y
_atom_site_fract_z
Zn1 0.0 0.0 0.0
O1 0.5 0.5 0.5
"""


def _install_fake(monkeypatch, mofs):
    """Install a fake mofdb_client whose fetch() honors name+database filtering and
    raises if `limit` is passed (mirrors the real client's limit bug, to prove the
    wrapper does NOT pass limit)."""
    fake = types.ModuleType("mofdb_client")

    def fetch(**kwargs):
        if "limit" in kwargs and kwargs["limit"] is not None:
            raise RuntimeError("generator raised StopIteration")  # the real bug
        name = kwargs.get("name")
        database = kwargs.get("database")
        for mof in mofs:
            if name is not None and name.lower() not in mof.name.lower():
                continue
            if database is not None and mof.database != database:
                continue
            yield mof

    fake.fetch = fetch
    monkeypatch.setitem(sys.modules, "mofdb_client", fake)
    return fake


def test_search_maps_mofs_to_hits(monkeypatch):
    mofs = [
        _FakeMof(101, "MOF-5", "CoREMOF 2019", ["Zn", "O", "C"], _CIF),
        _FakeMof(102, "HKUST-1", "CoREMOF 2019", ["Cu", "O", "C"], _CIF),
    ]
    _install_fake(monkeypatch, mofs)
    from catgo.utils.mofdb_search import search_mofs

    res = search_mofs(name="MOF", database="CoREMOF 2019", limit=50)
    assert res["count"] == 1
    hit = res["hits"][0]
    assert hit["name"] == "MOF-5"
    assert hit["id"] == 101
    assert hit["database"] == "CoREMOF 2019"
    assert "Zn" in hit["elements"]


def test_search_caps_at_limit_without_passing_limit_to_fetch(monkeypatch):
    # 5 matches, limit 3 -> exactly 3, and fetch() must NOT receive limit (the fake
    # raises if it does), proving the wrapper caps client-side.
    mofs = [_FakeMof(i, f"M{i}", "hMOF", ["C"], _CIF) for i in range(5)]
    _install_fake(monkeypatch, mofs)
    from catgo.utils.mofdb_search import search_mofs

    res = search_mofs(name=None, database="hMOF", limit=3)
    assert res["count"] == 3


def test_get_structure_by_name_database(monkeypatch):
    mofs = [
        _FakeMof(101, "MOF-5", "CoREMOF 2014", ["Zn"], _CIF),
        _FakeMof(202, "MOF-5", "CoREMOF 2019", ["Zn"], _CIF),
    ]
    _install_fake(monkeypatch, mofs)
    from catgo.utils.mofdb_search import get_mof_structure

    struct, name = get_mof_structure(name="MOF-5", database="CoREMOF 2019")
    assert isinstance(struct, Structure)
    assert struct.num_sites == 2
    assert name == "MOF-5"


def test_get_structure_unknown_raises_lookuperror(monkeypatch):
    _install_fake(monkeypatch, [])
    from catgo.utils.mofdb_search import get_mof_structure

    with pytest.raises(LookupError):
        get_mof_structure(name="nope", database="CoREMOF 2019")


def test_search_without_client_raises_runtimeerror(monkeypatch):
    monkeypatch.setitem(sys.modules, "mofdb_client", None)
    from catgo.utils.mofdb_search import search_mofs

    with pytest.raises(RuntimeError, match="not installed"):
        search_mofs(name="x", database=None, limit=10)

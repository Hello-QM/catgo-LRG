"""Reticular builder algorithm tests."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest
from pymatgen.core import Structure

from catgo.utils.reticular_algorithm import (
    build_preset,
    build_reticular,
    list_building_blocks,
    list_topologies,
    topology_detail,
)


def test_list_topologies_returns_known_nets():
    topos = list_topologies()
    names = {t["name"] for t in topos}
    assert {"pcu", "tbo", "sod", "dia"} <= names


def test_list_building_blocks_has_connection_counts():
    bbs = list_building_blocks(query="N409")
    assert any(b["name"] == "N409" for b in bbs)
    n409 = next(b for b in bbs if b["name"] == "N409")
    assert n409["n_connection_points"] == 4  # Cu paddlewheel


def test_topology_detail_reports_node_types_and_cn():
    detail = topology_detail("tbo")
    assert detail["name"] == "tbo"
    assert len(detail["node_types"]) == len(detail["node_cn"])
    assert all(cn > 0 for cn in detail["node_cn"])


def test_build_hkust1_advanced():
    struct = build_reticular(topology="tbo", node_bbs={0: "N10", 1: "N409"}, edge_bbs={})
    assert isinstance(struct, Structure)
    assert struct.num_sites > 0
    assert struct.lattice.volume > 0


def test_build_rejects_incompatible_bb():
    # N10 is 3-connected; tbo node type 1 needs 4 -> must raise before building.
    with pytest.raises(ValueError):
        build_reticular(topology="tbo", node_bbs={0: "N10", 1: "N10"}, edge_bbs={})


def test_build_unknown_topology_raises():
    with pytest.raises(ValueError):
        build_reticular(topology="definitely_not_a_net", node_bbs={0: "N10"}, edge_bbs={})


@pytest.mark.parametrize("preset", ["mof-5", "hkust-1", "zif-8", "cof-300"])
def test_build_each_preset(preset):
    struct = build_preset(preset)
    assert struct.num_sites > 0
    assert struct.lattice.volume > 0


def test_build_unknown_preset_raises():
    with pytest.raises(ValueError):
        build_preset("not-a-preset")


def test_router_build_preset_returns_structure():
    from catgo.models.reticular import ReticularBuildRequest
    from catgo.routers.reticular import build_reticular_structure

    res = build_reticular_structure(ReticularBuildRequest(mode="preset", preset="hkust-1"))
    assert res.n_atoms > 0
    assert res.topology == "tbo"
    assert len(res.structure.sites) == res.n_atoms
    assert res.formula


def test_router_build_advanced_bad_topology_raises_400():
    from fastapi import HTTPException
    from catgo.models.reticular import ReticularBuildRequest
    from catgo.routers.reticular import build_reticular_structure

    with pytest.raises(HTTPException) as ei:
        build_reticular_structure(
            ReticularBuildRequest(mode="advanced", topology="not_a_net", node_bbs={0: "N10"})
        )
    assert ei.value.status_code == 400


def test_router_build_preset_missing_preset_raises_400():
    from fastapi import HTTPException
    from catgo.models.reticular import ReticularBuildRequest
    from catgo.routers.reticular import build_reticular_structure

    with pytest.raises(HTTPException) as ei:
        build_reticular_structure(ReticularBuildRequest(mode="preset", preset=None))
    assert ei.value.status_code == 400


def test_router_list_topologies():
    from catgo.routers.reticular import list_topologies_route

    res = list_topologies_route(q="pcu")
    assert any(t.name == "pcu" for t in res)


def test_router_list_building_blocks():
    from catgo.routers.reticular import list_building_blocks_route

    res = list_building_blocks_route(q="N409")
    assert any(b.name == "N409" and b.n_connection_points == 4 for b in res)


def test_router_topology_detail():
    from catgo.routers.reticular import topology_detail_route

    res = topology_detail_route("tbo")
    assert res.name == "tbo"
    assert len(res.node_types) == len(res.node_cn)


def test_router_topology_detail_unknown_raises_404():
    from fastapi import HTTPException
    from catgo.routers.reticular import topology_detail_route

    with pytest.raises(HTTPException) as ei:
        topology_detail_route("not_a_net")
    assert ei.value.status_code == 404


def test_router_list_presets():
    from catgo.routers.reticular import list_presets_route

    res = list_presets_route()
    ids = {p["id"] for p in res}
    assert {"mof-5", "hkust-1", "zif-8", "cof-300"} == ids

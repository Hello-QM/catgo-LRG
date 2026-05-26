"""Wrap vendored PORMAKE to build MOF/COF structures and list DB contents.

Pure functions; no FastAPI/pydantic imports. Errors raised as ValueError so the
router maps them to HTTP 400.
"""

from __future__ import annotations

import logging

from pymatgen.core import Structure
from pymatgen.io.ase import AseAtomsAdaptor

logger = logging.getLogger(__name__)

_DB = None


def _db():
    """Lazily construct the PORMAKE Database (scans bundled data dir once)."""
    global _DB
    if _DB is None:
        import catgo.vendor.pormake as pm

        _DB = pm.Database()
    return _DB


def list_topologies(query: str | None = None) -> list[dict]:
    """Return [{name}] for all bundled RCSR nets (optionally filtered)."""
    names = _db().topo_list
    if query:
        q = query.lower()
        names = [n for n in names if q in n.lower()]
    return [{"name": n} for n in sorted(names)]


def list_building_blocks(query: str | None = None) -> list[dict]:
    """Return [{name, n_connection_points}] for bundled BBs (optionally filtered)."""
    db = _db()
    names = db.bb_list
    if query:
        q = query.lower()
        names = [n for n in names if q in n.lower()]
    out = []
    for n in sorted(names):
        try:
            bb = db.get_bb(n)
            out.append({"name": n, "n_connection_points": int(bb.n_connection_points)})
        except Exception:
            continue
    return out


def topology_detail(name: str) -> dict:
    """Return node/edge type structure for a net so the UI can assign BBs."""
    try:
        topo = _db().get_topo(name)
    except Exception as exc:
        raise ValueError(f"unknown topology '{name}': {exc}") from exc
    node_types = [int(t) for t in topo.unique_node_types]
    node_cn = [int(cn) for cn in topo.unique_cn]
    edge_types = [[int(a), int(b)] for a, b in topo.unique_edge_types]
    return {
        "name": name,
        "node_types": node_types,
        "node_cn": node_cn,
        "edge_types": edge_types,
    }


def _decode_edge_key(key) -> tuple[int, int]:
    """Edge-type keys arrive as 'i,j' strings (JSON) or (i, j) tuples."""
    if isinstance(key, str):
        a, b = key.split(",")
        return (int(a), int(b))
    return (int(key[0]), int(key[1]))


def build_reticular(topology: str, node_bbs: dict, edge_bbs: dict | None = None) -> Structure:
    """Build a framework and return it as a pymatgen Structure.

    node_bbs: {node_type(int): bb_id(str)}
    edge_bbs: {edge_type("i,j" or (i,j)): bb_id(str)}
    """
    import catgo.vendor.pormake as pm

    db = _db()
    try:
        topo = db.get_topo(topology)
    except Exception as exc:
        raise ValueError(f"unknown topology '{topology}': {exc}") from exc

    cn_by_type = {int(t): int(cn) for t, cn in zip(topo.unique_node_types, topo.unique_cn)}
    node_bb_objs = {}
    for t, bb_id in node_bbs.items():
        t = int(t)
        try:
            bb = db.get_bb(bb_id)
        except Exception as exc:
            raise ValueError(f"unknown building block '{bb_id}': {exc}") from exc
        if t in cn_by_type and bb.n_connection_points != cn_by_type[t]:
            raise ValueError(
                f"building block '{bb_id}' has {bb.n_connection_points} connection "
                f"points but node type {t} needs {cn_by_type[t]}"
            )
        node_bb_objs[t] = bb

    edge_bb_objs = {}
    for key, bb_id in (edge_bbs or {}).items():
        et = _decode_edge_key(key)
        try:
            edge_bb_objs[et] = db.get_bb(bb_id)
        except Exception as exc:
            raise ValueError(f"unknown building block '{bb_id}': {exc}") from exc

    builder = pm.Builder()
    try:
        framework = builder.build_by_type(
            topology=topo, node_bbs=node_bb_objs, edge_bbs=edge_bb_objs or None
        )
    except KeyError as exc:
        raise ValueError(f"missing building block assignment: {exc}") from exc
    except Exception as exc:
        raise ValueError(f"build failed: {exc}") from exc

    return AseAtomsAdaptor.get_structure(framework.atoms)


def build_preset(preset: str) -> Structure:
    """Build a curated preset by name."""
    from catgo.models.reticular import PRESETS

    if preset not in PRESETS:
        raise ValueError(f"unknown preset '{preset}'; choices: {sorted(PRESETS)}")
    recipe = PRESETS[preset]
    return build_reticular(
        topology=recipe["topology"],
        node_bbs=recipe["node_bbs"],
        edge_bbs=recipe.get("edge_bbs") or {},
    )

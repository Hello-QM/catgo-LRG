"""Tests for the local workflow dry-run (#225).

The dry-run validates the graph and attempts per-node *local* input
generation (NO HPC, NO DB writes), reporting honest pass/fail with the
real generator error per node. We call the pure service function
``dry_run_graph`` directly to avoid TestClient / real-DB coupling.
"""

from __future__ import annotations

from catgo.routers.workflow_engine import dry_run_graph


# A tiny, valid VASP POSCAR (2-atom bcc-ish W cell) — small + parses cleanly.
VALID_POSCAR = """\
Cu
1.0
3.6 0.0 0.0
0.0 3.6 0.0
0.0 0.0 3.6
Cu
1
direct
0.0 0.0 0.0
"""


def _structure_input_node(node_id="src"):
    return {"id": node_id, "type": "structure_input", "params": {}}


def _geo_opt_vasp_node(node_id="geo"):
    return {"id": node_id, "type": "geo_opt", "params": {"software": "vasp"}}


def test_valid_two_node_graph_ok():
    """structure_input -> geo_opt(vasp), structure supplied => geo node ok, valid."""
    nodes = [_structure_input_node("src"), _geo_opt_vasp_node("geo")]
    edges = [{"from": "src", "to": "geo"}]
    structures = {"geo": VALID_POSCAR}

    out = dry_run_graph(nodes, edges, structures)

    assert out["graph_errors"] == [], out["graph_errors"]
    assert out["results"]["src"]["ok"] is True
    assert out["results"]["geo"]["ok"] is True
    assert out["valid"] is True


def test_missing_structure_is_skipped():
    """No structure for the calc node => skipped (ok None), NOT a failure, still valid."""
    nodes = [_structure_input_node("src"), _geo_opt_vasp_node("geo")]
    edges = [{"from": "src", "to": "geo"}]
    structures = {}  # FE could not supply an upstream structure yet

    out = dry_run_graph(nodes, edges, structures)

    res = out["results"]["geo"]
    assert res["ok"] is None
    assert res.get("skipped")  # non-empty skip reason
    assert "error" not in res or res.get("error") is None
    # A skipped node must not invalidate the whole graph.
    assert out["valid"] is True


def test_cycle_is_invalid():
    """A -> B -> A forms a cycle => valid False, graph_errors non-empty."""
    nodes = [
        {"id": "a", "type": "geo_opt", "params": {"software": "vasp"}},
        {"id": "b", "type": "geo_opt", "params": {"software": "vasp"}},
    ]
    edges = [{"from": "a", "to": "b"}, {"from": "b", "to": "a"}]
    structures = {}

    out = dry_run_graph(nodes, edges, structures)

    assert out["valid"] is False
    assert len(out["graph_errors"]) > 0


def test_bad_params_reports_real_error():
    """An unparseable structure for a vasp node => ok False with a real error message."""
    nodes = [_structure_input_node("src"), _geo_opt_vasp_node("geo")]
    edges = [{"from": "src", "to": "geo"}]
    structures = {"geo": "this is not a valid POSCAR or pymatgen json"}

    out = dry_run_graph(nodes, edges, structures)

    res = out["results"]["geo"]
    assert res["ok"] is False
    assert isinstance(res.get("error"), str) and res["error"].strip()
    assert out["valid"] is False


def test_local_node_validates_without_files():
    """A local node (structure_input) validates ok with no input generation."""
    nodes = [_structure_input_node("src")]
    edges = []
    structures = {}

    out = dry_run_graph(nodes, edges, structures)

    assert out["results"]["src"]["ok"] is True
    assert "skipped" not in out["results"]["src"] or out["results"]["src"].get("skipped") is None
    assert out["valid"] is True

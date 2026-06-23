"""The wired analysis nodes must actually PRODUCE result data (not just route).

Teaching templates need to run, produce a result, and show it. This drives
execute_analysis_node with mocked deps and asserts each wired node type writes a
summary into step_results (which becomes result_json the frontend renders by
analysis_type).
"""

import asyncio

import pytest

import catgo.utils.workflow_db as wdb
from workflow.engines.analysis import execute_analysis_node


def _run(node_type: str, params: dict) -> dict:
    step_results = {
        "p1": {"final_energy": -10.5, "structure_json": "{}"},
        "p2": {"final_energy": -10.2, "structure_json": "{}"},
        "p3": {"final_energy": -10.8, "structure_json": "{}"},
    }

    async def _bc(*a, **k):
        pass

    # Force the V2 path (no V1 workflow_steps row).
    wdb.update_step = lambda *a, **k: (_ for _ in ()).throw(KeyError())
    sid = f"step_{node_type}"
    asyncio.run(execute_analysis_node(
        "wf", sid, node_type, params, [], step_results, None, _bc,
        lambda s, e: ["p1", "p2", "p3"],
    ))
    return step_results.get(sid, {})


@pytest.mark.parametrize("node_type", ["elastic_analysis", "phonon_analysis"])
def test_passthrough_analysis_produces_summary(node_type):
    out = _run(node_type, {})
    summary = out.get("summary", {})
    assert summary, f"{node_type} produced no result"
    assert summary.get("analysis_type")          # frontend renders by this key
    assert "energies" in summary


def test_energy_compare_ranks_energies():
    out = _run("energy_compare", {})
    summary = out["summary"]
    assert summary.get("entries")                 # real comparison data
    assert summary.get("reference_energy_eV") is not None


def test_pick_best_selects_lowest():
    out = _run("pick_best", {})
    summary = out["summary"]
    assert summary.get("best_step_id") == "p3"    # -10.8 is lowest

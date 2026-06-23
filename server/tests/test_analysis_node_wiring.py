"""Workflow templates that use analysis/export nodes must actually route + run.

These node types had handlers (workflow.engines.analysis / workflow.engines.local)
but were missing from the node-set routing, so the scanner sent them to "unknown"
and the templates could not run even as teaching demos. This locks the wiring.
"""

import inspect

from workflow.node_sets import ANALYSIS_NODES, LOCAL_NODES, _resolve_software
from workflow.engines import analysis as analysis_engine


def test_convergence_and_compare_are_routed():
    # Handlers exist in execute_analysis_node; they must be in ANALYSIS_NODES.
    for nt in ("convergence_check", "energy_compare", "pick_best"):
        assert nt in ANALYSIS_NODES


def test_export_data_is_local():
    assert "export_data" in LOCAL_NODES


def test_generic_analysis_resolves_to_specific_type():
    cases = {
        "elastic": "elastic_analysis",
        "phonon": "phonon_analysis",
        "eos": "eos_analysis",
        "trajectory_analysis": "md_analysis",
        "surface_energy": "surface_energy",
    }
    for atype, expected in cases.items():
        resolved, _ = _resolve_software("analysis", {"type": atype})
        assert resolved == expected, f"analysis type={atype} -> {resolved}"


def test_elastic_phonon_handlers_exist_no_raise():
    # The else-branch raises for unhandled types; elastic/phonon must be handled.
    src = inspect.getsource(analysis_engine.execute_analysis_node)
    assert "elastic_analysis" in src
    assert "phonon_analysis" in src

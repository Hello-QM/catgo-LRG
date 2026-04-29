"""Tests for workflow node_sets module (software resolution, engine mapping).

Validates that unified calculation types (geo_opt, single_point, etc.) are
correctly resolved to software-specific node types, and that the engine
lookup tables are consistent and non-overlapping.
"""

import sys
from pathlib import Path

import pytest

_server_dir = str(Path(__file__).resolve().parent.parent)
if _server_dir not in sys.path:
    sys.path.insert(0, _server_dir)

from workflow.node_sets import (
    VASP_CALC_NODES,
    UNIFIED_CALC_NODES,
    LOCAL_NODES,
    MLP_NODES,
    XTB_NODES,
    SELLA_NODES,
    CP2K_NODES,
    LAMMPS_NODES,
    BUILD_NODES,
    ORCA_CALC_NODES,
    GAUSSIAN_CALC_NODES,
    GROMACS_NODES,
    ANALYSIS_NODES,
    HPC_ANALYSIS_NODES,
    POLYMER_SIM_NODES,
    _resolve_software,
    get_engine_for_node,
)


class TestResolveSoftware:
    """Test _resolve_software() maps unified types to software-specific node types."""

    def test_geo_opt_vasp(self):
        """geo_opt + vasp should resolve to vasp_relax."""
        resolved, sw = _resolve_software("geo_opt", {"software": "vasp"})
        assert resolved == "vasp_relax"
        assert sw == "vasp"

    def test_geo_opt_cp2k(self):
        """geo_opt + cp2k should resolve to cp2k_geopt."""
        resolved, sw = _resolve_software("geo_opt", {"software": "cp2k"})
        assert resolved == "cp2k_geopt"
        assert sw == "cp2k"

    def test_geo_opt_orca(self):
        """geo_opt + orca should resolve to orca_opt."""
        resolved, sw = _resolve_software("geo_opt", {"software": "orca"})
        assert resolved == "orca_opt"
        assert sw == "orca"

    def test_single_point_vasp(self):
        """single_point + vasp should resolve to vasp_static."""
        resolved, sw = _resolve_software("single_point", {"software": "vasp"})
        assert resolved == "vasp_static"
        assert sw == "vasp"

    def test_md_lammps(self):
        """md + lammps should resolve to lammps_md."""
        resolved, sw = _resolve_software("md", {"software": "lammps"})
        assert resolved == "lammps_md"
        assert sw == "lammps"

    def test_freq_gaussian(self):
        """freq + gaussian should resolve to gaussian_freq."""
        resolved, sw = _resolve_software("freq", {"software": "gaussian"})
        assert resolved == "gaussian_freq"
        assert sw == "gaussian"

    def test_non_unified_passthrough(self):
        """Non-unified node types should pass through unchanged with empty sw."""
        resolved, sw = _resolve_software("vasp_relax", {"software": "vasp"})
        assert resolved == "vasp_relax"
        assert sw == ""

    def test_default_software_is_vasp(self):
        """When software is not specified, defaults to vasp."""
        resolved, sw = _resolve_software("geo_opt", {})
        assert resolved == "vasp_relax"
        assert sw == "vasp"

    def test_empty_params_defaults_to_vasp(self):
        """Passing an empty params dict should default to vasp, same as missing key."""
        resolved, sw = _resolve_software("single_point", {})
        assert resolved == "vasp_static"
        assert sw == "vasp"

    def test_unknown_software_fallback(self):
        """Unknown software for unified type returns the node type as-is."""
        resolved, sw = _resolve_software("geo_opt", {"software": "unknown_engine"})
        assert resolved == "geo_opt"
        assert sw == "unknown_engine"

    def test_ts_search_sella(self):
        """ts_search + sella should resolve to sella_ts."""
        resolved, sw = _resolve_software("ts_search", {"software": "sella"})
        assert resolved == "sella_ts"
        assert sw == "sella"

    def test_irc_orca(self):
        """irc + orca should resolve to orca_irc."""
        resolved, sw = _resolve_software("irc", {"software": "orca"})
        assert resolved == "orca_irc"
        assert sw == "orca"


class TestGetEngineForNode:
    """Test get_engine_for_node() returns the correct engine key for each node type."""

    def test_vasp_nodes(self):
        """All VASP calc nodes should map to 'vasp' engine."""
        for node in VASP_CALC_NODES:
            assert get_engine_for_node(node) == "vasp", f"{node} should map to vasp"

    def test_cp2k_nodes(self):
        """All CP2K nodes should map to 'cp2k' engine."""
        for node in CP2K_NODES:
            assert get_engine_for_node(node) == "cp2k", f"{node} should map to cp2k"

    def test_mlp_nodes(self):
        """All MLP nodes should map to 'mlp' engine."""
        for node in MLP_NODES:
            assert get_engine_for_node(node) == "mlp", f"{node} should map to mlp"

    def test_xtb_nodes(self):
        """All xTB nodes should map to 'xtb' engine."""
        for node in XTB_NODES:
            assert get_engine_for_node(node) == "xtb", f"{node} should map to xtb"

    def test_local_nodes(self):
        """All local nodes should map to 'local' engine."""
        for node in LOCAL_NODES:
            assert get_engine_for_node(node) == "local", f"{node} should map to local"

    def test_build_nodes(self):
        """All build nodes should map to 'build' engine."""
        for node in BUILD_NODES:
            assert get_engine_for_node(node) == "build", f"{node} should map to build"

    def test_orca_nodes(self):
        """All ORCA nodes should map to 'orca' engine."""
        for node in ORCA_CALC_NODES:
            assert get_engine_for_node(node) == "orca", f"{node} should map to orca"

    def test_gaussian_nodes(self):
        """All Gaussian nodes should map to 'gaussian' engine."""
        for node in GAUSSIAN_CALC_NODES:
            assert get_engine_for_node(node) == "gaussian", f"{node} should map to gaussian"

    def test_lammps_nodes(self):
        """All LAMMPS nodes should map to 'lammps' engine."""
        for node in LAMMPS_NODES:
            assert get_engine_for_node(node) == "lammps", f"{node} should map to lammps"

    def test_gromacs_nodes(self):
        """All GROMACS nodes should map to 'gromacs' engine."""
        for node in GROMACS_NODES:
            assert get_engine_for_node(node) == "gromacs", f"{node} should map to gromacs"

    def test_analysis_nodes(self):
        """All analysis nodes should map to 'analysis' engine."""
        for node in ANALYSIS_NODES:
            assert get_engine_for_node(node) == "analysis", f"{node} should map to analysis"

    def test_hpc_analysis_nodes(self):
        """All HPC analysis nodes should map to 'hpc_analysis' engine."""
        for node in HPC_ANALYSIS_NODES:
            assert get_engine_for_node(node) == "hpc_analysis"

    def test_polymer_sim_nodes(self):
        """All polymer simulation nodes should map to 'polymer_sim' engine."""
        for node in POLYMER_SIM_NODES:
            assert get_engine_for_node(node) == "polymer_sim"

    def test_unknown_node(self):
        """A completely unknown node type should map to 'unknown'."""
        assert get_engine_for_node("totally_fake_node") == "unknown"


class TestNodeSetIntegrity:
    """Validate node type sets are well-formed and non-overlapping."""

    ALL_SETS = [
        VASP_CALC_NODES, CP2K_NODES, MLP_NODES, XTB_NODES,
        SELLA_NODES, LAMMPS_NODES, ORCA_CALC_NODES, GAUSSIAN_CALC_NODES,
        GROMACS_NODES, LOCAL_NODES, ANALYSIS_NODES, HPC_ANALYSIS_NODES,
        BUILD_NODES, POLYMER_SIM_NODES,
    ]

    def test_all_sets_are_nonempty(self):
        """Every registered node set should contain at least one node type."""
        for s in self.ALL_SETS:
            assert len(s) > 0, f"Node set should not be empty: {s}"

    def test_no_overlaps_between_sets(self):
        """Each resolved node type should belong to at most one set."""
        seen = {}
        for s in self.ALL_SETS:
            for node in s:
                if node in seen:
                    pytest.fail(
                        f"Node '{node}' appears in multiple sets: "
                        f"{seen[node]} and {s}"
                    )
                seen[node] = s

    def test_unified_nodes_not_in_resolved_sets(self):
        """Unified nodes (geo_opt, single_point, etc.) should NOT appear in
        resolved node sets, since they get mapped to legacy types first."""
        all_resolved = set()
        for s in self.ALL_SETS:
            all_resolved.update(s)
        overlap = UNIFIED_CALC_NODES & all_resolved
        assert len(overlap) == 0, (
            f"Unified nodes should not be in resolved sets: {overlap}"
        )

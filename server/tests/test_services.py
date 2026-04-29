"""Tests for workflow service modules and MCP workflow tool helpers.

Covers:
- coerce_node_params: type coercion (string -> int/float/bool)
- validate_local_path: safe vs unsafe path validation
- expand_convergence_points: convergence data expansion for various node types
- _validate_graph: DAG validation (valid, cyclic, orphaned edges, missing inputs)
- _graph_snapshot: compact text summary of workflow graphs
"""

import json
import sys
from pathlib import Path

import pytest

_server_dir = str(Path(__file__).resolve().parent.parent)
if _server_dir not in sys.path:
    sys.path.insert(0, _server_dir)

from catgo.services.workflow_service import coerce_node_params, validate_local_path
from catgo.services.workflow_results import expand_convergence_points
from catgo.mcp_tools.workflow_tools import _validate_graph, _graph_snapshot


# ====== coerce_node_params ======


class TestCoerceNodeParams:
    """Test parameter type coercion for workflow nodes."""

    def test_string_to_int(self):
        """Integer strings like '520' are coerced to int."""
        graph = {"nodes": [{"id": "n1", "type": "geo_opt", "params": {"ENCUT": "520"}}], "edges": []}
        result = json.loads(coerce_node_params(json.dumps(graph)))
        assert result["nodes"][0]["params"]["ENCUT"] == 520
        assert isinstance(result["nodes"][0]["params"]["ENCUT"], int)

    def test_string_to_float(self):
        """Float strings like '0.01' and '1e-5' are coerced to float."""
        graph = {"nodes": [{"id": "n1", "type": "geo_opt", "params": {"fmax": "0.01", "EDIFF": "1e-5"}}], "edges": []}
        result = json.loads(coerce_node_params(json.dumps(graph)))
        assert result["nodes"][0]["params"]["fmax"] == 0.01
        assert isinstance(result["nodes"][0]["params"]["fmax"], float)
        assert result["nodes"][0]["params"]["EDIFF"] == 1e-5
        assert isinstance(result["nodes"][0]["params"]["EDIFF"], float)

    def test_string_to_bool(self):
        """Bool strings 'true'/'false' are coerced to bool."""
        graph = {"nodes": [{"id": "n1", "type": "orca_neb_ts", "params": {"ts_opt": "true", "triplets": "False"}}], "edges": []}
        result = json.loads(coerce_node_params(json.dumps(graph)))
        assert result["nodes"][0]["params"]["ts_opt"] is True
        assert result["nodes"][0]["params"]["triplets"] is False

    def test_non_numeric_strings_preserved(self):
        """Non-numeric strings like 'r2SCAN-3c' stay as strings."""
        graph = {"nodes": [{"id": "n1", "type": "orca_opt", "params": {"method": "r2SCAN-3c", "basis": "def2-SVP"}}], "edges": []}
        result = json.loads(coerce_node_params(json.dumps(graph)))
        assert result["nodes"][0]["params"]["method"] == "r2SCAN-3c"
        assert result["nodes"][0]["params"]["basis"] == "def2-SVP"

    def test_already_typed_values_unchanged(self):
        """Values that are already int/float/bool pass through unchanged."""
        graph = {"nodes": [{"id": "n1", "type": "geo_opt", "params": {"ENCUT": 520, "fmax": 0.01, "ts_opt": True}}], "edges": []}
        input_json = json.dumps(graph)
        result = coerce_node_params(input_json)
        # No coercion needed, so the original JSON string is returned
        assert result == input_json

    def test_invalid_json_returns_original(self):
        """Invalid JSON input is returned as-is."""
        bad = "not valid json {"
        assert coerce_node_params(bad) == bad

    def test_none_input_returns_none(self):
        """None input is returned as-is."""
        assert coerce_node_params(None) is None

    def test_empty_graph(self):
        """Graph with no nodes returns unchanged."""
        graph = {"nodes": [], "edges": []}
        input_json = json.dumps(graph)
        assert coerce_node_params(input_json) == input_json

    def test_mixed_types(self):
        """Mix of string-int, string-float, string-bool, and plain string in one node."""
        graph = {"nodes": [{"id": "n1", "type": "x", "params": {
            "a": "42", "b": "3.14", "c": "true", "d": "hello"
        }}], "edges": []}
        result = json.loads(coerce_node_params(json.dumps(graph)))
        p = result["nodes"][0]["params"]
        assert p["a"] == 42 and isinstance(p["a"], int)
        assert p["b"] == 3.14 and isinstance(p["b"], float)
        assert p["c"] is True
        assert p["d"] == "hello"


# ====== validate_local_path ======


class TestValidateLocalPath:
    """Test local path validation for safety."""

    def test_valid_home_path(self):
        """A normal home-directory path resolves successfully."""
        result = validate_local_path("~/calculations")
        assert isinstance(result, Path)
        assert result.is_absolute()

    def test_valid_absolute_path(self):
        """An absolute path with sufficient depth passes."""
        result = validate_local_path("/home/user/work")
        assert result == Path("/home/user/work")

    def test_shallow_path_rejected(self):
        """Root-level paths (too shallow) raise HTTPException."""
        from fastapi import HTTPException
        with pytest.raises(HTTPException) as exc_info:
            validate_local_path("/")
        assert exc_info.value.status_code == 400
        assert "too shallow" in exc_info.value.detail.lower()

    def test_single_component_rejected(self):
        """A single-level path like '/tmp' is rejected (only 1 part)."""
        from fastapi import HTTPException
        with pytest.raises(HTTPException):
            validate_local_path("/tmp")

    def test_path_with_dotdot_resolved(self):
        """Paths with '..' are resolved before validation."""
        result = validate_local_path("/home/user/../user/work")
        assert result == Path("/home/user/work")

    def test_tilde_expansion(self):
        """Tilde is expanded to the actual home directory."""
        result = validate_local_path("~/projects/catgo")
        import os
        home = Path(os.path.expanduser("~"))
        assert result == home / "projects" / "catgo"


# ====== expand_convergence_points ======


class TestExpandConvergencePoints:
    """Test convergence point expansion for various node types."""

    def _base_row(self):
        return {
            "id": "step-1",
            "formula": "H2O",
            "energy": -100.0,
            "workflow_id": "wf-1",
            "step_label": "Opt Step",
        }

    def test_empty_points_returns_empty(self):
        """Empty or None convergence_points returns empty list."""
        assert expand_convergence_points(self._base_row(), [], "orca_opt", "Opt") == []
        assert expand_convergence_points(self._base_row(), None, "orca_opt", "Opt") == []

    def test_single_point_returns_empty(self):
        """A single convergence point returns empty (caller handles single-point)."""
        points = [{"energy": -100.0, "step": 1}]
        assert expand_convergence_points(self._base_row(), points, "orca_opt", "Opt") == []

    def test_opt_expansion(self):
        """orca_opt expands to Step N labels."""
        points = [{"energy": -100.0, "step": 1}, {"energy": -101.0, "step": 2}, {"energy": -101.5, "step": 3}]
        rows = expand_convergence_points(self._base_row(), points, "orca_opt", "Optimization")
        assert len(rows) == 3
        assert rows[0]["step_label"] == "Optimization (Step 1)"
        assert rows[1]["step_label"] == "Optimization (Step 2)"
        assert rows[2]["energy"] == -101.5

    def test_neb_ts_expansion(self):
        """orca_neb_ts expands to Image N labels."""
        points = [{"energy": -50.0, "step": 1}, {"energy": -48.0, "step": 2}]
        rows = expand_convergence_points(self._base_row(), points, "orca_neb_ts", "NEB-TS")
        assert len(rows) == 2
        assert rows[0]["step_label"] == "NEB-TS (Image 1)"
        assert rows[1]["step_label"] == "NEB-TS (Image 2)"

    def test_ts_search_expansion(self):
        """ts_search (unified name) also uses Image N labels."""
        points = [{"energy": -50.0, "step": 1}, {"energy": -48.0, "step": 2}]
        rows = expand_convergence_points(self._base_row(), points, "ts_search", "TS Search")
        assert len(rows) == 2
        assert rows[0]["step_label"] == "TS Search (Image 1)"

    def test_irc_expansion(self):
        """orca_irc expands to IRC Step N labels."""
        points = [{"energy": -60.0, "step": 1}, {"energy": -62.0, "step": 2}]
        rows = expand_convergence_points(self._base_row(), points, "orca_irc", "IRC")
        assert len(rows) == 2
        assert rows[0]["step_label"] == "IRC (IRC Step 1)"

    def test_uvvis_expansion_with_wavelength(self):
        """orca_uvvis expands with wavelength info in labels."""
        points = [
            {"energy": 3.5, "step": 1, "state": 1, "wavelength_nm": 354.3, "oscillator_strength": 0.05},
            {"energy": 4.1, "step": 2, "state": 2, "wavelength_nm": 302.4, "oscillator_strength": 0.12},
        ]
        rows = expand_convergence_points(self._base_row(), points, "orca_uvvis", "UV-Vis")
        assert len(rows) == 2
        assert "354.3 nm" in rows[0]["step_label"]
        assert "State 1" in rows[0]["step_label"]
        assert rows[0]["wavelength_nm"] == 354.3
        assert rows[0]["oscillator_strength"] == 0.05

    def test_uvvis_expansion_without_wavelength(self):
        """orca_uvvis without wavelength shows State N only."""
        points = [{"energy": 3.5, "step": 1, "state": 1}, {"energy": 4.1, "step": 2, "state": 2}]
        rows = expand_convergence_points(self._base_row(), points, "uvvis", "UV-Vis")
        assert "State 1" in rows[0]["step_label"]
        assert "nm" not in rows[0]["step_label"]

    def test_freq_expansion(self):
        """orca_freq shows Frequency Analysis label."""
        points = [{"energy": -100.0, "step": 1}, {"energy": -100.1, "step": 2}]
        rows = expand_convergence_points(self._base_row(), points, "orca_freq", "Freq")
        assert len(rows) == 2
        assert rows[0]["step_label"] == "Freq (Frequency Analysis)"

    def test_single_point_expansion(self):
        """orca_sp shows Energy label."""
        points = [{"energy": -100.0, "step": 1}, {"energy": -100.0, "step": 2}]
        rows = expand_convergence_points(self._base_row(), points, "orca_sp", "SP")
        assert len(rows) == 2
        assert rows[0]["step_label"] == "SP (Energy)"

    def test_base_row_not_mutated(self):
        """Expansion should not mutate the original base_row."""
        base = self._base_row()
        original_energy = base["energy"]
        points = [{"energy": -200.0, "step": 1}, {"energy": -201.0, "step": 2}]
        rows = expand_convergence_points(base, points, "orca_opt", "Opt")
        assert base["energy"] == original_energy
        assert rows[0]["energy"] == -200.0


# ====== _validate_graph ======


class TestValidateGraph:
    """Test workflow DAG validation."""

    def test_valid_linear_graph(self):
        """A simple linear DAG (input -> opt -> sp) has no errors."""
        graph = {
            "nodes": [
                {"id": "n1", "type": "structure_input"},
                {"id": "n2", "type": "geo_opt"},
                {"id": "n3", "type": "single_point"},
            ],
            "edges": [
                {"id": "e1", "from": "n1", "to": "n2", "fromH": "structure", "toH": "structure"},
                {"id": "e2", "from": "n2", "to": "n3", "fromH": "structure", "toH": "structure"},
            ],
        }
        errors, warnings = _validate_graph(graph)
        assert errors == []

    def test_cyclic_graph_detected(self):
        """A cycle (n1 -> n2 -> n3 -> n1) produces an error."""
        graph = {
            "nodes": [
                {"id": "n1", "type": "geo_opt"},
                {"id": "n2", "type": "geo_opt"},
                {"id": "n3", "type": "geo_opt"},
            ],
            "edges": [
                {"id": "e1", "from": "n1", "to": "n2", "fromH": "structure", "toH": "structure"},
                {"id": "e2", "from": "n2", "to": "n3", "fromH": "structure", "toH": "structure"},
                {"id": "e3", "from": "n3", "to": "n1", "fromH": "structure", "toH": "structure"},
            ],
        }
        errors, warnings = _validate_graph(graph)
        assert any("cycle" in e.lower() for e in errors)

    def test_orphaned_edge_source(self):
        """An edge referencing a non-existent source node produces an error."""
        graph = {
            "nodes": [
                {"id": "n1", "type": "structure_input"},
                {"id": "n2", "type": "geo_opt"},
            ],
            "edges": [
                {"id": "e1", "from": "n_missing", "to": "n2", "fromH": "structure", "toH": "structure"},
            ],
        }
        errors, warnings = _validate_graph(graph)
        assert any("missing source" in e.lower() for e in errors)

    def test_orphaned_edge_target(self):
        """An edge referencing a non-existent target node produces an error."""
        graph = {
            "nodes": [
                {"id": "n1", "type": "structure_input"},
            ],
            "edges": [
                {"id": "e1", "from": "n1", "to": "n_ghost", "fromH": "structure", "toH": "structure"},
            ],
        }
        errors, warnings = _validate_graph(graph)
        assert any("missing target" in e.lower() for e in errors)

    def test_missing_input_edge(self):
        """A non-input node with required inputs but no incoming edge is an error."""
        graph = {
            "nodes": [
                {"id": "n1", "type": "structure_input"},
                {"id": "n2", "type": "geo_opt"},  # requires structure input but has no edge
            ],
            "edges": [],
        }
        errors, warnings = _validate_graph(graph)
        assert any("no incoming edge" in e.lower() for e in errors)

    def test_structure_input_without_incoming_ok(self):
        """structure_input nodes don't need incoming edges."""
        graph = {
            "nodes": [
                {"id": "n1", "type": "structure_input"},
            ],
            "edges": [],
        }
        errors, warnings = _validate_graph(graph)
        # structure_input has no required inputs, so no error about missing edges
        missing_input_errors = [e for e in errors if "no incoming edge" in e.lower()]
        assert missing_input_errors == []

    def test_leaf_node_warning(self):
        """A node with outputs but no outgoing edges triggers a warning (not error)."""
        graph = {
            "nodes": [
                {"id": "n1", "type": "structure_input"},
                {"id": "n2", "type": "geo_opt"},
            ],
            "edges": [
                {"id": "e1", "from": "n1", "to": "n2", "fromH": "structure", "toH": "structure"},
            ],
        }
        errors, warnings = _validate_graph(graph)
        # n2 is a leaf (has outputs but no outgoing edges)
        assert any("leaf node" in w.lower() for w in warnings)
        # This should not be an error
        leaf_errors = [e for e in errors if "leaf" in e.lower()]
        assert leaf_errors == []

    def test_handle_mismatch_warning(self):
        """An edge using a non-existent handle triggers a warning."""
        graph = {
            "nodes": [
                {"id": "n1", "type": "structure_input"},
                {"id": "n2", "type": "geo_opt"},
            ],
            "edges": [
                {"id": "e1", "from": "n1", "to": "n2", "fromH": "nonexistent_handle", "toH": "structure"},
            ],
        }
        errors, warnings = _validate_graph(graph)
        assert any("no output" in w.lower() for w in warnings)

    def test_empty_graph_no_errors(self):
        """An empty graph produces no errors or warnings."""
        errors, warnings = _validate_graph({"nodes": [], "edges": []})
        assert errors == []
        assert warnings == []

    def test_alias_node_type_resolved(self):
        """Legacy alias types (vasp_relax -> geo_opt) are resolved for validation."""
        graph = {
            "nodes": [
                {"id": "n1", "type": "structure_input"},
                {"id": "n2", "type": "vasp_relax"},  # alias for geo_opt
            ],
            "edges": [
                {"id": "e1", "from": "n1", "to": "n2", "fromH": "structure", "toH": "structure"},
            ],
        }
        errors, warnings = _validate_graph(graph)
        # Should not error on alias types
        alias_errors = [e for e in errors if "vasp_relax" in e]
        assert alias_errors == []


# ====== _graph_snapshot ======


class TestGraphSnapshot:
    """Test compact text summary of workflow graphs."""

    def test_empty_graph(self):
        """Empty graph shows 0 nodes, 0 edges."""
        result = _graph_snapshot({"nodes": [], "edges": []})
        assert "0 nodes" in result
        assert "0 edges" in result

    def test_single_node(self):
        """Single node graph shows node type and id."""
        graph = {
            "nodes": [{"id": "n1", "type": "structure_input", "params": {}}],
            "edges": [],
        }
        result = _graph_snapshot(graph)
        assert "1 nodes" in result or "1 node" in result
        assert "structure_input" in result
        assert "n1" in result
        assert "Edges: (none)" in result

    def test_linear_graph_ordering(self):
        """Nodes are displayed in topological order."""
        graph = {
            "nodes": [
                {"id": "n2", "type": "geo_opt", "params": {}},
                {"id": "n1", "type": "structure_input", "params": {}},
            ],
            "edges": [
                {"id": "e1", "from": "n1", "to": "n2", "fromH": "structure", "toH": "structure"},
            ],
        }
        result = _graph_snapshot(graph)
        # structure_input(n1) should appear before geo_opt(n2)
        idx_n1 = result.index("structure_input(n1)")
        idx_n2 = result.index("geo_opt(n2)")
        assert idx_n1 < idx_n2

    def test_edge_display(self):
        """Edges show from:handle -> to:handle format."""
        graph = {
            "nodes": [
                {"id": "n1", "type": "structure_input", "params": {}},
                {"id": "n2", "type": "geo_opt", "params": {}},
            ],
            "edges": [
                {"id": "e1", "from": "n1", "to": "n2", "fromH": "structure", "toH": "structure"},
            ],
        }
        result = _graph_snapshot(graph)
        assert "n1:structure" in result
        assert "n2:structure" in result

    def test_params_shown_in_label(self):
        """Key params are included in node labels (up to 4)."""
        graph = {
            "nodes": [{"id": "n1", "type": "geo_opt", "params": {"ENCUT": 520, "EDIFF": 1e-5}}],
            "edges": [],
        }
        result = _graph_snapshot(graph)
        assert "ENCUT=520" in result
        assert "EDIFF=" in result

    def test_internal_params_hidden(self):
        """Params starting with '_' are excluded from labels."""
        graph = {
            "nodes": [{"id": "n1", "type": "geo_opt", "params": {"_internal": "hidden", "ENCUT": 520}}],
            "edges": [],
        }
        result = _graph_snapshot(graph)
        assert "_internal" not in result
        assert "ENCUT=520" in result

    def test_structure_json_param_hidden(self):
        """structure_json param is excluded from labels (too large)."""
        graph = {
            "nodes": [{"id": "n1", "type": "structure_input", "params": {"structure_json": '{"big": "data"}'}}],
            "edges": [],
        }
        result = _graph_snapshot(graph)
        assert "structure_json" not in result

    def test_node_and_edge_counts(self):
        """Summary line shows correct node and edge counts."""
        graph = {
            "nodes": [
                {"id": "n1", "type": "structure_input", "params": {}},
                {"id": "n2", "type": "geo_opt", "params": {}},
                {"id": "n3", "type": "single_point", "params": {}},
            ],
            "edges": [
                {"id": "e1", "from": "n1", "to": "n2", "fromH": "structure", "toH": "structure"},
                {"id": "e2", "from": "n2", "to": "n3", "fromH": "structure", "toH": "structure"},
            ],
        }
        result = _graph_snapshot(graph)
        assert "3 nodes" in result
        assert "2 edges" in result

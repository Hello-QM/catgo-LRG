"""Tests for the mlp_single_point node type.

Tests script generation, node registration, and result parsing
— all without requiring MACE or any ML potential to be installed.
"""

import ast
import json
import os
import tempfile

import pytest


# ---------------------------------------------------------------------------
# 1. Node registration tests
# ---------------------------------------------------------------------------

class TestNodeRegistration:
    """Verify mlp_single_point is correctly registered in the dispatch chain."""

    def test_in_mlp_nodes_set(self):
        from workflow.node_sets import MLP_NODES
        assert "mlp_single_point" in MLP_NODES

    def test_engine_key_is_mlp(self):
        from workflow.node_sets import get_engine_for_node
        assert get_engine_for_node("mlp_single_point") == "mlp"

    def test_resolve_software_single_point_mlp(self):
        from workflow.node_sets import _resolve_software
        resolved, software = _resolve_software("single_point", {"software": "mlp"})
        assert resolved == "mlp_single_point"
        assert software == "mlp"

    def test_hpc_utils_unified_map(self):
        from catgo.workflow.engine.hpc_utils import map_task_type_to_engine
        resolved, engine_key = map_task_type_to_engine("single_point", {"software": "mlp"})
        assert resolved == "mlp_single_point"
        assert engine_key == "mlp"


# ---------------------------------------------------------------------------
# 2. Script generation tests
# ---------------------------------------------------------------------------

class TestScriptGeneration:
    """Verify generated Python scripts are syntactically valid."""

    def test_build_script_defaults(self):
        from workflow.engines.mlp import _build_mlp_script
        script = _build_mlp_script("mlp_single_point", "MACE", {})
        ast.parse(script)
        assert "get_potential_energy" in script
        assert "get_forces" in script
        assert "single_point.json" in script
        assert "mace_mp" in script
        # No optimizer should be present
        assert "LBFGS" not in script
        assert "BFGS" not in script
        assert "FIRE" not in script
        assert "opt.run" not in script

    def test_build_script_chgnet(self):
        from workflow.engines.mlp import _build_mlp_script
        script = _build_mlp_script("mlp_single_point", "CHGNet", {})
        ast.parse(script)
        assert "matgl" in script

    def test_build_script_m3gnet(self):
        from workflow.engines.mlp import _build_mlp_script
        script = _build_mlp_script("mlp_single_point", "M3GNet", {})
        ast.parse(script)
        assert "matgl" in script

    def test_build_script_brace_escaping(self):
        """Verify dict literal has single braces (not doubled)."""
        from workflow.engines.mlp import _build_mlp_script
        script = _build_mlp_script("mlp_single_point", "MACE", {})
        assert "result = {" in script
        assert "result = {{" not in script

    def test_generate_input_files(self):
        from workflow.engines.mlp import generate_mlp_input_files
        poscar = (
            "H2\n1.0\n10.0 0.0 0.0\n0.0 10.0 0.0\n0.0 0.0 10.0\n"
            "H\n2\nCartesian\n0.0 0.0 0.0\n0.0 0.0 0.74\n"
        )
        files = generate_mlp_input_files("mlp_single_point", {}, poscar)
        assert "run_mlp.py" in files
        assert "POSCAR" in files
        ast.parse(files["run_mlp.py"])
        # Also check brace escaping in this path
        assert "result = {" in files["run_mlp.py"]
        assert "result = {{" not in files["run_mlp.py"]

    def test_generate_input_files_both_paths_match(self):
        """Both code paths should produce equivalent scripts."""
        from workflow.engines.mlp import _build_mlp_script, generate_mlp_input_files
        poscar = "H2\n1.0\n10 0 0\n0 10 0\n0 0 10\nH\n2\nCartesian\n0 0 0\n0 0 0.74"
        s1 = _build_mlp_script("mlp_single_point", "MACE", {})
        files = generate_mlp_input_files("mlp_single_point", {"model": "MACE"}, poscar)
        s2 = files["run_mlp.py"]
        # Both should have the same key elements
        for key_phrase in ["get_potential_energy", "single_point.json", "CONTCAR", "Final energy"]:
            assert key_phrase in s1, f"Missing '{key_phrase}' in _build_mlp_script"
            assert key_phrase in s2, f"Missing '{key_phrase}' in generate_mlp_input_files"


# ---------------------------------------------------------------------------
# 3. Result JSON parsing tests
# ---------------------------------------------------------------------------

class TestResultParsing:
    """Test parsing of the single_point.json output file."""

    def test_parse_single_point_json(self):
        """Simulate what execute_mlp_local does after the subprocess."""
        sp_data = {
            "energy_ev": -22.9007,
            "max_force_ev_ang": 0.0234,
            "n_atoms": 4,
        }
        with tempfile.TemporaryDirectory() as tmpdir:
            sp_path = os.path.join(tmpdir, "single_point.json")
            with open(sp_path, "w") as f:
                json.dump(sp_data, f)

            # Simulate the parsing logic from execute_mlp_local
            result_data = {}
            if os.path.isfile(sp_path):
                with open(sp_path, "r") as f:
                    parsed = json.load(f)
                result_data["max_force"] = parsed.get("max_force_ev_ang")
                result_data["n_atoms"] = parsed.get("n_atoms")

            assert result_data["max_force"] == 0.0234
            assert result_data["n_atoms"] == 4

    def test_energy_from_stdout(self):
        """Energy is parsed from stdout 'Final energy:' line, same as mlp_relax."""
        stdout = "Final energy: -22.900660 eV\nMax force: 0.023400 eV/A\n"
        energy = None
        for line in stdout.splitlines():
            if "Final energy:" in line:
                energy = float(line.split("Final energy:")[1].strip().split()[0])
        assert energy == pytest.approx(-22.900660)


# ---------------------------------------------------------------------------
# 4. Downstream compatibility
# ---------------------------------------------------------------------------

class TestDownstreamCompatibility:
    """Verify mlp_single_point energy output works with gibbs_energy."""

    def test_energy_key_matches_gibbs_consumer(self):
        """gibbs_energy looks for 'energy' or 'final_energy' in parent results."""
        # Simulate what execute_mlp_local produces for single_point
        result_data = {
            "energy": -22.9007,  # Parsed from "Final energy:" stdout
            "contcar": "...",
            "max_force": 0.023,
            "n_atoms": 4,
        }
        # gibbs_energy consumer checks pr.get("energy") or pr.get("final_energy")
        e_val = result_data.get("energy") or result_data.get("final_energy")
        assert e_val == -22.9007

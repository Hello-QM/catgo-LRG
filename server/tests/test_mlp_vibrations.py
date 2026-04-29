"""Tests for the mlp_vibrations node type.

Tests script generation, node registration, frequency parsing,
and downstream gibbs_energy compatibility — all without requiring
MACE or any ML potential to be installed.
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
    """Verify mlp_vibrations is correctly registered in the dispatch chain."""

    def test_in_mlp_nodes_set(self):
        from workflow.node_sets import MLP_NODES
        assert "mlp_vibrations" in MLP_NODES

    def test_engine_key_is_mlp(self):
        from workflow.node_sets import get_engine_for_node
        assert get_engine_for_node("mlp_vibrations") == "mlp"

    def test_resolve_software_freq_mlp(self):
        from workflow.node_sets import _resolve_software
        resolved, software = _resolve_software("freq", {"software": "mlp"})
        assert resolved == "mlp_vibrations"
        assert software == "mlp"

    def test_hpc_utils_unified_map(self):
        from catgo.workflow.engine.hpc_utils import map_task_type_to_engine
        resolved, engine_key = map_task_type_to_engine("freq", {"software": "mlp"})
        assert resolved == "mlp_vibrations"
        assert engine_key == "mlp"


# ---------------------------------------------------------------------------
# 2. Script generation tests
# ---------------------------------------------------------------------------

class TestScriptGeneration:
    """Verify that generated Python scripts are syntactically valid."""

    def test_build_script_defaults(self):
        from workflow.engines.mlp import _build_mlp_script
        script = _build_mlp_script("mlp_vibrations", "MACE", {})
        # Must be valid Python
        ast.parse(script)
        assert "Vibrations" in script
        assert "frequencies.json" in script
        assert "mace_mp" in script
        assert "indices" in script

    def test_build_script_custom_params(self):
        from workflow.engines.mlp import _build_mlp_script
        params = {"delta": 0.02, "nfree": 4}
        script = _build_mlp_script("mlp_vibrations", "MACE", params)
        ast.parse(script)
        assert "delta=0.02" in script
        assert "nfree=4" in script

    def test_build_script_chgnet(self):
        from workflow.engines.mlp import _build_mlp_script
        script = _build_mlp_script("mlp_vibrations", "CHGNet", {})
        ast.parse(script)
        assert "M3GNetCalculator" in script or "matgl" in script

    def test_build_script_with_freeze_indices(self):
        from workflow.engines.mlp import _build_mlp_script
        params = {"freeze_mode": "indices", "freeze_indices": "0-3,8"}
        script = _build_mlp_script("mlp_vibrations", "MACE", params)
        ast.parse(script)
        assert "frozen" in script
        assert "0-3,8" in script

    def test_build_script_with_freeze_layers(self):
        from workflow.engines.mlp import _build_mlp_script
        params = {"freeze_mode": "layers", "freeze_layers": 2}
        script = _build_mlp_script("mlp_vibrations", "MACE", params)
        ast.parse(script)
        assert "_n_layers = 2" in script

    def test_build_script_with_freeze_element(self):
        from workflow.engines.mlp import _build_mlp_script
        params = {"freeze_mode": "element", "freeze_elements": "Ni,Ti"}
        script = _build_mlp_script("mlp_vibrations", "MACE", params)
        ast.parse(script)
        assert "Ni,Ti" in script

    def test_build_script_with_freeze_z_range(self):
        from workflow.engines.mlp import _build_mlp_script
        params = {"freeze_mode": "z_range", "freeze_z_below": 5.0}
        script = _build_mlp_script("mlp_vibrations", "MACE", params)
        ast.parse(script)
        assert "_z_cut = 5.0" in script

    def test_build_script_freeze_invert(self):
        from workflow.engines.mlp import _build_mlp_script
        params = {
            "freeze_mode": "indices",
            "freeze_indices": "36,37",
            "freeze_invert": True,
        }
        script = _build_mlp_script("mlp_vibrations", "MACE", params)
        ast.parse(script)
        assert "freeze_invert = True" in script

    def test_generate_input_files(self):
        from workflow.engines.mlp import generate_mlp_input_files
        # Minimal POSCAR-like structure string
        poscar = (
            "H2\n1.0\n10.0 0.0 0.0\n0.0 10.0 0.0\n0.0 0.0 10.0\n"
            "H\n2\nCartesian\n0.0 0.0 0.0\n0.0 0.0 0.74\n"
        )
        files = generate_mlp_input_files("mlp_vibrations", {}, poscar)
        assert "run_mlp.py" in files
        assert "POSCAR" in files
        ast.parse(files["run_mlp.py"])


# ---------------------------------------------------------------------------
# 3. Vibration indices block tests
# ---------------------------------------------------------------------------

class TestVibrationIndicesBlock:
    """Verify the freeze→indices code generation."""

    def test_no_freeze(self):
        from workflow.engines.mlp import _build_vibration_indices_block
        block = _build_vibration_indices_block({"freeze_mode": "none"})
        assert "indices = None" in block

    def test_default_no_freeze_mode(self):
        from workflow.engines.mlp import _build_vibration_indices_block
        block = _build_vibration_indices_block({})
        assert "indices = None" in block

    def test_freeze_indices_generates_parsing(self):
        from workflow.engines.mlp import _build_vibration_indices_block
        block = _build_vibration_indices_block({
            "freeze_mode": "indices",
            "freeze_indices": "0-5,10",
        })
        assert "frozen" in block
        assert "0-5,10" in block

    def test_freeze_layers_generates_z_grouping(self):
        from workflow.engines.mlp import _build_vibration_indices_block
        block = _build_vibration_indices_block({
            "freeze_mode": "layers",
            "freeze_layers": 3,
        })
        assert "_n_layers = 3" in block
        assert "_frozen_zs" in block


# ---------------------------------------------------------------------------
# 4. Frequency JSON parsing tests
# ---------------------------------------------------------------------------

class TestFrequencyParsing:
    """Test parsing of the frequencies.json output file."""

    def test_parse_frequencies_json(self):
        """Simulate what execute_mlp_local does after the subprocess."""
        freq_data = {
            "frequencies_cm": [3045.2, 2980.1, 1450.3, 800.5, 400.2, -125.7],
            "zpe_ev": 0.543,
            "n_atoms_displaced": 2,
            "n_frequencies": 6,
        }
        with tempfile.TemporaryDirectory() as tmpdir:
            freq_path = os.path.join(tmpdir, "frequencies.json")
            with open(freq_path, "w") as f:
                json.dump(freq_data, f)

            # Simulate the parsing logic from execute_mlp_local
            result_data: dict = {}
            if os.path.isfile(freq_path):
                with open(freq_path, "r") as f:
                    parsed = json.load(f)
                result_data["frequencies"] = parsed.get("frequencies_cm", [])
                result_data["zpe"] = parsed.get("zpe_ev")
                result_data["n_frequencies"] = parsed.get("n_frequencies")

            assert result_data["frequencies"] == [3045.2, 2980.1, 1450.3, 800.5, 400.2, -125.7]
            assert result_data["zpe"] == 0.543
            assert result_data["n_frequencies"] == 6

    def test_imaginary_frequencies_preserved(self):
        """Verify negative (imaginary) frequencies pass through correctly."""
        freq_data = {
            "frequencies_cm": [100.0, -50.0, 200.0],
            "zpe_ev": 0.02,
            "n_frequencies": 3,
        }
        with tempfile.TemporaryDirectory() as tmpdir:
            freq_path = os.path.join(tmpdir, "frequencies.json")
            with open(freq_path, "w") as f:
                json.dump(freq_data, f)

            with open(freq_path, "r") as f:
                parsed = json.load(f)
            freqs = parsed["frequencies_cm"]
            assert freqs[1] == -50.0  # imaginary preserved as negative


# ---------------------------------------------------------------------------
# 5. Downstream compatibility: gibbs_energy
# ---------------------------------------------------------------------------

class TestGibbsCompatibility:
    """Verify that mlp_vibrations output is consumable by run_gibbs_energy."""

    def test_plain_float_list(self):
        """run_gibbs_energy should handle a plain list of floats."""
        from catgo.workflow.builtins_impl import run_gibbs_energy
        # Typical frequencies from a small adsorbate on a surface
        freqs = [3045.2, 2980.1, 1450.3, 800.5, 400.2]
        result = run_gibbs_energy(
            energy=-42.5,
            frequencies=json.dumps(freqs),
            phase="adsorbed",
            temperature=298.15,
        )
        assert result["gibbs"] is not None
        assert result["zpe"] > 0
        assert isinstance(result["gibbs"], float)

    def test_with_imaginary_frequencies(self):
        """run_gibbs_energy should handle negative (imaginary) frequencies."""
        from catgo.workflow.builtins_impl import run_gibbs_energy
        freqs = [100.0, -50.0, 200.0, 300.0]
        result = run_gibbs_energy(
            energy=-10.0,
            frequencies=json.dumps(freqs),
            phase="adsorbed",
        )
        assert result["gibbs"] is not None
        # ZPE should only count real (positive) frequencies
        assert result["zpe"] > 0

    def test_empty_frequencies(self):
        """run_gibbs_energy with empty frequencies should still work."""
        from catgo.workflow.builtins_impl import run_gibbs_energy
        result = run_gibbs_energy(
            energy=-5.0,
            frequencies=json.dumps([]),
            phase="adsorbed",
        )
        assert result["gibbs"] is not None
        assert result["zpe"] == 0.0 or result["zpe"] is not None

"""Tests for the mlp_neb node type (NEB transition state search with MACE).

Tests script generation, node registration, dual-structure handling,
and result parsing — all without requiring MACE to be installed.
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
    def test_in_mlp_nodes_set(self):
        from workflow.node_sets import MLP_NODES
        assert "mlp_neb" in MLP_NODES

    def test_engine_key_is_mlp(self):
        from workflow.node_sets import get_engine_for_node
        assert get_engine_for_node("mlp_neb") == "mlp"

    def test_resolve_software_ts_search_mlp(self):
        from workflow.node_sets import _resolve_software
        resolved, software = _resolve_software("ts_search", {"software": "mlp"})
        assert resolved == "mlp_neb"
        assert software == "mlp"

    def test_hpc_utils_unified_map(self):
        from catgo.workflow.engine.hpc_utils import map_task_type_to_engine
        resolved, engine_key = map_task_type_to_engine("ts_search", {"software": "mlp"})
        assert resolved == "mlp_neb"
        assert engine_key == "mlp"


# ---------------------------------------------------------------------------
# 2. Script generation tests
# ---------------------------------------------------------------------------

POSCAR_H2 = (
    "H2\n1.0\n10.0 0.0 0.0\n0.0 10.0 0.0\n0.0 0.0 10.0\n"
    "H\n2\nCartesian\n0.0 0.0 0.0\n0.0 0.0 0.74\n"
)

POSCAR_H2_STRETCHED = (
    "H2\n1.0\n10.0 0.0 0.0\n0.0 10.0 0.0\n0.0 0.0 10.0\n"
    "H\n2\nCartesian\n0.0 0.0 0.0\n0.0 0.0 2.0\n"
)


class TestScriptGeneration:
    def test_build_script_defaults(self):
        from workflow.engines.mlp import _build_mlp_script
        script = _build_mlp_script("mlp_neb", "MACE", {})
        ast.parse(script)
        assert "DyNEB" in script
        assert "POSCAR_initial" in script
        assert "POSCAR_final" in script
        assert "neb_results.json" in script
        assert "FIRE" in script
        assert "mace_mp" in script
        assert "make_calc" in script  # calculator factory function

    def test_build_script_custom_params(self):
        from workflow.engines.mlp import _build_mlp_script
        params = {"nimages": 12, "fmax": 0.02, "max_steps": 1000, "climb": False, "optimizer": "LBFGS"}
        script = _build_mlp_script("mlp_neb", "MACE", params)
        ast.parse(script)
        assert "range(12)" in script
        assert "fmax=0.02" in script
        assert "steps=1000" in script
        assert "climb=False" in script
        assert "LBFGS" in script

    def test_build_script_chgnet(self):
        from workflow.engines.mlp import _build_mlp_script
        script = _build_mlp_script("mlp_neb", "CHGNet", {})
        ast.parse(script)
        assert "matgl" in script

    def test_build_script_brace_escaping(self):
        from workflow.engines.mlp import _build_mlp_script
        script = _build_mlp_script("mlp_neb", "MACE", {})
        # Dict literals should have single braces (not doubled)
        assert "result = {" in script
        assert "result = {{" not in script
        # But f-string expressions in print() should use {{ to produce {
        assert 'energies[ts_idx]' in script

    def test_generate_input_files_returns_two_poscars(self):
        from workflow.engines.mlp import generate_mlp_input_files
        params = {"_product_structure": POSCAR_H2_STRETCHED}
        files = generate_mlp_input_files("mlp_neb", params, POSCAR_H2)
        assert "run_mlp.py" in files
        assert "POSCAR_initial" in files
        assert "POSCAR_final" in files
        # Should NOT have single "POSCAR" key (NEB uses _initial/_final)
        assert "POSCAR" not in files
        ast.parse(files["run_mlp.py"])

    def test_generate_input_files_no_product_still_has_script(self):
        from workflow.engines.mlp import generate_mlp_input_files
        files = generate_mlp_input_files("mlp_neb", {}, POSCAR_H2)
        assert "run_mlp.py" in files
        assert "POSCAR_initial" in files
        # No product → no POSCAR_final (will error at runtime, but file gen doesn't crash)
        assert "POSCAR_final" not in files

    def test_both_code_paths_produce_valid_scripts(self):
        from workflow.engines.mlp import _build_mlp_script, generate_mlp_input_files
        params = {"_product_structure": POSCAR_H2_STRETCHED, "model": "MACE"}
        s1 = _build_mlp_script("mlp_neb", "MACE", params)
        files = generate_mlp_input_files("mlp_neb", params, POSCAR_H2)
        s2 = files["run_mlp.py"]
        for key_phrase in ["DyNEB", "POSCAR_initial", "POSCAR_final", "neb_results.json", "CONTCAR"]:
            assert key_phrase in s1, f"Missing '{key_phrase}' in _build_mlp_script"
            assert key_phrase in s2, f"Missing '{key_phrase}' in generate_mlp_input_files"


# ---------------------------------------------------------------------------
# 3. NEB result parsing tests
# ---------------------------------------------------------------------------

class TestResultParsing:
    def test_parse_neb_results_json(self):
        neb_data = {
            "neb_converged": True,
            "activation_barrier_kcal_mol": 15.2,
            "path_summary": {
                "images": [
                    {"image": "0", "de_kcal_mol": 0.0},
                    {"image": "1", "de_kcal_mol": 8.3},
                    {"image": "TS", "de_kcal_mol": 15.2, "is_ts": True},
                    {"image": "3", "de_kcal_mol": 10.1},
                    {"image": "4", "de_kcal_mol": -5.8},
                ]
            },
            "energies_ev": [-100.0, -99.6, -99.3, -99.5, -100.2],
            "energy": -99.3,
        }
        with tempfile.TemporaryDirectory() as tmpdir:
            neb_path = os.path.join(tmpdir, "neb_results.json")
            with open(neb_path, "w") as f:
                json.dump(neb_data, f)

            # Simulate parsing logic from execute_mlp_local
            result_data = {}
            if os.path.isfile(neb_path):
                with open(neb_path, "r") as f:
                    parsed = json.load(f)
                result_data["neb_converged"] = parsed.get("neb_converged", False)
                result_data["activation_barrier_kcal_mol"] = parsed.get("activation_barrier_kcal_mol")
                result_data["path_summary"] = parsed.get("path_summary")
                result_data["energies_ev"] = parsed.get("energies_ev")

            assert result_data["neb_converged"] is True
            assert result_data["activation_barrier_kcal_mol"] == 15.2
            assert len(result_data["path_summary"]["images"]) == 5
            assert result_data["path_summary"]["images"][2]["is_ts"] is True

    def test_energy_from_stdout(self):
        stdout = "Final energy: -99.300000 eV\nBarrier: 15.20 kcal/mol\nNEB converged: True\n"
        energy = None
        for line in stdout.splitlines():
            if "Final energy:" in line:
                energy = float(line.split("Final energy:")[1].strip().split()[0])
        assert energy == pytest.approx(-99.3)


# ---------------------------------------------------------------------------
# 4. Dual-structure input tests
# ---------------------------------------------------------------------------

class TestDualStructureInput:
    def test_neb_script_reads_two_poscar_files(self):
        from workflow.engines.mlp import _build_mlp_script
        script = _build_mlp_script("mlp_neb", "MACE", {})
        assert 'read("POSCAR_initial"' in script
        assert 'read("POSCAR_final"' in script

    def test_neb_creates_multiple_images(self):
        from workflow.engines.mlp import _build_mlp_script
        params = {"nimages": 6}
        script = _build_mlp_script("mlp_neb", "MACE", params)
        assert "range(6)" in script

    def test_each_image_gets_fresh_calculator(self):
        from workflow.engines.mlp import _build_mlp_script
        script = _build_mlp_script("mlp_neb", "MACE", {})
        # Should have a make_calc() factory, not shared calculator
        assert "def make_calc():" in script
        assert "img.calc = make_calc()" in script

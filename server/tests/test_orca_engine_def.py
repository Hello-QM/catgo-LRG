"""Tests for the ORCA declarative engine definition (engine_defs/orca.yaml)."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
import yaml

_server_dir = str(Path(__file__).resolve().parent.parent)
if _server_dir not in sys.path:
    sys.path.insert(0, _server_dir)

from workflow.engine_defs.schema import validate_engine_spec

YAML_PATH = Path(__file__).resolve().parent.parent / "workflow" / "engine_defs" / "orca.yaml"


@pytest.fixture(scope="module")
def raw_spec():
    """Load the ORCA YAML as a raw dict."""
    return yaml.safe_load(YAML_PATH.read_text())


@pytest.fixture(scope="module")
def spec(raw_spec):
    """Validate and return the typed EngineSpec."""
    return validate_engine_spec(raw_spec)


class TestOrcaYamlLoads:
    def test_yaml_file_exists(self):
        assert YAML_PATH.exists(), f"orca.yaml not found at {YAML_PATH}"

    def test_yaml_parses_without_error(self, raw_spec):
        assert isinstance(raw_spec, dict)

    def test_validate_engine_spec_succeeds(self, spec):
        assert spec is not None


class TestOrcaEngineIdentity:
    def test_engine_name(self, spec):
        assert spec.engine == "orca"

    def test_label(self, spec):
        assert spec.label == "ORCA"

    def test_description_is_non_empty(self, spec):
        assert spec.description.strip()


class TestOrcaCalcTypes:
    def test_supported_calc_types_includes_geo_opt(self, spec):
        assert "geo_opt" in spec.supported_calc_types

    def test_supported_calc_types_includes_single_point(self, spec):
        assert "single_point" in spec.supported_calc_types

    def test_supported_calc_types_includes_freq(self, spec):
        assert "freq" in spec.supported_calc_types

    def test_supported_calc_types_includes_ts_search(self, spec):
        assert "ts_search" in spec.supported_calc_types

    def test_supported_calc_types_includes_irc(self, spec):
        assert "irc" in spec.supported_calc_types

    def test_supported_calc_types_includes_uvvis(self, spec):
        assert "uvvis" in spec.supported_calc_types

    def test_calc_type_mapping_geo_opt(self, spec):
        assert spec.calc_type_mapping.get("geo_opt") == "orca_opt"

    def test_calc_type_mapping_single_point(self, spec):
        assert spec.calc_type_mapping.get("single_point") == "orca_sp"

    def test_calc_type_mapping_freq(self, spec):
        assert spec.calc_type_mapping.get("freq") == "orca_freq"

    def test_calc_type_mapping_ts_search(self, spec):
        assert spec.calc_type_mapping.get("ts_search") == "orca_neb_ts"

    def test_calc_type_mapping_irc(self, spec):
        assert spec.calc_type_mapping.get("irc") == "orca_irc"

    def test_calc_type_mapping_uvvis(self, spec):
        assert spec.calc_type_mapping.get("uvvis") == "orca_uvvis"


class TestOrcaParams:
    def _param(self, spec, key: str):
        for p in spec.params:
            if p.key == key:
                return p
        return None

    def test_method_param_exists(self, spec):
        assert self._param(spec, "method") is not None

    def test_method_default_is_b3lyp(self, spec):
        p = self._param(spec, "method")
        assert p.default == "B3LYP"

    def test_method_options_include_dlpno_ccsdt(self, spec):
        p = self._param(spec, "method")
        values = [opt["value"] for opt in p.options]
        assert "DLPNO-CCSD(T)" in values

    def test_basis_set_param_exists(self, spec):
        assert self._param(spec, "basis_set") is not None

    def test_basis_set_default_is_def2svp(self, spec):
        p = self._param(spec, "basis_set")
        assert p.default == "def2-SVP"

    def test_charge_param_exists(self, spec):
        p = self._param(spec, "charge")
        assert p is not None
        assert p.default == 0

    def test_multiplicity_param_has_range(self, spec):
        p = self._param(spec, "multiplicity")
        assert p is not None
        assert p.range == [1, 10]

    def test_num_cores_param_default(self, spec):
        p = self._param(spec, "num_cores")
        assert p is not None
        assert p.default == 4

    def test_max_iterations_param_exists(self, spec):
        assert self._param(spec, "max_iterations") is not None

    def test_custom_inp_text_has_help(self, spec):
        p = self._param(spec, "custom_inp_text")
        assert p is not None
        assert p.help is not None and len(p.help) > 0

    def test_cartesian_opt_has_show_if(self, spec):
        p = self._param(spec, "cartesian_opt")
        assert p is not None
        assert p.show_if is not None

    def test_nimages_show_if_ts_search(self, spec):
        p = self._param(spec, "nimages")
        assert p is not None
        assert p.show_if is not None
        assert "ts_search" in p.show_if.get("values", [])

    def test_nroots_show_if_uvvis(self, spec):
        p = self._param(spec, "nroots")
        assert p is not None
        assert p.show_if is not None
        assert "uvvis" in p.show_if.get("values", [])

    def test_solvation_show_if_uvvis(self, spec):
        p = self._param(spec, "solvation")
        assert p is not None
        assert p.show_if is not None
        assert "uvvis" in p.show_if.get("values", [])

    def test_solvation_options_include_cpcm_and_smd(self, spec):
        p = self._param(spec, "solvation")
        values = [opt["value"] for opt in p.options]
        assert "CPCM" in values
        assert "SMD" in values


class TestOrcaInputFiles:
    def test_orca_inp_defined(self, spec):
        assert "ORCA.inp" in spec.input_files

    def test_poscar_defined(self, spec):
        assert "POSCAR" in spec.input_files

    def test_orca_inp_source_is_hook(self, spec):
        assert spec.input_files["ORCA.inp"].source == "hook"

    def test_poscar_source_is_structure(self, spec):
        assert spec.input_files["POSCAR"].source == "structure"

    def test_poscar_format_is_poscar(self, spec):
        assert spec.input_files["POSCAR"].format == "poscar"


class TestOrcaRunAndOutput:
    def test_run_command_uses_orca(self, spec):
        assert any("orca" in cmd.lower() for cmd in spec.run_commands)

    def test_run_command_references_orca_inp(self, spec):
        assert any("ORCA.inp" in cmd for cmd in spec.run_commands)

    def test_output_files_has_log(self, spec):
        assert "log" in spec.output_files

    def test_output_files_has_structure(self, spec):
        assert "structure" in spec.output_files

    def test_output_log_is_orca_out(self, spec):
        assert spec.output_files["log"] == "ORCA.out"


class TestOrcaHooks:
    def test_pre_generate_hook_defined(self, spec):
        assert "pre_generate" in spec.hooks

    def test_pre_generate_points_to_orca_hooks(self, spec):
        hook_ref = spec.hooks["pre_generate"]
        assert hook_ref is not None
        assert "orca_hooks" in hook_ref
        assert "generate_inputs" in hook_ref


class TestOrcaSafety:
    def test_safety_is_safe(self, spec):
        assert spec.safety == "safe"

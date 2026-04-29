"""Tests for the CP2K declarative engine definition (engine_defs/cp2k.yaml)."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
import yaml

_server_dir = str(Path(__file__).resolve().parent.parent)
if _server_dir not in sys.path:
    sys.path.insert(0, _server_dir)

from workflow.engine_defs.schema import validate_engine_spec

YAML_PATH = Path(__file__).resolve().parent.parent / "workflow" / "engine_defs" / "cp2k.yaml"


@pytest.fixture(scope="module")
def raw_spec():
    """Load the CP2K YAML as a raw dict."""
    return yaml.safe_load(YAML_PATH.read_text())


@pytest.fixture(scope="module")
def spec(raw_spec):
    """Validate and return the typed EngineSpec."""
    return validate_engine_spec(raw_spec)


class TestCp2kYamlLoads:
    def test_yaml_file_exists(self):
        assert YAML_PATH.exists(), f"cp2k.yaml not found at {YAML_PATH}"

    def test_yaml_parses_without_error(self, raw_spec):
        assert isinstance(raw_spec, dict)

    def test_validate_engine_spec_succeeds(self, spec):
        assert spec is not None


class TestCp2kEngineIdentity:
    def test_engine_name(self, spec):
        assert spec.engine == "cp2k"

    def test_label(self, spec):
        assert spec.label == "CP2K"

    def test_description_is_non_empty(self, spec):
        assert spec.description.strip()


class TestCp2kCalcTypes:
    def test_supported_calc_types_includes_geo_opt(self, spec):
        assert "geo_opt" in spec.supported_calc_types

    def test_supported_calc_types_includes_single_point(self, spec):
        assert "single_point" in spec.supported_calc_types

    def test_supported_calc_types_includes_cell_opt(self, spec):
        assert "cell_opt" in spec.supported_calc_types

    def test_supported_calc_types_includes_md(self, spec):
        assert "md" in spec.supported_calc_types

    def test_supported_calc_types_includes_freq(self, spec):
        assert "freq" in spec.supported_calc_types

    def test_calc_type_mapping_geo_opt(self, spec):
        assert spec.calc_type_mapping.get("geo_opt") == "cp2k_geopt"

    def test_calc_type_mapping_single_point(self, spec):
        assert spec.calc_type_mapping.get("single_point") == "cp2k_static"

    def test_calc_type_mapping_cell_opt(self, spec):
        assert spec.calc_type_mapping.get("cell_opt") == "cp2k_cellopt"

    def test_calc_type_mapping_md(self, spec):
        assert spec.calc_type_mapping.get("md") == "cp2k_md"

    def test_calc_type_mapping_freq(self, spec):
        assert spec.calc_type_mapping.get("freq") == "cp2k_freq"


class TestCp2kParams:
    def _param(self, spec, key: str):
        for p in spec.params:
            if p.key == key:
                return p
        return None

    def test_functional_param_exists(self, spec):
        assert self._param(spec, "functional") is not None

    def test_functional_default_is_pbe(self, spec):
        p = self._param(spec, "functional")
        assert p.default == "PBE"

    def test_functional_options_include_hse06(self, spec):
        p = self._param(spec, "functional")
        values = [opt["value"] for opt in p.options]
        assert "HSE06" in values

    def test_basis_set_param_exists(self, spec):
        assert self._param(spec, "basis_set") is not None

    def test_basis_set_default(self, spec):
        p = self._param(spec, "basis_set")
        assert p.default == "DZVP-MOLOPT-SR-GTH"

    def test_cutoff_has_unit_ry(self, spec):
        p = self._param(spec, "cutoff")
        assert p is not None
        assert p.unit == "Ry"

    def test_cutoff_default_is_350(self, spec):
        p = self._param(spec, "cutoff")
        assert p.default == 350

    def test_cutoff_range(self, spec):
        p = self._param(spec, "cutoff")
        assert p.range == [100, 1500]

    def test_scf_method_default_is_ot(self, spec):
        p = self._param(spec, "scf_method")
        assert p is not None
        assert p.default == "OT"

    def test_charge_param_default(self, spec):
        p = self._param(spec, "charge")
        assert p is not None
        assert p.default == 0

    def test_multiplicity_range(self, spec):
        p = self._param(spec, "multiplicity")
        assert p is not None
        assert p.range == [1, 10]

    def test_vdw_default_is_none(self, spec):
        p = self._param(spec, "vdw")
        assert p is not None
        assert p.default == "none"

    def test_vdw_options_include_dftd3(self, spec):
        p = self._param(spec, "vdw")
        values = [opt["value"] for opt in p.options]
        assert "DFTD3" in values

    def test_periodic_default_is_xyz(self, spec):
        p = self._param(spec, "periodic")
        assert p is not None
        assert p.default == "XYZ"

    def test_custom_inp_text_has_help(self, spec):
        p = self._param(spec, "custom_inp_text")
        assert p is not None
        assert p.help is not None and len(p.help) > 0

    def test_geo_opt_optimizer_has_show_if(self, spec):
        p = self._param(spec, "geo_opt_optimizer")
        assert p is not None
        assert p.show_if is not None

    def test_geo_opt_optimizer_shows_for_geo_opt_and_cell_opt(self, spec):
        p = self._param(spec, "geo_opt_optimizer")
        values = p.show_if.get("values", [])
        assert "geo_opt" in values
        assert "cell_opt" in values

    def test_md_ensemble_has_show_if(self, spec):
        p = self._param(spec, "md_ensemble")
        assert p is not None
        assert p.show_if is not None
        assert "md" in p.show_if.get("values", [])

    def test_md_timestep_has_unit_fs(self, spec):
        p = self._param(spec, "md_timestep")
        assert p is not None
        assert p.unit == "fs"

    def test_md_temperature_default_is_300(self, spec):
        p = self._param(spec, "md_temperature")
        assert p is not None
        assert p.default == 300

    def test_fixed_elements_has_help(self, spec):
        p = self._param(spec, "fixed_elements")
        assert p is not None
        assert p.help is not None

    def test_fixed_indices_has_help(self, spec):
        p = self._param(spec, "fixed_indices")
        assert p is not None
        assert p.help is not None


class TestCp2kInputFiles:
    def test_project_inp_defined(self, spec):
        assert "project.inp" in spec.input_files

    def test_poscar_defined(self, spec):
        assert "POSCAR" in spec.input_files

    def test_project_inp_source_is_hook(self, spec):
        assert spec.input_files["project.inp"].source == "hook"

    def test_poscar_source_is_structure(self, spec):
        assert spec.input_files["POSCAR"].source == "structure"

    def test_poscar_format_is_poscar(self, spec):
        assert spec.input_files["POSCAR"].format == "poscar"


class TestCp2kRunAndOutput:
    def test_run_command_uses_cp2k(self, spec):
        assert any("cp2k" in cmd.lower() for cmd in spec.run_commands)

    def test_run_command_references_project_inp(self, spec):
        assert any("project.inp" in cmd for cmd in spec.run_commands)

    def test_output_files_has_log(self, spec):
        assert "log" in spec.output_files

    def test_output_files_has_structure(self, spec):
        assert "structure" in spec.output_files

    def test_output_files_has_restart(self, spec):
        assert "restart" in spec.output_files

    def test_output_log_is_project_out(self, spec):
        assert spec.output_files["log"] == "project.out"


class TestCp2kHooks:
    def test_pre_generate_hook_defined(self, spec):
        assert "pre_generate" in spec.hooks

    def test_pre_generate_points_to_cp2k_hooks(self, spec):
        hook_ref = spec.hooks["pre_generate"]
        assert hook_ref is not None
        assert "cp2k_hooks" in hook_ref
        assert "generate_inputs" in hook_ref


class TestCp2kSafety:
    def test_safety_is_safe(self, spec):
        assert spec.safety == "safe"

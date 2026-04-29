"""Tests for the LAMMPS declarative engine definition (engine_defs/lammps.yaml)."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
import yaml

_server_dir = str(Path(__file__).resolve().parent.parent)
if _server_dir not in sys.path:
    sys.path.insert(0, _server_dir)

from workflow.engine_defs.schema import validate_engine_spec

YAML_PATH = Path(__file__).resolve().parent.parent / "workflow" / "engine_defs" / "lammps.yaml"


@pytest.fixture(scope="module")
def raw_spec():
    """Load the LAMMPS YAML as a raw dict."""
    return yaml.safe_load(YAML_PATH.read_text())


@pytest.fixture(scope="module")
def spec(raw_spec):
    """Validate and return the typed EngineSpec."""
    return validate_engine_spec(raw_spec)


class TestLammpsYamlLoads:
    def test_yaml_file_exists(self):
        assert YAML_PATH.exists(), f"lammps.yaml not found at {YAML_PATH}"

    def test_yaml_parses_without_error(self, raw_spec):
        assert isinstance(raw_spec, dict)

    def test_validate_engine_spec_succeeds(self, spec):
        assert spec is not None


class TestLammpsEngineIdentity:
    def test_engine_name(self, spec):
        assert spec.engine == "lammps"

    def test_label(self, spec):
        assert spec.label == "LAMMPS"

    def test_description_is_non_empty(self, spec):
        assert spec.description.strip()


class TestLammpsCalcTypes:
    def test_supported_calc_types_includes_md(self, spec):
        assert "md" in spec.supported_calc_types

    def test_supported_calc_types_includes_md_minimize(self, spec):
        assert "md_minimize" in spec.supported_calc_types

    def test_calc_type_mapping_md(self, spec):
        assert spec.calc_type_mapping.get("md") == "lammps_md"

    def test_calc_type_mapping_md_minimize(self, spec):
        assert spec.calc_type_mapping.get("md_minimize") == "lammps_minimize"


class TestLammpsParams:
    def _param(self, spec, key: str):
        for p in spec.params:
            if p.key == key:
                return p
        return None

    def test_potential_type_param_exists(self, spec):
        assert self._param(spec, "potential_type") is not None

    def test_potential_type_default_is_lj(self, spec):
        p = self._param(spec, "potential_type")
        assert p.default == "lj"

    def test_ensemble_param_exists(self, spec):
        assert self._param(spec, "ensemble") is not None

    def test_ensemble_default_is_nvt(self, spec):
        p = self._param(spec, "ensemble")
        assert p.default == "nvt"

    def test_temperature_has_unit(self, spec):
        p = self._param(spec, "temperature")
        assert p is not None
        assert p.unit == "K"

    def test_steps_param_exists(self, spec):
        assert self._param(spec, "steps") is not None

    def test_min_style_param_exists(self, spec):
        assert self._param(spec, "min_style") is not None

    def test_min_style_default_is_cg(self, spec):
        p = self._param(spec, "min_style")
        assert p.default == "cg"

    def test_etol_and_ftol_present(self, spec):
        assert self._param(spec, "etol") is not None
        assert self._param(spec, "ftol") is not None

    def test_custom_input_text_param_exists(self, spec):
        assert self._param(spec, "custom_input_text") is not None


class TestLammpsInputFiles:
    def test_in_lammps_defined(self, spec):
        assert "in.lammps" in spec.input_files

    def test_system_data_defined(self, spec):
        assert "system.data" in spec.input_files

    def test_in_lammps_source_is_hook(self, spec):
        assert spec.input_files["in.lammps"].source == "hook"


class TestLammpsRunAndOutput:
    def test_run_command_uses_lmp(self, spec):
        assert any("lmp" in cmd for cmd in spec.run_commands)

    def test_output_files_has_log(self, spec):
        assert "log" in spec.output_files

    def test_output_files_has_trajectory(self, spec):
        assert "trajectory" in spec.output_files

    def test_output_files_has_structure(self, spec):
        assert "structure" in spec.output_files


class TestLammpsHooks:
    def test_pre_generate_hook_defined(self, spec):
        assert "pre_generate" in spec.hooks

    def test_pre_generate_points_to_lammps_hooks(self, spec):
        hook_ref = spec.hooks["pre_generate"]
        assert hook_ref is not None
        assert "lammps_hooks" in hook_ref
        assert "generate_inputs" in hook_ref


class TestLammpsSafety:
    def test_safety_is_safe(self, spec):
        assert spec.safety == "safe"

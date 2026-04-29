"""Test that all engine YAML definitions load and validate without errors."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

_server_dir = str(Path(__file__).resolve().parent.parent)
if _server_dir not in sys.path:
    sys.path.insert(0, _server_dir)


def test_all_engine_defs_load():
    """All YAML engine definitions should load without errors."""
    from workflow.engine_runtime import load_all_engine_defs, _RUNTIME_REGISTRY

    _RUNTIME_REGISTRY.clear()
    runtimes = load_all_engine_defs()
    engine_keys = {rt.spec.engine for rt in runtimes}

    # All 13 engines should be present
    expected = {
        "vasp", "cp2k", "orca", "xtb", "mlp", "lammps",
        "sella", "amber", "kmc", "gaussian", "qe", "qchem", "gromacs",
    }
    assert expected.issubset(engine_keys), f"Missing: {expected - engine_keys}"


def test_all_engine_defs_have_valid_specs():
    """Each loaded engine spec should have required fields populated."""
    from workflow.engine_runtime import load_all_engine_defs, _RUNTIME_REGISTRY

    _RUNTIME_REGISTRY.clear()
    runtimes = load_all_engine_defs()

    for rt in runtimes:
        spec = rt.spec
        assert spec.engine, f"engine key is empty for {rt}"
        assert spec.label, f"label is empty for engine {spec.engine}"
        assert isinstance(spec.params, list), f"params not a list for engine {spec.engine}"
        assert isinstance(spec.calc_type_mapping, dict), (
            f"calc_type_mapping not a dict for engine {spec.engine}"
        )

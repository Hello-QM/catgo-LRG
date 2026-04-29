"""Tests for declarative engine framework."""
import pytest
from workflow.engine_defs.schema import EngineSpec, validate_engine_spec
from workflow.engine_runtime import DeclarativeEngineRuntime


def test_valid_minimal_spec():
    """A minimal spec with just engine key and run_commands should be valid."""
    raw = {
        "engine": "test_engine",
        "label": "Test Engine",
        "supported_calc_types": ["geo_opt"],
        "params": [],
        "input_files": {},
        "run_commands": ["echo hello"],
        "output_files": {},
    }
    spec = validate_engine_spec(raw)
    assert spec.engine == "test_engine"
    assert spec.label == "Test Engine"
    assert spec.safety == "warn"  # has run_commands → auto-assessed as warn


def test_invalid_spec_missing_engine():
    """Missing required 'engine' key should raise."""
    with pytest.raises(ValueError, match="engine"):
        validate_engine_spec({"label": "No Engine Key"})


def test_safety_auto_assessment():
    """Safety should be auto-assessed from run_commands content."""
    safe_spec = validate_engine_spec({
        "engine": "safe", "label": "Safe", "supported_calc_types": [],
        "params": [], "input_files": {}, "run_commands": [], "output_files": {},
    })
    assert safe_spec.safety == "safe"

    dangerous_spec = validate_engine_spec({
        "engine": "danger", "label": "Danger", "supported_calc_types": [],
        "params": [], "input_files": {}, "run_commands": ["rm -rf /tmp/x"], "output_files": {},
    })
    assert dangerous_spec.safety == "dangerous"


# ---------------------------------------------------------------------------
# Task 2: DeclarativeEngineRuntime tests
# ---------------------------------------------------------------------------

@pytest.fixture
def xtb_spec_dict():
    return {
        "engine": "xtb",
        "label": "xTB",
        "supported_calc_types": ["geo_opt", "single_point"],
        "params": [
            {"key": "method", "label": "Method", "type": "select",
             "options": [{"label": "GFN2-xTB", "value": "GFN2-xTB"}],
             "default": "GFN2-xTB"},
            {"key": "fmax", "label": "Force Convergence", "type": "number", "default": 0.01,
             "show_if": {"key": "calc_type", "values": ["geo_opt"]}},
        ],
        "input_files": {
            "run_xtb.py": {"template": "xtb/run_xtb.py.j2"},
            "POSCAR": {"source": "structure", "format": "poscar"},
        },
        "run_commands": ["python run_xtb.py"],
        "output_files": {"structure": "CONTCAR", "log": "opt.log"},
        "environment": {"modules": []},
        "calc_type_mapping": {
            "geo_opt": "xtb_relax",
            "single_point": "xtb_static",
        },
    }


def test_runtime_loads_spec(xtb_spec_dict):
    runtime = DeclarativeEngineRuntime(xtb_spec_dict)
    assert runtime.spec.engine == "xtb"
    assert len(runtime.spec.params) == 2
    assert runtime.spec.calc_type_mapping["geo_opt"] == "xtb_relax"


def test_runtime_resolves_calc_type(xtb_spec_dict):
    runtime = DeclarativeEngineRuntime(xtb_spec_dict)
    assert runtime.resolve_calc_type("geo_opt") == "xtb_relax"
    assert runtime.resolve_calc_type("single_point") == "xtb_static"
    assert runtime.resolve_calc_type("unknown") is None


def test_runtime_to_frontend_params(xtb_spec_dict):
    runtime = DeclarativeEngineRuntime(xtb_spec_dict)
    frontend_params = runtime.to_frontend_params()
    assert len(frontend_params) == 2
    assert frontend_params[0]["key"] == "method"
    # fmax has show_if calc_type → should be rewritten to include software gate
    show_if = frontend_params[1]["show_if"]
    assert isinstance(show_if, list)
    software_cond = [c for c in show_if if c["key"] == "software"]
    assert len(software_cond) == 1
    assert "xtb" in software_cond[0]["values"]


# ---------------------------------------------------------------------------
# Task 3: xTB YAML engine definition + Jinja2 template tests
# ---------------------------------------------------------------------------

def test_xtb_yaml_loads():
    from workflow.engine_runtime import load_yaml_engine
    from pathlib import Path
    yaml_path = Path(__file__).parent.parent / "server" / "workflow" / "engine_defs" / "xtb.yaml"
    rt = load_yaml_engine(yaml_path)
    assert rt.spec.engine == "xtb"
    assert "geo_opt" in rt.spec.supported_calc_types
    assert rt.resolve_calc_type("geo_opt") == "xtb_relax"
    assert rt.resolve_calc_type("single_point") == "xtb_static"


def test_xtb_template_renders():
    from workflow.engine_runtime import _render_template
    content = _render_template(
        "xtb/run_xtb.py.j2",
        params={"method": "GFN2-xTB", "accuracy": 1.0, "electronic_temperature": 300,
                "fmax": 0.05, "max_steps": 200},
        structure_str=None, node_type="xtb_relax",
    )
    assert "GFN2-xTB" in content
    assert "fmax=0.05" in content or "fmax = 0.05" in content
    assert "steps=200" in content or "steps = 200" in content
    assert "BFGS" in content


def test_xtb_template_static():
    from workflow.engine_runtime import _render_template
    content = _render_template(
        "xtb/run_xtb.py.j2",
        params={"method": "GFN1-xTB", "accuracy": 0.5, "electronic_temperature": 500},
        structure_str=None, node_type="xtb_static",
    )
    assert "GFN1-xTB" in content
    assert "get_potential_energy" in content
    assert "BFGS" not in content


# ---------------------------------------------------------------------------
# Task 4: MLP YAML engine definition + Jinja2 template tests
# ---------------------------------------------------------------------------

def test_mlp_yaml_loads():
    from workflow.engine_runtime import load_yaml_engine
    from pathlib import Path
    yaml_path = Path(__file__).parent.parent / "server" / "workflow" / "engine_defs" / "mlp.yaml"
    rt = load_yaml_engine(yaml_path)
    assert rt.spec.engine == "mlp"
    assert "geo_opt" in rt.spec.supported_calc_types
    assert "md" in rt.spec.supported_calc_types
    assert rt.resolve_calc_type("geo_opt") == "mlp_relax"
    assert rt.resolve_calc_type("md") == "mlp_md"


def test_mlp_template_relax():
    from workflow.engine_runtime import _render_template
    content = _render_template(
        "mlp/run_mlp.py.j2",
        params={"model": "mace-mp-0", "fmax": 0.03, "max_steps": 300,
                "relax_cell": True, "optimizer": "FIRE"},
        structure_str=None, node_type="mlp_relax",
    )
    assert "mace-mp-0" in content or "mace_mp" in content
    assert "FIRE" in content
    assert "fmax" in content


def test_mlp_template_md():
    from workflow.engine_runtime import _render_template
    content = _render_template(
        "mlp/run_mlp.py.j2",
        params={"model": "chgnet", "temp": 500, "steps": 1000, "timestep": 2.0},
        structure_str=None, node_type="mlp_md",
    )
    assert "chgnet" in content or "CHGNet" in content
    assert "500" in content


# ---------------------------------------------------------------------------
# Task 5: Registry bridge tests
# ---------------------------------------------------------------------------

def test_declarative_engines_register_in_runtime_registry():
    from workflow.engine_runtime import load_all_engine_defs, get_runtime, _RUNTIME_REGISTRY
    _RUNTIME_REGISTRY.clear()
    runtimes = load_all_engine_defs()
    assert len(runtimes) >= 2
    assert get_runtime("xtb") is not None
    assert get_runtime("mlp") is not None


def test_unified_calc_map_from_runtimes():
    from workflow.engine_runtime import load_all_engine_defs, build_unified_calc_map, _RUNTIME_REGISTRY
    _RUNTIME_REGISTRY.clear()
    load_all_engine_defs()
    mapping = build_unified_calc_map()
    assert mapping[("geo_opt", "xtb")] == "xtb_relax"
    assert mapping[("geo_opt", "mlp")] == "mlp_relax"
    assert mapping[("md", "mlp")] == "mlp_md"


# ---------------------------------------------------------------------------
# Task 6: Engine Def Endpoints — to_dict() serialization test
# ---------------------------------------------------------------------------

def test_engine_def_to_dict():
    """Runtime.to_dict() should produce a JSON-serializable dict."""
    from workflow.engine_runtime import load_yaml_engine, _RUNTIME_REGISTRY
    from pathlib import Path
    import json

    _RUNTIME_REGISTRY.clear()
    yaml_path = Path(__file__).parent.parent / "server" / "workflow" / "engine_defs" / "xtb.yaml"
    rt = load_yaml_engine(yaml_path)
    d = rt.to_dict()

    json_str = json.dumps(d)
    assert '"engine": "xtb"' in json_str
    assert '"supported_calc_types"' in json_str
    assert '"params"' in json_str
    assert isinstance(d["params"][0], dict)
    assert d["params"][0]["key"] == "method"


# ---------------------------------------------------------------------------
# Task 10: Full Integration Tests
# ---------------------------------------------------------------------------

def test_full_roundtrip_xtb():
    """Full roundtrip: YAML → runtime → frontend params → API dict."""
    from workflow.engine_runtime import load_yaml_engine, _RUNTIME_REGISTRY
    from pathlib import Path

    _RUNTIME_REGISTRY.clear()
    yaml_path = Path(__file__).parent.parent / "server" / "workflow" / "engine_defs" / "xtb.yaml"
    rt = load_yaml_engine(yaml_path)

    # 1. Spec loaded correctly
    assert rt.spec.engine == "xtb"
    assert rt.spec.safety == "safe"

    # 2. Calc type resolution
    assert rt.resolve_calc_type("geo_opt") == "xtb_relax"

    # 3. Frontend params have software show_if
    params = rt.to_frontend_params()
    for p in params:
        show_if = p.get("show_if")
        if isinstance(show_if, dict):
            assert show_if["key"] == "software"
            assert "xtb" in show_if["values"]
        elif isinstance(show_if, list):
            software_cond = [c for c in show_if if c["key"] == "software"]
            assert len(software_cond) == 1
            assert "xtb" in software_cond[0]["values"]

    # 4. API dict is JSON-serializable
    import json
    d = rt.to_dict()
    json.dumps(d)  # Should not raise


def test_full_roundtrip_mlp():
    """Full roundtrip for MLP engine."""
    from workflow.engine_runtime import load_yaml_engine, _RUNTIME_REGISTRY
    from pathlib import Path

    _RUNTIME_REGISTRY.clear()
    yaml_path = Path(__file__).parent.parent / "server" / "workflow" / "engine_defs" / "mlp.yaml"
    rt = load_yaml_engine(yaml_path)

    assert rt.spec.engine == "mlp"
    assert rt.spec.safety == "safe"
    assert rt.resolve_calc_type("geo_opt") == "mlp_relax"
    assert rt.resolve_calc_type("md") == "mlp_md"

    params = rt.to_frontend_params()
    assert len(params) == 8  # model, fmax, max_steps, relax_cell, optimizer, temp, steps, timestep

    import json
    json.dumps(rt.to_dict())


# ---------------------------------------------------------------------------
# Task: VASP declarative engine definition tests
# ---------------------------------------------------------------------------

def test_vasp_yaml_loads():
    from workflow.engine_runtime import load_yaml_engine, _RUNTIME_REGISTRY
    from pathlib import Path
    _RUNTIME_REGISTRY.clear()
    yaml_path = Path(__file__).parent.parent / "server" / "workflow" / "engine_defs" / "vasp.yaml"
    rt = load_yaml_engine(yaml_path)
    assert rt.spec.engine == "vasp"
    assert "geo_opt" in rt.spec.supported_calc_types
    assert "freq" in rt.spec.supported_calc_types
    assert rt.resolve_calc_type("geo_opt") == "vasp_relax"
    assert rt.resolve_calc_type("single_point") == "vasp_static"
    assert rt.resolve_calc_type("cell_opt") == "bulk_opt"
    assert rt.resolve_calc_type("md") == "vasp_md"
    assert rt.resolve_calc_type("freq") == "frequency"
    # Check params count is reasonable (20+)
    assert len(rt.spec.params) >= 20


def test_vasp_frontend_params_have_software_gate():
    from workflow.engine_runtime import load_yaml_engine, _RUNTIME_REGISTRY
    from pathlib import Path
    _RUNTIME_REGISTRY.clear()
    yaml_path = Path(__file__).parent.parent / "server" / "workflow" / "engine_defs" / "vasp.yaml"
    rt = load_yaml_engine(yaml_path)
    params = rt.to_frontend_params()
    # Every param should have a show_if with software=vasp
    for p in params:
        show_if = p.get("show_if")
        assert show_if is not None, f"Param {p['key']} missing show_if"
        if isinstance(show_if, dict):
            assert show_if["key"] == "software"
            assert "vasp" in show_if["values"]
        elif isinstance(show_if, list):
            software_conds = [c for c in show_if if c["key"] == "software"]
            assert len(software_conds) >= 1, f"Param {p['key']} missing software show_if"
            assert "vasp" in software_conds[0]["values"]


def test_vasp_to_dict_serializable():
    from workflow.engine_runtime import load_yaml_engine, _RUNTIME_REGISTRY
    from pathlib import Path
    import json
    _RUNTIME_REGISTRY.clear()
    yaml_path = Path(__file__).parent.parent / "server" / "workflow" / "engine_defs" / "vasp.yaml"
    rt = load_yaml_engine(yaml_path)
    d = rt.to_dict()
    json.dumps(d)  # Should not raise

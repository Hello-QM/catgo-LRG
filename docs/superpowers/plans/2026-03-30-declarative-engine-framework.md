# Declarative Engine Framework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 3-file-change engine registration process with a single YAML-per-engine declarative framework, and add a generic command node for arbitrary HPC tasks.

**Architecture:** Each engine is defined by a YAML file in `server/workflow/engine_defs/`. A `DeclarativeEngineRuntime` loads YAML specs, renders Jinja2 input templates, and registers into the existing `engine_registry`. The frontend dynamically loads engine metadata from a new API endpoint and auto-generates parameter panels. Custom command nodes are minimal YAML specs created at runtime.

**Tech Stack:** Python (YAML, Jinja2), TypeScript/Svelte 5, FastAPI, existing engine_registry

**Spec:** `docs/superpowers/specs/2026-03-30-declarative-engine-framework-design.md`

---

## Key Discovery: Duplicated Mapping

`node_sets.py:_resolve_software` and `hpc_utils.py:map_task_type_to_engine` both maintain independent `(calc_type, software) → legacy_node_type` dicts that are **already out of sync**. The declarative framework will be the single source of truth for these mappings.

---

## File Map

### New Files (Backend)

| File | Responsibility |
|------|----------------|
| `server/workflow/engine_defs/` | Directory for YAML engine definitions |
| `server/workflow/engine_defs/xtb.yaml` | xTB engine spec (first migration) |
| `server/workflow/engine_defs/mlp.yaml` | MLP engine spec (second migration) |
| `server/workflow/engine_defs/schema.py` | YAML schema validation + EngineSpec dataclass |
| `server/workflow/engine_runtime.py` | DeclarativeEngineRuntime — loads YAML, renders templates, generates inputs |
| `server/workflow/templates/xtb/run_xtb.py.j2` | Jinja2 template for xTB script |
| `server/workflow/templates/mlp/run_mlp.py.j2` | Jinja2 template for MLP script |
| `server/workflow/engine_defs/custom/` | Directory for user-created custom engines |
| `tests/test_engine_runtime.py` | Tests for the declarative engine framework |

### New Files (Frontend)

| File | Responsibility |
|------|----------------|
| `src/lib/workflow/node-defs/dynamic.ts` | Load engine specs from API, generate ParamDef[], register software options |
| `src/lib/workflow/components/CustomCommandWizard.svelte` | UI wizard for creating custom command nodes |

### Modified Files

| File | Change |
|------|--------|
| `server/catgo/workflow/engine/engine_builtins.py` | Add declarative engine auto-registration loop |
| `server/catgo/workflow/engine/hpc_utils.py:57-80` | Replace duplicated UNIFIED_MAP with import from engine_runtime |
| `server/workflow/node_sets.py:114-165` | Replace `_resolve_software` hardcoded `_map` with data-driven lookup from engine specs |
| `server/workflow/node_sets.py:168-211` | Replace `get_engine_for_node` hardcoded if-chain with data-driven lookup |
| `server/catgo/routers/workflow.py` | Add `/engine-defs` GET/POST endpoints |
| `src/lib/workflow/node-defs/index.ts` | Call `loadDynamicEngines()` alongside `load_plugin_nodes()` |
| `src/lib/workflow/workflow-types.ts` | Add `EngineSpec` interface |

---

### Task 1: YAML Schema & Validation

**Files:**
- Create: `server/workflow/engine_defs/schema.py`
- Create: `server/workflow/engine_defs/__init__.py`
- Test: `tests/test_engine_runtime.py`

- [ ] **Step 1: Write failing test for schema validation**

```python
# tests/test_engine_runtime.py
"""Tests for declarative engine framework."""
import pytest
from workflow.engine_defs.schema import EngineSpec, validate_engine_spec


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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/james0001/project/catgo/.worktrees/split-files && python -m pytest tests/test_engine_runtime.py::test_valid_minimal_spec -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'workflow.engine_defs'`

- [ ] **Step 3: Create schema module**

```python
# server/workflow/engine_defs/__init__.py
"""Declarative engine definitions — loaded from YAML at startup."""
```

```python
# server/workflow/engine_defs/schema.py
"""Engine spec schema validation and dataclass."""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any


DANGEROUS_PATTERNS = [
    r"\brm\s+-rf\b", r"\bsudo\b", r"\bcurl\b", r"\bwget\b",
    r"\bchmod\b.*777", r"\b>\s*/dev/", r"\bdd\b\s+if=",
    r"\bmkfs\b",
]

REQUIRED_FIELDS = {"engine", "label", "supported_calc_types", "params",
                   "input_files", "run_commands", "output_files"}


@dataclass
class ParamSpec:
    """A single parameter definition."""
    key: str
    label: str
    type: str = "string"
    default: Any = None
    options: list[dict[str, Any]] | None = None
    unit: str | None = None
    range: list[float] | None = None
    help: str | None = None
    group: str | None = None
    show_if: dict[str, Any] | None = None


@dataclass
class InputFileSpec:
    """How to produce one input file."""
    template: str | None = None
    source: str | None = None  # "structure" | "user" | "upstream"
    format: str | None = None


@dataclass
class EngineSpec:
    """Validated, typed representation of a YAML engine definition."""
    engine: str
    label: str
    description: str = ""
    supported_calc_types: list[str] = field(default_factory=list)
    params: list[ParamSpec] = field(default_factory=list)
    input_files: dict[str, InputFileSpec] = field(default_factory=dict)
    run_commands: list[str] = field(default_factory=list)
    output_files: dict[str, str] = field(default_factory=dict)
    environment: dict[str, Any] = field(default_factory=dict)
    parser: str | None = None
    hooks: dict[str, str | None] = field(default_factory=dict)
    safety: str = "safe"
    # Mapping from (calc_type, engine_key) → legacy node type for routing
    calc_type_mapping: dict[str, str] = field(default_factory=dict)


def _assess_safety(run_commands: list[str]) -> str:
    """Auto-classify safety level from run_commands content."""
    if not run_commands:
        return "safe"
    combined = " ".join(run_commands)
    for pattern in DANGEROUS_PATTERNS:
        if re.search(pattern, combined):
            return "dangerous"
    return "warn"


def validate_engine_spec(raw: dict[str, Any]) -> EngineSpec:
    """Validate a raw dict (from YAML or API) and return a typed EngineSpec.

    Raises ValueError for missing required fields.
    """
    missing = REQUIRED_FIELDS - set(raw.keys())
    if missing:
        raise ValueError(f"Missing required fields: {', '.join(sorted(missing))}")

    params = [
        ParamSpec(**p) if isinstance(p, dict) else p
        for p in raw.get("params", [])
    ]
    input_files = {
        name: InputFileSpec(**spec) if isinstance(spec, dict) else spec
        for name, spec in raw.get("input_files", {}).items()
    }

    spec = EngineSpec(
        engine=raw["engine"],
        label=raw["label"],
        description=raw.get("description", ""),
        supported_calc_types=raw.get("supported_calc_types", []),
        params=params,
        input_files=input_files,
        run_commands=raw.get("run_commands", []),
        output_files=raw.get("output_files", {}),
        environment=raw.get("environment", {}),
        parser=raw.get("parser"),
        hooks=raw.get("hooks", {}),
        safety=raw.get("safety") or _assess_safety(raw.get("run_commands", [])),
        calc_type_mapping=raw.get("calc_type_mapping", {}),
    )
    return spec
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/james0001/project/catgo/.worktrees/split-files && python -m pytest tests/test_engine_runtime.py -v`
Expected: 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add server/workflow/engine_defs/__init__.py server/workflow/engine_defs/schema.py tests/test_engine_runtime.py
git commit -m "feat: add EngineSpec dataclass and YAML validation for declarative engines"
```

---

### Task 2: DeclarativeEngineRuntime Core

**Files:**
- Create: `server/workflow/engine_runtime.py`
- Test: `tests/test_engine_runtime.py` (extend)

- [ ] **Step 1: Write failing test for runtime input generation**

Add to `tests/test_engine_runtime.py`:

```python
import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from workflow.engine_runtime import DeclarativeEngineRuntime


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
    """Runtime should parse spec dict into typed EngineSpec."""
    runtime = DeclarativeEngineRuntime(xtb_spec_dict)
    assert runtime.spec.engine == "xtb"
    assert len(runtime.spec.params) == 2
    assert runtime.spec.calc_type_mapping["geo_opt"] == "xtb_relax"


def test_runtime_resolves_calc_type(xtb_spec_dict):
    """Given a unified calc type, runtime should return the legacy node type."""
    runtime = DeclarativeEngineRuntime(xtb_spec_dict)
    assert runtime.resolve_calc_type("geo_opt") == "xtb_relax"
    assert runtime.resolve_calc_type("single_point") == "xtb_static"
    assert runtime.resolve_calc_type("unknown") is None


def test_runtime_to_frontend_params(xtb_spec_dict):
    """Runtime should export params in frontend-compatible format."""
    runtime = DeclarativeEngineRuntime(xtb_spec_dict)
    frontend_params = runtime.to_frontend_params()
    assert len(frontend_params) == 2
    assert frontend_params[0]["key"] == "method"
    assert frontend_params[1]["show_if"]["key"] == "software"
    assert frontend_params[1]["show_if"]["values"] == ["xtb"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/james0001/project/catgo/.worktrees/split-files && python -m pytest tests/test_engine_runtime.py::test_runtime_loads_spec -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'workflow.engine_runtime'`

- [ ] **Step 3: Create engine_runtime.py**

```python
# server/workflow/engine_runtime.py
"""Declarative engine runtime — loads YAML specs and executes them.

Each YAML engine spec is loaded into a DeclarativeEngineRuntime instance.
The runtime can:
  - Resolve unified calc types to legacy node types
  - Render Jinja2 input file templates
  - Generate and upload input files to HPC
  - Export frontend-compatible parameter definitions
"""
from __future__ import annotations

import logging
from dataclasses import asdict
from pathlib import Path
from typing import Any

import yaml

from workflow.engine_defs.schema import EngineSpec, validate_engine_spec

logger = logging.getLogger(__name__)

# ─── Global registry of loaded runtimes ───
_RUNTIME_REGISTRY: dict[str, "DeclarativeEngineRuntime"] = {}

# Base directory for YAML engine definitions
ENGINE_DEFS_DIR = Path(__file__).parent / "engine_defs"
TEMPLATES_DIR = Path(__file__).parent / "templates"


class DeclarativeEngineRuntime:
    """Loads a YAML engine spec and provides generation/resolution methods."""

    def __init__(self, raw: dict[str, Any]):
        self.spec = validate_engine_spec(raw)

    # ─── Calc type resolution ───

    def resolve_calc_type(self, calc_type: str) -> str | None:
        """Map a unified calc type to the legacy node type for this engine."""
        return self.spec.calc_type_mapping.get(calc_type)

    # ─── Frontend param export ───

    def to_frontend_params(self) -> list[dict[str, Any]]:
        """Export params as frontend-compatible dicts.

        Rewrites show_if conditions that reference 'calc_type' to instead
        reference 'software' with this engine's key, so the frontend
        unified nodes show/hide params correctly.
        """
        result = []
        for p in self.spec.params:
            d = asdict(p)
            # Remove None values for cleaner JSON
            d = {k: v for k, v in d.items() if v is not None}
            # Rewrite show_if to target software selector
            if "show_if" in d:
                existing = d["show_if"]
                if existing.get("key") == "calc_type":
                    # Keep the calc_type condition AND add software condition
                    d["show_if"] = [
                        {"key": "software", "values": [self.spec.engine]},
                        existing,
                    ]
                else:
                    # Wrap existing condition with software gate
                    d["show_if"] = {"key": "software", "values": [self.spec.engine]}
            else:
                d["show_if"] = {"key": "software", "values": [self.spec.engine]}
            result.append(d)
        return result

    # ─── Input generation ───

    async def generate_inputs(
        self,
        hpc: Any,
        work_dir: str,
        node_type: str,
        params: dict[str, Any],
        structure_str: str | None,
        config: Any,
        task: dict[str, Any],
    ) -> None:
        """Generate input files and upload to HPC.

        1. Run pre_generate hook (if defined)
        2. Render Jinja2 templates for input files
        3. Handle structure conversion
        4. Upload all files to HPC
        5. Generate sbatch script from modules + run_commands
        """
        from catgo.utils.job_parser import write_remote_files

        # 1. Pre-generate hook
        hook_path = self.spec.hooks.get("pre_generate")
        if hook_path:
            params, structure_str = await _call_hook(hook_path, params, structure_str)

        # 2. Build file dict
        files: dict[str, str] = {}
        for filename, file_spec in self.spec.input_files.items():
            if file_spec.template:
                files[filename] = _render_template(file_spec.template, params, structure_str, node_type)
            elif file_spec.source == "structure" and structure_str:
                files[filename] = _convert_structure(structure_str, file_spec.format or "poscar")

        # 3. Upload to HPC
        remote_files = {f"{work_dir}/{name}": content for name, content in files.items()}
        await write_remote_files(hpc.conn, remote_files)

    # ─── Serialization ───

    def to_dict(self) -> dict[str, Any]:
        """Serialize spec for API responses."""
        d = asdict(self.spec)
        # Convert dataclass lists to plain dicts
        d["params"] = [asdict(p) if hasattr(p, "__dataclass_fields__") else p for p in self.spec.params]
        d["input_files"] = {
            name: asdict(f) if hasattr(f, "__dataclass_fields__") else f
            for name, f in self.spec.input_files.items()
        }
        return d


# ─── Template rendering ───

def _render_template(
    template_path: str,
    params: dict[str, Any],
    structure_str: str | None,
    node_type: str,
) -> str:
    """Render a Jinja2 template with params and structure context."""
    import jinja2

    full_path = TEMPLATES_DIR / template_path
    if not full_path.exists():
        raise FileNotFoundError(f"Template not found: {full_path}")

    env = jinja2.Environment(
        loader=jinja2.FileSystemLoader(str(TEMPLATES_DIR)),
        undefined=jinja2.StrictUndefined,
    )
    template = env.get_template(template_path)
    return template.render(params=params, structure_str=structure_str, node_type=node_type)


def _convert_structure(structure_str: str, fmt: str) -> str:
    """Convert a structure string (pymatgen JSON or POSCAR) to the target format."""
    if fmt == "poscar":
        from workflow.engines import ensure_poscar
        return ensure_poscar(structure_str)
    # For other formats, try pymatgen conversion
    import json
    from pymatgen.core import Structure
    struct = Structure.from_dict(json.loads(structure_str))
    return struct.to(fmt=fmt)


async def _call_hook(
    hook_path: str,
    params: dict[str, Any],
    structure_str: str | None,
) -> tuple[dict[str, Any], str | None]:
    """Import and call a pre/post hook function.

    hook_path format: "hooks/vasp_hooks.py:handle_frozen_layers"
    """
    module_path, func_name = hook_path.rsplit(":", 1)
    # Convert file path to importable module path
    module_name = module_path.replace("/", ".").replace(".py", "")
    import importlib
    mod = importlib.import_module(module_name)
    func = getattr(mod, func_name)
    return await func(params, structure_str)


# ─── Registry management ───

def load_engine_def(raw: dict[str, Any]) -> DeclarativeEngineRuntime:
    """Create a runtime from a raw dict and register it."""
    runtime = DeclarativeEngineRuntime(raw)
    _RUNTIME_REGISTRY[runtime.spec.engine] = runtime
    return runtime


def load_yaml_engine(yaml_path: Path) -> DeclarativeEngineRuntime:
    """Load a YAML engine definition file and register it."""
    with open(yaml_path) as f:
        raw = yaml.safe_load(f)
    return load_engine_def(raw)


def load_all_engine_defs() -> list[DeclarativeEngineRuntime]:
    """Scan engine_defs/ directory and load all YAML files."""
    runtimes = []
    for yaml_dir in [ENGINE_DEFS_DIR, ENGINE_DEFS_DIR / "custom"]:
        if not yaml_dir.exists():
            continue
        for yaml_file in sorted(yaml_dir.glob("*.yaml")):
            try:
                rt = load_yaml_engine(yaml_file)
                runtimes.append(rt)
                logger.info("Loaded declarative engine: %s from %s", rt.spec.engine, yaml_file.name)
            except Exception:
                logger.exception("Failed to load engine def: %s", yaml_file)
    return runtimes


def get_runtime(engine_key: str) -> DeclarativeEngineRuntime | None:
    """Get a loaded runtime by engine key."""
    return _RUNTIME_REGISTRY.get(engine_key)


def all_runtimes() -> list[DeclarativeEngineRuntime]:
    """Return all loaded runtimes."""
    return list(_RUNTIME_REGISTRY.values())


def build_unified_calc_map() -> dict[tuple[str, str], str]:
    """Build a combined (calc_type, engine_key) → legacy_node_type map from all runtimes."""
    result: dict[tuple[str, str], str] = {}
    for rt in _RUNTIME_REGISTRY.values():
        for calc_type, legacy_type in rt.spec.calc_type_mapping.items():
            result[(calc_type, rt.spec.engine)] = legacy_type
    return result


def build_engine_node_sets() -> dict[str, set[str]]:
    """Build engine_key → {legacy_node_types} map from all runtimes."""
    result: dict[str, set[str]] = {}
    for rt in _RUNTIME_REGISTRY.values():
        node_types = set(rt.spec.calc_type_mapping.values())
        if node_types:
            result[rt.spec.engine] = node_types
    return result
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/james0001/project/catgo/.worktrees/split-files && python -m pytest tests/test_engine_runtime.py -v`
Expected: All 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add server/workflow/engine_runtime.py tests/test_engine_runtime.py
git commit -m "feat: add DeclarativeEngineRuntime with template rendering and calc type resolution"
```

---

### Task 3: xTB YAML Engine Definition + Jinja2 Template

**Files:**
- Create: `server/workflow/engine_defs/xtb.yaml`
- Create: `server/workflow/templates/xtb/run_xtb.py.j2`
- Test: `tests/test_engine_runtime.py` (extend)

- [ ] **Step 1: Write failing test for xTB template rendering**

Add to `tests/test_engine_runtime.py`:

```python
def test_xtb_yaml_loads():
    """The xTB YAML engine def should load and validate correctly."""
    from workflow.engine_runtime import load_yaml_engine
    from pathlib import Path

    yaml_path = Path(__file__).parent.parent / "server" / "workflow" / "engine_defs" / "xtb.yaml"
    rt = load_yaml_engine(yaml_path)
    assert rt.spec.engine == "xtb"
    assert "geo_opt" in rt.spec.supported_calc_types
    assert rt.resolve_calc_type("geo_opt") == "xtb_relax"
    assert rt.resolve_calc_type("single_point") == "xtb_static"


def test_xtb_template_renders():
    """The xTB Jinja2 template should produce valid Python with params substituted."""
    from workflow.engine_runtime import _render_template

    content = _render_template(
        "xtb/run_xtb.py.j2",
        params={"method": "GFN2-xTB", "accuracy": 1.0, "electronic_temperature": 300,
                "fmax": 0.05, "max_steps": 200},
        structure_str=None,
        node_type="xtb_relax",
    )
    assert "GFN2-xTB" in content
    assert "fmax=0.05" in content
    assert "steps=200" in content
    assert "BFGS" in content


def test_xtb_template_static():
    """xTB template should handle single_point (xtb_static) node type."""
    from workflow.engine_runtime import _render_template

    content = _render_template(
        "xtb/run_xtb.py.j2",
        params={"method": "GFN1-xTB", "accuracy": 0.5, "electronic_temperature": 500},
        structure_str=None,
        node_type="xtb_static",
    )
    assert "GFN1-xTB" in content
    assert "get_potential_energy" in content
    # Static should NOT have optimizer
    assert "BFGS" not in content
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/james0001/project/catgo/.worktrees/split-files && python -m pytest tests/test_engine_runtime.py::test_xtb_yaml_loads -v`
Expected: FAIL — FileNotFoundError (YAML doesn't exist yet)

- [ ] **Step 3: Create xTB YAML definition**

```yaml
# server/workflow/engine_defs/xtb.yaml
engine: xtb
label: xTB
description: "Semi-empirical tight-binding calculations via GFN-xTB"

supported_calc_types:
  - geo_opt
  - single_point

params:
  - key: method
    label: "Method"
    type: select
    options:
      - { label: "GFN2-xTB", value: "GFN2-xTB" }
      - { label: "GFN1-xTB", value: "GFN1-xTB" }
      - { label: "GFN0-xTB", value: "GFN0-xTB" }
      - { label: "GFN-FF", value: "GFN-FF" }
    default: "GFN2-xTB"
  - key: accuracy
    label: "Accuracy"
    type: number
    default: 1.0
    range: [0.01, 10.0]
    help: "Numerical accuracy parameter (lower = tighter)"
  - key: electronic_temperature
    label: "Electronic Temperature"
    type: number
    default: 300
    unit: "K"
    range: [0, 10000]
  - key: fmax
    label: "Force Convergence"
    type: number
    default: 0.01
    unit: "eV/Å"
    range: [0.0001, 1.0]
    show_if: { key: calc_type, values: [geo_opt] }
  - key: max_steps
    label: "Max Optimization Steps"
    type: number
    default: 500
    range: [1, 10000]
    show_if: { key: calc_type, values: [geo_opt] }

input_files:
  "run_xtb.py":
    template: "xtb/run_xtb.py.j2"
  "POSCAR":
    source: structure
    format: poscar

run_commands:
  - "python run_xtb.py"

output_files:
  structure: "CONTCAR"
  log: "opt.log"
  trajectory: "opt.traj"

calc_type_mapping:
  geo_opt: xtb_relax
  single_point: xtb_static

safety: safe
```

- [ ] **Step 4: Create Jinja2 template for xTB**

```bash
mkdir -p server/workflow/templates/xtb
```

```jinja2
{# server/workflow/templates/xtb/run_xtb.py.j2 #}
#!/usr/bin/env python3
"""xTB {{ "relaxation" if node_type == "xtb_relax" else "single-point" }} generated by CatGo workflow engine."""
from ase.io import read, write

atoms = read("POSCAR", format="vasp")

# Try tblite first, fallback to xtb-python
method = "{{ params.get('method', 'GFN2-xTB') }}"
try:
    from tblite.ase import TBLite
    calc = TBLite(method=method, accuracy={{ params.get('accuracy', 1.0) }}, electronic_temperature={{ params.get('electronic_temperature', 300) }})
except ImportError:
    from xtb.ase.calculator import XTB
    calc = XTB(method=method)

atoms.calc = calc
{% if node_type == "xtb_relax" %}
from ase.optimize import BFGS
opt = BFGS(atoms, trajectory="opt.traj", logfile="opt.log")
opt.run(fmax={{ params.get('fmax', 0.01) }}, steps={{ params.get('max_steps', 500) }})
{% else %}
energy = atoms.get_potential_energy()
forces = atoms.get_forces()
print(f"Final energy: {energy:.6f} eV")
print(f"Max force: {forces.max():.6f} eV/A")
{% endif %}
write("CONTCAR", atoms, format="vasp")
{% if node_type == "xtb_relax" %}
print(f"Final energy: {atoms.get_potential_energy():.6f} eV")
{% endif %}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /home/james0001/project/catgo/.worktrees/split-files && python -m pytest tests/test_engine_runtime.py -v`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add server/workflow/engine_defs/xtb.yaml server/workflow/templates/xtb/run_xtb.py.j2 tests/test_engine_runtime.py
git commit -m "feat: add xTB declarative engine definition and Jinja2 template"
```

---

### Task 4: MLP YAML Engine Definition + Template

**Files:**
- Create: `server/workflow/engine_defs/mlp.yaml`
- Create: `server/workflow/templates/mlp/run_mlp.py.j2`
- Test: `tests/test_engine_runtime.py` (extend)

- [ ] **Step 1: Write failing test for MLP template rendering**

Add to `tests/test_engine_runtime.py`:

```python
def test_mlp_yaml_loads():
    """The MLP YAML engine def should load and validate correctly."""
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
    """MLP template should render a relaxation script."""
    from workflow.engine_runtime import _render_template

    content = _render_template(
        "mlp/run_mlp.py.j2",
        params={"model": "mace-mp-0", "fmax": 0.03, "max_steps": 300,
                "relax_cell": True, "optimizer": "FIRE"},
        structure_str=None,
        node_type="mlp_relax",
    )
    assert "mace-mp-0" in content
    assert "FIRE" in content
    assert "fmax=0.03" in content


def test_mlp_template_md():
    """MLP template should render an MD script."""
    from workflow.engine_runtime import _render_template

    content = _render_template(
        "mlp/run_mlp.py.j2",
        params={"model": "chgnet", "temp": 500, "steps": 1000,
                "timestep": 2.0},
        structure_str=None,
        node_type="mlp_md",
    )
    assert "chgnet" in content
    assert "500" in content  # temperature
    assert "Langevin" in content or "NVTBerendsen" in content
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/james0001/project/catgo/.worktrees/split-files && python -m pytest tests/test_engine_runtime.py::test_mlp_yaml_loads -v`
Expected: FAIL — FileNotFoundError

- [ ] **Step 3: Read the existing mlp.py engine to capture all params**

Read: `server/workflow/engines/mlp.py` (already read — use params: model, fmax, max_steps, relax_cell, optimizer, temp, steps, timestep)

- [ ] **Step 4: Create MLP YAML definition**

```yaml
# server/workflow/engine_defs/mlp.yaml
engine: mlp
label: Machine Learning Potentials
description: "ML potentials (MACE, CHGNet, M3GNet) for fast structure optimization and MD"

supported_calc_types:
  - geo_opt
  - md

params:
  - key: model
    label: "Model"
    type: select
    options:
      - { label: "MACE-MP-0 (Universal)", value: "mace-mp-0" }
      - { label: "CHGNet", value: "chgnet" }
      - { label: "M3GNet", value: "m3gnet" }
    default: "mace-mp-0"
  - key: fmax
    label: "Force Convergence"
    type: number
    default: 0.01
    unit: "eV/Å"
    range: [0.0001, 1.0]
    show_if: { key: calc_type, values: [geo_opt] }
  - key: max_steps
    label: "Max Steps"
    type: number
    default: 500
    range: [1, 10000]
    show_if: { key: calc_type, values: [geo_opt] }
  - key: relax_cell
    label: "Relax Cell"
    type: boolean
    default: false
    show_if: { key: calc_type, values: [geo_opt] }
  - key: optimizer
    label: "Optimizer"
    type: select
    options:
      - { label: "BFGS", value: "BFGS" }
      - { label: "FIRE", value: "FIRE" }
      - { label: "LBFGS", value: "LBFGS" }
    default: "BFGS"
    show_if: { key: calc_type, values: [geo_opt] }
  - key: temp
    label: "Temperature"
    type: number
    default: 300
    unit: "K"
    range: [0, 10000]
    show_if: { key: calc_type, values: [md] }
  - key: steps
    label: "MD Steps"
    type: number
    default: 1000
    range: [1, 1000000]
    show_if: { key: calc_type, values: [md] }
  - key: timestep
    label: "Timestep"
    type: number
    default: 1.0
    unit: "fs"
    range: [0.1, 10.0]
    show_if: { key: calc_type, values: [md] }

input_files:
  "run_mlp.py":
    template: "mlp/run_mlp.py.j2"
  "POSCAR":
    source: structure
    format: poscar

run_commands:
  - "python run_mlp.py"

output_files:
  structure: "CONTCAR"
  log: "opt.log"
  trajectory: "md.traj"

calc_type_mapping:
  geo_opt: mlp_relax
  md: mlp_md

safety: safe
```

- [ ] **Step 5: Create Jinja2 template for MLP**

```bash
mkdir -p server/workflow/templates/mlp
```

```jinja2
{# server/workflow/templates/mlp/run_mlp.py.j2 #}
#!/usr/bin/env python3
"""MLP {{ "relaxation" if node_type == "mlp_relax" else "molecular dynamics" }} generated by CatGo workflow engine."""
from ase.io import read, write

atoms = read("POSCAR", format="vasp")

# ─── Calculator setup ───
model = "{{ params.get('model', 'mace-mp-0') }}"
{% if params.get('model', 'mace-mp-0').startswith('mace') %}
from mace.calculators import mace_mp
calc = mace_mp(model=model, default_dtype="float64")
{% elif params.get('model') == 'chgnet' %}
from chgnet.model.dynamics import CHGNetCalculator
calc = CHGNetCalculator()
{% elif params.get('model') == 'm3gnet' %}
from matgl.ext.ase import M3GNetCalculator
import matgl
pot = matgl.load_model("M3GNet-MP-2021.2.8-PES")
calc = M3GNetCalculator(pot)
{% endif %}
atoms.calc = calc

{% if node_type == "mlp_relax" %}
# ─── Geometry optimization ───
{% if params.get('relax_cell', False) %}
from ase.constraints import ExpCellFilter
atoms_to_opt = ExpCellFilter(atoms)
{% else %}
atoms_to_opt = atoms
{% endif %}
from ase.optimize import {{ params.get('optimizer', 'BFGS') }}
opt = {{ params.get('optimizer', 'BFGS') }}(atoms_to_opt, trajectory="opt.traj", logfile="opt.log")
opt.run(fmax={{ params.get('fmax', 0.01) }}, steps={{ params.get('max_steps', 500) }})

write("CONTCAR", atoms, format="vasp")
print(f"Final energy: {atoms.get_potential_energy():.6f} eV")
{% elif node_type == "mlp_md" %}
# ─── Molecular dynamics ───
from ase.md.langevin import Langevin
from ase import units
from ase.io.trajectory import Trajectory

dyn = Langevin(atoms, timestep={{ params.get('timestep', 1.0) }} * units.fs,
               temperature_K={{ params.get('temp', 300) }}, friction=0.01)
traj = Trajectory("md.traj", "w", atoms)
dyn.attach(traj.write, interval=10)
dyn.run(steps={{ params.get('steps', 1000) }})
traj.close()

write("CONTCAR", atoms, format="vasp")
print(f"Final energy: {atoms.get_potential_energy():.6f} eV")
{% endif %}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd /home/james0001/project/catgo/.worktrees/split-files && python -m pytest tests/test_engine_runtime.py -v`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add server/workflow/engine_defs/mlp.yaml server/workflow/templates/mlp/run_mlp.py.j2 tests/test_engine_runtime.py
git commit -m "feat: add MLP declarative engine definition and Jinja2 template"
```

---

### Task 5: Registry Bridge — Wire Declarative Engines into Existing System

**Files:**
- Modify: `server/catgo/workflow/engine/engine_builtins.py`
- Modify: `server/workflow/node_sets.py`
- Modify: `server/catgo/workflow/engine/hpc_utils.py`
- Test: `tests/test_engine_runtime.py` (extend)

- [ ] **Step 1: Write failing test for end-to-end registry integration**

Add to `tests/test_engine_runtime.py`:

```python
def test_declarative_engines_register_in_global_registry():
    """Declarative engines should be discoverable via engine_registry."""
    from workflow.engine_runtime import load_all_engine_defs
    from catgo.workflow.engine.engine_registry import get_engine_generator, list_engines

    # Load all YAML defs
    runtimes = load_all_engine_defs()
    assert len(runtimes) >= 2  # at least xtb + mlp

    # They should NOT auto-register in the engine_registry yet
    # (that happens in engine_builtins.py)
    # But we can test the runtime registry
    from workflow.engine_runtime import get_runtime
    assert get_runtime("xtb") is not None
    assert get_runtime("mlp") is not None


def test_unified_calc_map_from_runtimes():
    """build_unified_calc_map should produce a combined mapping from all runtimes."""
    from workflow.engine_runtime import load_all_engine_defs, build_unified_calc_map

    load_all_engine_defs()
    mapping = build_unified_calc_map()
    assert mapping[("geo_opt", "xtb")] == "xtb_relax"
    assert mapping[("geo_opt", "mlp")] == "mlp_relax"
    assert mapping[("md", "mlp")] == "mlp_md"
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd /home/james0001/project/catgo/.worktrees/split-files && python -m pytest tests/test_engine_runtime.py::test_declarative_engines_register_in_global_registry -v`
Expected: PASS (these just test the runtime registry, not the engine_registry bridge yet)

- [ ] **Step 3: Add declarative engine auto-registration to engine_builtins.py**

At the end of `server/catgo/workflow/engine/engine_builtins.py`, after the collector loop, add:

```python
# ─── Declarative engines (YAML-based) ───

def _register_declarative_engines():
    """Load all YAML engine defs and register them in the engine/collector registries.

    Declarative engines coexist with handwritten engines. If a YAML def has the same
    engine key as an already-registered handwritten engine, the handwritten one wins
    (it was registered first via @register_engine above).
    """
    from workflow.engine_runtime import load_all_engine_defs
    from catgo.workflow.engine.engine_registry import get_engine_generator

    for runtime in load_all_engine_defs():
        key = runtime.spec.engine
        if get_engine_generator(key):
            # Handwritten engine already registered — skip YAML override
            continue

        @register_engine(key)
        async def _gen(hpc, work_dir, node_type, params, structure_str, config, task,
                       _rt=runtime):
            await _rt.generate_inputs(hpc, work_dir, node_type, params, structure_str, config, task)

        # Also register collector if not already present
        if key not in _ALL_ENGINE_KEYS:
            _make_collector(key)


_register_declarative_engines()
```

- [ ] **Step 4: Replace duplicated mapping in hpc_utils.py**

Replace lines 57-80 of `server/catgo/workflow/engine/hpc_utils.py`:

```python
def map_task_type_to_engine(task_type: str, params: dict) -> tuple[str, str]:
    """Map task_type + software to (resolved_node_type, engine_key).

    Uses the unified calc map built from all declarative engine definitions,
    with fallback to node_sets for non-declarative engines.
    """
    from workflow.node_sets import get_engine_for_node, _resolve_software

    resolved_type, software = _resolve_software(task_type, params)
    engine_key = get_engine_for_node(resolved_type)
    return resolved_type, engine_key
```

- [ ] **Step 5: Make node_sets._resolve_software data-driven**

Replace the hardcoded `_map` dict in `server/workflow/node_sets.py:_resolve_software` (lines 127-160) to first consult declarative engine runtimes:

```python
def _resolve_software(node_type: str, params: dict[str, object]) -> tuple[str, str]:
    """For unified nodes, resolve (effective_node_type, software) from params.

    Consults declarative engine specs first, then falls back to hardcoded map
    for engines not yet migrated to YAML.
    """
    if node_type not in UNIFIED_CALC_NODES:
        return node_type, ""

    software = str(params.get("software", "vasp"))

    # 1. Try declarative engine runtime
    try:
        from workflow.engine_runtime import build_unified_calc_map
        declarative_map = build_unified_calc_map()
        resolved = declarative_map.get((node_type, software))
        if resolved:
            return resolved, software
    except ImportError:
        pass

    # 2. Fallback: hardcoded map for engines not yet migrated
    _legacy_map: dict[tuple[str, str], str] = {
        ("geo_opt", "vasp"): "vasp_relax",
        ("geo_opt", "cp2k"): "cp2k_geopt",
        ("geo_opt", "orca"): "orca_opt",
        ("geo_opt", "xtb"): "xtb_relax",
        ("geo_opt", "mlp"): "mlp_relax",
        ("single_point", "vasp"): "vasp_static",
        ("single_point", "cp2k"): "cp2k_static",
        ("single_point", "orca"): "orca_sp",
        ("single_point", "xtb"): "xtb_static",
        ("cell_opt", "vasp"): "bulk_opt",
        ("cell_opt", "cp2k"): "cp2k_cellopt",
        ("md", "vasp"): "vasp_md",
        ("md", "cp2k"): "cp2k_md",
        ("md", "lammps"): "lammps_md",
        ("md", "gromacs"): "gromacs_md",
        ("md", "amber"): "amber_md",
        ("md", "mlp"): "mlp_md",
        ("md_minimize", "lammps"): "lammps_minimize",
        ("md_minimize", "gromacs"): "gromacs_minimize",
        ("md_minimize", "amber"): "amber_minimize",
        ("md_minimize", "mlp"): "mlp_relax",
        ("freq", "vasp"): "frequency",
        ("freq", "cp2k"): "cp2k_freq",
        ("freq", "orca"): "orca_freq",
        ("freq", "gaussian"): "gaussian_freq",
        ("geo_opt", "amber"): "amber_minimize",
        ("geo_opt", "gaussian"): "gaussian_opt",
        ("single_point", "gaussian"): "gaussian_sp",
        ("ts_search", "sella"): "sella_ts",
        ("ts_search", "orca"): "orca_neb_ts",
        ("irc", "orca"): "orca_irc",
        ("uvvis", "orca"): "orca_uvvis",
    }
    resolved = _legacy_map.get((node_type, software))
    if resolved:
        return resolved, software
    return node_type, software
```

- [ ] **Step 6: Run all tests**

Run: `cd /home/james0001/project/catgo/.worktrees/split-files && python -m pytest tests/test_engine_runtime.py -v`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add server/catgo/workflow/engine/engine_builtins.py server/catgo/workflow/engine/hpc_utils.py server/workflow/node_sets.py tests/test_engine_runtime.py
git commit -m "feat: bridge declarative engines into existing registry, unify calc type mapping"
```

---

### Task 6: Backend API — Engine Def Endpoints

**Files:**
- Modify: `server/catgo/routers/workflow.py`
- Test: `tests/test_engine_runtime.py` (extend)

- [ ] **Step 1: Write failing test for API endpoint**

Add to `tests/test_engine_runtime.py`:

```python
def test_engine_def_to_dict():
    """Runtime.to_dict() should produce a JSON-serializable dict."""
    from workflow.engine_runtime import load_yaml_engine
    from pathlib import Path
    import json

    yaml_path = Path(__file__).parent.parent / "server" / "workflow" / "engine_defs" / "xtb.yaml"
    rt = load_yaml_engine(yaml_path)
    d = rt.to_dict()

    # Should be JSON-serializable
    json_str = json.dumps(d)
    assert '"engine": "xtb"' in json_str
    assert '"supported_calc_types"' in json_str
    assert '"params"' in json_str

    # Params should be plain dicts, not dataclass instances
    assert isinstance(d["params"][0], dict)
    assert d["params"][0]["key"] == "method"
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd /home/james0001/project/catgo/.worktrees/split-files && python -m pytest tests/test_engine_runtime.py::test_engine_def_to_dict -v`
Expected: PASS

- [ ] **Step 3: Add API endpoints to workflow.py**

Add near the end of `server/catgo/routers/workflow.py` (before the last endpoint group):

```python
# ─── Engine Definition Endpoints ───

@router.get("/engine-defs")
async def list_engine_defs():
    """Return metadata for all declarative engines (built-in + custom)."""
    from workflow.engine_runtime import all_runtimes
    return [rt.to_dict() for rt in all_runtimes()]


@router.get("/engine-defs/{engine_key}")
async def get_engine_def(engine_key: str):
    """Return metadata for a specific declarative engine."""
    from workflow.engine_runtime import get_runtime
    rt = get_runtime(engine_key)
    if not rt:
        raise HTTPException(status_code=404, detail=f"Engine '{engine_key}' not found")
    return rt.to_dict()


@router.post("/engine-defs/custom")
async def create_custom_engine(request: Request):
    """Create a user-defined engine from a spec dict.

    The spec is validated, safety-assessed, saved to engine_defs/custom/,
    and immediately registered so the engine is available for use.
    """
    spec_dict = await request.json()
    from workflow.engine_defs.schema import validate_engine_spec, _assess_safety
    from workflow.engine_runtime import load_engine_def, ENGINE_DEFS_DIR
    import yaml

    try:
        spec = validate_engine_spec(spec_dict)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

    # Auto-assess safety if not explicitly set
    if "safety" not in spec_dict:
        spec_dict["safety"] = _assess_safety(spec_dict.get("run_commands", []))

    # Save YAML
    custom_dir = ENGINE_DEFS_DIR / "custom"
    custom_dir.mkdir(parents=True, exist_ok=True)
    yaml_path = custom_dir / f"{spec.engine}.yaml"
    with open(yaml_path, "w") as f:
        yaml.safe_dump(spec_dict, f, default_flow_style=False, sort_keys=False)

    # Register runtime
    rt = load_engine_def(spec_dict)

    return {"status": "created", "engine": spec.engine, "safety": spec.safety}
```

- [ ] **Step 4: Commit**

```bash
git add server/catgo/routers/workflow.py tests/test_engine_runtime.py
git commit -m "feat: add /engine-defs API endpoints for listing and creating engines"
```

---

### Task 7: Frontend — EngineSpec Type & Dynamic Loading

**Files:**
- Modify: `src/lib/workflow/workflow-types.ts`
- Create: `src/lib/workflow/node-defs/dynamic.ts`
- Modify: `src/lib/workflow/node-defs/index.ts`

- [ ] **Step 1: Add EngineSpec interface to workflow-types.ts**

Add at end of `src/lib/workflow/workflow-types.ts`:

```typescript
/** Declarative engine spec from backend YAML definitions */
export interface EngineParamSpec {
  key: string
  label: string
  type: string
  default?: unknown
  options?: { label: string; value: unknown }[]
  unit?: string
  range?: [number, number]
  help?: string
  group?: string
  show_if?: ShowIfCondition | ShowIfCondition[]
}

export interface EngineSpec {
  engine: string
  label: string
  description: string
  supported_calc_types: string[]
  params: EngineParamSpec[]
  input_files: Record<string, { template?: string; source?: string; format?: string }>
  run_commands: string[]
  output_files: Record<string, string>
  environment?: { modules?: string[] }
  parser?: string
  safety: `safe` | `warn` | `dangerous`
  calc_type_mapping: Record<string, string>
}
```

- [ ] **Step 2: Create dynamic.ts for loading engine specs**

```typescript
// src/lib/workflow/node-defs/dynamic.ts
/**
 * Dynamic engine loading — fetches declarative engine specs from the backend
 * and registers them as software options in unified calculation nodes.
 */
import type { ParamDef, EngineSpec, ShowIfCondition } from '../workflow-types'
import { NODE_DEFINITIONS, UNIFIED_CALC_TYPES } from './index'

/** Loaded engine specs, keyed by engine key */
const _engine_specs: Map<string, EngineSpec> = new Map()

/**
 * Fetch all declarative engine specs from the backend and register them
 * as software options in the unified calculation node dropdowns.
 */
export async function load_dynamic_engines(api_base: string): Promise<void> {
  try {
    const resp = await fetch(`${api_base}/workflow/engine-defs`)
    if (!resp.ok) return
    const specs: EngineSpec[] = await resp.json()

    for (const spec of specs) {
      _engine_specs.set(spec.engine, spec)
      _register_software_option(spec)
      _merge_params(spec)
    }
  } catch {
    // Backend may not support engine-defs yet — silently skip
  }
}

/**
 * For each supported calc type, ensure this engine appears as a software option
 * in the unified node's param_schema.
 */
function _register_software_option(spec: EngineSpec): void {
  for (const calc_type of spec.supported_calc_types) {
    const node_def = NODE_DEFINITIONS[calc_type]
    if (!node_def?.param_schema) continue

    const software_param = node_def.param_schema.find(p => p.key === `software`)
    if (!software_param?.options) continue

    // Add if not already present
    const exists = software_param.options.some(o => o.value === spec.engine)
    if (!exists) {
      software_param.options.push({ label: spec.label, value: spec.engine })
    }
  }
}

/**
 * Convert engine params to frontend ParamDefs and merge them into
 * the unified node's param_schema.
 */
function _merge_params(spec: EngineSpec): void {
  const frontend_params: ParamDef[] = spec.params.map(p => {
    const show_if: ShowIfCondition | ShowIfCondition[] = p.show_if
      ? [{ key: `software`, values: [spec.engine] }, ...(Array.isArray(p.show_if) ? p.show_if : [p.show_if])]
      : { key: `software`, values: [spec.engine] }

    return {
      key: p.key,
      label: p.label,
      type: p.type as ParamDef[`type`],
      default: p.default,
      options: p.options,
      help: p.help,
      group: p.group,
      show_if,
      min: p.range?.[0],
      max: p.range?.[1],
    }
  })

  // Merge into each supported calc type's node definition
  for (const calc_type of spec.supported_calc_types) {
    const node_def = NODE_DEFINITIONS[calc_type]
    if (!node_def) continue

    for (const param of frontend_params) {
      // Avoid duplicates
      const existing = node_def.param_schema?.find(p => p.key === param.key)
      if (!existing) {
        node_def.param_schema = node_def.param_schema || []
        node_def.param_schema.push(param)
      }
    }
  }
}

/** Get a loaded engine spec by key */
export function get_engine_spec(engine_key: string): EngineSpec | undefined {
  return _engine_specs.get(engine_key)
}

/** Get all loaded engine specs */
export function all_engine_specs(): EngineSpec[] {
  return [..._engine_specs.values()]
}
```

- [ ] **Step 3: Wire dynamic loading into node-defs/index.ts**

Add to `src/lib/workflow/node-defs/index.ts` after `load_plugin_nodes`:

```typescript
export { load_dynamic_engines, get_engine_spec, all_engine_specs } from './dynamic'
```

- [ ] **Step 4: Call load_dynamic_engines in WorkflowEditor**

In `src/lib/workflow/WorkflowEditor.svelte`, find where `load_plugin_nodes` is called (on mount) and add `load_dynamic_engines` alongside it. Find the import line and add:

```typescript
import { ..., load_dynamic_engines } from './node-definitions'
```

Then in the onMount or initialization section, after `load_plugin_nodes(api_base)`:

```typescript
load_dynamic_engines(api_base)
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/workflow/workflow-types.ts src/lib/workflow/node-defs/dynamic.ts src/lib/workflow/node-defs/index.ts src/lib/workflow/WorkflowEditor.svelte
git commit -m "feat: frontend dynamic engine loading from backend YAML specs"
```

---

### Task 8: Custom Command Wizard Component

**Files:**
- Create: `src/lib/workflow/components/CustomCommandWizard.svelte`
- Modify: `src/lib/workflow/WorkflowEditor.svelte`

- [ ] **Step 1: Create CustomCommandWizard component**

```svelte
<!-- src/lib/workflow/components/CustomCommandWizard.svelte -->
<script lang="ts">
  import type { EngineSpec } from '../workflow-types'

  interface Props {
    api_base: string
    onclose: () => void
    oncreated: (engine_key: string) => void
  }

  let { api_base, onclose, oncreated }: Props = $props()

  let name = $state('')
  let commands = $state([''])
  let input_files = $state<{ name: string; source: 'editor' | 'upstream' }[]>([])
  let output_structure = $state('')
  let output_files = $state<string[]>([])
  let modules = $state<string[]>([])
  let error = $state('')
  let creating = $state(false)

  function add_command() { commands = [...commands, ''] }
  function remove_command(i: number) { commands = commands.filter((_, idx) => idx !== i) }
  function add_input_file() { input_files = [...input_files, { name: '', source: 'editor' }] }
  function remove_input_file(i: number) { input_files = input_files.filter((_, idx) => idx !== i) }
  function add_output_file() { output_files = [...output_files, ''] }
  function remove_output_file(i: number) { output_files = output_files.filter((_, idx) => idx !== i) }
  function add_module() { modules = [...modules, ''] }
  function remove_module(i: number) { modules = modules.filter((_, idx) => idx !== i) }

  async function create() {
    if (!name.trim()) { error = 'Name is required'; return }
    if (commands.every(c => !c.trim())) { error = 'At least one command is required'; return }

    creating = true
    error = ''

    const engine_key = `custom_${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${Date.now()}`

    const spec: Record<string, unknown> = {
      engine: engine_key,
      label: name.trim(),
      description: `Custom command: ${name.trim()}`,
      supported_calc_types: [],
      params: [],
      input_files: Object.fromEntries(
        input_files
          .filter(f => f.name.trim())
          .map(f => [f.name.trim(), { source: f.source === 'upstream' ? 'upstream' : 'user' }])
      ),
      run_commands: commands.filter(c => c.trim()),
      output_files: {
        ...(output_structure ? { structure: output_structure } : {}),
        ...Object.fromEntries(output_files.filter(f => f.trim()).map((f, i) => [`file_${i}`, f])),
      },
      environment: { modules: modules.filter(m => m.trim()) },
      calc_type_mapping: {},
    }

    try {
      const resp = await fetch(`${api_base}/workflow/engine-defs/custom`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(spec),
      })
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({ detail: resp.statusText }))
        error = data.detail || 'Failed to create engine'
        return
      }
      oncreated(engine_key)
    } catch (e) {
      error = `Connection error: ${e}`
    } finally {
      creating = false
    }
  }
</script>

<div class="wizard-overlay" onclick={onclose}>
  <div class="wizard-modal" onclick|stopPropagation>
    <h2>Create Custom Command</h2>

    <label>
      Name
      <input type="text" bind:value={name} placeholder="My LAMMPS Script" />
    </label>

    <fieldset>
      <legend>Input Files</legend>
      {#each input_files as file, i}
        <div class="row">
          <input type="text" bind:value={file.name} placeholder="in.lammps" />
          <select bind:value={file.source}>
            <option value="editor">Editor / Upload</option>
            <option value="upstream">From Upstream</option>
          </select>
          <button class="btn-sm" onclick={() => remove_input_file(i)}>✕</button>
        </div>
      {/each}
      <button class="btn-sm" onclick={add_input_file}>+ Add File</button>
    </fieldset>

    <fieldset>
      <legend>Commands</legend>
      {#each commands as cmd, i}
        <div class="row">
          <input type="text" bind:value={commands[i]} placeholder="lmp -in in.lammps" />
          {#if commands.length > 1}
            <button class="btn-sm" onclick={() => remove_command(i)}>✕</button>
          {/if}
        </div>
      {/each}
      <button class="btn-sm" onclick={add_command}>+ Add Command</button>
    </fieldset>

    <fieldset>
      <legend>Output Files</legend>
      <label>
        Output Structure (optional)
        <input type="text" bind:value={output_structure} placeholder="final.data" />
      </label>
      {#each output_files as file, i}
        <div class="row">
          <input type="text" bind:value={output_files[i]} placeholder="log.lammps" />
          <button class="btn-sm" onclick={() => remove_output_file(i)}>✕</button>
        </div>
      {/each}
      <button class="btn-sm" onclick={add_output_file}>+ Add File</button>
    </fieldset>

    <fieldset>
      <legend>HPC Modules (optional)</legend>
      {#each modules as mod, i}
        <div class="row">
          <input type="text" bind:value={modules[i]} placeholder="gromacs/2023.3" />
          <button class="btn-sm" onclick={() => remove_module(i)}>✕</button>
        </div>
      {/each}
      <button class="btn-sm" onclick={add_module}>+ Add Module</button>
    </fieldset>

    <div class="warning">Custom commands run directly on HPC. Review carefully before submitting.</div>

    {#if error}
      <div class="error">{error}</div>
    {/if}

    <div class="actions">
      <button onclick={onclose}>Cancel</button>
      <button class="primary" onclick={create} disabled={creating}>
        {creating ? 'Creating...' : 'Create Node'}
      </button>
    </div>
  </div>
</div>

<style>
  .wizard-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.5);
    display: flex; align-items: center; justify-content: center; z-index: 1000;
  }
  .wizard-modal {
    background: var(--bg-primary, #1e1e2e); color: var(--text-primary, #cdd6f4);
    border-radius: 12px; padding: 24px; width: 560px; max-height: 80vh; overflow-y: auto;
  }
  h2 { margin: 0 0 16px; font-size: 18px; }
  label { display: block; margin-bottom: 12px; font-size: 13px; }
  input, select { width: 100%; padding: 6px 8px; border: 1px solid var(--border, #45475a);
    border-radius: 6px; background: var(--bg-secondary, #313244); color: inherit; margin-top: 4px; }
  fieldset { border: 1px solid var(--border, #45475a); border-radius: 8px; padding: 12px; margin-bottom: 12px; }
  legend { font-size: 13px; font-weight: 600; }
  .row { display: flex; gap: 8px; margin-bottom: 6px; align-items: center; }
  .row input { flex: 1; }
  .btn-sm { padding: 4px 10px; border-radius: 4px; border: 1px solid var(--border, #45475a);
    background: transparent; color: inherit; cursor: pointer; font-size: 12px; }
  .warning { padding: 8px 12px; background: rgba(249, 158, 11, 0.15); border-radius: 6px;
    color: #f59e0b; font-size: 12px; margin-bottom: 12px; }
  .error { padding: 8px 12px; background: rgba(239, 68, 68, 0.15); border-radius: 6px;
    color: #ef4444; font-size: 12px; margin-bottom: 12px; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
  .actions button { padding: 8px 16px; border-radius: 6px; border: 1px solid var(--border, #45475a);
    background: transparent; color: inherit; cursor: pointer; }
  .actions .primary { background: var(--accent, #89b4fa); color: #1e1e2e; border: none; font-weight: 600; }
</style>
```

- [ ] **Step 2: Add "Custom Command" button to WorkflowEditor sidebar**

In `WorkflowEditor.svelte`, add a state variable and import:

```typescript
import CustomCommandWizard from './components/CustomCommandWizard.svelte'

let show_custom_wizard = $state(false)
```

Find the sidebar node palette section (where node categories are rendered) and add a button at the bottom:

```svelte
<button class="custom-cmd-btn" onclick={() => show_custom_wizard = true}>
  + Custom Command
</button>
```

And render the wizard modal:

```svelte
{#if show_custom_wizard}
  <CustomCommandWizard
    {api_base}
    onclose={() => show_custom_wizard = false}
    oncreated={(key) => {
      show_custom_wizard = false
      // Reload dynamic engines to pick up the new custom engine
      load_dynamic_engines(api_base)
    }}
  />
{/if}
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/workflow/components/CustomCommandWizard.svelte src/lib/workflow/WorkflowEditor.svelte
git commit -m "feat: add Custom Command wizard for user-defined workflow nodes"
```

---

### Task 9: Safety Warning UI

**Files:**
- Modify: `src/lib/workflow/WorkflowEditor.svelte`

- [ ] **Step 1: Add safety check before workflow submission**

In `WorkflowEditor.svelte`, find the run/submit workflow function. Before the actual submission call, add a safety check:

```typescript
import { all_engine_specs } from './node-defs/dynamic'

function check_workflow_safety(nodes: WfNode[]): { level: string; warnings: string[] } {
  const warnings: string[] = []
  let max_level = 'safe'

  for (const spec of all_engine_specs()) {
    if (spec.safety === 'warn' || spec.safety === 'dangerous') {
      // Check if any node uses this engine
      const uses = nodes.some(n => {
        const sw = n.data?.params?.software
        return sw === spec.engine
      })
      if (uses) {
        if (spec.safety === 'dangerous') max_level = 'dangerous'
        else if (max_level !== 'dangerous') max_level = 'warn'
        warnings.push(`${spec.label}: runs custom commands on HPC`)
      }
    }
  }

  return { level: max_level, warnings }
}
```

In the submit handler, before calling the run API:

```typescript
const safety = check_workflow_safety(nodes)
if (safety.level === 'dangerous') {
  const confirmed = confirm(
    `⚠️ DANGEROUS: This workflow contains nodes that run potentially dangerous commands:\n\n` +
    safety.warnings.join('\n') +
    `\n\nAre you SURE you want to proceed?`
  )
  if (!confirmed) return
} else if (safety.level === 'warn') {
  const confirmed = confirm(
    `⚠️ This workflow contains custom command nodes:\n\n` +
    safety.warnings.join('\n') +
    `\n\nProceed?`
  )
  if (!confirmed) return
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/workflow/WorkflowEditor.svelte
git commit -m "feat: add safety warning UI for custom command workflow nodes"
```

---

### Task 10: Integration Verification & Cleanup

**Files:**
- Test: `tests/test_engine_runtime.py` (final integration test)
- Cleanup: ensure `pnpm check` passes

- [ ] **Step 1: Write full integration test**

Add to `tests/test_engine_runtime.py`:

```python
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
```

- [ ] **Step 2: Run all tests**

Run: `cd /home/james0001/project/catgo/.worktrees/split-files && python -m pytest tests/test_engine_runtime.py -v`
Expected: All tests PASS

- [ ] **Step 3: Run frontend type check**

Run: `cd /home/james0001/project/catgo/.worktrees/split-files && pnpm check`
Expected: No new TypeScript errors introduced

- [ ] **Step 4: Commit**

```bash
git add tests/test_engine_runtime.py
git commit -m "test: add full integration test for declarative engine roundtrip"
```

---

## Summary

| Task | What | Key Files |
|------|------|-----------|
| 1 | YAML schema + validation | `engine_defs/schema.py` |
| 2 | DeclarativeEngineRuntime core | `engine_runtime.py` |
| 3 | xTB YAML + template | `engine_defs/xtb.yaml`, `templates/xtb/` |
| 4 | MLP YAML + template | `engine_defs/mlp.yaml`, `templates/mlp/` |
| 5 | Registry bridge + unified mapping | `engine_builtins.py`, `node_sets.py`, `hpc_utils.py` |
| 6 | Backend API endpoints | `routers/workflow.py` |
| 7 | Frontend dynamic loading | `dynamic.ts`, `workflow-types.ts` |
| 8 | Custom Command wizard | `CustomCommandWizard.svelte` |
| 9 | Safety warning UI | `WorkflowEditor.svelte` |
| 10 | Integration test + cleanup | `test_engine_runtime.py` |

**Phase 1 scope (this plan):** Framework + xTB + MLP as validation. After this plan is complete, remaining engines (ORCA, CP2K, LAMMPS, VASP) can be migrated incrementally using the same YAML + template pattern.

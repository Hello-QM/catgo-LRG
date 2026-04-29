# Tool-First Architecture Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace CatGo's fragmented 5-class plugin system with a unified Tool abstraction where CatBot can generate, test, and register tools automatically.

**Architecture:** Single `ToolRegistry` backed by `TOOL` dict + `execute(context)` convention. Three trust levels (builtin/user/sandboxed). Frontend auto-renders results by `output_type`. Compatibility layer bridges legacy plugins during transition.

**Tech Stack:** Python 3.12 (FastAPI, pytest), Svelte 5 (runes), TypeScript

**Spec:** `docs/superpowers/specs/2026-03-11-tool-first-architecture-design.md`

---

## File Structure

### New Files

| File | Responsibility |
|---|---|
| `server/tools/__init__.py` | Export `registry` singleton |
| `server/tools/models.py` | `ToolEntry`, `ToolResult` dataclasses |
| `server/tools/registry.py` | `ToolRegistry` — register, get, list, enable/disable |
| `server/tools/sandbox.py` | `audit_code()`, `execute_in_sandbox()` — refactored from `plugins/sandbox.py` |
| `server/tools/executor.py` | `execute_tool()` — context assembly, trust dispatch, output post-processing |
| `server/tools/discovery.py` | `discover_tools()` — scan `plugins/` + `~/.catgo/tools/`, load TOOL dicts |
| `server/tools/builder.py` | `create_from_code()`, `save_tool()`, `upgrade_trust()` — AI tool lifecycle |
| `server/tools/compat.py` | `load_legacy_plugin()`, `load_legacy_mcp_plugin()` — old format adapters |
| `server/tools/builtin/` | Migrated builtin readers (trust: builtin) |
| `server/routers/tools.py` | REST API: `/tools`, `/tools/{id}/run`, `/tools/create`, etc. |
| `src/lib/chat/ToolResultRenderer.svelte` | Auto-render tool results by `output_type` |
| `server/tests/test_tool_registry.py` | Registry unit tests |
| `server/tests/test_tool_sandbox.py` | Sandbox unit tests |
| `server/tests/test_tool_executor.py` | Executor unit tests |
| `server/tests/test_tool_discovery.py` | Discovery unit tests |
| `server/tests/test_tool_builder.py` | Builder unit tests |
| `server/tests/test_tool_api.py` | REST API integration tests |

### Modified Files

| File | Change |
|---|---|
| `server/main.py:84-88` | Add `await registry.discover()` in lifespan |
| `server/mcp_tools/server.py:100-118` | `list_tools` includes registry tools |
| `server/mcp_tools/server.py:1180-1200` | `call_tool` dispatches via registry |
| `src/lib/plugins/loader.ts` | Accept both `catgo-plugin.json` and `catgo-tool.json` |
| `src/lib/plugins/manager.svelte.ts` | Accept `catgo-tool.json` in ZIP install validation |
| `server/calculators/base.py:99-105` | Use `registry.get_calculator()` instead of `plugin_manager` |
| `server/routers/optimize.py:110-121` | Use `registry.list_by_category("calculator")` |
| `src/lib/chat/ChatPane.svelte:1180-1187` | Integrate ToolResultRenderer |
| `src/lib/chat/types.ts:31-35` | Extend ToolResultBlock for structured data |

### Files to Delete (after migration)

| File | Replaced By |
|---|---|
| `server/plugin_loader.py` | `tools/discovery.py` |
| `server/plugins/base.py` | `tools/models.py` |
| `server/plugins/manager.py` | `tools/registry.py` |
| `server/plugins/discovery.py` | `tools/discovery.py` |
| `server/plugins/tool_builder.py` | `tools/builder.py` |
| `server/plugins/sandbox.py` | `tools/sandbox.py` |
| `server/plugins/builtin_readers.py` | `tools/builtin/` |
| `server/routers/plugins.py` | `routers/tools.py` |

---

## Chunk 1: Foundation

### Task 1: ToolEntry and ToolResult Data Classes

**Files:**
- Create: `server/tools/__init__.py`
- Create: `server/tools/models.py`
- Test: `server/tests/test_tool_registry.py`

- [ ] **Step 1: Write failing tests for data classes**

```python
# server/tests/test_tool_registry.py
import pytest
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


class TestToolEntry:
    """Test ToolEntry dataclass creation and defaults."""

    def test_minimal_creation(self):
        from tools.models import ToolEntry
        tool = ToolEntry(id="rdf", name="RDF Analysis", description="Compute RDF")
        assert tool.id == "rdf"
        assert tool.category == "general"
        assert tool.trust == "sandboxed"
        assert tool.enabled is True
        assert tool.output_type == "text"
        assert tool.ephemeral is False

    def test_calculator_fields(self):
        from tools.models import ToolEntry
        tool = ToolEntry(
            id="lj", name="LJ", description="LJ potential",
            category="calculator",
            supported_elements=["Ar", "Kr"],
        )
        assert tool.category == "calculator"
        assert tool.supported_elements == ["Ar", "Kr"]

    def test_reader_fields(self):
        from tools.models import ToolEntry
        tool = ToolEntry(
            id="cp2k", name="CP2K", description="Read CP2K",
            category="reader",
            supported_formats=[".pdos"],
            multi_file=True,
        )
        assert tool.supported_formats == [".pdos"]
        assert tool.multi_file is True

    def test_id_validation_rejects_spaces(self):
        from tools.models import validate_tool_id
        assert validate_tool_id("rdf_analysis") is True
        assert validate_tool_id("my-tool-v2") is True
        assert validate_tool_id("Bad Name") is False
        assert validate_tool_id("") is False


class TestToolResult:
    """Test ToolResult dataclass."""

    def test_success_result(self):
        from tools.models import ToolResult
        r = ToolResult(data={"x": [1, 2]}, output_type="scatter_plot", tool_id="rdf")
        assert r.error is None
        assert r.output_type == "scatter_plot"

    def test_error_result(self):
        from tools.models import ToolResult
        r = ToolResult(data={}, output_type="text", tool_id="rdf", error="ImportError")
        assert r.error == "ImportError"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && python -m pytest tests/test_tool_registry.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'tools'`

- [ ] **Step 3: Implement models.py**

```python
# server/tools/models.py
"""Core data classes for the Tool-First architecture."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional

_VALID_ID = re.compile(r"^[a-z0-9][a-z0-9_-]*$")

VALID_OUTPUT_TYPES = frozenset({
    "scatter_plot", "bar_plot", "table", "text", "image",
    "structure", "atom_property", "trajectory",
    "electronic_dos", "electronic_bands", "cohp",
})

VALID_CATEGORIES = frozenset({
    "general", "calculator", "reader", "optimizer", "workflow_node",
})


def validate_tool_id(tool_id: str) -> bool:
    """Check if tool_id matches [a-z0-9][a-z0-9_-]*."""
    return bool(_VALID_ID.match(tool_id))


@dataclass
class ToolResult:
    """Result of a tool execution."""
    data: dict
    output_type: str
    tool_id: str
    error: Optional[str] = None
    traceback: Optional[str] = None
    session_id: Optional[str] = None


@dataclass
class ToolEntry:
    """A registered tool in the ToolRegistry."""

    # Identity
    id: str
    name: str
    description: str
    version: str = "1.0.0"
    author: str = ""

    # Behavior
    category: str = "general"
    input_schema: dict = field(default_factory=dict)
    output_type: str = "text"

    # Trust
    trust: str = "sandboxed"
    permissions: list[str] = field(default_factory=list)

    # Source
    source: str = "code"
    path: Optional[Path] = None
    ephemeral: bool = False

    # Callables (not serialized)
    execute_fn: Optional[Callable] = field(default=None, repr=False)
    extra_fns: dict[str, Callable] = field(default_factory=dict, repr=False)

    # Optional frontend
    frontend: Optional[dict] = None

    # Category-specific
    supported_elements: Optional[list[str]] = None
    supported_formats: Optional[list[str]] = None
    multi_file: bool = False
    node_definition: Optional[dict] = None
    supports_cell_optimization: bool = False

    # State
    enabled: bool = True

    # Lifecycle
    on_load_fn: Optional[Callable] = field(default=None, repr=False)
    on_unload_fn: Optional[Callable] = field(default=None, repr=False)

    def to_dict(self) -> dict:
        """Serialize to dict for REST/MCP (excludes callables)."""
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "version": self.version,
            "author": self.author,
            "category": self.category,
            "input_schema": self.input_schema,
            "output_type": self.output_type,
            "trust": self.trust,
            "permissions": self.permissions,
            "enabled": self.enabled,
            "source": self.source,
            "supported_elements": self.supported_elements,
            "supported_formats": self.supported_formats,
            "multi_file": self.multi_file,
            "node_definition": self.node_definition,
            "supports_cell_optimization": self.supports_cell_optimization,
            "has_frontend": self.frontend is not None,
        }
```

```python
# server/tools/__init__.py
"""Tool-First architecture — unified tool system."""
```

- [ ] **Step 4: Run tests and verify they pass**

Run: `cd server && python -m pytest tests/test_tool_registry.py -v`
Expected: All 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add server/tools/ server/tests/test_tool_registry.py
git commit -m "feat(tools): add ToolEntry and ToolResult data classes"
```

---

### Task 2: ToolRegistry Core

**Files:**
- Create: `server/tools/registry.py`
- Modify: `server/tools/__init__.py`
- Test: `server/tests/test_tool_registry.py` (append)

- [ ] **Step 1: Write failing tests for registry**

Append to `server/tests/test_tool_registry.py`:

```python
class TestToolRegistry:
    """Test ToolRegistry registration, lookup, and listing."""

    def _make_entry(self, **overrides):
        from tools.models import ToolEntry
        defaults = dict(id="test_tool", name="Test", description="A test tool")
        defaults.update(overrides)
        return ToolEntry(**defaults)

    def test_register_and_get(self):
        from tools.registry import ToolRegistry
        reg = ToolRegistry()
        entry = self._make_entry()
        reg.register(entry)
        assert reg.get("test_tool") is entry

    def test_get_nonexistent_returns_none(self):
        from tools.registry import ToolRegistry
        reg = ToolRegistry()
        assert reg.get("nope") is None

    def test_register_rejects_invalid_id(self):
        from tools.registry import ToolRegistry
        reg = ToolRegistry()
        entry = self._make_entry(id="Bad Name")
        with pytest.raises(ValueError, match="Invalid tool id"):
            reg.register(entry)

    def test_list_all(self):
        from tools.registry import ToolRegistry
        reg = ToolRegistry()
        reg.register(self._make_entry(id="a", name="A", description="A"))
        reg.register(self._make_entry(id="b", name="B", description="B"))
        assert len(reg.list_all()) == 2

    def test_list_by_category(self):
        from tools.registry import ToolRegistry
        reg = ToolRegistry()
        reg.register(self._make_entry(id="a", name="A", description="A", category="calculator"))
        reg.register(self._make_entry(id="b", name="B", description="B", category="general"))
        calcs = reg.list_by_category("calculator")
        assert len(calcs) == 1
        assert calcs[0].id == "a"

    def test_unregister(self):
        from tools.registry import ToolRegistry
        reg = ToolRegistry()
        reg.register(self._make_entry())
        reg.unregister("test_tool")
        assert reg.get("test_tool") is None

    def test_enable_disable(self):
        from tools.registry import ToolRegistry
        reg = ToolRegistry()
        reg.register(self._make_entry())
        reg.disable("test_tool")
        assert reg.get("test_tool").enabled is False
        reg.enable("test_tool")
        assert reg.get("test_tool").enabled is True

    def test_duplicate_id_overwrites_with_warning(self):
        from tools.registry import ToolRegistry
        reg = ToolRegistry()
        reg.register(self._make_entry(version="1.0"))
        reg.register(self._make_entry(version="2.0"))
        assert reg.get("test_tool").version == "2.0"
        assert len(reg.list_all()) == 1

    def test_get_calculator(self):
        from tools.registry import ToolRegistry
        reg = ToolRegistry()
        calc_fn = lambda **params: f"calc_with_{params}"
        entry = self._make_entry(
            id="lj", name="LJ", description="LJ",
            category="calculator",
            extra_fns={"get_calculator": calc_fn},
        )
        reg.register(entry)
        result = reg.get_calculator("lj", cutoff=10.0)
        assert result == "calc_with_{'cutoff': 10.0}"

    def test_get_calculator_not_found_raises(self):
        from tools.registry import ToolRegistry
        reg = ToolRegistry()
        with pytest.raises(KeyError):
            reg.get_calculator("nonexistent")

    def test_find_reader_for_files(self):
        from tools.registry import ToolRegistry
        reg = ToolRegistry()
        detect = lambda fns: any(f.endswith(".pdos") for f in fns)
        priority = lambda fns: 20 if any(f.endswith(".pdos") for f in fns) else 0
        entry = self._make_entry(
            id="cp2k", name="CP2K", description="Read CP2K",
            category="reader",
            supported_formats=[".pdos"],
            extra_fns={"detect_files": detect, "priority_score": priority},
        )
        reg.register(entry)
        found = reg.find_reader_for_files(["alpha-PDOS.pdos"])
        assert found is not None
        assert found.id == "cp2k"

    def test_find_reader_returns_none_when_no_match(self):
        from tools.registry import ToolRegistry
        reg = ToolRegistry()
        assert reg.find_reader_for_files(["file.xyz"]) is None

    def test_get_all_workflow_node_definitions(self):
        from tools.registry import ToolRegistry
        reg = ToolRegistry()
        node_def = {"type": "lammps_nvt", "label": "LAMMPS NVT"}
        entry = self._make_entry(
            id="lammps", name="LAMMPS", description="MD",
            category="workflow_node", node_definition=node_def,
        )
        reg.register(entry)
        defs = reg.get_all_workflow_node_definitions()
        assert len(defs) == 1
        assert defs[0]["type"] == "lammps_nvt"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && python -m pytest tests/test_tool_registry.py::TestToolRegistry -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'tools.registry'`

- [ ] **Step 3: Implement registry.py**

```python
# server/tools/registry.py
"""ToolRegistry — the single registration center for all tools."""

from __future__ import annotations

import logging
from typing import Any, Optional

from .models import ToolEntry, ToolResult, validate_tool_id

logger = logging.getLogger(__name__)


class ToolRegistry:
    """Singleton registry for all tools."""

    def __init__(self):
        self._tools: dict[str, ToolEntry] = {}

    # ── Core ──

    def register(self, tool: ToolEntry) -> None:
        if not validate_tool_id(tool.id):
            raise ValueError(f"Invalid tool id: {tool.id!r}. Must match [a-z0-9][a-z0-9_-]*")
        if tool.id in self._tools:
            logger.warning("Tool %r already registered, overwriting", tool.id)
        self._tools[tool.id] = tool
        logger.info("Registered tool: %s (%s, trust=%s)", tool.id, tool.category, tool.trust)

    def unregister(self, tool_id: str) -> None:
        tool = self._tools.pop(tool_id, None)
        if tool and tool.on_unload_fn:
            try:
                import asyncio
                asyncio.get_event_loop().run_until_complete(tool.on_unload_fn())
            except Exception:
                logger.exception("on_unload failed for %s", tool_id)

    # ── Query ──

    def get(self, tool_id: str) -> Optional[ToolEntry]:
        return self._tools.get(tool_id)

    def list_all(self) -> list[ToolEntry]:
        return list(self._tools.values())

    def list_by_category(self, category: str) -> list[ToolEntry]:
        return [t for t in self._tools.values() if t.category == category]

    # ── Enable / Disable ──

    def enable(self, tool_id: str) -> None:
        tool = self._tools.get(tool_id)
        if tool:
            tool.enabled = True

    def disable(self, tool_id: str) -> None:
        tool = self._tools.get(tool_id)
        if tool:
            tool.enabled = False

    # ── Category-specific accessors ──

    def get_calculator(self, tool_id: str, **params) -> Any:
        """Return ASE Calculator from a calculator-category tool."""
        tool = self._tools.get(tool_id)
        if not tool or tool.category != "calculator":
            raise KeyError(f"Calculator tool not found: {tool_id}")
        if not tool.enabled:
            raise KeyError(f"Calculator tool disabled: {tool_id}")
        get_calc = tool.extra_fns.get("get_calculator")
        if not get_calc:
            raise KeyError(f"Tool {tool_id} has no get_calculator function")
        return get_calc(**params)

    def get_optimizer(self, tool_id: str, atoms: Any, **params) -> Any:
        """Return ASE Optimizer from an optimizer-category tool."""
        tool = self._tools.get(tool_id)
        if not tool or tool.category != "optimizer":
            raise KeyError(f"Optimizer tool not found: {tool_id}")
        if not tool.enabled:
            raise KeyError(f"Optimizer tool disabled: {tool_id}")
        get_opt = tool.extra_fns.get("get_optimizer")
        if not get_opt:
            raise KeyError(f"Tool {tool_id} has no get_optimizer function")
        return get_opt(atoms, **params)

    def find_reader_for_files(self, filenames: list[str]) -> Optional[ToolEntry]:
        """Find the best reader tool for the given filenames."""
        best: Optional[ToolEntry] = None
        best_score = -1
        for tool in self._tools.values():
            if tool.category != "reader" or not tool.enabled:
                continue
            detect = tool.extra_fns.get("detect_files")
            if detect and detect(filenames):
                priority = tool.extra_fns.get("priority_score")
                score = priority(filenames) if priority else 0
                if score > best_score:
                    best = tool
                    best_score = score
            elif not detect:
                # Fallback: match by supported_formats
                exts = tool.supported_formats or []
                if any(any(fn.lower().endswith(ext) for ext in exts) for fn in filenames):
                    if 0 > best_score:
                        best = tool
                        best_score = 0
        return best

    def get_all_workflow_node_definitions(self) -> list[dict]:
        """Return node_definition dicts for all enabled workflow_node tools."""
        return [
            t.node_definition
            for t in self._tools.values()
            if t.category == "workflow_node" and t.enabled and t.node_definition
        ]

    async def call(self, tool_id: str, arguments: dict, **kwargs) -> "ToolResult":
        """Execute a tool by ID. Central dispatch point for all callers."""
        from .executor import execute_tool
        tool = self.get(tool_id)
        if not tool:
            from .models import ToolResult
            return ToolResult(data={}, output_type="text", tool_id=tool_id, error=f"Tool not found: {tool_id}")
        return await execute_tool(tool, arguments, **kwargs)
```

Update `__init__.py`:

```python
# server/tools/__init__.py
"""Tool-First architecture — unified tool system."""
from .models import ToolEntry, ToolResult, validate_tool_id
from .registry import ToolRegistry

registry = ToolRegistry()

__all__ = ["registry", "ToolEntry", "ToolResult", "ToolRegistry", "validate_tool_id"]
```

- [ ] **Step 4: Run tests and verify they pass**

Run: `cd server && python -m pytest tests/test_tool_registry.py -v`
Expected: All tests PASS (6 from Task 1 + 13 from Task 2 = 19 total)

- [ ] **Step 5: Commit**

```bash
git add server/tools/ server/tests/test_tool_registry.py
git commit -m "feat(tools): add ToolRegistry with register, get, list, category accessors"
```

---

### Task 3: Sandbox Module

**Files:**
- Create: `server/tools/sandbox.py`
- Test: `server/tests/test_tool_sandbox.py`

This is a refactored version of `server/plugins/sandbox.py` with the same AST audit + subprocess isolation, adapted for the new `execute(context)` signature.

- [ ] **Step 1: Write failing tests for sandbox**

```python
# server/tests/test_tool_sandbox.py
import pytest
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


class TestAuditCode:
    """Test AST-based security audit."""

    def test_clean_code_passes(self):
        from tools.sandbox import audit_code
        code = """
import numpy as np
TOOL = {"name": "test", "description": "test", "input_schema": {}, "output_type": "text"}
async def execute(context):
    return {"content": str(np.pi)}
"""
        violations = audit_code(code)
        assert violations == []

    def test_os_import_blocked(self):
        from tools.sandbox import audit_code
        code = "import os\nasync def execute(context): pass"
        violations = audit_code(code)
        assert any("os" in v for v in violations)

    def test_subprocess_import_blocked(self):
        from tools.sandbox import audit_code
        code = "import subprocess\nasync def execute(context): pass"
        violations = audit_code(code)
        assert any("subprocess" in v for v in violations)

    def test_open_call_blocked(self):
        from tools.sandbox import audit_code
        code = "async def execute(context):\n    f = open('x')\n"
        violations = audit_code(code)
        assert any("open" in v for v in violations)

    def test_pymatgen_allowed(self):
        from tools.sandbox import audit_code
        code = "from pymatgen.core import Structure\nasync def execute(context): pass"
        violations = audit_code(code)
        assert violations == []

    def test_scipy_allowed(self):
        from tools.sandbox import audit_code
        code = "from scipy.spatial import KDTree\nasync def execute(context): pass"
        violations = audit_code(code)
        assert violations == []


class TestVerifyToolFormat:
    """Test TOOL dict + execute() function validation."""

    def test_valid_tool(self):
        from tools.sandbox import verify_tool_format
        code = '''
TOOL = {"name": "test", "description": "d", "input_schema": {}, "output_type": "text"}
async def execute(context):
    return {"content": "ok"}
'''
        errors = verify_tool_format(code)
        assert errors == []

    def test_missing_tool_dict(self):
        from tools.sandbox import verify_tool_format
        code = "async def execute(context): pass"
        errors = verify_tool_format(code)
        assert any("TOOL" in e for e in errors)

    def test_missing_execute(self):
        from tools.sandbox import verify_tool_format
        code = 'TOOL = {"name": "t", "description": "d", "input_schema": {}, "output_type": "text"}'
        errors = verify_tool_format(code)
        assert any("execute" in e for e in errors)

    def test_execute_wrong_signature(self):
        from tools.sandbox import verify_tool_format
        code = '''
TOOL = {"name": "t", "description": "d", "input_schema": {}, "output_type": "text"}
async def execute():
    pass
'''
        errors = verify_tool_format(code)
        assert any("context" in e.lower() or "parameter" in e.lower() for e in errors)


class TestExecuteInSandbox:
    """Test subprocess sandbox execution."""

    @pytest.mark.slow
    def test_simple_execution(self):
        from tools.sandbox import execute_in_sandbox
        code = '''
TOOL = {"name": "test", "description": "d", "input_schema": {}, "output_type": "text"}
async def execute(context):
    return {"content": "hello"}
'''
        result = execute_in_sandbox(code, {})
        assert result["content"] == "hello"

    @pytest.mark.slow
    def test_timeout(self):
        from tools.sandbox import execute_in_sandbox
        code = '''
TOOL = {"name": "test", "description": "d", "input_schema": {}, "output_type": "text"}
async def execute(context):
    import time
    time.sleep(10)
    return {"content": "late"}
'''
        with pytest.raises(RuntimeError, match="[Tt]imeout"):
            execute_in_sandbox(code, {}, timeout=2.0)

    @pytest.mark.slow
    def test_runtime_error_reported(self):
        from tools.sandbox import execute_in_sandbox
        code = '''
TOOL = {"name": "test", "description": "d", "input_schema": {}, "output_type": "text"}
async def execute(context):
    raise ValueError("bad input")
'''
        with pytest.raises(RuntimeError, match="bad input"):
            execute_in_sandbox(code, {})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && python -m pytest tests/test_tool_sandbox.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'tools.sandbox'`

- [ ] **Step 3: Implement sandbox.py**

Refactor from `server/plugins/sandbox.py` — keep the same AST visitor and subprocess pattern, adapt for `execute(context)`:

```python
# server/tools/sandbox.py
"""Security sandbox for AI-generated tools.

Two layers:
1. AST audit — reject forbidden imports/calls at parse time
2. Subprocess isolation — run code in separate process with timeout
"""

from __future__ import annotations

import ast
import json
import logging
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# ── Whitelist / Blacklist ──

ALLOWED_IMPORTS: set[str] = {
    # stdlib
    "math", "cmath", "itertools", "collections", "functools",
    "operator", "copy", "json", "re", "typing", "dataclasses",
    # science
    "numpy", "scipy", "pymatgen", "ase",
}

FORBIDDEN_MODULES: set[str] = {
    "os", "sys", "subprocess", "shutil", "socket", "http", "urllib",
    "requests", "pathlib", "io", "tempfile", "signal", "ctypes",
    "importlib", "pickle", "shelve", "multiprocessing", "threading",
    "asyncio", "webbrowser", "code", "codeop", "pty", "pipes",
}

FORBIDDEN_CALLS: set[str] = {
    "exec", "eval", "compile", "__import__", "open", "input",
    "breakpoint", "exit", "quit", "globals", "locals", "vars",
    "dir", "getattr", "setattr", "delattr",
}


# ── AST Audit ──

class _SecurityVisitor(ast.NodeVisitor):
    def __init__(self):
        self.violations: list[str] = []

    def _get_top_module(self, name: str) -> str:
        return name.split(".")[0]

    def _is_import_allowed(self, name: str) -> bool:
        top = self._get_top_module(name)
        if top in FORBIDDEN_MODULES:
            return False
        if top in ALLOWED_IMPORTS:
            return True
        # Allow submodules of allowed packages
        return any(name.startswith(a + ".") for a in ALLOWED_IMPORTS)

    def visit_Import(self, node: ast.Import):
        for alias in node.names:
            if not self._is_import_allowed(alias.name):
                self.violations.append(
                    f"Line {node.lineno}: Forbidden import '{alias.name}'"
                )
        self.generic_visit(node)

    def visit_ImportFrom(self, node: ast.ImportFrom):
        if node.module and not self._is_import_allowed(node.module):
            self.violations.append(
                f"Line {node.lineno}: Forbidden import from '{node.module}'"
            )
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call):
        if isinstance(node.func, ast.Name) and node.func.id in FORBIDDEN_CALLS:
            self.violations.append(
                f"Line {node.lineno}: Forbidden call '{node.func.id}()'"
            )
        self.generic_visit(node)

    def visit_Attribute(self, node: ast.Attribute):
        if node.attr.startswith("__") and node.attr.endswith("__"):
            if node.attr not in ("__init__", "__name__", "__doc__", "__class__"):
                self.violations.append(
                    f"Line {node.lineno}: Forbidden dunder access '{node.attr}'"
                )
        self.generic_visit(node)


def audit_code(source: str) -> list[str]:
    """Parse and audit source code. Returns list of violations (empty = passed)."""
    try:
        tree = ast.parse(source)
    except SyntaxError as e:
        return [f"Syntax error: {e}"]
    visitor = _SecurityVisitor()
    visitor.visit(tree)
    return visitor.violations


def verify_tool_format(source: str) -> list[str]:
    """Verify source has valid TOOL dict and execute(context) function."""
    errors: list[str] = []
    try:
        tree = ast.parse(source)
    except SyntaxError as e:
        return [f"Syntax error: {e}"]

    has_tool = False
    has_execute = False
    execute_has_context = False

    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id == "TOOL":
                    has_tool = True
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if node.name == "execute":
                has_execute = True
                args = node.args
                # Should have at least 1 parameter (context)
                if len(args.args) >= 1:
                    execute_has_context = True

    if not has_tool:
        errors.append("Missing TOOL dict assignment")
    if not has_execute:
        errors.append("Missing execute() function")
    elif not execute_has_context:
        errors.append("execute() must accept at least one parameter (context)")

    return errors


# ── Subprocess Sandbox ──

def _sandbox_env() -> dict[str, str]:
    """Minimal environment for sandbox subprocess."""
    env = {}
    # Inherit PATH for conda/venv Python
    if "PATH" in os.environ:
        env["PATH"] = os.environ["PATH"]
    # Windows needs these
    for key in ("SystemRoot", "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH"):
        if key in os.environ:
            env[key] = os.environ[key]
    # Conda
    for key in ("CONDA_PREFIX", "CONDA_DEFAULT_ENV", "VIRTUAL_ENV"):
        if key in os.environ:
            env[key] = os.environ[key]
    return env


_RUNNER_TEMPLATE = '''\
import asyncio
import json
import sys
import traceback

# Load tool code
_code = open({code_path!r}, encoding="utf-8").read()
_ns = {{}}
exec(_code, _ns)

_execute = _ns.get("execute")
_context = json.loads({context_json!r})

try:
    if asyncio.iscoroutinefunction(_execute):
        _result = asyncio.run(_execute(_context))
    else:
        _result = _execute(_context)
    print(json.dumps({{"ok": True, "result": _result}}))
except Exception as _e:
    print(json.dumps({{"ok": False, "error": str(_e), "traceback": traceback.format_exc()}}))
'''


def execute_in_sandbox(
    source: str,
    context: dict,
    timeout: float = 30.0,
) -> dict:
    """Execute tool code in an isolated subprocess.

    Args:
        source: Python source with TOOL dict + execute(context)
        context: Dict passed to execute()
        timeout: Max seconds before killing

    Returns:
        Dict returned by execute()

    Raises:
        RuntimeError: If execution fails, times out, or returns invalid JSON
    """
    tmp_dir = tempfile.mkdtemp(prefix="catgo_sandbox_")
    code_path = os.path.join(tmp_dir, "tool_code.py")
    runner_path = os.path.join(tmp_dir, "runner.py")

    try:
        with open(code_path, "w", encoding="utf-8") as f:
            f.write(source)

        context_json = json.dumps(context, default=str)
        runner_code = _RUNNER_TEMPLATE.format(
            code_path=code_path.replace("\\", "\\\\"),
            context_json=context_json,
        )
        with open(runner_path, "w", encoding="utf-8") as f:
            f.write(runner_code)

        proc = subprocess.run(
            [sys.executable, runner_path],
            capture_output=True,
            text=True,
            timeout=timeout,
            env=_sandbox_env(),
            cwd=tmp_dir,
        )

        if proc.returncode != 0:
            stderr = proc.stderr.strip()
            raise RuntimeError(f"Sandbox execution failed (exit {proc.returncode}): {stderr}")

        stdout = proc.stdout.strip()
        if not stdout:
            raise RuntimeError("Sandbox produced no output")

        try:
            data = json.loads(stdout)
        except json.JSONDecodeError:
            raise RuntimeError(f"Sandbox produced invalid JSON: {stdout[:200]}")

        if not data.get("ok"):
            error = data.get("error", "Unknown error")
            tb = data.get("traceback", "")
            raise RuntimeError(f"{error}\n{tb}" if tb else error)

        return data["result"]

    except subprocess.TimeoutExpired:
        raise RuntimeError(f"Timeout: execution exceeded {timeout}s")
    finally:
        import shutil
        shutil.rmtree(tmp_dir, ignore_errors=True)
```

- [ ] **Step 4: Run tests and verify they pass**

Run: `cd server && python -m pytest tests/test_tool_sandbox.py -v`
Expected: All tests PASS (skip `@slow` tests with `-m "not slow"` for fast iteration)

- [ ] **Step 5: Commit**

```bash
git add server/tools/sandbox.py server/tests/test_tool_sandbox.py
git commit -m "feat(tools): add sandbox module with AST audit and subprocess isolation"
```

---

## Chunk 2: Execution and Discovery

### Task 4: Executor Module

**Files:**
- Create: `server/tools/executor.py`
- Test: `server/tests/test_tool_executor.py`

The executor assembles `context` dicts per category, dispatches by trust level, and post-processes results (e.g., creating VaspData sessions for reader tools).

- [ ] **Step 1: Write failing tests**

```python
# server/tests/test_tool_executor.py
import pytest
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from tools.models import ToolEntry, ToolResult


class TestBuildContext:
    """Test context assembly from arguments + category."""

    def test_general_context(self):
        from tools.executor import build_context
        ctx = build_context("general", {"structure": {"lattice": {}}, "r_max": 5.0})
        assert "structure" in ctx
        assert ctx["params"]["r_max"] == 5.0

    def test_reader_context(self):
        from tools.executor import build_context
        ctx = build_context("reader", {"file_paths": ["/tmp/a.pdos"], "sigma": 0.1})
        assert ctx["file_paths"] == ["/tmp/a.pdos"]
        assert ctx["params"]["sigma"] == 0.1

    def test_general_without_structure(self):
        from tools.executor import build_context
        ctx = build_context("general", {"n_bins": 100})
        assert ctx["structure"] is None
        assert ctx["params"]["n_bins"] == 100


class TestExecuteTool:
    """Test execute_tool dispatch."""

    @pytest.mark.asyncio
    async def test_builtin_direct_call(self):
        from tools.executor import execute_tool

        async def my_execute(context):
            return {"content": f"got {context['params'].get('x', 0)}"}

        entry = ToolEntry(
            id="test", name="Test", description="d",
            trust="builtin", output_type="text",
            execute_fn=my_execute,
        )
        result = await execute_tool(entry, {"x": 42})
        assert result.data["content"] == "got 42"
        assert result.output_type == "text"
        assert result.error is None

    @pytest.mark.asyncio
    async def test_disabled_tool_returns_error(self):
        from tools.executor import execute_tool
        entry = ToolEntry(
            id="test", name="Test", description="d",
            enabled=False, execute_fn=lambda ctx: {},
        )
        result = await execute_tool(entry, {})
        assert result.error is not None
        assert "disabled" in result.error.lower()

    @pytest.mark.asyncio
    async def test_no_execute_fn_returns_error(self):
        from tools.executor import execute_tool
        entry = ToolEntry(id="test", name="Test", description="d", trust="builtin")
        result = await execute_tool(entry, {})
        assert result.error is not None
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server && python -m pytest tests/test_tool_executor.py -v`
Expected: FAIL

- [ ] **Step 3: Implement executor.py**

```python
# server/tools/executor.py
"""Unified tool execution — context assembly, trust dispatch, post-processing."""

from __future__ import annotations

import logging
from typing import Any, Optional

from .models import ToolEntry, ToolResult

logger = logging.getLogger(__name__)

# Known keys that are NOT params — extracted into context fields
_CONTEXT_KEYS = {"structure", "file_paths", "config"}


def build_context(category: str, arguments: dict) -> dict:
    """Assemble context dict from raw arguments based on category.

    IMPORTANT: Does NOT mutate arguments — makes a copy first.
    """
    args = dict(arguments) if arguments else {}
    structure = args.pop("structure", None)
    file_paths = args.pop("file_paths", None)
    config = args.pop("config", None)

    # Everything remaining is params
    params = args

    if category == "reader":
        return {"file_paths": file_paths or [], "params": params}
    elif category == "workflow_node":
        return {"structure": structure, "params": params, "config": config or {}}
    else:
        # general, calculator, optimizer
        return {"structure": structure, "params": params}


async def execute_tool(
    entry: ToolEntry,
    arguments: dict,
    *,
    injected_structure: Optional[dict] = None,
) -> ToolResult:
    """Execute a tool and return the result.

    Args:
        entry: The tool to execute
        arguments: Raw arguments from MCP/REST (not mutated)
        injected_structure: Auto-injected structure from viewer (if available)
    """
    if not entry.enabled:
        return ToolResult(
            data={}, output_type=entry.output_type, tool_id=entry.id,
            error=f"Tool '{entry.id}' is disabled",
        )

    if not entry.execute_fn:
        return ToolResult(
            data={}, output_type=entry.output_type, tool_id=entry.id,
            error=f"Tool '{entry.id}' has no execute function",
        )

    # Auto-inject structure if not provided (copy to avoid mutating caller's dict)
    args = dict(arguments)
    if injected_structure and "structure" not in args:
        args["structure"] = injected_structure

    context = build_context(entry.category, args)

    try:
        if entry.trust == "sandboxed":
            result_data = await _execute_sandboxed(entry, context)
        else:
            # builtin and user: direct call
            import asyncio
            if asyncio.iscoroutinefunction(entry.execute_fn):
                result_data = await entry.execute_fn(context)
            else:
                result_data = entry.execute_fn(context)

        if not isinstance(result_data, dict):
            result_data = {"content": str(result_data)}

        # Post-process by output_type
        result = ToolResult(
            data=result_data,
            output_type=entry.output_type,
            tool_id=entry.id,
        )
        await _post_process(result, entry)
        return result

    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        logger.error("Tool %s execution failed: %s", entry.id, e)
        return ToolResult(
            data={}, output_type=entry.output_type, tool_id=entry.id,
            error=str(e), traceback=tb,
        )


async def _post_process(result: ToolResult, entry: ToolEntry) -> None:
    """Post-process result based on output_type.

    - electronic_dos/bands/cohp: create VaspData session, inject session_id
    - structure: auto-push to 3D viewer
    - atom_property: push property data to viewer
    """
    if result.error:
        return

    otype = result.output_type

    if otype in ("electronic_dos", "electronic_bands", "cohp"):
        try:
            # Create VaspData session (same as routers/plugins.py _create_dos_session_from_reader)
            from dos_analysis import create_session_from_dict
            session_id = create_session_from_dict(result.data, otype)
            result.session_id = session_id
            # Keep summary data but strip heavy arrays for the response
            result.data = {
                "session_id": session_id,
                "output_type": otype,
                "nions": result.data.get("nions", len(result.data.get("elements", []))),
                "elements": result.data.get("elements", []),
            }
        except ImportError:
            logger.warning("dos_analysis not available, skipping session creation")
        except Exception as e:
            logger.error("Failed to create %s session: %s", otype, e)

    elif otype == "structure":
        try:
            import httpx
            async with httpx.AsyncClient(timeout=5) as client:
                await client.post(
                    "http://localhost:8000/api/view/structure/push",
                    json=result.data,
                )
        except Exception as e:
            logger.warning("Failed to push structure to viewer: %s", e)

    elif otype == "atom_property":
        try:
            import httpx
            async with httpx.AsyncClient(timeout=5) as client:
                await client.post(
                    "http://localhost:8000/api/view/atom-property/push",
                    json=result.data,
                )
        except Exception as e:
            logger.warning("Failed to push atom_property to viewer: %s", e)


async def _execute_sandboxed(entry: ToolEntry, context: dict) -> dict:
    """Execute sandboxed tool via subprocess."""
    if not entry.path:
        raise RuntimeError("Sandboxed tool has no source path")

    source_path = entry.path / "tool.py"
    if not source_path.exists():
        raise RuntimeError(f"Tool source not found: {source_path}")

    source = source_path.read_text(encoding="utf-8")

    from .sandbox import execute_in_sandbox
    return execute_in_sandbox(source, context)
```

- [ ] **Step 4: Run tests**

Run: `cd server && python -m pytest tests/test_tool_executor.py -v`
Expected: PASS

Note: `pytest-asyncio` is needed for async tests. Install if missing: `pip install pytest-asyncio`

- [ ] **Step 5: Commit**

```bash
git add server/tools/executor.py server/tests/test_tool_executor.py
git commit -m "feat(tools): add executor with context assembly and trust dispatch"
```

---

### Task 5: Discovery Module

**Files:**
- Create: `server/tools/discovery.py`
- Test: `server/tests/test_tool_discovery.py`

- [ ] **Step 1: Write failing tests**

```python
# server/tests/test_tool_discovery.py
import pytest
import sys, os, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


class TestLoadToolFromPath:
    """Test loading a single tool from a directory."""

    def test_load_minimal_tool(self, tmp_path):
        from tools.discovery import load_tool_from_path
        tool_dir = tmp_path / "my_tool"
        tool_dir.mkdir()
        (tool_dir / "tool.py").write_text('''
TOOL = {
    "name": "my_tool",
    "description": "A test tool",
    "input_schema": {"type": "object", "properties": {}},
    "output_type": "text",
}
async def execute(context):
    return {"content": "hello"}
''', encoding="utf-8")
        entry = load_tool_from_path(tool_dir)
        assert entry.id == "my_tool"
        assert entry.output_type == "text"
        assert entry.execute_fn is not None

    def test_load_with_manifest(self, tmp_path):
        from tools.discovery import load_tool_from_path
        tool_dir = tmp_path / "fancy"
        tool_dir.mkdir()
        (tool_dir / "tool.py").write_text('''
TOOL = {"name": "fancy", "description": "x", "input_schema": {}, "output_type": "text"}
async def execute(context):
    return {"content": "ok"}
''', encoding="utf-8")
        (tool_dir / "catgo-tool.json").write_text(json.dumps({
            "name": "fancy",
            "version": "2.0.0",
            "displayName": "Fancy Tool",
            "trust": "user",
        }), encoding="utf-8")
        entry = load_tool_from_path(tool_dir)
        assert entry.version == "2.0.0"
        assert entry.name == "Fancy Tool"
        assert entry.trust == "user"

    def test_load_calculator_tool(self, tmp_path):
        from tools.discovery import load_tool_from_path
        tool_dir = tmp_path / "calc"
        tool_dir.mkdir()
        (tool_dir / "tool.py").write_text('''
TOOL = {
    "name": "my_calc",
    "description": "A calculator",
    "category": "calculator",
    "supported_elements": ["Ar"],
    "input_schema": {},
}
def get_calculator(**params):
    return "fake_calc"
''', encoding="utf-8")
        entry = load_tool_from_path(tool_dir)
        assert entry.category == "calculator"
        assert "get_calculator" in entry.extra_fns

    def test_missing_tool_py_raises(self, tmp_path):
        from tools.discovery import load_tool_from_path, ToolLoadError
        tool_dir = tmp_path / "empty"
        tool_dir.mkdir()
        with pytest.raises(ToolLoadError):
            load_tool_from_path(tool_dir)


class TestDiscoverTools:
    """Test scanning directories for tools."""

    def test_discover_from_directory(self, tmp_path):
        from tools.discovery import discover_tools
        # Create two tools
        for name in ("tool_a", "tool_b"):
            d = tmp_path / name
            d.mkdir()
            (d / "tool.py").write_text(f'''
TOOL = {{"name": "{name}", "description": "d", "input_schema": {{}}, "output_type": "text"}}
async def execute(context):
    return {{"content": "ok"}}
''', encoding="utf-8")
        entries, errors = discover_tools([tmp_path])
        assert len(entries) == 2
        assert len(errors) == 0

    def test_skips_pycache(self, tmp_path):
        from tools.discovery import discover_tools
        (tmp_path / "__pycache__").mkdir()
        entries, errors = discover_tools([tmp_path])
        assert len(entries) == 0
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server && python -m pytest tests/test_tool_discovery.py -v`
Expected: FAIL

- [ ] **Step 3: Implement discovery.py**

```python
# server/tools/discovery.py
"""Tool discovery — scan directories and load TOOL dicts."""

from __future__ import annotations

import importlib.util
import json
import logging
from pathlib import Path
from typing import Optional

from .models import ToolEntry

logger = logging.getLogger(__name__)


class ToolLoadError(Exception):
    pass


def load_tool_from_path(tool_dir: Path, default_trust: str = "sandboxed") -> ToolEntry:
    """Load a tool from a directory containing tool.py (+ optional catgo-tool.json).

    Raises ToolLoadError if the directory is not a valid tool.
    """
    tool_py = tool_dir / "tool.py"
    # Legacy fallback
    if not tool_py.exists():
        tool_py = tool_dir / "plugin.py"
    if not tool_py.exists():
        raise ToolLoadError(f"No tool.py found in {tool_dir}")

    # Load module
    module = _load_module(tool_py)

    # Extract TOOL dict
    tool_dict = getattr(module, "TOOL", None)
    if not tool_dict or not isinstance(tool_dict, dict):
        raise ToolLoadError(f"No TOOL dict found in {tool_py}")

    # Extract functions
    execute_fn = getattr(module, "execute", None)
    extra_fns = {}
    for fn_name in ("get_calculator", "get_optimizer", "detect_files", "priority_score", "on_load", "on_unload"):
        fn = getattr(module, fn_name, None)
        if fn:
            extra_fns[fn_name] = fn

    # Load optional manifest (overrides TOOL dict)
    manifest = _load_manifest(tool_dir)

    # Build ToolEntry
    tool_id = tool_dict.get("name", tool_dir.name)
    entry = ToolEntry(
        id=tool_id,
        name=_get(manifest, "displayName", tool_dict.get("display_name", tool_id)),
        description=tool_dict.get("description", ""),
        version=_get(manifest, "version", tool_dict.get("version", "1.0.0")),
        author=_get(manifest, "author", tool_dict.get("author", "")),
        category=tool_dict.get("category", "general"),
        input_schema=tool_dict.get("input_schema", {}),
        output_type=tool_dict.get("output_type", "text"),
        trust=_get(manifest, "trust", default_trust),
        permissions=_get(manifest, "permissions", []),
        source="directory",
        path=tool_dir,
        execute_fn=execute_fn,
        extra_fns=extra_fns,
        frontend=_get(manifest, "frontend", tool_dict.get("frontend")),
        supported_elements=tool_dict.get("supported_elements"),
        supported_formats=tool_dict.get("supported_formats"),
        multi_file=tool_dict.get("multi_file", False),
        node_definition=tool_dict.get("node_definition"),
        supports_cell_optimization=tool_dict.get("supports_cell_optimization", False),
        on_load_fn=extra_fns.get("on_load"),
        on_unload_fn=extra_fns.get("on_unload"),
    )
    return entry


def discover_tools(
    dirs: list[Path],
    default_trust: str = "sandboxed",
) -> tuple[list[ToolEntry], list[tuple[Path, str]]]:
    """Scan directories for tools.

    Returns (entries, errors) where errors is [(path, error_msg)].
    """
    entries: list[ToolEntry] = []
    errors: list[tuple[Path, str]] = []

    for base_dir in dirs:
        if not base_dir.exists():
            continue
        for item in sorted(base_dir.iterdir()):
            if not item.is_dir():
                continue
            if item.name.startswith((".", "__")):
                continue
            try:
                entry = load_tool_from_path(item, default_trust=default_trust)
                entries.append(entry)
                logger.info("Discovered tool: %s at %s", entry.id, item)
            except Exception as e:
                errors.append((item, str(e)))
                logger.warning("Failed to load tool from %s: %s", item, e)

    return entries, errors


def _load_module(path: Path):
    """Import a Python module from file path."""
    spec = importlib.util.spec_from_file_location(path.stem, path)
    if not spec or not spec.loader:
        raise ToolLoadError(f"Cannot create module spec for {path}")
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except Exception as e:
        raise ToolLoadError(f"Failed to load {path}: {e}") from e
    return module


def _load_manifest(tool_dir: Path) -> Optional[dict]:
    """Load catgo-tool.json or catgo-plugin.json manifest."""
    for name in ("catgo-tool.json", "catgo-plugin.json"):
        p = tool_dir / name
        if p.exists():
            try:
                return json.loads(p.read_text(encoding="utf-8"))
            except Exception:
                logger.warning("Failed to parse %s", p)
    return None


def _get(manifest: Optional[dict], key: str, default):
    """Get value from manifest, falling back to default."""
    if manifest is None:
        return default
    return manifest.get(key, default)
```

- [ ] **Step 4: Run tests**

Run: `cd server && python -m pytest tests/test_tool_discovery.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/tools/discovery.py server/tests/test_tool_discovery.py
git commit -m "feat(tools): add discovery module to scan directories and load TOOL dicts"
```

---

### Task 6: Builder Module (AI Tool Lifecycle)

**Files:**
- Create: `server/tools/builder.py`
- Test: `server/tests/test_tool_builder.py`

- [ ] **Step 1: Write failing tests**

```python
# server/tests/test_tool_builder.py
import pytest
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


VALID_TOOL_CODE = '''
TOOL = {
    "name": "test_add",
    "description": "Add two numbers",
    "input_schema": {"type": "object", "properties": {"a": {"type": "number"}, "b": {"type": "number"}}},
    "output_type": "text",
}
async def execute(context):
    params = context.get("params", {})
    return {"content": str(params.get("a", 0) + params.get("b", 0))}
'''


class TestCreateFromCode:
    """Test AI tool creation from source code."""

    @pytest.mark.slow
    @pytest.mark.asyncio
    async def test_create_and_execute(self):
        from tools.builder import create_from_code
        result, ephemeral_id = await create_from_code(
            VALID_TOOL_CODE,
            test_input={"a": 3, "b": 4},
        )
        assert result.error is None
        assert result.data["content"] == "7"
        assert ephemeral_id is not None

    @pytest.mark.asyncio
    async def test_audit_failure(self):
        from tools.builder import create_from_code
        bad_code = '''
import os
TOOL = {"name": "bad", "description": "d", "input_schema": {}, "output_type": "text"}
async def execute(context):
    os.system("rm -rf /")
'''
        with pytest.raises(ValueError, match="[Aa]udit"):
            await create_from_code(bad_code)


class TestSaveTool:
    """Test persisting ephemeral tools to disk."""

    @pytest.mark.slow
    @pytest.mark.asyncio
    async def test_save_and_load(self, tmp_path):
        from tools.builder import create_from_code, save_tool
        result, eph_id = await create_from_code(VALID_TOOL_CODE, test_input={"a": 1, "b": 2})
        entry = save_tool(eph_id, tools_dir=tmp_path)
        assert entry.id == "test_add"
        assert (tmp_path / "test_add" / "tool.py").exists()

    @pytest.mark.asyncio
    async def test_save_nonexistent_raises(self):
        from tools.builder import save_tool
        with pytest.raises(KeyError):
            save_tool("nonexistent_id")


class TestUpgradeTrust:
    """Test trust level upgrade."""

    @pytest.mark.slow
    @pytest.mark.asyncio
    async def test_upgrade_sandboxed_to_user(self, tmp_path):
        from tools.builder import create_from_code, save_tool, upgrade_trust
        _, eph_id = await create_from_code(VALID_TOOL_CODE, test_input={"a": 1, "b": 2})
        entry = save_tool(eph_id, tools_dir=tmp_path)
        assert entry.trust == "sandboxed"
        upgrade_trust(entry.id, "user", tools_dir=tmp_path)
        # Re-read manifest to verify
        import json
        manifest = json.loads((tmp_path / "test_add" / "catgo-tool.json").read_text())
        assert manifest["trust"] == "user"
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server && python -m pytest tests/test_tool_builder.py -v -m "not slow"`
Expected: FAIL

- [ ] **Step 3: Implement builder.py**

```python
# server/tools/builder.py
"""AI tool lifecycle — create, save, upgrade, delete."""

from __future__ import annotations

import json
import logging
import uuid
from pathlib import Path
from typing import Optional

from .models import ToolEntry, ToolResult
from .sandbox import audit_code, verify_tool_format, execute_in_sandbox

logger = logging.getLogger(__name__)

# Session-scoped ephemeral store: ephemeral_id -> (code, TOOL dict, ToolResult)
_ephemeral_store: dict[str, tuple[str, dict, ToolResult]] = {}


async def create_from_code(
    code: str,
    test_input: Optional[dict] = None,
    injected_structure: Optional[dict] = None,
) -> tuple[ToolResult, str]:
    """Create, audit, test, and execute a tool from source code.

    Returns (result, ephemeral_id).
    Raises ValueError if audit or format check fails.
    """
    # Step 1: Audit
    violations = audit_code(code)
    if violations:
        raise ValueError(f"Audit failed:\n" + "\n".join(violations))

    # Step 2: Verify format
    format_errors = verify_tool_format(code)
    if format_errors:
        raise ValueError(f"Format check failed:\n" + "\n".join(format_errors))

    # Step 3: Extract TOOL dict (lightweight exec)
    tool_dict = _extract_tool_dict(code)

    # Step 4: Build context
    context = {"params": test_input or {}}
    if injected_structure:
        context["structure"] = injected_structure

    # Step 5: Execute in sandbox
    try:
        result_data = execute_in_sandbox(code, context)
    except RuntimeError as e:
        return ToolResult(
            data={}, output_type=tool_dict.get("output_type", "text"),
            tool_id=tool_dict.get("name", "unknown"),
            error=str(e),
        ), None  # None signals save is not possible

    result = ToolResult(
        data=result_data,
        output_type=tool_dict.get("output_type", "text"),
        tool_id=tool_dict.get("name", "unknown"),
    )

    # Step 6: Store ephemerally
    ephemeral_id = str(uuid.uuid4())[:8]
    _ephemeral_store[ephemeral_id] = (code, tool_dict, result)

    return result, ephemeral_id


def save_tool(
    ephemeral_id: str,
    save_as: Optional[str] = None,
    tools_dir: Optional[Path] = None,
) -> ToolEntry:
    """Persist an ephemeral tool to disk.

    Args:
        ephemeral_id: ID returned by create_from_code
        save_as: Override tool ID (defaults to TOOL["name"])
        tools_dir: Directory to save to (defaults to ~/.catgo/tools/)
    """
    if ephemeral_id not in _ephemeral_store:
        raise KeyError(f"Ephemeral tool not found: {ephemeral_id}")

    code, tool_dict, _ = _ephemeral_store.pop(ephemeral_id)
    tool_id = save_as or tool_dict.get("name", ephemeral_id)

    if tools_dir is None:
        tools_dir = Path.home() / ".catgo" / "tools"
    tools_dir.mkdir(parents=True, exist_ok=True)

    tool_dir = tools_dir / tool_id
    tool_dir.mkdir(exist_ok=True)

    # Write tool.py
    (tool_dir / "tool.py").write_text(code, encoding="utf-8")

    # Write manifest
    manifest = {
        "name": tool_id,
        "version": tool_dict.get("version", "1.0.0"),
        "displayName": tool_dict.get("display_name", tool_id),
        "description": tool_dict.get("description", ""),
        "trust": "sandboxed",
    }
    (tool_dir / "catgo-tool.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    # Load as ToolEntry
    from .discovery import load_tool_from_path
    return load_tool_from_path(tool_dir, default_trust="sandboxed")


def upgrade_trust(
    tool_id: str,
    trust: str,
    tools_dir: Optional[Path] = None,
) -> None:
    """Upgrade a saved tool's trust level by updating its manifest."""
    if trust not in ("user",):
        raise ValueError(f"Cannot upgrade to trust level: {trust}")

    if tools_dir is None:
        tools_dir = Path.home() / ".catgo" / "tools"

    manifest_path = tools_dir / tool_id / "catgo-tool.json"
    if not manifest_path.exists():
        raise FileNotFoundError(f"Tool manifest not found: {manifest_path}")

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["trust"] = trust
    manifest_path.write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    logger.info("Upgraded tool %s to trust=%s", tool_id, trust)


def delete_tool(
    tool_id: str,
    tools_dir: Optional[Path] = None,
) -> bool:
    """Delete a saved tool from disk."""
    if tools_dir is None:
        tools_dir = Path.home() / ".catgo" / "tools"

    tool_dir = tools_dir / tool_id
    if not tool_dir.exists():
        return False

    import shutil
    shutil.rmtree(tool_dir)
    logger.info("Deleted tool %s", tool_id)
    return True


def list_ephemeral() -> list[str]:
    """List ephemeral tool IDs in the current session."""
    return list(_ephemeral_store.keys())


def _extract_tool_dict(code: str) -> dict:
    """Extract TOOL dict from source without full execution."""
    ns: dict = {}
    # Only exec assignments, not function defs
    import ast
    tree = ast.parse(code)
    assign_code = compile(
        ast.Module(
            body=[n for n in tree.body if isinstance(n, ast.Assign)],
            type_ignores=[],
        ),
        "<tool>",
        "exec",
    )
    exec(assign_code, ns)
    return ns.get("TOOL", {})
```

- [ ] **Step 4: Run tests**

Run: `cd server && python -m pytest tests/test_tool_builder.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/tools/builder.py server/tests/test_tool_builder.py
git commit -m "feat(tools): add builder module for AI tool create/save/upgrade lifecycle"
```

---

## Chunk 3: API Layer

### Task 7: REST API Endpoints

**Files:**
- Create: `server/routers/tools.py`
- Test: `server/tests/test_tool_api.py`

- [ ] **Step 1: Write failing tests**

```python
# server/tests/test_tool_api.py
import pytest
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from starlette.testclient import TestClient


@pytest.fixture(scope="module")
def tool_client():
    """Create test client with tools router only."""
    from fastapi import FastAPI
    from routers.tools import router
    from tools import registry
    from tools.models import ToolEntry

    app = FastAPI()
    app.include_router(router, prefix="/api")

    # Register a test tool
    async def fake_execute(context):
        return {"content": "result"}

    registry.register(ToolEntry(
        id="test_tool", name="Test Tool", description="A test",
        trust="builtin", output_type="text",
        execute_fn=fake_execute,
    ))

    return TestClient(app)


class TestToolsAPI:
    """Test REST API endpoints for tools."""

    def test_list_tools(self, tool_client):
        resp = tool_client.get("/api/tools")
        assert resp.status_code == 200
        data = resp.json()
        assert any(t["id"] == "test_tool" for t in data)

    def test_get_tool(self, tool_client):
        resp = tool_client.get("/api/tools/test_tool")
        assert resp.status_code == 200
        assert resp.json()["id"] == "test_tool"

    def test_get_tool_not_found(self, tool_client):
        resp = tool_client.get("/api/tools/nonexistent")
        assert resp.status_code == 404

    def test_run_tool(self, tool_client):
        resp = tool_client.post("/api/tools/test_tool/run", json={"x": 1})
        assert resp.status_code == 200
        assert resp.json()["data"]["content"] == "result"

    def test_enable_disable(self, tool_client):
        resp = tool_client.post("/api/tools/test_tool/disable")
        assert resp.status_code == 200
        resp = tool_client.post("/api/tools/test_tool/enable")
        assert resp.status_code == 200
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server && python -m pytest tests/test_tool_api.py -v`
Expected: FAIL

- [ ] **Step 3: Implement routers/tools.py**

```python
# server/routers/tools.py
"""REST API for the unified tool system."""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, UploadFile, File
from pydantic import BaseModel
from typing import Any, Optional

from tools import registry
from tools.executor import execute_tool
from tools.models import ToolResult

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/tools", tags=["tools"])


# ── List / Get ──

@router.get("/")
async def list_tools(category: Optional[str] = None):
    """List all registered tools."""
    if category:
        tools = registry.list_by_category(category)
    else:
        tools = registry.list_all()
    return [t.to_dict() for t in tools]


@router.get("/calculators")
async def list_calculators():
    return [t.to_dict() for t in registry.list_by_category("calculator")]


@router.get("/readers")
async def list_readers():
    return [t.to_dict() for t in registry.list_by_category("reader")]


@router.get("/{tool_id}")
async def get_tool(tool_id: str):
    tool = registry.get(tool_id)
    if not tool:
        raise HTTPException(status_code=404, detail=f"Tool not found: {tool_id}")
    return tool.to_dict()


# ── Execute ──

@router.post("/{tool_id}/run")
async def run_tool(tool_id: str, arguments: dict = {}):
    """Execute a tool and return the result."""
    tool = registry.get(tool_id)
    if not tool:
        raise HTTPException(status_code=404, detail=f"Tool not found: {tool_id}")

    # Auto-inject structure from viewer (internal call, not HTTP to self)
    injected = _get_current_structure()

    result = await execute_tool(tool, arguments, injected_structure=injected)
    return {
        "data": result.data,
        "output_type": result.output_type,
        "tool_id": result.tool_id,
        "error": result.error,
        "session_id": result.session_id,
    }


def _get_current_structure():
    """Get current structure from the view state store (internal, no HTTP)."""
    try:
        from routers.view import get_current_structure
        return get_current_structure()
    except Exception:
        return None


# ── Enable / Disable ──

@router.post("/{tool_id}/enable")
async def enable_tool(tool_id: str):
    tool = registry.get(tool_id)
    if not tool:
        raise HTTPException(status_code=404, detail=f"Tool not found: {tool_id}")
    registry.enable(tool_id)
    return {"status": "enabled", "tool_id": tool_id}


@router.post("/{tool_id}/disable")
async def disable_tool(tool_id: str):
    tool = registry.get(tool_id)
    if not tool:
        raise HTTPException(status_code=404, detail=f"Tool not found: {tool_id}")
    registry.disable(tool_id)
    return {"status": "disabled", "tool_id": tool_id}


# ── AI Create / Save / Upgrade / Delete ──

class CreateToolRequest(BaseModel):
    code: str
    test_input: Optional[dict] = None


@router.post("/create")
async def create_tool(req: CreateToolRequest):
    """AI generate + audit + sandbox test + execute."""
    from tools.builder import create_from_code

    injected = _get_current_structure()

    try:
        result, ephemeral_id = await create_from_code(
            req.code,
            test_input=req.test_input,
            injected_structure=injected,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    return {
        "data": result.data,
        "output_type": result.output_type,
        "tool_id": result.tool_id,
        "error": result.error,
        "ephemeral_id": ephemeral_id,
    }


class SaveToolRequest(BaseModel):
    ephemeral_id: str
    save_as: Optional[str] = None


@router.post("/{tool_id}/save")
async def save_tool_endpoint(tool_id: str, req: SaveToolRequest):
    from tools.builder import save_tool
    try:
        entry = save_tool(req.ephemeral_id, save_as=req.save_as)
        # Register in registry
        registry.register(entry)
        return {"status": "saved", "tool": entry.to_dict()}
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))


class UpgradeToolRequest(BaseModel):
    trust: str = "user"


@router.post("/{tool_id}/upgrade")
async def upgrade_tool_endpoint(tool_id: str, req: UpgradeToolRequest):
    from tools.builder import upgrade_trust
    try:
        upgrade_trust(tool_id, req.trust)
        # Update in-memory entry
        tool = registry.get(tool_id)
        if tool:
            tool.trust = req.trust
        return {"status": "upgraded", "tool_id": tool_id, "trust": req.trust}
    except (ValueError, FileNotFoundError) as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/{tool_id}")
async def delete_tool_endpoint(tool_id: str):
    from tools.builder import delete_tool
    registry.unregister(tool_id)
    deleted = delete_tool(tool_id)
    return {"status": "deleted" if deleted else "not_found", "tool_id": tool_id}


@router.post("/discover")
async def discover_tools_endpoint():
    """Re-scan tool directories and register new tools."""
    from tools.discovery import discover_tools
    from pathlib import Path

    dirs = []
    project_plugins = Path(__file__).resolve().parent.parent.parent / "plugins"
    if project_plugins.exists():
        dirs.append(project_plugins)
    user_tools = Path.home() / ".catgo" / "tools"
    if user_tools.exists():
        dirs.append(user_tools)

    entries, errors = discover_tools(dirs)
    for entry in entries:
        registry.register(entry)

    return {
        "discovered": len(entries),
        "errors": [{"path": str(p), "error": e} for p, e in errors],
    }
```

- [ ] **Step 4: Run tests**

Run: `cd server && python -m pytest tests/test_tool_api.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/routers/tools.py server/tests/test_tool_api.py
git commit -m "feat(tools): add REST API endpoints for tool CRUD and execution"
```

---

### Task 8: MCP Integration

**Files:**
- Modify: `server/mcp_tools/server.py`
- No separate test file — existing `test_mcp_tools.py` covers tool list validation

- [ ] **Step 1: Add registry tools to MCP list_tools**

In `server/mcp_tools/server.py` (lines ~100-118, `handle_list_tools`):

```python
# After existing TOOLS list assembly, before returning:
# Add tools from ToolRegistry
from tools import registry as tool_registry
for entry in tool_registry.list_all():
    if entry.enabled:
        all_tools.append(Tool(
            name=f"catgo_ext_{entry.id}",
            description=entry.description,
            inputSchema=entry.input_schema or {"type": "object", "properties": {}},
        ))

# Add lifecycle tools
all_tools.extend([
    Tool(name="catgo_create_tool", description="Create and execute a tool from Python code", inputSchema={
        "type": "object",
        "properties": {
            "code": {"type": "string", "description": "Python source with TOOL dict + async def execute(context)"},
            "test_input": {"type": "object", "description": "Test parameters"},
        },
        "required": ["code"],
    }),
    Tool(name="catgo_save_tool", description="Save a recently created tool permanently", inputSchema={
        "type": "object",
        "properties": {
            "ephemeral_id": {"type": "string", "description": "ID returned by catgo_create_tool"},
            "save_as": {"type": "string", "description": "Override tool ID"},
        },
        "required": ["ephemeral_id"],
    }),
    Tool(name="catgo_upgrade_tool", description="Upgrade a saved tool's trust level", inputSchema={
        "type": "object",
        "properties": {
            "tool_id": {"type": "string"},
            "trust": {"type": "string", "enum": ["user"]},
        },
        "required": ["tool_id"],
    }),
    Tool(name="catgo_delete_tool", description="Delete a saved tool", inputSchema={
        "type": "object",
        "properties": {"tool_id": {"type": "string"}},
        "required": ["tool_id"],
    }),
    Tool(name="catgo_list_tools", description="List all registered tools", inputSchema={
        "type": "object", "properties": {},
    }),
])
```

- [ ] **Step 2: Add registry dispatch to MCP call_tool**

In `server/mcp_tools/server.py` (around line ~1180-1200, `handle_call_tool`):

```python
# After existing tool dispatch, before "tool not found" error:

# Tool lifecycle MCP tools
if name == "catgo_create_tool":
    from tools.builder import create_from_code
    try:
        result, eph_id = await create_from_code(
            arguments["code"],
            test_input=arguments.get("test_input"),
            injected_structure=auto_structure,
        )
        text = json.dumps({"ephemeral_id": eph_id, "data": result.data, "error": result.error})
        return [TextContent(type="text", text=text)]
    except ValueError as e:
        return [TextContent(type="text", text=json.dumps({"error": str(e)}))]

if name == "catgo_save_tool":
    from tools.builder import save_tool
    from tools import registry as tool_registry
    try:
        entry = save_tool(arguments["ephemeral_id"], save_as=arguments.get("save_as"))
        tool_registry.register(entry)
        return [TextContent(type="text", text=f"Saved tool '{entry.id}' to ~/.catgo/tools/{entry.id}/")]
    except KeyError as e:
        return [TextContent(type="text", text=f"Error: {e}")]

if name == "catgo_upgrade_tool":
    from tools.builder import upgrade_trust
    from tools import registry as tool_registry
    try:
        upgrade_trust(arguments["tool_id"], arguments.get("trust", "user"))
        tool = tool_registry.get(arguments["tool_id"])
        if tool:
            tool.trust = arguments.get("trust", "user")
        return [TextContent(type="text", text=f"Upgraded '{arguments['tool_id']}' to trust={arguments.get('trust', 'user')}")]
    except Exception as e:
        return [TextContent(type="text", text=f"Error: {e}")]

if name == "catgo_delete_tool":
    from tools.builder import delete_tool
    from tools import registry as tool_registry
    tool_registry.unregister(arguments["tool_id"])
    delete_tool(arguments["tool_id"])
    return [TextContent(type="text", text=f"Deleted tool '{arguments['tool_id']}'")]

if name == "catgo_list_tools":
    from tools import registry as tool_registry
    tools = [t.to_dict() for t in tool_registry.list_all()]
    return [TextContent(type="text", text=json.dumps(tools, indent=2))]

# Registry tool dispatch (catgo_ext_*)
if name.startswith("catgo_ext_"):
    tool_id = name[len("catgo_ext_"):]
    from tools import registry as tool_registry
    from tools.executor import execute_tool
    entry = tool_registry.get(tool_id)
    if entry:
        result = await execute_tool(entry, arguments, injected_structure=auto_structure)
        if result.error:
            return [TextContent(type="text", text=f"Error: {result.error}")]
        return [TextContent(type="text", text=json.dumps(result.data))]
```

- [ ] **Step 3: Run existing MCP tests to verify no breakage**

Run: `cd server && python -m pytest tests/test_mcp_tools.py -v`
Expected: PASS (existing tests still work)

- [ ] **Step 4: Commit**

```bash
git add server/mcp_tools/server.py
git commit -m "feat(tools): integrate ToolRegistry into MCP list_tools and call_tool"
```

---

### Task 9: Server Startup Wiring

**Files:**
- Modify: `server/main.py:84-88`
- Modify: `server/main.py:172-209` (router registration)

- [ ] **Step 1: Add registry initialization to lifespan**

In `server/main.py`, modify the `lifespan` function (around line 84):

```python
# Add after plugin_manager.initialize():
from tools import registry as tool_registry
from tools.discovery import discover_tools
from pathlib import Path

# Discover tools from plugins/ and ~/.catgo/tools/
dirs = []
project_plugins = Path(__file__).resolve().parent.parent / "plugins"
if project_plugins.exists():
    dirs.append(project_plugins)
user_tools = Path.home() / ".catgo" / "tools"
if user_tools.exists():
    dirs.append(user_tools)

entries, errors = discover_tools(dirs, default_trust="user")
for entry in entries:
    tool_registry.register(entry)

logger.info("Tool registry: %d tools loaded, %d errors", len(entries), len(errors))
```

- [ ] **Step 2: Register tools router**

In `server/main.py`, in the router registration section (around line 172):

```python
from routers.tools import router as tools_router
app.include_router(tools_router, prefix="/api")
```

- [ ] **Step 3: Test server starts**

Run: `cd server && python -c "from main import app; print('OK')"`
Expected: "OK" without errors

- [ ] **Step 4: Commit**

```bash
git add server/main.py
git commit -m "feat(tools): wire ToolRegistry discovery and REST router into server startup"
```

---

## Chunk 4: Frontend Integration

### Task 10: ToolResultRenderer Component

**Files:**
- Create: `src/lib/chat/ToolResultRenderer.svelte`

- [ ] **Step 1: Create the component**

```svelte
<!-- src/lib/chat/ToolResultRenderer.svelte -->
<script lang="ts">
    import type { Snippet } from 'svelte'

    interface ToolResultData {
        data: Record<string, unknown>
        output_type: string
        tool_id: string
        error?: string
        traceback?: string
        session_id?: string
    }

    let { result }: { result: ToolResultData } = $props()

    // Lazy imports for heavy components
    let ScatterPlot: any = $state(null)
    let BarPlot: any = $state(null)
    let DosPlot: any = $state(null)

    $effect(() => {
        if (result.output_type === `scatter_plot` && !ScatterPlot) {
            import(`$lib/plot/ScatterPlot.svelte`).then(m => ScatterPlot = m.default)
        }
        if (result.output_type === `bar_plot` && !BarPlot) {
            import(`$lib/plot/BarPlot.svelte`).then(m => BarPlot = m.default)
        }
        if (result.output_type === `electronic_dos` && !DosPlot) {
            import(`$lib/dos/DosPlot.svelte`).then(m => DosPlot = m.default).catch(() => {})
        }
    })
</script>

{#if result.error}
    <div class="tool-result-error">
        <strong>Error:</strong> {result.error}
        {#if result.traceback}
            <pre class="traceback">{result.traceback}</pre>
        {/if}
    </div>
{:else if result.output_type === `scatter_plot` && ScatterPlot}
    <div class="tool-result-plot">
        <svelte:component this={ScatterPlot} data={result.data} />
    </div>
{:else if result.output_type === `bar_plot` && BarPlot}
    <div class="tool-result-plot">
        <svelte:component this={BarPlot} data={result.data} />
    </div>
{:else if result.output_type === `table`}
    <div class="tool-result-table">
        <table>
            <thead>
                <tr>
                    {#each (result.data.columns || []) as col}
                        <th>{col.label || col.key}</th>
                    {/each}
                </tr>
            </thead>
            <tbody>
                {#each (result.data.rows || []) as row}
                    <tr>
                        {#each (result.data.columns || []) as col}
                            <td>{row[col.key]}</td>
                        {/each}
                    </tr>
                {/each}
            </tbody>
        </table>
    </div>
{:else if result.output_type === `text`}
    <div class="tool-result-text">
        {result.data.content || JSON.stringify(result.data)}
    </div>
{:else if result.output_type === `image`}
    <div class="tool-result-image">
        <img src={`data:${result.data.mime || `image/png`};base64,${result.data.data}`} alt="Tool output" />
    </div>
{:else if result.output_type === `electronic_dos` && result.session_id && DosPlot}
    <div class="tool-result-plot">
        <svelte:component this={DosPlot} sessionId={result.session_id} />
    </div>
{:else}
    <div class="tool-result-raw">
        <pre>{JSON.stringify(result.data, null, 2)}</pre>
    </div>
{/if}

<style>
    .tool-result-error {
        padding: 8px 12px;
        background: var(--error-bg, #fee);
        border: 1px solid var(--error-border, #fcc);
        border-radius: 6px;
        font-size: 13px;
    }
    .traceback {
        font-size: 11px;
        max-height: 200px;
        overflow-y: auto;
        margin-top: 8px;
        opacity: 0.7;
    }
    .tool-result-plot {
        width: 100%;
        max-width: 600px;
        margin: 8px 0;
    }
    .tool-result-table table {
        width: 100%;
        border-collapse: collapse;
        font-size: 13px;
    }
    .tool-result-table th,
    .tool-result-table td {
        padding: 4px 8px;
        border: 1px solid var(--border-color, #ddd);
        text-align: left;
    }
    .tool-result-text {
        white-space: pre-wrap;
        font-size: 13px;
    }
    .tool-result-image img {
        max-width: 100%;
        border-radius: 4px;
    }
    .tool-result-raw pre {
        font-size: 11px;
        max-height: 300px;
        overflow-y: auto;
        background: var(--code-bg, #f5f5f5);
        padding: 8px;
        border-radius: 4px;
    }
</style>
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/chat/ToolResultRenderer.svelte
git commit -m "feat(tools): add ToolResultRenderer component for auto-rendering by output_type"
```

---

### Task 11: Chat Integration

**Files:**
- Modify: `src/lib/chat/ChatPane.svelte:1180-1187` (tool badges → ToolResultRenderer)
- Modify: `src/lib/chat/types.ts:31-35` (extend ToolResultBlock)

- [ ] **Step 1: Extend ToolResultBlock type**

In `src/lib/chat/types.ts`, update the `ToolResultBlock` interface:

```typescript
export interface ToolResultBlock {
    type: `tool_result`
    tool_use_id: string
    content: string | ToolResultData
}

export interface ToolResultData {
    data: Record<string, unknown>
    output_type: string
    tool_id: string
    error?: string
    traceback?: string
    session_id?: string
}
```

- [ ] **Step 2: Add ToolResultRenderer to ChatPane**

In `src/lib/chat/ChatPane.svelte`, import the component and add rendering after tool badges:

```svelte
<script>
    import ToolResultRenderer from './ToolResultRenderer.svelte'
</script>

<!-- After the existing tool-badges div (line ~1187), add: -->
{#if tool_results?.length > 0}
    {#each tool_results as tr}
        {#if typeof tr.content === 'object' && tr.content.output_type}
            <ToolResultRenderer result={tr.content} />
        {/if}
    {/each}
{/if}
```

The exact integration point will depend on how `tool_results` are extracted from the message content blocks. Look at how `tool_uses` are already extracted (around line 1177) and follow the same pattern for result blocks.

- [ ] **Step 3: Test visually**

Run: `pnpm dev` and test by sending a message that triggers a tool with structured output.

- [ ] **Step 4: Commit**

```bash
git add src/lib/chat/ChatPane.svelte src/lib/chat/types.ts src/lib/chat/ToolResultRenderer.svelte
git commit -m "feat(tools): integrate ToolResultRenderer into chat message rendering"
```

---

## Chunk 5: Migration and Cleanup

### Task 12: Migrate Existing Plugins to Tool Format

**Files:**
- Rewrite: `plugins/bond-histogram/tool.py` (was `plugin.py`)
- Rewrite: `plugins/cp2k-dos-reader/tool.py` (was `plugin.py`)
- Rewrite: `plugins/lennard-jones-calculator/tool.py` (was `plugin.py`)
- Rewrite: `plugins/lammps-workflow/tool.py` (was `plugin.py`)

- [ ] **Step 1: Migrate bond-histogram**

Read the existing `plugins/bond-histogram/plugin.py`, rewrite as `tool.py`:

```python
# plugins/bond-histogram/tool.py
"""Bond length distribution histogram."""

TOOL = {
    "name": "bond_histogram",
    "display_name": "Bond Length Histogram",
    "description": "Compute and display bond length distribution",
    "input_schema": {
        "type": "object",
        "properties": {
            "n_bins": {"type": "integer", "default": 30, "description": "Number of histogram bins"},
            "max_distance": {"type": "number", "default": 4.0, "description": "Maximum distance in Angstrom"},
        },
    },
    "output_type": "bar_plot",
    "version": "1.0.0",
    "author": "CatGo Team",
}


async def execute(context):
    import numpy as np
    from pymatgen.core import Structure

    structure = context["structure"]
    params = context.get("params", {})
    n_bins = params.get("n_bins", 30)
    max_distance = params.get("max_distance", 4.0)

    struct = Structure.from_dict(structure) if isinstance(structure, dict) else structure

    distances = []
    for i in range(len(struct)):
        neighbors = struct.get_neighbors(struct[i], max_distance)
        distances.extend([n.nn_distance for n in neighbors])

    if not distances:
        return {"series": [], "x_axis": {"label": "Distance (Angstrom)"}, "y_axis": {"label": "Count"}}

    counts, edges = np.histogram(distances, bins=n_bins, range=(0, max_distance))
    centers = ((edges[:-1] + edges[1:]) / 2).tolist()

    return {
        "series": [{"x": centers, "y": counts.tolist(), "label": "Bond lengths"}],
        "x_axis": {"label": "Distance (Angstrom)"},
        "y_axis": {"label": "Count"},
    }
```

- [ ] **Step 2: Migrate remaining 3 plugins**

Follow the same pattern for cp2k-dos-reader, lennard-jones-calculator, and lammps-workflow. Read each existing `plugin.py`, rewrite as `tool.py` following the TOOL dict + execute(context) convention.

For each plugin:
1. Read the existing `plugin.py`
2. Extract the logic from the class methods
3. Write as `TOOL` dict + standalone functions
4. Update `catgo-plugin.json` → `catgo-tool.json` (or keep both for compat)

- [ ] **Step 3: Run discovery test to verify new format loads**

Run: `cd server && python -c "
from tools.discovery import discover_tools
from pathlib import Path
entries, errors = discover_tools([Path('../plugins')])
print(f'{len(entries)} tools loaded, {len(errors)} errors')
for e in entries:
    print(f'  {e.id} ({e.category})')
for p, err in errors:
    print(f'  ERROR {p}: {err}')
"`
Expected: 4 tools loaded, 0 errors

- [ ] **Step 4: Commit**

```bash
git add plugins/
git commit -m "refactor(plugins): migrate all 4 plugins to Tool-First format"
```

---

### Task 12b: Migrate Builtin Readers

**Files:**
- Create: `server/tools/builtin/__init__.py`
- Create: `server/tools/builtin/vasp_readers.py`

The 4 builtin readers in `server/plugins/builtin_readers.py` (`VaspoutH5Reader`, `ProcarReader`, `VasprunBandReader`, `CohpcarReader`) must be migrated to the new TOOL dict format and registered as `trust: "builtin"` tools.

- [ ] **Step 1: Read existing builtin_readers.py and rewrite as tool format**

Create `server/tools/builtin/vasp_readers.py` with 4 TOOL dicts + execute functions, one per reader. Follow the same pattern as the cp2k-dos-reader migration but keep them as builtin (trust="builtin").

Each reader becomes a separate TOOL dict exported in a list:

```python
# server/tools/builtin/__init__.py
"""Built-in tools that ship with CatGo server."""

def get_builtin_tool_modules():
    """Return list of modules containing TOOL dicts."""
    from . import vasp_readers
    return [vasp_readers]
```

- [ ] **Step 2: Update discovery to load builtins**

In `server/tools/discovery.py`, add a function to load builtin tools:

```python
def discover_builtin_tools() -> list[ToolEntry]:
    """Load built-in tools from server/tools/builtin/."""
    entries = []
    try:
        from .builtin import get_builtin_tool_modules
        for module in get_builtin_tool_modules():
            # Each module can export multiple tools via TOOLS list or single TOOL
            tools_list = getattr(module, "TOOLS", [])
            if not tools_list:
                tool = getattr(module, "TOOL", None)
                if tool:
                    tools_list = [tool]
            for tool_dict in tools_list:
                # Load execute fn from module
                fn_name = f"execute_{tool_dict['name']}"
                execute_fn = getattr(module, fn_name, getattr(module, "execute", None))
                entries.append(ToolEntry(
                    id=tool_dict["name"],
                    name=tool_dict.get("display_name", tool_dict["name"]),
                    description=tool_dict.get("description", ""),
                    category="reader",
                    output_type=tool_dict.get("output_type", "electronic_dos"),
                    trust="builtin",
                    source="code",
                    execute_fn=execute_fn,
                    supported_formats=tool_dict.get("supported_formats", []),
                    multi_file=tool_dict.get("multi_file", False),
                    extra_fns={
                        k: getattr(module, f"{k}_{tool_dict['name']}", None)
                        for k in ("detect_files", "priority_score")
                        if getattr(module, f"{k}_{tool_dict['name']}", None)
                    },
                ))
    except ImportError:
        pass
    return entries
```

- [ ] **Step 3: Wire into server startup (main.py)**

Add after directory discovery in the lifespan function:

```python
from tools.discovery import discover_builtin_tools
for entry in discover_builtin_tools():
    tool_registry.register(entry)
```

- [ ] **Step 4: Commit**

```bash
git add server/tools/builtin/
git commit -m "feat(tools): migrate builtin VASP readers to tool format"
```

---

### Task 13: Compatibility Layer

**Files:**
- Create: `server/tools/compat.py`

- [ ] **Step 1: Implement compat.py**

Follow the spec's compatibility layer design for loading legacy `BasePlugin` subclasses and old MCP hot-reload format. This allows any unmigrated third-party plugins to still work.

```python
# server/tools/compat.py
"""Backward compatibility for legacy plugin formats."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Optional

from .models import ToolEntry

logger = logging.getLogger(__name__)


def load_legacy_plugin(path: Path) -> Optional[ToolEntry]:
    """Try to load a legacy BasePlugin-style plugin and convert to ToolEntry.

    Returns None if the directory does not contain a legacy plugin.
    """
    plugin_py = path / "plugin.py"
    if not plugin_py.exists():
        return None

    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location("legacy_plugin", plugin_py)
        if not spec or not spec.loader:
            return None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    except Exception as e:
        logger.warning("Failed to load legacy plugin %s: %s", path, e)
        return None

    # Check if it has old-style BasePlugin classes
    plugin_class = None
    try:
        from plugins.base import BasePlugin, CalculatorPlugin, OptimizerPlugin, ReaderPlugin, AnalyzerPlugin, WorkflowNodePlugin
        for attr_name in dir(module):
            attr = getattr(module, attr_name)
            if isinstance(attr, type) and issubclass(attr, BasePlugin) and attr is not BasePlugin:
                plugin_class = attr
                break
    except ImportError:
        return None

    if not plugin_class:
        return None

    plugin = plugin_class()

    # Detect category
    category_map = {}
    try:
        from plugins.base import CalculatorPlugin, OptimizerPlugin, ReaderPlugin, AnalyzerPlugin, WorkflowNodePlugin
        category_map = {
            CalculatorPlugin: "calculator",
            OptimizerPlugin: "optimizer",
            ReaderPlugin: "reader",
            AnalyzerPlugin: "general",
            WorkflowNodePlugin: "workflow_node",
        }
    except ImportError:
        pass

    category = "general"
    for base_cls, cat in category_map.items():
        if isinstance(plugin, base_cls):
            category = cat
            break

    # Extract extra functions
    extra_fns = {}
    for fn_name in ("get_calculator", "get_optimizer", "detect_files", "priority_score"):
        fn = getattr(plugin, fn_name, None)
        if fn:
            extra_fns[fn_name] = fn

    # Wrap execute method
    execute_fn = None
    for method_name in ("analyze", "read", "execute"):
        method = getattr(plugin, method_name, None)
        if method:
            execute_fn = _wrap_legacy_method(method, category)
            break

    return ToolEntry(
        id=getattr(plugin, "analyzer_id", None) or getattr(plugin, "reader_id", None)
           or getattr(plugin, "calculator_id", None) or plugin.name,
        name=getattr(plugin, "display_name", plugin.name),
        description=getattr(plugin, "description", ""),
        version=getattr(plugin, "version", "1.0.0"),
        author=getattr(plugin, "author", ""),
        category=category,
        input_schema=getattr(plugin, "input_schema", {}),
        output_type=getattr(plugin, "output_type", "text"),
        trust="user",
        source="directory",
        path=path,
        execute_fn=execute_fn,
        extra_fns=extra_fns,
        supported_elements=getattr(plugin, "supported_elements", None),
        supported_formats=getattr(plugin, "supported_formats", None),
        multi_file=getattr(plugin, "multi_file", False),
        node_definition=getattr(plugin, "node_definition", None),
        supports_cell_optimization=getattr(plugin, "supports_cell_optimization", False),
        on_load_fn=getattr(plugin, "on_load", None),
        on_unload_fn=getattr(plugin, "on_unload", None),
    )


def _wrap_legacy_method(method, category):
    """Wrap old-style plugin method to new execute(context) signature."""
    async def wrapped(context):
        if category == "reader":
            return await method(context["file_paths"], context.get("params", {}))
        elif category == "workflow_node":
            return await method(
                json.dumps(context.get("structure", {})),
                context.get("params", {}),
                context.get("config", {}),
            )
        else:
            input_data = {"structure": context.get("structure"), **context.get("params", {})}
            return await method(input_data)
    return wrapped
```

- [ ] **Step 2: Integrate into discovery fallback**

In `server/tools/discovery.py`, add a fallback to `load_tool_from_path`:

```python
# After TOOL dict not found, before raising ToolLoadError:
from .compat import load_legacy_plugin
legacy = load_legacy_plugin(tool_dir)
if legacy:
    return legacy
```

- [ ] **Step 3: Commit**

```bash
git add server/tools/compat.py server/tools/discovery.py
git commit -m "feat(tools): add compatibility layer for legacy BasePlugin format"
```

---

### Task 14: Update CLAUDE.md and Cleanup

**Files:**
- Modify: `CLAUDE.md` (update plugin system docs)

- [ ] **Step 1: Update CLAUDE.md Extension/Plugin Architecture section**

Replace the outdated plugin system documentation with the new Tool-First architecture description. Key sections to update:

- Change "Extension/Plugin Architecture" to describe the unified tool system
- Document the `TOOL` dict + `execute(context)` convention
- Document the three trust levels
- Document how CatBot creates tools via `catgo_create_tool`
- Update file paths (server/tools/ instead of server/plugins/)

- [ ] **Step 2: Update memory MEMORY.md**

Update the Extension/Plugin Architecture section to reflect the new system.

- [ ] **Step 3: Final commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md with Tool-First architecture"
```

---

## Execution Notes

### Test Commands Summary

```bash
# All tool tests
cd server && python -m pytest tests/test_tool_*.py -v

# Fast tests only (skip sandbox subprocess tests)
cd server && python -m pytest tests/test_tool_*.py -v -m "not slow"

# Single file
cd server && python -m pytest tests/test_tool_registry.py -v

# Frontend type check
pnpm check
```

### Dependencies to Install

```bash
pip install pytest-asyncio  # For async test support
```

Add to `server/pyproject.toml` or `server/pytest.ini` (create if missing):

```ini
# server/pytest.ini
[pytest]
asyncio_mode = auto
markers =
    slow: marks tests as slow (deselect with '-m "not slow"')
    integration: marks integration tests
```

### Parallelization Opportunities

Tasks that can run in parallel (for subagent-driven development):

| Group | Tasks | Why parallel |
|---|---|---|
| 1 | Task 1 | Foundation — no dependencies |
| 2 | Task 2, Task 3 | Both depend only on Task 1 (models) |
| 3 | Task 4, Task 5 | Task 4 needs registry+sandbox, Task 5 needs models only |
| 4 | Task 6, Task 7, Task 8 | All depend on registry+executor but not each other |
| 5 | Task 9, Task 10, Task 11 | Server wiring + frontend work |
| 6 | Task 12, Task 13, Task 14 | Migration + cleanup |

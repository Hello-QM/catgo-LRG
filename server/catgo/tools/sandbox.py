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
    "glob", "fnmatch", "inspect", "platform", "compileall", "zipimport",
}

FORBIDDEN_CALLS: set[str] = {
    "exec", "eval", "compile", "__import__", "open", "input",
    "breakpoint", "exit", "quit", "globals", "locals", "vars",
    "dir", "getattr", "setattr", "delattr",
}

_ALLOWED_DUNDERS: set[str] = {
    "__init__", "__name__", "__doc__", "__class__", "__len__",
    "__str__", "__repr__", "__iter__", "__next__",
    "__getitem__", "__setitem__", "__contains__",
    "__eq__", "__ne__", "__lt__", "__gt__", "__le__", "__ge__",
    "__hash__", "__bool__", "__int__", "__float__",
    "__add__", "__sub__", "__mul__", "__truediv__", "__floordiv__",
    "__mod__", "__pow__", "__neg__", "__abs__",
    "__enter__", "__exit__",
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
        elif isinstance(node.func, ast.Attribute) and node.func.attr in FORBIDDEN_CALLS:
            self.violations.append(
                f"Line {node.lineno}: Forbidden call '.{node.func.attr}()'"
            )
        self.generic_visit(node)

    def visit_Attribute(self, node: ast.Attribute):
        if node.attr.startswith("__") and node.attr.endswith("__"):
            if node.attr not in _ALLOWED_DUNDERS:
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
    # Construct minimal PATH: only the Python executable's directory
    python_dir = str(Path(sys.executable).parent)
    conda_prefix = os.environ.get("CONDA_PREFIX")
    if conda_prefix:
        # Conda envs may have Scripts/bin in a separate dir
        conda_bin = str(Path(conda_prefix) / ("Scripts" if sys.platform == "win32" else "bin"))
        env["PATH"] = os.pathsep.join({python_dir, conda_bin})
    else:
        env["PATH"] = python_dir
    # Windows needs these for basic operation (but NOT USERPROFILE/HOME)
    for key in ("SystemRoot", "TEMP", "TMP"):
        if key in os.environ:
            env[key] = os.environ[key]
    # Conda / venv activation
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
    _result_json = json.dumps({{"ok": True, "result": _result}})
    if sys.getsizeof(_result_json) > 10_000_000:  # 10MB limit
        _result_json = json.dumps({{"ok": False, "error": "Output too large (>10MB)"}})
    print(_result_json)
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

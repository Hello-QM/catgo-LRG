"""
Sandbox execution for AI-generated tool plugins.

Provides two layers of protection:
1. AST-based security audit — rejects code with forbidden imports/calls
2. Subprocess isolation — runs code in a separate process with timeout

The sandbox is NOT a security boundary against a determined attacker.
It prevents accidental damage from AI-generated code (file I/O, network,
system calls) while allowing computational chemistry libraries.
"""

import ast
import json
import logging
import subprocess
import sys
import tempfile
import textwrap
from pathlib import Path

logger = logging.getLogger(__name__)

# ─── Allowed imports whitelist ───
# Only computational/scientific libraries + stdlib math/data utilities
ALLOWED_IMPORTS: set[str] = {
    # stdlib
    "math",
    "cmath",
    "itertools",
    "collections",
    "functools",
    "operator",
    "copy",
    "json",
    "re",
    "typing",
    # scientific computing
    "numpy",
    "scipy",
    "scipy.spatial",
    "scipy.linalg",
    "scipy.optimize",
    "scipy.interpolate",
    # materials science
    "pymatgen",
    "pymatgen.core",
    "pymatgen.core.structure",
    "pymatgen.core.lattice",
    "pymatgen.core.sites",
    "pymatgen.core.periodic_table",
    "pymatgen.analysis",
    "pymatgen.analysis.local_env",
    "pymatgen.analysis.structure_analyzer",
    "pymatgen.symmetry",
    "pymatgen.transformations",
    "ase",
    "ase.atoms",
    "ase.neighborlist",
    "ase.geometry",
    "ase.build",
    "ase.data",
}

# Forbidden built-in function names (called as functions)
FORBIDDEN_CALLS: set[str] = {
    "exec",
    "eval",
    "compile",
    "__import__",
    "open",
    "input",
    "breakpoint",
    "exit",
    "quit",
    "globals",
    "locals",
    "vars",
    "dir",
    "getattr",
    "setattr",
    "delattr",
}

# Forbidden module names (any import of these is rejected)
FORBIDDEN_MODULES: set[str] = {
    "os",
    "sys",
    "subprocess",
    "shutil",
    "socket",
    "http",
    "urllib",
    "requests",
    "pathlib",
    "io",
    "tempfile",
    "signal",
    "ctypes",
    "importlib",
    "pickle",
    "shelve",
    "multiprocessing",
    "threading",
    "asyncio",
    "webbrowser",
    "code",
    "codeop",
    "compileall",
    "builtins",
}


def _get_top_module(module_name: str) -> str:
    """Extract top-level module from a dotted name."""
    return module_name.split(".")[0]


def _is_import_allowed(module_name: str) -> bool:
    """Check if a module import is allowed."""
    top = _get_top_module(module_name)

    # Explicitly forbidden
    if top in FORBIDDEN_MODULES:
        return False

    # Check exact match or prefix match against whitelist
    if module_name in ALLOWED_IMPORTS:
        return True

    # Allow sub-modules of whitelisted top-level packages
    for allowed in ALLOWED_IMPORTS:
        top_allowed = _get_top_module(allowed)
        if top == top_allowed:
            return True

    return False


class _SecurityVisitor(ast.NodeVisitor):
    """AST visitor that collects security violations."""

    def __init__(self):
        self.violations: list[str] = []

    def visit_Import(self, node: ast.Import):
        for alias in node.names:
            if not _is_import_allowed(alias.name):
                self.violations.append(
                    f"Forbidden import: '{alias.name}' (line {node.lineno})"
                )
        self.generic_visit(node)

    def visit_ImportFrom(self, node: ast.ImportFrom):
        module = node.module or ""
        if not _is_import_allowed(module):
            self.violations.append(
                f"Forbidden import: 'from {module}' (line {node.lineno})"
            )
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call):
        # Check for forbidden function calls: exec(), eval(), open(), etc.
        func_name = None
        if isinstance(node.func, ast.Name):
            func_name = node.func.id
        elif isinstance(node.func, ast.Attribute):
            func_name = node.func.attr

        if func_name in FORBIDDEN_CALLS:
            self.violations.append(
                f"Forbidden call: '{func_name}()' (line {node.lineno})"
            )

        self.generic_visit(node)

    def visit_Attribute(self, node: ast.Attribute):
        # Block dunder attribute access (e.g., obj.__class__, obj.__subclasses__)
        if node.attr.startswith("__") and node.attr.endswith("__"):
            # Allow __init__ and __name__ which are common in class definitions
            if node.attr not in ("__init__", "__name__", "__doc__", "__class__"):
                self.violations.append(
                    f"Forbidden dunder access: '{node.attr}' (line {node.lineno})"
                )
        self.generic_visit(node)


def audit_code(source: str) -> list[str]:
    """AST-based security audit of tool source code.

    Args:
        source: Python source code string

    Returns:
        List of violation descriptions. Empty list means code passed audit.
    """
    try:
        tree = ast.parse(source)
    except SyntaxError as e:
        return [f"Syntax error: {e}"]

    visitor = _SecurityVisitor()
    visitor.visit(tree)
    return visitor.violations


def execute_in_sandbox(
    source: str,
    func_name: str,
    kwargs: dict,
    timeout: float = 30.0,
) -> dict:
    """Run a tool function in a subprocess sandbox.

    Writes the source + invocation to a temp file, runs it in a subprocess
    with restricted environment, parses JSON result from stdout.

    Args:
        source: Python source code containing the function
        func_name: Name of the function to call
        kwargs: Arguments to pass as JSON
        timeout: Maximum execution time in seconds

    Returns:
        Result dict parsed from stdout JSON

    Raises:
        RuntimeError: If execution fails, times out, or produces invalid output
    """
    # Build the runner script
    runner = textwrap.dedent(f"""\
        import json
        import sys

        # Execute the tool source
        exec(compile(open(sys.argv[1]).read(), sys.argv[1], "exec"))

        # Call the function with kwargs
        kwargs = json.loads(sys.argv[2])
        result = {func_name}(**kwargs)

        # Output result as JSON
        print(json.dumps(result))
    """)

    # Write source and runner to temp files
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".py", delete=False, encoding="utf-8"
    ) as src_f:
        src_f.write(source)
        src_path = src_f.name

    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".py", delete=False, encoding="utf-8"
    ) as run_f:
        run_f.write(runner)
        runner_path = run_f.name

    kwargs_json = json.dumps(kwargs)

    try:
        result = subprocess.run(
            [sys.executable, runner_path, src_path, kwargs_json],
            capture_output=True,
            text=True,
            timeout=timeout,
            env=_sandbox_env(),
        )

        if result.returncode != 0:
            stderr = result.stderr.strip()
            # Extract the last meaningful error line
            err_lines = [l for l in stderr.splitlines() if l.strip()]
            short_err = err_lines[-1] if err_lines else "Unknown error"
            raise RuntimeError(
                f"Tool execution failed (exit {result.returncode}): {short_err}"
            )

        stdout = result.stdout.strip()
        if not stdout:
            raise RuntimeError("Tool produced no output")

        # Parse JSON from the last line (in case of print statements)
        last_line = stdout.splitlines()[-1]
        try:
            return json.loads(last_line)
        except json.JSONDecodeError as e:
            raise RuntimeError(f"Tool output is not valid JSON: {e}\nOutput: {stdout[:500]}")

    except subprocess.TimeoutExpired:
        raise RuntimeError(f"Tool execution timed out after {timeout}s")
    finally:
        # Clean up temp files
        try:
            Path(src_path).unlink(missing_ok=True)
            Path(runner_path).unlink(missing_ok=True)
        except Exception:
            pass


def _sandbox_env() -> dict[str, str]:
    """Build a restricted environment for subprocess execution."""
    import os

    # Start with minimal env — inherit PATH for python/conda to work
    env = {
        "PATH": os.environ.get("PATH", ""),
        "PYTHONPATH": "",  # Don't inherit parent's PYTHONPATH
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONIOENCODING": "utf-8",
    }

    # Windows needs SystemRoot and TEMP
    if sys.platform == "win32":
        env["SystemRoot"] = os.environ.get("SystemRoot", r"C:\Windows")
        env["TEMP"] = os.environ.get("TEMP", "")
        env["TMP"] = os.environ.get("TMP", "")

    # Conda environment support
    for key in ("CONDA_PREFIX", "CONDA_DEFAULT_ENV", "VIRTUAL_ENV"):
        if key in os.environ:
            env[key] = os.environ[key]

    return env

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

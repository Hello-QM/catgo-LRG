# server/tests/test_tool_executor.py
import pytest
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from catgo.tools.models import ToolEntry, ToolResult


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

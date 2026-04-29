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

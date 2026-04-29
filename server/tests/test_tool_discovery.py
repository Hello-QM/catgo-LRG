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

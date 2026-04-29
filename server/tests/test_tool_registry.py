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

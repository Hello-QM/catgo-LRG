"""Tests for MCP tool definitions (validation, uniqueness, naming).

Ensures the aggregated TOOLS list exported by mcp_tools.tools conforms to
the MCP protocol: every tool has a name, description, and valid inputSchema.
Also validates coverage across tool categories.
"""

import sys
from pathlib import Path

import pytest

# Ensure server/ is importable
_server_dir = str(Path(__file__).resolve().parent.parent)
if _server_dir not in sys.path:
    sys.path.insert(0, _server_dir)


def _get_tools():
    """Import and return the TOOLS list, skipping if deps are missing."""
    try:
        from catgo.mcp_tools.tools import TOOLS
        return TOOLS
    except ImportError as e:
        pytest.skip(f"Cannot import mcp_tools.tools: {e}")


class TestMCPToolDefinitions:
    """Validate the aggregated MCP tool list for protocol compliance."""

    def test_tools_is_nonempty_list(self):
        """TOOLS should be a non-empty list of dicts."""
        tools = _get_tools()
        assert isinstance(tools, list)
        assert len(tools) > 0

    def test_all_tools_have_required_fields(self):
        """Every tool must have 'name', 'description', and 'inputSchema' keys."""
        tools = _get_tools()
        for i, tool in enumerate(tools):
            assert "name" in tool, f"Tool at index {i} missing 'name'"
            assert "description" in tool, f"Tool '{tool.get('name', i)}' missing 'description'"
            assert "inputSchema" in tool, f"Tool '{tool.get('name', i)}' missing 'inputSchema'"

    def test_tool_names_are_unique(self):
        """No two tools should share the same name."""
        tools = _get_tools()
        names = [t["name"] for t in tools]
        duplicates = [n for n in names if names.count(n) > 1]
        assert len(duplicates) == 0, f"Duplicate tool names: {set(duplicates)}"

    def test_all_tool_names_start_with_catgo(self):
        """All tool names must use the 'catgo_' namespace prefix."""
        tools = _get_tools()
        for tool in tools:
            assert tool["name"].startswith("catgo_"), (
                f"Tool '{tool['name']}' does not start with 'catgo_'"
            )

    def test_tool_count_is_reasonable(self):
        """There should be at least 50 tools registered."""
        tools = _get_tools()
        # Should have a substantial number of tools (at least 50)
        assert len(tools) >= 50, f"Only {len(tools)} tools found, expected >= 50"

    def test_input_schemas_are_valid(self):
        """Every inputSchema must be a dict with type='object'."""
        tools = _get_tools()
        for tool in tools:
            schema = tool["inputSchema"]
            assert isinstance(schema, dict), f"Tool '{tool['name']}' inputSchema is not a dict"
            assert schema.get("type") == "object", (
                f"Tool '{tool['name']}' inputSchema type is '{schema.get('type')}', expected 'object'"
            )

    def test_descriptions_are_nonempty(self):
        """Every tool description must be a non-empty string."""
        tools = _get_tools()
        for tool in tools:
            desc = tool["description"]
            assert isinstance(desc, str) and len(desc.strip()) > 0, (
                f"Tool '{tool['name']}' has empty description"
            )

    def test_all_tool_categories_represented(self):
        """Tool names should cover all major categories: structure, build, analysis, view, optimization."""
        tools = _get_tools()
        names = {t["name"] for t in tools}

        # Each category should have at least one tool whose name contains the keyword
        categories = {
            "structure": ["structure", "atom", "supercell", "slab"],
            "build": ["build", "defect", "strain", "doping"],
            "analysis": ["analy", "symmetry", "dos", "band"],
            "view": ["screenshot", "selection"],
            "optimization": ["optim", "relax", "calculator"],
        }
        for category, keywords in categories.items():
            found = any(
                any(kw in name for kw in keywords)
                for name in names
            )
            assert found, (
                f"No tools found for category '{category}' "
                f"(looked for keywords {keywords} in {len(names)} tool names)"
            )

    def test_input_schema_properties_have_descriptions(self):
        """inputSchema properties should include 'description' fields for documentation.

        Warns (does not fail) for tools missing property descriptions, but fails
        if more than half of tools with properties are missing descriptions entirely.
        """
        tools = _get_tools()
        tools_missing_all_descs = []

        for tool in tools:
            schema = tool["inputSchema"]
            properties = schema.get("properties", {})
            if not properties:
                continue  # No properties to check

            props_with_desc = sum(
                1 for p in properties.values()
                if isinstance(p, dict) and p.get("description")
            )
            if props_with_desc == 0 and len(properties) > 0:
                tools_missing_all_descs.append(tool["name"])

        # Allow some tools to lack descriptions, but not a majority
        tools_with_props = sum(
            1 for t in tools
            if t["inputSchema"].get("properties")
        )
        if tools_with_props > 0:
            ratio = len(tools_missing_all_descs) / tools_with_props
            assert ratio < 0.5, (
                f"{len(tools_missing_all_descs)}/{tools_with_props} tools with properties "
                f"have zero property descriptions: {tools_missing_all_descs[:10]}..."
            )

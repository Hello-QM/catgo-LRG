"""Tests for the Claude Code consolidated MCP server.

Validates tool definitions, action routing, and schema compliance.
"""

import sys
from pathlib import Path

import pytest

_server_dir = str(Path(__file__).resolve().parent.parent)
if _server_dir not in sys.path:
    sys.path.insert(0, _server_dir)


def _get_tools():
    """Import the TOOLS list from server_claude_code."""
    try:
        from catgo.mcp_tools.server_claude_code import TOOLS
        return TOOLS
    except ImportError as e:
        pytest.skip(f"Cannot import server_claude_code: {e}")


class TestClaudeCodeToolDefinitions:
    """Validate the 11 consolidated tools."""

    def test_tool_count(self):
        tools = _get_tools()
        assert len(tools) == 11, f"Expected 11 tools, got {len(tools)}"

    def test_tool_names(self):
        tools = _get_tools()
        names = {t.name for t in tools}
        expected = {
            "catgo_structure", "catgo_fetch", "catgo_workflow", "catgo_analyze",
            "catgo_view", "catgo_catalysis", "catgo_system", "catgo_workflow_engine",
            "catgo_file", "catgo_diagnose", "catgo_skills",
        }
        assert names == expected, f"Tool names mismatch: {names}"

    def test_all_tools_have_action_enum(self):
        tools = _get_tools()
        # catgo_diagnose uses task_id instead of action
        tools_with_action = [t for t in tools if t.name != "catgo_diagnose"]
        for tool in tools_with_action:
            schema = tool.inputSchema
            assert "action" in schema["properties"], f"{tool.name} missing 'action' property"
            assert "enum" in schema["properties"]["action"], f"{tool.name} action missing enum"

    def test_all_tools_require_action(self):
        tools = _get_tools()
        # catgo_diagnose requires task_id, not action
        tools_with_action = [t for t in tools if t.name != "catgo_diagnose"]
        for tool in tools_with_action:
            assert "action" in tool.inputSchema.get("required", []), (
                f"{tool.name} does not require 'action'"
            )

    def test_diagnose_requires_task_id(self):
        tools = _get_tools()
        diagnose_tool = next(t for t in tools if t.name == "catgo_diagnose")
        assert "task_id" in diagnose_tool.inputSchema.get("required", [])

    def test_descriptions_are_concise(self):
        """Descriptions should be under 300 chars for token efficiency.

        catgo_workflow has a long description with building guide, which is expected.
        """
        tools = _get_tools()
        # Workflow, workflow_engine, and skills have intentionally long descriptions
        exempt = {"catgo_workflow", "catgo_workflow_engine", "catgo_skills",
                  "catgo_structure", "catgo_catalysis"}
        for tool in tools:
            if tool.name in exempt:
                continue
            assert len(tool.description) < 300, (
                f"{tool.name} description is {len(tool.description)} chars (max 300)"
            )

    def test_structure_actions_complete(self):
        tools = _get_tools()
        struct_tool = next(t for t in tools if t.name == "catgo_structure")
        actions = struct_tool.inputSchema["properties"]["action"]["enum"]
        expected = [
            "get", "add_atom", "add_atoms", "delete", "replace",
            "move", "supercell", "set_lattice", "slab", "doping",
            "merge", "add_molecule", "load_file",
        ]
        assert actions == expected

    def test_fetch_actions_complete(self):
        tools = _get_tools()
        fetch_tool = next(t for t in tools if t.name == "catgo_fetch")
        actions = fetch_tool.inputSchema["properties"]["action"]["enum"]
        assert set(actions) == {"crystal", "search", "molecule"}

    def test_view_actions_complete(self):
        tools = _get_tools()
        view_tool = next(t for t in tools if t.name == "catgo_view")
        actions = view_tool.inputSchema["properties"]["action"]["enum"]
        assert set(actions) == {"get_state", "selection", "screenshot"}

    def test_workflow_actions_complete(self):
        """Workflow tool should have all expected actions."""
        tools = _get_tools()
        workflow_tool = next(t for t in tools if t.name == "catgo_workflow")
        actions = workflow_tool.inputSchema["properties"]["action"]["enum"]
        expected = {
            "list", "templates", "node_types", "node_details", "create", "get",
            "add_node", "remove_node", "connect", "set_params", "batch",
            "run", "pause", "resume", "validate", "status", "step_error",
            "retry", "batch_status", "batch_results", "list_presets",
        }
        assert set(actions) == expected

    def test_analyze_actions_complete(self):
        """Analyze tool should have all expected actions."""
        tools = _get_tools()
        analyze_tool = next(t for t in tools if t.name == "catgo_analyze")
        actions = analyze_tool.inputSchema["properties"]["action"]["enum"]
        expected = {
            "symmetry", "dos", "rdf", "optimize",
            "dft_input", "adsorption_sites", "coordination",
            "hub_search", "hub_install", "hub_list",
        }
        assert set(actions) == expected

    def test_catalysis_actions_complete(self):
        """Catalysis tool should have reaction analysis actions."""
        tools = _get_tools()
        cat_tool = next(t for t in tools if t.name == "catgo_catalysis")
        actions = cat_tool.inputSchema["properties"]["action"]["enum"]
        expected = {
            "oer", "co2rr", "nrr", "free_energy",
            "volcano", "d_band_center", "adsorption_energy",
        }
        assert set(actions) == expected

    def test_system_actions_complete(self):
        """System tool should have diagnostics actions."""
        tools = _get_tools()
        sys_tool = next(t for t in tools if t.name == "catgo_system")
        actions = sys_tool.inputSchema["properties"]["action"]["enum"]
        assert set(actions) == {"status", "errors"}

    def test_workflow_engine_actions_complete(self):
        """Workflow engine tool should have state-machine actions."""
        tools = _get_tools()
        engine_tool = next(t for t in tools if t.name == "catgo_workflow_engine")
        actions = engine_tool.inputSchema["properties"]["action"]["enum"]
        expected = {
            "create", "add_task", "submit", "status", "list",
            "modify_params", "retry", "pause", "resume", "reset",
            "get_result", "get_dag",
        }
        assert set(actions) == expected

    def test_file_actions_complete(self):
        """File tool should have write/template/list actions."""
        tools = _get_tools()
        file_tool = next(t for t in tools if t.name == "catgo_file")
        actions = file_tool.inputSchema["properties"]["action"]["enum"]
        assert set(actions) == {"write", "template", "list"}

    def test_skills_actions_complete(self):
        """Skills tool should have list/read actions."""
        tools = _get_tools()
        skills_tool = next(t for t in tools if t.name == "catgo_skills")
        actions = skills_tool.inputSchema["properties"]["action"]["enum"]
        assert set(actions) == {"list", "read"}

    def test_all_tools_are_mcp_tool_objects(self):
        """All items in TOOLS list should be mcp.types.Tool objects."""
        tools = _get_tools()
        from mcp.types import Tool
        for tool in tools:
            assert isinstance(tool, Tool), f"Expected Tool object, got {type(tool)}"

    def test_tool_input_schemas_are_valid(self):
        """All tools should have valid input schemas with type='object'."""
        tools = _get_tools()
        for tool in tools:
            schema = tool.inputSchema
            assert isinstance(schema, dict), f"{tool.name} inputSchema is not a dict"
            assert schema.get("type") == "object", (
                f"{tool.name} inputSchema type is '{schema.get('type')}', expected 'object'"
            )

    def test_structure_has_required_fields(self):
        """catgo_structure should have all documented parameter fields."""
        tools = _get_tools()
        struct_tool = next(t for t in tools if t.name == "catgo_structure")
        props = struct_tool.inputSchema["properties"]

        expected_params = {
            "action", "element", "position", "atoms", "indices", "index",
            "new_element", "displacement", "scaling", "matrix",
            "a", "b", "c", "alpha", "beta", "gamma",
            "miller_index", "min_slab_size", "min_vacuum_size",
            "dopant", "host_element", "concentration", "enumerate",
            "structure", "query", "count", "spacing",
            "file_content", "file_format",
        }
        assert set(props.keys()) == expected_params, (
            f"Structure params mismatch. Got: {set(props.keys())}"
        )

    def test_fetch_has_required_fields(self):
        """catgo_fetch should have all documented parameter fields."""
        tools = _get_tools()
        fetch_tool = next(t for t in tools if t.name == "catgo_fetch")
        props = fetch_tool.inputSchema["properties"]

        expected_params = {
            "action", "formula", "elements", "structure_id",
            "provider", "query", "cid", "search_type", "limit"
        }
        assert set(props.keys()) == expected_params, (
            f"Fetch params mismatch. Got: {set(props.keys())}"
        )

    def test_workflow_has_required_fields(self):
        """catgo_workflow should have workflow-related parameter fields."""
        tools = _get_tools()
        workflow_tool = next(t for t in tools if t.name == "catgo_workflow")
        props = workflow_tool.inputSchema["properties"]

        assert "action" in props
        assert "workflow_id" in props
        assert "name" in props
        assert "node_id" in props

    def test_analyze_has_required_fields(self):
        """catgo_analyze should have analysis-related parameter fields."""
        tools = _get_tools()
        analyze_tool = next(t for t in tools if t.name == "catgo_analyze")
        props = analyze_tool.inputSchema["properties"]

        expected_params = {
            "action", "software", "calc_type", "model", "fmax",
            "params", "query", "plugin_id",
        }
        assert set(props.keys()) == expected_params, (
            f"Analyze params mismatch. Got: {set(props.keys())}"
        )

    def test_view_has_required_fields(self):
        """catgo_view should only have 'action' parameter (minimal tool)."""
        tools = _get_tools()
        view_tool = next(t for t in tools if t.name == "catgo_view")
        props = view_tool.inputSchema["properties"]

        assert set(props.keys()) == {"action"}

    def test_all_properties_have_type_field(self):
        """All properties should specify a JSON type."""
        tools = _get_tools()
        for tool in tools:
            props = tool.inputSchema.get("properties", {})
            for param_name, param_def in props.items():
                if isinstance(param_def, dict):
                    assert "type" in param_def or "enum" in param_def, (
                        f"{tool.name}.{param_name} missing 'type' or 'enum'"
                    )

    def test_action_properties_have_descriptions(self):
        """All action enums should have descriptions."""
        tools = _get_tools()
        # catgo_diagnose uses task_id instead of action
        tools_with_action = [t for t in tools if t.name != "catgo_diagnose"]
        for tool in tools_with_action:
            action_prop = tool.inputSchema["properties"].get("action", {})
            assert "description" in action_prop, (
                f"{tool.name} action property missing description"
            )

    def test_provider_has_default(self):
        """catgo_fetch.provider should have a default value."""
        tools = _get_tools()
        fetch_tool = next(t for t in tools if t.name == "catgo_fetch")
        provider_prop = fetch_tool.inputSchema["properties"]["provider"]
        assert provider_prop.get("default") == "mp", (
            "provider should default to 'mp'"
        )

    def test_search_type_has_default(self):
        """catgo_fetch.search_type should have a default value."""
        tools = _get_tools()
        fetch_tool = next(t for t in tools if t.name == "catgo_fetch")
        search_type_prop = fetch_tool.inputSchema["properties"]["search_type"]
        assert search_type_prop.get("default") == "name", (
            "search_type should default to 'name'"
        )

    def test_limit_has_default(self):
        """catgo_fetch.limit should have a default value."""
        tools = _get_tools()
        fetch_tool = next(t for t in tools if t.name == "catgo_fetch")
        limit_prop = fetch_tool.inputSchema["properties"]["limit"]
        assert limit_prop.get("default") == 5, (
            "limit should default to 5"
        )

    def test_workflow_from_to_handles_have_defaults(self):
        """Workflow connection handles should have defaults."""
        tools = _get_tools()
        workflow_tool = next(t for t in tools if t.name == "catgo_workflow")

        from_handle = workflow_tool.inputSchema["properties"].get("from_handle", {})
        to_handle = workflow_tool.inputSchema["properties"].get("to_handle", {})

        assert from_handle.get("default") == "structure", "from_handle should default to 'structure'"
        assert to_handle.get("default") == "structure", "to_handle should default to 'structure'"

    def test_no_duplicate_actions_in_any_tool(self):
        """Each tool should have unique action values (no duplicates in enum)."""
        tools = _get_tools()
        # catgo_diagnose has no action enum
        tools_with_action = [t for t in tools if t.name != "catgo_diagnose"]
        for tool in tools_with_action:
            actions = tool.inputSchema["properties"]["action"]["enum"]
            assert len(actions) == len(set(actions)), (
                f"{tool.name} has duplicate action values: {actions}"
            )

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


# Runtime manifest: tool name -> exact top-level required fields.
# Optional properties may grow without weakening the stable invocation contract.
EXPECTED_REQUIRED_FIELDS = {
    "catgo_structure": {"action"},
    "catgo_fetch": {"action"},
    "catgo_workflow": {"action"},
    "catgo_analyze": {"action"},
    "catgo_view": {"action"},
    "catgo_pane": {"action"},
    "catgo_catalysis": {"action", "params"},
    "catgo_system": {"action"},
    "catgo_workflow_engine": {"action"},
    "catgo_file": {"action"},
    "catgo_diagnose": {"task_id"},
    "catgo_quickbuild": {"recipe"},
    "catgo_skills": {"action"},
    "catgo_campaign": {"action"},
    "catgo_terminal": {"action"},
    "catgo_validate_config": {"potcar_root"},
    "catgo_verify": {"result"},
    "catgo_heterostructure": set(),
    "catgo_nanotube": {"n", "m"},
    "catgo_nanoparticle": {"element"},
    "catgo_moire": set(),
}


class TestClaudeCodeToolDefinitions:
    """Validate the current consolidated MCP runtime contract."""

    def test_tool_count(self):
        tools = _get_tools()
        assert len(tools) == len(EXPECTED_REQUIRED_FIELDS), (
            f"Expected {len(EXPECTED_REQUIRED_FIELDS)} tools, got {len(tools)}"
        )

    def test_tool_names(self):
        tools = _get_tools()
        names = {t.name for t in tools}
        expected = set(EXPECTED_REQUIRED_FIELDS)
        assert names == expected, f"Tool names mismatch: {names}"

    def test_all_tools_have_action_enum(self):
        tools = _get_tools()
        for tool in tools:
            action = tool.inputSchema.get("properties", {}).get("action")
            if action is None:
                continue
            assert action.get("type") == "string", (
                f"{tool.name}.action must be a string"
            )
            assert isinstance(action.get("enum"), list) and action["enum"], (
                f"{tool.name}.action must define a non-empty enum"
            )

    def test_required_fields_match_runtime_contract(self):
        tools = _get_tools()
        for tool in tools:
            actual = set(tool.inputSchema.get("required", []))
            expected = EXPECTED_REQUIRED_FIELDS[tool.name]
            assert actual == expected, (
                f"{tool.name} required fields changed: "
                f"expected {sorted(expected)}, got {sorted(actual)}"
            )

    def test_diagnose_requires_task_id(self):
        tools = _get_tools()
        diagnose_tool = next(t for t in tools if t.name == "catgo_diagnose")
        assert "task_id" in diagnose_tool.inputSchema.get("required", [])

    def test_all_tools_have_descriptions(self):
        """Every tool needs non-empty routing guidance."""
        tools = _get_tools()
        for tool in tools:
            assert isinstance(tool.description, str)
            assert tool.description.strip(), f"{tool.name} has no description"

    def test_structure_actions_complete(self):
        tools = _get_tools()
        struct_tool = next(t for t in tools if t.name == "catgo_structure")
        actions = struct_tool.inputSchema["properties"]["action"]["enum"]
        expected = [
            "get", "export", "add_atom", "add_atoms", "delete", "replace",
            "move", "supercell", "set_lattice", "slab", "doping",
            "merge", "add_molecule", "add_cluster", "load_file",
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
        assert set(actions) == {"get_state", "selection", "screenshot", "select"}

    def test_workflow_actions_complete(self):
        """Workflow tool should have all expected actions."""
        tools = _get_tools()
        workflow_tool = next(t for t in tools if t.name == "catgo_workflow")
        actions = workflow_tool.inputSchema["properties"]["action"]["enum"]
        expected = {
            "list", "templates", "node_types", "node_details", "create", "rename", "get",
            "add_node", "remove_node", "connect", "set_params", "batch",
            "run", "pause", "resume", "validate", "status", "results", "step_error",
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
        """All tools should have valid object schemas and declared required keys."""
        tools = _get_tools()
        for tool in tools:
            schema = tool.inputSchema
            assert isinstance(schema, dict), f"{tool.name} inputSchema is not a dict"
            assert schema.get("type") == "object", (
                f"{tool.name} inputSchema type is '{schema.get('type')}', expected 'object'"
            )
            props = schema.get("properties")
            required = schema.get("required", [])
            assert isinstance(props, dict), f"{tool.name}.properties is not a dict"
            assert isinstance(required, list), f"{tool.name}.required is not a list"
            assert len(required) == len(set(required)), (
                f"{tool.name} has duplicate required fields: {required}"
            )
            assert set(required) <= set(props), (
                f"{tool.name} requires undeclared fields: {set(required) - set(props)}"
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
            "cluster_type", "size", "offset",
            "file_content", "file_format",
        }
        assert expected_params <= set(props), (
            f"Structure params missing: {expected_params - set(props)}"
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
        assert expected_params <= set(props), (
            f"Fetch params missing: {expected_params - set(props)}"
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
        assert expected_params <= set(props), (
            f"Analyze params missing: {expected_params - set(props)}"
        )

    def test_view_has_required_fields(self):
        """catgo_view should expose selection routing fields."""
        tools = _get_tools()
        view_tool = next(t for t in tools if t.name == "catgo_view")
        props = view_tool.inputSchema["properties"]

        assert {"action", "query", "panel_id", "mode"} <= set(props)

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

    def test_action_tools_have_routing_descriptions(self):
        """Action routing must be documented inline or at tool level."""
        tools = _get_tools()
        for tool in tools:
            action_prop = tool.inputSchema.get("properties", {}).get("action")
            if action_prop is None:
                continue
            routing_description = action_prop.get("description") or tool.description
            assert isinstance(routing_description, str)
            assert routing_description.strip(), (
                f"{tool.name} action routing has no description"
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
        for tool in tools:
            action = tool.inputSchema.get("properties", {}).get("action")
            if action is None:
                continue
            actions = action["enum"]
            assert len(actions) == len(set(actions)), (
                f"{tool.name} has duplicate action values: {actions}"
            )

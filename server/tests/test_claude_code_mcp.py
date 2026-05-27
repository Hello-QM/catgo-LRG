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
    """Validate the 17 consolidated tools."""

    # Tools that legitimately do NOT use an `action` enum:
    #   catgo_diagnose -> keyed on task_id
    #   catgo_quickbuild -> keyed on recipe
    NO_ACTION_TOOLS = {"catgo_diagnose", "catgo_quickbuild"}

    # The consolidated Menu B surface is exactly these 17 tools. Asserting the
    # EXACT count (not >=) is the tripwire: an accidentally added or removed
    # mega-tool trips this test. (Bump this number deliberately when a tool is
    # added on purpose — and update test_tool_names below to match.)
    EXPECTED_TOOL_COUNT = 17

    def test_tool_count(self):
        tools = _get_tools()
        assert len(tools) == len({t.name for t in tools}), "duplicate tool names"
        # Exact count, not >=: catches accidental registry bloat or loss.
        assert len(tools) == self.EXPECTED_TOOL_COUNT, (
            f"Expected exactly {self.EXPECTED_TOOL_COUNT} tools, got {len(tools)}"
        )

    def test_tool_names(self):
        tools = _get_tools()
        names = {t.name for t in tools}
        expected = {
            "catgo_structure", "catgo_fetch", "catgo_workflow", "catgo_analyze",
            "catgo_view", "catgo_catalysis", "catgo_system", "catgo_workflow_engine",
            "catgo_file", "catgo_diagnose", "catgo_quickbuild", "catgo_skills",
            "catgo_heterostructure", "catgo_nanotube", "catgo_moire",
            "catgo_md", "catgo_input",
        }
        assert names == expected, f"Tool names mismatch: {names}"

    def test_all_tools_have_action_enum(self):
        tools = _get_tools()
        tools_with_action = [t for t in tools if t.name not in self.NO_ACTION_TOOLS]
        for tool in tools_with_action:
            schema = tool.inputSchema
            assert "action" in schema["properties"], f"{tool.name} missing 'action' property"
            assert "enum" in schema["properties"]["action"], f"{tool.name} action missing enum"

    def test_all_tools_require_action(self):
        """Every action-driven tool must either REQUIRE `action` or supply a
        default for it.

        The one-shot builder mega-tools (catgo_heterostructure/nanotube/moire)
        deliberately make `action` optional with default="build" so a bare call
        does the common thing; they require their domain inputs (film / n,m)
        instead. That is still a well-defined action contract.
        """
        tools = _get_tools()
        tools_with_action = [t for t in tools if t.name not in self.NO_ACTION_TOOLS]
        for tool in tools_with_action:
            schema = tool.inputSchema
            action_required = "action" in schema.get("required", [])
            action_has_default = "default" in schema["properties"].get("action", {})
            assert action_required or action_has_default, (
                f"{tool.name} neither requires 'action' nor gives it a default"
            )

    def test_diagnose_requires_task_id(self):
        tools = _get_tools()
        diagnose_tool = next(t for t in tools if t.name == "catgo_diagnose")
        assert "task_id" in diagnose_tool.inputSchema.get("required", [])

    # Token-efficiency guard. The MCP tool list is re-sent on every session
    # init, so description length is a real cost. The consolidated mega-tools
    # ship usage recipes and so legitimately run longer than the old granular
    # 300-char tools, but they are NOT unbounded.
    #
    # As of the 17-tool consolidation the largest NON-exempt description is
    # catgo_structure at 2451 chars; the rest are smaller. We cap normal tools
    # at 3000 (= ~2451 rounded up with ~20% headroom) so any future unbounded
    # bloat fails. catgo_workflow is the single legitimate outlier: it embeds
    # the full CATBOT building guide (~7.6k chars). It is exempted from the tight
    # cap but still bounded by EXEMPT_DESC_CAP so even it cannot grow unbounded.
    DESC_CAP = 3000
    EXEMPT_DESC_CAP = 9000
    # tool -> reason it is allowed a longer description.
    DESC_EXEMPT = {
        "catgo_workflow": "embeds the full CATBOT workflow-building guide",
    }

    def test_descriptions_are_concise(self):
        """Every tool must have a non-empty, length-bounded description.

        Normal tools must stay under DESC_CAP; only explicitly-exempt tools may
        exceed it, and even they are bounded by EXEMPT_DESC_CAP. A future
        unbounded description (the regression this guards) fails the test.
        """
        tools = _get_tools()
        for tool in tools:
            assert tool.description and tool.description.strip(), (
                f"{tool.name} has an empty description"
            )
            length = len(tool.description)
            if tool.name in self.DESC_EXEMPT:
                assert length < self.EXEMPT_DESC_CAP, (
                    f"{tool.name} description is {length} chars, over the "
                    f"exempt cap {self.EXEMPT_DESC_CAP} "
                    f"({self.DESC_EXEMPT[tool.name]})"
                )
            else:
                assert length < self.DESC_CAP, (
                    f"{tool.name} description is {length} chars, over the "
                    f"{self.DESC_CAP}-char cap (add to DESC_EXEMPT only with a "
                    f"documented reason)"
                )

    def test_structure_actions_complete(self):
        tools = _get_tools()
        struct_tool = next(t for t in tools if t.name == "catgo_structure")
        actions = struct_tool.inputSchema["properties"]["action"]["enum"]
        expected = [
            "get", "export", "add_atom", "add_atoms", "delete", "replace",
            "move", "supercell", "set_lattice", "slab", "doping",
            "merge", "add_molecule", "add_cluster", "load_file",
            "defect", "strain", "passivate", "water_layer",
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
            "list", "templates", "node_types", "node_details", "create", "rename",
            "get", "add_node", "remove_node", "connect", "set_params", "batch",
            "run", "pause", "resume", "validate", "status", "step_error",
            "retry", "batch_status", "batch_results", "list_presets",
        }
        assert set(actions) == expected

    def test_analyze_actions_complete(self):
        """Analyze tool should have all expected actions."""
        tools = _get_tools()
        analyze_tool = next(t for t in tools if t.name == "catgo_analyze")
        actions = analyze_tool.inputSchema["properties"]["action"]["enum"]
        # dft_input dropped; energy/calculators added during consolidation.
        expected = {
            "symmetry", "dos", "rdf", "optimize", "energy", "calculators",
            "adsorption_sites", "coordination",
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
            # added during consolidation (export / clusters / defect / strain /
            # passivate / water_layer building actions)
            "axis", "offset", "size", "cluster_type", "substitute_element",
            "defect_type", "site_index", "supercell",
            "strain_type", "magnitude", "n_steps", "params", "bulk", "slab",
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

        # `software` dropped with the dft_input action during consolidation.
        expected_params = {
            "action", "calc_type", "model", "fmax",
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
        tools_with_action = [t for t in tools if t.name not in self.NO_ACTION_TOOLS]
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
        tools_with_action = [t for t in tools if t.name not in self.NO_ACTION_TOOLS]
        for tool in tools_with_action:
            actions = tool.inputSchema["properties"]["action"]["enum"]
            assert len(actions) == len(set(actions)), (
                f"{tool.name} has duplicate action values: {actions}"
            )

"""
MCP Server integration test.

Tests that all 53 MCP tools are discoverable, have valid schemas, and that
the dispatch layer correctly routes calls to the backend.

Usage:
    conda run -n catgo python tests/test_mcp_integration.py
    conda run -n catgo python tests/test_mcp_integration.py -v
"""

import asyncio
import json
import sys

# Add server dir to path
sys.path.insert(0, "server")


NACL_STRUCTURE = {
    "lattice": {
        "matrix": [[5.69, 0, 0], [0, 5.69, 0], [0, 0, 5.69]],
        "a": 5.69, "b": 5.69, "c": 5.69,
        "alpha": 90.0, "beta": 90.0, "gamma": 90.0,
    },
    "sites": [
        {"xyz": [0, 0, 0], "species": [{"element": "Na", "occu": 1.0}]},
        {"xyz": [0, 2.845, 2.845], "species": [{"element": "Na", "occu": 1.0}]},
        {"xyz": [2.845, 0, 2.845], "species": [{"element": "Na", "occu": 1.0}]},
        {"xyz": [2.845, 2.845, 0], "species": [{"element": "Na", "occu": 1.0}]},
        {"xyz": [2.845, 2.845, 2.845], "species": [{"element": "Cl", "occu": 1.0}]},
        {"xyz": [2.845, 0, 0], "species": [{"element": "Cl", "occu": 1.0}]},
        {"xyz": [0, 2.845, 0], "species": [{"element": "Cl", "occu": 1.0}]},
        {"xyz": [0, 0, 2.845], "species": [{"element": "Cl", "occu": 1.0}]},
    ],
}

# Expected tool categories and counts
EXPECTED_CATEGORIES = {
    "catgo_": 57,  # Total tools with catgo_ prefix
}

# Tools that should be callable without any required arguments (GET endpoints)
GET_TOOLS = {
    "catgo_calculators",
    "catgo_vasp_calc_types",
    "catgo_qe_templates",
    "catgo_lammps_pair_styles",
    "catgo_providers",
}

# Tools that need a structure as input (POST endpoints) — sample subset for testing
STRUCTURE_TOOLS = {
    "catgo_add_atom": {"structure": NACL_STRUCTURE, "element": "H", "position": [0, 0, 5]},
    "catgo_vasp_generate": {"structure": NACL_STRUCTURE, "calculation_type": "scf"},
    "catgo_doping": {"structure": NACL_STRUCTURE, "dopant": "K", "host_element": "Na", "concentration": 1},
    "catgo_water_layer": {
        "structure": {**NACL_STRUCTURE, "lattice": {**NACL_STRUCTURE["lattice"], "matrix": [[5.69, 0, 0], [0, 5.69, 0], [0, 0, 25]], "c": 25.0}},
        "params": {"z_start": 5.0, "z_end": 15.0, "min_distance": 2.0},
    },
}


async def run_tests(verbose: bool = False):
    from mcp_server import TOOLS, handle_call_tool, handle_list_tools

    passed = 0
    failed = 0
    total = 0

    def record(name, ok, msg=""):
        nonlocal passed, failed, total
        total += 1
        if ok:
            passed += 1
            print(f"  ✓ {name}" + (f" — {msg}" if msg and verbose else ""))
        else:
            failed += 1
            print(f"  ✗ {name} — {msg}")

    # ── 1. Tool Discovery ──
    print("\n── Tool Discovery ──")

    tools = await handle_list_tools()
    record("list_tools_returns_list", isinstance(tools, list), f"{len(tools)} tools")
    record("tool_count_57", len(tools) == 57,
           f"expected 57, got {len(tools)}")

    # Check all tools have required fields
    all_have_name = all(hasattr(t, "name") and t.name for t in tools)
    record("all_tools_have_name", all_have_name)

    all_have_desc = all(hasattr(t, "description") and t.description for t in tools)
    record("all_tools_have_description", all_have_desc)

    all_have_schema = all(hasattr(t, "inputSchema") and t.inputSchema for t in tools)
    record("all_tools_have_schema", all_have_schema)

    # ── 2. Schema Validation ──
    print("\n── Schema Validation ──")

    tool_names = {t.name for t in tools}
    tool_map = {t["name"]: t for t in TOOLS}

    # Check no duplicate names
    record("no_duplicate_names", len(tool_names) == len(tools),
           f"unique={len(tool_names)}, total={len(tools)}")

    # Check all tools have valid endpoints
    all_have_endpoints = all("endpoint" in t and "method" in t for t in TOOLS)
    record("all_tools_have_endpoint", all_have_endpoints)

    # Check all schemas have "type": "object"
    all_object_type = all(
        t["inputSchema"].get("type") == "object" for t in TOOLS
    )
    record("all_schemas_are_object_type", all_object_type)

    # Check all schemas have "properties"
    all_have_properties = all(
        "properties" in t["inputSchema"] for t in TOOLS
    )
    record("all_schemas_have_properties", all_have_properties)

    # Check required fields reference existing properties
    schema_errors = []
    for t in TOOLS:
        schema = t["inputSchema"]
        required = schema.get("required", [])
        props = set(schema.get("properties", {}).keys())
        for r in required:
            if r not in props:
                schema_errors.append(f"{t['name']}: required '{r}' not in properties")
    record("required_fields_exist_in_properties",
           len(schema_errors) == 0,
           "; ".join(schema_errors[:3]) if schema_errors else "")

    # ── 3. GET Tool Dispatch ──
    print("\n── GET Tool Dispatch (no-arg tools) ──")

    for tool_name in sorted(GET_TOOLS):
        if tool_name not in tool_names:
            record(f"dispatch_{tool_name}", False, "tool not found in list")
            continue
        try:
            results = await handle_call_tool(tool_name, {})
            ok = (
                len(results) > 0
                and results[0].text
                and "Cannot connect" not in results[0].text
                and "Unknown tool" not in results[0].text
            )
            is_error = "API error" in results[0].text if results else False
            record(f"dispatch_{tool_name}", ok and not is_error,
                   results[0].text[:100] if not ok or verbose else "")
        except Exception as e:
            record(f"dispatch_{tool_name}", False, str(e)[:100])

    # ── 4. POST Tool Dispatch (structure tools) ──
    print("\n── POST Tool Dispatch (structure tools) ──")

    for tool_name, args in STRUCTURE_TOOLS.items():
        if tool_name not in tool_names:
            record(f"dispatch_{tool_name}", False, "tool not found in list")
            continue
        try:
            results = await handle_call_tool(tool_name, args)
            text = results[0].text if results else ""
            ok = (
                len(results) > 0
                and text
                and "Cannot connect" not in text
                and "Unknown tool" not in text
                and "API error" not in text
            )
            record(f"dispatch_{tool_name}", ok,
                   text[:120] if not ok or verbose else "")
        except Exception as e:
            record(f"dispatch_{tool_name}", False, str(e)[:100])

    # ── 5. Unknown Tool ──
    print("\n── Edge Cases ──")

    results = await handle_call_tool("nonexistent_tool", {})
    record("unknown_tool_handled",
           "Unknown tool" in results[0].text,
           results[0].text[:80])

    # Empty arguments on required-arg tool
    results = await handle_call_tool("catgo_add_atom", {})
    # Should return an API error (422 validation) not crash
    record("missing_required_args_returns_error",
           len(results) > 0 and ("error" in results[0].text.lower() or "failed" in results[0].text.lower()),
           results[0].text[:100])

    # ── Summary ──
    print(f"\n{'='*60}")
    print(f"Results: {passed}/{total} passed, {failed} failed")
    if failed:
        print(f"\n{failed} test(s) failed — see above for details")
    print(f"{'='*60}")

    return failed == 0


def main():
    verbose = "-v" in sys.argv
    ok = asyncio.run(run_tests(verbose))
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()

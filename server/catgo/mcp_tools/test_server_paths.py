"""Regression: the MCP modules must put server/ on sys.path, not server/catgo/.

Three modules computed it with one `dirname` too few, landing on server/catgo/ and
inserting it at sys.path[0]. Because server/catgo/workflow/ exists, it SHADOWED
server/workflow/, so `from workflow.catalysis.oer import ...` raised
"No module named 'workflow.catalysis'" and catgo_catalysis answered
"Catalysis module not available: ..." for every single call — a tool that had been
dead in the merged MCP variant while looking like a normal error message.

Runnable with pytest OR standalone (`python test_server_paths.py`).
"""
import os
import sys
import asyncio
import json
import subprocess

_HERE = os.path.dirname(os.path.abspath(__file__))
_SERVER = os.path.dirname(os.path.dirname(_HERE))          # server/
if _SERVER not in sys.path:
    sys.path.insert(0, _SERVER)


def test_workflow_package_is_not_shadowed():
    import catgo.mcp_tools.server_claude_code  # noqa: F401  (does the path setup)
    import workflow
    assert workflow.__file__ == os.path.join(_SERVER, "workflow", "__init__.py"), (
        f"server/catgo/workflow shadowed server/workflow: {workflow.__file__}")


def test_catalysis_submodule_imports():
    import catgo.mcp_tools.server_claude_code  # noqa: F401
    from workflow.catalysis.oer import compute_oer_overpotential
    r = compute_oer_overpotential(dG_OH=-0.7, dG_O=1.6, dG_OOH=3.2)
    assert "overpotential" in r


def test_server_catgo_is_not_ahead_of_server_on_path():
    import catgo.mcp_tools.server_claude_code  # noqa: F401
    import catgo.mcp_tools.server            # noqa: F401  (has the same bug shape)
    inner = os.path.join(_SERVER, "catgo")
    if inner in sys.path:
        assert sys.path.index(_SERVER) < sys.path.index(inner), \
            "server/catgo must never precede server/ on sys.path"


def test_consolidated_server_honors_runtime_backend_port():
    """The embedded MCP must call back into the backend that hosts it.

    Desktop/worktree instances intentionally run on ports other than 8000.
    A private fallback in ``server_claude_code`` previously ignored
    ``SERVER_PORT`` and made healthy instances report that their backend was
    disconnected as soon as a tool needed an HTTP callback.
    """
    env = os.environ.copy()
    env.pop("CATGO_API", None)
    env["SERVER_PORT"] = "8123"
    output = subprocess.check_output(
        [
            sys.executable,
            "-c",
            "from catgo.mcp_tools.server_claude_code import API_BASE; print(API_BASE)",
        ],
        cwd=_SERVER,
        env=env,
        text=True,
    ).strip()
    assert output == "http://localhost:8123/api"


# ---- the provenance envelope the numeric tools now return ------------------
def test_envelope_declares_what_it_cannot_vouch_for():
    from catgo.mcp_tools import provenance as prov
    e = prov.envelope({"overpotential": 1.07}, tool="catgo_catalysis", action="oer",
                      inputs={"dG_OH": -0.7}, claim="limiting_potential",
                      method="workflow.catalysis.oer")
    assert e["value"]["overpotential"] == 1.07
    assert e["provenance"]["method"] == "workflow.catalysis.oer"
    assert e["unverifiable_without"] == ["ul_reaction", "ul_reference", "ul_convention"]
    # binding_dG must carry complete thermodynamics plus typed operand lineage.
    b = prov.envelope(-1.2, tool="catgo_catalysis", action="adsorption_energy",
                      claim="binding_dG")
    assert b["unverifiable_without"] == [
        "E_ads_eV", "E_ads_unit", "dG_ads_eV", "dG_ads_unit",
        "temperature", "pressure",
        "zpe_correction_eV", "entropy_correction_eV",
        "gas_entropy_included",
        "reference_task_id", "reference_digest",
        "slab_adsorbate_task_id", "slab_adsorbate_digest", "pairing_mode",
        "lineage_records", "declared_role_bindings",
    ], b


def test_envelope_never_invents_provenance():
    from catgo.mcp_tools import provenance as prov
    # a None-valued field is not provenance
    n = prov.envelope(1.0, tool="t", action="a", claim="her_dGH", gas_entropy_included=None)
    assert n["unverifiable_without"] == ["gas_entropy_included"]
    # supplying it clears the declaration
    ok = prov.envelope(1.0, tool="t", action="a", claim="her_dGH", gas_entropy_included=True)
    assert "unverifiable_without" not in ok
    # an unregistered claim invents nothing
    u = prov.envelope(1.0, tool="t", action="a", claim="brand_new_claim")
    assert "unverifiable_without" not in u and u["claim"] == "brand_new_claim"


def test_dispatcher_rejects_error_responses_before_postmark():
    from mcp.types import TextContent
    from catgo.mcp_tools.server_claude_code import _response_succeeded

    def response(text):
        return [TextContent(type="text", text=text)]

    assert not _response_succeeded(
        "catgo_workflow", response("batch_results requires 'step_id'.")
    )
    assert not _response_succeeded(
        "catgo_analyze", response('{"success": false, "error": "parse failed"}')
    )
    assert not _response_succeeded(
        "catgo_analyze", response('{"status": "failed", "items": []}')
    )
    assert not _response_succeeded(
        "catgo_catalysis", response("catalysis/oer failed: invalid input")
    )
    assert not _response_succeeded(
        "catgo_catalysis", response("Catalysis module not available: missing")
    )
    # PR #546 review: these two legacy formats slipped through and armed the
    # session as "unverified" with nothing verifiable behind them
    assert not _response_succeeded(
        "catgo_workflow_engine", response("workflow_engine error: boom")
    )
    assert not _response_succeeded(
        "catgo_catalysis", response("Unknown catalysis action 'x'. Valid: oer, ...")
    )
    assert _response_succeeded(
        "catgo_analyze", response('{"energy": -1.25, "success": true}')
    )
    assert _response_succeeded(
        "catgo_workflow",
        response('{"status": "failed", "steps": [{"result_json": {"energy": -1.0}}]}'),
        {"action": "status"},
    )


def test_empty_or_error_batch_does_not_arm_enforcement(monkeypatch):
    from mcp.types import TextContent
    from catgo.mcp_tools import server_claude_code as server_module
    from catgo.mcp_tools import verify_enforcement as enforcement

    async def dispatch_empty(name, arguments):
        return [TextContent(type="text", text='{"items": [], "total": 0}')]

    enforcement._sessions.pop("default", None)
    monkeypatch.setattr(server_module, "_dispatch_tool", dispatch_empty)
    asyncio.run(server_module.handle_call_tool(
        "catgo_workflow", {"action": "batch_results", "step_id": "sp"}
    ))
    assert enforcement.state()["unverified"] == 0

    async def dispatch_error(name, arguments):
        return [TextContent(type="text", text="batch_results requires 'step_id'.")]

    monkeypatch.setattr(server_module, "_dispatch_tool", dispatch_error)
    asyncio.run(server_module.handle_call_tool(
        "catgo_workflow", {"action": "batch_results"}
    ))
    assert enforcement.state()["unverified"] == 0


def test_dispatcher_binds_scalar_numeric_result_to_one_digest(monkeypatch):
    from mcp.types import TextContent
    from catgo.mcp_tools import provenance
    from catgo.mcp_tools import server_claude_code as server_module
    from catgo.mcp_tools import verify_enforcement as enforcement

    async def dispatch_scalar(name, arguments):
        return [TextContent(type="text", text="-1.25")]

    enforcement._sessions.pop("default", None)
    monkeypatch.setattr(server_module, "_dispatch_tool", dispatch_scalar)
    response = asyncio.run(server_module.handle_call_tool(
        "catgo_energy", {"action": "parse", "task_id": "scalar-1"}
    ))
    envelope = json.loads(response[0].text)

    assert provenance.bound_result_digest(envelope) == envelope["result_digest"]
    state = enforcement.state()
    assert state["legacy_unverified"] == 0
    assert state["pending_digests"] == {
        envelope["result_digest"]: "catgo_energy",
    }


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
    print(f"OK — {len(fns)} tests passed (sys.path shadowing + provenance envelope)")

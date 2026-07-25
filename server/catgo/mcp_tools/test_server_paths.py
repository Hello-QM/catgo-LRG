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


# ---- the provenance envelope the numeric tools now return ------------------
def test_envelope_declares_what_it_cannot_vouch_for():
    import provenance as prov
    e = prov.envelope({"overpotential": 1.07}, tool="catgo_catalysis", action="oer",
                      inputs={"dG_OH": -0.7}, claim="limiting_potential",
                      method="workflow.catalysis.oer")
    assert e["value"]["overpotential"] == 1.07
    assert e["provenance"]["method"] == "workflow.catalysis.oer"
    assert e["unverifiable_without"] == ["ul_reaction", "ul_reference", "ul_convention"]


def test_envelope_never_invents_provenance():
    import provenance as prov
    # a None-valued field is not provenance
    n = prov.envelope(1.0, tool="t", action="a", claim="her_dGH", gas_entropy_included=None)
    assert n["unverifiable_without"] == ["gas_entropy_included"]
    # supplying it clears the declaration
    ok = prov.envelope(1.0, tool="t", action="a", claim="her_dGH", gas_entropy_included=True)
    assert "unverifiable_without" not in ok
    # an unregistered claim invents nothing
    u = prov.envelope(1.0, tool="t", action="a", claim="brand_new_claim")
    assert "unverifiable_without" not in u and u["claim"] == "brand_new_claim"


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
    print(f"OK — {len(fns)} tests passed (sys.path shadowing + provenance envelope)")

"""Tests for lateral (in-plane) heterostructure exposure over MCP.

Lateral heterojunctions join two pre-cut slabs side-by-side along one
in-plane edge (1D edge matching), as opposed to the vertical ZSL stack.
The backend already exposes /heterostructure/search-lateral and
/build-lateral; these tests pin the two MCP front-doors:

  1. The consolidated HTTP/SSE server (server_claude_code.catgo_heterostructure)
     gains `search_lateral` / `build_lateral` actions + lateral params, and
     routes them to the right endpoints, pushing the built slab to the viewer.
  2. The declarative stdio registry (mcp_tools.tools) gains two endpoint-bound
     lateral tools.
"""

import sys
from pathlib import Path

import pytest

_server_dir = str(Path(__file__).resolve().parent.parent)
if _server_dir not in sys.path:
    sys.path.insert(0, _server_dir)


# ---------------------------------------------------------------------------
# Fake httpx client — records POST/GET calls, returns canned responses by URL
# ---------------------------------------------------------------------------

class _FakeResponse:
    def __init__(self, status_code=200, json_data=None, text=""):
        self.status_code = status_code
        self._json = json_data if json_data is not None else {}
        self.text = text or ""

    def json(self):
        return self._json


class _FakeClient:
    """Minimal stand-in for httpx.AsyncClient used by the MCP handlers."""

    def __init__(self, responder):
        self.calls = []  # list of {"method","url","json","params"}
        self._responder = responder

    async def post(self, url, json=None, params=None, timeout=None):
        self.calls.append({"method": "POST", "url": url, "json": json, "params": params})
        return self._responder("POST", url, json)

    async def get(self, url, params=None, timeout=None):
        self.calls.append({"method": "GET", "url": url, "json": None, "params": params})
        return self._responder("GET", url, None)

    def posts_to(self, suffix):
        return [c for c in self.calls if c["method"] == "POST" and c["url"].endswith(suffix)]


# A pre-cut slab dict (has both `sites` and `lattice` so _resolve_hetero_material
# passes it straight through without hitting the network).
def _slab(formula_z=0.0):
    return {
        "lattice": {"matrix": [[3.0, 0, 0], [0, 3.0, 0], [0, 0, 20.0]]},
        "sites": [
            {"species": [{"element": "C", "occu": 1}], "xyz": [0, 0, formula_z],
             "abc": [0, 0, formula_z / 20.0], "label": "C"},
        ],
    }


# ---------------------------------------------------------------------------
# 1. Consolidated tool schema
# ---------------------------------------------------------------------------

def _hetero_tool():
    from catgo.mcp_tools.server_claude_code import TOOLS
    tool = next((t for t in TOOLS if t.name == "catgo_heterostructure"), None)
    assert tool is not None, "catgo_heterostructure tool missing"
    return tool


class TestLateralSchema:
    def test_action_enum_has_lateral(self):
        schema = _hetero_tool().inputSchema
        actions = schema["properties"]["action"]["enum"]
        assert "search_lateral" in actions
        assert "build_lateral" in actions

    def test_lateral_params_present(self):
        props = _hetero_tool().inputSchema["properties"]
        for key in ("interface_axis", "lateral_max_length", "lateral_max_strain",
                    "width_A", "width_B", "buffer"):
            assert key in props, f"lateral param {key!r} missing from schema"


# ---------------------------------------------------------------------------
# 2. Declarative stdio registry
# ---------------------------------------------------------------------------

class TestLateralDeclarativeTools:
    def _tools(self):
        from catgo.mcp_tools.tools import TOOLS
        return {t["name"]: t for t in TOOLS}

    def test_search_lateral_tool(self):
        tools = self._tools()
        assert "catgo_hetero_search_lateral" in tools
        assert tools["catgo_hetero_search_lateral"]["endpoint"] == "/heterostructure/search-lateral"

    def test_build_lateral_tool(self):
        tools = self._tools()
        assert "catgo_hetero_build_lateral" in tools
        assert tools["catgo_hetero_build_lateral"]["endpoint"] == "/heterostructure/build-lateral"


# ---------------------------------------------------------------------------
# 3. Handler routing
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_search_lateral_routes_to_endpoint():
    from catgo.mcp_tools.server_claude_code import _handle_heterostructure

    def responder(method, url, body):
        if url.endswith("/heterostructure/search-lateral"):
            return _FakeResponse(200, {
                "matches": [
                    {"match_id": 0, "n1": 1, "n2": 1, "edge_length_A": 3.0,
                     "edge_length_B": 3.1, "strain_percent": 3.3,
                     "n_atoms_A": 1, "n_atoms_B": 1},
                ],
                "n_matches": 1,
            })
        return _FakeResponse(404, text="unexpected")

    client = _FakeClient(responder)
    out = await _handle_heterostructure(client, {
        "action": "search_lateral",
        "slab_A": _slab(), "slab_B": _slab(),
        "interface_axis": 1, "lateral_max_strain": 4.0,
    })

    posts = client.posts_to("/heterostructure/search-lateral")
    assert len(posts) == 1, "must POST exactly once to search-lateral"
    body = posts[0]["json"]
    assert "slab_A" in body and "slab_B" in body
    assert body["params"]["interface_axis"] == 1
    assert body["params"]["max_strain"] == 4.0
    text = out[0].text
    assert "match_id=0" in text


@pytest.mark.asyncio
async def test_build_lateral_searches_then_builds_and_pushes():
    from catgo.mcp_tools.server_claude_code import _handle_heterostructure

    built = {
        "structure": {"lattice": {"matrix": [[6, 0, 0], [0, 3, 0], [0, 0, 20]]},
                      "sites": [{"species": [{"element": "C", "occu": 1}],
                                 "xyz": [0, 0, 0], "abc": [0, 0, 0], "label": "C"}]},
        "n_atoms": 2, "n_atoms_A": 1, "n_atoms_B": 1,
        "interface_length": 3.0, "strain": 3.3,
    }

    def responder(method, url, body):
        if url.endswith("/heterostructure/search-lateral"):
            return _FakeResponse(200, {
                "matches": [
                    {"match_id": 0, "n1": 1, "n2": 1, "edge_length_A": 3.0,
                     "edge_length_B": 3.1, "strain_percent": 3.3,
                     "n_atoms_A": 1, "n_atoms_B": 1},
                ],
                "n_matches": 1,
            })
        if url.endswith("/heterostructure/build-lateral"):
            return _FakeResponse(200, built)
        if "/view/structure/" in url:
            return _FakeResponse(200, {"ok": True})
        return _FakeResponse(404, text="unexpected")

    client = _FakeClient(responder)
    out = await _handle_heterostructure(client, {
        "action": "build_lateral",
        "slab_A": _slab(), "slab_B": _slab(),
        "match_id": 0, "width_A": 2, "buffer": 1.0,
    })

    build_posts = client.posts_to("/heterostructure/build-lateral")
    assert len(build_posts) == 1, "must build exactly once"
    bbody = build_posts[0]["json"]
    assert bbody["match"]["match_id"] == 0
    assert bbody["params"]["width_A"] == 2
    assert bbody["params"]["buffer"] == 1.0
    # built structure pushed to the viewer
    assert client.posts_to("/view/structure/push"), "built slab must be pushed to viewer"
    assert "atoms" in out[0].text.lower()


@pytest.mark.asyncio
async def test_lateral_params_clamped_to_backend_range():
    """Out-of-range knobs are clamped to the backend's accepted bounds so the
    LLM never sees a raw pydantic 422 (e.g. max_strain below the 0.1% floor)."""
    from catgo.mcp_tools.server_claude_code import _handle_heterostructure

    captured = {}

    def responder(method, url, body):
        if url.endswith("/heterostructure/search-lateral"):
            captured["search"] = body
            return _FakeResponse(200, {"matches": [], "n_matches": 0})
        return _FakeResponse(404, text="unexpected")

    client = _FakeClient(responder)
    await _handle_heterostructure(client, {
        "action": "search_lateral",
        "slab_A": _slab(), "slab_B": _slab(),
        "lateral_max_strain": 0.01,   # below floor 0.1
        "lateral_max_length": 1.0,    # below floor 5.0
        "interface_axis": 7,          # out of {0,1}
    })
    p = captured["search"]["params"]
    assert p["max_strain"] == 0.1, "max_strain must clamp up to 0.1"
    assert p["max_length"] == 5.0, "max_length must clamp up to 5.0"
    assert p["interface_axis"] == 1, "interface_axis must clamp into {0,1}"

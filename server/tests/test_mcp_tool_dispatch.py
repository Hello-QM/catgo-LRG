"""Regressions for the fine-grained MCP dispatch CatBot actually talks to.

`catbot-plugin/server/mcp_server.py` runs `catgo.mcp_tools.server`, not the merged
`server_claude_code` variant. Four defects lived only on this path, so every one
of them was invisible to the merged variant's tests:

  * six tools the agent prompt tells CatBot to call were never registered
  * a tool endpoint missing its leading slash 404s on every call
  * a POST route taking bare scalars needs QUERY params; a JSON body 422s
  * a builder's result was pushed to the viewer only when the tool also
    CONSUMED a structure, so pure builders displayed nothing
"""

import importlib
import json

import pytest

# NB: `from catgo.mcp_tools import server` yields the module-level `Server`
# OBJECT (server.py:66 rebinds the name inside the package), not this module.
# import_module is the only spelling that reliably gets the submodule.
mcp_server = importlib.import_module("catgo.mcp_tools.server")
TOOLS = importlib.import_module("catgo.mcp_tools.tools").TOOLS


def _tool(name: str) -> dict:
    match = [t for t in TOOLS if t["name"] == name]
    assert match, f"{name} is not registered"
    return match[0]


# ---- registration ---------------------------------------------------------
@pytest.mark.parametrize("name", [
    "catgo_adsorption_sites",
    "catgo_adsorption_place",
    "catgo_place_dual_adsorbates",
    "catgo_doping",
    "catgo_substitution",
    "catgo_intercalation",
])
def test_tools_the_agent_is_told_to_call_are_registered(name):
    # catbot.md and the structure-builder / surface-catalysis skills instruct
    # CatBot to call these by name.
    _tool(name)


def test_no_duplicate_tool_names():
    names = [t["name"] for t in TOOLS]
    assert len(names) == len(set(names)), \
        f"duplicates: {sorted({n for n in names if names.count(n) > 1})}"


def test_every_endpoint_resolves_under_the_api_root():
    # A missing leading slash silently produced ".../apikmc/simulate".
    for t in TOOLS:
        ep = t.get("endpoint", "")
        if not ep or ep.startswith("__direct__/") or ep.startswith("__special__/"):
            continue
        url = f"{mcp_server.API_BASE}/{ep.lstrip('/')}"
        assert url.startswith(mcp_server.API_BASE + "/"), (t["name"], ep)
        assert "//" not in url.split("://", 1)[1], (t["name"], url)


# ---- dispatch behaviour ---------------------------------------------------
class _Resp:
    def __init__(self, payload, status=200):
        self._payload = payload
        self.status_code = status
        self.text = json.dumps(payload)

    def json(self):
        return self._payload


class _FakeClient:
    """Records every request the dispatcher makes."""

    def __init__(self, payload):
        self.payload = payload
        self.calls = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get(self, url, params=None):
        self.calls.append(("GET", url, {"params": params}))
        return _Resp(self.payload)

    async def post(self, url, params=None, json=None):
        self.calls.append(("POST", url, {"params": params, "json": json}))
        return _Resp(self.payload)


@pytest.fixture
def fake_http(monkeypatch):
    holder = {}

    def factory(payload):
        client = _FakeClient(payload)
        holder["client"] = client
        monkeypatch.setattr(
            mcp_server.httpx, "AsyncClient", lambda *a, **k: client
        )
        return client

    return factory


def _text(result):
    return "\n".join(c.text for c in result)


@pytest.mark.asyncio
async def test_query_param_route_is_not_sent_as_a_json_body(fake_http):
    # /dos/from-directory takes bare scalars -> FastAPI reads the query string.
    client = fake_http({"session_id": "d-1", "elements": ["Pt"]})

    await mcp_server.handle_call_tool(
        "catgo_dos_from_dir", {"session_id": "hpc-1", "remote_path": "/scratch/run"}
    )

    posts = [c for c in client.calls if c[0] == "POST" and "from-directory" in c[1]]
    assert posts, client.calls
    _, _, kw = posts[0]
    assert kw["params"] == {"session_id": "hpc-1", "remote_path": "/scratch/run"}
    assert kw["json"] is None


@pytest.mark.asyncio
async def test_a_session_handle_survives_the_response_summary(fake_http):
    # The response carries geometry AND the session_id the next call needs;
    # summarizing it away stranded the agent.
    fake_http({"session_id": "d-9", "structure": {"sites": [{"label": "Pt"}]}})

    out = _text(await mcp_server.handle_call_tool(
        "catgo_dos_from_dir", {"session_id": "h", "remote_path": "/p"}
    ))

    assert "d-9" in out


@pytest.mark.asyncio
async def test_a_pure_builder_pushes_its_geometry_to_the_viewer(fake_http):
    # catgo_passivate consumes `slab`+`bulk`, never `structure`, so the old
    # `needs_structure` gate meant it built a slab and displayed nothing.
    client = fake_http({"structure": {"sites": [{"label": "H"}]}})

    await mcp_server.handle_call_tool(
        "catgo_passivate", {"slab": {"sites": []}, "bulk": {"sites": []}}
    )

    assert any("/view/structure/push" in c[1] for c in client.calls), client.calls


@pytest.mark.asyncio
async def test_a_build_result_list_pushes_its_first_structure(fake_http):
    # BuildResult{structures:[...]} — defect / doping / substitution / strain.
    client = fake_http({"structures": [{"sites": [{"label": "V"}]}], "count": 1})

    await mcp_server.handle_call_tool(
        "catgo_build_defect", {"structure": {"sites": []}, "defect_type": "vacancy"}
    )

    pushed = [c for c in client.calls if "/view/structure/push" in c[1]]
    assert pushed, client.calls
    assert pushed[0][2]["json"]["structure"]["sites"][0]["label"] == "V"


@pytest.mark.asyncio
async def test_a_response_with_no_geometry_pushes_nothing(fake_http):
    client = fake_http({"frequencies": [1200.0, 3400.0]})

    await mcp_server.handle_call_tool("catgo_freq_parse", {"path": "/tmp/x"})

    assert not [c for c in client.calls if "/view/structure/push" in c[1]]


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))

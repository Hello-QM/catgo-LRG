"""The agent side of agent↔viewer adaptation.

Two halves have to agree: what the code now does, and what CatBot is told it can
do. An agent whose prompt still says "the user must upload the file first" will
keep asking for an upload no matter how good the transport is — the capability
and the instructions are one feature, not two.

Also covers the reverse direction: a session the USER loaded used to be
invisible to the agent (the frontend registry is write-only), so it could not
act on data already on screen.
"""

import importlib
import time

import pytest
from fastapi.testclient import TestClient
from fastapi import FastAPI

from catgo.routers import view_capture

REPO = __import__("pathlib").Path(__file__).resolve().parents[2]
AGENT_MD = REPO / "catbot-plugin" / "agents" / "catbot.md"
SKILLS = REPO / "catbot-plugin" / "skills"


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(view_capture.router, prefix="/api")
    return TestClient(app)


# ---- the agent's own instructions must match what the code does ------------
def test_the_agent_is_no_longer_told_that_analysis_needs_a_manual_upload():
    text = AGENT_MD.read_text(encoding="utf-8")
    assert "require the user to first upload" not in text, (
        "catbot.md still documents the pre-fix limitation; the agent will keep "
        "asking for an upload instead of loading from the cluster itself"
    )
    assert "catgo_dos_from_dir" in text
    skill = (SKILLS / "electronic-analysis" / "SKILL.md").read_text(encoding="utf-8")
    assert "opens in the Analysis panel" in skill


def test_the_agent_is_told_which_tools_cannot_be_auto_filled():
    # helpers.py injects the viewer structure only for an input literally named
    # `structure`; the skill used to claim every builder auto-fetches it.
    skill = (SKILLS / "structure-builder" / "SKILL.md").read_text(encoding="utf-8")
    for tool in ("catgo_passivate", "catgo_hetero_build", "catgo_merge"):
        assert tool in skill, tool
    assert "auto-filled" in skill or "cannot be auto" in skill


def test_the_agent_knows_its_results_are_already_on_screen():
    text = AGENT_MD.read_text(encoding="utf-8")
    assert "Results tab" in text and "catgo_screenshot" in text


# ---- reverse direction: the agent can see sessions it did not create -------
def test_a_session_the_user_loaded_is_discoverable(client, monkeypatch):
    dos = importlib.import_module("catgo.routers.dos")
    cohp = importlib.import_module("catgo.routers.cohp")

    class _Sess:
        timestamp = time.time()
        source = "h5"

    monkeypatch.setitem(dos._sessions, "dos-user-1", _Sess())
    monkeypatch.setitem(cohp._sessions, "cohp-user-1", ({"bonds": []}, time.time()))

    body = client.get("/api/view/analysis-sessions").json()

    found = {(s["kind"], s["session_id"]) for s in body["sessions"]}
    assert ("dos", "dos-user-1") in found
    assert ("cohp", "cohp-user-1") in found
    assert body["count"] == len(body["sessions"])
    dos_row = next(s for s in body["sessions"] if s["session_id"] == "dos-user-1")
    assert dos_row["source"] == "h5" and dos_row["age_seconds"] >= 0


def test_listing_is_empty_not_broken_when_nothing_is_loaded(client):
    body = client.get("/api/view/analysis-sessions").json()
    assert isinstance(body["sessions"], list)


def test_the_tool_that_exposes_it_is_registered():
    tools = importlib.import_module("catgo.mcp_tools.tools").TOOLS
    tool = next(t for t in tools if t["name"] == "catgo_analysis_sessions")
    assert tool["method"] == "GET" and tool["endpoint"] == "/view/analysis-sessions"


# ---- the result channel the stdio server depends on ------------------------
def test_result_push_rejects_a_payload_the_viewer_could_not_render(client):
    assert client.post("/api/view/result/push", json={"kind": "volcano"}).status_code == 400
    assert client.post("/api/view/result/push", json={"payload": {}}).status_code == 400
    ok = client.post("/api/view/result/push", json={"kind": "volcano", "payload": {"points": []}})
    assert ok.status_code == 200 and ok.json()["ok"] is True


# ---- the output_type contract the server advertises must be honoured --------
@pytest.mark.asyncio
@pytest.mark.parametrize("output_type,payload,expect_path,expect_kind", [
    ("structure", {"sites": [{"label": "Pt"}]}, "/view/structure/push", None),
    ("electronic_dos", {"session_id": "d-1", "efermi": 0.0}, "/view/analysis/push", "dos"),
    ("cohp", {"session_id": "c-1"}, "/view/analysis/push", "cohp"),
    ("bar_plot", {"series": [{"label": "a", "values": [1.0]}]}, "/view/result/push", "bar_plot"),
    ("table", {"columns": ["a"], "rows": [[1]]}, "/view/result/push", "table"),
    ("atom_property", {"property_name": "q", "values": [0.1]}, "/view/result/push", "atom_property"),
])
async def test_a_declared_output_type_reaches_its_surface(
    output_type, payload, expect_path, expect_kind, monkeypatch
):
    # `structure: ... (auto-pushed to 3D viewer)` is advertised in the server's
    # own tool description; the plot/spectrum types exist so a result can be
    # RENDERED. Every registry tool and non-structure plugin reader dropped its
    # payload into the transcript instead.
    mcp_server = importlib.import_module("catgo.mcp_tools.server")
    calls = []

    class _Client:
        async def __aenter__(self): return self
        async def __aexit__(self, *exc): return False
        async def post(self, url, params=None, json=None):
            calls.append((url, json))
            class _R:
                status_code = 200
                text = "{}"
                def json(self_inner): return {}
            return _R()

    monkeypatch.setattr(mcp_server.httpx, "AsyncClient", lambda *a, **k: _Client())
    await mcp_server._publish_tool_output(output_type, payload)

    assert calls, f"{output_type} published nothing"
    url, body = calls[0]
    assert expect_path in url, (output_type, url)
    if expect_kind:
        assert body["kind"] == expect_kind


@pytest.mark.asyncio
async def test_a_spectrum_with_no_session_falls_back_to_the_results_surface(monkeypatch):
    # A reader can emit DOS arrays without minting a backend session; those
    # cannot be adopted by the pane, but they must not vanish either.
    mcp_server = importlib.import_module("catgo.mcp_tools.server")
    calls = []

    class _Client:
        async def __aenter__(self): return self
        async def __aexit__(self, *exc): return False
        async def post(self, url, params=None, json=None):
            calls.append(url)
            class _R:
                status_code = 200
            return _R()

    monkeypatch.setattr(mcp_server.httpx, "AsyncClient", lambda *a, **k: _Client())
    await mcp_server._publish_tool_output("electronic_dos", {"energies": [0.0, 1.0]})

    assert calls and "/view/result/push" in calls[0]


@pytest.mark.asyncio
async def test_publishing_never_fails_the_tool_that_produced_the_data(monkeypatch):
    mcp_server = importlib.import_module("catgo.mcp_tools.server")

    def _explode(*a, **k):
        raise RuntimeError("backend down")

    monkeypatch.setattr(mcp_server.httpx, "AsyncClient", _explode)
    await mcp_server._publish_tool_output("table", {"columns": [], "rows": []})  # no raise


def test_analysis_push_rejects_a_session_the_pane_could_not_adopt(client):
    assert client.post("/api/view/analysis/push", json={"kind": "dos"}).status_code == 400
    assert client.post(
        "/api/view/analysis/push", json={"kind": "dos", "session": {}}
    ).status_code == 400
    ok = client.post(
        "/api/view/analysis/push", json={"kind": "dos", "session": {"session_id": "d-9"}}
    )
    assert ok.status_code == 200 and ok.json()["ok"] is True


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))

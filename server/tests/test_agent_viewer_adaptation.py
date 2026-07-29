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


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))

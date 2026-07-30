"""The adversarial-review items that were recorded as open, now closed.

Each one is a way the display path stays wrong long after the run that caused
it has finished: a stale trajectory replayed forever, a pane bound to a session
it cannot render, or one mutation executed twice.
"""

import asyncio

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from catgo.routers import view_capture, view_state


def setup_function():
    view_state.reset()
    view_state.panel_subscribers.clear()


def teardown_function():
    view_state.reset()
    view_state.panel_subscribers.clear()


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(view_capture.router, prefix="/api")
    return TestClient(app)


# ---- a stored trajectory must not be replayed forever ---------------------
def test_a_stale_trajectory_is_not_replayed_on_reconnect(monkeypatch):
    # The SSE reconnect path yields the stored trajectory verbatim, so without a
    # TTL a refresh loop re-sends the same multi-MB path indefinitely.
    view_state.push_trajectory("default", "2\nf\nH 0 0 0\nH 0 0 1\n", "neb.xyz")
    assert view_state.get_trajectory("default")["filename"] == "neb.xyz"

    entry = view_state.panel_trajectories["default"]
    entry["ts"] -= view_state.TRAJECTORY_TTL_SECONDS + 1

    assert view_state.get_trajectory("default") is None
    assert "default" not in view_state.panel_trajectories


def test_a_fresh_trajectory_survives_and_hides_its_bookkeeping():
    view_state.push_trajectory("default", "2\nf\nH 0 0 0\nH 0 0 1\n", "neb.xyz")
    got = view_state.get_trajectory("default")
    # the reconnect path yields this dict straight to the client
    assert set(got) == {"content", "filename"}


def test_pushing_expires_other_panels_too():
    view_state.push_trajectory("p1", "2\nf\nH 0 0 0\nH 0 0 1\n", "a.xyz")
    view_state.panel_trajectories["p1"]["ts"] -= view_state.TRAJECTORY_TTL_SECONDS + 1
    view_state.push_trajectory("p2", "2\nf\nH 0 0 0\nH 0 0 1\n", "b.xyz")
    assert "p1" not in view_state.panel_trajectories
    assert "p2" in view_state.panel_trajectories


# ---- a pane cannot adopt a session it cannot render ------------------------
def test_a_stub_session_is_refused(client):
    # The pane binds this object to `initial_session` and renders from it; an id
    # alone produces an analysis panel wired to nothing.
    r = client.post("/api/view/analysis/push",
                    json={"kind": "dos", "session": {"session_id": "d-1"}})
    assert r.status_code == 400
    assert "missing" in r.json()["detail"]


@pytest.mark.parametrize("kind,session", [
    ("dos", {"session_id": "d", "nions": 4, "elements": ["Pt"], "efermi": -2.5}),
    ("bands", {"session_id": "b", "nbands": 20, "nkpts": 40, "efermi": 0.1,
               "elements": ["Ir"]}),
    ("cohp", {"session_id": "c", "efermi": -1.0, "all_bonds": []}),
])
def test_a_renderable_session_is_accepted(client, kind, session):
    r = client.post("/api/view/analysis/push", json={"kind": kind, "session": session})
    assert r.status_code == 200, r.json()


def test_an_unknown_kind_is_refused_rather_than_announced(client):
    r = client.post("/api/view/analysis/push",
                    json={"kind": "raman", "session": {"session_id": "x"}})
    assert r.status_code == 400 and "unknown analysis kind" in r.json()["detail"]


# ---- a command must be executed by exactly one viewer ---------------------
def test_a_command_reaches_exactly_one_viewer():
    # _subscriber_keys deliberately includes the tab alias next to the resolved
    # pane. For an event that is a NOTIFICATION that is correct; for one that
    # MUTATES the structure it means two panes apply the same edit.
    async def scenario():
        view_state.mark_active("tabX:leafA")
        pane = view_state.subscribe("tabX:leafA")
        alias = view_state.subscribe("tabX")

        task = asyncio.create_task(
            view_state.request_viewer_command("tabX", "delete_atoms", {"indices": [0]},
                                              timeout=0.3)
        )
        await asyncio.sleep(0.05)
        delivered = [q for q in (pane, alias) if not q.empty()]
        assert len(delivered) == 1, "the mutation was handed to two viewers"
        assert delivered[0] is pane, "the addressed pane should win over the alias"
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass

    asyncio.run(scenario())


def test_a_notification_still_reaches_both_listeners():
    # The global App.svelte listener and the pane both need structure events.
    async def scenario():
        view_state.mark_active("tabX:leafA")
        pane = view_state.subscribe("tabX:leafA")
        alias = view_state.subscribe("tabX")

        view_state.notify_structure("tabX", {"sites": []})
        await asyncio.sleep(0)
        assert not pane.empty() and not alias.empty()

    asyncio.run(scenario())


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))

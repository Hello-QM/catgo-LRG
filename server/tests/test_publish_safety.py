"""Defects an adversarial review of the auto-visualisation work turned up.

Each test names the failure it exists to prevent. They are grouped by the
property that was violated, not by the file that was changed.
"""

import asyncio
import importlib
import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from catgo.routers import view_capture, view_state
from catgo.workflow.engine import result_handler

mcp_server = importlib.import_module("catgo.mcp_tools.server")


def setup_function():
    view_state.reset()
    # `reset()` deliberately does NOT drop SSE subscribers — /view/reset is
    # called by a starting frontend and must not deafen panes that are already
    # connected. Tests in other modules leak them, so isolate here.
    view_state.panel_subscribers.clear()


def teardown_function():
    view_state.reset()
    view_state.panel_subscribers.clear()


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(view_capture.router, prefix="/api")
    return TestClient(app)


class _Recorder:
    """Captures the HTTP calls the stdio server would make."""

    def __init__(self):
        self.calls = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, params=None, json=None):
        self.calls.append((url, params, json))

        class _R:
            status_code = 200
            text = "{}"

            def json(self_inner):
                return {}

        return _R()


@pytest.fixture
def recorder(monkeypatch):
    rec = _Recorder()
    monkeypatch.setattr(mcp_server.httpx, "AsyncClient", lambda *a, **k: rec)
    return rec


# ---- a background job must not touch the pane the human is using -----------
def test_a_finished_job_does_not_delete_the_structure_the_user_is_editing():
    # push_trajectory POPS panel_structures for its target. Aimed at
    # `last_active_panel_id` — by definition the pane the human is touching — a
    # job finishing in the background would delete the geometry under them, and
    # the next auto-injected "current structure" would silently be another
    # pane's.
    editing = "tab7:leafA"
    view_state.mark_active(editing)
    view_state.push_structure({"sites": [{"label": "Pt"}]}, panel_id=editing)

    class _Conn:
        class _Inner:
            def run(self, cmd, check=False):
                class _R:
                    exit_status = 0
                    stdout = ("2\nf\nH 0 0 0\nH 0 0 1\n" if cmd.startswith("cat")
                              else "40")
                return _R()

        @property
        def conn(self):
            return self._Inner()

        async def run_on_owner(self, fn):
            return fn()

    asyncio.run(result_handler._publish_path_trajectory(
        _Conn(), "/scratch/run", "t-1", "orca_neb_ts"
    ))

    assert view_state.get_structure(editing), "the user's structure was deleted"
    assert view_state.get_trajectory("default"), "the path went nowhere"


def test_a_display_failure_cannot_replace_committed_results_with_an_error_row(monkeypatch):
    # store_result is INSERT OR REPLACE and the collector's except-handler writes
    # an error row over the good one. A display side-effect inside that scope
    # could therefore destroy the science it was meant to show.
    writes = []

    class _DB:
        def store_result(self, task_id, workflow_id, **fields):
            writes.append(fields)

    async def good_collector(*a, **k):
        return json.dumps({"energy": -876.5})

    async def exploding_publish(*a, **k):
        raise RuntimeError("viewer exploded")

    monkeypatch.setattr(result_handler, "collect_orca_neb_results", good_collector)
    monkeypatch.setattr(result_handler, "_read_neb_ts_structure",
                        lambda *a, **k: asyncio.sleep(0, result=None))
    monkeypatch.setattr(result_handler, "_publish_path_trajectory", exploding_publish)

    task = {"id": "task-1", "task_type": "orca_neb_ts", "work_dir": "/w",
            "workflow_id": "wf", "params_json": "{}"}

    with pytest.raises(RuntimeError):
        asyncio.run(result_handler.on_task_completed(_DB(), task, object()))

    assert len(writes) == 1, "the display failure triggered a second, overwriting write"
    assert "error" not in (writes[0].get("outputs_json") or "")
    assert "-876.5" in writes[0]["outputs_json"]


# ---- what we call a structure must be one -------------------------------
def test_an_error_dict_from_a_structure_tool_is_not_pushed_as_geometry(recorder):
    # A reader declaring output_type=structure can still return an error dict.
    # Pushed to the store it becomes every later tool's auto-injected structure.
    asyncio.run(mcp_server._publish_tool_output(
        "structure", {"warning": "no coordinates found", "n_frames": 0}
    ))
    assert not [c for c in recorder.calls if "structure/push" in c[0]]


def test_a_real_structure_is_pushed_on_BOTH_legs(recorder):
    # /structure/push seeds the store but emits no SSE — its own docstring says
    # so. Without the pending-update leg nothing is displayed.
    asyncio.run(mcp_server._publish_tool_output(
        "structure", {"sites": [{"label": "Pt"}]}
    ))
    urls = [c[0] for c in recorder.calls]
    assert any("structure/push" in u for u in urls)
    assert any("structure/pending-update" in u for u in urls), "no SSE leg — nothing displays"


# ---- an analysis response must not clobber the viewer ---------------------
@pytest.mark.asyncio
async def test_a_dos_session_response_does_not_replace_the_users_geometry(monkeypatch):
    # DOSUploadResponse carries the run's structure alongside the session. The
    # analysis event already hands the pane that geometry with adoption
    # semantics; pushing it here would replace a hand-edited slab in place.
    rec = _Recorder()
    payload = {"session_id": "d-1", "structure": {"sites": [{"label": "Ir"}]}}

    class _C(_Recorder):
        async def post(self, url, params=None, json=None):
            await super().post(url, params=params, json=json)
            return await _Recorder.post(rec, url, params=params, json=json)

        async def get(self, url, params=None):
            class _R:
                status_code = 200
                text = json_mod.dumps(payload)

                def json(self_inner):
                    return payload
            return _R()

    import json as json_mod

    client = _C()

    class _Resp:
        status_code = 200
        text = json_mod.dumps(payload)

        def json(self):
            return payload

    async def _post(url, params=None, json=None):
        client.calls.append((url, params, json))
        return _Resp()

    client.post = _post
    monkeypatch.setattr(mcp_server.httpx, "AsyncClient", lambda *a, **k: client)

    await mcp_server.handle_call_tool(
        "catgo_dos_from_dir", {"session_id": "h", "remote_path": "/p"}
    )

    assert not [c for c in client.calls if "structure/push" in c[0]], \
        "an analysis response overwrote the viewer's structure"


# ---- a list result keeps the labels the agent needs ----------------------
@pytest.mark.asyncio
async def test_a_multi_candidate_build_keeps_its_labels(monkeypatch):
    payload = {"structures": [{"sites": [{"label": "V"}]}, {"sites": []}],
               "labels": ["vac_0", "vac_1"], "count": 2}

    class _C(_Recorder):
        pass

    client = _C()

    class _Resp:
        status_code = 200
        text = json.dumps(payload)

        def json(self):
            return payload

    async def _post(url, params=None, json_=None, json=None):
        client.calls.append((url, params, json))
        return _Resp()

    client.post = _post
    monkeypatch.setattr(mcp_server.httpx, "AsyncClient", lambda *a, **k: client)

    out = await mcp_server.handle_call_tool(
        "catgo_build_defect", {"structure": {"sites": []}, "defect_type": "vacancy"}
    )
    text = "\n".join(c.text for c in out)

    assert "vac_1" in text, "the summarizer dropped the candidate labels"
    assert any("structure/push" in c[0] for c in client.calls), "candidate 0 was not shown"


# ---- an event is a summary, not a data transfer --------------------------
def test_an_oversized_result_is_refused_instead_of_stalling_the_event_loop(client):
    huge = {"pdos": [float(i) for i in range(200_000)]}
    r = client.post("/api/view/result/push", json={"kind": "electronic_dos", "payload": huge})
    assert r.status_code == 413

    ok = client.post("/api/view/result/push",
                     json={"kind": "kinetics", "payload": {"tof": {"CO2": 1.0}}})
    assert ok.status_code == 200


def test_an_oversized_session_is_refused(client):
    huge = {"session_id": "d", "densities": [float(i) for i in range(200_000)]}
    assert client.post("/api/view/analysis/push",
                       json={"kind": "dos", "session": huge}).status_code == 413


# ---- no work when nobody is watching -------------------------------------
def test_a_node_result_does_no_parsing_when_no_one_is_subscribed(monkeypatch):
    from catgo.workflow import viewer_publish

    called = {"n": 0}
    real = viewer_publish.build_payload

    def counting(*a, **k):
        called["n"] += 1
        return real(*a, **k)

    monkeypatch.setattr(viewer_publish, "build_payload", counting)
    view_state.mark_active("default")  # no subscribers

    viewer_publish.announce_node_result("t", "wf", {"outputs_json": json.dumps({"energy": 1})})
    assert called["n"] == 0, "parsed a multi-MB payload with nobody watching"

    view_state.subscribe("default")
    viewer_publish.announce_node_result("t", "wf", {"outputs_json": json.dumps({"energy": 1})})
    assert called["n"] == 1


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))

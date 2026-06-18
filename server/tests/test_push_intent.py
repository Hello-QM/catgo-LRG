"""Tests for load/edit `intent` plumbing through the structure push → SSE.

When CatBot LOADS a new structure into a viewer that already shows one, a
later UI task gates on an `intent` tag carried in the SSE `structure` event.
This module covers the backend plumbing that threads `intent` from the emit
helpers (`notify_structure`, `push_structure`) into the event payload.
Default is "edit" so every existing caller is unchanged (back-compat).
"""

import sys
from pathlib import Path

_d = str(Path(__file__).resolve().parent.parent)
if _d not in sys.path:
    sys.path.insert(0, _d)

from catgo.routers import view_state


def test_notify_structure_default_intent_edit(monkeypatch):
    seen = {}
    monkeypatch.setattr(
        view_state, "_notify",
        lambda pid, ev, data: seen.update(ev=ev, data=data),
    )
    view_state.notify_structure("p1", {"sites": []})
    assert seen["ev"] == "structure"
    assert seen["data"]["intent"] == "edit"


def test_notify_structure_load_intent(monkeypatch):
    seen = {}
    monkeypatch.setattr(
        view_state, "_notify",
        lambda pid, ev, data: seen.update(data=data),
    )
    view_state.notify_structure("p1", {"sites": []}, intent="load")
    assert seen["data"]["intent"] == "load"


def test_push_structure_default_intent_edit(monkeypatch):
    seen = {}
    monkeypatch.setattr(
        view_state, "_notify",
        lambda pid, ev, data: seen.update(ev=ev, data=data),
    )
    view_state.push_structure({"sites": []}, panel_id="p1")
    assert seen["ev"] == "structure"
    assert seen["data"]["intent"] == "edit"


def test_push_structure_load_intent(monkeypatch):
    seen = {}
    monkeypatch.setattr(
        view_state, "_notify",
        lambda pid, ev, data: seen.update(data=data),
    )
    view_state.push_structure({"sites": []}, panel_id="p1", intent="load")
    assert seen["data"]["intent"] == "load"


def test_upload_and_load_route_tags_intent_load(monkeypatch):
    """The PREFERRED file-load path (POST /view/upload-and-load) must tag
    its push as a LOAD — loading a brand-new structure from disk should
    prompt, not silently overwrite the viewer's current structure.

    Calls the route handler directly with a real UploadFile (no TestClient
    / FastAPI app import / SSE / MCP-patch scaffolding); monkeypatches
    push_structure to capture the intent it threads through.
    """
    import asyncio
    import io

    from starlette.datastructures import UploadFile

    from catgo.routers import view_capture

    captured = {}
    monkeypatch.setattr(
        view_capture.view_state, "push_structure",
        lambda sd, pid, intent="edit", **kw: captured.update(intent=intent, pid=pid),
    )

    xyz = b"2\n\nH 0.0 0.0 0.0\nH 0.0 0.0 0.74\n"
    uf = UploadFile(filename="mol.xyz", file=io.BytesIO(xyz))
    res = asyncio.run(view_capture.upload_and_load(file=uf, panel_id="default"))

    assert res["status"] == "ok"
    assert captured["intent"] == "load"
    assert captured["pid"] == "default"

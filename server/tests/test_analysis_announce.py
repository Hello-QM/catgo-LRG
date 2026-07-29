"""Analysis sessions an agent creates must reach the viewer.

The gap under test: DOS/bands/COHP panes adopt a session only when a HUMAN
uploads a file, so a spectrum CatBot computed existed only as text in a tool
response. `announce_analysis` publishes the session on the panel SSE bus that
already carries structure pushes, and the pane adopts it as `initial_session`.
"""

import asyncio

import pytest

from catgo.routers import view_state


def setup_function():
    view_state.reset()


def teardown_function():
    view_state.reset()


def _drain(q: asyncio.Queue) -> list[dict]:
    out = []
    while not q.empty():
        out.append(q.get_nowait())
    return out


def _session(session_id: str = "s-1", **extra) -> dict:
    return {"session_id": session_id, "efermi": 1.5, **extra}


def test_announce_reaches_the_panel_the_user_is_on():
    # A producer (dos.py) has no tab context: an MCP stdio call and an HPC
    # callback both arrive header-less, so the fallback must be the active panel.
    view_state.mark_active("structure-1")
    q = view_state.subscribe("structure-1")

    view_state.announce_analysis("dos", _session("dos-42"))

    events = _drain(q)
    assert [e["event"] for e in events] == ["analysis"]
    assert events[0]["data"]["kind"] == "dos"
    assert events[0]["data"]["session"]["session_id"] == "dos-42"


def test_announce_routes_a_legacy_tab_id_to_its_active_viewer():
    viewer_id = "structure-1:leaf-7"
    view_state.mark_active(viewer_id)
    q = view_state.subscribe(viewer_id)

    view_state.announce_analysis("bands", _session("b-1"), panel_id="structure-1")

    assert [e["data"]["kind"] for e in _drain(q)] == ["bands"]


def test_announce_accepts_a_pydantic_response_model():
    # Producers return their upload-response MODEL, not a dict. The payload must
    # be the model's own fields — nothing re-derived — so the pane sees exactly
    # what the parser produced.
    pydantic = pytest.importorskip("pydantic")

    class Resp(pydantic.BaseModel):
        session_id: str
        efermi: float

    view_state.mark_active("default")
    q = view_state.subscribe("default")

    view_state.announce_analysis("cohp", Resp(session_id="c-9", efermi=-3.25))

    payload = _drain(q)[0]["data"]["session"]
    assert payload["session_id"] == "c-9" and payload["efermi"] == -3.25


@pytest.mark.parametrize(
    "bad", [None, {}, {"efermi": 1.0}, "not-a-session", 42, object()]
)
def test_a_payload_without_a_session_id_emits_nothing(bad):
    # An un-adoptable payload must not produce an event: the frontend would open
    # an analysis pane bound to nothing.
    view_state.mark_active("default")
    q = view_state.subscribe("default")

    view_state.announce_analysis("dos", bad)

    assert _drain(q) == []


def test_display_failure_never_breaks_the_computation():
    # announce is a side-effect of a successful parse; if the bus misbehaves the
    # caller must still return its result.
    view_state.mark_active("default")

    class Exploding:
        def model_dump(self):
            raise RuntimeError("boom")

    view_state.announce_analysis("dos", Exploding())  # must not raise


def test_a_full_subscriber_queue_does_not_raise():
    q = view_state.subscribe("default")
    for _ in range(q.maxsize):
        q.put_nowait({"event": "filler", "data": {}})

    view_state.announce_analysis("dos", _session())  # dropped, not raised

    assert q.qsize() == q.maxsize


def test_dos_session_factory_announces_what_it_returns():
    # The single convergence point: upload / from-remote / from-directory all
    # build their session here, so hooking it covers the agent path too.
    numpy = pytest.importorskip("numpy")
    dos = pytest.importorskip("catgo.routers.dos")

    class FakeVaspData:
        nions = 1
        nkpts = 2
        nbands = 3
        nchannels = 4
        nspin = 1
        elements = numpy.array(["Pt"])
        ion_types = ["Pt"]
        ion_counts = [1]
        efermi = -2.5
        lattice = numpy.eye(3) * 4.0
        positions = numpy.zeros((1, 3))
        positions_frac = numpy.zeros((1, 3))

    view_state.mark_active("default")
    q = view_state.subscribe("default")

    response = dos._create_session(FakeVaspData(), source="h5")

    events = _drain(q)
    assert [e["data"]["kind"] for e in events] == ["dos"]
    announced = events[0]["data"]["session"]
    assert announced["session_id"] == response.session_id
    # the announced payload carries what the pane needs to render without a
    # second round-trip: geometry + Fermi level + per-element ion counts
    assert announced["efermi"] == -2.5
    assert announced["elements"] == ["Pt"]
    assert announced["structure"]["sites"][0]["label"] == "Pt"


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))

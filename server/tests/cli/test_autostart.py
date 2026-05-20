import sys
import pytest
from catgo.cli._autostart import spawn_daemon_and_wait
from catgo.cli.adapter import OpError


class _FakeProc:
    def __init__(self):
        self.stderr = None


def test_spawn_succeeds_when_health_responds(monkeypatch):
    from catgo.cli import _autostart, server_link
    popen_calls = {}
    def _popen(cmd, **kw):
        popen_calls["cmd"] = cmd
        popen_calls["start_new_session"] = kw.get("start_new_session")
        return _FakeProc()
    monkeypatch.setattr(_autostart.subprocess, "Popen", _popen)
    monkeypatch.setattr(_autostart.time, "sleep", lambda s: None)
    monkeypatch.setattr(
        server_link.ServerLink, "discover",
        classmethod(lambda cls: server_link.ServerLink(
            base_url="http://localhost:8000")))
    link = spawn_daemon_and_wait(timeout=20.0)
    assert link.base_url == "http://localhost:8000"
    assert popen_calls["cmd"] == [sys.executable, "-m", "catgo",
                                   "serve", "--daemon"]
    assert popen_calls["start_new_session"] is True


def test_spawn_times_out_raises_operror(monkeypatch):
    from catgo.cli import _autostart, server_link
    monkeypatch.setattr(_autostart.subprocess, "Popen",
                        lambda *a, **k: _FakeProc())
    monkeypatch.setattr(_autostart.time, "sleep", lambda s: None)
    monkeypatch.setattr(server_link.ServerLink, "discover",
                        classmethod(lambda cls: None))
    with pytest.raises(OpError) as ei:
        spawn_daemon_and_wait(timeout=0.05)
    assert "failed to start" in str(ei.value).lower()

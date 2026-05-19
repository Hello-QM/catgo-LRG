import pytest
from catgo.cli.server_link import ServerLink


def test_discover_finds_8000(monkeypatch):
    from catgo.cli import server_link
    monkeypatch.setattr(server_link, "_ping",
                        lambda url: url == "http://localhost:8000/health")
    link = ServerLink.discover()
    assert link is not None
    assert link.base_url == "http://localhost:8000"


def test_discover_falls_back_to_33413(monkeypatch):
    from catgo.cli import server_link
    monkeypatch.setattr(server_link, "_ping",
                        lambda url: url == "http://localhost:33413/health")
    link = ServerLink.discover()
    assert link is not None
    assert link.base_url == "http://localhost:33413"


def test_discover_returns_none_when_both_down(monkeypatch):
    from catgo.cli import server_link
    monkeypatch.setattr(server_link, "_ping", lambda url: False)
    assert ServerLink.discover() is None


import io
import urllib.error


class _FakeResponse:
    def __init__(self, body: bytes, status: int = 200):
        self._body = body
        self.status = status
    def read(self) -> bytes:
        return self._body
    def __enter__(self): return self
    def __exit__(self, *a): pass


def test_push_structure_posts_multipart(monkeypatch, tmp_path):
    from catgo.cli import server_link
    calls = {}
    def _urlopen(req, timeout=None):
        calls["url"] = req.full_url
        calls["method"] = req.get_method()
        calls["content_type"] = req.headers.get("Content-type", "")
        calls["body"] = req.data
        return _FakeResponse(b'{"panel_id": "default", "num_sites": 4}')
    monkeypatch.setattr(server_link.urllib.request, "urlopen", _urlopen)
    p = tmp_path / "x.vasp"; p.write_bytes(b"POSCAR\n1.0\n")
    link = server_link.ServerLink(base_url="http://localhost:8000")
    resp = link.push_structure(p, panel_id="default")
    assert calls["method"] == "POST"
    assert calls["url"].startswith(
        "http://localhost:8000/api/view/upload-and-load")
    assert "panel_id=default" in calls["url"]
    assert calls["content_type"].startswith("multipart/form-data; boundary=")
    assert b'filename="x.vasp"' in calls["body"]
    assert b"POSCAR" in calls["body"]
    assert resp == {"panel_id": "default", "num_sites": 4}


def test_push_structure_4xx_raises_operror(monkeypatch, tmp_path):
    from catgo.cli import server_link
    from catgo.cli.adapter import OpError
    err_body = b'{"detail": "bad file"}'
    def _urlopen(req, timeout=None):
        raise urllib.error.HTTPError(
            req.full_url, 400, "Bad Request", {},
            io.BytesIO(err_body))
    monkeypatch.setattr(server_link.urllib.request, "urlopen", _urlopen)
    p = tmp_path / "x.vasp"; p.write_bytes(b"x")
    link = server_link.ServerLink(base_url="http://localhost:8000")
    with pytest.raises(OpError) as ei:
        link.push_structure(p, panel_id=None)
    assert "bad file" in str(ei.value)

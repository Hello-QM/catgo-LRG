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


def test_pull_structure_get_with_format(monkeypatch):
    from catgo.cli import server_link
    calls = {}
    def _urlopen(req, timeout=None):
        calls["url"] = req.full_url
        calls["method"] = req.get_method()
        return _FakeResponse(b"POSCAR\n1.0\n...")
    monkeypatch.setattr(server_link.urllib.request, "urlopen", _urlopen)
    link = server_link.ServerLink(base_url="http://localhost:33413")
    data = link.pull_structure(fmt="poscar", panel_id="structure-1")
    assert calls["method"] == "GET"
    assert calls["url"].startswith(
        "http://localhost:33413/api/view/structure/export?format=poscar")
    assert "panel_id=structure-1" in calls["url"]
    assert data.startswith(b"POSCAR")


def test_push_structure_quotes_filename_with_double_quote(monkeypatch,
                                                          tmp_path):
    """C2 — RFC 7578: filename in Content-Disposition is a quoted-string;
    backslash and double-quote must be escaped. A filename containing `"`
    must serialise as filename="weird\\"name.vasp" (with the backslash
    literally in the bytes), not raw."""
    from catgo.cli import server_link
    captured = {}

    def _urlopen(req, timeout=None):
        captured["body"] = req.data
        return _FakeResponse(b'{"ok": 1}')

    monkeypatch.setattr(server_link.urllib.request, "urlopen", _urlopen)
    p = tmp_path / 'weird"name.vasp'
    try:
        p.write_bytes(b"POSCAR\n")
    except OSError:  # pragma: no cover — Linux/macOS allow `"` in names
        import pytest
        pytest.skip('filesystem rejects `"` in filename')
    link = server_link.ServerLink(base_url="http://localhost:8000")
    link.push_structure(p, panel_id=None)
    # Backslash-escaped double-quote in the rendered header.
    assert b'filename="weird\\"name.vasp"' in captured["body"]


def test_push_structure_quotes_filename_with_backslash(monkeypatch,
                                                      tmp_path):
    """C2 — backslashes in the filename must also be escaped (RFC 7578)."""
    from catgo.cli import server_link
    captured = {}

    def _urlopen(req, timeout=None):
        captured["body"] = req.data
        return _FakeResponse(b'{"ok": 1}')

    monkeypatch.setattr(server_link.urllib.request, "urlopen", _urlopen)
    p = tmp_path / "back\\slash.vasp"
    try:
        p.write_bytes(b"POSCAR\n")
    except OSError:  # pragma: no cover
        import pytest
        pytest.skip("filesystem rejects `\\` in filename")
    link = server_link.ServerLink(base_url="http://localhost:8000")
    link.push_structure(p, panel_id=None)
    assert b'filename="back\\\\slash.vasp"' in captured["body"]


def test_push_structure_urlerror_raises_operror(monkeypatch, tmp_path):
    """C3 — connection-level failures must surface as OpError with a clean
    message (no urllib traceback leak)."""
    from catgo.cli import server_link
    from catgo.cli.adapter import OpError

    def _urlopen(req, timeout=None):
        raise urllib.error.URLError("connection refused")

    monkeypatch.setattr(server_link.urllib.request, "urlopen", _urlopen)
    p = tmp_path / "x.vasp"
    p.write_bytes(b"x")
    link = server_link.ServerLink(base_url="http://localhost:8000")
    with pytest.raises(OpError) as ei:
        link.push_structure(p, panel_id=None)
    assert "connection failed" in str(ei.value)


def test_pull_structure_4xx_raises_operror(monkeypatch):
    """C3 — pull mirrors push: HTTPError → OpError carrying detail."""
    from catgo.cli import server_link
    from catgo.cli.adapter import OpError
    err_body = b'{"detail": "no panel"}'

    def _urlopen(req, timeout=None):
        raise urllib.error.HTTPError(
            req.full_url, 404, "Not Found", {}, io.BytesIO(err_body))

    monkeypatch.setattr(server_link.urllib.request, "urlopen", _urlopen)
    link = server_link.ServerLink(base_url="http://localhost:8000")
    with pytest.raises(OpError) as ei:
        link.pull_structure(fmt="poscar", panel_id="ghost")
    assert "no panel" in str(ei.value)


def test_pull_structure_urlerror_raises_operror(monkeypatch):
    """C3 — pull mirrors push for connection failures too."""
    from catgo.cli import server_link
    from catgo.cli.adapter import OpError

    def _urlopen(req, timeout=None):
        raise urllib.error.URLError("connection refused")

    monkeypatch.setattr(server_link.urllib.request, "urlopen", _urlopen)
    link = server_link.ServerLink(base_url="http://localhost:8000")
    with pytest.raises(OpError) as ei:
        link.pull_structure(fmt="poscar", panel_id=None)
    assert "connection failed" in str(ei.value)


def test_pull_structure_panel_omitted(monkeypatch):
    from catgo.cli import server_link
    calls = {}
    def _urlopen(req, timeout=None):
        calls["url"] = req.full_url
        return _FakeResponse(b"x")
    monkeypatch.setattr(server_link.urllib.request, "urlopen", _urlopen)
    link = server_link.ServerLink(base_url="http://localhost:8000")
    link.pull_structure(fmt="cif", panel_id=None)
    assert "panel_id=" not in calls["url"]
    assert "format=cif" in calls["url"]


def test_push_structure_sends_intent_edit(monkeypatch, tmp_path):
    """`catgo view` pushes with intent=edit so the External pane always
    replaces (ase-gui), not held after the first push (regression: catgo
    view只生效一次)."""
    from catgo.cli import server_link
    calls = {}
    def _urlopen(req, timeout=None):
        calls["url"] = req.full_url
        return _FakeResponse(b'{"panel_id": "default", "num_sites": 2}')
    monkeypatch.setattr(server_link.urllib.request, "urlopen", _urlopen)
    p = tmp_path / "x.vasp"; p.write_bytes(b"POSCAR\n1.0\n")
    link = server_link.ServerLink(base_url="http://localhost:8000")
    link.push_structure(p, panel_id="default")
    assert "intent=edit" in calls["url"]
    assert "panel_id=default" in calls["url"]

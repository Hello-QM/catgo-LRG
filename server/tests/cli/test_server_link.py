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

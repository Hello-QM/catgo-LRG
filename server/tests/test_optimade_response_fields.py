"""OPTIMADE get_structure: response_fields forwarding + graceful degrade.

Covers the PR-391 backend change (per-structure fetch forwards
`response_fields`) plus the fix that a provider rejecting unknown extras must
NOT fail the import — get_structure retries without the fields and still
returns the structure.
"""
import asyncio

from catgo.routers import optimade


def _patch(monkeypatch, fetch_json):
    async def fake_get_providers():
        return {
            "data": [
                {"id": "mp", "attributes": {"base_url": "https://mp.example/optimade"}}
            ]
        }

    async def fake_resolve(base_url):
        return base_url

    monkeypatch.setattr(optimade, "get_providers", fake_get_providers)
    monkeypatch.setattr(optimade, "resolve_provider_url", fake_resolve)
    monkeypatch.setattr(optimade, "fetch_json", fetch_json)


def test_forwards_response_fields_then_degrades(monkeypatch):
    calls = []

    async def fake_fetch_json(url):
        calls.append(url)
        # Simulate a provider that rejects unknown response_fields, but serves
        # the bare structure fine.
        if "response_fields" in url:
            raise Exception("400 Bad Request: unrecognised response_fields")
        return {"data": {"id": "mp-1", "type": "structures", "attributes": {}}}

    _patch(monkeypatch, fake_fetch_json)

    result = asyncio.run(
        optimade.get_structure("mp", "mp-1", response_fields="_mp_band_gap,_mp_efermi")
    )

    # response_fields WAS forwarded on the first attempt(s)…
    assert any("response_fields" in u for u in calls), calls
    # …and the import degraded gracefully (bare-query retry) → structure returned
    assert any("response_fields" not in u for u in calls), calls
    assert result and "data" in result


def test_no_response_fields_is_single_query(monkeypatch):
    async def fake_fetch_json(url):
        assert "response_fields" not in url
        return {"data": {"id": "mp-1", "type": "structures", "attributes": {}}}

    _patch(monkeypatch, fake_fetch_json)
    result = asyncio.run(optimade.get_structure("mp", "mp-1"))
    assert result and "data" in result

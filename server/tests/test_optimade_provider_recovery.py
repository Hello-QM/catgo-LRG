from __future__ import annotations

import pytest

from catgo.routers import optimade


@pytest.fixture(autouse=True)
def _clear_provider_caches():
    optimade._providers_cache = None
    optimade._resolved_urls_cache.clear()
    yield
    optimade._providers_cache = None
    optimade._resolved_urls_cache.clear()


@pytest.mark.asyncio
async def test_registry_failure_does_not_cache_fallback_forever(monkeypatch):
    calls = 0

    async def fake_fetch_json(url: str):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("temporary registry outage")
        return {
            "data": [{
                "id": "healthy",
                "attributes": {
                    "name": "Healthy",
                    "description": "working provider",
                    "base_url": "https://healthy.example",
                },
            }],
        }

    monkeypatch.setattr(optimade, "fetch_json", fake_fetch_json)

    first = await optimade.get_providers()
    second = await optimade.get_providers()

    assert first["data"] == optimade.FALLBACK_PROVIDERS
    assert [entry["id"] for entry in second["data"]] == ["healthy"]
    assert calls == 2


@pytest.mark.asyncio
async def test_transient_child_resolution_failure_is_retried(monkeypatch):
    calls = 0

    async def fake_fetch_json(url: str):
        nonlocal calls
        calls += 1
        if calls <= 2:
            raise RuntimeError("temporary index outage")
        return {
            "data": [{
                "id": "child",
                "type": "links",
                "attributes": {
                    "link_type": "child",
                    "base_url": "https://child.example",
                },
            }],
        }

    monkeypatch.setattr(optimade, "fetch_json", fake_fetch_json)

    first = await optimade.resolve_provider_url("https://index.example")
    second = await optimade.resolve_provider_url("https://index.example")

    assert first == "https://index.example"
    assert second == "https://child.example"
    assert calls == 3


@pytest.mark.asyncio
async def test_provider_registry_filters_confirmed_dead_endpoints(monkeypatch):
    async def fake_fetch_json(url: str):
        return {
            "data": [
                {
                    "id": provider_id,
                    "attributes": {
                        "name": provider_id,
                        "base_url": f"https://{provider_id}.example",
                    },
                }
                for provider_id in (
                    "healthy",
                    "mcloud",
                    "omdb",
                    "twodmatpedia",
                )
            ],
        }

    monkeypatch.setattr(optimade, "fetch_json", fake_fetch_json)

    response = await optimade.get_providers()

    assert [entry["id"] for entry in response["data"]] == ["healthy"]

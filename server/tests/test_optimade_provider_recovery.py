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
async def test_external_requests_do_not_inherit_agent_proxy_env(monkeypatch):
    created_with = []

    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {"data": []}

    class FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            created_with.append(kwargs)

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def get(self, *args, **kwargs):
            return FakeResponse()

    monkeypatch.setattr(optimade.httpx, "AsyncClient", FakeAsyncClient)

    await optimade.fetch_json("https://optimade.example/v1/structures")

    assert created_with == [{"timeout": optimade.HTTP_TIMEOUT, "trust_env": False}]


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

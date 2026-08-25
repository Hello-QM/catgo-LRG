from __future__ import annotations

import pytest

from catgo.routers import pubchem


@pytest.mark.asyncio
@pytest.mark.parametrize("fetcher", [pubchem.fetch_json, pubchem.fetch_text])
async def test_external_requests_do_not_inherit_agent_proxy_env(monkeypatch, fetcher):
    created_with = []

    class FakeResponse:
        text = "ok"

        def raise_for_status(self):
            return None

        def json(self):
            return {"ok": True}

    class FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            created_with.append(kwargs)

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def get(self, *args, **kwargs):
            return FakeResponse()

    monkeypatch.setattr(pubchem.httpx, "AsyncClient", FakeAsyncClient)

    await fetcher("https://pubchem.example/record")

    assert created_with == [{"timeout": pubchem.HTTP_TIMEOUT, "trust_env": False}]

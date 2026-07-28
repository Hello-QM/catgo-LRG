from __future__ import annotations

import pytest

from catgo.routers import materials_project


class _FakeResponse:
    status_code = 200
    text = '{"data":[]}'

    def json(self):
        return {"data": [], "meta": {"total_doc": 0}}

    def raise_for_status(self):
        return None


class _FakeAsyncClient:
    requests: list[dict] = []

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return None

    async def get(self, url, *, params, headers):
        self.requests.append({"url": url, "params": params, "headers": headers})
        return _FakeResponse()


@pytest.fixture(autouse=True)
def _mock_httpx(monkeypatch):
    _FakeAsyncClient.requests = []
    monkeypatch.setattr(materials_project.httpx, "AsyncClient", _FakeAsyncClient)


@pytest.mark.asyncio
async def test_search_forwards_exact_element_count_and_offset():
    request = materials_project.MPSearchRequest(
        elements=["Ti", "O"],
        num_elements=2,
        limit=20,
        offset=20,
    )

    await materials_project.search_structures(request, x_api_key="test-key")

    params = _FakeAsyncClient.requests[0]["params"]
    assert params["elements"] == "Ti,O"
    assert params["nelements_min"] == "2"
    assert params["nelements_max"] == "2"
    assert params["_skip"] == "20"


@pytest.mark.asyncio
async def test_single_structure_request_includes_geometry_field():
    await materials_project.get_structure("mp-2657", x_api_key="test-key")

    request = _FakeAsyncClient.requests[0]
    assert request["url"].endswith("/materials/summary/")
    assert request["params"]["material_ids"] == "mp-2657"
    assert request["params"]["_limit"] == "1"
    fields = request["params"]["_fields"].split(",")
    assert "structure" in fields

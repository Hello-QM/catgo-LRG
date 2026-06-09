import json

import pytest

from catgo.routers import chat


class _FakeResponse:
    def __init__(self, status_code: int, payload: dict | None = None):
        self.status_code = status_code
        self._payload = payload or {}

    def json(self) -> dict:
        return self._payload


class _FakeStreamResponse:
    status_code = 200

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def aiter_lines(self):
        yield json.dumps({"message": {"content": "hello "}, "done": False})
        yield json.dumps({"message": {"content": "world"}, "done": True})


class _FakeAsyncClient:
    def __init__(self, *args, **kwargs):
        self.requested_urls: list[str] = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def get(self, url: str):
        self.requested_urls.append(url)
        return _FakeResponse(200, {"models": [{"name": "qwen3:0.6b"}]})

    def stream(self, method: str, url: str, json: dict):
        self.requested_urls.append(url)
        assert method == "POST"
        assert url.endswith("/api/chat")
        assert json["model"] == "qwen3:0.6b"
        return _FakeStreamResponse()


@pytest.mark.asyncio
async def test_ollama_model_discovery_uses_native_tags(monkeypatch):
    monkeypatch.setattr(chat.httpx, "AsyncClient", _FakeAsyncClient)

    models, latency, fmt = await chat._fetch_provider_models(
        "ollama",
        api_key=None,
        base_url="http://127.0.0.1:11434",
        api_format=None,
    )

    assert fmt == "ollama"
    assert latency >= 0
    assert models == [{"id": "qwen3:0.6b", "label": "qwen3:0.6b"}]


@pytest.mark.asyncio
async def test_ollama_stream_does_not_require_api_key(monkeypatch):
    monkeypatch.setattr(chat.httpx, "AsyncClient", _FakeAsyncClient)
    req = chat.UniversalStreamRequest(
        provider_id="ollama",
        messages=[chat.ChatMessage(role="user", content="hi")],
        model="qwen3:0.6b",
    )

    chunks = [chunk async for chunk in chat._stream_universal(req)]
    payloads = [
        json.loads(chunk.removeprefix("data: ").strip())
        for chunk in chunks
        if chunk.startswith("data: {")
    ]

    assert payloads == [{"text": "hello "}, {"text": "world"}]
    assert chunks[-1] == "data: [DONE]\n\n"

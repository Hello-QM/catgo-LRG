import json

import pytest

from catgo.routers import chat


class _FakeStdin:
    def __init__(self):
        self.payload = b""

    def write(self, data: bytes):
        self.payload += data

    async def drain(self):
        return None

    def close(self):
        return None

    async def wait_closed(self):
        return None


class _FakeStdout:
    def __init__(self, responses: list[dict]):
        self._lines = [json.dumps(response).encode() + b"\n" for response in responses]

    async def readline(self):
        return self._lines.pop(0) if self._lines else b""


class _FakeCodexAppServer:
    returncode = None

    def __init__(self, response: dict):
        self.stdin = _FakeStdin()
        self.stdout = _FakeStdout([{"id": 0, "result": {}}, response])
        self.killed = False

    def kill(self):
        self.killed = True

    async def wait(self):
        self.returncode = 0
        return self.returncode


@pytest.mark.asyncio
async def test_codex_model_list_drives_default_label(monkeypatch):
    fake = _FakeCodexAppServer({
        "id": 1,
        "result": {
            "data": [
                {
                    "id": "gpt-5.5",
                    "displayName": "GPT-5.5",
                    "isDefault": False,
                },
                {
                    "id": "gpt-5.6-sol",
                    "displayName": "GPT-5.6-Sol",
                    "isDefault": True,
                },
                {
                    "id": "internal-model",
                    "displayName": "Internal",
                    "hidden": True,
                },
            ]
        },
    })

    async def create_subprocess_exec(*args, **kwargs):
        assert args == ("/fake/codex", "app-server")
        assert kwargs["stdin"] is chat.asyncio.subprocess.PIPE
        return fake

    monkeypatch.setattr(chat.asyncio, "create_subprocess_exec", create_subprocess_exec)

    models = await chat._discover_codex_models("/fake/codex")
    sent = [json.loads(line) for line in fake.stdin.payload.decode().splitlines()]

    assert [request["method"] for request in sent] == [
        "initialize",
        "initialized",
        "model/list",
    ]
    assert models == [
        {"id": "", "label": "Default (GPT-5.6-Sol)"},
        {"id": "gpt-5.5", "label": "GPT-5.5"},
    ]


@pytest.mark.asyncio
async def test_codex_model_discovery_failure_uses_unpinned_default(monkeypatch):
    async def fail_discovery(binary: str):
        raise RuntimeError("old CLI")

    monkeypatch.setattr(chat, "_discover_codex_models", fail_discovery)
    monkeypatch.setattr(chat, "_codex_models_cache", None)

    models = await chat._get_codex_models("/fake/codex")

    assert models == [{"id": "", "label": "Default"}]


@pytest.mark.asyncio
async def test_provider_catalogue_uses_live_codex_models(monkeypatch):
    live_models = [
        {"id": "", "label": "Default (GPT-5.6-Sol)"},
        {"id": "gpt-5.6-terra", "label": "GPT-5.6-Terra"},
    ]

    monkeypatch.setattr(
        chat.shutil,
        "which",
        lambda binary: f"/fake/{binary}" if binary == "codex" else None,
    )

    async def get_codex_models(binary: str | None):
        assert binary == "/fake/codex"
        return live_models

    async def fail_ollama(base_url: str):
        raise RuntimeError("not running")

    monkeypatch.setattr(chat, "_get_codex_models", get_codex_models)
    monkeypatch.setattr(chat, "_fetch_ollama_tags", fail_ollama)
    monkeypatch.setattr(chat, "_ollama_running", lambda: False)

    catalogue = await chat.list_providers()
    codex = next(provider for provider in catalogue["providers"] if provider["id"] == "sdk-codex")

    assert codex["available"] is True
    assert codex["models"] == live_models

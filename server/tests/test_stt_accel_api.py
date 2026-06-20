"""STT accelerator endpoints: status shape, engine switch validation, install gate."""

import importlib

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("CATGO_STT_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("CATGO_STT_ENGINE", raising=False)
    monkeypatch.delenv("CATGO_WHISPERCPP_BIN", raising=False)
    monkeypatch.delenv("CATGO_WHISPERCPP_MODELS", raising=False)
    es = importlib.import_module("catgo.stt.engine_state")
    es._reset_for_test()
    accel = importlib.import_module("catgo.stt.accel")
    importlib.reload(accel)
    stt = importlib.import_module("catgo.routers.stt")
    importlib.reload(stt)
    app = FastAPI()
    app.include_router(stt.router, prefix="/api")
    c = TestClient(app)
    c._stt, c._accel, c._es = stt, accel, es
    yield c
    es._reset_for_test()


def test_status_shape(client):
    r = client.get("/api/stt/accel/status")
    assert r.status_code == 200
    d = r.json()
    assert d["engine"] == "faster-whisper"
    assert d["binary_installed"] is False
    assert d["models_installed"] == []
    assert "gpu_api" in d and "download" in d


def test_switch_to_whispercpp_without_binary_rejected(client):
    r = client.post("/api/stt/accel/engine", json={"engine": "whispercpp"})
    assert r.status_code == 400
    assert client.get("/api/stt/accel/status").json()["engine"] == "faster-whisper"


def test_switch_to_whispercpp_with_binary_ok(client):
    binp = client._accel.binary_path()
    binp.parent.mkdir(parents=True, exist_ok=True)
    binp.write_text("#!/bin/sh\n")
    r = client.post("/api/stt/accel/engine", json={"engine": "whispercpp"})
    assert r.status_code == 200
    assert r.json()["engine"] == "whispercpp"
    assert client.get("/api/stt/accel/status").json()["engine"] == "whispercpp"


def test_switch_unknown_engine_rejected(client):
    assert client.post("/api/stt/accel/engine", json={"engine": "bogus"}).status_code == 400


def test_install_unsupported_platform_rejected(client, monkeypatch):
    monkeypatch.setattr(client._accel, "platform_key", lambda: None)
    assert client.post("/api/stt/accel/install").status_code == 400


def test_install_starts_background(client, monkeypatch):
    called = {}
    monkeypatch.setattr(client._accel, "platform_key", lambda: "linux-x64-vulkan")
    monkeypatch.setattr(client._accel, "install_binary", lambda: called.setdefault("ok", True))
    r = client.post("/api/stt/accel/install")
    assert r.status_code == 200 and r.json()["started"] is True
    assert called.get("ok") is True  # background task ran (TestClient runs them)


def test_transcribe_empty_body(client):
    r = client.post("/api/stt/transcribe", content=b"")
    assert r.status_code == 400

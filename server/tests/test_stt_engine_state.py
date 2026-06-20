"""Runtime STT engine state: default, env override, persistence, validation."""

import importlib

import pytest


@pytest.fixture
def es(tmp_path, monkeypatch):
    monkeypatch.setenv("CATGO_STT_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("CATGO_STT_ENGINE", raising=False)
    mod = importlib.import_module("catgo.stt.engine_state")
    mod._reset_for_test()
    yield mod
    mod._reset_for_test()


def test_default_is_faster_whisper(es):
    assert es.get_engine() == "faster-whisper"
    assert es.get_state() == {"engine": "faster-whisper", "model": None}


def test_env_override(tmp_path, monkeypatch):
    monkeypatch.setenv("CATGO_STT_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("CATGO_STT_ENGINE", "whispercpp")
    mod = importlib.import_module("catgo.stt.engine_state")
    mod._reset_for_test()
    assert mod.get_engine() == "whispercpp"
    mod._reset_for_test()


def test_set_engine_persists_across_reload(es):
    es.set_engine("whispercpp")
    es.set_model("small")
    es._reset_for_test()  # forget in-memory; must re-read from disk
    assert es.get_engine() == "whispercpp"
    assert es.get_model() == "small"


def test_reject_unknown_engine(es):
    with pytest.raises(ValueError):
        es.set_engine("bogus")
    assert es.get_engine() == "faster-whisper"


def test_corrupt_state_file_falls_back(es, tmp_path):
    (tmp_path / "state.json").write_text("{not json")
    es._reset_for_test()
    assert es.get_engine() == "faster-whisper"

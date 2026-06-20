"""Runtime STT engine selection, persisted across restarts.

PR #379's stt.py read CATGO_STT_ENGINE once at import. The in-app GPU
accelerator lets the user switch faster-whisper <-> whispercpp at runtime
(after downloading the binary), so the choice must be mutable and survive a
restart. State lives in <data-dir>/state.json, where <data-dir> defaults to
~/.catgo/stt-accel (override with CATGO_STT_DATA_DIR, mainly for tests).
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path

logger = logging.getLogger(__name__)

VALID_ENGINES = ("faster-whisper", "whispercpp")

_state: dict | None = None


def data_dir() -> Path:
    override = os.environ.get("CATGO_STT_DATA_DIR")
    return Path(override) if override else (Path.home() / ".catgo" / "stt-accel")


def _state_file() -> Path:
    return data_dir() / "state.json"


def _default_engine() -> str:
    env = (os.environ.get("CATGO_STT_ENGINE") or "").strip().lower()
    return env if env in VALID_ENGINES else "faster-whisper"


def _load() -> dict:
    global _state
    if _state is not None:
        return _state
    state = {"engine": _default_engine(), "model": None}
    try:
        sf = _state_file()
        if sf.exists():
            saved = json.loads(sf.read_text())
            if isinstance(saved, dict):
                if saved.get("engine") in VALID_ENGINES:
                    state["engine"] = saved["engine"]
                if isinstance(saved.get("model"), str):
                    state["model"] = saved["model"]
    except Exception as exc:
        logger.warning("STT state load failed: %s", exc)
    _state = state
    return _state


def _save() -> None:
    try:
        d = data_dir()
        d.mkdir(parents=True, exist_ok=True)
        _state_file().write_text(json.dumps(_load()))
    except Exception as exc:
        logger.warning("STT state save failed: %s", exc)


def get_state() -> dict:
    return dict(_load())


def get_engine() -> str:
    return _load()["engine"]


def set_engine(engine: str) -> None:
    if engine not in VALID_ENGINES:
        raise ValueError(f"unknown STT engine: {engine!r}")
    _load()["engine"] = engine
    _save()


def get_model() -> str | None:
    return _load()["model"]


def set_model(model: str | None) -> None:
    _load()["model"] = model
    _save()


def _reset_for_test() -> None:
    """Drop the in-memory cache so the next access re-reads env / disk."""
    global _state
    _state = None

import importlib.util
import subprocess
from pathlib import Path
from unittest.mock import Mock


_SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "smoke-frozen-catbot.py"
_SPEC = importlib.util.spec_from_file_location("smoke_frozen_catbot", _SCRIPT)
assert _SPEC and _SPEC.loader
smoke = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(smoke)


def test_request_json_forwards_explicit_timeout(monkeypatch):
    response = Mock()
    response.__enter__ = Mock(return_value=response)
    response.__exit__ = Mock(return_value=False)
    response.read.return_value = b'{"ok": true}'
    response.getcode.return_value = 200
    opener = Mock()
    opener.open.return_value = response
    monkeypatch.setattr(smoke, "_OPENER", opener)

    assert smoke._request_json("http://127.0.0.1/test", timeout=60) == {"ok": True}
    assert opener.open.call_args.kwargs["timeout"] == 60


def test_posix_process_group_is_isolated(monkeypatch):
    monkeypatch.setattr(smoke.os, "name", "posix")
    assert smoke._process_group_options() == {"start_new_session": True}


def test_windows_cleanup_terminates_entire_process_tree(monkeypatch):
    monkeypatch.setattr(smoke.os, "name", "nt")
    run = Mock()
    monkeypatch.setattr(smoke.subprocess, "run", run)
    process = Mock()
    process.pid = 1234
    process.wait.return_value = 0

    smoke._terminate_process_tree(process)

    run.assert_called_once_with(
        ["taskkill", "/PID", "1234", "/T", "/F"],
        check=False,
        capture_output=True,
        text=True,
    )
    process.wait.assert_called_once_with(timeout=10)

"""Regression tests for the browser/PyPI Windows Local Shell transport."""

import asyncio
import base64
import threading
from unittest.mock import patch

from catgo.routers import pty as pty_router


class FakeProcess:
    def __init__(self):
        self.closed = False
        self.writes = []
        self.sizes = []
        self._first_read = True
        self._closed_event = threading.Event()

    def isalive(self):
        return not self.closed

    def read(self, _size):
        if self._first_read:
            self._first_read = False
            return "PowerShell ready"
        self._closed_event.wait(timeout=5)
        raise EOFError

    def write(self, data):
        self.writes.append(data)

    def setwinsize(self, rows, cols):
        self.sizes.append((rows, cols))

    def close(self, force=False):
        self.closed = True
        self._closed_event.set()


class FakePtyProcess:
    process = FakeProcess()

    @classmethod
    def spawn(cls, argv, **kwargs):
        cls.argv = argv
        cls.spawn_kwargs = kwargs
        return cls.process


class FakeWebSocket:
    def __init__(self):
        self.sent = []
        self.actions = [
            {"action": "input", "data": "Write-Output OK\r"},
            {"action": "resize", "cols": 120, "rows": 40},
            {"action": "ping"},
            {"action": "close"},
        ]

    async def send_json(self, message):
        self.sent.append(message)

    async def receive_json(self):
        await asyncio.sleep(0.02)
        return self.actions.pop(0)

    async def close(self):
        pass


def test_windows_local_pty_open_io_resize_and_ping():
    process = FakeProcess()
    FakePtyProcess.process = process
    ws = FakeWebSocket()
    specs = [
        {
            "id": "powershell",
            "label": "Windows PowerShell",
            "argv": ["powershell.exe", "-NoLogo"],
        }
    ]

    async def run():
        await asyncio.wait_for(
            pty_router._run_windows_pty(
                ws, pty_id=7, cols=80, rows=24, shell_id="powershell"
            ),
            timeout=5,
        )

    with (
        patch.object(pty_router, "PtyProcess", FakePtyProcess),
        patch.object(pty_router, "_windows_shell_specs", return_value=specs),
    ):
        asyncio.run(run())

    assert ws.sent[0] == {"type": "opened", "id": 7}
    assert FakePtyProcess.argv[:2] == ["powershell.exe", "-NoLogo"]
    assert FakePtyProcess.argv[2:4] == ["-NoExit", "-Command"]
    assert "]7;$p" in FakePtyProcess.argv[4]
    output_messages = [message for message in ws.sent if message["type"] == "output"]
    assert base64.b64decode(output_messages[0]["data"]) == b"PowerShell ready"
    assert process.writes == ["Write-Output OK\r"]
    assert process.sizes == [(40, 120)]
    assert {"type": "pong"} in ws.sent
    assert process.closed is True


def test_windows_cmd_prompt_reports_raw_current_directory():
    argv = pty_router._windows_argv_with_cwd_reporting(
        {"id": "cmd", "label": "Command Prompt", "argv": ["cmd.exe"]}
    )

    assert argv == ["cmd.exe", "/K", r"prompt $E]7;$P$E\$P$G$S"]

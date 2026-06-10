import asyncio
import pytest

from catgo.utils.ssh_file_ops import SSHFileOpsMixin


class _CompletedProcess:
    def __init__(self, exit_status: int, stdout: str, stderr: str) -> None:
        self.exit_status = exit_status
        self.stdout = stdout
        self.stderr = stderr


class _FakeRunner:
    def __init__(self, stdout: str, exit_status: int = 0, stderr: str = "") -> None:
        self.stdout = stdout
        self.exit_status = exit_status
        self.stderr = stderr
        self.commands: list[str] = []

    async def run(self, cmd: str, check: bool = False, timeout: float = 60) -> _CompletedProcess:
        self.commands.append(cmd)
        return _CompletedProcess(self.exit_status, self.stdout, self.stderr)


class _ListingOps(SSHFileOpsMixin):
    def __init__(self, runner: _FakeRunner) -> None:
        self.conn = runner
        self.sftp = None
        self._sftp_failed = False

    @property
    def is_subprocess_mode(self) -> bool:
        return True

    async def get_sftp(self):
        return None


@pytest.mark.asyncio
async def test_remote_listing_ignores_login_shell_noise() -> None:
    stdout = "\n".join(
        [
            "Last login: Wed Jun 10 12:00:00 from 10.0.0.2",
            "__CATGO_LIST_BEGIN__/home/user",
            "d|4096|1718000000.0|project",
            "f|12|1718000001.0|README.md",
            "__CATGO_LIST_END__",
            "",
        ]
    )
    runner = _FakeRunner(stdout)
    ops = _ListingOps(runner)

    resolved, files = await ops.list_remote_dir("~")

    assert resolved == "/home/user"
    assert [f.name for f in files] == ["project", "README.md"]
    assert files[0].is_dir is True
    assert files[1].path == "/home/user/README.md"
    assert "find . -mindepth 1 -maxdepth 1" in runner.commands[0]


@pytest.mark.asyncio
async def test_remote_listing_surfaces_cd_failure() -> None:
    runner = _FakeRunner("__CATGO_LIST_ERROR__/missing\n", exit_status=2)
    ops = _ListingOps(runner)

    with pytest.raises(RuntimeError, match="Cannot list directory: /missing"):
        await ops.list_remote_dir("/missing")


class _TimeoutThenSftpOps(SSHFileOpsMixin):
    def __init__(self) -> None:
        self.sftp = object()
        self._sftp_failed = False
        self.sftp_called = False

    @property
    def is_subprocess_mode(self) -> bool:
        return False

    async def get_sftp(self):
        return self.sftp

    async def _list_dir_subprocess(self, path: str):
        raise asyncio.TimeoutError()

    async def _list_dir_sftp(self, path: str):
        self.sftp_called = True
        return "/resolved", []


@pytest.mark.asyncio
async def test_exec_timeout_falls_back_to_sftp() -> None:
    ops = _TimeoutThenSftpOps()

    resolved, files = await ops.list_remote_dir("/data")

    assert ops.sftp_called is True
    assert resolved == "/resolved"
    assert files == []

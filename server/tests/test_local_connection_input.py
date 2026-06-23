"""conn.run(..., input=...) must pipe stdin on the subprocess SSH/local runners.

Regression: job submit failed with
``SubprocessSSHRunner.run() got an unexpected keyword argument 'input'`` —
the submitter uploads (possibly user-edited) preview files via
``conn.run("cat > file", input=content)``, which the asyncssh backend supports
but the system-ssh / local subprocess backends did not.
"""

import asyncio
import inspect

from catgo.utils.local_connection import LocalCommandRunner, SubprocessSSHRunner

# pytest-asyncio is not installed in this repo; drive coroutines via asyncio.run
# so the tests actually execute (a bare `async def test_` would be a false pass).


def test_local_runner_pipes_input_to_stdin(tmp_path):
    target = tmp_path / "INCAR"
    runner = LocalCommandRunner()
    result = asyncio.run(runner.run(f"cat > {target}", input="ENCUT = 520\n", check=True))
    assert result.exit_status == 0
    assert target.read_text() == "ENCUT = 520\n"


def test_local_runner_without_input_still_works():
    runner = LocalCommandRunner()
    result = asyncio.run(runner.run("echo hi", check=True))
    assert result.exit_status == 0
    assert result.stdout.strip() == "hi"


def test_subprocess_ssh_runner_accepts_input_kwarg():
    # The exact failure mode: the kwarg must exist on both run() and run_raw().
    for name in ("run", "run_raw"):
        params = inspect.signature(getattr(SubprocessSSHRunner, name)).parameters
        assert "input" in params, f"SubprocessSSHRunner.{name} missing 'input'"


def test_local_runner_accepts_input_kwarg():
    params = inspect.signature(LocalCommandRunner.run).parameters
    assert "input" in params

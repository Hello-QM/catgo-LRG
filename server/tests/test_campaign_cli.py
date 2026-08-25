"""Shared campaign CLI runner — used by both the MCP tool and the HTTP route."""
import asyncio
import sys

import pytest

from catgo import campaign_cli
from catgo.campaign_cli import CAMPAIGN_ACTIONS, campaign_argv, run_campaign_cli


def test_campaign_argv():
    assert campaign_argv('poll', []) == [sys.executable, '-m', 'catgo', 'campaign', 'poll']
    assert campaign_argv('new', ['p', '--name', 'x']) == [
        sys.executable, '-m', 'catgo', 'campaign', 'new', 'p', '--name', 'x',
    ]


def test_campaign_argv_in_frozen_backend(monkeypatch):
    """The bundled sidecar must never be treated as a Python interpreter."""
    monkeypatch.setattr(sys, 'frozen', True, raising=False)
    with pytest.raises(RuntimeError, match='execute in-process'):
        campaign_argv('new', ['p', '--template', 'blank'])


def test_frozen_backend_runs_campaign_in_process(tmp_path, monkeypatch):
    """Regression: Windows one-file backends must not unpack themselves again."""
    monkeypatch.setattr(sys, 'frozen', True, raising=False)

    async def forbidden_subprocess(*args, **kwargs):
        raise AssertionError('frozen Campaign attempted to spawn catgo-server')

    monkeypatch.setattr(asyncio, 'create_subprocess_exec', forbidden_subprocess)
    root = tmp_path / 'camp'
    out, code = asyncio.run(run_campaign_cli(
        'new', [str(root), '--name', 'Frozen Windows', '--template', 'blank'],
    ))

    assert code == 0
    assert "created campaign 'Frozen Windows'" in out
    assert (root / 'plan.md').is_file()


def test_frozen_backend_preserves_cli_failures(monkeypatch):
    monkeypatch.setattr(sys, 'frozen', True, raising=False)

    def fail(action, extra):
        return ('campaign failed loudly\n', 7)

    monkeypatch.setattr(campaign_cli, '_run_campaign_in_process', fail)
    out, code = asyncio.run(run_campaign_cli('poll', []))

    assert code == 7
    assert out == 'campaign failed loudly\n'


def test_bad_action_raises():
    with pytest.raises(ValueError):
        asyncio.run(run_campaign_cli('frobnicate', []))


def test_actions_enum_covers_cli():
    assert 'new' in CAMPAIGN_ACTIONS and 'poll' in CAMPAIGN_ACTIONS


def test_runs_from_foreign_cwd(tmp_path, monkeypatch):
    """Must resolve `catgo` via PYTHONPATH even when cwd is not server/ and
    catgo isn't pip-installed — the real backend condition."""
    monkeypatch.chdir(tmp_path)
    out, code = asyncio.run(run_campaign_cli(
        'new', [str(tmp_path / 'camp'), '--name', 't', '--template', 'blank'],
    ))
    assert 'No module named catgo' not in out
    assert code == 0
    assert (tmp_path / 'camp').exists()

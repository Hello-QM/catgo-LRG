"""Shared campaign CLI runner — used by both the MCP tool and the HTTP route."""
import asyncio
import sys

import pytest

from catgo.campaign_cli import CAMPAIGN_ACTIONS, campaign_argv, run_campaign_cli


def test_campaign_argv():
    assert campaign_argv('poll', []) == [sys.executable, '-m', 'catgo', 'campaign', 'poll']
    assert campaign_argv('new', ['p', '--name', 'x']) == [
        sys.executable, '-m', 'catgo', 'campaign', 'new', 'p', '--name', 'x',
    ]


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

import asyncio
import sys

from catgo.mcp_tools import server_claude_code as scc
from catgo.mcp_tools.server_claude_code import _campaign_argv


def test_campaign_argv_basic():
    argv = _campaign_argv('new', ['my-study', '--location', '/tmp/x'])
    assert argv[0] == sys.executable
    assert argv[1:] == ['-m', 'catgo', 'campaign', 'new', 'my-study', '--location', '/tmp/x']


def test_campaign_argv_no_extra():
    assert _campaign_argv('poll', []) == [sys.executable, '-m', 'catgo', 'campaign', 'poll']


def test_handle_campaign_resolves_catgo_module(tmp_path, monkeypatch):
    """The campaign subprocess must `python -m catgo` even though the backend
    runs from a different cwd and catgo isn't pip-installed — regression for
    the 'No module named catgo' failure over the MCP wire. chdir away from
    server/ to reproduce the real backend condition."""
    monkeypatch.chdir(tmp_path)
    out = asyncio.run(scc._handle_campaign({
        'action': 'new',
        'args': [str(tmp_path / 'camp'), '--name', 't', '--template', 'blank'],
    }))
    text = out[0].text
    assert 'No module named catgo' not in text
    assert 'exit 1' not in text  # scaffold should succeed
    assert (tmp_path / 'camp').exists()

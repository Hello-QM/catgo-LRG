from catgo.mcp_tools.server_claude_code import _campaign_argv
import sys


def test_campaign_argv_basic():
    argv = _campaign_argv('new', ['my-study', '--location', '/tmp/x'])
    assert argv[0] == sys.executable
    assert argv[1:] == ['-m', 'catgo', 'campaign', 'new', 'my-study', '--location', '/tmp/x']


def test_campaign_argv_no_extra():
    assert _campaign_argv('poll', []) == [sys.executable, '-m', 'catgo', 'campaign', 'poll']

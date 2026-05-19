"""CatGo CLI package — server lifecycle + structure operations.

Entry point: ``catgo.cli:main`` (declared in server/pyproject.toml).
"""
from __future__ import annotations

import sys

from catgo.cli._legacy import (
    cmd_serve, cmd_setup, cmd_status, cmd_stop,
)


def _build_legacy_parser():
    """Recreate the original serve/setup/status/stop parser."""
    import argparse
    parser = argparse.ArgumentParser(
        prog="catgo",
        description="CatGo — Computational Chemistry Workflow Engine",
    )
    sub = parser.add_subparsers(dest="command")

    p_serve = sub.add_parser("serve", help="Start the CatGo backend server")
    p_serve.add_argument("--port", type=int, default=0, help="Port (default: 8000)")
    p_serve.add_argument("--host", default="0.0.0.0", help="Host (default: 0.0.0.0)")
    p_serve.add_argument("--daemon", action="store_true", help="Run as background daemon (Unix only)")
    p_serve.add_argument("--reload", action="store_true", help="Enable auto-reload (dev mode)")
    p_serve.set_defaults(func=cmd_serve)

    p_setup = sub.add_parser("setup", help="Configure MCP for Claude Code")
    p_setup.add_argument("--port", type=int, default=0, help="API port (default: 8000)")
    p_setup.add_argument("--check", action="store_true", help="Check environment status")
    p_setup.set_defaults(func=cmd_setup)

    p_status = sub.add_parser("status", help="Check if server is running")
    p_status.set_defaults(func=cmd_status)

    p_stop = sub.add_parser("stop", help="Stop a running daemon")
    p_stop.set_defaults(func=cmd_stop)

    return parser, sub


def main(argv: list[str] | None = None) -> None:
    argv = sys.argv[1:] if argv is None else argv
    parser, _sub = _build_legacy_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "command", None):
        parser.print_help()
        return
    args.func(args)


if __name__ == "__main__":
    main()

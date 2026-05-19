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


def _add_op_subparsers(sub):
    from catgo.cli.ops import build_registry
    reg = build_registry()
    for op in reg.all():
        p = sub.add_parser(op.name, help=op.summary)
        p.add_argument("input", nargs="?", help="input structure file")
        p.add_argument("-o", "--out", help="output path")
        p.add_argument("--force", action="store_true",
                       help="overwrite existing output")
        for prm in op.params:
            if prm.name == "out":
                continue
            p.add_argument(f"--{prm.name}", default=None,
                           required=prm.required, help=prm.help)
        p.set_defaults(_op=op)
    return reg


def _run_op(args) -> int:
    from catgo.cli.session import Session, SessionError
    from catgo.cli.adapter import OpError
    from catgo.cli.registry import coerce_param
    op = args._op
    session = Session()
    try:
        if args.input:
            session.load(args.input)
        params: dict = {}
        for prm in op.params:
            if prm.name == "out":
                if prm.required and not getattr(args, "out", None):
                    print("error: -o/--out is required for this command",
                          file=sys.stderr)
                    return 1
                continue
            raw = getattr(args, prm.name, None)
            if raw is None:
                if prm.required:
                    print(f"error: --{prm.name} required", file=sys.stderr)
                    return 1
                continue
            try:
                params[prm.name] = coerce_param(prm, raw)
            except ValueError:
                kind = ("comma-separated numbers" if prm.type is tuple
                        else prm.type.__name__)
                print(f"error: --{prm.name} expects {kind}, got '{raw}'",
                      file=sys.stderr)
                return 1
        if getattr(args, "out", None):
            params["out"] = args.out
        if getattr(args, "force", False):
            params["force"] = True
        if op.mutates:
            session.push_history()
        result = op.handler(session, params)
    except (SessionError, OpError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    if not result.ok:
        print(f"error: {result.message}", file=sys.stderr)
        return 1
    if result.structure is not None:
        session.structure = result.structure
        if args.out and result.artifact is None:
            session.save(args.out)
            print(f"{result.message} -> {args.out}")
        else:
            print(f"{result.message}  (not saved -- pass -o to persist)")
    else:
        print(result.message)
    return 0


def main(argv: list[str] | None = None) -> None:
    argv = sys.argv[1:] if argv is None else argv
    parser, sub = _build_legacy_parser()
    _add_op_subparsers(sub)
    if not argv:
        from catgo.cli.shell import InteractiveShell
        InteractiveShell().run()
        return
    args = parser.parse_args(argv)
    if not getattr(args, "command", None):
        parser.print_help()
        return
    if hasattr(args, "_op"):
        raise SystemExit(_run_op(args))
    args.func(args)


if __name__ == "__main__":
    main()

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
    parser.add_argument(
        "--no-autostart", action="store_true", dest="no_autostart",
        help="do not auto-spawn `catgo serve --daemon` for needs_server ops")
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

    from catgo.cli.campaign_cmd import cmd_campaign
    p_campaign = sub.add_parser(
        "campaign",
        help="md-orchestration campaign (file-first, agent-driven)")
    p_campaign.add_argument(
        "rest", nargs=argparse.REMAINDER,
        help="<action> [args]: new|fetch-ref|submit|poll|aggregate|report|ingest")
    p_campaign.set_defaults(func=cmd_campaign)

    from catgo.cli.freq_inputs_cmd import cmd_freq_inputs
    p_freq = sub.add_parser(
        "freq-inputs",
        help="build VASP freq inputs from a relaxed CONTCAR/POSCAR (catgo-gibbs-pipeline)")
    p_freq.add_argument(
        "rest", nargs=argparse.REMAINDER,
        help="--structure <CONTCAR> --out <dir> [--gas | --free-elements O,H] [--kpoints ...]")
    p_freq.set_defaults(func=cmd_freq_inputs)

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
            # Modern GNU dash style (--no-anim, --freq-cutoff) is the
            # primary advertised flag; the underscore form remains as
            # a backward-compat alias so existing scripts keep working.
            # `dest=prm.name` keeps args.<name> in the underscore shape
            # the handlers (and Param.name lookups) already use.
            flag_dash = "--" + prm.name.replace("_", "-")
            flag_underscore = f"--{prm.name}"
            flags = ([flag_dash, flag_underscore]
                     if flag_dash != flag_underscore else [flag_underscore])
            if prm.type is bool:
                p.add_argument(*flags, action="store_true", dest=prm.name,
                               help=prm.help)
                continue
            kwargs = {"default": None, "required": prm.required,
                      "help": prm.help, "dest": prm.name}
            if prm.choices is not None:
                kwargs["choices"] = prm.choices
            p.add_argument(*flags, **kwargs)
        p.set_defaults(_op=op)
    return reg


def _run_op(args) -> int:
    from catgo.cli.session import Session, SessionError
    from catgo.cli.adapter import OpError
    from catgo.cli.registry import coerce_param
    op = args._op
    session = Session()
    from catgo.cli.server_link import ServerLink
    session.link = ServerLink.discover()
    if op.needs_server and session.link is None:
        if getattr(args, "no_autostart", False):
            print("error: --no-autostart: server unreachable; "
                  "start `catgo serve` first", file=sys.stderr)
            return 2
        try:
            from catgo.cli._autostart import spawn_daemon_and_wait
            session.link = spawn_daemon_and_wait()
        except OpError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 2
    try:
        # analyze ops take an artifact path (OUTCAR / vasprun.xml / vaspout.h5
        # / COHPCAR.lobster) — NOT a parsable structure file. Skip session
        # load and forward the path via params["input"] so the handler reads
        # it directly (same shape the registry path uses).
        if args.input:
            if op.group == "analyze":
                pass
            else:
                session.load(args.input)
        params: dict = {}
        if op.group == "analyze" and args.input:
            params["input"] = args.input
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
    # Top-level argparse flags don't propagate into subparsers, so a
    # user typing `catgo push --no-autostart` would otherwise fail with
    # "unrecognized arguments". Strip --no-autostart from wherever it
    # appears and re-prepend it before the (sub)command so the top-level
    # parser always sees it.
    no_auto = "--no-autostart" in argv
    effective = [a for a in argv if a != "--no-autostart"]
    parser, sub = _build_legacy_parser()
    _add_op_subparsers(sub)
    if not effective:
        from catgo.cli.shell import InteractiveShell
        InteractiveShell(no_autostart=no_auto).run()
        return
    # Passthrough subcommands: their tail is forwarded verbatim to a launcher and may
    # LEAD with an option (e.g. `catgo freq-inputs --structure ...`), which argparse
    # REMAINDER mishandles. Dispatch them directly, before the top-level parser.
    if effective[0] == "campaign":
        from catgo.cli.campaign_cmd import run_campaign
        raise SystemExit(run_campaign(effective[1:]))
    if effective[0] == "freq-inputs":
        from catgo.cli.freq_inputs_cmd import run_freq_inputs
        raise SystemExit(run_freq_inputs(effective[1:]))
    args = parser.parse_args(
        (["--no-autostart"] if no_auto else []) + effective)
    if not getattr(args, "command", None):
        parser.print_help()
        return
    if hasattr(args, "_op"):
        raise SystemExit(_run_op(args))
    args.func(args)


if __name__ == "__main__":
    main()

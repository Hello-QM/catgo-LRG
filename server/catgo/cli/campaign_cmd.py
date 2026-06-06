"""`catgo campaign ...` — portable launcher for the md-orchestration campaign.

Thin launcher only: it locates the campaign reference scripts shipped inside the
catgo package and dispatches to their ``main(argv)``. All logic stays in those
scripts (skill-first); this just makes them runnable from any directory where
``catgo`` is on PATH.
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

# action -> entrypoint module name (in the campaign scripts dir)
_ACTIONS = {
    "new": "new_campaign",
    "fetch-ref": "fetch_ref",
    "submit": "submit_calc",
    "poll": "poll",
    "aggregate": "aggregate",
    "report": "make_report",
    "ingest": "ingest_lit",
    "archive": "archive",
}

_USAGE = "usage: catgo campaign {" + "|".join(_ACTIONS) + "} [args]"


def _scripts_dir() -> Path:
    import catgo
    return (Path(catgo.__file__).resolve().parent
            / "workflow" / "skills" / "campaign" / "scripts")


def run_campaign(argv: list[str]) -> int:
    if not argv or argv[0] in ("-h", "--help"):
        print(_USAGE)
        return 0 if argv else 2
    action, rest = argv[0], argv[1:]
    module = _ACTIONS.get(action)
    if module is None:
        print(f"error: unknown campaign action '{action}'", file=sys.stderr)
        print(_USAGE, file=sys.stderr)
        return 2
    scripts = str(_scripts_dir())
    if scripts not in sys.path:
        sys.path.insert(0, scripts)
    mod = importlib.import_module(module)
    return int(mod.main(rest) or 0)


def cmd_campaign(args) -> None:
    """argparse hook: `catgo campaign <rest...>`."""
    raise SystemExit(run_campaign(list(getattr(args, "rest", []) or [])))

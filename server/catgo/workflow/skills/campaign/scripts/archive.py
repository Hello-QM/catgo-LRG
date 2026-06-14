#!/usr/bin/env python3
"""Archive a campaign calc (explicit move) or propose candidates (never auto-moves).

    python archive.py --project <dir> --list                       # propose (FAILED only)
    python archive.py --project <dir> --calc calc/<stage>/<name> [--reason "..."]

Funnel rejects (DONE with a high E_form) are intentionally NOT proposed — they are
data the analysis needs. Only an explicit --calc (or a user-confirmed FAILED) moves.
"""
from __future__ import annotations

import argparse
import sys

import campaign_lib as cl


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="archive a campaign calc")
    ap.add_argument("--project", required=True)
    ap.add_argument("--calc", default="", help="calc rel path to archive (explicit move)")
    ap.add_argument("--reason", default="", help="why (recorded in the tombstone)")
    ap.add_argument("--list", action="store_true",
                    help="propose archive candidates (FAILED) — does not move")
    args = ap.parse_args(argv)

    if args.list:
        cands = cl.archive_candidates(args.project)
        if not cands:
            print("no archive candidates (FAILED calcs). "
                  "Funnel rejects are kept as data.")
        else:
            print("archive candidates (confirm before moving):")
            for c in cands:
                print(f"  {c['calc']}  — {c['reason']}")
        return 0

    if not args.calc:
        print("provide --calc <rel> to archive, or --list to propose", file=sys.stderr)
        return 2
    try:
        dest = cl.archive_calc(args.project, args.calc, reason=args.reason)
    except cl.CampaignError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print(f"archived -> {dest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

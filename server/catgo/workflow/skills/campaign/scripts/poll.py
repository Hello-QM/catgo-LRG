#!/usr/bin/env python3
"""Poll all active calcs (squeue) and update their STATUS.md.

    python poll.py --project <dir> --ssh <alias>
"""
from __future__ import annotations

import argparse
import sys

import campaign_lib as cl


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="poll active campaign jobs")
    ap.add_argument("--project", required=True)
    ap.add_argument("--ssh", required=True, help="ssh alias / host")
    args = ap.parse_args(argv)
    try:
        updated = cl.poll_campaign(args.project, args.ssh)
    except cl.CampaignError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print("poll: " + ("; ".join(updated) if updated else "no changes"))
    return 0


if __name__ == "__main__":
    sys.exit(main())

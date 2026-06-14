#!/usr/bin/env python3
"""Draft a campaign report under report/<date>-<occasion>/.

    python make_report.py --project <dir> --occasion groupmeeting [--date YYYY-MM-DD]
"""
from __future__ import annotations

import argparse
import datetime
import sys

import campaign_report as cr


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="draft a campaign report")
    ap.add_argument("--project", required=True)
    ap.add_argument("--occasion", required=True, help="e.g. groupmeeting / seminar")
    ap.add_argument("--date", default="", help="YYYY-MM-DD (default: today)")
    args = ap.parse_args(argv)
    date = args.date or datetime.date.today().isoformat()
    dest = cr.make_report(args.project, occasion=args.occasion, date=date)
    print(f"report draft -> {dest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

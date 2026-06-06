#!/usr/bin/env python3
"""Aggregate per-calc results into analysis/ (ranking / volcano / funnel).

    python aggregate.py --project <dir> [--eform_threshold 0.0] [--top 3] [--plot]
"""
from __future__ import annotations

import argparse
import sys

import campaign_analysis as ca


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="aggregate campaign results")
    ap.add_argument("--project", required=True)
    ap.add_argument("--eform_threshold", type=float, default=0.0)
    ap.add_argument("--top", type=int, default=3)
    ap.add_argument("--plot", action="store_true", help="also write volcano.png")
    args = ap.parse_args(argv)
    info = ca.write_aggregates(args.project, eform_threshold=args.eform_threshold,
                               top=args.top)
    if args.plot:
        ca.volcano_plot(args.project)
    print(f"aggregated {info['n_results']} results -> {args.project}/analysis/")
    return 0


if __name__ == "__main__":
    sys.exit(main())

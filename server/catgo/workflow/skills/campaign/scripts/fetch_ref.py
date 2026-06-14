#!/usr/bin/env python3
"""Pull a reference job script from the cluster into scripts/reference_job.sb.

    python fetch_ref.py --project <dir> --ssh <alias> --remote_path <cluster .sb>
"""
from __future__ import annotations

import argparse
import sys

import campaign_lib as cl


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="fetch a remote reference job script")
    ap.add_argument("--project", required=True)
    ap.add_argument("--ssh", required=True, help="ssh alias / host")
    ap.add_argument("--remote_path", required=True, help="path to the .sb on the cluster")
    args = ap.parse_args(argv)
    try:
        dest = cl.fetch_reference(args.project, args.ssh, args.remote_path)
    except cl.CampaignError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print(f"fetched reference script -> {dest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

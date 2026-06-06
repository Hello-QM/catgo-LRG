#!/usr/bin/env python3
"""Ingest literature into a campaign: a PDF (via MinerU) or a GitHub repo pointer.

    python ingest_lit.py --project <dir> --pdf <paper.pdf>
    python ingest_lit.py --project <dir> --repo <url> [--purpose "..."] [--commit SHA]
"""
from __future__ import annotations

import argparse
import sys

import campaign_lib as cl
import campaign_lit as lit


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="ingest literature")
    ap.add_argument("--project", required=True)
    ap.add_argument("--pdf", default="", help="PDF to convert via MinerU")
    ap.add_argument("--repo", default="", help="GitHub repo URL")
    ap.add_argument("--purpose", default="")
    ap.add_argument("--commit", default="")
    args = ap.parse_args(argv)
    if not args.pdf and not args.repo:
        print("provide --pdf or --repo", file=sys.stderr)
        return 2
    try:
        if args.pdf:
            dest = lit.ingest_pdf(args.project, args.pdf)
        else:
            dest = lit.ingest_repo(args.project, args.repo,
                                   purpose=args.purpose, commit=args.commit)
    except cl.CampaignError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print(f"ingested -> {dest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

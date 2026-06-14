#!/usr/bin/env python3
"""Scaffold a md-orchestration campaign project at a user-chosen location.

    python new_campaign.py <dir> [--name "<name>"] [--template blank|saa_her]
"""
from __future__ import annotations

import argparse
import sys

import campaign_lib as cl


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="scaffold a campaign project")
    ap.add_argument("path", help="project directory (any location you choose)")
    ap.add_argument("--name", default="", help="project name (default: dir name)")
    ap.add_argument("--template", default="blank", choices=["blank", "saa_her"])
    args = ap.parse_args(argv)
    name = args.name or cl.Path(args.path).name
    root = cl.scaffold_project(args.path, name, template=args.template)
    print(f"created campaign '{name}' at {root} (template={args.template})")
    return 0


if __name__ == "__main__":
    sys.exit(main())

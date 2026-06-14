#!/usr/bin/env python3
"""Submit ONE calc: gate -> adapt reference script -> scp inputs -> ssh sbatch.

    python submit_calc.py --project <dir> --calc calc/<stage>/<candidate> --ssh <alias>

Refuses to submit while cluster.md is unconfirmed or no reference_job.sb exists
(never guess cluster paths). The input-file confirmation is the agent's job
BEFORE calling this — this script performs the already-approved submission.
"""
from __future__ import annotations

import argparse
import sys

import campaign_lib as cl


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="submit one campaign calc")
    ap.add_argument("--project", required=True)
    ap.add_argument("--calc", required=True, help="calc rel path under the project")
    ap.add_argument("--ssh", default="", help="ssh alias (default: cluster.md ssh_host)")
    ap.add_argument("--job_type", default="", help="label, e.g. 'vasp geo_opt'")
    ap.add_argument("--force", action="store_true",
                    help="resubmit even if STATUS is RUNNING/PENDING (e.g. after a rebuild)")
    args = ap.parse_args(argv)
    try:
        res = cl.submit_calc(args.project, args.calc, args.ssh,
                             job_type=args.job_type, force=args.force)
    except cl.CampaignError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    for line in res.get("warnings", []):
        print("[sanity] " + line.strip(), file=sys.stderr)
    print(f"submitted {res['job_name']} job={res['jobid']} dir={res['remote_dir']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

# campaign scripts

> **TL;DR:** Reference scripts for md-orchestration campaigns. Run them as-is
> (gates enforced) or read `campaign_lib.py` and adapt for the unforeseen.

- `campaign_lib.py` — the library: naming, STATUS.md, cluster.md gate, job-script
  adaptation, squeue, stdlib-ssh wrappers, and the orchestration functions. Read
  this to understand or adapt; the entrypoints below are thin wrappers.
- `new_campaign.py <dir> [--name N] [--template blank|saa_her]` — scaffold a project.
- `fetch_ref.py --project <dir> --ssh <alias> --remote_path <.sb>` — pull a
  reference job script from the cluster.
- `submit_calc.py --project <dir> --calc <rel> --ssh <alias>` — submit ONE calc;
  **refuses** if cluster.md is unconfirmed or reference_job.sb is missing.
- `poll.py --project <dir> --ssh <alias>` — squeue active calcs, update STATUS.md.
- `test_campaign_lib.py` / `test_entrypoints.py` — dev verification (not a CI gate):
  `cd <this dir> && python -m pytest -v`.

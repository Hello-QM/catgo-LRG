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
- `poll.py --project <dir> --ssh <alias>` — squeue→sacct, update STATUS.md (DONE/FAILED).
- `aggregate.py --project <dir> [--plot]` — roll per-calc result.md into analysis/
  (ranking / volcano / funnel). Logic in `campaign_analysis.py`.
- `make_report.py --project <dir> --occasion <name> [--date YYYY-MM-DD]` — draft a
  group-meeting/seminar report under report/. Logic in `campaign_report.py`.
- `ingest_lit.py --project <dir> (--pdf <p.pdf> | --repo <url> [--purpose ..])` —
  literature ingest (MinerU PDF→md / repo pointer). Logic in `campaign_lit.py`.
- `archive.py --project <dir> (--list | --calc <rel> [--reason ..])` — propose
  archivable calcs (FAILED only; funnel rejects kept) or explicitly move one into
  archive/ with a tombstone. Never auto-decides.
- `test_campaign_lib.py` / `test_entrypoints.py` / `test_campaign_analysis.py` /
  `test_campaign_report.py` / `test_campaign_lit.py` / `test_skill_structure.py` —
  dev verification (not a CI gate): `cd <this dir> && python -m pytest -v`.

"""POTCAR root must be found whether it sits at hpc-root or hpc.job_defaults.

Regression: VASP jobs died with `severe (29): file not found ... POTCAR`. The
submitter read `config["hpc"]["potcar_root"]`, but when potcar_root comes from
default_job_params it lands in `config["hpc"]["job_defaults"]` (the scanner only
promotes it to hpc-root when a cluster_config exists for the session). With an
empty cluster_config the submitter read "" and silently skipped POTCAR
generation.
"""

from catgo.workflow.engine.submitter import _resolve_potcar_settings


def test_reads_from_job_defaults_when_root_absent():
    cfg = {"hpc": {"job_defaults": {"potcar_root": "/pots", "potcar_functional": "potpaw_PBE_54"}}}
    root, func = _resolve_potcar_settings(cfg)
    assert root == "/pots"
    assert func == "potpaw_PBE_54"


def test_reads_from_hpc_root():
    cfg = {"hpc": {"potcar_root": "/r", "potcar_functional": "potpaw_LDA"}}
    root, func = _resolve_potcar_settings(cfg)
    assert root == "/r"
    assert func == "potpaw_LDA"


def test_hpc_root_takes_precedence_over_job_defaults():
    cfg = {"hpc": {"potcar_root": "/root", "job_defaults": {"potcar_root": "/jd"}}}
    root, _ = _resolve_potcar_settings(cfg)
    assert root == "/root"


def test_defaults_when_absent():
    root, func = _resolve_potcar_settings({"hpc": {}})
    assert root == ""
    assert func == "potpaw_PBE"

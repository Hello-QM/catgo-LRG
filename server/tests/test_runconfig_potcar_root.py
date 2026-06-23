"""default_job_params must keep potcar_root through WorkflowRunConfig validation.

Regression: potcar_root set in default_job_params was silently dropped because
JobScriptParams had no such field. The scanner then had no potcar_root to put in
hpc.job_defaults, the submitter skipped POTCAR generation, and the VASP job died
with "file not found ... POTCAR".
"""

from catgo.models.workflow_run import JobScriptParams, WorkflowRunConfig


def test_jobscriptparams_keeps_potcar_root():
    p = JobScriptParams(ntasks=32, partition="shared", potcar_root="/pots", potcar_functional="potpaw_PBE")
    assert p.potcar_root == "/pots"
    assert p.potcar_functional == "potpaw_PBE"


def test_runconfig_keeps_potcar_root_in_default_job_params():
    cfg = WorkflowRunConfig(default_job_params={"ntasks": 32, "potcar_root": "/home/u/pot"})
    assert cfg.default_job_params.potcar_root == "/home/u/pot"


def test_potcar_root_defaults_to_none():
    p = JobScriptParams()
    assert p.potcar_root is None
    assert p.potcar_functional is None

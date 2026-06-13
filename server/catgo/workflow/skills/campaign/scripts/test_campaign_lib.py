"""campaign_lib — dev verification for the error-prone, safety-critical logic."""
from pathlib import Path

import campaign_lib as cl


# ---- naming: readable, never hashes ----

def test_slugify_preserves_readable_identifiers():
    assert cl.slugify("Pt1-Cu_SAA") == "Pt1-Cu_SAA"
    assert cl.slugify("01-stability-formation-energy") == "01-stability-formation-energy"


def test_slugify_spaces_to_hyphen_strips_unsafe_and_colon():
    assert cl.slugify("SAA HER") == "SAA-HER"
    assert cl.slugify("a/b:c") == "abc"
    assert cl.slugify("///") == "item"


def test_disambiguate_readable_suffix():
    assert cl.disambiguate("x", set()) == "x"
    assert cl.disambiguate("x", {"x"}) == "x-2"
    assert cl.disambiguate("x", {"x", "x-2"}) == "x-3"


def test_tldr_header():
    h = cl.tldr_header("T", "S")
    assert h.startswith("# T\n")
    assert "**TL;DR:** S" in h


def test_remote_mirror_path_readable_no_colon():
    p = cl.remote_mirror_path("/base", "SAA HER", "calc/01-x/Pt1-Cu_SAA")
    assert p == "/base/SAA-HER/calc/01-x/Pt1-Cu_SAA"
    assert ":" not in p


# ---- STATUS.md ----

def test_status_roundtrip_and_update():
    s = cl.Status(title="c", state="RUNNING", cluster="expanse", jobid="55",
                  remote_dir="/base/SAA-HER/calc/01-x/c", submitted_at="t0",
                  updated_at="t0", job_type="vasp geo_opt")
    text = cl.render_status(s)
    assert "**TL;DR:**" in text
    s2 = cl.parse_status(text)
    assert s2.state == "RUNNING" and s2.jobid == "55"
    text2 = cl.update_status(text, state="DONE", updated_at="t1")
    s3 = cl.parse_status(text2)
    assert s3.state == "DONE" and s3.updated_at == "t1" and s3.jobid == "55"


# ---- cluster.md gate ----

def test_cluster_gate_blocks_empty_and_lists_missing():
    c = cl.ClusterConfig()
    miss = cl.missing_fields(c)
    for req in cl.REQUIRED:
        assert req in miss
    assert cl.is_submittable(c) is False


def test_cluster_full_is_submittable_roundtrip():
    c = cl.ClusterConfig(
        cluster="expanse", ssh_host="expanse", account="abc123",
        partition="shared", walltime="12:00:00", ntasks="64",
        run_command="srun vasp_std", load_method="source setvars.sh",
        potcar_root="/pot", python_env="conda activate pmg",
        remote_base="/remote/base",
    )
    assert cl.missing_fields(c) == []
    assert cl.is_submittable(c) is True
    c2 = cl.parse_cluster(cl.render_cluster(c))
    assert c2.run_command == "srun vasp_std" and cl.is_submittable(c2)


# ---- job-script adaptation: preserve preamble, override resources ----

_REF = (
    "#!/bin/bash\n#SBATCH --job-name=old\n#SBATCH --time=01:00:00\n"
    "source /opt/intel/oneapi/setvars.sh\nconda activate pmg\n"
    "srun vasp_std > vasp.log 2>&1\n"
)


def test_adapt_overrides_directives_keeps_preamble_once():
    out = cl.adapt_job_script(
        _REF, job_name="Pt1-Cu_SAA", work_dir="/w", account="abc123",
        partition="shared", walltime="12:00:00", ntasks="64",
        run_command="srun vasp_std",
    )
    assert "#SBATCH --job-name=Pt1-Cu_SAA" in out
    assert "#SBATCH --time=12:00:00" in out
    assert "#SBATCH --account=abc123" in out
    assert "old" not in out and "01:00:00" not in out
    assert "source /opt/intel/oneapi/setvars.sh" in out
    assert "conda activate pmg" in out
    assert out.count("srun vasp_std") == 1   # not duplicated


def test_adapt_inserts_missing_directives_after_shebang():
    out = cl.adapt_job_script(
        "#!/bin/bash\nmodule load vasp\nsrun vasp_std\n", job_name="j",
        work_dir="/w", account="a", partition="p", walltime="1:00:00",
        ntasks="8", run_command="srun vasp_std",
    )
    lines = out.splitlines()
    assert lines[0] == "#!/bin/bash"
    for key in ("job-name", "account", "partition", "time", "ntasks"):
        assert any(ln.startswith(f"#SBATCH --{key}=") for ln in lines)
    assert "module load vasp" in out


# ---- squeue interpretation ----

def test_squeue_and_state_mapping():
    assert cl.parse_squeue("RUNNING\n") == "RUNNING"
    assert cl.parse_squeue("") == ""
    assert cl.map_state("RUNNING", True) == "RUNNING"
    assert cl.map_state("CONFIGURING", True) == "PENDING"
    assert cl.map_state("", True) == "DONE"     # left queue
    assert cl.map_state("", False) == "PENDING"


import pytest


def _good_cluster_md():
    return cl.render_cluster(cl.ClusterConfig(
        cluster="expanse", ssh_host="lab", account="abc123", partition="shared",
        walltime="12:00:00", ntasks="64", run_command="srun vasp_std",
        load_method="source setvars.sh", potcar_root="/pot",
        python_env="conda activate pmg", remote_base="/remote/base",
    ))


# ---- scaffold ----

def test_scaffold_blank_tree(tmp_path):
    root = cl.scaffold_project(tmp_path / "SAA-HER", "SAA HER", template="blank")
    for f in ("README.md", "INDEX.md", "plan.md", "cluster.md"):
        assert (root / f).is_file()
    for d in cl.SUBDIRS:
        assert (root / d / "INDEX.md").is_file()
    # every md follows the progressive convention
    for md in root.rglob("*.md"):
        t = md.read_text()
        assert t.lstrip().startswith("# ") and "**TL;DR:**" in t
    # freshly scaffolded cluster.md is NOT submittable (must pass setup gate)
    assert not cl.is_submittable(cl.parse_cluster((root / "cluster.md").read_text()))


def test_scaffold_saa_her_seeds_stages(tmp_path):
    root = cl.scaffold_project(tmp_path / "p", "SAA HER", template="saa_her")
    assert (root / "calc" / "01-stability-formation-energy" / "INDEX.md").is_file()
    assert (root / "calc" / "02-activity-dGH" / "INDEX.md").is_file()
    assert "decision point" in (root / "plan.md").read_text().lower()


# ---- submit gate (enforced in code, not just SKILL prose) ----

def test_submit_refuses_unconfirmed_cluster(tmp_path):
    root = cl.scaffold_project(tmp_path / "p", "p", template="saa_her")
    calc = root / "calc" / "01-stability-formation-energy" / "c"
    calc.mkdir(parents=True)
    (calc / "INCAR").write_text("ENCUT = 520\n")
    with pytest.raises(cl.CampaignError) as ei:
        cl.submit_calc(str(root), "calc/01-stability-formation-energy/c", "lab")
    assert "cluster.md" in str(ei.value)


def test_submit_refuses_missing_reference_script(tmp_path):
    root = cl.scaffold_project(tmp_path / "p", "p", template="saa_her")
    (root / "cluster.md").write_text(_good_cluster_md())
    calc = root / "calc" / "01-stability-formation-energy" / "c"
    calc.mkdir(parents=True)
    (calc / "INCAR").write_text("ENCUT = 520\n")
    with pytest.raises(cl.CampaignError) as ei:
        cl.submit_calc(str(root), "calc/01-stability-formation-energy/c", "lab")
    assert "reference_job.sb" in str(ei.value)


# ---- submit / poll / fetch happy paths (stdlib ssh mocked at _run) ----

@pytest.fixture
def _mock_run(monkeypatch):
    calls = []

    def fake_run(argv):
        calls.append(argv)
        joined = " ".join(argv)
        if "sbatch" in joined:
            return 0, "Submitted batch job 55\n", ""
        if "squeue" in joined:
            return 0, "", ""          # gone from queue -> DONE
        return 0, "", ""              # scp / mkdir ok
    monkeypatch.setattr(cl, "_run", fake_run)
    return calls


def test_submit_happy_writes_status_and_ships_inputs(tmp_path, _mock_run):
    # remote mirrors the LOCAL dir basename (true mirror) — dir name == remote name
    root = cl.scaffold_project(tmp_path / "SAA-HER", "SAA HER", template="saa_her")
    (root / "cluster.md").write_text(_good_cluster_md())
    (root / "scripts" / "reference_job.sb").write_text(
        "#!/bin/bash\n#SBATCH --time=1:00:00\nsource setvars.sh\nsrun vasp_std\n"
    )
    calc = root / "calc" / "01-stability-formation-energy" / "Pt1-Cu_SAA"
    calc.mkdir(parents=True)
    (calc / "INCAR").write_text("ENCUT = 520\n")
    (calc / "POSCAR").write_text("Pt\n1.0\n")

    res = cl.submit_calc(
        str(root), "calc/01-stability-formation-energy/Pt1-Cu_SAA", "lab",
        job_type="vasp geo_opt", now="t0",
    )
    assert res["jobid"] == "55"
    assert res["remote_dir"] == (
        "/remote/base/SAA-HER/calc/01-stability-formation-energy/Pt1-Cu_SAA"
    )
    st = cl.parse_status((calc / "STATUS.md").read_text())
    assert st.state == "RUNNING" and st.jobid == "55"
    # job.sb written locally too (self-describing local tree)
    assert (calc / "job.sb").is_file()
    # inputs + job.sb scp'd; bookkeeping md NOT shipped
    scp_dests = [a[-1] for a in _mock_run if a and a[0] == "scp"]
    names = [d.rsplit("/", 1)[-1] for d in scp_dests]
    assert "INCAR" in names and "POSCAR" in names and "job.sb" in names
    assert "STATUS.md" not in names


def test_poll_marks_finished_done(tmp_path, _mock_run):
    root = cl.scaffold_project(tmp_path / "p", "p", template="saa_her")
    calc = root / "calc" / "01-stability-formation-energy" / "c"
    calc.mkdir(parents=True)
    (calc / "STATUS.md").write_text(cl.render_status(cl.Status(
        title="c", state="RUNNING", cluster="expanse", jobid="55",
        remote_dir="/remote/base/p/calc/01/c",
    )))
    updated = cl.poll_campaign(str(root), "lab", now="t1")
    assert any("RUNNING->DONE" in u for u in updated)
    assert cl.parse_status((calc / "STATUS.md").read_text()).state == "DONE"


def test_fetch_reference_writes_script(tmp_path, monkeypatch):
    root = cl.scaffold_project(tmp_path / "p", "p", template="saa_her")

    def fake_run(argv):
        # simulate scp-from by writing to the local dest (last argv element)
        Path(argv[-1]).write_text("#!/bin/bash\nsrun vasp_std\n")
        return 0, "", ""
    monkeypatch.setattr(cl, "_run", fake_run)

    dest = cl.fetch_reference(str(root), "lab", "/expanse/test/vasp_test.sb")
    assert dest.is_file()
    assert "srun vasp_std" in dest.read_text()


# ---- result.md (P2) ----

def test_result_render_then_parse_coerces_numbers():
    text = cl.render_result("Pt1-Cu_SAA", {"energy": -123.456, "E_form": -0.42,
                                           "dG_H": 0.08})
    assert text.lstrip().startswith("# result: Pt1-Cu_SAA")
    assert "**TL;DR:**" in text
    v = cl.parse_result(text)
    assert v["E_form"] == -0.42 and v["dG_H"] == 0.08
    assert isinstance(v["energy"], float)


def test_result_parse_keeps_non_numeric_as_string_and_skips_header():
    text = ("# result: x\n> **TL;DR:** whatever\n\n"
            "energy: -1.0\nnote: converged in 42 steps\n")
    v = cl.parse_result(text)
    assert v["energy"] == -1.0
    assert v["note"] == "converged in 42 steps"   # non-numeric stays string
    assert "result" not in v                        # title line not captured


# ---- sacct terminal verdict: DONE vs FAILED (P2.x) ----

def test_parse_sacct_first_job_line():
    assert cl.parse_sacct("COMPLETED|0:0\nCOMPLETED|0:0\n") == ("COMPLETED", "0:0")
    assert cl.parse_sacct("FAILED|1:0\nFAILED|1:0\n") == ("FAILED", "1:0")
    # 'CANCELLED by 42' -> drop the trailing 'by <uid>'
    assert cl.parse_sacct("CANCELLED by 42|0:15\n")[0] == "CANCELLED"
    assert cl.parse_sacct("") == ("", "")


def test_map_sacct():
    assert cl.map_sacct("COMPLETED") == "DONE"
    for s in ("FAILED", "TIMEOUT", "OUT_OF_MEMORY", "CANCELLED", "NODE_FAIL"):
        assert cl.map_sacct(s) == "FAILED"
    assert cl.map_sacct("RUNNING") == "RUNNING"
    assert cl.map_sacct("PENDING") == "PENDING"
    assert cl.map_sacct("WEIRD") == ""        # unknown -> caller falls back


def test_status_exit_code_roundtrips():
    s = cl.Status(title="c", state="FAILED", jobid="55", exit_code="1:0")
    s2 = cl.parse_status(cl.render_status(s))
    assert s2.exit_code == "1:0" and s2.state == "FAILED"


def test_poll_marks_failed_via_sacct(tmp_path, monkeypatch):
    root = cl.scaffold_project(tmp_path / "p", "p", template="saa_her")
    calc = root / "calc" / "01-stability-formation-energy" / "c"
    calc.mkdir(parents=True)
    (calc / "STATUS.md").write_text(cl.render_status(cl.Status(
        title="c", state="RUNNING", cluster="expanse", jobid="55",
        remote_dir="/remote/base/p/calc/01/c")))

    def fake_run(argv):
        j = " ".join(argv)
        if "squeue" in j:
            return 0, "", ""                 # left the queue
        if "sacct" in j:
            return 0, "FAILED|1:0\n", ""      # terminal verdict: failed
        return 0, "", ""
    monkeypatch.setattr(cl, "_run", fake_run)

    updated = cl.poll_campaign(str(root), "lab", now="t1")
    assert any("RUNNING->FAILED" in u for u in updated)
    s = cl.parse_status((calc / "STATUS.md").read_text())
    assert s.state == "FAILED" and s.exit_code == "1:0"


def test_poll_sacct_completed_is_done(tmp_path, monkeypatch):
    root = cl.scaffold_project(tmp_path / "p", "p", template="saa_her")
    calc = root / "calc" / "01-stability-formation-energy" / "c"
    calc.mkdir(parents=True)
    (calc / "STATUS.md").write_text(cl.render_status(cl.Status(
        title="c", state="RUNNING", jobid="55")))

    def fake_run(argv):
        j = " ".join(argv)
        if "squeue" in j:
            return 0, "", ""
        if "sacct" in j:
            return 0, "COMPLETED|0:0\n", ""
        return 0, "", ""
    monkeypatch.setattr(cl, "_run", fake_run)
    cl.poll_campaign(str(root), "lab", now="t1")
    assert cl.parse_status((calc / "STATUS.md").read_text()).state == "DONE"


def test_poll_falls_back_to_done_when_sacct_unavailable(tmp_path, monkeypatch):
    root = cl.scaffold_project(tmp_path / "p", "p", template="saa_her")
    calc = root / "calc" / "01-stability-formation-energy" / "c"
    calc.mkdir(parents=True)
    (calc / "STATUS.md").write_text(cl.render_status(cl.Status(
        title="c", state="RUNNING", jobid="55")))

    def fake_run(argv):
        j = " ".join(argv)
        if "squeue" in j:
            return 0, "", ""
        if "sacct" in j:
            return 127, "", "sacct: command not found"   # -> CampaignError
        return 0, "", ""
    monkeypatch.setattr(cl, "_run", fake_run)
    cl.poll_campaign(str(root), "lab", now="t1")
    # ended but sacct unavailable -> fall back to DONE (no crash)
    assert cl.parse_status((calc / "STATUS.md").read_text()).state == "DONE"


# ---- archive: explicit move + propose candidates (never guess) ----

def test_archive_calc_moves_and_leaves_tombstone(tmp_path):
    root = cl.scaffold_project(tmp_path / "p", "p", template="saa_her")
    calc = root / "calc" / "01-stability-formation-energy" / "Au1-Cu_SAA"
    calc.mkdir(parents=True)
    (calc / "STATUS.md").write_text(cl.render_status(cl.Status(
        title="Au1-Cu_SAA", state="FAILED", jobid="9")))
    (calc / "INCAR").write_text("ENCUT=520\n")
    dest = cl.archive_calc(str(root), "calc/01-stability-formation-energy/Au1-Cu_SAA",
                           reason="job crashed", now="t9")
    assert dest == root / "archive" / "01-stability-formation-energy" / "Au1-Cu_SAA"
    assert (dest / "INCAR").is_file()
    tomb = calc / "ARCHIVED.md"
    assert tomb.is_file()
    t = tomb.read_text()
    assert "moved_to:" in t and "job crashed" in t
    assert not (calc / "INCAR").exists()      # files moved out of original


def test_archive_calc_refuses_non_calc_or_missing(tmp_path):
    root = cl.scaffold_project(tmp_path / "p", "p", template="saa_her")
    with pytest.raises(cl.CampaignError):
        cl.archive_calc(str(root), "refs/foo")                 # not under calc/
    with pytest.raises(cl.CampaignError):
        cl.archive_calc(str(root), "calc/01-stability-formation-energy/nope")  # missing


def test_archive_calc_disambiguates_readable(tmp_path):
    root = cl.scaffold_project(tmp_path / "p", "p", template="saa_her")
    stage = "calc/01-stability-formation-energy"
    (root / "archive" / "01-stability-formation-energy" / "c").mkdir(parents=True)
    calc = root / stage / "c"
    calc.mkdir(parents=True)
    (calc / "INCAR").write_text("x\n")
    dest = cl.archive_calc(str(root), f"{stage}/c")
    assert dest.name == "c-2"      # readable suffix, never a hash


def test_archive_candidates_lists_failed_not_funnel_rejects(tmp_path):
    root = cl.scaffold_project(tmp_path / "p", "p", template="saa_her")
    stage = root / "calc" / "01-stability-formation-energy"
    (stage / "bad").mkdir(parents=True)
    (stage / "bad" / "STATUS.md").write_text(cl.render_status(cl.Status(
        title="bad", state="FAILED", jobid="1", exit_code="1:0")))
    (stage / "reject").mkdir(parents=True)        # DONE but high E_form = funnel reject = DATA
    (stage / "reject" / "STATUS.md").write_text(cl.render_status(cl.Status(
        title="reject", state="DONE", jobid="2")))
    (stage / "reject" / "result.md").write_text(cl.render_result("reject", {"E_form": 0.5}))
    cands = cl.archive_candidates(str(root))
    names = [c["calc"] for c in cands]
    assert any("bad" in n for n in names)
    assert not any("reject" in n for n in names)   # funnel rejects kept


def test_squeue_invalid_jobid_returns_empty(monkeypatch):
    # finished job -> `squeue -j <id>` exits nonzero "Invalid job id" -> treat as not queued
    monkeypatch.setattr(cl, "_run",
                        lambda argv: (1, "", "slurm_load_jobs error: Invalid job id specified"))
    assert cl.squeue("lab", "999") == ""


def test_squeue_real_ssh_failure_still_raises(monkeypatch):
    monkeypatch.setattr(cl, "_run", lambda argv: (255, "", "Connection refused"))
    import pytest as _pt
    with _pt.raises(cl.CampaignError):
        cl.squeue("lab", "1")


# ---- submit double-submit guard (idempotent re-entry) ----

def test_submit_refuses_when_already_running(tmp_path):
    root = cl.scaffold_project(tmp_path / "p", "p", template="saa_her")
    (root / "cluster.md").write_text(_good_cluster_md())
    (root / "scripts" / "reference_job.sb").write_text(
        "#!/bin/bash\n#SBATCH --time=1:00:00\nsrun vasp_std\n")
    calc = root / "calc" / "01-stability-formation-energy" / "c"
    calc.mkdir(parents=True)
    (calc / "INCAR").write_text("ENCUT=520\n")
    (calc / "STATUS.md").write_text(cl.render_status(cl.Status(
        title="c", state="RUNNING", jobid="42")))
    with pytest.raises(cl.CampaignError) as ei:
        cl.submit_calc(str(root), "calc/01-stability-formation-energy/c", "lab")
    assert "already RUNNING" in str(ei.value) and "42" in str(ei.value)


def test_submit_force_overrides_running_guard(tmp_path, _mock_run):
    root = cl.scaffold_project(tmp_path / "p", "p", template="saa_her")
    (root / "cluster.md").write_text(_good_cluster_md())
    (root / "scripts" / "reference_job.sb").write_text(
        "#!/bin/bash\n#SBATCH --time=1:00:00\nsrun vasp_std\n")
    calc = root / "calc" / "01-stability-formation-energy" / "c"
    calc.mkdir(parents=True)
    (calc / "INCAR").write_text("ENCUT=520\n")
    (calc / "STATUS.md").write_text(cl.render_status(cl.Status(
        title="c", state="RUNNING", jobid="42")))
    res = cl.submit_calc(str(root), "calc/01-stability-formation-energy/c", "lab",
                         now="t0", force=True)
    assert res["jobid"] == "55"   # resubmitted (fake sbatch returns 55)


def test_submit_proceeds_when_status_done(tmp_path, _mock_run):
    root = cl.scaffold_project(tmp_path / "p", "p", template="saa_her")
    (root / "cluster.md").write_text(_good_cluster_md())
    (root / "scripts" / "reference_job.sb").write_text(
        "#!/bin/bash\n#SBATCH --time=1:00:00\nsrun vasp_std\n")
    calc = root / "calc" / "01-stability-formation-energy" / "c"
    calc.mkdir(parents=True)
    (calc / "INCAR").write_text("ENCUT=520\n")
    (calc / "STATUS.md").write_text(cl.render_status(cl.Status(
        title="c", state="DONE", jobid="42")))   # DONE -> resubmit allowed (no guard)
    res = cl.submit_calc(str(root), "calc/01-stability-formation-energy/c", "lab", now="t0")
    assert res["jobid"] == "55"


# ---- scientific-config sanity gate (P1: safety-critical, pre-submission) ----

def test_sanity_gate_blocks_encut_below_enmax(tmp_path):
    calc = tmp_path / "c"
    calc.mkdir()
    (calc / "INCAR").write_text("ENCUT = 200\nISMEAR = 1\n")
    (calc / "POSCAR").write_text("c\n1\n1 0 0\n0 1 0\n0 0 1\nPt O\n9 1\n")
    try:
        cl.sanity_check_inputs(calc, force=False)
        assert False, "expected a blocking CampaignError"
    except cl.CampaignError as exc:
        assert "ENCUT" in str(exc) and "force" in str(exc).lower()


def test_sanity_gate_force_overrides_block(tmp_path):
    calc = tmp_path / "c"
    calc.mkdir()
    (calc / "INCAR").write_text("ENCUT = 200\n")
    (calc / "POSCAR").write_text("c\n1\n1 0 0\n0 1 0\n0 0 1\nPt O\n9 1\n")
    lines = cl.sanity_check_inputs(calc, force=True)  # must NOT raise
    assert any("ENCUT" in l for l in lines)


def test_sanity_gate_warnings_do_not_block(tmp_path):
    calc = tmp_path / "c"
    calc.mkdir()
    (calc / "INCAR").write_text("ENCUT = 450\nISMEAR = 1\nSIGMA = 0.1\n")  # 450<520 = warn
    (calc / "POSCAR").write_text("c\n1\n1 0 0\n0 1 0\n0 0 1\nPt O\n9 1\n")
    lines = cl.sanity_check_inputs(calc, force=False)  # warn-only, no raise
    assert any("ENCUT" in l for l in lines)


def test_sanity_gate_no_incar_returns_empty(tmp_path):
    calc = tmp_path / "c"
    calc.mkdir()
    assert cl.sanity_check_inputs(calc, force=False) == []


def test_scaffold_writes_agent_claude_md(tmp_path):
    root = cl.scaffold_project(tmp_path / "p", "p", template="blank")
    c = root / "CLAUDE.md"
    assert c.is_file()
    t = c.read_text()
    assert "catgo-campaign" in t              # points at the skill
    assert "Resume" in t and "STATUS.md" in t # resume recipe
    assert "see `README.md`" in t             # defers description to README (no overlap)

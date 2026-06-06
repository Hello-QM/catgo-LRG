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
        cluster="expanse", ssh_host="expanse", account="sdp126",
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
    "source /home/wli7/intel/oneapi/setvars.sh\nconda activate pmg\n"
    "srun vasp_std > vasp.log 2>&1\n"
)


def test_adapt_overrides_directives_keeps_preamble_once():
    out = cl.adapt_job_script(
        _REF, job_name="Pt1-Cu_SAA", work_dir="/w", account="sdp126",
        partition="shared", walltime="12:00:00", ntasks="64",
        run_command="srun vasp_std",
    )
    assert "#SBATCH --job-name=Pt1-Cu_SAA" in out
    assert "#SBATCH --time=12:00:00" in out
    assert "#SBATCH --account=sdp126" in out
    assert "old" not in out and "01:00:00" not in out
    assert "source /home/wli7/intel/oneapi/setvars.sh" in out
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
        cluster="expanse", ssh_host="lab", account="sdp126", partition="shared",
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

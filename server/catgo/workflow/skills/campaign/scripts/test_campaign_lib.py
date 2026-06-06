"""campaign_lib — dev verification for the error-prone, safety-critical logic."""
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

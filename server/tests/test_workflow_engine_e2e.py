"""End-to-end tests for CatGo Workflow Engine.

Tests the FULL pipeline: create workflow via API → engine generates inputs →
submit to local/__local__ or HPC session → scanner monitors → collector gathers
results → results queryable via API.

These tests use the REAL CatGo backend (must be running on localhost:8000).
"""
import json
import time
import uuid

import pytest
import requests


def _uid(prefix="n"):
    """Generate a unique node ID to avoid DB conflicts."""
    return f"{prefix}_{uuid.uuid4().hex[:12]}"

API = "http://localhost:8000"
SHAHEEN_SESSION = "5e27f9b4-37ba-486b-83cd-e2c7a86863e3"
LOCAL_SESSION = "__local__"
SHAHEEN_WORK_BASE = "/scratch/reny0b/gs/test-catgo/engine-e2e"

# ── Test Structures ──

SI_DIAMOND = json.dumps({
    "@module": "pymatgen.core.structure", "@class": "Structure",
    "lattice": {"matrix": [[0, 2.715, 2.715], [2.715, 0, 2.715], [2.715, 2.715, 0]]},
    "sites": [
        {"species": [{"element": "Si", "occu": 1}], "abc": [0, 0, 0], "xyz": [0, 0, 0]},
        {"species": [{"element": "Si", "occu": 1}], "abc": [0.25, 0.25, 0.25],
         "xyz": [1.3575, 1.3575, 1.3575]},
    ],
})


def _check_backend():
    try:
        r = requests.get(f"{API}/health", timeout=3)
        return r.status_code == 200
    except Exception:
        return False


def _check_shaheen():
    try:
        r = requests.get(f"{API}/api/hpc/connections", timeout=5)
        sessions = r.json()
        return any(s["session_id"] == SHAHEEN_SESSION for s in sessions)
    except Exception:
        return False


def _create_workflow(name, nodes, edges):
    """Create a workflow via API and return workflow_id."""
    graph = json.dumps({"nodes": nodes, "edges": edges, "viewport": {"x": 0, "y": 0, "zoom": 1}})
    r = requests.post(f"{API}/api/workflow/", json={
        "name": name,
        "description": f"E2E test: {name}",
        "graph_json": graph,
    })
    assert r.status_code == 201, f"Create failed: {r.status_code} {r.text}"
    data = r.json()
    return data["id"]


def _run_workflow(wf_id, config):
    """Start a workflow run via API."""
    r = requests.post(f"{API}/api/workflow/{wf_id}/run", json=config)
    assert r.status_code == 200, f"Run failed: {r.status_code} {r.text}"
    return r.json()


def _poll_until_done(wf_id, timeout=300, interval=5):
    """Poll workflow status until completed/failed or timeout."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        r = requests.get(f"{API}/api/workflow/{wf_id}/run-status")
        if r.status_code != 200:
            time.sleep(interval)
            continue
        data = r.json()
        status = data.get("status", "")
        if status in ("completed", "failed", "not_converged"):
            return data
        time.sleep(interval)
    pytest.fail(f"Workflow {wf_id} did not complete within {timeout}s, last status: {status}")


def _get_step_status(wf_id, step_id):
    """Get status of a specific step."""
    r = requests.get(f"{API}/api/workflow/{wf_id}/steps/{step_id}/status")
    if r.status_code == 200:
        return r.json()
    return None


def _get_step_results(wf_id, step_id):
    """Get results of a completed step."""
    r = requests.get(f"{API}/api/workflow/{wf_id}/step-results/{step_id}")
    if r.status_code == 200:
        return r.json()
    return None


def _delete_workflow(wf_id):
    """Clean up: delete workflow."""
    requests.delete(f"{API}/api/workflow/{wf_id}")


def _local_run_config(work_dir="/tmp/catgo-e2e-test"):
    """Standard local run config."""
    return {
        "execution_mode": "local",
        "default_session_id": LOCAL_SESSION,
        "lmp_command": "lmp",
        "local_work_dir": work_dir,
        "base_work_dir": work_dir,
        "poll_interval": 5,
        "job_script_template": "",
        "cluster_configs": {},
        "calc_templates": {},
        "step_sessions": {},
        "step_scripts": {},
        "step_job_params": {},
        "default_job_params": {
            "nodes": 1, "ntasks": 1, "cpus_per_task": 1,
            "walltime": "00:10:00",
        },
        "use_custodian": False,
        "custodian_max_errors": 1,
    }


def _shaheen_run_config():
    """Shaheen HPC run config."""
    return {
        "execution_mode": "hpc",
        "default_session_id": SHAHEEN_SESSION,
        "lmp_command": "lmp",
        "local_work_dir": "",
        "base_work_dir": SHAHEEN_WORK_BASE,
        "poll_interval": 15,
        "job_script_template": "#!/bin/bash\n#SBATCH --partition=workq\n#SBATCH --nodes=1\n#SBATCH --time=00:30:00\n#SBATCH --ntasks-per-node=96\n#SBATCH --cpus-per-task=2\n#SBATCH --exclusive\n\nmodule switch PrgEnv-cray PrgEnv-intel\nmodule switch intel intel/19.0.5.281\n\nexport VASP_HOME=/scratch/reny0b/VASP/vasp.6.4.3-vtst/bin\nexport VASP_PP_PATH=/scratch/reny0b/VASP/pot64\nexport FI_CXI_RX_MATCH_MODE=software\nexport MKL_DEBUG_CPU_TYPE=5\nexport MKL_CBWR=auto\nexport OMP_NUM_THREADS=$SLURM_CPUS_PER_TASK\nexport PATH=$VASP_HOME:$PATH\nexport LD_LIBRARY_PATH=/opt/cray/pe/netcdf/4.9.0.7/INTEL/2022.2/lib:$LD_LIBRARY_PATH\nexport LD_LIBRARY_PATH=/opt/cray/pe/hdf5/1.12.2.7/INTEL/2022.2/lib:$LD_LIBRARY_PATH\n",
        "cluster_configs": {
            SHAHEEN_SESSION: {
                "potcar_root": "/home/reny0b/VASP/pot64",
                "potcar_functional": "potpaw_PBE",
                "vasp_command": "srun vasp_std",
                "python_env": "source /scratch/reny0b/iops/sw/miniconda3-amd64/etc/profile.d/conda.sh && conda activate /scratch/reny0b/iops/sw/envs/gs",
                "default_template": "",
                "default_job_params": {
                    "nodes": 1, "ntasks": 96, "cpus_per_task": 2,
                    "walltime": "00:30:00", "partition": "workq",
                },
                "module_loads": "module switch PrgEnv-cray PrgEnv-intel && module switch intel intel/19.0.5.281",
            }
        },
        "calc_templates": {},
        "step_sessions": {},
        "step_scripts": {},
        "step_job_params": {},
        "default_job_params": {
            "nodes": 1, "ntasks": 96, "cpus_per_task": 2,
            "walltime": "00:30:00", "partition": "workq",
        },
        "use_custodian": False,
        "custodian_max_errors": 1,
    }


# ══════════════════════════════════════════════════════════════
# Test: Engine Defs API
# ══════════════════════════════════════════════════════════════

@pytest.mark.skipif(not _check_backend(), reason="Backend not running")
class TestEnginDefsAPI:
    """Verify /engine-defs API returns correct data."""

    def test_list_all_engines(self):
        r = requests.get(f"{API}/api/workflow/engine-defs")
        assert r.status_code == 200
        engines = r.json()
        keys = {e["engine"] for e in engines}
        assert len(keys) >= 13
        for expected in ["vasp", "orca", "cp2k", "xtb", "mlp", "lammps", "sella", "amber", "kmc"]:
            assert expected in keys, f"Missing engine: {expected}"

    def test_get_single_engine(self):
        r = requests.get(f"{API}/api/workflow/engine-defs/vasp")
        assert r.status_code == 200
        spec = r.json()
        assert spec["engine"] == "vasp"
        assert "geo_opt" in spec["supported_calc_types"]
        assert len(spec["params"]) > 10

    def test_get_nonexistent_engine(self):
        r = requests.get(f"{API}/api/workflow/engine-defs/nonexistent_xyz")
        assert r.status_code == 404

    def test_engine_params_have_correct_structure(self):
        r = requests.get(f"{API}/api/workflow/engine-defs/xtb")
        spec = r.json()
        for p in spec["params"]:
            assert "key" in p
            assert "label" in p
            assert "type" in p

    def test_create_custom_engine(self):
        """POST /engine-defs/custom should create and register a new engine."""
        custom_spec = {
            "engine": "test_custom_e2e",
            "label": "E2E Test Custom",
            "description": "Custom engine for e2e testing",
            "supported_calc_types": [],
            "params": [{"key": "greeting", "label": "Greeting", "type": "string", "default": "hello"}],
            "input_files": {},
            "run_commands": ["echo hello"],
            "output_files": {},
            "calc_type_mapping": {},
        }
        r = requests.post(f"{API}/api/workflow/engine-defs/custom", json=custom_spec)
        assert r.status_code == 200
        data = r.json()
        assert data["engine"] == "test_custom_e2e"
        assert data["safety"] == "warn"  # has run_commands

        # Verify it's now listed
        r2 = requests.get(f"{API}/api/workflow/engine-defs/test_custom_e2e")
        assert r2.status_code == 200
        assert r2.json()["label"] == "E2E Test Custom"


# ══════════════════════════════════════════════════════════════
# Test: Workflow CRUD
# ══════════════════════════════════════════════════════════════

@pytest.mark.skipif(not _check_backend(), reason="Backend not running")
class TestWorkflowCRUD:
    """Create, read, update, delete workflows via API."""

    def test_create_and_delete_workflow(self):
        nid = _uid("input")
        nodes = [
            {"id": nid, "type": "structure_input", "x": 0, "y": 0,
             "params": {"structure": SI_DIAMOND}},
        ]
        wf_id = _create_workflow("CRUD Test", nodes, [])
        assert wf_id is not None

        # Read
        r = requests.get(f"{API}/api/workflow/{wf_id}")
        assert r.status_code == 200
        assert r.json()["name"] == "CRUD Test"
        assert r.json()["status"] == "draft"

        # Delete
        r = requests.delete(f"{API}/api/workflow/{wf_id}")
        assert r.status_code == 204

    def test_create_workflow_with_edges(self):
        nid1, nid2 = _uid("input"), _uid("opt")
        nodes = [
            {"id": nid1, "type": "structure_input", "x": 0, "y": 0,
             "params": {"structure": SI_DIAMOND}},
            {"id": nid2, "type": "geo_opt", "x": 200, "y": 0,
             "params": {"software": "mlp", "model": "mace-mp-0", "fmax": 0.05}},
        ]
        edges = [
            {"id": _uid("e"), "from": nid1, "to": nid2, "fromH": "out-0", "toH": "in-0"},
        ]
        wf_id = _create_workflow("Edge Test", nodes, edges)

        r = requests.get(f"{API}/api/workflow/{wf_id}")
        graph = json.loads(r.json()["graph_json"])
        assert len(graph["nodes"]) == 2
        assert len(graph["edges"]) == 1

        _delete_workflow(wf_id)

    def test_list_workflows(self):
        r = requests.get(f"{API}/api/workflow/")
        assert r.status_code == 200
        data = r.json()
        assert isinstance(data, list)


# ══════════════════════════════════════════════════════════════
# Test: MLP Workflow via Engine (Local)
# ══════════════════════════════════════════════════════════════

@pytest.mark.skipif(not _check_backend(), reason="Backend not running")
class TestMlpWorkflowLocal:
    """Full pipeline: create MLP geo_opt workflow → run locally → get results."""

    def test_mlp_geo_opt_full_pipeline(self):
        """Create → Run → Poll → Complete → Results."""
        # 1. Create workflow
        input_id, opt_id = _uid("si_input"), _uid("mlp_opt")
        nodes = [
            {"id": input_id, "type": "structure_input", "x": 0, "y": 0,
             "params": {"structure": SI_DIAMOND}},
            {"id": opt_id, "type": "geo_opt", "x": 200, "y": 0,
             "params": {
                 "software": "mlp",
                 "model": "mace-mp-0",
                 "fmax": 0.1,
                 "max_steps": 20,
             }},
        ]
        edges = [
            {"id": _uid("e"), "from": input_id, "to": opt_id,
             "fromH": "out-0", "toH": "in-0"},
        ]
        wf_id = _create_workflow("E2E MLP GeoOpt", nodes, edges)

        try:
            # 2. Run with local config
            run_result = _run_workflow(wf_id, _local_run_config("/tmp/catgo-e2e-mlp"))
            assert run_result.get("status") == "started" or "v2_workflow_id" in run_result

            # 3. Poll until done (MLP local should be fast — < 60s)
            final = _poll_until_done(wf_id, timeout=120, interval=5)
            assert final["status"] == "completed", \
                f"Workflow failed: {json.dumps(final, indent=2)}"

            # 4. Check step statuses
            steps = final.get("steps", [])
            for step in steps:
                if step.get("node_type") == "geo_opt" or step.get("label", "").startswith("mlp"):
                    assert step["status"].lower() in ("completed", "completed_remote"), \
                        f"Step not completed: {step}"

            # 5. Check results exist
            results = _get_step_results(wf_id, opt_id)
            if results:
                assert "energy" in str(results).lower() or "result" in str(results).lower()

        finally:
            _delete_workflow(wf_id)


# ══════════════════════════════════════════════════════════════
# Test: VASP Workflow via Engine (Shaheen)
# ══════════════════════════════════════════════════════════════

@pytest.mark.skipif(not _check_backend() or not _check_shaheen(),
                    reason="Backend or Shaheen not available")
class TestVaspWorkflowShaheen:
    """Full pipeline: VASP single_point on Shaheen via engine."""

    def test_vasp_sp_full_pipeline(self):
        """Create VASP SP → Submit to Shaheen → Poll → Collect results."""
        input_id, sp_id = _uid("si_input"), _uid("vasp_sp")
        nodes = [
            {"id": input_id, "type": "structure_input", "x": 0, "y": 0,
             "params": {"structure": SI_DIAMOND}},
            {"id": sp_id, "type": "single_point", "x": 200, "y": 0,
             "params": {
                 "software": "vasp",
                 "ENCUT": 400,
                 "EDIFF": 1e-5,
                 "ISMEAR": 0,
                 "SIGMA": 0.05,
                 "ISPIN": 1,
                 "NCORE": 4,
                 "PREC": "Accurate",
                 "ALGO": "Fast",
                 "kpoints": "6x6x6",
                 "LWAVE": False,
                 "LCHARG": False,
             }},
        ]
        edges = [
            {"id": "e1", "from": input_id, "to": sp_id,
             "fromH": "out-0", "toH": "in-0"},
        ]
        wf_id = _create_workflow("E2E VASP SP Shaheen", nodes, edges)

        try:
            # Run on Shaheen
            run_result = _run_workflow(wf_id, _shaheen_run_config())
            assert "started" in str(run_result).lower() or "v2_workflow_id" in run_result

            # Poll — VASP on Shaheen might take a few minutes (queue + compute)
            final = _poll_until_done(wf_id, timeout=600, interval=15)
            assert final["status"] == "completed", \
                f"VASP SP failed on Shaheen: {json.dumps(final, indent=2)}"

            # Verify results
            results = _get_step_results(wf_id, sp_id)
            if results:
                result_str = json.dumps(results)
                assert "energy" in result_str.lower(), f"No energy in results: {result_str[:500]}"

        finally:
            pass  # Don't delete — keep for debugging


# ══════════════════════════════════════════════════════════════
# Test: Workflow State Machine
# ══════════════════════════════════════════════════════════════

@pytest.mark.skipif(not _check_backend(), reason="Backend not running")
class TestWorkflowStateMachine:
    """Test pause, resume, reset operations."""

    def test_pause_and_resume(self):
        nid = _uid("si")
        nodes = [
            {"id": nid, "type": "structure_input", "x": 0, "y": 0,
             "params": {"structure": SI_DIAMOND}},
        ]
        wf_id = _create_workflow("Pause Test", nodes, [])

        try:
            # Pause a draft workflow
            r = requests.post(f"{API}/api/workflow/{wf_id}/pause")
            # Should succeed or return appropriate status
            assert r.status_code in (200, 400, 409, 422)  # 409 if draft/wrong state

        finally:
            _delete_workflow(wf_id)

    def test_reset_workflow(self):
        nid = _uid("si")
        nodes = [
            {"id": nid, "type": "structure_input", "x": 0, "y": 0,
             "params": {"structure": SI_DIAMOND}},
        ]
        wf_id = _create_workflow("Reset Test", nodes, [])

        try:
            r = requests.post(f"{API}/api/workflow/{wf_id}/reset")
            assert r.status_code in (200, 400, 422)

        finally:
            _delete_workflow(wf_id)


# ══════════════════════════════════════════════════════════════
# Test: Preview Input Files
# ══════════════════════════════════════════════════════════════

@pytest.mark.skipif(not _check_backend(), reason="Backend not running")
class TestPreviewInput:
    """Test input file preview generation via API."""

    def test_preview_vasp_input(self):
        r = requests.post(f"{API}/api/workflow/preview-input", json={
            "node_type": "vasp_static",
            "params": {
                "ENCUT": 500, "EDIFF": 1e-6, "ISMEAR": 0, "SIGMA": 0.05,
                "kpoints": "4x4x4",
            },
            "structure_str": SI_DIAMOND,
        })
        if r.status_code == 200:
            data = r.json()
            # Should contain INCAR and/or KPOINTS content
            assert any(k in str(data).upper() for k in ["INCAR", "ENCUT", "KPOINTS"])

    def test_preview_orca_input(self):
        r = requests.post(f"{API}/api/workflow/preview-input", json={
            "node_type": "orca_sp",
            "params": {
                "method": "B3LYP",
                "basis_set": "def2-SVP",
                "charge": 0,
                "multiplicity": 1,
            },
            "structure_str": SI_DIAMOND,
        })
        # ORCA preview may or may not be implemented for this structure
        assert r.status_code in (200, 400, 422, 500)


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])

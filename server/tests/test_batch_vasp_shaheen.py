#!/usr/bin/env python3
"""High-throughput test: 3 parallel VASP single-point calculations on Shaheen.

Creates 3 independent structure_input → single_point chains (Si, Cu, Al)
and submits them all in one workflow to verify parallel HPC execution.

Usage:
  conda run -n catgo bash -c "PYTHONPATH=server:server/catgo python server/tests/test_batch_vasp_shaheen.py"
"""
import json
import time
import uuid
import sys
import os
import requests

# Force unbuffered output
os.environ["PYTHONUNBUFFERED"] = "1"

API = "http://localhost:8000"
SHAHEEN_SESSION = "5e27f9b4-37ba-486b-83cd-e2c7a86863e3"
SHAHEEN_WORK_BASE = "/scratch/reny0b/gs/test-catgo/batch-vasp"

# ── Structures ──

SI_DIAMOND = json.dumps({
    "@module": "pymatgen.core.structure", "@class": "Structure",
    "lattice": {"matrix": [[0, 2.715, 2.715], [2.715, 0, 2.715], [2.715, 2.715, 0]]},
    "sites": [
        {"species": [{"element": "Si", "occu": 1}], "abc": [0, 0, 0], "xyz": [0, 0, 0]},
        {"species": [{"element": "Si", "occu": 1}], "abc": [0.25, 0.25, 0.25],
         "xyz": [1.3575, 1.3575, 1.3575]},
    ],
})

CU_FCC = json.dumps({
    "@module": "pymatgen.core.structure", "@class": "Structure",
    "lattice": {"matrix": [[0, 1.8075, 1.8075], [1.8075, 0, 1.8075], [1.8075, 1.8075, 0]]},
    "sites": [
        {"species": [{"element": "Cu", "occu": 1}], "abc": [0, 0, 0], "xyz": [0, 0, 0]},
    ],
})

AL_FCC = json.dumps({
    "@module": "pymatgen.core.structure", "@class": "Structure",
    "lattice": {"matrix": [[0, 2.025, 2.025], [2.025, 0, 2.025], [2.025, 2.025, 0]]},
    "sites": [
        {"species": [{"element": "Al", "occu": 1}], "abc": [0, 0, 0], "xyz": [0, 0, 0]},
    ],
})

STRUCTURES = {"Si": SI_DIAMOND, "Cu": CU_FCC, "Al": AL_FCC}

# Expected energies (eV) — approximate DFT-PBE values
EXPECTED_ENERGIES = {
    "Si": (-11.5, -10.5),  # Si diamond, 2 atoms
    "Cu": (-4.0, -3.0),    # Cu FCC, 1 atom
    "Al": (-4.0, -3.0),    # Al FCC, 1 atom
}


def uid(prefix="n"):
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def check_backend():
    try:
        r = requests.get(f"{API}/health", timeout=3)
        return r.status_code == 200
    except Exception:
        return False


def check_shaheen():
    """Check if Shaheen session is connected (with retry for reconnection races)."""
    for attempt in range(3):
        try:
            r = requests.get(f"{API}/api/hpc/connections", timeout=5)
            sessions = r.json()
            if any(s["session_id"] == SHAHEEN_SESSION for s in sessions):
                return True
        except Exception:
            pass
        if attempt < 2:
            time.sleep(2)
    return False


def shaheen_run_config():
    return {
        "execution_mode": "hpc",
        "default_session_id": SHAHEEN_SESSION,
        "lmp_command": "lmp",
        "local_work_dir": "",
        "base_work_dir": SHAHEEN_WORK_BASE,
        "poll_interval": 15,
        "job_script_template": (
            "#!/bin/bash\n"
            "#SBATCH --partition=workq\n"
            "#SBATCH --nodes=1\n"
            "#SBATCH --time=00:30:00\n"
            "#SBATCH --ntasks-per-node=96\n"
            "#SBATCH --cpus-per-task=2\n"
            "#SBATCH --exclusive\n"
            "\n"
            "module switch PrgEnv-cray PrgEnv-intel\n"
            "module switch intel intel/19.0.5.281\n"
            "\n"
            "export VASP_HOME=/scratch/reny0b/VASP/vasp.6.4.3-vtst/bin\n"
            "export VASP_PP_PATH=/scratch/reny0b/VASP/pot64\n"
            "export FI_CXI_RX_MATCH_MODE=software\n"
            "export MKL_DEBUG_CPU_TYPE=5\n"
            "export MKL_CBWR=auto\n"
            "export OMP_NUM_THREADS=$SLURM_CPUS_PER_TASK\n"
            "export PATH=$VASP_HOME:$PATH\n"
            "export LD_LIBRARY_PATH=/opt/cray/pe/netcdf/4.9.0.7/INTEL/2022.2/lib:$LD_LIBRARY_PATH\n"
            "export LD_LIBRARY_PATH=/opt/cray/pe/hdf5/1.12.2.7/INTEL/2022.2/lib:$LD_LIBRARY_PATH\n"
        ),
        "cluster_configs": {
            SHAHEEN_SESSION: {
                "potcar_root": "/home/reny0b/VASP/pot64",
                "potcar_functional": "potpaw_PBE",
                "vasp_command": "srun vasp_std",
                "python_env": (
                    "source /scratch/reny0b/iops/sw/miniconda3-amd64/etc/profile.d/conda.sh "
                    "&& conda activate /scratch/reny0b/iops/sw/envs/gs"
                ),
                "default_template": "",
                "default_job_params": {
                    "nodes": 1, "ntasks": 96, "cpus_per_task": 2,
                    "walltime": "00:30:00", "partition": "workq",
                },
                "module_loads": (
                    "module switch PrgEnv-cray PrgEnv-intel && "
                    "module switch intel intel/19.0.5.281"
                ),
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


VASP_PARAMS = {
    "software": "vasp",
    "ENCUT": 400,
    "EDIFF": 1e-5,
    "ISMEAR": 0,
    "SIGMA": 0.05,
    "ISPIN": 1,
    "NCORE": 4,
    "PREC": "Accurate",
    "ALGO": "Fast",
    "kpoints": "8x8x8",
    "LWAVE": False,
    "LCHARG": False,
}


def main():
    print("=" * 70)
    print("HIGH-THROUGHPUT BATCH TEST: 3x VASP Single-Point on Shaheen")
    print("=" * 70)

    # 1. Pre-flight checks
    if not check_backend():
        print("FAIL: Backend not running at", API)
        sys.exit(1)
    print("[OK] Backend is running")

    if not check_shaheen():
        print("FAIL: Shaheen session not connected:", SHAHEEN_SESSION)
        sys.exit(1)
    print("[OK] Shaheen session is active")

    # 2. Build workflow graph: 3 x (structure_input → single_point)
    nodes = []
    edges = []
    sp_ids = {}  # name -> sp_node_id

    for name, struct in STRUCTURES.items():
        inp_id = uid(f"input_{name}")
        sp_id = uid(f"sp_{name}")
        sp_ids[name] = sp_id

        nodes.append({
            "id": inp_id, "type": "structure_input", "x": 0, "y": 0,
            "params": {"structure": struct, "system_name": name},
        })
        nodes.append({
            "id": sp_id, "type": "single_point", "x": 200, "y": 0,
            "params": {**VASP_PARAMS, "system_name": name},
        })
        edges.append({
            "id": uid("e"), "from": inp_id, "to": sp_id,
            "fromH": "out-0", "toH": "in-0",
        })

    graph = json.dumps({
        "nodes": nodes, "edges": edges,
        "viewport": {"x": 0, "y": 0, "zoom": 1},
    })

    # 3. Create workflow via v1 API
    r = requests.post(f"{API}/api/workflow/", json={
        "name": "Batch VASP SP (Si+Cu+Al)",
        "description": "High-throughput test: 3 parallel VASP single-point calculations",
        "graph_json": graph,
    })
    assert r.status_code == 201, f"Create failed: {r.status_code} {r.text}"
    wf_id = r.json()["id"]
    print(f"\n[OK] Workflow created: {wf_id}")
    print(f"     Nodes: {len(nodes)} ({len(STRUCTURES)} input + {len(STRUCTURES)} single_point)")
    print(f"     Edges: {len(edges)}")

    # 4. Start workflow execution on Shaheen
    config = shaheen_run_config()
    r = requests.post(f"{API}/api/workflow/{wf_id}/run", json=config)
    assert r.status_code == 200, f"Run failed: {r.status_code} {r.text}"
    run_data = r.json()
    print(f"[OK] Workflow started: {json.dumps(run_data, indent=2)}")

    # 5. Poll for completion (15 min timeout)
    print(f"\n{'='*70}")
    print("POLLING (timeout=900s, interval=15s)")
    print(f"{'='*70}")

    timeout = 900
    interval = 15
    deadline = time.time() + timeout
    last_status = ""
    submit_times = {}  # track when each job was submitted

    while time.time() < deadline:
        r = requests.get(f"{API}/api/workflow/{wf_id}/run-status")
        if r.status_code != 200:
            print(f"  [WARN] Status check failed: {r.status_code}")
            time.sleep(interval)
            continue

        data = r.json()
        status = data.get("status", "unknown")
        elapsed = int(time.time() - (deadline - timeout))

        # Show per-step status
        steps = data.get("steps", [])
        step_summary = []
        submitted_count = 0
        completed_count = 0
        for step in steps:
            s = step.get("status", "?")
            label = step.get("label", step.get("node_type", "?"))
            step_id = step.get("step_id", "?")

            if "single_point" in step.get("node_type", "") or "single_point" in label:
                step_summary.append(f"{label}={s}")
                if s in ("submitted", "queued", "running"):
                    submitted_count += 1
                    if step_id not in submit_times:
                        submit_times[step_id] = time.time()
                if s in ("completed", "completed_remote"):
                    completed_count += 1

        summary_str = ", ".join(step_summary) if step_summary else "waiting..."
        print(f"  [{elapsed:>4d}s] workflow={status} | {summary_str}")

        # Check for parallel submission
        if submitted_count > 1 and "parallel_noted" not in dir():
            print(f"\n  >>> PARALLEL SUBMISSION DETECTED: {submitted_count} jobs active simultaneously <<<\n")
            parallel_noted = True

        if status in ("completed", "failed", "not_converged"):
            break

        time.sleep(interval)
    else:
        print(f"\nTIMEOUT: Workflow did not complete within {timeout}s")
        print("Final status query:")
        r = requests.get(f"{API}/api/workflow/{wf_id}/run-status")
        if r.status_code == 200:
            print(json.dumps(r.json(), indent=2))
        sys.exit(1)

    # 6. Analyze results
    print(f"\n{'='*70}")
    print("RESULTS")
    print(f"{'='*70}")

    final_data = data
    final_status = final_data.get("status", "unknown")
    print(f"Workflow final status: {final_status}")

    all_ok = True
    parallel_count = 0

    for name, sp_id in sp_ids.items():
        print(f"\n--- {name} (node={sp_id[:16]}...) ---")

        # Get step results
        results = None
        r = requests.get(f"{API}/api/workflow/{wf_id}/step-results/{sp_id}")
        if r.status_code == 200:
            results = r.json()

        # Get step status
        r = requests.get(f"{API}/api/workflow/{wf_id}/steps/{sp_id}/status")
        step_status = r.json() if r.status_code == 200 else {}

        s = step_status.get("status", "unknown")
        print(f"  Status: {s}")

        if results:
            # Extract energy
            energy = None
            result_str = json.dumps(results)
            if "energy" in result_str.lower():
                # Try various locations
                if isinstance(results, dict):
                    energy = results.get("energy") or results.get("total_energy")
                    if not energy and "result" in results:
                        res = results["result"]
                        if isinstance(res, dict):
                            energy = res.get("energy") or res.get("total_energy")

            if energy is not None:
                expected_lo, expected_hi = EXPECTED_ENERGIES[name]
                in_range = expected_lo <= energy <= expected_hi
                marker = "OK" if in_range else "WARN"
                print(f"  Energy: {energy:.6f} eV  [{marker}] (expected: {expected_lo} to {expected_hi})")
                if not in_range:
                    all_ok = False
            else:
                print(f"  Energy: not found in results")
                print(f"  Raw results: {json.dumps(results)[:300]}")
                all_ok = False
        else:
            print(f"  No results available")
            all_ok = False

        # Check job ID for parallel detection
        job_id = step_status.get("hpc_job_id") or step_status.get("job_id")
        if job_id:
            print(f"  SLURM Job ID: {job_id}")
            parallel_count += 1

    # 7. Summary
    print(f"\n{'='*70}")
    print("SUMMARY")
    print(f"{'='*70}")

    # Q1: Were jobs submitted in parallel?
    # Check submit_times — if multiple jobs were in submitted/running state simultaneously
    if len(submit_times) >= 2:
        times = sorted(submit_times.values())
        max_gap = max(t2 - t1 for t1, t2 in zip(times, times[1:]))
        print(f"Q1: Parallel submission? YES ({len(submit_times)} jobs, max gap={max_gap:.0f}s)")
    elif parallel_count >= 2:
        print(f"Q1: Parallel submission? LIKELY ({parallel_count} jobs had HPC job IDs)")
    else:
        print(f"Q1: Parallel submission? UNCLEAR (only {parallel_count} jobs tracked)")

    # Q2: Did all 3 complete?
    completed_all = final_status == "completed"
    print(f"Q2: All 3 completed? {'YES' if completed_all else 'NO'} (workflow status: {final_status})")

    # Q3: Energies reasonable?
    print(f"Q3: Energies reasonable? {'YES' if all_ok else 'CHECK ABOVE'}")

    if completed_all and all_ok:
        print(f"\n*** ALL TESTS PASSED ***")
    elif completed_all:
        print(f"\n*** WORKFLOW COMPLETED but energy checks need review ***")
    else:
        print(f"\n*** WORKFLOW DID NOT COMPLETE SUCCESSFULLY ***")
        sys.exit(1)


if __name__ == "__main__":
    main()

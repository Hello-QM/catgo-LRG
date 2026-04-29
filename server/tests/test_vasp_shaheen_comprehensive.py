#!/usr/bin/env python3
"""Comprehensive VASP tests on Shaheen: single_point (batch), geo_opt, cell_opt.

Usage:
  cd /home/james0001/project/catgo/.worktrees/split-files
  PYTHONPATH=server:server/catgo python server/tests/test_vasp_shaheen_comprehensive.py
"""
import json, time, uuid, sys, os, requests

os.environ["PYTHONUNBUFFERED"] = "1"

API = "http://localhost:8000"
SHAHEEN = "5e27f9b4-37ba-486b-83cd-e2c7a86863e3"
WORK_BASE = "/scratch/reny0b/gs/test-catgo/vasp-comprehensive"

# ── Structures ──────────────────────────────────────────────

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

# Si with slightly distorted position for geo_opt test
SI_DISTORTED = json.dumps({
    "@module": "pymatgen.core.structure", "@class": "Structure",
    "lattice": {"matrix": [[0, 2.715, 2.715], [2.715, 0, 2.715], [2.715, 2.715, 0]]},
    "sites": [
        {"species": [{"element": "Si", "occu": 1}], "abc": [0, 0, 0], "xyz": [0, 0, 0]},
        {"species": [{"element": "Si", "occu": 1}], "abc": [0.26, 0.26, 0.26],
         "xyz": [1.4118, 1.4118, 1.4118]},
    ],
})

# Si with expanded lattice for cell_opt test (a=5.55 vs equilibrium 5.43)
SI_EXPANDED = json.dumps({
    "@module": "pymatgen.core.structure", "@class": "Structure",
    "lattice": {"matrix": [[0, 2.775, 2.775], [2.775, 0, 2.775], [2.775, 2.775, 0]]},
    "sites": [
        {"species": [{"element": "Si", "occu": 1}], "abc": [0, 0, 0], "xyz": [0, 0, 0]},
        {"species": [{"element": "Si", "occu": 1}], "abc": [0.25, 0.25, 0.25],
         "xyz": [1.3875, 1.3875, 1.3875]},
    ],
})


def uid(prefix="n"):
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def check_prereqs():
    """Check backend and Shaheen connectivity."""
    try:
        r = requests.get(f"{API}/health", timeout=3)
        assert r.status_code == 200, f"Health check failed: {r.status_code}"
    except Exception as e:
        print(f"FAIL: Backend not running: {e}")
        sys.exit(1)
    print("[OK] Backend is healthy")

    for attempt in range(3):
        try:
            r = requests.get(f"{API}/api/hpc/connections", timeout=5)
            if any(s["session_id"] == SHAHEEN for s in r.json()):
                print("[OK] Shaheen session is active")
                return
        except Exception:
            pass
        time.sleep(2)
    print("FAIL: Shaheen not connected")
    sys.exit(1)


def shaheen_vasp_config():
    return {
        "execution_mode": "hpc",
        "default_session_id": SHAHEEN,
        "lmp_command": "",
        "local_work_dir": "",
        "base_work_dir": WORK_BASE,
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
            SHAHEEN: {
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


def create_engine_workflow(name, nodes, edges, config):
    """Create workflow via engine API convert endpoint."""
    graph = json.dumps({
        "nodes": nodes, "edges": edges,
        "viewport": {"x": 0, "y": 0, "zoom": 1},
    })
    r = requests.post(f"{API}/api/engine/workflows/convert", json={
        "name": name,
        "graph_json": graph,
        "config": config,
    })
    if r.status_code not in (200, 201):
        print(f"  ERROR creating workflow: {r.status_code} {r.text[:500]}")
        return None
    data = r.json()
    wf_id = data.get("workflow_id") or data.get("id")
    print(f"  Workflow created: {wf_id} ({data.get('task_count', '?')} tasks)")
    return wf_id


def submit_engine_workflow(wf_id):
    """Submit workflow for execution."""
    r = requests.post(f"{API}/api/engine/workflows/{wf_id}/submit")
    if r.status_code not in (200, 201):
        print(f"  ERROR submitting: {r.status_code} {r.text[:500]}")
        return False
    print(f"  Submitted: {json.dumps(r.json(), indent=2)[:300]}")
    return True


def poll_engine_workflow(wf_id, timeout=900, interval=15):
    """Poll workflow until completion or timeout. Returns final data dict."""
    deadline = time.time() + timeout
    last_status = None

    while time.time() < deadline:
        r = requests.get(f"{API}/api/engine/workflows/{wf_id}")
        if r.status_code != 200:
            print(f"  [WARN] Poll failed: {r.status_code}")
            time.sleep(interval)
            continue

        data = r.json()
        wf = data.get("workflow", data)
        status = wf.get("status", "unknown")
        elapsed = int(deadline - timeout - (deadline - time.time() - timeout) + (time.time() - (deadline - timeout)))
        elapsed = int(time.time() - (deadline - timeout))

        # Show task statuses
        tasks = data.get("tasks", [])
        task_summary = []
        for t in tasks:
            ttype = t.get("task_type", t.get("type", "?"))
            tst = t.get("status", "?")
            if ttype not in ("structure_input",):
                task_summary.append(f"{ttype}={tst}")

        summary = ", ".join(task_summary) if task_summary else "..."
        if status != last_status:
            print(f"  [{elapsed:>4d}s] STATUS CHANGE: {last_status} -> {status} | {summary}")
            last_status = status
        else:
            print(f"  [{elapsed:>4d}s] {status} | {summary}")

        if status in ("completed", "COMPLETED", "finished", "success"):
            return data
        elif status in ("failed", "FAILED", "error"):
            print(f"  WORKFLOW FAILED!")
            for t in tasks:
                err = t.get("error_message") or t.get("error")
                if err:
                    print(f"    Task {t.get('id', '?')[:20]}: {err[:200]}")
            return data

        time.sleep(interval)

    print(f"  TIMEOUT after {timeout}s!")
    return None


def get_task_result(task_id):
    """Get result for a specific task."""
    r = requests.get(f"{API}/api/engine/tasks/{task_id}/result")
    if r.status_code == 200:
        return r.json()
    return None


# ═══════════════════════════════════════════════════════════
# TEST 1: VASP Single-Point Batch (Si + Cu + Al)
# ═══════════════════════════════════════════════════════════
def test_vasp_single_point_batch():
    print("\n" + "=" * 70)
    print("TEST 1: VASP Single-Point Batch (Si + Cu + Al)")
    print("=" * 70)

    structures = {"Si": SI_DIAMOND, "Cu": CU_FCC, "Al": AL_FCC}
    sp_params = {
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

    nodes, edges, sp_ids = [], [], {}
    for name, struct in structures.items():
        inp_id = uid(f"input_{name}")
        sp_id = uid(f"sp_{name}")
        sp_ids[name] = sp_id
        nodes.append({
            "id": inp_id, "type": "structure_input", "x": 0, "y": 0,
            "params": {"structure": struct, "system_name": name},
        })
        nodes.append({
            "id": sp_id, "type": "single_point", "x": 200, "y": 0,
            "params": {**sp_params, "system_name": name},
        })
        edges.append({
            "id": uid("e"), "from": inp_id, "to": sp_id,
            "fromH": "out-0", "toH": "in-0",
        })

    config = shaheen_vasp_config()
    wf_id = create_engine_workflow("VASP SP Batch (Si+Cu+Al)", nodes, edges, config)
    if not wf_id:
        return False

    if not submit_engine_workflow(wf_id):
        return False

    data = poll_engine_workflow(wf_id, timeout=900, interval=15)
    if not data:
        return False

    # Validate results
    expected = {"Si": (-12.0, -10.0), "Cu": (-5.0, -3.0), "Al": (-5.0, -3.0)}
    all_ok = True
    wf = data.get("workflow", data)
    status = wf.get("status", "unknown")

    print(f"\n  Final status: {status}")
    for name, sp_id in sp_ids.items():
        result = get_task_result(sp_id)
        if result:
            energy = None
            if isinstance(result, dict):
                energy = result.get("energy") or result.get("total_energy")
                if not energy and "result" in result:
                    energy = result["result"].get("energy")
            if energy is not None:
                lo, hi = expected[name]
                ok = lo <= energy <= hi
                marker = "PASS" if ok else "FAIL"
                print(f"  {name}: energy={energy:.6f} eV [{marker}] (expected {lo} to {hi})")
                if not ok:
                    all_ok = False
            else:
                print(f"  {name}: energy not found in result: {json.dumps(result)[:200]}")
                all_ok = False
        else:
            print(f"  {name}: no result available")
            all_ok = False

    return status in ("completed", "COMPLETED") and all_ok


# ═══════════════════════════════════════════════════════════
# TEST 2: VASP Geometry Optimization (Si distorted)
# ═══════════════════════════════════════════════════════════
def test_vasp_geo_opt():
    print("\n" + "=" * 70)
    print("TEST 2: VASP Geometry Optimization (Si distorted)")
    print("=" * 70)

    inp_id = uid("input_si")
    opt_id = uid("geo_opt_si")

    nodes = [
        {"id": inp_id, "type": "structure_input", "x": 0, "y": 0,
         "params": {"structure": SI_DISTORTED, "system_name": "Si_distorted"}},
        {"id": opt_id, "type": "geo_opt", "x": 200, "y": 0,
         "params": {
             "software": "vasp",
             "ENCUT": 400, "EDIFF": 1e-5, "EDIFFG": -0.02,
             "NSW": 50, "ISIF": 2, "IBRION": 2,
             "ISMEAR": 0, "SIGMA": 0.05, "ISPIN": 1,
             "NCORE": 4, "PREC": "Accurate", "ALGO": "Fast",
             "kpoints": "8x8x8", "LWAVE": False, "LCHARG": False,
             "system_name": "Si_geo_opt",
         }},
    ]
    edges = [{"id": uid("e"), "from": inp_id, "to": opt_id, "fromH": "out-0", "toH": "in-0"}]

    config = shaheen_vasp_config()
    wf_id = create_engine_workflow("VASP Geo-Opt Si", nodes, edges, config)
    if not wf_id:
        return False

    if not submit_engine_workflow(wf_id):
        return False

    data = poll_engine_workflow(wf_id, timeout=900, interval=15)
    if not data:
        return False

    wf = data.get("workflow", data)
    status = wf.get("status", "unknown")
    print(f"\n  Final status: {status}")

    result = get_task_result(opt_id)
    if result:
        energy = None
        if isinstance(result, dict):
            energy = result.get("energy") or result.get("total_energy")
            if not energy and "result" in result:
                energy = result["result"].get("energy")
        if energy is not None:
            # Si diamond 2-atom cell: ~-10.8 to -11.0 eV
            ok = -12.0 <= energy <= -10.0
            print(f"  Energy: {energy:.6f} eV [{'PASS' if ok else 'FAIL'}]")
        else:
            print(f"  Energy not found in result")

        struct = result.get("structure") or result.get("structure_json")
        if struct:
            print(f"  Optimized structure found: YES")
        else:
            print(f"  Optimized structure: NOT FOUND")
    else:
        print(f"  No result available")

    return status in ("completed", "COMPLETED")


# ═══════════════════════════════════════════════════════════
# TEST 3: VASP Cell Optimization (Si expanded lattice)
# ═══════════════════════════════════════════════════════════
def test_vasp_cell_opt():
    print("\n" + "=" * 70)
    print("TEST 3: VASP Cell Optimization (Si expanded)")
    print("=" * 70)

    inp_id = uid("input_si_exp")
    opt_id = uid("cell_opt_si")

    nodes = [
        {"id": inp_id, "type": "structure_input", "x": 0, "y": 0,
         "params": {"structure": SI_EXPANDED, "system_name": "Si_expanded"}},
        {"id": opt_id, "type": "cell_opt", "x": 200, "y": 0,
         "params": {
             "software": "vasp",
             "ENCUT": 500, "EDIFF": 1e-6, "EDIFFG": -0.01,
             "NSW": 50, "ISIF": 3, "IBRION": 2,
             "ISMEAR": 0, "SIGMA": 0.05, "ISPIN": 1,
             "NCORE": 4, "PREC": "Accurate", "ALGO": "Fast",
             "kpoints": "8x8x8", "LWAVE": False, "LCHARG": False,
             "system_name": "Si_cell_opt",
         }},
    ]
    edges = [{"id": uid("e"), "from": inp_id, "to": opt_id, "fromH": "out-0", "toH": "in-0"}]

    config = shaheen_vasp_config()
    wf_id = create_engine_workflow("VASP Cell-Opt Si", nodes, edges, config)
    if not wf_id:
        return False

    if not submit_engine_workflow(wf_id):
        return False

    data = poll_engine_workflow(wf_id, timeout=900, interval=15)
    if not data:
        return False

    wf = data.get("workflow", data)
    status = wf.get("status", "unknown")
    print(f"\n  Final status: {status}")

    result = get_task_result(opt_id)
    if result:
        energy = None
        if isinstance(result, dict):
            energy = result.get("energy") or result.get("total_energy")
            if not energy and "result" in result:
                energy = result["result"].get("energy")
        if energy is not None:
            ok = -12.0 <= energy <= -10.0
            print(f"  Energy: {energy:.6f} eV [{'PASS' if ok else 'FAIL'}]")
        else:
            print(f"  Energy not found")
    else:
        print(f"  No result available")

    return status in ("completed", "COMPLETED")


# ═══════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════
def main():
    print("=" * 70)
    print("COMPREHENSIVE VASP TEST SUITE — Shaheen HPC")
    print(f"Timestamp: {time.strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 70)

    check_prereqs()

    results = {}

    # Run tests sequentially (each uses HPC resources)
    for name, test_fn in [
        ("VASP Single-Point Batch", test_vasp_single_point_batch),
        ("VASP Geo-Opt", test_vasp_geo_opt),
        ("VASP Cell-Opt", test_vasp_cell_opt),
    ]:
        try:
            results[name] = test_fn()
        except Exception as e:
            print(f"\n  EXCEPTION in {name}: {e}")
            import traceback; traceback.print_exc()
            results[name] = False

    # Summary
    print("\n" + "=" * 70)
    print("VASP TEST SUMMARY")
    print("=" * 70)
    all_pass = True
    for name, passed in results.items():
        marker = "PASS" if passed else "FAIL"
        print(f"  [{marker}] {name}")
        if not passed:
            all_pass = False

    if all_pass:
        print("\n*** ALL VASP TESTS PASSED ***")
    else:
        print("\n*** SOME VASP TESTS FAILED — SEE ABOVE ***")
        sys.exit(1)


if __name__ == "__main__":
    main()

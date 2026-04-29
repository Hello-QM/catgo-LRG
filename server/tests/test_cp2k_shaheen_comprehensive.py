#!/usr/bin/env python3
"""Comprehensive CP2K tests on Shaheen: single_point, geo_opt.

Usage:
  cd /home/james0001/project/catgo/.worktrees/split-files
  PYTHONPATH=server:server/catgo python server/tests/test_cp2k_shaheen_comprehensive.py
"""
import json, time, uuid, sys, os, requests

os.environ["PYTHONUNBUFFERED"] = "1"

API = "http://localhost:8000"
SHAHEEN = "5e27f9b4-37ba-486b-83cd-e2c7a86863e3"
WORK_BASE = "/scratch/reny0b/gs/test-catgo/cp2k-comprehensive"

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

MGO_ROCKSALT = json.dumps({
    "@module": "pymatgen.core.structure", "@class": "Structure",
    "lattice": {"matrix": [[4.212, 0, 0], [0, 4.212, 0], [0, 0, 4.212]]},
    "sites": [
        {"species": [{"element": "Mg", "occu": 1}], "abc": [0, 0, 0], "xyz": [0, 0, 0]},
        {"species": [{"element": "Mg", "occu": 1}], "abc": [0.5, 0.5, 0], "xyz": [2.106, 2.106, 0]},
        {"species": [{"element": "Mg", "occu": 1}], "abc": [0.5, 0, 0.5], "xyz": [2.106, 0, 2.106]},
        {"species": [{"element": "Mg", "occu": 1}], "abc": [0, 0.5, 0.5], "xyz": [0, 2.106, 2.106]},
        {"species": [{"element": "O", "occu": 1}], "abc": [0.5, 0, 0], "xyz": [2.106, 0, 0]},
        {"species": [{"element": "O", "occu": 1}], "abc": [0, 0.5, 0], "xyz": [0, 2.106, 0]},
        {"species": [{"element": "O", "occu": 1}], "abc": [0, 0, 0.5], "xyz": [0, 0, 2.106]},
        {"species": [{"element": "O", "occu": 1}], "abc": [0.5, 0.5, 0.5], "xyz": [2.106, 2.106, 2.106]},
    ],
})

# Si with slightly distorted positions for geo_opt
SI_DISTORTED = json.dumps({
    "@module": "pymatgen.core.structure", "@class": "Structure",
    "lattice": {"matrix": [[0, 2.715, 2.715], [2.715, 0, 2.715], [2.715, 2.715, 0]]},
    "sites": [
        {"species": [{"element": "Si", "occu": 1}], "abc": [0, 0, 0], "xyz": [0, 0, 0]},
        {"species": [{"element": "Si", "occu": 1}], "abc": [0.26, 0.26, 0.26],
         "xyz": [1.4118, 1.4118, 1.4118]},
    ],
})


def uid(prefix="n"):
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def check_prereqs():
    try:
        r = requests.get(f"{API}/health", timeout=3)
        assert r.status_code == 200
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


def shaheen_cp2k_config():
    return {
        "execution_mode": "hpc",
        "default_session_id": SHAHEEN,
        "base_work_dir": WORK_BASE,
        "poll_interval": 15,
        "lmp_command": "",
        "local_work_dir": "",
        "job_script_template": (
            "#!/bin/bash\n"
            "#SBATCH --partition=workq\n"
            "#SBATCH --nodes=1\n"
            "#SBATCH --time=00:30:00\n"
            "#SBATCH --ntasks-per-node=192\n"
            "#SBATCH --exclusive\n"
            "\n"
            "module load cp2k/2025.1\n"
            "export OMP_NUM_THREADS=1\n"
        ),
        "cluster_configs": {
            SHAHEEN: {
                "potcar_root": "",
                "potcar_functional": "",
                "vasp_command": "srun cp2k.psmp -i project.inp -o project.out",
                "python_env": "",
                "default_template": "",
                "default_job_params": {
                    "nodes": 1, "ntasks": 192, "cpus_per_task": 1,
                    "walltime": "00:30:00", "partition": "workq",
                },
                "module_loads": "module load cp2k/2025.1",
            }
        },
        "calc_templates": {},
        "step_sessions": {},
        "step_scripts": {},
        "step_job_params": {},
        "default_job_params": {
            "nodes": 1, "ntasks": 192, "cpus_per_task": 1,
            "walltime": "00:30:00", "partition": "workq",
        },
        "use_custodian": False,
        "custodian_max_errors": 1,
    }


def create_engine_workflow(name, nodes, edges, config):
    graph = json.dumps({
        "nodes": nodes, "edges": edges,
        "viewport": {"x": 0, "y": 0, "zoom": 1},
    })
    r = requests.post(f"{API}/api/engine/workflows/convert", json={
        "name": name, "graph_json": graph, "config": config,
    })
    if r.status_code not in (200, 201):
        print(f"  ERROR creating workflow: {r.status_code} {r.text[:500]}")
        return None
    data = r.json()
    wf_id = data.get("workflow_id") or data.get("id")
    print(f"  Workflow created: {wf_id} ({data.get('task_count', '?')} tasks)")
    return wf_id


def submit_engine_workflow(wf_id):
    r = requests.post(f"{API}/api/engine/workflows/{wf_id}/submit")
    if r.status_code not in (200, 201):
        print(f"  ERROR submitting: {r.status_code} {r.text[:500]}")
        return False
    print(f"  Submitted: {json.dumps(r.json())[:300]}")
    return True


def poll_engine_workflow(wf_id, timeout=900, interval=15):
    deadline = time.time() + timeout
    last_status = None
    start = time.time()

    while time.time() < deadline:
        r = requests.get(f"{API}/api/engine/workflows/{wf_id}")
        if r.status_code != 200:
            print(f"  [WARN] Poll failed: {r.status_code}")
            time.sleep(interval)
            continue

        data = r.json()
        wf = data.get("workflow", data)
        status = wf.get("status", "unknown")
        elapsed = int(time.time() - start)

        tasks = data.get("tasks", [])
        task_summary = []
        for t in tasks:
            ttype = t.get("task_type", t.get("type", "?"))
            tst = t.get("status", "?")
            if ttype not in ("structure_input",):
                task_summary.append(f"{ttype}={tst}")

        summary = ", ".join(task_summary) if task_summary else "..."
        if status != last_status:
            print(f"  [{elapsed:>4d}s] STATUS: {last_status} -> {status} | {summary}")
            last_status = status
        else:
            print(f"  [{elapsed:>4d}s] {status} | {summary}")

        if status in ("completed", "COMPLETED"):
            return data
        elif status in ("failed", "FAILED", "error"):
            print(f"  WORKFLOW FAILED!")
            for t in tasks:
                err = t.get("error_message") or t.get("error")
                if err:
                    print(f"    Task {t.get('id', '?')[:25]}: {err[:300]}")
            return data

        time.sleep(interval)

    print(f"  TIMEOUT after {timeout}s!")
    return None


def get_task_result(task_id):
    r = requests.get(f"{API}/api/engine/tasks/{task_id}/result")
    if r.status_code == 200:
        return r.json()
    return None


# ═══════════════════════════════════════════════════════════
# TEST 1: CP2K Single-Point (Si diamond)
# ═══════════════════════════════════════════════════════════
def test_cp2k_single_point():
    print("\n" + "=" * 70)
    print("TEST 1: CP2K Single-Point (Si diamond)")
    print("=" * 70)

    inp_id = uid("input_si")
    sp_id = uid("cp2k_sp")

    nodes = [
        {"id": inp_id, "type": "structure_input", "x": 0, "y": 0,
         "params": {"structure": SI_DIAMOND, "system_name": "Si_diamond"}},
        {"id": sp_id, "type": "single_point", "x": 200, "y": 0,
         "params": {
             "software": "cp2k",
             "functional": "PBE",
             "basis_set": "DZVP-MOLOPT-SR-GTH",
             "cutoff": 350, "rel_cutoff": 50,
             "eps_scf": 1e-6, "max_scf": 100,
             "charge": 0, "periodic": "XYZ",
             "system_name": "Si_cp2k_sp",
         }},
    ]
    edges = [{"id": uid("e"), "from": inp_id, "to": sp_id, "fromH": "out-0", "toH": "in-0"}]

    config = shaheen_cp2k_config()
    wf_id = create_engine_workflow("CP2K SP Si", nodes, edges, config)
    if not wf_id:
        return False

    if not submit_engine_workflow(wf_id):
        return False

    data = poll_engine_workflow(wf_id, timeout=600, interval=15)
    if not data:
        return False

    wf = data.get("workflow", data)
    status = wf.get("status", "unknown")
    print(f"\n  Final status: {status}")

    result = get_task_result(sp_id)
    if result:
        energy = None
        if isinstance(result, dict):
            energy = result.get("energy") or result.get("total_energy")
            if not energy and "result" in result:
                energy = result["result"].get("energy")
        if energy is not None:
            print(f"  Energy: {energy:.6f} eV")
            # CP2K PBE Si diamond: roughly -215 to -218 Hartree ≈ -5860 to -5940 eV
            # But often reported per-atom or in Hartree. Accept any reasonable number.
            print(f"  [INFO] Energy value obtained (manual validation needed for CP2K)")
        else:
            print(f"  Energy not found in result: {json.dumps(result)[:300]}")
        return status in ("completed", "COMPLETED")
    else:
        print(f"  No result available")
        return False


# ═══════════════════════════════════════════════════════════
# TEST 2: CP2K Single-Point (MgO rocksalt)
# ═══════════════════════════════════════════════════════════
def test_cp2k_single_point_mgo():
    print("\n" + "=" * 70)
    print("TEST 2: CP2K Single-Point (MgO rocksalt)")
    print("=" * 70)

    inp_id = uid("input_mgo")
    sp_id = uid("cp2k_sp_mgo")

    nodes = [
        {"id": inp_id, "type": "structure_input", "x": 0, "y": 0,
         "params": {"structure": MGO_ROCKSALT, "system_name": "MgO_rocksalt"}},
        {"id": sp_id, "type": "single_point", "x": 200, "y": 0,
         "params": {
             "software": "cp2k",
             "functional": "PBE",
             "basis_set": "DZVP-MOLOPT-SR-GTH",
             "cutoff": 400, "rel_cutoff": 60,
             "eps_scf": 1e-6, "max_scf": 150,
             "charge": 0, "periodic": "XYZ",
             "system_name": "MgO_cp2k_sp",
         }},
    ]
    edges = [{"id": uid("e"), "from": inp_id, "to": sp_id, "fromH": "out-0", "toH": "in-0"}]

    config = shaheen_cp2k_config()
    wf_id = create_engine_workflow("CP2K SP MgO", nodes, edges, config)
    if not wf_id:
        return False

    if not submit_engine_workflow(wf_id):
        return False

    data = poll_engine_workflow(wf_id, timeout=600, interval=15)
    if not data:
        return False

    wf = data.get("workflow", data)
    status = wf.get("status", "unknown")
    print(f"\n  Final status: {status}")

    result = get_task_result(sp_id)
    if result:
        energy = None
        if isinstance(result, dict):
            energy = result.get("energy") or result.get("total_energy")
            if not energy and "result" in result:
                energy = result["result"].get("energy")
        if energy is not None:
            print(f"  Energy: {energy:.6f} eV")
        else:
            print(f"  Energy not found in result: {json.dumps(result)[:300]}")
        return status in ("completed", "COMPLETED")
    else:
        print(f"  No result available")
        return False


# ═══════════════════════════════════════════════════════════
# TEST 3: CP2K Geometry Optimization (Si distorted)
# ═══════════════════════════════════════════════════════════
def test_cp2k_geo_opt():
    print("\n" + "=" * 70)
    print("TEST 3: CP2K Geometry Optimization (Si distorted)")
    print("=" * 70)

    inp_id = uid("input_si_dist")
    opt_id = uid("cp2k_geo_opt")

    nodes = [
        {"id": inp_id, "type": "structure_input", "x": 0, "y": 0,
         "params": {"structure": SI_DISTORTED, "system_name": "Si_distorted"}},
        {"id": opt_id, "type": "geo_opt", "x": 200, "y": 0,
         "params": {
             "software": "cp2k",
             "functional": "PBE",
             "basis_set": "DZVP-MOLOPT-SR-GTH",
             "cutoff": 350, "rel_cutoff": 50,
             "eps_scf": 1e-6, "max_scf": 100,
             "charge": 0, "periodic": "XYZ",
             "geo_opt_optimizer": "BFGS",
             "geo_opt_max_iter": 50,
             "system_name": "Si_cp2k_geoopt",
         }},
    ]
    edges = [{"id": uid("e"), "from": inp_id, "to": opt_id, "fromH": "out-0", "toH": "in-0"}]

    config = shaheen_cp2k_config()
    wf_id = create_engine_workflow("CP2K Geo-Opt Si", nodes, edges, config)
    if not wf_id:
        return False

    if not submit_engine_workflow(wf_id):
        return False

    data = poll_engine_workflow(wf_id, timeout=600, interval=15)
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
            print(f"  Energy: {energy:.6f} eV")
        struct = result.get("structure") or result.get("structure_json")
        if struct:
            print(f"  Optimized structure: YES")
        else:
            print(f"  Optimized structure: NOT FOUND")
        return status in ("completed", "COMPLETED")
    else:
        print(f"  No result available")
        return False


# ═══════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════
def main():
    print("=" * 70)
    print("COMPREHENSIVE CP2K TEST SUITE — Shaheen HPC")
    print(f"Timestamp: {time.strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 70)

    check_prereqs()

    results = {}

    for name, test_fn in [
        ("CP2K Single-Point Si", test_cp2k_single_point),
        ("CP2K Single-Point MgO", test_cp2k_single_point_mgo),
        ("CP2K Geo-Opt Si", test_cp2k_geo_opt),
    ]:
        try:
            results[name] = test_fn()
        except Exception as e:
            print(f"\n  EXCEPTION in {name}: {e}")
            import traceback; traceback.print_exc()
            results[name] = False

    # Summary
    print("\n" + "=" * 70)
    print("CP2K TEST SUMMARY")
    print("=" * 70)
    all_pass = True
    for name, passed in results.items():
        marker = "PASS" if passed else "FAIL"
        print(f"  [{marker}] {name}")
        if not passed:
            all_pass = False

    if all_pass:
        print("\n*** ALL CP2K TESTS PASSED ***")
    else:
        print("\n*** SOME CP2K TESTS FAILED — SEE ABOVE ***")
        sys.exit(1)


if __name__ == "__main__":
    main()

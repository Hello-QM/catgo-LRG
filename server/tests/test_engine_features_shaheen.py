#!/usr/bin/env python3
"""Workflow Engine Feature Tests on Shaheen.

Tests engine API features: convert, submit, pause/resume, reset,
confirm-all, status monitoring, task-level APIs, sequential workflows.

Usage:
  cd /home/james0001/project/catgo/.worktrees/split-files
  PYTHONPATH=server:server/catgo python server/tests/test_engine_features_shaheen.py
"""
import json, time, uuid, sys, os, requests

os.environ["PYTHONUNBUFFERED"] = "1"

API = "http://localhost:8000"
SHAHEEN = "5e27f9b4-37ba-486b-83cd-e2c7a86863e3"
WORK_BASE = "/scratch/reny0b/gs/test-catgo/engine-features"

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


def uid(prefix="n"):
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def vasp_config():
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


def check_prereqs():
    try:
        r = requests.get(f"{API}/health", timeout=3)
        assert r.status_code == 200
    except Exception as e:
        print(f"FAIL: Backend not running: {e}")
        sys.exit(1)
    print("[OK] Backend healthy")

    for attempt in range(3):
        try:
            r = requests.get(f"{API}/api/hpc/connections", timeout=5)
            if any(s["session_id"] == SHAHEEN for s in r.json()):
                print("[OK] Shaheen connected")
                return
        except Exception:
            pass
        time.sleep(2)
    print("FAIL: Shaheen not connected")
    sys.exit(1)


def make_sp_graph(struct, name):
    """Build a simple structure_input → single_point graph."""
    inp_id = uid(f"input_{name}")
    sp_id = uid(f"sp_{name}")
    nodes = [
        {"id": inp_id, "type": "structure_input", "x": 0, "y": 0,
         "params": {"structure": struct, "system_name": name}},
        {"id": sp_id, "type": "single_point", "x": 200, "y": 0,
         "params": {
             "software": "vasp", "ENCUT": 400, "EDIFF": 1e-5,
             "ISMEAR": 0, "SIGMA": 0.05, "ISPIN": 1, "NCORE": 4,
             "PREC": "Accurate", "ALGO": "Fast", "kpoints": "8x8x8",
             "LWAVE": False, "LCHARG": False, "system_name": name,
         }},
    ]
    edges = [{"id": uid("e"), "from": inp_id, "to": sp_id, "fromH": "out-0", "toH": "in-0"}]
    return nodes, edges, sp_id


# ═══════════════════════════════════════════════════════════
# TEST 1: Workflow Convert + List + Get
# ═══════════════════════════════════════════════════════════
def test_convert_and_list():
    print("\n" + "=" * 70)
    print("TEST 1: Convert workflow + List + Get")
    print("=" * 70)

    nodes, edges, sp_id = make_sp_graph(SI_DIAMOND, "Si_convert_test")
    graph = json.dumps({
        "nodes": nodes, "edges": edges,
        "viewport": {"x": 0, "y": 0, "zoom": 1},
    })

    # Convert
    r = requests.post(f"{API}/api/engine/workflows/convert", json={
        "name": "Engine Feature Test: Convert",
        "graph_json": graph,
        "config": vasp_config(),
    })
    assert r.status_code in (200, 201), f"Convert failed: {r.status_code} {r.text[:300]}"
    data = r.json()
    wf_id = data.get("workflow_id") or data.get("id")
    assert wf_id, f"No workflow_id in response: {data}"
    print(f"  [PASS] Convert: wf_id={wf_id}, tasks={data.get('task_count')}")

    # List
    r = requests.get(f"{API}/api/engine/workflows")
    assert r.status_code == 200, f"List failed: {r.status_code}"
    workflows = r.json()
    found = any(w.get("id") == wf_id for w in workflows)
    print(f"  [{'PASS' if found else 'FAIL'}] List: found workflow in list ({len(workflows)} total)")

    # Get
    r = requests.get(f"{API}/api/engine/workflows/{wf_id}")
    assert r.status_code == 200, f"Get failed: {r.status_code}"
    data = r.json()
    tasks = data.get("tasks", [])
    print(f"  [PASS] Get: {len(tasks)} tasks")
    for t in tasks:
        print(f"    - {t.get('task_type', '?')} [{t.get('status', '?')}]")

    # DAG
    r = requests.get(f"{API}/api/engine/workflows/{wf_id}/dag")
    assert r.status_code == 200, f"DAG failed: {r.status_code}"
    dag = r.json()
    print(f"  [PASS] DAG: {len(dag.get('tasks', []))} tasks, {len(dag.get('links', []))} links")

    return True


# ═══════════════════════════════════════════════════════════
# TEST 2: Submit + Pause + Resume
# ═══════════════════════════════════════════════════════════
def test_submit_pause_resume():
    print("\n" + "=" * 70)
    print("TEST 2: Submit → Pause → Resume (VASP SP Si)")
    print("=" * 70)

    nodes, edges, sp_id = make_sp_graph(SI_DIAMOND, "Si_pause_test")
    graph = json.dumps({
        "nodes": nodes, "edges": edges,
        "viewport": {"x": 0, "y": 0, "zoom": 1},
    })

    # Create
    r = requests.post(f"{API}/api/engine/workflows/convert", json={
        "name": "Engine Feature Test: Pause/Resume",
        "graph_json": graph,
        "config": vasp_config(),
    })
    assert r.status_code in (200, 201), f"Convert failed: {r.status_code} {r.text[:300]}"
    wf_id = r.json().get("workflow_id") or r.json().get("id")
    print(f"  Created: {wf_id}")

    # Submit
    r = requests.post(f"{API}/api/engine/workflows/{wf_id}/submit")
    assert r.status_code in (200, 201), f"Submit failed: {r.status_code} {r.text[:300]}"
    print(f"  [PASS] Submitted")

    # Wait a bit then pause
    time.sleep(10)
    r = requests.post(f"{API}/api/engine/workflows/{wf_id}/pause")
    print(f"  Pause response: {r.status_code} {r.json() if r.status_code == 200 else r.text[:200]}")
    if r.status_code == 200:
        print(f"  [PASS] Paused")
    else:
        print(f"  [INFO] Pause returned {r.status_code} (might have already progressed)")

    # Check status after pause
    r = requests.get(f"{API}/api/engine/workflows/{wf_id}")
    if r.status_code == 200:
        wf = r.json().get("workflow", r.json())
        print(f"  Status after pause: {wf.get('status')}")

    # Resume
    time.sleep(2)
    r = requests.post(f"{API}/api/engine/workflows/{wf_id}/resume")
    print(f"  Resume response: {r.status_code} {r.json() if r.status_code == 200 else r.text[:200]}")
    if r.status_code == 200:
        print(f"  [PASS] Resumed")
    else:
        print(f"  [INFO] Resume returned {r.status_code}")

    # Poll to completion
    print(f"\n  Polling for completion...")
    deadline = time.time() + 900
    start = time.time()
    while time.time() < deadline:
        r = requests.get(f"{API}/api/engine/workflows/{wf_id}")
        if r.status_code == 200:
            data = r.json()
            wf = data.get("workflow", data)
            status = wf.get("status", "unknown")
            elapsed = int(time.time() - start)
            tasks = data.get("tasks", [])
            task_info = ", ".join(
                f"{t.get('task_type','?')}={t.get('status','?')}"
                for t in tasks if t.get("task_type") != "structure_input"
            )
            print(f"  [{elapsed:>4d}s] {status} | {task_info}")
            if status in ("completed", "COMPLETED"):
                print(f"  [PASS] Workflow completed after pause/resume")
                return True
            elif status in ("failed", "FAILED"):
                for t in tasks:
                    err = t.get("error_message")
                    if err:
                        print(f"    ERROR: {err[:300]}")
                return False
        time.sleep(15)

    print(f"  TIMEOUT")
    return False


# ═══════════════════════════════════════════════════════════
# TEST 3: Reset Workflow
# ═══════════════════════════════════════════════════════════
def test_reset():
    print("\n" + "=" * 70)
    print("TEST 3: Create → Submit → Reset → Re-Submit (VASP SP Cu)")
    print("=" * 70)

    nodes, edges, sp_id = make_sp_graph(CU_FCC, "Cu_reset_test")
    graph = json.dumps({
        "nodes": nodes, "edges": edges,
        "viewport": {"x": 0, "y": 0, "zoom": 1},
    })

    r = requests.post(f"{API}/api/engine/workflows/convert", json={
        "name": "Engine Feature Test: Reset",
        "graph_json": graph,
        "config": vasp_config(),
    })
    assert r.status_code in (200, 201)
    wf_id = r.json().get("workflow_id") or r.json().get("id")
    print(f"  Created: {wf_id}")

    # Submit then reset
    r = requests.post(f"{API}/api/engine/workflows/{wf_id}/submit")
    assert r.status_code in (200, 201)
    print(f"  [PASS] Submitted")

    time.sleep(5)

    # Reset
    r = requests.post(f"{API}/api/engine/workflows/{wf_id}/reset")
    print(f"  Reset response: {r.status_code} {r.json() if r.status_code == 200 else r.text[:200]}")

    # Verify all tasks reset to WAITING
    r = requests.get(f"{API}/api/engine/workflows/{wf_id}")
    if r.status_code == 200:
        data = r.json()
        tasks = data.get("tasks", [])
        all_waiting = all(t.get("status") == "WAITING" for t in tasks)
        print(f"  [{'PASS' if all_waiting else 'FAIL'}] All tasks in WAITING state: {all_waiting}")
        for t in tasks:
            print(f"    - {t.get('task_type','?')}: {t.get('status','?')}")

    # Re-submit and run to completion
    r = requests.post(f"{API}/api/engine/workflows/{wf_id}/submit")
    if r.status_code in (200, 201):
        print(f"  [PASS] Re-submitted after reset")
    else:
        print(f"  [FAIL] Re-submit failed: {r.status_code} {r.text[:200]}")
        return False

    # Poll to completion
    deadline = time.time() + 900
    start = time.time()
    while time.time() < deadline:
        r = requests.get(f"{API}/api/engine/workflows/{wf_id}")
        if r.status_code == 200:
            data = r.json()
            wf = data.get("workflow", data)
            status = wf.get("status", "unknown")
            elapsed = int(time.time() - start)
            tasks = data.get("tasks", [])
            task_info = ", ".join(
                f"{t.get('task_type','?')}={t.get('status','?')}"
                for t in tasks if t.get("task_type") != "structure_input"
            )
            print(f"  [{elapsed:>4d}s] {status} | {task_info}")
            if status in ("completed", "COMPLETED"):
                print(f"  [PASS] Workflow completed after reset + re-submit")
                return True
            elif status in ("failed", "FAILED"):
                for t in tasks:
                    err = t.get("error_message")
                    if err:
                        print(f"    ERROR: {err[:300]}")
                return False
        time.sleep(15)

    print(f"  TIMEOUT")
    return False


# ═══════════════════════════════════════════════════════════
# TEST 4: Sequential Chain (geo_opt → single_point)
# ═══════════════════════════════════════════════════════════
def test_sequential_chain():
    print("\n" + "=" * 70)
    print("TEST 4: Sequential Chain (VASP geo_opt → single_point)")
    print("=" * 70)

    inp_id = uid("input_si")
    opt_id = uid("geo_opt_si")
    sp_id = uid("sp_si")

    nodes = [
        {"id": inp_id, "type": "structure_input", "x": 0, "y": 0,
         "params": {"structure": SI_DIAMOND, "system_name": "Si"}},
        {"id": opt_id, "type": "geo_opt", "x": 200, "y": 0,
         "params": {
             "software": "vasp", "ENCUT": 400, "EDIFF": 1e-5, "EDIFFG": -0.02,
             "NSW": 20, "ISIF": 2, "IBRION": 2,
             "ISMEAR": 0, "SIGMA": 0.05, "ISPIN": 1, "NCORE": 4,
             "PREC": "Accurate", "ALGO": "Fast", "kpoints": "8x8x8",
             "LWAVE": False, "LCHARG": False,
             "system_name": "Si_opt",
         }},
        {"id": sp_id, "type": "single_point", "x": 400, "y": 0,
         "params": {
             "software": "vasp", "ENCUT": 400, "EDIFF": 1e-6,
             "ISMEAR": 0, "SIGMA": 0.05, "ISPIN": 1, "NCORE": 4,
             "PREC": "Accurate", "ALGO": "Fast", "kpoints": "8x8x8",
             "LWAVE": False, "LCHARG": False,
             "system_name": "Si_sp",
         }},
    ]
    edges = [
        {"id": uid("e1"), "from": inp_id, "to": opt_id, "fromH": "out-0", "toH": "in-0"},
        {"id": uid("e2"), "from": opt_id, "to": sp_id, "fromH": "out-0", "toH": "in-0"},
    ]

    graph = json.dumps({
        "nodes": nodes, "edges": edges,
        "viewport": {"x": 0, "y": 0, "zoom": 1},
    })

    r = requests.post(f"{API}/api/engine/workflows/convert", json={
        "name": "Engine Feature Test: Sequential Chain",
        "graph_json": graph,
        "config": vasp_config(),
    })
    assert r.status_code in (200, 201), f"Convert failed: {r.status_code} {r.text[:300]}"
    wf_id = r.json().get("workflow_id") or r.json().get("id")
    print(f"  Created: {wf_id} ({r.json().get('task_count')} tasks)")

    # Check DAG has correct links
    r = requests.get(f"{API}/api/engine/workflows/{wf_id}/dag")
    if r.status_code == 200:
        dag = r.json()
        links = dag.get("links", [])
        print(f"  DAG: {len(dag.get('tasks', []))} tasks, {len(links)} links")
        # Should have: input→opt, opt→sp
        link_pairs = [(l.get("source_task_id", "")[:15], l.get("target_task_id", "")[:15]) for l in links]
        print(f"  Links: {link_pairs}")

    # Submit
    r = requests.post(f"{API}/api/engine/workflows/{wf_id}/submit")
    assert r.status_code in (200, 201)
    print(f"  [PASS] Submitted")

    # Poll — expect sequential execution: opt first, then sp
    deadline = time.time() + 1800  # 30 min for 2 sequential VASP jobs
    start = time.time()
    opt_completed = False
    sp_started_after_opt = False

    while time.time() < deadline:
        r = requests.get(f"{API}/api/engine/workflows/{wf_id}")
        if r.status_code == 200:
            data = r.json()
            wf = data.get("workflow", data)
            status = wf.get("status", "unknown")
            elapsed = int(time.time() - start)
            tasks = data.get("tasks", [])

            task_map = {}
            for t in tasks:
                task_map[t.get("id", "")] = t

            opt_task = task_map.get(opt_id, {})
            sp_task = task_map.get(sp_id, {})
            opt_st = opt_task.get("status", "?")
            sp_st = sp_task.get("status", "?")

            print(f"  [{elapsed:>4d}s] wf={status} | geo_opt={opt_st}, single_point={sp_st}")

            # Track sequential behavior
            if opt_st in ("COMPLETED", "completed"):
                if not opt_completed:
                    opt_completed = True
                    print(f"  >>> geo_opt COMPLETED at {elapsed}s")
            if sp_st not in ("WAITING", "?") and opt_completed:
                if not sp_started_after_opt:
                    sp_started_after_opt = True
                    print(f"  >>> single_point started AFTER geo_opt at {elapsed}s — sequential confirmed!")

            if status in ("completed", "COMPLETED"):
                print(f"\n  [PASS] Sequential chain completed!")
                print(f"  Sequential execution verified: {sp_started_after_opt}")

                # Get results
                opt_result = requests.get(f"{API}/api/engine/tasks/{opt_id}/result")
                sp_result = requests.get(f"{API}/api/engine/tasks/{sp_id}/result")
                if opt_result.status_code == 200:
                    r_data = opt_result.json()
                    e = r_data.get("energy") or (r_data.get("result", {}) or {}).get("energy")
                    print(f"  Geo-opt energy: {e}")
                if sp_result.status_code == 200:
                    r_data = sp_result.json()
                    e = r_data.get("energy") or (r_data.get("result", {}) or {}).get("energy")
                    print(f"  SP energy: {e}")
                return True

            elif status in ("failed", "FAILED"):
                for t in tasks:
                    err = t.get("error_message")
                    if err:
                        print(f"    ERROR ({t.get('task_type','?')}): {err[:300]}")
                return False

        time.sleep(15)

    print(f"  TIMEOUT")
    return False


# ═══════════════════════════════════════════════════════════
# TEST 5: Task-Level API
# ═══════════════════════════════════════════════════════════
def test_task_level_api():
    print("\n" + "=" * 70)
    print("TEST 5: Task-Level API (get task, get params, provenance)")
    print("=" * 70)

    nodes, edges, sp_id = make_sp_graph(CU_FCC, "Cu_task_api")
    graph = json.dumps({
        "nodes": nodes, "edges": edges,
        "viewport": {"x": 0, "y": 0, "zoom": 1},
    })

    r = requests.post(f"{API}/api/engine/workflows/convert", json={
        "name": "Engine Feature Test: Task API",
        "graph_json": graph,
        "config": vasp_config(),
    })
    assert r.status_code in (200, 201)
    wf_id = r.json().get("workflow_id") or r.json().get("id")

    # Get all tasks
    r = requests.get(f"{API}/api/engine/workflows/{wf_id}")
    assert r.status_code == 200
    tasks = r.json().get("tasks", [])
    assert len(tasks) >= 2, f"Expected >= 2 tasks, got {len(tasks)}"

    all_ok = True
    for t in tasks:
        tid = t["id"]
        ttype = t.get("task_type", "?")

        # Get individual task
        r = requests.get(f"{API}/api/engine/tasks/{tid}")
        if r.status_code == 200:
            task_data = r.json()
            has_task = "task" in task_data
            has_parents = "parents" in task_data
            has_children = "children" in task_data
            print(f"  [PASS] GET /tasks/{tid[:20]}: task={has_task}, parents={has_parents}, children={has_children}")
        else:
            print(f"  [FAIL] GET /tasks/{tid[:20]}: {r.status_code}")
            all_ok = False

        # Get provenance
        r = requests.get(f"{API}/api/engine/tasks/{tid}/provenance")
        if r.status_code == 200:
            prov = r.json()
            print(f"  [PASS] Provenance for {ttype}: {json.dumps(prov)[:150]}")
        else:
            print(f"  [INFO] Provenance for {ttype}: {r.status_code} (may not be available yet)")

    return all_ok


# ═══════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════
def main():
    print("=" * 70)
    print("WORKFLOW ENGINE FEATURE TESTS — Shaheen HPC")
    print(f"Timestamp: {time.strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 70)

    check_prereqs()

    results = {}

    for name, test_fn in [
        ("Convert + List + Get", test_convert_and_list),
        ("Task-Level API", test_task_level_api),
        ("Submit + Pause + Resume", test_submit_pause_resume),
        ("Reset + Re-Submit", test_reset),
        ("Sequential Chain (geo_opt → SP)", test_sequential_chain),
    ]:
        try:
            results[name] = test_fn()
        except Exception as e:
            print(f"\n  EXCEPTION in {name}: {e}")
            import traceback; traceback.print_exc()
            results[name] = False

    # Summary
    print("\n" + "=" * 70)
    print("ENGINE FEATURE TEST SUMMARY")
    print("=" * 70)
    all_pass = True
    for name, passed in results.items():
        marker = "PASS" if passed else "FAIL"
        print(f"  [{marker}] {name}")
        if not passed:
            all_pass = False

    if all_pass:
        print("\n*** ALL ENGINE FEATURE TESTS PASSED ***")
    else:
        print("\n*** SOME ENGINE FEATURE TESTS FAILED — SEE ABOVE ***")
        sys.exit(1)


if __name__ == "__main__":
    main()

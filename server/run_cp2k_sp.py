#!/usr/bin/env python
"""Submit CP2K single-point workflow for Si diamond on Shaheen."""
import requests, json, uuid, time, sys

API = "http://localhost:8000"
SHAHEEN = "5e27f9b4-37ba-486b-83cd-e2c7a86863e3"

si = json.dumps({
    "@module": "pymatgen.core.structure", "@class": "Structure",
    "lattice": {"matrix": [[0, 2.715, 2.715], [2.715, 0, 2.715], [2.715, 2.715, 0]]},
    "sites": [
        {"species": [{"element": "Si", "occu": 1}], "abc": [0, 0, 0], "xyz": [0, 0, 0]},
        {"species": [{"element": "Si", "occu": 1}], "abc": [0.25, 0.25, 0.25], "xyz": [1.3575, 1.3575, 1.3575]},
    ],
})

uid = lambda p: f"{p}_{uuid.uuid4().hex[:12]}"
input_id, sp_id = uid("input"), uid("cp2k_sp")

graph = json.dumps({
    "nodes": [
        {"id": input_id, "type": "structure_input", "x": 0, "y": 0, "params": {"structure": si}},
        {"id": sp_id, "type": "single_point", "x": 200, "y": 0, "params": {
            "software": "cp2k",
            "functional": "PBE", "basis_set": "DZVP-MOLOPT-SR-GTH",
            "cutoff": 350, "rel_cutoff": 50, "eps_scf": 1e-6, "max_scf": 100,
            "charge": 0, "periodic": "XYZ",
        }},
    ],
    "edges": [{"id": uid("e"), "from": input_id, "to": sp_id, "fromH": "out-0", "toH": "in-0"}],
    "viewport": {"x": 0, "y": 0, "zoom": 1},
})

config = {
    "execution_mode": "hpc", "default_session_id": SHAHEEN,
    "base_work_dir": "/scratch/reny0b/gs/test-catgo/engine-e2e",
    "poll_interval": 15, "lmp_command": "", "local_work_dir": "",
    "job_script_template": "#!/bin/bash\n#SBATCH --partition=workq\n#SBATCH --nodes=1\n#SBATCH --time=00:30:00\n#SBATCH --ntasks-per-node=192\n#SBATCH --exclusive\nmodule load cp2k/2025.1\nexport OMP_NUM_THREADS=1\n",
    "cluster_configs": {SHAHEEN: {
        "potcar_root": "", "potcar_functional": "",
        "vasp_command": "srun cp2k.psmp -i project.inp -o project.out",
        "python_env": "", "default_template": "",
        "default_job_params": {"nodes": 1, "ntasks": 192, "cpus_per_task": 1, "walltime": "00:30:00", "partition": "workq"},
    }},
    "calc_templates": {}, "step_sessions": {}, "step_scripts": {}, "step_job_params": {},
    "default_job_params": {"nodes": 1, "ntasks": 192, "cpus_per_task": 1, "walltime": "00:30:00", "partition": "workq"},
    "use_custodian": False, "custodian_max_errors": 1,
}

# --- Step 1: Create workflow via convert endpoint ---
print("=" * 60)
print("STEP 1: Creating workflow via /convert ...")
r = requests.post(f"{API}/api/engine/workflows/convert", json={
    "name": "CP2K SP Si diamond",
    "graph_json": graph,
    "config": config,
})
print(f"  Status: {r.status_code}")
if r.status_code not in (200, 201):
    print(f"  ERROR: {r.text}")
    sys.exit(1)
wf = r.json()
wf_id = wf.get("workflow_id") or wf.get("id")
print(f"  Workflow ID: {wf_id}")
print(f"  Response: {json.dumps(wf, indent=2)[:500]}")

# --- Step 2: Submit workflow ---
print("\n" + "=" * 60)
print("STEP 2: Submitting workflow...")
r = requests.post(f"{API}/api/engine/workflows/{wf_id}/submit")
print(f"  Status: {r.status_code}")
if r.status_code not in (200, 201):
    print(f"  ERROR: {r.text}")
    sys.exit(1)
run = r.json()
run_id = run.get("id") or run.get("run_id") or run.get("workflow_id")
print(f"  Run/Workflow ID: {run_id}")
print(f"  Response: {json.dumps(run, indent=2)[:500]}")

# --- Step 3: Poll for completion ---
print("\n" + "=" * 60)
print("STEP 3: Polling for completion (max 10 minutes)...")
TIMEOUT = 600  # 10 minutes
INTERVAL = 15
start = time.time()
last_status = None

while time.time() - start < TIMEOUT:
    r = requests.get(f"{API}/api/engine/workflows/{wf_id}")
    if r.status_code != 200:
        print(f"  Poll error: {r.status_code} {r.text[:200]}")
        time.sleep(INTERVAL)
        continue

    data = r.json()
    wf_data = data.get("workflow", data)
    status = wf_data.get("status") or wf_data.get("state", "unknown")
    elapsed = int(time.time() - start)

    if status != last_status:
        print(f"  [{elapsed:>3}s] Status changed: {last_status} -> {status}")
        last_status = status
    else:
        print(f"  [{elapsed:>3}s] Status: {status}")

    # Check task statuses
    tasks = data.get("tasks", [])
    for t in tasks:
        tid = t.get("id", t.get("task_id", "?"))
        tst = t.get("status", t.get("state", "?"))
        ttype = t.get("type", t.get("node_type", "?"))
        short_id = tid[:25] if len(str(tid)) > 25 else tid
        print(f"    Task {short_id} ({ttype}): {tst}")

    if status in ("completed", "COMPLETED", "finished", "FINISHED", "success", "SUCCESS"):
        print(f"\n  WORKFLOW COMPLETED in {elapsed}s!")
        break
    elif status in ("failed", "FAILED", "error", "ERROR"):
        print(f"\n  WORKFLOW FAILED after {elapsed}s!")
        # Try to get error details
        err = data.get("error") or data.get("errors") or data.get("message")
        if err:
            print(f"  Error: {err}")
        break

    time.sleep(INTERVAL)
else:
    print(f"\n  TIMEOUT after {TIMEOUT}s! Last status: {last_status}")

# --- Step 4: Get final results ---
print("\n" + "=" * 60)
print("STEP 4: Final workflow state...")
r = requests.get(f"{API}/api/engine/workflows/{wf_id}")
if r.status_code == 200:
    final = r.json()
    print(json.dumps(final, indent=2, default=str))
else:
    print(f"  Error getting final state: {r.status_code} {r.text[:500]}")

# Try to get task details and results
print("\n" + "=" * 60)
print("STEP 5: Checking task details and results...")
r = requests.get(f"{API}/api/engine/workflows/{wf_id}")
if r.status_code == 200:
    data = r.json()
    tasks = data.get("tasks", [])
    for t in tasks:
        tid = t.get("id", "?")
        ttype = t.get("type", "?")
        tst = t.get("status", "?")
        print(f"\n  Task: {tid}")
        print(f"  Type: {ttype}, Status: {tst}")
        result = t.get("result") or t.get("output") or t.get("results")
        if result:
            rtext = json.dumps(result, indent=2, default=str)
            print(f"  Result: {rtext[:2000]}")
            if len(rtext) > 2000:
                print(f"  ... ({len(rtext)} total chars)")
        error = t.get("error") or t.get("error_message")
        if error:
            print(f"  ERROR: {error}")

# Also check the DAG
print("\n" + "=" * 60)
print("STEP 6: DAG info...")
r = requests.get(f"{API}/api/engine/workflows/{wf_id}/dag")
if r.status_code == 200:
    dag = r.json()
    print(json.dumps(dag, indent=2, default=str)[:1500])

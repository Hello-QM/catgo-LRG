#!/usr/bin/env python3
"""Full OER Pipeline Test on Shaheen.

Pipeline:
  RuO2 bulk → slab_gen(110) → clean_relax + {OH,O,OOH}_place → relax
  H2O molecule → relax
  H2 molecule → relax
  → Compute OER overpotential → Generate step diagram

Usage:
  cd /home/james0001/project/catgo/.worktrees/split-files
  PYTHONPATH=server:server/catgo python server/tests/test_oer_shaheen.py
"""
import json, time, uuid, sys, os, requests, math

os.environ["PYTHONUNBUFFERED"] = "1"

API = "http://localhost:8000"
SHAHEEN = "5e27f9b4-37ba-486b-83cd-e2c7a86863e3"
WORK_BASE = "/scratch/reny0b/gs/test-catgo/oer-pipeline"

# ── Structures ──────────────────────────────────────────────

# RuO2 bulk (rutile structure, tetragonal a=4.4919 c=3.1066)
RUO2_BULK = json.dumps({
    "@module": "pymatgen.core.structure", "@class": "Structure",
    "lattice": {"matrix": [[4.4919, 0, 0], [0, 4.4919, 0], [0, 0, 3.1066]]},
    "sites": [
        {"species": [{"element": "Ru", "occu": 1}], "abc": [0, 0, 0], "xyz": [0, 0, 0]},
        {"species": [{"element": "Ru", "occu": 1}], "abc": [0.5, 0.5, 0.5], "xyz": [2.24595, 2.24595, 1.5533]},
        {"species": [{"element": "O", "occu": 1}], "abc": [0.3058, 0.3058, 0], "xyz": [1.37282, 1.37282, 0]},
        {"species": [{"element": "O", "occu": 1}], "abc": [0.6942, 0.6942, 0], "xyz": [3.11908, 3.11908, 0]},
        {"species": [{"element": "O", "occu": 1}], "abc": [0.8058, 0.1942, 0.5], "xyz": [3.61877, 0.87313, 1.5533]},
        {"species": [{"element": "O", "occu": 1}], "abc": [0.1942, 0.8058, 0.5], "xyz": [0.87313, 3.61877, 1.5533]},
    ],
})

# H2O molecule in large box (15A cubic)
H2O_MOLECULE = json.dumps({
    "@module": "pymatgen.core.structure", "@class": "Structure",
    "lattice": {"matrix": [[15.0, 0, 0], [0, 15.0, 0], [0, 0, 15.0]]},
    "sites": [
        {"species": [{"element": "O", "occu": 1}], "abc": [0.5, 0.5, 0.5], "xyz": [7.5, 7.5, 7.5]},
        {"species": [{"element": "H", "occu": 1}], "abc": [0.5507, 0.5393, 0.5], "xyz": [8.2605, 8.0895, 7.5]},
        {"species": [{"element": "H", "occu": 1}], "abc": [0.4493, 0.5393, 0.5], "xyz": [6.7395, 8.0895, 7.5]},
    ],
})

# H2 molecule in large box
H2_MOLECULE = json.dumps({
    "@module": "pymatgen.core.structure", "@class": "Structure",
    "lattice": {"matrix": [[15.0, 0, 0], [0, 15.0, 0], [0, 0, 15.0]]},
    "sites": [
        {"species": [{"element": "H", "occu": 1}], "abc": [0.5, 0.5, 0.475], "xyz": [7.5, 7.5, 7.125]},
        {"species": [{"element": "H", "occu": 1}], "abc": [0.5, 0.5, 0.525], "xyz": [7.5, 7.5, 7.875]},
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


def shaheen_config():
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


# ── VASP Parameters ──────────────────────────────────────────

SLAB_OPT_PARAMS = {
    "software": "vasp",
    "ENCUT": 400, "EDIFF": 1e-5, "EDIFFG": -0.05,
    "NSW": 100, "IBRION": 2, "ISIF": 2,
    "ISMEAR": 0, "SIGMA": 0.05, "ISPIN": 1,
    "PREC": "Normal", "ALGO": "Fast",
    "NCORE": 4, "LWAVE": False, "LCHARG": False,
    "kpoints": "2x2x1",
}

GAS_OPT_PARAMS = {
    "software": "vasp",
    "ENCUT": 400, "EDIFF": 1e-5, "EDIFFG": -0.05,
    "NSW": 100, "IBRION": 2, "ISIF": 2,
    "ISMEAR": 0, "SIGMA": 0.01, "ISPIN": 1,
    "PREC": "Normal", "ALGO": "Fast",
    "NCORE": 4, "LWAVE": False, "LCHARG": False,
    "kpoints": "1x1x1",
}


def build_oer_graph():
    """Build the full OER workflow graph."""
    nodes = []
    edges = []
    task_ids = {}

    # ── Slab branch ──
    bulk_id = uid("bulk")
    slab_id = uid("slab")
    clean_opt_id = uid("clean_opt")
    task_ids["bulk"] = bulk_id
    task_ids["slab"] = slab_id
    task_ids["clean_opt"] = clean_opt_id

    nodes.append({
        "id": bulk_id, "type": "structure_input", "x": 0, "y": 200,
        "params": {"structure": RUO2_BULK, "system_name": "RuO2_bulk"},
    })
    nodes.append({
        "id": slab_id, "type": "slab_gen", "x": 200, "y": 200,
        "params": {"miller": [1, 1, 0], "layers": 3, "vacuum": 15.0},
    })
    nodes.append({
        "id": clean_opt_id, "type": "geo_opt", "x": 600, "y": 0,
        "params": {**SLAB_OPT_PARAMS, "system_name": "clean_slab"},
    })

    edges.append({"id": uid("e"), "from": bulk_id, "to": slab_id, "fromH": "out-0", "toH": "in-0"})
    edges.append({"id": uid("e"), "from": slab_id, "to": clean_opt_id, "fromH": "out-0", "toH": "in-0"})

    # ── Adsorbate branches ──
    y_offset = 150
    for i, ads in enumerate(["OH", "O", "OOH"]):
        place_id = uid(f"{ads}_place")
        opt_id = uid(f"{ads}_opt")
        task_ids[f"{ads}_place"] = place_id
        task_ids[f"{ads}_opt"] = opt_id

        nodes.append({
            "id": place_id, "type": "adsorbate_place", "x": 400, "y": (i + 1) * y_offset,
            "params": {"species": ads, "site": "ontop", "height": 2.0},
        })
        nodes.append({
            "id": opt_id, "type": "geo_opt", "x": 600, "y": (i + 1) * y_offset,
            "params": {**SLAB_OPT_PARAMS, "system_name": f"*{ads}"},
        })

        edges.append({"id": uid("e"), "from": slab_id, "to": place_id, "fromH": "out-0", "toH": "in-0"})
        edges.append({"id": uid("e"), "from": place_id, "to": opt_id, "fromH": "out-0", "toH": "in-0"})

    # ── Gas reference: H2O ──
    h2o_inp_id = uid("h2o_inp")
    h2o_opt_id = uid("h2o_opt")
    task_ids["h2o_inp"] = h2o_inp_id
    task_ids["h2o_opt"] = h2o_opt_id

    nodes.append({
        "id": h2o_inp_id, "type": "structure_input", "x": 0, "y": 600,
        "params": {"structure": H2O_MOLECULE, "system_name": "H2O_gas"},
    })
    nodes.append({
        "id": h2o_opt_id, "type": "geo_opt", "x": 200, "y": 600,
        "params": {**GAS_OPT_PARAMS, "system_name": "H2O_gas"},
    })
    edges.append({"id": uid("e"), "from": h2o_inp_id, "to": h2o_opt_id, "fromH": "out-0", "toH": "in-0"})

    # ── Gas reference: H2 ──
    h2_inp_id = uid("h2_inp")
    h2_opt_id = uid("h2_opt")
    task_ids["h2_inp"] = h2_inp_id
    task_ids["h2_opt"] = h2_opt_id

    nodes.append({
        "id": h2_inp_id, "type": "structure_input", "x": 0, "y": 750,
        "params": {"structure": H2_MOLECULE, "system_name": "H2_gas"},
    })
    nodes.append({
        "id": h2_opt_id, "type": "geo_opt", "x": 200, "y": 750,
        "params": {**GAS_OPT_PARAMS, "system_name": "H2_gas"},
    })
    edges.append({"id": uid("e"), "from": h2_inp_id, "to": h2_opt_id, "fromH": "out-0", "toH": "in-0"})

    return nodes, edges, task_ids


def create_and_submit(name, nodes, edges, config):
    """Create and submit workflow."""
    graph = json.dumps({
        "nodes": nodes, "edges": edges,
        "viewport": {"x": 0, "y": 0, "zoom": 1},
    })

    print("Creating workflow...")
    r = requests.post(f"{API}/api/engine/workflows/convert", json={
        "name": name, "graph_json": graph, "config": config,
    })
    if r.status_code not in (200, 201):
        print(f"  ERROR creating: {r.status_code} {r.text[:500]}")
        return None
    data = r.json()
    wf_id = data.get("workflow_id") or data.get("id")
    print(f"  Created: {wf_id} ({data.get('task_count')} tasks)")

    print("Submitting...")
    r = requests.post(f"{API}/api/engine/workflows/{wf_id}/submit")
    if r.status_code not in (200, 201):
        print(f"  ERROR submitting: {r.status_code} {r.text[:500]}")
        return None
    print(f"  Submitted: {r.json()}")
    return wf_id


def poll_workflow(wf_id, timeout=3600, interval=15):
    """Poll workflow to completion."""
    deadline = time.time() + timeout
    start = time.time()
    last_summary = ""

    while time.time() < deadline:
        r = requests.get(f"{API}/api/engine/workflows/{wf_id}")
        if r.status_code != 200:
            time.sleep(interval)
            continue

        data = r.json()
        wf = data.get("workflow", data)
        status = wf.get("status", "unknown")
        elapsed = int(time.time() - start)
        tasks = data.get("tasks", [])

        # Build summary
        summary_parts = []
        for t in tasks:
            ttype = t.get("task_type", "?")
            tst = t.get("status", "?")
            name = t.get("name") or t.get("system_name") or ""
            if ttype not in ("structure_input",):
                summary_parts.append(f"{name or ttype}={tst}")
        summary = " | ".join(summary_parts)

        if summary != last_summary:
            print(f"  [{elapsed:>4d}s] wf={status}")
            for p in summary_parts:
                print(f"         {p}")
            last_summary = summary
        else:
            print(f"  [{elapsed:>4d}s] wf={status} (no change)")

        if status in ("completed", "COMPLETED"):
            return data
        elif status in ("failed", "FAILED"):
            for t in tasks:
                err = t.get("error_message")
                if err:
                    print(f"  ERROR in {t.get('name','?')}: {err[:300]}")
            return data

        time.sleep(interval)

    print(f"  TIMEOUT after {timeout}s!")
    return None


def get_energy(task_id):
    """Get energy from task result."""
    r = requests.get(f"{API}/api/engine/tasks/{task_id}/result")
    if r.status_code == 200:
        data = r.json()
        return data.get("energy") or data.get("total_energy") or (data.get("result", {}) or {}).get("energy")
    return None


def compute_oer_and_diagram(task_ids, wf_data):
    """Compute OER overpotential and generate step diagram."""
    print("\n" + "=" * 70)
    print("OER ANALYSIS")
    print("=" * 70)

    # Find actual task IDs from workflow data (they may have changed during conversion)
    tasks = wf_data.get("tasks", [])
    task_by_name = {}
    for t in tasks:
        name = t.get("name") or t.get("system_name") or ""
        ttype = t.get("task_type", "")
        key = f"{ttype}_{name}"
        task_by_name[name] = t["id"]
        task_by_name[key] = t["id"]

    # Try to get energies using the original task_ids or by name lookup
    energies = {}
    for label, tid_key in [
        ("clean", "clean_opt"), ("OH", "OH_opt"), ("O", "O_opt"),
        ("OOH", "OOH_opt"), ("H2O", "h2o_opt"), ("H2", "h2_opt"),
    ]:
        tid = task_ids.get(tid_key)
        energy = get_energy(tid) if tid else None

        # Fallback: search by name
        if energy is None:
            for t in tasks:
                tname = t.get("name") or t.get("system_name") or ""
                ttype = t.get("task_type", "")
                if ttype == "geo_opt" and (label.lower() in tname.lower() or f"*{label}" in tname):
                    energy = get_energy(t["id"])
                    if energy is not None:
                        break

        energies[label] = energy
        print(f"  E({label:5s}) = {energy:.6f} eV" if energy else f"  E({label:5s}) = NOT FOUND")

    # Check all energies available
    if any(v is None for v in energies.values()):
        print("\n  MISSING ENERGIES — cannot compute OER")
        missing = [k for k, v in energies.items() if v is None]
        print(f"  Missing: {missing}")
        return False

    E_clean = energies["clean"]
    E_OH = energies["OH"]
    E_O = energies["O"]
    E_OOH = energies["OOH"]
    E_H2O = energies["H2O"]
    E_H2 = energies["H2"]

    # Compute adsorption energies
    # ΔE_OH = E(*OH) - E(clean) - E(H2O) + 0.5*E(H2)
    dE_OH = E_OH - E_clean - E_H2O + 0.5 * E_H2
    dE_O = E_O - E_clean - E_H2O + E_H2
    dE_OOH = E_OOH - E_clean - 2 * E_H2O + 1.5 * E_H2

    print(f"\n  ΔE_OH  = {dE_OH:.4f} eV")
    print(f"  ΔE_O   = {dE_O:.4f} eV")
    print(f"  ΔE_OOH = {dE_OOH:.4f} eV")

    # Apply empirical ZPE-TS corrections (from Nørskov CHE model)
    ZPE_TS = {"OH": 0.35, "O": 0.05, "OOH": 0.40}
    dG_OH = dE_OH + ZPE_TS["OH"]
    dG_O = dE_O + ZPE_TS["O"]
    dG_OOH = dE_OOH + ZPE_TS["OOH"]

    print(f"\n  ΔG_OH  = {dG_OH:.4f} eV (ZPE-TS correction: +{ZPE_TS['OH']} eV)")
    print(f"  ΔG_O   = {dG_O:.4f} eV (ZPE-TS correction: +{ZPE_TS['O']} eV)")
    print(f"  ΔG_OOH = {dG_OOH:.4f} eV (ZPE-TS correction: +{ZPE_TS['OOH']} eV)")

    # Compute OER overpotential via REST API
    print("\n  Computing OER overpotential...")
    r = requests.post(f"{API}/api/workflow/catalysis/oer", json={
        "dG_OH": dG_OH, "dG_O": dG_O, "dG_OOH": dG_OOH,
    })
    if r.status_code == 200:
        oer = r.json()
        eta = oer.get("overpotential", "?")
        step = oer.get("limiting_step", "?")
        steps = oer.get("step_energies", [])
        print(f"\n  *** OER Overpotential: η = {eta:.4f} V ***")
        print(f"  Limiting step: {step}")
        for i, dG in enumerate(steps, 1):
            print(f"    Step {i}: ΔG = {dG:.4f} eV")
    else:
        print(f"  OER endpoint error: {r.status_code} {r.text[:200]}")
        # Manual calculation
        dG1 = dG_OH
        dG2 = dG_O - dG_OH
        dG3 = dG_OOH - dG_O
        dG4 = 4.92 - dG_OOH
        steps = [dG1, dG2, dG3, dG4]
        eta = max(steps) - 1.23
        step = steps.index(max(steps)) + 1
        print(f"\n  *** OER Overpotential (manual): η = {eta:.4f} V ***")
        print(f"  Limiting step: {step}")
        for i, dG in enumerate(steps, 1):
            print(f"    Step {i}: ΔG = {dG:.4f} eV")
        oer = {"overpotential": eta, "limiting_step": step, "step_energies": steps}

    # Generate step diagram via REST API
    print("\n  Generating step diagram...")
    dG1 = dG_OH
    dG2 = dG_O - dG_OH
    dG3 = dG_OOH - dG_O
    dG4 = 4.92 - dG_OOH

    # Cumulative energies for the diagram
    pathway = {
        "name": "RuO2(110)",
        "color": "#1f77b4",
        "steps": [
            {"label": "* + 2H₂O", "energy": 0.0},
            {"label": "*OH + H₂O", "energy": dG1},
            {"label": "*O + H₂O", "energy": dG1 + dG2},
            {"label": "*OOH", "energy": dG1 + dG2 + dG3},
            {"label": "O₂ + *", "energy": 4.92},
        ],
    }

    # Ideal pathway (each step = 1.23 eV)
    ideal = {
        "name": "Ideal (1.23V each)",
        "color": "#aaaaaa",
        "steps": [
            {"label": "* + 2H₂O", "energy": 0.0},
            {"label": "*OH + H₂O", "energy": 1.23},
            {"label": "*O + H₂O", "energy": 2.46},
            {"label": "*OOH", "energy": 3.69},
            {"label": "O₂ + *", "energy": 4.92},
        ],
    }

    r = requests.post(f"{API}/api/workflow/catalysis/energy-diagram", json={
        "pathways": [pathway, ideal],
    })
    diagram_json = None
    if r.status_code == 200:
        diagram_json = r.json()
        print(f"  Diagram generated: {len(json.dumps(diagram_json))} bytes")
    else:
        print(f"  Diagram endpoint error: {r.status_code} {r.text[:200]}")

    # Save results
    output_dir = "/home/james0001/project/catgo/.worktrees/split-files/server/tests/oer_results"
    os.makedirs(output_dir, exist_ok=True)

    results = {
        "material": "RuO2(110)",
        "energies": energies,
        "adsorption_energies": {"dE_OH": dE_OH, "dE_O": dE_O, "dE_OOH": dE_OOH},
        "free_energies": {"dG_OH": dG_OH, "dG_O": dG_O, "dG_OOH": dG_OOH},
        "zpe_ts_corrections": ZPE_TS,
        "overpotential": oer.get("overpotential"),
        "limiting_step": oer.get("limiting_step"),
        "step_energies": oer.get("step_energies"),
        "pathway": pathway,
    }

    with open(f"{output_dir}/oer_results.json", "w") as f:
        json.dump(results, f, indent=2)
    print(f"\n  Results saved to {output_dir}/oer_results.json")

    if diagram_json:
        with open(f"{output_dir}/oer_diagram.json", "w") as f:
            json.dump(diagram_json, f, indent=2)
        print(f"  Diagram saved to {output_dir}/oer_diagram.json")

        # Generate HTML with Plotly
        html = f"""<!DOCTYPE html>
<html><head><title>RuO2(110) OER Step Diagram</title>
<script src="https://cdn.plot.ly/plotly-2.32.0.min.js"></script>
</head><body>
<h2>RuO2(110) OER Free Energy Diagram</h2>
<p>Overpotential: η = {oer.get('overpotential', '?'):.4f} V | Limiting step: {oer.get('limiting_step', '?')}</p>
<div id="plot" style="width:900px;height:500px;"></div>
<script>
var data = {json.dumps(diagram_json.get('traces', []))};
var layout = {json.dumps(diagram_json.get('layout', {}))};
Plotly.newPlot('plot', data, layout);
</script>
<h3>Step Energies</h3>
<table border="1" cellpadding="5">
<tr><th>Step</th><th>Reaction</th><th>ΔG (eV)</th></tr>
<tr><td>1</td><td>* + H₂O → *OH + H⁺ + e⁻</td><td>{dG1:.4f}</td></tr>
<tr><td>2</td><td>*OH → *O + H⁺ + e⁻</td><td>{dG2:.4f}</td></tr>
<tr><td>3</td><td>*O + H₂O → *OOH + H⁺ + e⁻</td><td>{dG3:.4f}</td></tr>
<tr><td>4</td><td>*OOH → O₂ + * + H⁺ + e⁻</td><td>{dG4:.4f}</td></tr>
</table>
<h3>DFT Energies</h3>
<table border="1" cellpadding="5">
<tr><th>System</th><th>Energy (eV)</th></tr>
{"".join(f'<tr><td>{k}</td><td>{v:.6f}</td></tr>' for k, v in energies.items())}
</table>
</body></html>"""

        with open(f"{output_dir}/oer_diagram.html", "w") as f:
            f.write(html)
        print(f"  HTML diagram saved to {output_dir}/oer_diagram.html")

    return True


# ── MAIN ──────────────────────────────────────────────────────

def main():
    print("=" * 70)
    print("FULL OER PIPELINE TEST — RuO2(110) on Shaheen")
    print(f"Timestamp: {time.strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 70)

    check_prereqs()

    # Build and submit OER workflow
    nodes, edges, task_ids = build_oer_graph()
    print(f"\nOER Graph: {len(nodes)} nodes, {len(edges)} edges")
    print(f"  HPC tasks: 6 (clean + OH + O + OOH relaxation + H2O + H2 gas)")
    print(f"  Local tasks: 5 (1 slab_gen + 3 adsorbate_place + 2 structure_input)")

    config = shaheen_config()
    wf_id = create_and_submit("RuO2(110) OER — Shaheen Test", nodes, edges, config)
    if not wf_id:
        print("FAIL: Could not create/submit workflow")
        sys.exit(1)

    print(f"\nWorkflow ID: {wf_id}")
    print(f"Monitor: {API}/api/engine/workflows/{wf_id}")

    # Poll for completion (60 min timeout)
    print(f"\n{'='*70}")
    print("POLLING (timeout=3600s)")
    print(f"{'='*70}")

    data = poll_workflow(wf_id, timeout=3600, interval=20)
    if not data:
        print("FAIL: Workflow did not complete within timeout")
        sys.exit(1)

    wf = data.get("workflow", data)
    status = wf.get("status", "unknown")

    if status not in ("completed", "COMPLETED"):
        print(f"\nWORKFLOW ENDED WITH STATUS: {status}")
        sys.exit(1)

    # Compute OER and generate diagram
    ok = compute_oer_and_diagram(task_ids, data)

    print(f"\n{'='*70}")
    print("OER PIPELINE RESULT")
    print(f"{'='*70}")
    if ok:
        print("*** OER PIPELINE COMPLETED SUCCESSFULLY ***")
        print("Check server/tests/oer_results/ for outputs")
    else:
        print("*** OER PIPELINE COMPLETED BUT ANALYSIS FAILED ***")
        sys.exit(1)


if __name__ == "__main__":
    main()

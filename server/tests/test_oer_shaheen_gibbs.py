#!/usr/bin/env python3
"""Full OER Pipeline with Frequency Calculations on Shaheen.

Pipeline (proper Gibbs free energy):
  RuO2 bulk → slab_gen(110)
    ├→ clean: geo_opt → freq → gibbs_energy(adsorbed)
    ├→ *OH:   adsorbate_place → geo_opt → freq → gibbs_energy(adsorbed)
    ├→ *O:    adsorbate_place → geo_opt → freq → gibbs_energy(adsorbed)
    └→ *OOH:  adsorbate_place → geo_opt → freq → gibbs_energy(adsorbed)
  H2O: structure_input → geo_opt → freq → gibbs_energy(gas)
  H2:  structure_input → geo_opt → freq → gibbs_energy(gas)
  → Compute OER overpotential from Gibbs → Generate ΔG step diagram

Usage:
  cd /home/james0001/project/catgo/.worktrees/split-files
  PYTHONPATH=server:server/catgo python server/tests/test_oer_shaheen_gibbs.py
"""
import json, time, uuid, sys, os, requests

os.environ["PYTHONUNBUFFERED"] = "1"

API = "http://localhost:8000"
SHAHEEN = None  # dynamically discovered in check_prereqs
WORK_BASE = "/scratch/reny0b/gs/test-catgo/oer-gibbs"

# ── Structures ──────────────────────────────────────────────

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

H2O_MOLECULE = json.dumps({
    "@module": "pymatgen.core.structure", "@class": "Structure",
    "lattice": {"matrix": [[15.0, 0, 0], [0, 15.0, 0], [0, 0, 15.0]]},
    "sites": [
        {"species": [{"element": "O", "occu": 1}], "abc": [0.5, 0.5, 0.5], "xyz": [7.5, 7.5, 7.5]},
        {"species": [{"element": "H", "occu": 1}], "abc": [0.5507, 0.5393, 0.5], "xyz": [8.2605, 8.0895, 7.5]},
        {"species": [{"element": "H", "occu": 1}], "abc": [0.4493, 0.5393, 0.5], "xyz": [6.7395, 8.0895, 7.5]},
    ],
})

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
    global SHAHEEN
    try:
        r = requests.get(f"{API}/health", timeout=3)
        assert r.status_code == 200
    except Exception as e:
        print(f"FAIL: Backend not running: {e}")
        sys.exit(1)
    print("[OK] Backend healthy")
    for attempt in range(5):
        try:
            r = requests.get(f"{API}/api/hpc/connections", timeout=5)
            for s in r.json():
                if s.get("session_id") != "__local__" and "shaheen" in s.get("host", "").lower():
                    SHAHEEN = s["session_id"]
                    print(f"[OK] Shaheen connected (session={SHAHEEN})")
                    return
        except Exception:
            pass
        time.sleep(3)
    print("FAIL: Shaheen not connected")
    sys.exit(1)


def shaheen_config():
    return {
        "execution_mode": "hpc",
        "default_session_id": SHAHEEN,
        "lmp_command": "", "local_work_dir": "",
        "base_work_dir": WORK_BASE,
        "poll_interval": 15,
        "job_script_template": (
            "#!/bin/bash\n"
            "#SBATCH --partition=workq\n"
            "#SBATCH --nodes=1\n"
            "#SBATCH --time=01:00:00\n"
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
                    "walltime": "01:00:00", "partition": "workq",
                },
                "module_loads": (
                    "module switch PrgEnv-cray PrgEnv-intel && "
                    "module switch intel intel/19.0.5.281"
                ),
            }
        },
        "calc_templates": {}, "step_sessions": {}, "step_scripts": {}, "step_job_params": {},
        "default_job_params": {
            "nodes": 1, "ntasks": 96, "cpus_per_task": 2,
            "walltime": "01:00:00", "partition": "workq",
        },
        "use_custodian": False, "custodian_max_errors": 1,
    }


# ── VASP Parameters ──

SLAB_OPT = {
    "software": "vasp",
    "ENCUT": 450, "EDIFF": 1e-5, "EDIFFG": -0.03,
    "NSW": 150, "IBRION": 2, "ISIF": 2,
    "ISMEAR": 0, "SIGMA": 0.05, "ISPIN": 1,
    "PREC": "Accurate", "ALGO": "Fast",
    "NCORE": 4, "LWAVE": True, "LCHARG": True,
    "kpoints": "2x2x1",
}

SLAB_FREQ = {
    "software": "vasp",
    "IBRION": 5, "NFREE": 2, "POTIM": 0.015,
    "NSW": 1, "EDIFF": 1e-6,
    "ENCUT": 450, "ISPIN": 1, "ISIF": 2,
    "ISMEAR": 0, "SIGMA": 0.05,
    "ALGO": "Fast",  # Davidson (Normal) diverges for metallic oxide slabs
    "IVDW": 0,       # Disable vdW for freq — D3-BJ causes NaN near vacuum
    "LREAL": False, "LWAVE": False, "LCHARG": False,
    "NCORE": 4,      # Prevent NCORE=0→NPAR=96 ZHEGV crash
    "kpoints": "1x1x1",
    # Freeze ALL slab z-layers — only adsorbate atoms vibrate
    # RuO2(110) 3-layer slab has 9 z-layer groups; freeze all 9
    "freeze_mode": "layers", "frozen_layers": 9,
}

GAS_OPT = {
    "software": "vasp",
    "ENCUT": 450, "EDIFF": 1e-5, "EDIFFG": -0.03,
    "NSW": 100, "IBRION": 2, "ISIF": 2,
    "ISMEAR": 0, "SIGMA": 0.01, "ISPIN": 1,
    "PREC": "Accurate", "ALGO": "Fast",
    "NCORE": 4, "LWAVE": True, "LCHARG": True,
    "kpoints": "1x1x1",
}

GAS_FREQ = {
    "software": "vasp",
    "IBRION": 5, "NFREE": 2, "POTIM": 0.015,
    "NSW": 1, "EDIFF": 1e-6,
    "ENCUT": 450, "ISPIN": 1, "ISIF": 2,
    "ISMEAR": 0, "SIGMA": 0.01,
    "LREAL": False, "LWAVE": False, "LCHARG": False,
    "NCORE": 4, "kpoints": "1x1x1",
}


def build_oer_graph():
    """Build full OER workflow graph with freq + gibbs_energy."""
    nodes = []
    edges = []
    ids = {}  # label -> node_id

    def add_node(label, ntype, x, y, params):
        nid = uid(label)
        ids[label] = nid
        nodes.append({"id": nid, "type": ntype, "x": x, "y": y, "params": params})
        return nid

    def add_edge(from_label, to_label, fromH="out-0", toH="in-0"):
        edges.append({
            "id": uid("e"), "from": ids[from_label], "to": ids[to_label],
            "fromH": fromH, "toH": toH,
        })

    # ── Slab generation ──
    add_node("bulk", "structure_input", 0, 200, {"structure": RUO2_BULK, "system_name": "RuO2_bulk"})
    add_node("slab", "slab_gen", 200, 200, {"miller": [1, 1, 0], "layers": 3, "vacuum": 15.0})
    add_edge("bulk", "slab")

    # ── Clean slab: geo_opt → freq → gibbs ──
    add_node("clean_opt", "geo_opt", 400, 0, {**SLAB_OPT, "system_name": "clean"})
    add_node("clean_freq", "freq", 600, 0, {**SLAB_FREQ, "system_name": "clean"})
    add_node("clean_gibbs", "gibbs_energy", 800, 0, {"phase": "adsorbed", "temperature": 298.15, "system_name": "clean"})

    add_edge("slab", "clean_opt")                     # structure → geo_opt
    add_edge("clean_opt", "clean_freq", "out-0", "in-0")  # opt.structure → freq.structure
    add_edge("clean_opt", "clean_gibbs", "out-1", "in-0") # opt.energy → gibbs.energy
    add_edge("clean_freq", "clean_gibbs", "out-1", "in-1") # freq.frequencies → gibbs.frequencies

    # ── Adsorbate branches: OH, O, OOH ──
    for i, ads in enumerate(["OH", "O", "OOH"]):
        y = (i + 1) * 200
        add_node(f"{ads}_place", "adsorbate_place", 400, y, {"species": ads, "site": "ontop", "height": 2.0})
        add_node(f"{ads}_opt", "geo_opt", 500, y, {**SLAB_OPT, "system_name": f"*{ads}"})
        add_node(f"{ads}_freq", "freq", 650, y, {**SLAB_FREQ, "system_name": f"*{ads}"})
        add_node(f"{ads}_gibbs", "gibbs_energy", 800, y, {"phase": "adsorbed", "temperature": 298.15, "system_name": f"*{ads}"})

        add_edge("slab", f"{ads}_place")                           # slab → place
        add_edge(f"{ads}_place", f"{ads}_opt")                     # place.structure → opt
        add_edge(f"{ads}_opt", f"{ads}_freq", "out-0", "in-0")    # opt.structure → freq
        add_edge(f"{ads}_opt", f"{ads}_gibbs", "out-1", "in-0")   # opt.energy → gibbs.energy
        add_edge(f"{ads}_freq", f"{ads}_gibbs", "out-1", "in-1")  # freq.frequencies → gibbs.frequencies

    # ── Gas reference: H2O ──
    add_node("h2o_inp", "structure_input", 0, 900, {"structure": H2O_MOLECULE, "system_name": "H2O_gas"})
    add_node("h2o_opt", "geo_opt", 200, 900, {**GAS_OPT, "system_name": "H2O(g)"})
    add_node("h2o_freq", "freq", 400, 900, {**GAS_FREQ, "system_name": "H2O(g)"})
    add_node("h2o_gibbs", "gibbs_energy", 600, 900, {"phase": "gas", "temperature": 298.15, "system_name": "H2O(g)"})

    add_edge("h2o_inp", "h2o_opt")
    add_edge("h2o_opt", "h2o_freq", "out-0", "in-0")
    add_edge("h2o_opt", "h2o_gibbs", "out-1", "in-0")
    add_edge("h2o_freq", "h2o_gibbs", "out-1", "in-1")

    # ── Gas reference: H2 ──
    add_node("h2_inp", "structure_input", 0, 1100, {"structure": H2_MOLECULE, "system_name": "H2_gas"})
    add_node("h2_opt", "geo_opt", 200, 1100, {**GAS_OPT, "system_name": "H2(g)"})
    add_node("h2_freq", "freq", 400, 1100, {**GAS_FREQ, "system_name": "H2(g)"})
    add_node("h2_gibbs", "gibbs_energy", 600, 1100, {"phase": "gas", "temperature": 298.15, "system_name": "H2(g)"})

    add_edge("h2_inp", "h2_opt")
    add_edge("h2_opt", "h2_freq", "out-0", "in-0")
    add_edge("h2_opt", "h2_gibbs", "out-1", "in-0")
    add_edge("h2_freq", "h2_gibbs", "out-1", "in-1")

    return nodes, edges, ids


def create_and_submit(name, nodes, edges, config):
    graph = json.dumps({"nodes": nodes, "edges": edges, "viewport": {"x": 0, "y": 0, "zoom": 1}})
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
    print(f"  Submitted!")
    return wf_id


def poll_workflow(wf_id, timeout=14400, interval=30):
    """Poll workflow. 4-hour timeout for freq calculations."""
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

        # Count by status
        counts = {}
        for t in tasks:
            s = t.get("status", "?")
            counts[s] = counts.get(s, 0) + 1

        # Show active task details
        active = [t for t in tasks if t.get("status") in
                  ("READY", "GENERATING", "UPLOADING", "SUBMITTED", "QUEUED", "RUNNING", "COMPLETED_REMOTE", "COLLECTING")]
        active_str = ", ".join(f"{t.get('name') or t.get('task_type','?')}={t.get('status','?')}" for t in active)

        completed = counts.get("COMPLETED", 0)
        total = len(tasks)
        summary = f"[{completed}/{total}] {json.dumps(counts)}"

        if summary != last_summary or active_str:
            print(f"  [{elapsed:>5d}s] wf={status} {summary}")
            if active_str:
                print(f"           Active: {active_str}")
            last_summary = summary

        if status in ("completed", "COMPLETED"):
            return data
        elif status in ("failed", "FAILED"):
            for t in tasks:
                err = t.get("error_message")
                if err:
                    print(f"  TASK ERROR ({t.get('name','?')}): {err[:400]}")
            return data

        time.sleep(interval)

    print(f"  TIMEOUT after {timeout}s!")
    return None


def get_task_result(task_id):
    r = requests.get(f"{API}/api/engine/tasks/{task_id}/result")
    return r.json() if r.status_code == 200 else None


def compute_oer_from_gibbs(ids, wf_data):
    """Compute OER from Gibbs free energies — no empirical corrections needed."""
    print("\n" + "=" * 70)
    print("OER ANALYSIS (Gibbs Free Energies)")
    print("=" * 70)

    tasks = wf_data.get("tasks", [])

    # Find gibbs results by matching system_name in task names
    gibbs_values = {}
    for t in tasks:
        if t.get("task_type") != "gibbs_energy":
            continue
        tid = t["id"]
        name = t.get("name") or t.get("system_name") or ""
        result = get_task_result(tid)
        if result:
            g = result.get("gibbs")
            zpe = result.get("zpe")
            energy = result.get("energy")
            g_corr = result.get("g_corr")
            if g is not None:
                # Identify which system this is
                for key in ["clean", "*OH", "*O", "*OOH", "H2O(g)", "H2(g)"]:
                    if key.lower().replace("*", "").replace("(g)", "") in name.lower().replace("*", "").replace("(g)", ""):
                        gibbs_values[key] = {
                            "G": g, "E_DFT": energy, "ZPE": zpe, "G_corr": g_corr,
                        }
                        break

    # Also try direct task_id lookup via the graph ids
    for label, gibbs_key in [
        ("clean_gibbs", "clean"), ("OH_gibbs", "*OH"), ("O_gibbs", "*O"),
        ("OOH_gibbs", "*OOH"), ("h2o_gibbs", "H2O(g)"), ("h2_gibbs", "H2(g)"),
    ]:
        if gibbs_key not in gibbs_values:
            tid = ids.get(label)
            if tid:
                result = get_task_result(tid)
                if result and result.get("gibbs") is not None:
                    gibbs_values[gibbs_key] = {
                        "G": result["gibbs"], "E_DFT": result.get("energy"),
                        "ZPE": result.get("zpe"), "G_corr": result.get("g_corr"),
                    }

    print("\n  Gibbs Free Energies:")
    for key in ["clean", "*OH", "*O", "*OOH", "H2O(g)", "H2(g)"]:
        v = gibbs_values.get(key)
        if v:
            g_val = v['G'] if v['G'] is not None else 0.0
            e_val = v['E_DFT'] if v['E_DFT'] is not None else 0.0
            zpe_val = v['ZPE'] if v['ZPE'] is not None else 0.0
            gc_val = v['G_corr'] if v['G_corr'] is not None else 0.0
            print(f"    G({key:8s}) = {g_val:12.6f} eV  (E_DFT={e_val:.6f}, ZPE={zpe_val:.6f}, G_corr={gc_val:.6f})")
        else:
            print(f"    G({key:8s}) = NOT FOUND")

    required = ["clean", "*OH", "*O", "*OOH", "H2O(g)", "H2(g)"]
    if any(k not in gibbs_values for k in required):
        missing = [k for k in required if k not in gibbs_values]
        print(f"\n  MISSING Gibbs values: {missing}")
        print("  Cannot compute OER. Falling back to energy-only if available...")
        return False

    G_clean = gibbs_values["clean"]["G"]
    G_OH = gibbs_values["*OH"]["G"]
    G_O = gibbs_values["*O"]["G"]
    G_OOH = gibbs_values["*OOH"]["G"]
    G_H2O = gibbs_values["H2O(g)"]["G"]
    G_H2 = gibbs_values["H2(g)"]["G"]

    # Adsorption Gibbs free energies (CHE model)
    # ΔG_OH  = G(*OH)  - G(clean) - G(H2O) + 0.5*G(H2)
    # ΔG_O   = G(*O)   - G(clean) - G(H2O) + G(H2)
    # ΔG_OOH = G(*OOH) - G(clean) - 2*G(H2O) + 1.5*G(H2)
    dG_OH  = G_OH  - G_clean - G_H2O + 0.5 * G_H2
    dG_O   = G_O   - G_clean - G_H2O + G_H2
    dG_OOH = G_OOH - G_clean - 2 * G_H2O + 1.5 * G_H2

    print(f"\n  Adsorption Free Energies (CHE, T=298.15K):")
    print(f"    ΔG_OH  = {dG_OH:.4f} eV")
    print(f"    ΔG_O   = {dG_O:.4f} eV")
    print(f"    ΔG_OOH = {dG_OOH:.4f} eV")

    # OER step energies
    dG1 = dG_OH                     # * + H2O → *OH + H+ + e-
    dG2 = dG_O - dG_OH              # *OH → *O + H+ + e-
    dG3 = dG_OOH - dG_O             # *O + H2O → *OOH + H+ + e-
    dG4 = 4.92 - dG_OOH             # *OOH → O2 + * + H+ + e-

    steps = [dG1, dG2, dG3, dG4]
    eta = max(steps) - 1.23
    limiting = steps.index(max(steps)) + 1

    print(f"\n  OER Step Free Energies:")
    labels = [
        "* + H₂O → *OH + H⁺ + e⁻",
        "*OH → *O + H⁺ + e⁻",
        "*O + H₂O → *OOH + H⁺ + e⁻",
        "*OOH → O₂ + * + H⁺ + e⁻",
    ]
    for i, (dG, lbl) in enumerate(zip(steps, labels), 1):
        marker = " ← limiting" if i == limiting else ""
        print(f"    Step {i}: ΔG = {dG:.4f} eV  {lbl}{marker}")

    print(f"\n  *** OER Overpotential: η = {eta:.4f} V ***")
    print(f"  *** Potential-Determining Step: Step {limiting} ***")

    # Also call the REST API
    r = requests.post(f"{API}/api/workflow/catalysis/oer", json={
        "dG_OH": dG_OH, "dG_O": dG_O, "dG_OOH": dG_OOH,
    })
    if r.status_code == 200:
        oer_api = r.json()
        print(f"\n  [API cross-check] η = {oer_api.get('overpotential', '?')} V, "
              f"limiting step = {oer_api.get('limiting_step', '?')}")

    # ── Generate Gibbs Free Energy Step Diagram ──
    print("\n  Generating ΔG step diagram...")

    # Cumulative ΔG for the pathway
    pathway = {
        "name": "RuO2(110)",
        "color": "#e74c3c",
        "steps": [
            {"label": "* + 2H₂O(l)", "energy": 0.0},
            {"label": "*OH + H₂O", "energy": dG1},
            {"label": "*O + H₂O", "energy": dG1 + dG2},
            {"label": "*OOH", "energy": dG1 + dG2 + dG3},
            {"label": "O₂(g) + *", "energy": 4.92},
        ],
    }

    ideal = {
        "name": "Ideal (U=1.23V)",
        "color": "#95a5a6",
        "steps": [
            {"label": "* + 2H₂O(l)", "energy": 0.0},
            {"label": "*OH + H₂O", "energy": 1.23},
            {"label": "*O + H₂O", "energy": 2.46},
            {"label": "*OOH", "energy": 3.69},
            {"label": "O₂(g) + *", "energy": 4.92},
        ],
    }

    at_eta = {
        "name": f"RuO2 @ U={1.23+eta:.2f}V",
        "color": "#3498db",
        "steps": [
            {"label": "* + 2H₂O(l)", "energy": 0.0},
            {"label": "*OH + H₂O", "energy": dG1 - (1.23 + eta)},
            {"label": "*O + H₂O", "energy": dG1 + dG2 - 2 * (1.23 + eta)},
            {"label": "*OOH", "energy": dG1 + dG2 + dG3 - 3 * (1.23 + eta)},
            {"label": "O₂(g) + *", "energy": 4.92 - 4 * (1.23 + eta)},
        ],
    }

    r = requests.post(f"{API}/api/workflow/catalysis/energy-diagram", json={
        "pathways": [pathway, ideal, at_eta],
    })
    diagram_json = r.json() if r.status_code == 200 else None

    # ── Save results ──
    output_dir = "/home/james0001/project/catgo/.worktrees/split-files/server/tests/oer_results"
    os.makedirs(output_dir, exist_ok=True)

    results = {
        "material": "RuO2(110)",
        "temperature": 298.15,
        "gibbs_values": {k: v for k, v in gibbs_values.items()},
        "adsorption_free_energies": {"dG_OH": dG_OH, "dG_O": dG_O, "dG_OOH": dG_OOH},
        "step_free_energies": {"dG1": dG1, "dG2": dG2, "dG3": dG3, "dG4": dG4},
        "overpotential_V": eta,
        "limiting_step": limiting,
        "pathway": pathway,
    }
    with open(f"{output_dir}/oer_gibbs_results.json", "w") as f:
        json.dump(results, f, indent=2, default=str)
    print(f"  Results → {output_dir}/oer_gibbs_results.json")

    if diagram_json:
        with open(f"{output_dir}/oer_gibbs_diagram.json", "w") as f:
            json.dump(diagram_json, f, indent=2)

    # ── HTML step diagram ──
    html = f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>RuO2(110) OER ΔG Step Diagram</title>
<script src="https://cdn.plot.ly/plotly-2.32.0.min.js"></script>
<style>body{{font-family:Arial;max-width:1000px;margin:auto;padding:20px}}
table{{border-collapse:collapse;margin:10px 0}}td,th{{border:1px solid #ccc;padding:6px 12px;text-align:center}}</style>
</head><body>
<h1>RuO2(110) OER Free Energy Diagram</h1>
<p><b>Overpotential: η = {eta:.3f} V</b> &nbsp;|&nbsp; Limiting step: {limiting}
&nbsp;|&nbsp; T = 298.15 K &nbsp;|&nbsp; Freq-derived Gibbs (G = E<sub>DFT</sub> + ZPE − TS)</p>

<div id="plot" style="width:950px;height:520px;"></div>
<script>
var data = {json.dumps(diagram_json.get('traces', []) if diagram_json else [])};
var layout = {json.dumps(diagram_json.get('layout', {}) if diagram_json else {})};
layout.title = "RuO2(110) OER: Gibbs Free Energy Diagram";
layout.yaxis = layout.yaxis || {{}};
layout.yaxis.title = "ΔG (eV)";
Plotly.newPlot('plot', data, layout);
</script>

<h2>Step Free Energies</h2>
<table>
<tr><th>Step</th><th>Reaction</th><th>ΔG (eV)</th></tr>
<tr><td>1</td><td>* + H₂O → *OH + H⁺ + e⁻</td><td>{dG1:.4f}</td></tr>
<tr><td>2</td><td>*OH → *O + H⁺ + e⁻</td><td>{dG2:.4f}</td></tr>
<tr><td>3</td><td>*O + H₂O → *OOH + H⁺ + e⁻</td><td>{dG3:.4f}</td></tr>
<tr><td>4</td><td>*OOH → O₂ + * + H⁺ + e⁻</td><td>{dG4:.4f}</td></tr>
</table>

<h2>Gibbs Free Energies (Computed from DFT + Frequencies)</h2>
<table>
<tr><th>System</th><th>E<sub>DFT</sub> (eV)</th><th>ZPE (eV)</th><th>G<sub>corr</sub> (eV)</th><th>G (eV)</th></tr>
{"".join(
    f'<tr><td>{k}</td><td>{v["E_DFT"]:.6f}</td><td>{v["ZPE"]:.6f}</td>'
    f'<td>{v["G_corr"]:.6f}</td><td>{v["G"]:.6f}</td></tr>'
    for k, v in gibbs_values.items()
)}
</table>

<h2>Adsorption Free Energies (CHE Model)</h2>
<table>
<tr><th>Intermediate</th><th>ΔG (eV)</th></tr>
<tr><td>*OH</td><td>{dG_OH:.4f}</td></tr>
<tr><td>*O</td><td>{dG_O:.4f}</td></tr>
<tr><td>*OOH</td><td>{dG_OOH:.4f}</td></tr>
</table>
</body></html>"""

    with open(f"{output_dir}/oer_gibbs_diagram.html", "w") as f:
        f.write(html)
    print(f"  HTML diagram → {output_dir}/oer_gibbs_diagram.html")

    return True


# ── MAIN ──

def main():
    print("=" * 70)
    print("FULL OER PIPELINE (with Frequencies + Gibbs) — RuO2(110) on Shaheen")
    print(f"Timestamp: {time.strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 70)
    print("""
DAG:
  RuO2 bulk → slab(110,3L)
    ├→ clean:  geo_opt → freq → gibbs(adsorbed)
    ├→ *OH:    place → geo_opt → freq → gibbs(adsorbed)
    ├→ *O:     place → geo_opt → freq → gibbs(adsorbed)
    └→ *OOH:   place → geo_opt → freq → gibbs(adsorbed)
  H₂O(g): geo_opt → freq → gibbs(gas)
  H₂(g):  geo_opt → freq → gibbs(gas)

  12 VASP jobs (6 geo_opt + 6 freq)
  Estimated time: 1-4 hours
""")

    check_prereqs()

    nodes, edges, ids = build_oer_graph()
    print(f"Graph: {len(nodes)} nodes, {len(edges)} edges")

    config = shaheen_config()
    wf_id = create_and_submit("RuO2(110) OER Gibbs — Shaheen", nodes, edges, config)
    if not wf_id:
        print("FAIL: Could not create/submit workflow")
        sys.exit(1)

    print(f"\nWorkflow: {wf_id}")
    print(f"Monitor:  {API}/api/engine/workflows/{wf_id}")

    # Poll (4-hour timeout for freq calculations)
    print(f"\n{'='*70}")
    print("POLLING (timeout=4h, interval=30s)")
    print(f"{'='*70}")

    data = poll_workflow(wf_id, timeout=14400, interval=30)
    if not data:
        print("FAIL: Workflow timeout")
        sys.exit(1)

    wf = data.get("workflow", data)
    status = wf.get("status", "unknown")

    if status not in ("completed", "COMPLETED"):
        print(f"\nWORKFLOW ENDED: {status}")
        sys.exit(1)

    ok = compute_oer_from_gibbs(ids, data)

    print(f"\n{'='*70}")
    if ok:
        print("*** OER GIBBS PIPELINE COMPLETED SUCCESSFULLY ***")
        print("Output: server/tests/oer_results/oer_gibbs_diagram.html")
    else:
        print("*** WORKFLOW COMPLETED BUT OER ANALYSIS FAILED ***")
        sys.exit(1)


if __name__ == "__main__":
    main()

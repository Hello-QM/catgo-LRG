"""Workflow tool handlers for the CatGO MCP server.

Contains all workflow-related logic: node defaults, graph validation,
and the unified _handle_workflow handler.
"""

import difflib
import json
import logging

import httpx
from mcp.types import TextContent

from .helpers import API_BASE, _push_workflow_navigate

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Helper: fetch structure by Materials Project ID (or other OPTIMADE provider)
# ---------------------------------------------------------------------------

async def _fetch_structure_by_mp_id(client: httpx.AsyncClient, mp_id: str, provider: str = "mp") -> str | None:
    """Fetch a structure dict (as JSON string) by Materials Project ID.

    Returns the JSON string of the pymatgen-compatible structure dict,
    or None on failure.  Reuses the OPTIMADE direct-fetch machinery from
    structure_tools to avoid importing pymatgen.
    """
    try:
        from .structure_tools import _optimade_fetch_by_id_direct, _optimade_to_pymatgen

        entry = await _optimade_fetch_by_id_direct(client, provider, mp_id)
        if not entry:
            logger.warning("_fetch_structure_by_mp_id: no entry for %s in %s", mp_id, provider)
            return None
        struct_dict = _optimade_to_pymatgen(entry)
        return json.dumps(struct_dict)
    except Exception as exc:
        logger.warning("_fetch_structure_by_mp_id failed for %s: %s", mp_id, exc)
        return None


async def _resolve_structure_input_params(
    client: httpx.AsyncClient, params: dict,
) -> dict:
    """Ensure a structure_input node's params carry a real ``structure_json``.

    Single source of truth for "what structure does this structure_input
    hold". An LLM cannot synthesise a pymatgen JSON, so when CatBot creates
    OR edits a structure_input it only ever passes ``mp_id`` (or nothing).
    Without this resolution the node stays empty no matter how many times
    the user asks. Resolution order, only when ``structure_json`` is absent:

      1. ``mp_id`` / ``structure_id`` → OPTIMADE fetch.
      2. otherwise the current viewer structure (what the user is looking
         at — the most reliable intent signal for an auto-built workflow).

    Mutates and returns ``params``. Best-effort: viewer errors are swallowed
    so a missing backend never breaks the mutation.
    """
    if params.get("structure_json"):
        return params
    mp_id = params.get("mp_id") or params.get("structure_id")
    if mp_id:
        struct_json = await _fetch_structure_by_mp_id(client, str(mp_id))
        if struct_json:
            params["structure_json"] = struct_json
            if not params.get("label"):
                params["label"] = str(mp_id)
            logger.info("structure_input: fetched %s", mp_id)
            return params
        logger.warning("structure_input: mp-id fetch failed for %s, trying viewer", mp_id)
    try:
        sr = await client.get(f"{API_BASE}/view/structure/current")
        if sr.status_code == 200:
            sd = sr.json()
            if sd:
                params["structure_json"] = json.dumps(sd) if isinstance(sd, dict) else str(sd)
                logger.info("structure_input: captured viewer structure")
    except Exception as e:
        logger.warning("structure_input: viewer capture failed: %s", e)
    return params


# ---------------------------------------------------------------------------
# Workflow: node defaults, validation, and handler
# ---------------------------------------------------------------------------

# Fix #4: Default params for common node types (synced from frontend NODE_DEFINITIONS).
# MCP add_node merges these defaults with user-provided params so nodes are complete.
_NODE_DEFAULTS: dict[str, dict] = {
    "structure_input": {"_inputs": [], "_outputs": ["structure"], "defaults": {}},
    "structure_list_input": {
        "_inputs": [], "_outputs": ["structures"],
        "defaults": {"source": "files", "structures_json": "[]", "count": 0},
    },
    "geo_opt": {
        "_inputs": ["structure"], "_outputs": ["structure", "energy"],
        "defaults": {"system_type": "periodic", "software": "vasp", "ENCUT": 520, "EDIFF": "1e-5", "ISIF": 2, "NSW": 200, "kpoints": "4\u00d74\u00d74"},
    },
    "single_point": {
        "_inputs": ["structure"], "_outputs": ["energy", "dos", "band"],
        "defaults": {"system_type": "periodic", "software": "vasp", "ENCUT": 520, "EDIFF": "1e-6", "ISMEAR": -5, "LORBIT": 11},
    },
    "cell_opt": {
        "_inputs": ["structure"], "_outputs": ["structure", "energy"],
        "defaults": {"software": "vasp", "ENCUT": 520, "EDIFF": "1e-6", "ISIF": 3, "kpoints": "9\u00d79\u00d79"},
    },
    "md": {
        "_inputs": ["structure", "restart"], "_outputs": ["trajectory", "energy", "log", "restart"],
        "defaults": {"system_type": "periodic", "software": "vasp", "TEBEG": 300, "NSW": 5000, "POTIM": 1.0, "SMASS": 0, "constant_potential": "none"},
    },
    "slow_growth": {
        "_inputs": ["structure", "restart"],
        "_outputs": ["trajectory", "energy", "report", "restart"],
        "defaults": {
            "system_type": "periodic",
            "software": "vasp",
            "calculation_type": "slow_growth",
            "TEBEG": 300,
            "NSW": 10000,
            "POTIM": 1.0,
            "SMASS": 0,
            "lblueout": True,
            "increm": "-0.005",
            "iconst_content": "",
            "constant_potential": "none",
        },
    },
    "freq": {
        "_inputs": ["structure"], "_outputs": ["frequencies", "zpe"],
        "defaults": {
            "system_type": "periodic", "software": "vasp",
            "IBRION": 5, "NFREE": 2, "POTIM": 0.015,
            "kpoints": "1\u00d71\u00d71", "NCORE": 0, "NPAR": 0,
            "LREAL": ".FALSE.", "EDIFF": "1e-6",
        },
    },
    "ts_search": {
        "_inputs": ["structure", "structure_product"], "_outputs": ["structure", "energy", "frequencies", "trajectory"],
        "defaults": {"system_type": "molecular", "software": "sella", "calculator": "xtb", "calculator_method": "GFN2-xTB", "fmax": 0.01, "order": 1},
    },
    "irc": {
        "_inputs": ["structure"], "_outputs": ["trajectory", "structures"],
        "defaults": {"system_type": "molecular", "software": "orca", "method": "r2SCAN-3c", "basis": "6-31G", "max_iterations": 30},
    },
    "slab_gen": {
        "_inputs": ["structure"], "_outputs": ["structure"],
        "defaults": {"miller": "1,1,1", "layers": 4, "vacuum": 15.0, "supercell": "2\u00d72"},
    },
    "adsorbate_place": {
        "_inputs": ["structure"], "_outputs": ["structure"],
        "defaults": {"species": "OH", "site": "all", "height": 2.0},
        "_note": (
            "Param 'species' is the ASCII formula (H, OH, NNH, CH3OH, …) — "
            "matches server/data/adsorbates.json. Call 'list_presets preset_type=adsorbates' "
            "for the full library (~70 entries grouped by reaction). "
            "Param 'site' is one of: all, ontop, bridge, fcc, hcp."
        ),
    },
    "condition": {
        "_inputs": ["input_a", "input_b"], "_outputs": ["true_out", "false_out"],
        "defaults": {"field": "energy_diff", "op": "<", "value": "0.01"},
    },
    "loop": {
        "_inputs": ["collection"], "_outputs": ["each_item", "completed"],
        "defaults": {"variable": "structure", "max_iter": 10},
    },
    "merge": {
        "_inputs": ["input_a", "input_b", "input_c"], "_outputs": ["merged"],
        "defaults": {},
    },
    "kmc": {
        "_inputs": ["model", "barriers"], "_outputs": ["coverages", "tof", "trajectory"],
        "defaults": {"mode": "both", "temperature": 300, "potential": 0.0, "lattice_size": 20, "kmc_steps": 100000, "scan_type": "none", "model_json": ""},
    },
    "dos_analysis": {"_inputs": ["data"], "_outputs": ["result"], "defaults": {"source": "parent_step", "d_band": True}},
    "cohp_analysis": {"_inputs": ["data"], "_outputs": ["result"], "defaults": {"source": "parent_step"}},
    "md_analysis": {"_inputs": ["data"], "_outputs": ["result"], "defaults": {"analyses": "rmsd,rdf"}},
    "convergence_check": {"_inputs": ["data"], "_outputs": ["result"], "defaults": {"check_type": "energy", "threshold": 1e-4}},
    "electronic": {"_inputs": ["structure"], "_outputs": ["dos", "cohp", "charges"], "defaults": {"analysis": "dos,bader", "NEDOS": 3001}},
    "free_energy": {"_inputs": ["gibbs"], "_outputs": [], "defaults": {"input_mode": "auto"}, "_note": "Free energy diagram. Connect upstream gibbs_energy nodes. Thermodynamic corrections (ZPE, TS) are done in gibbs_energy, not here."},
    "gibbs_energy": {
        "_inputs": ["energy", "frequencies"], "_outputs": ["gibbs", "zpe"],
        "defaults": {"phase": "adsorbed", "temperature": 298.15, "freq_cutoff": 50, "pressure_atm": 1.0, "n_unpaired": 0},
        "_note": "Compute Gibbs free energy: G = E_DFT + ZPE - TS. Connect 'energy' from geo_opt and 'frequencies' from freq node. Phase: 'adsorbed' (harmonic, surface-bound) or 'gas' (ideal gas with translation+rotation+vibration).",
    },
    "export_data": {"_inputs": ["data"], "_outputs": [], "defaults": {"format": "json", "db": "ase.db"}},
    # Legacy names (auto-migrate)
    "vasp_relax": {"_alias": "geo_opt"},
    "vasp_static": {"_alias": "single_point"},
    "vasp_md": {"_alias": "md"},
    "mlp_relax": {
        "_inputs": ["structure"], "_outputs": ["structure", "energy"],
        "defaults": {"software": "mlp", "model": "MACE", "fmax": 0.01},
    },
    "mlp_md": {
        "_inputs": ["structure", "restart"], "_outputs": ["trajectory", "energy"],
        "defaults": {"software": "mlp", "model": "MACE", "temperature": 300, "steps": 1000},
    },
    # AMBER node types (ML/MM)
    "amber_md": {
        "_inputs": ["structure", "restart"], "_outputs": ["trajectory", "energy", "restart"],
        "defaults": {
            "software": "amber", "nstlim": 5000000, "dt": 0.0001, "irest": 1,
            "ntt": 0, "ntb": 0, "cut": 9999.0, "ntc": 1, "use_mlp": True,
            "mlp_model": "macepol_l", "animask": "", "mlp_embedding": 2,
            "mlp_multipole": 1, "mlp_polar": 2, "adjust_q": 1,
            "ntpr": 1000, "ntwx": 10000, "ntwr": 100000,
        },
    },
    "amber_minimize": {
        "_inputs": ["structure"], "_outputs": ["structure", "energy"],
        "defaults": {
            "software": "amber", "maxcyc": 5000, "ncyc": 2500, "drms": 0.0001,
            "use_mlp": False,
        },
    },
    # ORCA node types (quantum chemistry)
    "orca_opt": {
        "_inputs": ["structure"], "_outputs": ["structure", "energy"],
        "defaults": {"method": "r2SCAN-3c", "basis": "def2-SVP", "charge": 0, "multiplicity": 1, "num_cores": 4},
    },
    "orca_sp": {
        "_inputs": ["structure"], "_outputs": ["energy"],
        "defaults": {"method": "r2SCAN-3c", "basis": "def2-TZVP", "charge": 0, "multiplicity": 1, "num_cores": 4},
    },
    "orca_freq": {
        "_inputs": ["structure"], "_outputs": ["frequencies", "zpe"],
        "defaults": {"method": "r2SCAN-3c", "basis": "def2-SVP", "charge": 0, "multiplicity": 1, "num_cores": 4},
    },
    "orca_neb_ts": {
        "_inputs": ["structure", "structure_product"], "_outputs": ["structure", "energy", "trajectory"],
        "defaults": {"method": "r2SCAN-3c", "basis": "def2-SVP", "charge": 0, "multiplicity": 1, "num_cores": 8, "nimages": 8, "ts_opt": True, "neb_cycles": 100},
    },
    "orca_irc": {
        "_inputs": ["structure"], "_outputs": ["trajectory", "structures"],
        "defaults": {"method": "r2SCAN-3c", "basis": "6-31G", "charge": 0, "multiplicity": 1, "num_cores": 4, "max_iterations": 30},
    },
    "orca_uvvis": {
        "_inputs": ["structure"], "_outputs": ["spectrum"],
        "defaults": {"method": "CAM-B3LYP", "basis": "def2-TZVP", "charge": 0, "multiplicity": 1, "num_cores": 4, "nroots": 10, "triplets": False},
    },
    # --- High-throughput screening nodes ---
    "batch_generate": {
        "_inputs": ["structure"], "_outputs": ["structures"],
        "defaults": {
            "mode": "substituent",
            "elements": "Ti, V, Cr, Mn, Fe, Co, Ni, Cu",
            "sites": "all",
            "miller_indices": "100, 110, 111, 211",
            "slab_thickness": 4,
            "vacuum": 15.0,
            "adsorbate": "OH",
            "param_range": "0.95, 1.05",
            "n_points": 11,
            "custom_script": "",
        },
    },
    "map": {
        "_inputs": ["structures"], "_outputs": ["results"],
        "defaults": {
            "max_parallel": 0,
            "fail_strategy": "continue",
            "retry_failed": False,
        },
    },
    "aggregate": {
        "_inputs": ["results"], "_outputs": ["filtered", "table"],
        "defaults": {
            "sort_by": "energy_per_atom",
            "sort_order": "ascending",
            "filter_by": "",
            "top_n": 0,
            "export_csv": True,
        },
    },
    # --- Quantum ESPRESSO nodes ---
    "qe_scf": {
        "_inputs": ["structure"], "_outputs": ["energy", "charge_density"],
        "defaults": {
            "software": "qe", "ecutwfc": 60, "ecutrho": 480,
            "kpoints": "6×6×6", "smearing": "cold", "degauss": 0.01,
            "pseudo_library": "SSSP_efficiency",
        },
    },
    "qe_relax": {
        "_inputs": ["structure"], "_outputs": ["structure", "energy"],
        "defaults": {
            "software": "qe", "ecutwfc": 60, "ecutrho": 480,
            "kpoints": "4×4×4", "forc_conv_thr": 1e-3,
            "press_conv_thr": 0.5, "cell_dofree": "all",
            "pseudo_library": "SSSP_efficiency",
        },
    },
    "qe_bands": {
        "_inputs": ["structure", "charge_density"], "_outputs": ["band_structure"],
        "defaults": {
            "software": "qe", "ecutwfc": 60, "ecutrho": 480,
            "nbnd": 20, "kpoints_density": 40,
            "pseudo_library": "SSSP_efficiency",
        },
    },
    "qe_dos": {
        "_inputs": ["structure", "charge_density"], "_outputs": ["dos"],
        "defaults": {
            "software": "qe", "ecutwfc": 60, "ecutrho": 480,
            "kpoints": "12×12×12", "degauss": 0.005,
            "pseudo_library": "SSSP_efficiency",
        },
    },
    "qe_phonon": {
        "_inputs": ["structure", "charge_density"], "_outputs": ["phonon_dos", "phonon_bands"],
        "defaults": {
            "software": "qe", "ecutwfc": 60, "ecutrho": 480,
            "qpoints": "4×4×4", "tr2_ph": 1e-14,
            "pseudo_library": "SSSP_efficiency",
        },
    },
    # --- Q-Chem nodes ---
    "qchem_static": {
        "_inputs": ["structure"], "_outputs": ["energy"],
        "defaults": {
            "software": "qchem", "method": "wB97X-V", "basis": "def2-TZVPD",
            "charge": 0, "multiplicity": 1, "solvent": "",
            "scf_algorithm": "DIIS", "max_scf_cycles": 200,
        },
    },
    "qchem_opt": {
        "_inputs": ["structure"], "_outputs": ["structure", "energy"],
        "defaults": {
            "software": "qchem", "method": "wB97X-V", "basis": "def2-SVP",
            "charge": 0, "multiplicity": 1, "solvent": "",
            "geom_opt_max_cycles": 200, "geom_opt_tol_gradient": 300,
        },
    },
    "qchem_ts": {
        "_inputs": ["structure"], "_outputs": ["structure", "energy", "frequencies"],
        "defaults": {
            "software": "qchem", "method": "wB97X-V", "basis": "def2-SVP",
            "charge": 0, "multiplicity": 1, "solvent": "",
            "geom_opt_max_cycles": 200,
        },
    },
    # --- Analysis nodes ---
    "phonon_analysis": {
        "_inputs": ["data"], "_outputs": ["phonon_dos", "phonon_bands", "thermodynamics"],
        "defaults": {
            "mesh": "20×20×20", "t_min": 0, "t_max": 1000, "t_step": 10,
            "band_points": 51,
        },
    },
    "eos_analysis": {
        "_inputs": ["data"], "_outputs": ["result"],
        "defaults": {
            "eos_type": "birch_murnaghan", "n_deformations": 7,
        },
    },
    "elastic_analysis": {
        "_inputs": ["data"], "_outputs": ["result"],
        "defaults": {
            "sym_reduce": True, "n_strains": 6, "strain_magnitude": 0.01,
        },
    },
}

# Expose NODE_DEFAULTS as a public alias for validation and tests
NODE_DEFAULTS = _NODE_DEFAULTS


# ---------------------------------------------------------------------------
# CatBot knowledge base — comprehensive reference for all new features
# ---------------------------------------------------------------------------

CATBOT_KNOWLEDGE = """
## Workflow Import (atomate2 / quacc)

### How to import
- Use `import_atomate2_template` or `import_quacc_template` tools with a template_id.
- Or use the "Import" button in the workflow editor toolbar to browse templates visually.
- For JSON import: export your atomate2 flow with `flow.as_dict()`, save as JSON, then import via the Import dialog.

### Available atomate2 templates
- `atomate2-double-relax` — Two-stage VASP relaxation (coarse then tight), standard DoubleRelaxMaker pattern.
- `atomate2-band-structure` — PBE SCF static + uniform and line-mode non-SCF for DOS and band structure.
- `atomate2-hse-band-structure` — HSE06 hybrid functional band structure with PBE preconditioning.
- `atomate2-elastic` — Elastic tensor: relaxation + 6 deformation single-points in parallel.
- `atomate2-phonon` — Phonon band structure and DOS via finite displacements with phonopy.
- `atomate2-eos` — Equation of state: relaxation + 7 volume-scaled single-points + Birch-Murnaghan fit.
- `atomate2-dielectric` — DFPT dielectric constant (LEPSILON) with Born effective charges.
- `atomate2-optics` — Optical properties via LOPTICS for frequency-dependent dielectric function.
- `atomate2-mlp-vasp-refinement` — Fast MLP relaxation (MACE) + VASP single-point validation.
- `atomate2-mlp-phonon` — MLP phonon calculation with MACE and phonopy post-processing.

### Available quacc templates
- `quacc-slab-relax` — Slab relaxation: bulk → slab generation → relax → static.
- `quacc-band-structure` — VASP band structure: SCF + uniform + line-mode non-SCF.
- `quacc-mlp-phonon` — MLP phonon with MACE: relax → displacements → phonopy.
- `quacc-mlp-elastic` — MLP elastic tensor with MACE: relax → deformation statics → fit.
- `quacc-mlp-dft-refine` — Multi-fidelity: MLP pre-relaxation (MACE) → VASP single-point validation.
- `quacc-xtb-orca` — Molecular multi-fidelity: xTB pre-opt → ORCA single-point refinement.
- `quacc-qe-bands` — Quantum ESPRESSO band structure: SCF → bands + DOS.
- `quacc-qe-phonon` — Quantum ESPRESSO phonon: SCF → DFPT phonon → analysis.

### How mapping works
- atomate2 Makers map to existing CatGo nodes: RelaxMaker → geo_opt, StaticMaker → single_point, MDMaker → md.
- Parameters are mapped to CatGo's param_schema (ENCUT, EDIFF, kpoints, etc.), not passed as opaque blobs.
- Dynamic workflows (Response.detour/replace) appear as opaque placeholder nodes — they cannot be fully expanded at import time.

### Limitations
- Dynamic atomate2 workflows that use Response.detour or Response.replace appear as opaque nodes.
- Some advanced atomate2 features (AMSET, GW, Lobster) may map to generic "external" nodes.
- Custom quacc @subflow functions cannot be statically analyzed — they appear as opaque nodes.

## High-Throughput Screening

### Step-by-step guide to building a screening workflow
1. Start with a **Structure Input** node (auto-added on workflow create).
2. Add a **Batch Generate** node — choose your screening mode:
   - `substituent`: Replace atoms with different elements (e.g., "Ti,V,Cr,Mn,Fe,Co,Ni,Cu"). Great for dopant screening.
   - `surface`: Generate multiple surface cuts by Miller index (e.g., "100,110,111,211"). For surface energy studies.
   - `adsorbate`: Place adsorbate molecule at all unique adsorption sites. For catalyst screening.
   - `lattice_scan`: Vary lattice parameter across a range (e.g., 0.95 to 1.05 in 11 points). For EOS curves.
   - `composition`: Generate all compositions in a specified range. For alloy screening.
   - `custom`: Write a Python generator function for arbitrary structure generation.
3. Add a **Map** node — this runs downstream calculations on ALL candidates in parallel.
   - Set `max_parallel` to limit concurrent HPC jobs (0 = unlimited).
   - Set `fail_strategy` to "continue" (keep running even if some fail) or "abort_all".
   - Set `retry_failed` to True to auto-retry failed branches once.
4. Add calculation nodes between Map and Aggregate (e.g., geo_opt → single_point).
   - For fast pre-screening, use MLP (machine learning potential) — MACE, CHGNet, etc.
   - For accurate results, use VASP, CP2K, or QE.
5. Add an **Aggregate** node — this collects and filters results.
   - `sort_by`: energy_per_atom, total_energy, band_gap, formation_energy, adsorption_energy, max_force, or custom.
   - `filter_by`: Python expression like "band_gap > 1.5 and energy_per_atom < -5.0".
   - `top_n`: Keep only top N candidates (0 = keep all that pass filter).
6. Click Run to start. Monitor progress in the Branch Status panel (click the map node's progress bar).
7. After completion, click "View Results Table" on the Aggregate node.

### The 3-node pattern
```
structure_input → batch_generate → map → [your calculations] → aggregate
```
Everything between `map` and `aggregate` is the per-candidate sub-workflow. It gets cloned and executed for each candidate structure in parallel.

### Two-stage screening (MLP pre-screen → DFT validation)
Build two map-aggregate stages:
```
structure_input → batch_generate → map → [mlp_relax → mlp_static] → aggregate(top_n=10) → map → [vasp_static] → aggregate(sort_by=energy_per_atom)
```
Stage 1: Fast MLP screen on all candidates, keep top 10.
Stage 2: Accurate DFT validation on only the top 10 candidates.

### Monitoring progress
- During execution, the Map node shows an inline progress bar and status counts.
- Click the progress bar to open the **BranchStatusPanel** with a full table of all branches.
- Each branch shows: label, status (pending/running/completed/failed), and intermediate results.
- Use "Retry Failed" to re-submit failed branches, or "Abort All" to cancel everything.

### Viewing results
- After completion, the Aggregate node shows a "View Results Table" button.
- The **ResultTablePanel** shows a sortable, filterable data table with all results.
- Click any row to load that structure in the 3D viewer.
- Export results as CSV or JSON.
- Interactive filter input lets you re-filter without re-running.

### Difference between Map and Loop
- **Map** = parallel fan-out on a list of structures (batch processing).
- **Loop** = sequential iteration (e.g., convergence testing with increasing k-points).

## New Node Types

### Quantum ESPRESSO nodes
- **qe_scf**: Self-consistent field calculation. Key params: ecutwfc (Ry, default 60), ecutrho (Ry, default 480), kpoints, smearing, degauss, pseudo_library (SSSP_efficiency or PseudoDojo_standard).
- **qe_relax**: Geometry optimisation (vc-relax). Key params: ecutwfc, ecutrho, forc_conv_thr, cell_dofree.
- **qe_bands**: Band structure (non-SCF). Needs charge density from qe_scf. Key params: nbnd, kpoints_density.
- **qe_dos**: Density of states. Needs charge density from qe_scf. Key params: degauss.
- **qe_phonon**: DFPT phonon calculation (ph.x). Needs charge density from qe_scf. Key params: qpoints, tr2_ph.
- Pseudopotential libraries: SSSP_efficiency (faster), SSSP_precision (more accurate), PseudoDojo_standard, PseudoDojo_stringent.

### Q-Chem nodes
- **qchem_static**: Single-point energy. Key params: method (wB97X-V, B3LYP, PBE0), basis (def2-TZVPD, 6-31G*), charge, multiplicity, solvent (PCM/SMD model name or empty).
- **qchem_opt**: Geometry optimisation. Same params as static plus geom_opt_max_cycles, geom_opt_tol_gradient.
- **qchem_ts**: Transition state search. Key params: same as opt plus frequency analysis for TS confirmation.

### Analysis nodes
- **phonon_analysis**: Post-processing of displacement force data. Input: forces from multiple displacement statics. Output: phonon band structure, phonon DOS, thermodynamic properties. Key params: mesh, t_min, t_max, t_step, band_points.
- **eos_analysis**: Equation of state fitting. Input: energy-volume data from multiple volume-scaled statics. Output: bulk modulus, equilibrium volume, fitted curve. Key params: eos_type (birch_murnaghan or vinet).
- **elastic_analysis**: Elastic tensor calculation. Input: stress-strain data from deformation statics. Output: elastic tensor, bulk modulus, shear modulus, Young's modulus. Key params: sym_reduce, n_strains, strain_magnitude.

## Troubleshooting

### "My screening has failed branches"
- Open the BranchStatusPanel (click the map node's progress bar).
- Check the error message for each failed branch.
- Common causes: SCF convergence failure, ZBRENT error, insufficient memory.
- Use "Retry Failed" to re-submit failed branches.
- If many fail, check your calculation parameters (ENCUT too low, kpoints too sparse, etc.).
- Consider using fail_strategy="continue" to let other branches finish even if some fail.

### "How many structures can I screen?"
- Depends on your HPC allocation and the cost per calculation.
- MLP calculations: hundreds to thousands of structures feasible on a workstation.
- DFT (VASP/QE): typically 10-100 structures per screening run, depending on system size.
- Use `max_parallel` to control concurrent jobs and avoid overwhelming the HPC queue.
- Two-stage screening (MLP pre-screen then DFT on top N) is the most cost-effective approach.

### "Results table is empty"
- Check your filter expression in the Aggregate node — it may be too restrictive.
- Try setting filter_by to an empty string to see all results.
- Verify that calculations actually completed (check BranchStatusPanel for failed branches).
- Check that sort_by matches a property that exists in the output (e.g., energy_per_atom).

### "Map node stuck at 0%"
- Check HPC connection: ensure your cluster is reachable and your credentials are valid.
- Check the queue: your jobs may be pending in the HPC scheduler.
- Look at the first branch's work directory for submission logs.
- If using local mode, ensure sufficient CPU/memory resources.
- Try setting max_parallel=1 to debug with a single branch first.
"""


# ---------------------------------------------------------------------------
# Template import handlers
# ---------------------------------------------------------------------------

async def _handle_import_atomate2_template(
    client: httpx.AsyncClient, args: dict
) -> list[TextContent]:
    """Import a pre-built atomate2 workflow template into a new workflow.

    Fetches the template from the built-in atomate2 template library,
    creates a new workflow with the template's graph JSON, and returns
    a confirmation with node/edge counts.
    """
    _t = TextContent
    template_id = args.get("template_id", "")
    if not template_id:
        return [_t(type="text", text="Missing required parameter: template_id")]

    try:
        from converters.atomate2.templates import ATOMATE2_TEMPLATES
    except ImportError:
        return [_t(type="text", text="atomate2 templates module not available.")]

    template = None
    for t in ATOMATE2_TEMPLATES:
        if t["id"] == template_id:
            template = t
            break

    if template is None:
        available = [t["id"] for t in ATOMATE2_TEMPLATES]
        return [_t(type="text", text=(
            f"Unknown template '{template_id}'. "
            f"Available atomate2 templates: {', '.join(available)}"
        ))]

    # Create workflow from template graph
    graph = json.loads(template["graph_json"])
    n_nodes = len(graph.get("nodes", []))
    n_edges = len(graph.get("edges", []))

    base = f"{API_BASE}/workflow"
    payload = {
        "name": template["name"],
        "graph_json": template["graph_json"],
    }
    resp = await client.post(f"{base}/", json=payload)
    if resp.status_code not in (200, 201):
        return [_t(type="text", text=f"Failed to create workflow: {resp.text[:300]}")]

    wf = resp.json()
    from .helpers import _push_workflow_navigate
    await _push_workflow_navigate(client, wf["id"])

    return [_t(type="text", text=(
        f"Imported atomate2 template '{template['name']}' as workflow '{wf['name']}' "
        f"(id={wf['id']}). {n_nodes} nodes, {n_edges} edges.\n"
        f"Description: {template.get('description', 'N/A')}"
    ))]


async def _handle_import_quacc_template(
    client: httpx.AsyncClient, args: dict
) -> list[TextContent]:
    """Import a pre-built quacc workflow template into a new workflow.

    Fetches the template from the built-in quacc template library,
    creates a new workflow with the template's graph JSON, and returns
    a confirmation with node/edge counts.
    """
    _t = TextContent
    template_id = args.get("template_id", "")
    if not template_id:
        return [_t(type="text", text="Missing required parameter: template_id")]

    try:
        from converters.quacc.templates import QUACC_TEMPLATES
    except ImportError:
        return [_t(type="text", text="quacc templates module not available.")]

    template = None
    for t in QUACC_TEMPLATES:
        if t["id"] == template_id:
            template = t
            break

    if template is None:
        available = [t["id"] for t in QUACC_TEMPLATES]
        return [_t(type="text", text=(
            f"Unknown template '{template_id}'. "
            f"Available quacc templates: {', '.join(available)}"
        ))]

    graph = json.loads(template["graph_json"])
    n_nodes = len(graph.get("nodes", []))
    n_edges = len(graph.get("edges", []))

    base = f"{API_BASE}/workflow"
    payload = {
        "name": template["name"],
        "graph_json": template["graph_json"],
    }
    resp = await client.post(f"{base}/", json=payload)
    if resp.status_code not in (200, 201):
        return [_t(type="text", text=f"Failed to create workflow: {resp.text[:300]}")]

    wf = resp.json()
    from .helpers import _push_workflow_navigate
    await _push_workflow_navigate(client, wf["id"])

    return [_t(type="text", text=(
        f"Imported quacc template '{template['name']}' as workflow '{wf['name']}' "
        f"(id={wf['id']}). {n_nodes} nodes, {n_edges} edges.\n"
        f"Description: {template.get('description', 'N/A')}"
    ))]


async def _handle_create_screening_workflow(
    client: httpx.AsyncClient, args: dict
) -> list[TextContent]:
    """Create a high-throughput screening workflow programmatically.

    Builds a screening workflow from the pattern:
        structure_input -> batch_generate(mode) -> map -> [calculation] -> aggregate

    The calculation nodes are chosen based on the software parameter.
    The batch_generate mode is chosen based on the screening_type parameter.
    """
    import time
    import random as _rnd

    _t = TextContent

    screening_type = args.get("screening_type", "")
    software = args.get("software", "vasp")

    if not screening_type:
        return [_t(type="text", text=(
            "Missing required parameter: screening_type. "
            "Options: catalyst, dopant, surface, eos, mlp_prescreen"
        ))]

    # Map screening type to batch_generate mode and aggregate sort
    type_config = {
        "catalyst": {
            "mode": "adsorbate",
            "sort_by": "adsorption_energy",
            "description": "catalyst screening (adsorbate placement at unique sites)",
        },
        "dopant": {
            "mode": "substituent",
            "sort_by": "formation_energy",
            "description": "dopant screening (element substitution)",
        },
        "surface": {
            "mode": "surface",
            "sort_by": "energy_per_atom",
            "description": "surface energy screening (Miller index surfaces)",
        },
        "eos": {
            "mode": "lattice_scan",
            "sort_by": "total_energy",
            "description": "equation of state (lattice parameter scan)",
        },
        "mlp_prescreen": {
            "mode": "substituent",
            "sort_by": "energy_per_atom",
            "description": "two-stage MLP pre-screen + DFT validation",
        },
    }

    cfg = type_config.get(screening_type)
    if cfg is None:
        return [_t(type="text", text=(
            f"Unknown screening_type '{screening_type}'. "
            f"Options: {', '.join(type_config.keys())}"
        ))]

    # Map software to calculation nodes
    calc_nodes_map = {
        "vasp": [
            ("geo_opt", {"software": "vasp", "ENCUT": 520, "EDIFF": "1e-5", "ISIF": 2, "NSW": 200}),
            ("single_point", {"software": "vasp", "ENCUT": 520, "EDIFF": "1e-6", "ISMEAR": -5}),
        ],
        "cp2k": [
            ("geo_opt", {"software": "cp2k"}),
            ("single_point", {"software": "cp2k"}),
        ],
        "orca": [
            ("orca_opt", {"method": "r2SCAN-3c", "basis": "def2-SVP"}),
            ("orca_sp", {"method": "r2SCAN-3c", "basis": "def2-TZVP"}),
        ],
        "mlp": [
            ("mlp_relax", {"model": "MACE", "fmax": 0.02}),
        ],
        "xtb": [
            ("geo_opt", {"software": "xtb", "method": "GFN2-xTB", "fmax": 0.01}),
        ],
    }

    calc_nodes = calc_nodes_map.get(software)
    if calc_nodes is None:
        return [_t(type="text", text=(
            f"Unknown software '{software}'. Options: {', '.join(calc_nodes_map.keys())}"
        ))]

    # Build the graph nodes
    ts = int(time.time())
    nodes = []
    edges = []

    def _nid(idx: int) -> str:
        return f"n{ts}-{idx}{''.join(_rnd.choices('abcdefghijklmnop', k=2))}"

    # 1. structure_input
    si_id = _nid(0)
    nodes.append({"id": si_id, "type": "structure_input", "x": 80, "y": 200, "params": {}})

    # 2. batch_generate
    bg_id = _nid(1)
    bg_params = {"mode": cfg["mode"]}
    if args.get("elements"):
        bg_params["elements"] = args["elements"]
    if args.get("miller_indices"):
        bg_params["miller_indices"] = args["miller_indices"]
    if args.get("adsorbate"):
        bg_params["adsorbate"] = args["adsorbate"]
    nodes.append({"id": bg_id, "type": "batch_generate", "x": 380, "y": 200, "params": bg_params})
    edges.append({"id": f"e{ts}-0", "from": si_id, "to": bg_id, "fromH": "structure", "toH": "structure"})

    # 3. map
    map_id = _nid(2)
    nodes.append({"id": map_id, "type": "map", "x": 680, "y": 200, "params": {
        "max_parallel": 0, "fail_strategy": "continue", "retry_failed": False,
    }})
    edges.append({"id": f"e{ts}-1", "from": bg_id, "to": map_id, "fromH": "structures", "toH": "structures"})

    # 4. calculation nodes
    prev_id = map_id
    for ci, (ctype, cparams) in enumerate(calc_nodes):
        c_id = _nid(3 + ci)
        nodes.append({"id": c_id, "type": ctype, "x": 980 + ci * 300, "y": 200, "params": cparams})
        out_h = "structure" if ctype in ("geo_opt", "mlp_relax", "orca_opt") else "structure"
        edges.append({"id": f"e{ts}-{2 + ci}", "from": prev_id, "to": c_id, "fromH": out_h, "toH": "structure"})
        prev_id = c_id

    # 5. aggregate
    agg_id = _nid(3 + len(calc_nodes))
    agg_x = 980 + len(calc_nodes) * 300
    nodes.append({"id": agg_id, "type": "aggregate", "x": agg_x, "y": 200, "params": {
        "sort_by": cfg["sort_by"], "sort_order": "ascending", "top_n": 0, "export_csv": True,
    }})
    edges.append({"id": f"e{ts}-{2 + len(calc_nodes)}", "from": prev_id, "to": agg_id, "fromH": "structure", "toH": "results"})

    # For mlp_prescreen, add a second stage: aggregate(top_n=10) → map → vasp_static → aggregate
    if screening_type == "mlp_prescreen":
        # Update first aggregate to keep top 10
        nodes[-1]["params"]["top_n"] = 10

        # Second map
        map2_id = _nid(10)
        nodes.append({"id": map2_id, "type": "map", "x": agg_x + 300, "y": 200, "params": {
            "max_parallel": 0, "fail_strategy": "continue", "retry_failed": False,
        }})
        edges.append({"id": f"e{ts}-10", "from": agg_id, "to": map2_id, "fromH": "filtered", "toH": "structures"})

        # VASP static for DFT validation
        vs_id = _nid(11)
        nodes.append({"id": vs_id, "type": "single_point", "x": agg_x + 600, "y": 200, "params": {
            "software": "vasp", "ENCUT": 520, "EDIFF": "1e-6", "ISMEAR": -5,
        }})
        edges.append({"id": f"e{ts}-11", "from": map2_id, "to": vs_id, "fromH": "structure", "toH": "structure"})

        # Final aggregate
        agg2_id = _nid(12)
        nodes.append({"id": agg2_id, "type": "aggregate", "x": agg_x + 900, "y": 200, "params": {
            "sort_by": "energy_per_atom", "sort_order": "ascending", "top_n": 0, "export_csv": True,
        }})
        edges.append({"id": f"e{ts}-12", "from": vs_id, "to": agg2_id, "fromH": "structure", "toH": "results"})

    # Create the workflow
    graph_json = json.dumps({"nodes": nodes, "edges": edges})
    wf_name = f"{cfg['description']} ({software})"

    base = f"{API_BASE}/workflow"
    payload = {"name": wf_name, "graph_json": graph_json}
    resp = await client.post(f"{base}/", json=payload)
    if resp.status_code not in (200, 201):
        return [_t(type="text", text=f"Failed to create workflow: {resp.text[:300]}")]

    wf = resp.json()
    await _push_workflow_navigate(client, wf["id"])

    stage_note = ""
    if screening_type == "mlp_prescreen":
        stage_note = " Two-stage: MLP pre-screen (keep top 10) → DFT validation."

    return [_t(type="text", text=(
        f"Created {cfg['description']} workflow '{wf_name}' (id={wf['id']}). "
        f"{len(nodes)} nodes, {len(edges)} edges. "
        f"Batch mode: {cfg['mode']}, software: {software}, sort by: {cfg['sort_by']}.{stage_note}\n"
        f"Use set_params to adjust parameters, then validate_workflow and run_workflow."
    ))]


def _graph_snapshot(graph: dict) -> str:
    """Return a compact text summary of the current workflow graph.

    Designed to be appended to every mutation response so the AI always
    has the latest state without a separate ``get`` call.
    """
    nodes = graph.get("nodes", [])
    edges = graph.get("edges", [])

    if not nodes:
        return "\n\n📋 Current graph: empty (0 nodes, 0 edges)"

    # Build node label: type(id, key_params...)
    def _node_label(n: dict) -> str:
        ntype = n.get("type", "?")
        nid = n.get("id", "?")
        params = n.get("params", {})
        # Show a few key params (skip internal ones starting with _)
        key_params = [
            f"{k}={v}" for k, v in params.items()
            if not k.startswith("_") and k not in ("structure_json", "formula", "n_atoms", "n_frames", "trajectory_json")
        ]
        if key_params:
            return f"{ntype}({nid}, {', '.join(key_params[:4])})"
        return f"{ntype}({nid})"

    # Build adjacency for topological ordering
    children: dict[str, list[str]] = {n["id"]: [] for n in nodes}
    parents: dict[str, list[str]] = {n["id"]: [] for n in nodes}
    for e in edges:
        if e["from"] in children:
            children[e["from"]].append(e["to"])
        if e["to"] in parents:
            parents[e["to"]].append(e["from"])

    # Topological sort (Kahn's) for display ordering
    in_deg = {n["id"]: len(parents.get(n["id"], [])) for n in nodes}
    queue = [nid for nid, d in in_deg.items() if d == 0]
    ordered_ids: list[str] = []
    while queue:
        nid = queue.pop(0)
        ordered_ids.append(nid)
        for child in children.get(nid, []):
            in_deg[child] -= 1
            if in_deg[child] == 0:
                queue.append(child)
    # Append any remaining (cycle members) at the end
    for n in nodes:
        if n["id"] not in ordered_ids:
            ordered_ids.append(n["id"])

    node_map = {n["id"]: n for n in nodes}
    node_labels = [_node_label(node_map[nid]) for nid in ordered_ids if nid in node_map]

    edge_strs = [
        f"{e['from']}:{e.get('fromH', '?')} → {e['to']}:{e.get('toH', '?')}"
        for e in edges
    ]

    lines = [f"\n\n📋 Current graph: {len(nodes)} nodes, {len(edges)} edges"]
    lines.append(f"Nodes: {' → '.join(node_labels)}")
    if edge_strs:
        lines.append(f"Edges: {', '.join(edge_strs)}")
    else:
        lines.append("Edges: (none)")
    return "\n".join(lines)


# Schema-allowed keys for adsorbate_place — matches
# src/lib/workflow/node-defs/utility/adsorbate-place.ts. Any other key the
# LLM invents (e.g. `mode: "end-on"`, `dentate: ...`, `orientation: ...`)
# gets either translated below or stripped, so the frontend NodeConfigPanel
# doesn't render unknown noisy fields.
_ADSORBATE_PLACE_ALLOWED_KEYS = {
    "species", "custom_xyz", "site", "height", "auto_rotate", "quick_optimize",
    # backend-internal, kept if already present
    "structure_json", "site_index",
    "_manual_adsorbate_cart", "_manual_normal", "_site_strategy",
}
_ADSORBATE_PLACE_SITE_ALIASES = {
    "top": "ontop", "on_top": "ontop", "atop": "ontop",
    "hollow3": "fcc", "hollow4": "fcc", "hollow": "fcc",
}
_UNICODE_SUBSCRIPT_MAP = str.maketrans({
    "₀": "0", "₁": "1", "₂": "2", "₃": "3", "₄": "4",
    "₅": "5", "₆": "6", "₇": "7", "₈": "8", "₉": "9",
})


def _normalize_adsorbate_place_params(merged: dict) -> dict:
    """Coerce LLM-flavoured params into the canonical schema.

    Three things happen:
      * `site` aliases (`top` / `atop` / `hollow3` / …) are mapped to the
        enum the frontend dropdown actually accepts.
      * `species` is ASCII-folded (`H₂O` → `H2O`) and stripped of a leading
        `*` so it can be looked up in the JSON library.
      * The LLM-invented `mode: "end-on" | "side-on"` is translated to
        `auto_rotate` (the closest concept this node supports) and then
        dropped, so the panel doesn't render an unknown field.
      * Any other key not in the schema is dropped with a logger.warning,
        so the workflow editor doesn't show garbage params after CatBot.
    """
    out = dict(merged)
    # site
    _site = str(out.get("site", "")).lower().strip()
    if _site in _ADSORBATE_PLACE_SITE_ALIASES:
        out["site"] = _ADSORBATE_PLACE_SITE_ALIASES[_site]
    # species
    _sp_raw = str(out.get("species", "")).lstrip("*").strip()
    _sp_ascii = _sp_raw.translate(_UNICODE_SUBSCRIPT_MAP)
    if _sp_ascii and _sp_ascii != out.get("species"):
        out["species"] = _sp_ascii
    # mode (LLM-invented) → auto_rotate
    if "mode" in out:
        _m = str(out["mode"]).lower().strip()
        if _m in ("end-on", "end_on", "endon", "vertical", "upright"):
            out.setdefault("auto_rotate", True)
        elif _m in ("side-on", "side_on", "sideon", "flat", "horizontal", "parallel"):
            out["auto_rotate"] = False
        del out["mode"]
    # strip anything not in the schema
    dropped = [k for k in out if k not in _ADSORBATE_PLACE_ALLOWED_KEYS]
    if dropped:
        logger.warning("adsorbate_place: dropped unknown params from LLM: %s", dropped)
        for k in dropped:
            del out[k]
    return out


def _validate_graph(graph: dict) -> tuple[list[str], list[str]]:
    """Validate workflow DAG — returns ``(errors, warnings)``.

    *Errors* are issues that would cause execution failure and **block run**.
    *Warnings* are informational and do not block execution.
    """
    errors: list[str] = []
    warnings: list[str] = []
    nodes = graph.get("nodes", [])
    edges = graph.get("edges", [])
    node_ids = {n["id"] for n in nodes}

    # ERROR: orphaned edge references (referencing non-existent nodes)
    for e in edges:
        if e["from"] not in node_ids:
            errors.append(f"Edge {e['id']} references missing source node {e['from']}")
        if e["to"] not in node_ids:
            errors.append(f"Edge {e['id']} references missing target node {e['to']}")

    # WARNING: handle compatibility (soft — node may accept dynamic handles)
    for e in edges:
        src = next((n for n in nodes if n["id"] == e["from"]), None)
        tgt = next((n for n in nodes if n["id"] == e["to"]), None)
        if src and tgt:
            src_def = _NODE_DEFAULTS.get(src["type"], {})
            tgt_def = _NODE_DEFAULTS.get(tgt["type"], {})
            if "_alias" in src_def:
                src_def = _NODE_DEFAULTS.get(src_def["_alias"], {})
            if "_alias" in tgt_def:
                tgt_def = _NODE_DEFAULTS.get(tgt_def["_alias"], {})
            from_h = e.get("fromH", "structure")
            to_h = e.get("toH", "structure")
            src_outputs = src_def.get("_outputs", [])
            tgt_inputs = tgt_def.get("_inputs", [])
            if src_outputs and from_h not in src_outputs:
                warnings.append(f"Node {src['id']} ({src['type']}) has no output '{from_h}'. Available: {src_outputs}")
            if tgt_inputs and to_h not in tgt_inputs:
                warnings.append(f"Node {tgt['id']} ({tgt['type']}) has no input '{to_h}'. Available: {tgt_inputs}")

    # ERROR: cycle detection (topological sort)
    adj: dict[str, list[str]] = {nid: [] for nid in node_ids}
    in_degree: dict[str, int] = {nid: 0 for nid in node_ids}
    for e in edges:
        if e["from"] in adj and e["to"] in in_degree:
            adj[e["from"]].append(e["to"])
            in_degree[e["to"]] += 1
    queue = [nid for nid, d in in_degree.items() if d == 0]
    visited = 0
    while queue:
        nid = queue.pop(0)
        visited += 1
        for nb in adj.get(nid, []):
            in_degree[nb] -= 1
            if in_degree[nb] == 0:
                queue.append(nb)
    if visited < len(node_ids):
        errors.append("Graph contains a cycle — workflow execution will fail.")

    # ERROR: non-input nodes missing required incoming edges
    for n in nodes:
        if n["type"] not in ("structure_input", "structure_list_input") and n["id"] not in {e["to"] for e in edges}:
            ndef = _NODE_DEFAULTS.get(n["type"], {})
            if "_alias" in ndef:
                ndef = _NODE_DEFAULTS.get(ndef["_alias"], {})
            if ndef.get("_inputs"):
                errors.append(f"Node {n['id']} ({n['type']}) has no incoming edge — it won't receive input data.")

    # WARNING: leaf nodes (no outgoing edges) — informational only
    nodes_with_outgoing = {e["from"] for e in edges}
    for n in nodes:
        ndef = _NODE_DEFAULTS.get(n["type"], {})
        if "_alias" in ndef:
            ndef = _NODE_DEFAULTS.get(ndef["_alias"], {})
        if ndef.get("_outputs") and n["id"] not in nodes_with_outgoing:
            warnings.append(f"Node {n['id']} ({n['type']}) has no outgoing edges (leaf node).")

    return errors, warnings


# Fix #1: Per-action required params validation
_ACTION_REQUIRED: dict[str, list[str]] = {
    "list": [],
    "templates": [],
    "node_types": [],
    "node_details": ["node_type"],
    "create": ["name"],
    "rename": ["workflow_id", "name"],
    "get": ["workflow_id"],
    "add_node": ["workflow_id", "node_type"],
    "remove_node": ["workflow_id", "node_id"],
    "connect": ["workflow_id", "from_id", "to_id"],
    "set_params": ["workflow_id", "node_id", "params"],
    "batch": ["workflow_id", "operations"],
    "run": ["workflow_id"],
    "pause": ["workflow_id"],
    "resume": ["workflow_id"],
    "validate": ["workflow_id"],
    "status": ["workflow_id"],
    "step_error": ["workflow_id", "step_id"],
    "retry": ["workflow_id", "step_id"],
    "batch_status": ["workflow_id", "step_id"],
    "batch_results": ["workflow_id", "step_id"],
    "list_presets": [],
}


def _normalize_run_config_aliases(user_config: dict) -> dict:
    """Accept user-facing HPC aliases and emit WorkflowRunConfig fields."""
    config = dict(user_config or {})
    if not config:
        return config

    job_params = dict(config.get("default_job_params") or {})

    session_id = config.pop("hpc_session_id", None) or config.pop("session_id", None)
    if session_id and not config.get("default_session_id"):
        config["default_session_id"] = session_id

    alias_to_job_param = {
        "nodes": "nodes",
        "ntasks": "ntasks",
        "ppn": "cpus_per_task",
        "cpus_per_task": "cpus_per_task",
        "walltime": "walltime",
        "time_limit": "walltime",
        "queue": "partition",
        "partition": "partition",
        "memory": "memory",
        "account": "account",
    }
    for alias, target in alias_to_job_param.items():
        if alias in config:
            val = config.pop(alias)
            if val is not None and val != "":
                job_params[target] = val

    if job_params:
        config["default_job_params"] = job_params

    module_loads = config.pop("modules", None) or config.pop("module_loads", None)
    python_env = config.pop("env_commands", None) or config.pop("python_env", None)
    active_session = config.get("default_session_id")
    if active_session and (module_loads or python_env):
        cluster_configs = dict(config.get("cluster_configs") or {})
        cluster_cfg = dict(cluster_configs.get(active_session) or {})
        if module_loads:
            cluster_cfg["module_loads"] = module_loads
        if python_env:
            cluster_cfg["python_env"] = python_env
        if job_params:
            cluster_cfg["default_job_params"] = {
                **dict(cluster_cfg.get("default_job_params") or {}),
                **job_params,
            }
        cluster_configs[active_session] = cluster_cfg
        config["cluster_configs"] = cluster_configs

    hpc_markers = {"default_session_id", "default_job_params", "cluster_configs"}
    if "execution_mode" not in config and any(k in config for k in hpc_markers):
        config["execution_mode"] = "hpc"

    return config


async def _handle_workflow(client: httpx.AsyncClient, args: dict) -> list[TextContent]:
    """Handle all workflow operations via a single unified tool.

    Fixes applied:
      #1 — Per-action required param validation
      #2 — Optimistic locking via updated_at comparison
      #4 — Node default params from _NODE_DEFAULTS
      #5 — Graph validation (cycles, handles, orphans)
      #6 — Configurable run_config for HPC support
    """
    import time, random as _rnd

    action = args.get("action", "")
    wf_id = args.get("workflow_id", "")
    base = f"{API_BASE}/workflow"
    _t = TextContent

    # Fix #1: Validate required params for this action
    required = _ACTION_REQUIRED.get(action)
    if required is None:
        valid = ", ".join(_ACTION_REQUIRED.keys())
        return [_t(type="text", text=f"Unknown action '{action}'. Valid actions: {valid}")]
    missing = [p for p in required if not args.get(p)]
    if missing:
        return [_t(type="text", text=f"Action '{action}' requires: {', '.join(missing)}")]

    try:
        # -- Read-only actions --
        if action == "list":
            resp = await client.get(f"{base}/")
            data = resp.json()
            if not data:
                return [_t(type="text", text="No workflows found. Use action='create' to create one.")]
            lines = ["Workflows:"]
            for w in data:
                lines.append(f"  - {w['id']}: {w['name']} ({w.get('status', 'draft')}, {w.get('step_count', 0)} steps)")
            return [_t(type="text", text="\n".join(lines))]

        if action == "templates":
            resp = await client.get(f"{base}/templates")
            data = resp.json()
            if not data:
                return [_t(type="text", text="No templates available.")]
            lines = ["Workflow templates:"]
            for t in data:
                lines.append(f"  - {t['id']}: {t['name']} \u2014 {t.get('description', '')}")
            return [_t(type="text", text="\n".join(lines))]

        if action == "node_types":
            # Use the broad /node-categories endpoint (calc + build + analysis +
            # logic + kmc) rather than /calc-type-categories (calc-only).
            # See `NODE_CATEGORIES` in catgo/models/workflow_run.py for the
            # canonical list and the rationale for the two endpoints.
            resp = await client.get(f"{base}/node-categories")
            data = resp.json()
            cat_filter = args.get("category", "")
            lines = ["Available node types (use action='node_details' for params/IO):"]
            for cat_key, cat_info in data.items():
                if cat_filter and cat_filter.lower() not in cat_key.lower():
                    continue
                label = cat_info.get("label", cat_key) if isinstance(cat_info, dict) else cat_key
                desc = cat_info.get("description", "") if isinstance(cat_info, dict) else ""
                node_list = cat_info.get("node_types", []) if isinstance(cat_info, dict) else cat_info
                lines.append(f"\n  [{cat_key}] {label}")
                if desc:
                    lines.append(f"    {desc}")
                for n in node_list:
                    ntype = n if isinstance(n, str) else n.get("type", n.get("id", "?"))
                    nlabel = n.get("label", ntype) if isinstance(n, dict) else ntype
                    suffix = f": {nlabel}" if nlabel != ntype else ""
                    lines.append(f"    - {ntype}{suffix}")
            return [_t(type="text", text="\n".join(lines))]

        if action == "node_details":
            node_type = args["node_type"]
            ndef = _NODE_DEFAULTS.get(node_type)
            if ndef is None:
                available = sorted(
                    k for k, v in _NODE_DEFAULTS.items() if "_alias" not in v
                )
                return [_t(type="text", text=(
                    f"Unknown node type '{node_type}'. "
                    f"Available types: {', '.join(available)}"
                ))]
            # Resolve alias
            if "_alias" in ndef:
                canonical = ndef["_alias"]
                ndef = _NODE_DEFAULTS.get(canonical, {})
                alias_note = f" (alias for '{canonical}')"
            else:
                canonical = node_type
                alias_note = ""
            inputs = ndef.get("_inputs", [])
            outputs = ndef.get("_outputs", [])
            defaults = ndef.get("defaults", {})
            lines = [f"Node type: {node_type}{alias_note}"]
            lines.append(f"Inputs:  {inputs if inputs else '(none)'}")
            lines.append(f"Outputs: {outputs if outputs else '(none)'}")
            if defaults:
                lines.append("Default parameters:")
                for k, v in defaults.items():
                    lines.append(f"  {k}: {v!r}")
            else:
                lines.append("Default parameters: (none)")
            return [_t(type="text", text="\n".join(lines))]

        if action == "get":
            resp = await client.get(f"{base}/{wf_id}")
            if resp.status_code != 200:
                return [_t(type="text", text=f"Workflow {wf_id} not found.")]
            wf = resp.json()
            graph = json.loads(wf.get("graph_json", "{}"))
            nodes = graph.get("nodes", [])
            edges = graph.get("edges", [])
            lines = [f"Workflow: {wf['name']} (status={wf.get('status', 'draft')}, updated_at={wf.get('updated_at', '?')})"]
            lines.append(f"Nodes ({len(nodes)}):")
            for n in nodes:
                p_summary = ", ".join(f"{k}={v}" for k, v in n.get("params", {}).items() if not k.startswith("_"))
                lines.append(f"  - {n['id']}: {n['type']}{f' ({p_summary})' if p_summary else ''}")
            lines.append(f"Edges ({len(edges)}):")
            for e in edges:
                lines.append(f"  - {e['from']} \u2192[{e.get('fromH','?')}\u2192{e.get('toH','?')}] {e['to']}")
            return [_t(type="text", text="\n".join(lines))]

        if action == "status":
            resp = await client.get(f"{base}/{wf_id}/run-status")
            if resp.status_code != 200:
                return [_t(type="text", text=f"Cannot get status for {wf_id}.")]
            return [_t(type="text", text=json.dumps(resp.json(), indent=2))]

        if action == "step_error":
            step_id = args["step_id"]
            resp = await client.get(f"{base}/{wf_id}/steps/{step_id}/status")
            if resp.status_code != 200:
                return [_t(type="text", text=f"Step {step_id} not found.")]
            return [_t(type="text", text=json.dumps(resp.json(), indent=2))]

        # -- Create --
        if action == "create":
            wf_name = args["name"]
            template_id = args.get("template_id")
            # Support multiple materials: material_ids is a list of MP IDs
            # e.g. ["mp-825", "mp-1008677"] → creates one structure_input per material
            material_ids = args.get("material_ids", [])
            if isinstance(material_ids, str):
                # Accept comma-separated string too: "mp-825,mp-1008677"
                material_ids = [m.strip() for m in material_ids.split(",") if m.strip()]
            if template_id:
                resp = await client.post(f"{base}/from-template/{template_id}", params={"name": wf_name})
            else:
                init_nodes: list[dict] = []

                if material_ids:
                    # Create one structure_input node per material ID
                    for idx, mp_id in enumerate(material_ids):
                        si_id = f"n{int(time.time())}-{idx}{''.join(_rnd.choices('abcdefghijklmnop', k=4))}"
                        si_params: dict[str, object] = {"label": mp_id, "mp_id": mp_id}
                        struct_json = await _fetch_structure_by_mp_id(client, mp_id)
                        if struct_json:
                            si_params["structure_json"] = struct_json
                            logger.info("Fetched structure for %s into workflow", mp_id)
                        elif len(material_ids) == 1:
                            # Single-material create and the mp-id fetch failed:
                            # fall back to the current viewer structure. CatBot
                            # usually loads the material into the viewer (by name)
                            # before building the workflow, so the viewer is the
                            # most reliable source of the intended structure.
                            # (Multi-material can't be disambiguated this way, so
                            # only single-material falls back.)
                            try:
                                sr = await client.get(f"{API_BASE}/view/structure/current")
                                if sr.status_code == 200:
                                    sd = sr.json()
                                    if sd:
                                        si_params["structure_json"] = json.dumps(sd) if isinstance(sd, dict) else str(sd)
                                        logger.info("Captured viewer structure for %s (mp-id fetch failed)", mp_id)
                            except Exception as e:
                                logger.warning("Viewer fallback failed for %s: %s", mp_id, e)
                            if not si_params.get("structure_json"):
                                logger.warning("Could not fetch structure for %s (no viewer fallback available)", mp_id)
                        else:
                            logger.warning("Could not fetch structure for %s", mp_id)
                        init_nodes.append({
                            "id": si_id, "type": "structure_input",
                            "x": 80, "y": 200 + idx * 200,
                            "params": si_params,
                        })
                else:
                    # Legacy single-material: auto-capture viewer structure
                    si_id = f"n{int(time.time())}-{''.join(_rnd.choices('abcdefghijklmnop', k=4))}"
                    si_params_single: dict[str, object] = {}
                    try:
                        sr = await client.get(f"{API_BASE}/view/structure/current")
                        if sr.status_code == 200:
                            struct_data = sr.json()
                            if struct_data:
                                si_params_single["structure_json"] = json.dumps(struct_data) if isinstance(struct_data, dict) else str(struct_data)
                                logger.info("Auto-captured viewer structure into new workflow")
                    except Exception as e:
                        logger.warning("Failed to auto-capture viewer structure on create: %s", e)
                    init_nodes.append({
                        "id": si_id, "type": "structure_input",
                        "x": 80, "y": 200,
                        "params": si_params_single,
                    })

                init_graph = {"nodes": init_nodes, "edges": []}
                payload = {"name": wf_name, "graph_json": json.dumps(init_graph)}
                resp = await client.post(f"{base}/", json=payload)
            if resp.status_code not in (200, 201):
                return [_t(type="text", text=f"Create failed ({resp.status_code}): {resp.text[:300]}")]
            wf = resp.json()
            await _push_workflow_navigate(client, wf["id"])
            create_graph = json.loads(wf.get("graph_json", "{}")) if "graph_json" in wf else init_graph
            snapshot = _graph_snapshot(create_graph)
            if material_ids:
                fetched = sum(1 for n in init_nodes if n["params"].get("structure_json"))
                struct_msg = f"with {fetched}/{len(material_ids)} materials fetched ({', '.join(material_ids)})"
            elif template_id:
                struct_msg = "from template"
            else:
                has_struct = bool(init_nodes[0]["params"].get("structure_json")) if init_nodes else False
                struct_msg = "with viewer structure captured" if has_struct else "(WARNING: no structure in viewer — user must import manually)"
            return [_t(type="text", text=f"Created workflow '{wf['name']}' (id={wf['id']}). {len(init_nodes)} structure_input node(s) {struct_msg}. Use add_node/batch to build the pipeline.{snapshot}")]

        # -- Rename: change only the workflow's display name, leave graph alone --
        if action == "rename":
            wf_id = args["workflow_id"]
            new_name = str(args["name"]).strip()
            if not new_name:
                return [_t(type="text", text="rename: name must be non-empty")]
            # PUT /{id} with only `name` — the backend WorkflowUpdate model
            # supports rename without touching graph_json (workflow.py:369,
            # "Update a workflow (save graph, rename, change status)").
            resp = await client.put(f"{base}/{wf_id}", json={"name": new_name})
            if resp.status_code not in (200, 201):
                return [_t(type="text", text=f"Rename failed ({resp.status_code}): {resp.text[:300]}")]
            wf = resp.json()
            # Refresh the open editor + sidebar so the new name shows without
            # a manual reload (same signal create/set_params use).
            await _push_workflow_navigate(client, wf_id)
            return [_t(type="text", text=f"Renamed workflow to '{wf.get('name', new_name)}' (id={wf_id}).")]

        # -- Batch mutation: multiple operations in a single read-modify-write --
        if action == "batch":
            operations = args["operations"]
            if not isinstance(operations, list) or len(operations) == 0:
                return [_t(type="text", text="'operations' must be a non-empty array.")]

            resp = await client.get(f"{base}/{wf_id}")
            if resp.status_code != 200:
                return [_t(type="text", text=f"Workflow {wf_id} not found.")]
            wf = resp.json()
            server_updated_at = wf.get("updated_at", "")
            graph = json.loads(wf.get("graph_json", '{"nodes":[],"edges":[]}'))
            nodes = graph.get("nodes", [])
            edges = graph.get("edges", [])

            results: list[str] = []
            node_id_map: dict[str, str] = {}  # label → real node_id for connect refs
            gap_x, gap_y = 300, 140
            batch_ts = int(time.time())  # shared timestamp for this batch

            for idx, op in enumerate(operations):
                op_type = op.get("op", op.get("action", ""))
                if op_type == "add_node":
                    raw_node_type = op.get("node_type", "")
                    if not raw_node_type:
                        results.append(f"[{idx}] add_node: missing node_type")
                        continue
                    # Same convention as the add_node action: registry keys are
                    # lowercase. Lower-case here so 'Geo_Opt' / 'MD' / 'NEB' hit
                    # the registry instead of falling through as unknown.
                    node_type = raw_node_type.lower()
                    ndef = _NODE_DEFAULTS.get(node_type, {})
                    if "_alias" in ndef:
                        node_type = ndef["_alias"]
                        ndef = _NODE_DEFAULTS.get(node_type, {})
                    # Reject unknown types here too. Without this, a typo
                    # (e.g. 'adsorbate_placement' instead of 'adsorbate_place')
                    # silently creates a ghost node with empty defaults and no
                    # engine binding — the frontend then can't render it and
                    # the rest of the batch (connect ops referencing this
                    # label) breaks downstream. The add_node action enforces
                    # this; the batch path used to skip it. See PR for the
                    # CatBot OER hang root-causing this.
                    if not ndef:
                        valid_types = sorted(
                            k for k, v in _NODE_DEFAULTS.items() if "_alias" not in v
                        )
                        suggestions = difflib.get_close_matches(
                            node_type, valid_types, n=3, cutoff=0.6,
                        )
                        msg = f"[{idx}] add_node: unknown node_type '{raw_node_type}'"
                        if suggestions:
                            msg += f" — did you mean: {', '.join(suggestions)}?"
                        results.append(msg)
                        continue
                    default_params = dict(ndef.get("defaults", {}))
                    user_params = op.get("params", {})
                    _sw_map: dict[tuple[str, str], str] = {
                        ("geo_opt", "mlp"): "mlp_relax", ("md", "mlp"): "mlp_md",
                        ("geo_opt", "orca"): "orca_opt", ("single_point", "orca"): "orca_sp",
                        ("freq", "orca"): "orca_freq",
                    }
                    sw = user_params.get("software")
                    if sw:
                        alt = _sw_map.get((node_type, sw))
                        if alt and alt in _NODE_DEFAULTS:
                            default_params = dict(_NODE_DEFAULTS[alt].get("defaults", {}))
                    merged = {**default_params, **user_params}

                    # Canonicalise LLM-flavoured params (site aliases, ASCII
                    # species, drop invented keys) so the stored graph contains
                    # exactly what the frontend NodeConfigPanel expects.
                    if node_type == "adsorbate_place":
                        merged = _normalize_adsorbate_place_params(merged)

                    # Resolve structure for structure_input (mp-id → viewer).
                    if node_type == "structure_input":
                        merged = await _resolve_structure_input_params(client, merged)

                    node_id = f"n{batch_ts}-{idx}{''.join(_rnd.choices('abcdefghijklmnop', k=2))}"
                    # Compute layer for positioning
                    node_ids_set = {n["id"] for n in nodes}
                    targets = {e["to"] for e in edges}
                    layer_of: dict[str, int] = {}
                    for n in nodes:
                        if n["id"] not in targets:
                            layer_of[n["id"]] = 0
                    changed = True
                    while changed:
                        changed = False
                        for e in edges:
                            sl = layer_of.get(e["from"], 0)
                            cur = layer_of.get(e["to"], -1)
                            if sl + 1 > cur:
                                layer_of[e["to"]] = sl + 1
                                changed = True
                    max_layer = max(layer_of.values(), default=0)
                    new_layer = max_layer + 1
                    same_layer = sum(1 for _, l in layer_of.items() if l == new_layer)
                    new_node = {
                        "id": node_id, "type": node_type,
                        "x": 80 + new_layer * gap_x, "y": 200 + same_layer * gap_y,
                        "params": merged,
                    }
                    nodes.append(new_node)
                    # Track label → id for connect references
                    label = op.get("label", op.get("id", ""))
                    if label:
                        node_id_map[label] = node_id
                    results.append(f"[{idx}] +node {node_id} ({node_type})")

                elif op_type == "connect":
                    from_id = op.get("from_id", "")
                    to_id = op.get("to_id", "")
                    # Resolve label references from earlier add_node ops
                    from_id = node_id_map.get(from_id, from_id)
                    to_id = node_id_map.get(to_id, to_id)
                    node_ids_set = {n["id"] for n in nodes}
                    if from_id not in node_ids_set:
                        results.append(f"[{idx}] connect: source {from_id} not found")
                        continue
                    if to_id not in node_ids_set:
                        results.append(f"[{idx}] connect: target {to_id} not found")
                        continue
                    if from_id == to_id:
                        results.append(f"[{idx}] connect: self-loop")
                        continue

                    src_node = next(n for n in nodes if n["id"] == from_id)
                    tgt_node = next(n for n in nodes if n["id"] == to_id)
                    src_def = _NODE_DEFAULTS.get(src_node["type"], {})
                    tgt_def = _NODE_DEFAULTS.get(tgt_node["type"], {})
                    if "_alias" in src_def:
                        src_def = _NODE_DEFAULTS.get(src_def["_alias"], {})
                    if "_alias" in tgt_def:
                        tgt_def = _NODE_DEFAULTS.get(tgt_def["_alias"], {})
                    from_h = op.get("from_handle", "structure")
                    to_h = op.get("to_handle", "structure")
                    src_outputs = src_def.get("_outputs", [])
                    tgt_inputs = tgt_def.get("_inputs", [])
                    # Auto-resolve single-handle; reject ambiguous multi-handle
                    if "from_handle" not in op and src_outputs:
                        if len(src_outputs) == 1:
                            from_h = src_outputs[0]
                        elif "structure" not in src_outputs:
                            results.append(f"[{idx}] connect: ambiguous from_handle for {src_node['type']} (outputs: {src_outputs})")
                            continue
                    if "to_handle" not in op and tgt_inputs:
                        if len(tgt_inputs) == 1:
                            to_h = tgt_inputs[0]
                        elif "structure" not in tgt_inputs:
                            results.append(f"[{idx}] connect: ambiguous to_handle for {tgt_node['type']} (inputs: {tgt_inputs})")
                            continue

                    # Dedup check
                    dup = any(e["from"] == from_id and e["to"] == to_id and e.get("fromH") == from_h and e.get("toH") == to_h for e in edges)
                    if dup:
                        results.append(f"[{idx}] connect: edge {from_id}→{to_id} already exists")
                        continue
                    edge_id = f"e{batch_ts}-{idx}{''.join(_rnd.choices('abcdefghijklmnop', k=2))}"
                    edges.append({"id": edge_id, "from": from_id, "to": to_id, "fromH": from_h, "toH": to_h})
                    results.append(f"[{idx}] +edge {from_id}→{to_id}")

                elif op_type == "set_params":
                    nid = op.get("node_id", "")
                    nid = node_id_map.get(nid, nid)
                    params = op.get("params", {})
                    for k, v in list(params.items()):
                        if isinstance(v, str):
                            if v.lower() in ("true", "false"):
                                params[k] = v.lower() == "true"
                                continue
                            try: params[k] = int(v); continue
                            except ValueError: pass
                            try: params[k] = float(v); continue
                            except ValueError: pass
                    found = False
                    for n in nodes:
                        if n["id"] == nid:
                            merged_sp = {**n.get("params", {}), **params}
                            # Same resolution as add_node/create: editing a
                            # structure_input via set_params must also turn
                            # an mp_id (or nothing) into a real structure_json,
                            # else the node stays empty no matter how often
                            # the user asks CatBot to set it.
                            if n.get("type") == "structure_input":
                                merged_sp = await _resolve_structure_input_params(client, merged_sp)
                            n["params"] = merged_sp
                            found = True
                            break
                    if not found:
                        results.append(f"[{idx}] set_params: node {nid} not found")
                        continue
                    results.append(f"[{idx}] params {nid}")

                elif op_type == "remove_node":
                    nid = op.get("node_id", "")
                    nid = node_id_map.get(nid, nid)
                    if not any(n["id"] == nid for n in nodes):
                        results.append(f"[{idx}] remove: node {nid} not found")
                        continue
                    nodes = [n for n in nodes if n["id"] != nid]
                    edges = [e for e in edges if e["from"] != nid and e["to"] != nid]
                    graph["nodes"] = nodes
                    graph["edges"] = edges
                    results.append(f"[{idx}] -node {nid}")

                else:
                    results.append(f"[{idx}] unknown op '{op_type}'")

            graph["nodes"] = nodes
            graph["edges"] = edges

            # Validate, optimistic lock, save
            b_errors, b_warnings = _validate_graph(graph)
            check_resp = await client.get(f"{base}/{wf_id}")
            if check_resp.status_code == 200:
                current_ua = check_resp.json().get("updated_at", "")
                if current_ua and current_ua != server_updated_at:
                    return [_t(type="text", text="Conflict: workflow modified externally. Retry.")]

            update_resp = await client.put(f"{base}/{wf_id}", json={"graph_json": json.dumps(graph)})
            if update_resp.status_code != 200:
                return [_t(type="text", text=f"Failed to save: {update_resp.text[:300]}")]
            await _push_workflow_navigate(client, wf_id)

            # Compact response
            summary = f"Batch: {len(operations)} ops → {len(nodes)} nodes, {len(edges)} edges."
            validation_str = ""
            if b_errors:
                validation_str += "\n❌ " + "; ".join(b_errors)
            if b_warnings:
                validation_str += "\n⚠️ " + "; ".join(b_warnings)
            # Include node_id_map so model knows the real IDs
            id_map_str = ""
            if node_id_map:
                id_map_str = "\nNode IDs: " + ", ".join(f"{k}={v}" for k, v in node_id_map.items())
            snapshot = _graph_snapshot(graph)
            return [_t(type="text", text=f"{summary}{id_map_str}{validation_str}{snapshot}")]

        # -- Graph mutation: read-modify-write with optimistic locking --
        if action in ("add_node", "remove_node", "connect", "set_params"):
            # Fetch current graph
            resp = await client.get(f"{base}/{wf_id}")
            if resp.status_code != 200:
                return [_t(type="text", text=f"Workflow {wf_id} not found.")]
            wf = resp.json()
            server_updated_at = wf.get("updated_at", "")
            graph = json.loads(wf.get("graph_json", '{"nodes":[],"edges":[]}'))
            nodes = graph.get("nodes", [])
            edges = graph.get("edges", [])

            if action == "add_node":
                # Normalize: registry keys are lowercase by convention.
                # Lowercasing lets 'MD' / 'NEB' / 'Geo_Opt' hit the right entry
                # instead of falling through to did-you-mean.
                node_type = args["node_type"].lower()
                # Fix #4: Resolve alias and apply default params
                ndef = _NODE_DEFAULTS.get(node_type, {})
                if "_alias" in ndef:
                    node_type = ndef["_alias"]
                    ndef = _NODE_DEFAULTS.get(node_type, {})
                # Reject unknown types with a did-you-mean hint instead of
                # silently creating an empty node. Without this, typos and
                # stale type names from LLM training data produce ghost
                # nodes that look added (no error) but have no defaults
                # and no engine binding — they only fail later at execute.
                if not ndef:
                    valid_types = sorted(
                        k for k, v in _NODE_DEFAULTS.items() if "_alias" not in v
                    )
                    suggestions = difflib.get_close_matches(
                        node_type, valid_types, n=3, cutoff=0.6,
                    )
                    parts = [f"Unknown node type '{args['node_type']}'."]
                    if suggestions:
                        parts.append(f"Did you mean: {', '.join(suggestions)}?")
                    parts.append(
                        "Run action='node_types' to list every valid type "
                        "grouped by category (calculation/build/analysis/logic/kmc)."
                    )
                    return [_t(type="text", text=" ".join(parts))]
                default_params = dict(ndef.get("defaults", {}))
                user_params = args.get("params", {})
                # If user specifies a different software, use that software's
                # dedicated defaults instead of the generic (VASP) ones.
                # e.g. geo_opt + software='mlp' → use mlp_relax defaults
                _software_defaults_map: dict[tuple[str, str], str] = {
                    ("geo_opt", "mlp"): "mlp_relax",
                    ("md", "mlp"): "mlp_md",
                    ("geo_opt", "orca"): "orca_opt",
                    ("single_point", "orca"): "orca_sp",
                    ("freq", "orca"): "orca_freq",
                }
                user_software = user_params.get("software")
                if user_software:
                    alt_key = _software_defaults_map.get((node_type, user_software))
                    if alt_key and alt_key in _NODE_DEFAULTS:
                        default_params = dict(_NODE_DEFAULTS[alt_key].get("defaults", {}))
                merged_params = {**default_params, **user_params}

                # Canonicalise LLM-flavoured params for adsorbate_place. See
                # _normalize_adsorbate_place_params docstring for the rules.
                if node_type == "adsorbate_place":
                    merged_params = _normalize_adsorbate_place_params(merged_params)

                # Resolve structure for structure_input (mp-id → viewer).
                # Previously this path only did viewer capture (no mp-id
                # fetch) — now unified with every other path via the helper.
                if node_type == "structure_input":
                    merged_params = await _resolve_structure_input_params(client, merged_params)

                node_id = f"n{int(time.time())}-{''.join(_rnd.choices('abcdefghijklmnop', k=4))}"
                # DAG-layer-aware positioning (matches editor's Sugiyama layout)
                # Compute layer = 1 + max layer of existing nodes (new node follows them)
                node_ids = {n["id"] for n in nodes}
                targets = {e["to"] for e in edges}
                # Nodes with no incoming edges are layer 0
                layer_of: dict[str, int] = {}
                for n in nodes:
                    if n["id"] not in targets:
                        layer_of[n["id"]] = 0
                # BFS to compute layers
                changed = True
                while changed:
                    changed = False
                    for e in edges:
                        src_layer = layer_of.get(e["from"], 0)
                        cur = layer_of.get(e["to"], -1)
                        if src_layer + 1 > cur:
                            layer_of[e["to"]] = src_layer + 1
                            changed = True
                max_layer = max(layer_of.values(), default=0)
                new_layer = max_layer + 1  # New node at next layer
                # Count existing nodes in the same layer for y-offset
                same_layer_count = sum(1 for nid, l in layer_of.items() if l == new_layer)
                gap_x, gap_y = 300, 140
                new_node = {
                    "id": node_id,
                    "type": node_type,
                    "x": 80 + new_layer * gap_x,
                    "y": 200 + same_layer_count * gap_y,
                    "params": merged_params,
                }
                nodes.append(new_node)
                graph["nodes"] = nodes

            elif action == "remove_node":
                node_id = args["node_id"]
                if not any(n["id"] == node_id for n in nodes):
                    return [_t(type="text", text=f"Node {node_id} not found in workflow.")]
                graph["nodes"] = [n for n in nodes if n["id"] != node_id]
                graph["edges"] = [e for e in edges if e["from"] != node_id and e["to"] != node_id]

            elif action == "connect":
                from_id, to_id = args["from_id"], args["to_id"]
                # Fix #5: Validate node IDs exist
                node_ids = {n["id"] for n in nodes}
                if from_id not in node_ids:
                    return [_t(type="text", text=f"Source node {from_id} not found. Existing: {', '.join(node_ids)}")]
                if to_id not in node_ids:
                    return [_t(type="text", text=f"Target node {to_id} not found. Existing: {', '.join(node_ids)}")]
                if from_id == to_id:
                    return [_t(type="text", text="Cannot connect a node to itself.")]

                # Resolve node types and their definitions for handle validation
                src_node = next(n for n in nodes if n["id"] == from_id)
                tgt_node = next(n for n in nodes if n["id"] == to_id)
                src_def = _NODE_DEFAULTS.get(src_node["type"], {})
                tgt_def = _NODE_DEFAULTS.get(tgt_node["type"], {})
                if "_alias" in src_def:
                    src_def = _NODE_DEFAULTS.get(src_def["_alias"], {})
                if "_alias" in tgt_def:
                    tgt_def = _NODE_DEFAULTS.get(tgt_def["_alias"], {})
                src_outputs = src_def.get("_outputs", [])
                tgt_inputs = tgt_def.get("_inputs", [])

                from_h_explicit = "from_handle" in args
                to_h_explicit = "to_handle" in args
                from_h = args.get("from_handle", "structure")
                to_h = args.get("to_handle", "structure")

                # Ambiguity detection: reject default "structure" when it is
                # not a valid handle or the node has multiple handles.
                if not from_h_explicit and src_outputs:
                    if len(src_outputs) == 1 and src_outputs[0] == "structure":
                        pass  # safe default
                    else:
                        return [_t(type="text", text=(
                            f"Ambiguous from_handle: source node {from_id} ({src_node['type']}) "
                            f"has outputs {src_outputs}. "
                            f"Please specify from_handle explicitly."
                        ))]
                if not to_h_explicit and tgt_inputs:
                    if len(tgt_inputs) == 1 and tgt_inputs[0] == "structure":
                        pass  # safe default
                    else:
                        return [_t(type="text", text=(
                            f"Ambiguous to_handle: target node {to_id} ({tgt_node['type']}) "
                            f"has inputs {tgt_inputs}. "
                            f"Please specify to_handle explicitly."
                        ))]

                # Check duplicate edge (include handles -- same node pair may have multiple valid edges on different ports)
                for e in edges:
                    if e["from"] == from_id and e["to"] == to_id and e.get("fromH") == from_h and e.get("toH") == to_h:
                        return [_t(type="text", text=f"Edge {from_id}:{from_h} \u2192 {to_id}:{to_h} already exists.")]
                edge_id = f"e{int(time.time())}-{''.join(_rnd.choices('abcdefghijklmnop', k=4))}"
                new_edge = {
                    "id": edge_id,
                    "from": from_id,
                    "to": to_id,
                    "fromH": from_h,
                    "toH": to_h,
                }
                edges.append(new_edge)
                graph["edges"] = edges

            elif action == "set_params":
                node_id = args["node_id"]
                params = args["params"]
                # Coerce string values to proper types (AI often sends "520" instead of 520)
                for k, v in list(params.items()):
                    if isinstance(v, str):
                        if v.lower() in ("true", "false"):
                            params[k] = v.lower() == "true"
                            continue
                        try:
                            params[k] = int(v)
                            continue
                        except ValueError:
                            pass
                        try:
                            params[k] = float(v)
                            continue
                        except ValueError:
                            pass
                found = False
                for n in nodes:
                    if n["id"] == node_id:
                        merged_set = {**n.get("params", {}), **params}
                        if n.get("type") == "adsorbate_place":
                            merged_set = _normalize_adsorbate_place_params(merged_set)
                        elif n.get("type") == "structure_input":
                            # Editing a structure_input must resolve mp_id /
                            # viewer into a real structure_json — without this
                            # the node stays empty however many times asked.
                            merged_set = await _resolve_structure_input_params(client, merged_set)
                        n["params"] = merged_set
                        found = True
                        break
                if not found:
                    return [_t(type="text", text=f"Node {node_id} not found in workflow.")]

            # Fix #5: Validate the graph before saving
            errors, warnings = _validate_graph(graph)

            # Fix #2: Optimistic locking -- re-check updated_at before PUT
            check_resp = await client.get(f"{base}/{wf_id}")
            if check_resp.status_code == 200:
                current_updated_at = check_resp.json().get("updated_at", "")
                if current_updated_at and current_updated_at != server_updated_at:
                    return [_t(type="text", text=(
                        f"Conflict: workflow was modified externally while editing "
                        f"(expected updated_at={server_updated_at}, got {current_updated_at}). "
                        f"Please retry \u2014 the latest version will be fetched."
                    ))]

            # Save updated graph
            update_resp = await client.put(
                f"{base}/{wf_id}",
                json={"graph_json": json.dumps(graph)},
            )
            if update_resp.status_code != 200:
                return [_t(type="text", text=f"Failed to update workflow: {update_resp.text[:300]}")]

            # Signal frontend to navigate to / refresh this workflow
            await _push_workflow_navigate(client, wf_id)

            # Build response — show both errors and warnings for incremental operations
            validation_str = ""
            if errors:
                validation_str += "\n❌ Errors:\n" + "\n".join(f"  - {e}" for e in errors)
            if warnings:
                validation_str += "\n⚠️ Warnings:\n" + "\n".join(f"  - {w}" for w in warnings)

            snapshot = _graph_snapshot(graph)

            if action == "add_node":
                p_str = ", ".join(f"{k}={v}" for k, v in merged_params.items())
                return [_t(type="text", text=f"Added node {node_id} (type={node_type}, params: {p_str}). {len(graph['nodes'])} nodes total.{validation_str}{snapshot}")]
            elif action == "remove_node":
                return [_t(type="text", text=f"Removed node {node_id}. {len(graph['nodes'])} nodes, {len(graph['edges'])} edges remaining.{validation_str}{snapshot}")]
            elif action == "connect":
                return [_t(type="text", text=f"Connected {from_id} \u2192 {to_id}. {len(graph['edges'])} edges total.{validation_str}{snapshot}")]
            elif action == "set_params":
                return [_t(type="text", text=f"Updated params for node {node_id}.{validation_str}{snapshot}")]

        # -- Execution control --
        if action == "run":
            # Validate graph before running — block on errors
            vresp = await client.get(f"{base}/{wf_id}")
            if vresp.status_code != 200:
                return [_t(type="text", text=f"Workflow {wf_id} not found.")]
            vgraph = json.loads(vresp.json().get("graph_json", "{}"))
            run_errors, run_warnings = _validate_graph(vgraph)
            if run_errors:
                err_list = "\n".join(f"  - {e}" for e in run_errors)
                warn_note = ""
                if run_warnings:
                    warn_note = "\n⚠️ Warnings:\n" + "\n".join(f"  - {w}" for w in run_warnings)
                return [_t(type="text", text=(
                    f"❌ Cannot run workflow — {len(run_errors)} error(s) found:\n{err_list}{warn_note}\n\n"
                    f"Fix the errors above, then retry."
                ))]

            # Safety: require explicit run_config or confirm=true to prevent accidental execution
            user_config = _normalize_run_config_aliases(args.get("run_config") or args.get("params") or {})
            if not user_config and not args.get("confirm"):
                return [_t(type="text", text=(
                    "\u26a0\ufe0f MCP `run` will IMMEDIATELY execute the workflow (not open a UI dialog). "
                    "Pass `run_config` with execution settings, or `confirm: true` to run with defaults "
                    "(local mode, ~/calculations). For HPC, include cluster/queue/account in run_config."
                ))]
            config = {
                "execution_mode": user_config.get("execution_mode", "local"),
                "base_work_dir": user_config.get("base_work_dir", "~/calculations"),
                "use_custodian": user_config.get("use_custodian", True),
                "custodian_max_errors": user_config.get("custodian_max_errors", 5),
                "poll_interval": user_config.get("poll_interval", 15),
                **{k: v for k, v in user_config.items() if k not in (
                    "execution_mode", "base_work_dir", "use_custodian",
                    "custodian_max_errors", "poll_interval",
                )},
            }
            resp = await client.post(f"{base}/{wf_id}/run", json=config)
            if resp.status_code != 200:
                detail = resp.text[:300]
                try:
                    detail = resp.json().get("detail", detail)
                except Exception:
                    pass
                return [_t(type="text", text=f"Run failed ({resp.status_code}): {detail}")]
            await _push_workflow_navigate(client, wf_id)
            run_warn_str = ""
            if run_warnings:
                run_warn_str = "\n⚠️ Warnings:\n" + "\n".join(f"  - {w}" for w in run_warnings)
            return [_t(type="text", text=f"Workflow {wf_id} started (mode={config['execution_mode']}). Use action='status' to monitor.{run_warn_str}")]

        if action == "pause":
            resp = await client.post(f"{base}/{wf_id}/pause")
            if resp.status_code != 200:
                return [_t(type="text", text=f"Pause failed: {resp.text[:300]}")]
            return [_t(type="text", text=f"Workflow {wf_id} paused. Use action='resume' to continue.")]

        if action == "resume":
            user_config = _normalize_run_config_aliases(args.get("run_config") or args.get("params") or {})
            config = {
                "execution_mode": user_config.get("execution_mode", "local"),
                "base_work_dir": user_config.get("base_work_dir", "~/calculations"),
                "use_custodian": user_config.get("use_custodian", True),
                "custodian_max_errors": user_config.get("custodian_max_errors", 5),
                "poll_interval": user_config.get("poll_interval", 15),
                **{k: v for k, v in user_config.items() if k not in (
                    "execution_mode", "base_work_dir", "use_custodian",
                    "custodian_max_errors", "poll_interval",
                )},
            }
            resp = await client.post(f"{base}/{wf_id}/resume", json=config)
            if resp.status_code != 200:
                detail = resp.text[:300]
                try:
                    detail = resp.json().get("detail", detail)
                except Exception:
                    pass
                return [_t(type="text", text=f"Resume failed ({resp.status_code}): {detail}")]
            return [_t(type="text", text=f"Workflow {wf_id} resumed. Use action='status' to monitor.")]

        if action == "validate":
            resp = await client.get(f"{base}/{wf_id}")
            if resp.status_code != 200:
                return [_t(type="text", text=f"Cannot load workflow {wf_id}: {resp.text[:300]}")]
            wf = resp.json()
            graph = json.loads(wf.get("graph_json", "{}"))
            errors, warnings = _validate_graph(graph)
            parts = []
            if errors:
                parts.append(f"❌ {len(errors)} error(s) (will block run):\n" + "\n".join(f"  - {e}" for e in errors))
            if warnings:
                parts.append(f"⚠️ {len(warnings)} warning(s):\n" + "\n".join(f"  - {w}" for w in warnings))
            if parts:
                return [_t(type="text", text="\n".join(parts))]
            return [_t(type="text", text=f"✓ Workflow {wf_id} is valid. No errors or warnings.")]

        # -- Retry: reset a step and all downstream to pending ("rerun from here") --
        if action == "retry":
            step_id = args.get("step_id")
            if not step_id:
                return [_t(type="text", text="retry requires 'step_id'.")]
            resp = await client.post(f"{base}/{wf_id}/steps/{step_id}/retry")
            if resp.status_code not in (200, 201):
                return [_t(type="text", text=f"Retry failed ({resp.status_code}): {resp.text[:300]}")]
            return [_t(type="text", text=json.dumps(resp.json(), indent=2))]

        # -- Batch status: get batch job summary for a batch node --
        if action == "batch_status":
            step_id = args.get("step_id")
            if not step_id:
                return [_t(type="text", text="batch_status requires 'step_id'.")]
            resp = await client.get(f"{base}/{wf_id}/steps/{step_id}/batch-summary")
            if resp.status_code != 200:
                return [_t(type="text", text=f"batch_status failed ({resp.status_code}): {resp.text[:300]}")]
            return [_t(type="text", text=json.dumps(resp.json(), indent=2))]

        # -- Batch results: get paginated batch subtask results --
        if action == "batch_results":
            step_id = args.get("step_id")
            if not step_id:
                return [_t(type="text", text="batch_results requires 'step_id'.")]
            page = args.get("page", 1)
            resp = await client.get(
                f"{base}/{wf_id}/steps/{step_id}/batch-results",
                params={"page": page, "per_page": 50},
            )
            if resp.status_code != 200:
                return [_t(type="text", text=f"batch_results failed ({resp.status_code}): {resp.text[:300]}")]
            return [_t(type="text", text=json.dumps(resp.json(), indent=2))]

        # -- List presets: available VASP or adsorbate presets --
        if action == "list_presets":
            preset_type = args.get("preset_type", "vasp")
            if preset_type == "adsorbates":
                # Read directly from the JSON source of truth so this view
                # stays in sync with the workflow engine and the frontend
                # adsorbate library. Previously this imported a non-existent
                # `workflow.presets.adsorbates` module and always errored out.
                try:
                    from pathlib import Path
                    json_path = (
                        Path(__file__).resolve().parent.parent
                        / "data" / "adsorbates.json"
                    )
                    data = json.loads(json_path.read_text(encoding="utf-8"))
                    groups = data.get("groups", [])
                    total = sum(len(g.get("presets", [])) for g in groups)
                    lines = [f"Available adsorbate presets ({total} entries across {len(groups)} reaction groups):\n"]
                    for g in groups:
                        lines.append(f"  [{g['label']}]")
                        for p in g.get("presets", []):
                            n_atoms = len(p.get("atoms", []))
                            display = p.get("display_formula", p["formula"])
                            note = f" (display: {display})" if display != p["formula"] else ""
                            lines.append(f"    {p['formula']:14s} — {p['name']} ({n_atoms} atoms){note}")
                    lines.append("\nUse the ASCII formula (left column) as the 'species' param in adsorbate_place nodes.")
                    lines.append("Names are case-insensitive. A leading '*' prefix is accepted but optional.")
                    return [_t(type="text", text="\n".join(lines))]
                except (FileNotFoundError, OSError) as exc:
                    return [_t(type="text", text=f"Cannot load adsorbate presets: {exc}")]
            else:
                try:
                    from workflow.presets.vasp import PRESETS
                    return [_t(type="text", text=json.dumps(
                        {name: list(preset.keys()) for name, preset in PRESETS.items()},
                        indent=2,
                    ))]
                except ImportError as exc:
                    return [_t(type="text", text=f"Cannot load VASP presets: {exc}")]

    except Exception as exc:
        logger.error("Workflow %s failed: %s", action, exc, exc_info=True)
        return [_t(type="text", text=f"Workflow {action} failed: {exc}")]

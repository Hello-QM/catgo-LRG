#!/usr/bin/env python3
"""Create RuO2(110) and IrO2(110) OER workflows via the CatGo engine API.

Each workflow follows the DAG:
  structure_input (bulk)
    └→ slab_gen (110, 4 layers, 15A vacuum)
        ├→ geo_opt (clean slab) → freq → gibbs_energy (adsorbed)
        ├→ adsorbate_place (OH) → geo_opt (*OH) → freq → gibbs_energy (adsorbed)
        ├→ adsorbate_place (O)  → geo_opt (*O)  → freq → gibbs_energy (adsorbed)
        └→ adsorbate_place (OOH)→ geo_opt (*OOH)→ freq → gibbs_energy (adsorbed)

  Gas references (shared per workflow):
    H2O: structure_input → geo_opt → freq → gibbs_energy (gas)
    H2:  structure_input → geo_opt → freq → gibbs_energy (gas)
"""

import sys
import json
import httpx

API = "http://localhost:8000/api"

# ── Structures ──────────────────────────────────────────────────────
from pymatgen.core import Structure, Lattice

ruo2 = Structure(
    Lattice.tetragonal(4.4919, 3.1066),
    ["Ru", "Ru", "O", "O", "O", "O"],
    [
        [0.0, 0.0, 0.0],
        [0.5, 0.5, 0.5],
        [0.3058, 0.3058, 0.0],
        [0.6942, 0.6942, 0.0],
        [0.8058, 0.1942, 0.5],
        [0.1942, 0.8058, 0.5],
    ],
)

iro2 = Structure(
    Lattice.tetragonal(4.5051, 3.1586),
    ["Ir", "Ir", "O", "O", "O", "O"],
    [
        [0.0, 0.0, 0.0],
        [0.5, 0.5, 0.5],
        [0.3065, 0.3065, 0.0],
        [0.6935, 0.6935, 0.0],
        [0.8065, 0.1935, 0.5],
        [0.1935, 0.8065, 0.5],
    ],
)

# Gas-phase molecules
h2o = Structure(
    Lattice.cubic(15.0),
    ["O", "H", "H"],
    [[0.5, 0.5, 0.5], [0.5507, 0.5393, 0.5], [0.4493, 0.5393, 0.5]],
)

h2 = Structure(
    Lattice.cubic(15.0),
    ["H", "H"],
    [[0.5, 0.5, 0.475], [0.5, 0.5, 0.525]],
)

# ── VASP parameters ────────────────────────────────────────────────
GEO_OPT_PARAMS = {
    "software": "vasp",
    "ENCUT": 520,
    "EDIFF": 1e-5,
    "EDIFFG": -0.05,
    "NSW": 200,
    "IBRION": 2,
    "ISIF": 2,
    "ISMEAR": 0,
    "SIGMA": 0.05,
    "ISPIN": 1,
    "PREC": "Accurate",
    "ALGO": "Normal",
    "LREAL": "Auto",
    "LWAVE": False,
    "LCHARG": False,
    "NCORE": 4,
    "KPOINTS": [1, 1, 1],
}

# Gas-phase geo_opt: same but ISIF=2 is fine, large box
GEO_OPT_GAS_PARAMS = {**GEO_OPT_PARAMS, "ISMEAR": 0, "SIGMA": 0.01}

FREQ_PARAMS = {
    "software": "vasp",
    "IBRION": 5,
    "NFREE": 2,
    "POTIM": 0.015,
    "NSW": 1,
    "EDIFF": 1e-6,
    "ENCUT": 520,
    "ISPIN": 1,
    "LREAL": False,
    "LWAVE": False,
    "LCHARG": False,
    "NCORE": 4,
    "KPOINTS": [1, 1, 1],
}

WORK_DIR_BASE = "/expanse/projects/qstore/csd807/gliu3/catgo/0329"


# ── Helper: ref dict for service.add_task ───────────────────────────
def ref(task_id: str, key: str | None = None) -> dict:
    """Build an OutputReference dict for REST-style add_task."""
    return {"_ref": task_id, "_key": key}


# ── Build one OER workflow ──────────────────────────────────────────
def create_oer_workflow(
    client: httpx.Client,
    material_name: str,
    bulk_structure: Structure,
) -> str:
    """Create a full OER workflow for one material. Returns workflow_id."""

    wf_name = f"{material_name}(110) OER — Full Pipeline"
    bulk_json = bulk_structure.as_dict()

    # 1. Create workflow
    r = client.post(f"{API}/engine/workflows", json={
        "name": wf_name,
        "config": {
            "auto_submit": False,
            "hpc_session_id": None,
            "paths": {"base_dir": f"{WORK_DIR_BASE}/{material_name}"},
        },
    })
    # The REST router doesn't have a POST create endpoint.
    # Use the Python API directly via the MCP-style tool interface.
    # Actually, let's just use the Python API.
    raise NotImplementedError("Switching to direct Python API")


def create_oer_workflow_python(
    material_name: str,
    bulk_structure: Structure,
) -> str:
    """Create a full OER workflow using the Python Workflow API."""
    from catgo.workflow.db import WorkflowDB
    from catgo.workflow.workflow import Workflow
    from catgo.workflow.builtins import (
        structure_input, slab_gen, adsorbate_place,
        geo_opt, freq, gibbs_energy,
    )

    db = WorkflowDB(str(__import__("pathlib").Path("~/.catgo/catgo.db").expanduser()))

    wf = Workflow(
        f"{material_name}(110) OER — Full Pipeline",
        db=db,
        config={
            "auto_submit": False,
            "paths": {"base_dir": f"{WORK_DIR_BASE}/{material_name}"},
        },
    )

    bulk_json_str = json.dumps(bulk_structure.as_dict())

    # ── Slab branch ─────────────────────────────────────────────
    bulk_input = wf.add_task(
        structure_input,
        name=f"{material_name} bulk",
        structure=bulk_json_str,
    )

    slab = wf.add_task(
        slab_gen,
        name=f"{material_name}(110) slab",
        structure=bulk_input.output.structure,
        miller=[1, 1, 0],
        layers=4,
        vacuum=15.0,
    )

    # ── Clean slab branch ───────────────────────────────────────
    clean_opt = wf.add_task(
        geo_opt,
        name="geo_opt (clean slab)",
        system_name="clean",
        structure=slab.output.structure,
        **GEO_OPT_PARAMS,
    )
    clean_freq = wf.add_task(
        freq,
        name="freq (clean slab)",
        system_name="clean",
        structure=clean_opt.output.structure,
        **FREQ_PARAMS,
    )
    clean_gibbs = wf.add_task(
        gibbs_energy,
        name="gibbs (clean slab)",
        system_name="clean",
        energy=clean_opt.output.energy,
        frequencies=clean_freq.output.frequencies,
        phase="adsorbed",
    )

    # ── Adsorbate branches: OH, O, OOH ─────────────────────────
    for ads_species in ["OH", "O", "OOH"]:
        ads_place = wf.add_task(
            adsorbate_place,
            name=f"place *{ads_species}",
            structure=slab.output.structure,
            species=ads_species,
            site="ontop",
            height=2.0,
        )
        ads_opt = wf.add_task(
            geo_opt,
            name=f"geo_opt (*{ads_species})",
            system_name=f"*{ads_species}",
            structure=ads_place.output.structure,
            **GEO_OPT_PARAMS,
        )
        ads_freq = wf.add_task(
            freq,
            name=f"freq (*{ads_species})",
            system_name=f"*{ads_species}",
            structure=ads_opt.output.structure,
            **FREQ_PARAMS,
        )
        ads_gibbs = wf.add_task(
            gibbs_energy,
            name=f"gibbs (*{ads_species})",
            system_name=f"*{ads_species}",
            energy=ads_opt.output.energy,
            frequencies=ads_freq.output.frequencies,
            phase="adsorbed",
        )

    # ── Gas references: H2O ────────────────────────────────────
    h2o_input = wf.add_task(
        structure_input,
        name="H2O molecule",
        structure=json.dumps(h2o.as_dict()),
    )
    h2o_opt = wf.add_task(
        geo_opt,
        name="geo_opt (H2O gas)",
        system_name="H2O(g)",
        structure=h2o_input.output.structure,
        **GEO_OPT_GAS_PARAMS,
    )
    h2o_freq = wf.add_task(
        freq,
        name="freq (H2O gas)",
        system_name="H2O(g)",
        structure=h2o_opt.output.structure,
        **FREQ_PARAMS,
    )
    h2o_gibbs = wf.add_task(
        gibbs_energy,
        name="gibbs (H2O gas)",
        system_name="H2O(g)",
        energy=h2o_opt.output.energy,
        frequencies=h2o_freq.output.frequencies,
        phase="gas",
    )

    # ── Gas references: H2 ─────────────────────────────────────
    h2_input = wf.add_task(
        structure_input,
        name="H2 molecule",
        structure=json.dumps(h2.as_dict()),
    )
    h2_opt = wf.add_task(
        geo_opt,
        name="geo_opt (H2 gas)",
        system_name="H2(g)",
        structure=h2_input.output.structure,
        **GEO_OPT_GAS_PARAMS,
    )
    h2_freq = wf.add_task(
        freq,
        name="freq (H2 gas)",
        system_name="H2(g)",
        structure=h2_opt.output.structure,
        **FREQ_PARAMS,
    )
    h2_gibbs = wf.add_task(
        gibbs_energy,
        name="gibbs (H2 gas)",
        system_name="H2(g)",
        energy=h2_opt.output.energy,
        frequencies=h2_freq.output.frequencies,
        phase="gas",
    )

    # Print summary
    dag = wf.get_dag()
    print(f"\n{'='*60}")
    print(f"Workflow: {material_name}(110) OER")
    print(f"  ID:    {wf.workflow_id}")
    print(f"  Tasks: {len(dag['tasks'])}")
    print(f"  Links: {len(dag['links'])}")
    print(f"  Base:  {WORK_DIR_BASE}/{material_name}")
    print(f"{'='*60}")
    for t in dag["tasks"]:
        print(f"  [{t['status']:>14s}] {t['task_type']:20s}  {t.get('name', '')}")

    return wf.workflow_id


# ── Main ────────────────────────────────────────────────────────────
if __name__ == "__main__":
    print("Creating OER workflows for RuO2 and IrO2...")
    print(f"Work dir base: {WORK_DIR_BASE}")

    ruo2_wf_id = create_oer_workflow_python("RuO2", ruo2)
    iro2_wf_id = create_oer_workflow_python("IrO2", iro2)

    print(f"\n{'='*60}")
    print(f"SUMMARY")
    print(f"{'='*60}")
    print(f"RuO2 workflow ID: {ruo2_wf_id}")
    print(f"IrO2 workflow ID: {iro2_wf_id}")
    print(f"\nWorkflows created in DRAFT status.")
    print(f"To submit: POST http://localhost:8000/api/engine/workflows/<id>/submit")
    print(f"To view:   GET  http://localhost:8000/api/engine/workflows/<id>")

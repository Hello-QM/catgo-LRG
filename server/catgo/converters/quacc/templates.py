"""Pre-built CatGo workflow templates for common quacc workflows.

These templates are static JSON -- no runtime quacc dependency required.
Users can one-click import these into the CatGo workflow editor.
"""

from __future__ import annotations

import json
from typing import Any

__all__ = ["QUACC_TEMPLATES", "get_template", "list_templates"]

# Multiplication sign used in k-point grid strings
_X = "\u00d7"


def _graph(nodes: list[dict], edges: list[dict]) -> str:
    """Serialize a graph to JSON string."""
    return json.dumps({"nodes": nodes, "edges": edges})


# ---------------------------------------------------------------------------
# 1. Slab Relaxation Flow
# ---------------------------------------------------------------------------

_SLAB_RELAX_NODES = [
    {"id": "n1", "type": "structure_input", "x": 100, "y": 200, "params": {}},
    {"id": "n2", "type": "slab_gen", "x": 400, "y": 200, "params": {
        "miller": "1,0,0", "layers": 4, "vacuum": 15,
    }},
    {"id": "n3", "type": "geo_opt", "x": 700, "y": 200, "params": {
        "system_type": "periodic", "software": "vasp",
        "ENCUT": 520, "EDIFF": "1e-5", "EDIFFG": -0.02,
        "ISIF": 2, "NSW": 200, "IBRION": 2,
        "PREC": "Accurate", "ALGO": "Fast", "LREAL": "Auto",
        "ISMEAR": 0, "SIGMA": 0.05,
        "LORBIT": 11, "LWAVE": False, "LCHARG": False,
        "LDIPOL": True,
        "kpoints": f"3{_X}3{_X}1",
        "frozen_layers": 2,
        "label": "Slab Relaxation",
    }},
    {"id": "n4", "type": "single_point", "x": 1000, "y": 200, "params": {
        "system_type": "periodic", "software": "vasp",
        "ENCUT": 520, "EDIFF": "1e-6", "NSW": 0,
        "PREC": "Accurate", "ALGO": "Fast", "LREAL": False,
        "ISMEAR": -5, "SIGMA": 0.05,
        "LORBIT": 11, "LWAVE": False, "LCHARG": True,
        "LDIPOL": True,
        "kpoints": f"3{_X}3{_X}1",
        "label": "Slab Static",
    }},
]
_SLAB_RELAX_EDGES = [
    {"id": "e1", "from": "n1", "to": "n2", "fromH": "out-0", "toH": "in-0"},
    {"id": "e2", "from": "n2", "to": "n3", "fromH": "out-0", "toH": "in-0"},
    {"id": "e3", "from": "n3", "to": "n4", "fromH": "out-0", "toH": "in-0"},
]

# ---------------------------------------------------------------------------
# 2. Band Structure Flow
# ---------------------------------------------------------------------------

_BAND_STRUCTURE_NODES = [
    {"id": "n1", "type": "structure_input", "x": 100, "y": 200, "params": {}},
    {"id": "n2", "type": "single_point", "x": 400, "y": 200, "params": {
        "system_type": "periodic", "software": "vasp",
        "ENCUT": 520, "EDIFF": "1e-6", "NSW": 0,
        "PREC": "Accurate", "ALGO": "Fast", "LREAL": False,
        "ISMEAR": -5, "SIGMA": 0.05,
        "LORBIT": 11, "LWAVE": False, "LCHARG": True,
        "kpoints": f"6{_X}6{_X}6",
        "label": "SCF Static",
    }},
    {"id": "n3", "type": "single_point", "x": 700, "y": 120, "params": {
        "system_type": "periodic", "software": "vasp",
        "ENCUT": 520, "EDIFF": "1e-6", "NSW": 0,
        "PREC": "Accurate", "ALGO": "Fast", "LREAL": False,
        "ISMEAR": -5, "SIGMA": 0.05,
        "LORBIT": 11, "LWAVE": False, "LCHARG": False,
        "ICHARG": 11,
        "mode": "uniform_band_structure",
        "kpoints_density": 200,
        "label": "Non-SCF (uniform)",
    }},
    {"id": "n4", "type": "single_point", "x": 700, "y": 300, "params": {
        "system_type": "periodic", "software": "vasp",
        "ENCUT": 520, "EDIFF": "1e-6", "NSW": 0,
        "PREC": "Accurate", "ALGO": "Fast", "LREAL": False,
        "ISMEAR": 0, "SIGMA": 0.05,
        "LORBIT": 11, "LWAVE": False, "LCHARG": False,
        "ICHARG": 11,
        "mode": "line_band_structure",
        "kpoints_density": 40,
        "label": "Non-SCF (line-mode)",
    }},
]
_BAND_STRUCTURE_EDGES = [
    {"id": "e1", "from": "n1", "to": "n2", "fromH": "out-0", "toH": "in-0"},
    {"id": "e2", "from": "n2", "to": "n3", "fromH": "out-0", "toH": "in-0"},
    {"id": "e3", "from": "n2", "to": "n4", "fromH": "out-0", "toH": "in-0"},
]

# ---------------------------------------------------------------------------
# 3. MLP Phonon
# ---------------------------------------------------------------------------

_MLP_PHONON_NODES = [
    {"id": "n1", "type": "structure_input", "x": 100, "y": 200, "params": {}},
    {"id": "n2", "type": "geo_opt", "x": 400, "y": 200, "params": {
        "system_type": "periodic", "software": "mlp",
        "model": "MACE", "fmax": 0.01,
        "label": "MLP Geometry Optimisation",
    }},
    {"id": "n3", "type": "loop", "x": 700, "y": 200, "params": {
        "variable": "displacement", "max_iter": 50,
    }},
    {"id": "n4", "type": "single_point", "x": 1000, "y": 140, "params": {
        "system_type": "periodic", "software": "mlp",
        "model": "MACE",
        "label": "MLP Displacement Static",
    }},
    {"id": "n5", "type": "merge", "x": 1300, "y": 200, "params": {}},
    {"id": "n6", "type": "analysis", "x": 1600, "y": 200, "params": {
        "type": "phonon",
        "label": "Phonon Analysis",
    }},
]
_MLP_PHONON_EDGES = [
    {"id": "e1", "from": "n1", "to": "n2", "fromH": "out-0", "toH": "in-0"},
    {"id": "e2", "from": "n2", "to": "n3", "fromH": "out-0", "toH": "in-0"},
    {"id": "e3", "from": "n3", "to": "n4", "fromH": "out-0", "toH": "in-0"},
    {"id": "e4", "from": "n4", "to": "n5", "fromH": "out-0", "toH": "in-0"},
    {"id": "e5", "from": "n3", "to": "n5", "fromH": "out-1", "toH": "in-1"},
    {"id": "e6", "from": "n5", "to": "n6", "fromH": "out-0", "toH": "in-0"},
]

# ---------------------------------------------------------------------------
# 4. MLP Elastic
# ---------------------------------------------------------------------------

_MLP_ELASTIC_NODES = [
    {"id": "n1", "type": "structure_input", "x": 100, "y": 200, "params": {}},
    {"id": "n2", "type": "geo_opt", "x": 400, "y": 200, "params": {
        "system_type": "periodic", "software": "mlp",
        "model": "MACE", "fmax": 0.01,
        "label": "MLP Geometry Optimisation",
    }},
    {"id": "n3", "type": "loop", "x": 700, "y": 200, "params": {
        "variable": "deformation", "max_iter": 24,
    }},
    {"id": "n4", "type": "single_point", "x": 1000, "y": 140, "params": {
        "system_type": "periodic", "software": "mlp",
        "model": "MACE",
        "label": "MLP Deformation Static",
    }},
    {"id": "n5", "type": "merge", "x": 1300, "y": 200, "params": {}},
    {"id": "n6", "type": "analysis", "x": 1600, "y": 200, "params": {
        "type": "elastic",
        "label": "Elastic Analysis",
    }},
]
_MLP_ELASTIC_EDGES = [
    {"id": "e1", "from": "n1", "to": "n2", "fromH": "out-0", "toH": "in-0"},
    {"id": "e2", "from": "n2", "to": "n3", "fromH": "out-0", "toH": "in-0"},
    {"id": "e3", "from": "n3", "to": "n4", "fromH": "out-0", "toH": "in-0"},
    {"id": "e4", "from": "n4", "to": "n5", "fromH": "out-0", "toH": "in-0"},
    {"id": "e5", "from": "n3", "to": "n5", "fromH": "out-1", "toH": "in-1"},
    {"id": "e6", "from": "n5", "to": "n6", "fromH": "out-0", "toH": "in-0"},
]

# ---------------------------------------------------------------------------
# 5. MLP Pre-screen + DFT Refinement
# ---------------------------------------------------------------------------

_MLP_DFT_NODES = [
    {"id": "n1", "type": "structure_input", "x": 100, "y": 200, "params": {}},
    {"id": "n2", "type": "geo_opt", "x": 400, "y": 200, "params": {
        "system_type": "periodic", "software": "mlp",
        "model": "MACE", "fmax": 0.02,
        "label": "MLP Pre-relaxation",
    }},
    {"id": "n3", "type": "single_point", "x": 700, "y": 200, "params": {
        "system_type": "periodic", "software": "vasp",
        "ENCUT": 520, "EDIFF": "1e-6", "NSW": 0,
        "PREC": "Accurate", "ALGO": "Fast", "LREAL": False,
        "ISMEAR": -5, "SIGMA": 0.05,
        "LORBIT": 11, "LWAVE": False, "LCHARG": True,
        "kpoints": f"4{_X}4{_X}4",
        "label": "VASP Single-Point Validation",
    }},
]
_MLP_DFT_EDGES = [
    {"id": "e1", "from": "n1", "to": "n2", "fromH": "out-0", "toH": "in-0"},
    {"id": "e2", "from": "n2", "to": "n3", "fromH": "out-0", "toH": "in-0"},
]

# ---------------------------------------------------------------------------
# 6. xTB Pre-opt + ORCA Refinement
# ---------------------------------------------------------------------------

_XTB_ORCA_NODES = [
    {"id": "n1", "type": "structure_input", "x": 100, "y": 200, "params": {}},
    {"id": "n2", "type": "geo_opt", "x": 400, "y": 200, "params": {
        "system_type": "molecular", "software": "xtb",
        "method": "GFN2-xTB", "fmax": 0.01,
        "accuracy": 1.0, "electronic_temperature": 300,
        "label": "xTB Pre-optimisation",
    }},
    {"id": "n3", "type": "single_point", "x": 700, "y": 200, "params": {
        "system_type": "molecular", "software": "orca",
        "method": "B3LYP", "basis": "def2-SVP",
        "charge": 0, "multiplicity": 1,
        "label": "ORCA Single-Point Refinement",
    }},
]
_XTB_ORCA_EDGES = [
    {"id": "e1", "from": "n1", "to": "n2", "fromH": "out-0", "toH": "in-0"},
    {"id": "e2", "from": "n2", "to": "n3", "fromH": "out-0", "toH": "in-0"},
]

# ---------------------------------------------------------------------------
# 7. QE Band Structure
# ---------------------------------------------------------------------------

_QE_BANDS_NODES = [
    {"id": "n1", "type": "structure_input", "x": 100, "y": 200, "params": {}},
    {"id": "n2", "type": "qe_scf", "x": 400, "y": 200, "params": {
        "software": "qe",
        "ecutwfc": 60, "ecutrho": 480,
        "kpoints": f"6{_X}6{_X}6",
        "label": "QE SCF Calculation",
    }},
    {"id": "n3", "type": "qe_bands", "x": 700, "y": 140, "params": {
        "software": "qe",
        "ecutwfc": 60, "ecutrho": 480,
        "kpoints_density": 40,
        "label": "QE Band Structure",
    }},
    {"id": "n4", "type": "qe_dos", "x": 700, "y": 280, "params": {
        "software": "qe",
        "ecutwfc": 60, "ecutrho": 480,
        "kpoints": f"12{_X}12{_X}12",
        "label": "QE Density of States",
    }},
]
_QE_BANDS_EDGES = [
    {"id": "e1", "from": "n1", "to": "n2", "fromH": "out-0", "toH": "in-0"},
    {"id": "e2", "from": "n2", "to": "n3", "fromH": "out-0", "toH": "in-0"},
    {"id": "e3", "from": "n2", "to": "n4", "fromH": "out-0", "toH": "in-0"},
]

# ---------------------------------------------------------------------------
# 8. QE Phonon
# ---------------------------------------------------------------------------

_QE_PHONON_NODES = [
    {"id": "n1", "type": "structure_input", "x": 100, "y": 200, "params": {}},
    {"id": "n2", "type": "qe_scf", "x": 400, "y": 200, "params": {
        "software": "qe",
        "ecutwfc": 60, "ecutrho": 480,
        "kpoints": f"6{_X}6{_X}6",
        "label": "QE SCF Calculation",
    }},
    {"id": "n3", "type": "qe_phonon", "x": 700, "y": 200, "params": {
        "software": "qe",
        "ecutwfc": 60, "ecutrho": 480,
        "label": "QE Phonon (DFPT)",
    }},
    {"id": "n4", "type": "analysis", "x": 1000, "y": 200, "params": {
        "type": "phonon",
        "label": "Phonon Analysis",
    }},
]
_QE_PHONON_EDGES = [
    {"id": "e1", "from": "n1", "to": "n2", "fromH": "out-0", "toH": "in-0"},
    {"id": "e2", "from": "n2", "to": "n3", "fromH": "out-0", "toH": "in-0"},
    {"id": "e3", "from": "n3", "to": "n4", "fromH": "out-0", "toH": "in-0"},
]


# ---------------------------------------------------------------------------
# Template registry
# ---------------------------------------------------------------------------

QUACC_TEMPLATES: list[dict[str, Any]] = [
    {
        "id": "quacc-slab-relax",
        "name": "Slab Relaxation (quacc)",
        "description": (
            "Slab relaxation workflow: generate slab from bulk structure, "
            "relax with VASP, then run a single-point calculation. "
            "Based on quacc.recipes.vasp.slabs patterns."
        ),
        "category": "quacc",
        "tags": ["vasp", "surface", "slab"],
        "graph_json": _graph(_SLAB_RELAX_NODES, _SLAB_RELAX_EDGES),
    },
    {
        "id": "quacc-band-structure",
        "name": "Band Structure (quacc)",
        "description": (
            "VASP band structure workflow: SCF static, followed by non-SCF "
            "calculations on uniform and line-mode k-point grids. "
            "Based on quacc.recipes.vasp.core patterns."
        ),
        "category": "quacc",
        "tags": ["vasp", "electronic", "bands"],
        "graph_json": _graph(_BAND_STRUCTURE_NODES, _BAND_STRUCTURE_EDGES),
    },
    {
        "id": "quacc-mlp-phonon",
        "name": "MLP Phonon (quacc)",
        "description": (
            "Phonon calculation using ML potentials: relax with MACE, "
            "generate displacement supercells, compute forces, and "
            "analyse phonon properties. Based on quacc.recipes.mlp patterns."
        ),
        "category": "quacc",
        "tags": ["mlp", "phonon", "mace"],
        "graph_json": _graph(_MLP_PHONON_NODES, _MLP_PHONON_EDGES),
    },
    {
        "id": "quacc-mlp-elastic",
        "name": "MLP Elastic (quacc)",
        "description": (
            "Elastic tensor calculation using ML potentials: relax with MACE, "
            "apply deformation strains, compute stresses, and fit the elastic "
            "tensor. Based on quacc.recipes.mlp patterns."
        ),
        "category": "quacc",
        "tags": ["mlp", "elastic", "mace"],
        "graph_json": _graph(_MLP_ELASTIC_NODES, _MLP_ELASTIC_EDGES),
    },
    {
        "id": "quacc-mlp-dft-refine",
        "name": "MLP Pre-screen + DFT Refinement (quacc)",
        "description": (
            "Multi-fidelity workflow: fast MLP pre-relaxation with MACE, "
            "followed by a VASP single-point calculation for DFT-level "
            "validation. Common quacc multi-code pattern."
        ),
        "category": "quacc",
        "tags": ["mlp", "vasp", "multi-fidelity"],
        "graph_json": _graph(_MLP_DFT_NODES, _MLP_DFT_EDGES),
    },
    {
        "id": "quacc-xtb-orca",
        "name": "xTB Pre-opt + ORCA Refinement (quacc)",
        "description": (
            "Molecular multi-fidelity workflow: fast xTB geometry optimisation "
            "followed by ORCA single-point refinement for higher accuracy. "
            "Based on quacc.recipes.tblite + quacc.recipes.orca patterns."
        ),
        "category": "quacc",
        "tags": ["xtb", "orca", "molecular", "multi-fidelity"],
        "graph_json": _graph(_XTB_ORCA_NODES, _XTB_ORCA_EDGES),
    },
    {
        "id": "quacc-qe-bands",
        "name": "QE Band Structure (quacc)",
        "description": (
            "Quantum ESPRESSO band structure workflow: SCF calculation, "
            "followed by band structure and density of states calculations. "
            "Based on quacc.recipes.espresso patterns."
        ),
        "category": "quacc",
        "tags": ["qe", "electronic", "bands", "dos"],
        "graph_json": _graph(_QE_BANDS_NODES, _QE_BANDS_EDGES),
    },
    {
        "id": "quacc-qe-phonon",
        "name": "QE Phonon (quacc)",
        "description": (
            "Quantum ESPRESSO phonon workflow: SCF calculation, followed by "
            "DFPT phonon calculation (ph.x) and phonon analysis. "
            "Based on quacc.recipes.espresso.phonons patterns."
        ),
        "category": "quacc",
        "tags": ["qe", "phonon", "dfpt"],
        "graph_json": _graph(_QE_PHONON_NODES, _QE_PHONON_EDGES),
    },
]


# ---------------------------------------------------------------------------
# Lookup helpers
# ---------------------------------------------------------------------------

def get_template(template_id: str) -> dict[str, Any] | None:
    """Look up a template by ID."""
    for t in QUACC_TEMPLATES:
        if t["id"] == template_id:
            return t
    return None


def list_templates() -> list[dict[str, Any]]:
    """Return all templates (without graph_json for listing)."""
    return [
        {k: v for k, v in t.items() if k != "graph_json"}
        for t in QUACC_TEMPLATES
    ]


# ---------------------------------------------------------------------------
# Self-test
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    print(f"{len(QUACC_TEMPLATES)} templates")
    for t in QUACC_TEMPLATES:
        graph = json.loads(t["graph_json"])
        n_nodes = len(graph["nodes"])
        n_edges = len(graph["edges"])
        print(f"  {t['id']}: {t['name']} ({n_nodes} nodes, {n_edges} edges)")

        # Validate edge references
        node_ids = {n["id"] for n in graph["nodes"]}
        for edge in graph["edges"]:
            assert edge["from"] in node_ids, f"Edge {edge['id']} references unknown source {edge['from']}"
            assert edge["to"] in node_ids, f"Edge {edge['id']} references unknown target {edge['to']}"

    print("All template validation passed.")

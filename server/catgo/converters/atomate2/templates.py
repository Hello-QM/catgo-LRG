"""Pre-built atomate2 workflow templates as static CatGo graph JSON.

These templates require no atomate2 installation. They are pure JSON
representations of common atomate2 flows, ready for one-click import
into CatGo's workflow editor.
"""

from __future__ import annotations

import json

__all__ = ["ATOMATE2_TEMPLATES"]

# Multiplication sign used in k-point grid strings
_X = "\u00d7"


def _make_graph(nodes: list[dict], edges: list[dict]) -> str:
    """Serialize nodes/edges to a JSON string."""
    return json.dumps({"nodes": nodes, "edges": edges})


# ---------------------------------------------------------------------------
# Common VASP parameter sets used across templates
# ---------------------------------------------------------------------------

def _vasp_relax_params(
    *,
    ediff: str = "1e-5",
    ediffg: float = -0.02,
    isif: int = 3,
    nsw: int = 200,
    ibrion: int = 2,
    kpoints: str = f"4{_X}4{_X}4",
) -> dict:
    """Standard VASP relaxation parameters (atomate2 defaults)."""
    return {
        "system_type": "periodic", "software": "vasp",
        "ENCUT": 520, "EDIFF": ediff, "EDIFFG": ediffg,
        "ISIF": isif, "NSW": nsw, "IBRION": ibrion,
        "PREC": "Accurate", "ALGO": "Fast", "LREAL": "Auto",
        "ISMEAR": 0, "SIGMA": 0.05,
        "LORBIT": 11, "LWAVE": False, "LCHARG": False,
        "kpoints": kpoints,
    }


def _vasp_static_params(
    *,
    ediff: str = "1e-6",
    kpoints: str = f"6{_X}6{_X}6",
    lcharg: bool = True,
    lwave: bool = False,
) -> dict:
    """Standard VASP static/single-point parameters."""
    return {
        "system_type": "periodic", "software": "vasp",
        "ENCUT": 520, "EDIFF": ediff, "NSW": 0,
        "PREC": "Accurate", "ALGO": "Fast", "LREAL": False,
        "ISMEAR": -5, "SIGMA": 0.05,
        "LORBIT": 11, "LWAVE": lwave, "LCHARG": lcharg,
        "kpoints": kpoints,
    }


# ---------------------------------------------------------------------------
# 1. Double Relaxation
# ---------------------------------------------------------------------------

_double_relax_nodes = [
    {"id": "n1", "type": "structure_input", "x": 80, "y": 200, "params": {}},
    {"id": "n2", "type": "geo_opt", "x": 380, "y": 200, "params": {
        **_vasp_relax_params(ediff="1e-5", ediffg=-0.05, kpoints=f"4{_X}4{_X}4"),
        "label": "Relax 1 (coarse)",
    }},
    {"id": "n3", "type": "geo_opt", "x": 680, "y": 200, "params": {
        **_vasp_relax_params(ediff="1e-6", ediffg=-0.02, kpoints=f"4{_X}4{_X}4"),
        "label": "Relax 2 (tight)",
    }},
]
_double_relax_edges = [
    {"id": "e1", "from": "n1", "to": "n2", "fromH": "out-0", "toH": "in-0"},
    {"id": "e2", "from": "n2", "to": "n3", "fromH": "out-0", "toH": "in-0"},
]

# ---------------------------------------------------------------------------
# 2. Band Structure
# ---------------------------------------------------------------------------

_band_structure_nodes = [
    {"id": "n1", "type": "structure_input", "x": 80, "y": 200, "params": {}},
    {"id": "n2", "type": "single_point", "x": 380, "y": 200, "params": {
        **_vasp_static_params(lcharg=True),
        "label": "SCF Static",
    }},
    {"id": "n3", "type": "single_point", "x": 680, "y": 120, "params": {
        **_vasp_static_params(lcharg=False),
        "ICHARG": 11, "LWAVE": False,
        "mode": "uniform_band_structure",
        "kpoints_density": 200,
        "label": "Non-SCF (uniform)",
    }},
    {"id": "n4", "type": "single_point", "x": 680, "y": 300, "params": {
        **_vasp_static_params(lcharg=False),
        "ICHARG": 11, "ISMEAR": 0, "LWAVE": False,
        "mode": "line_band_structure",
        "kpoints_density": 40,
        "label": "Non-SCF (line-mode)",
    }},
]
_band_structure_edges = [
    {"id": "e1", "from": "n1", "to": "n2", "fromH": "out-0", "toH": "in-0"},
    {"id": "e2", "from": "n2", "to": "n3", "fromH": "out-0", "toH": "in-0"},
    {"id": "e3", "from": "n2", "to": "n4", "fromH": "out-0", "toH": "in-0"},
]

# ---------------------------------------------------------------------------
# 3. HSE Band Structure
# ---------------------------------------------------------------------------

_hse_common = {"functional": "HSE06", "LHFCALC": True, "AEXX": 0.25, "HFSCREEN": 0.2}

_hse_band_nodes = [
    {"id": "n1", "type": "structure_input", "x": 80, "y": 200, "params": {}},
    {"id": "n2", "type": "single_point", "x": 380, "y": 200, "params": {
        **_vasp_static_params(lcharg=True),
        "label": "PBE Static",
    }},
    {"id": "n3", "type": "single_point", "x": 680, "y": 200, "params": {
        **_vasp_static_params(lcharg=True, lwave=True),
        **_hse_common,
        "ALGO": "All",
        "label": "HSE Static",
    }},
    {"id": "n4", "type": "single_point", "x": 980, "y": 120, "params": {
        **_vasp_static_params(lcharg=False),
        **_hse_common,
        "ICHARG": 11, "ALGO": "All",
        "mode": "uniform_band_structure",
        "kpoints_density": 200,
        "label": "HSE Non-SCF (uniform)",
    }},
    {"id": "n5", "type": "single_point", "x": 980, "y": 300, "params": {
        **_vasp_static_params(lcharg=False),
        **_hse_common,
        "ICHARG": 11, "ISMEAR": 0, "ALGO": "All",
        "mode": "line_band_structure",
        "kpoints_density": 40,
        "label": "HSE Non-SCF (line-mode)",
    }},
]
_hse_band_edges = [
    {"id": "e1", "from": "n1", "to": "n2", "fromH": "out-0", "toH": "in-0"},
    {"id": "e2", "from": "n2", "to": "n3", "fromH": "out-0", "toH": "in-0"},
    {"id": "e3", "from": "n3", "to": "n4", "fromH": "out-0", "toH": "in-0"},
    {"id": "e4", "from": "n3", "to": "n5", "fromH": "out-0", "toH": "in-0"},
]

# ---------------------------------------------------------------------------
# 4. Elastic Constants
# ---------------------------------------------------------------------------

_elastic_nodes = [
    {"id": "n1", "type": "structure_input", "x": 80, "y": 300, "params": {}},
    {"id": "n2", "type": "geo_opt", "x": 380, "y": 300, "params": {
        **_vasp_relax_params(ediffg=-0.02, kpoints=f"6{_X}6{_X}6"),
        "label": "Relaxation",
    }},
]
# 6 deformation single points in parallel
for i in range(6):
    _elastic_nodes.append({
        "id": f"n{3 + i}", "type": "single_point",
        "x": 680, "y": 60 + i * 100,
        "params": {
            **_vasp_static_params(kpoints=f"6{_X}6{_X}6"),
            "ISIF": 2,
            "label": f"Deformation {i + 1}",
        },
    })
_elastic_nodes.append({
    "id": "n9", "type": "analysis", "x": 980, "y": 300, "params": {
        "type": "elastic", "label": "Elastic Analysis",
    },
})
_elastic_edges = [
    {"id": "e1", "from": "n1", "to": "n2", "fromH": "out-0", "toH": "in-0"},
]
for i in range(6):
    _elastic_edges.append({
        "id": f"e{2 + i}", "from": "n2", "to": f"n{3 + i}",
        "fromH": "out-0", "toH": "in-0",
    })
    _elastic_edges.append({
        "id": f"e{8 + i}", "from": f"n{3 + i}", "to": "n9",
        "fromH": "out-0", "toH": "in-0",
    })

# ---------------------------------------------------------------------------
# 5. Phonon
# ---------------------------------------------------------------------------

_phonon_nodes = [
    {"id": "n1", "type": "structure_input", "x": 80, "y": 200, "params": {}},
    {"id": "n2", "type": "geo_opt", "x": 380, "y": 200, "params": {
        **_vasp_relax_params(ediff="1e-6", ediffg=-0.01, kpoints=f"6{_X}6{_X}6"),
        "label": "Relaxation",
    }},
    {"id": "n3", "type": "loop", "x": 680, "y": 200, "params": {
        "variable": "displacement", "max_iter": 50,
        "label": "Displacement Loop",
    }},
    {"id": "n4", "type": "single_point", "x": 980, "y": 140, "params": {
        **_vasp_static_params(ediff="1e-7", kpoints=f"4{_X}4{_X}4"),
        "IBRION": -1,
        "label": "Displacement Static",
    }},
    {"id": "n5", "type": "merge", "x": 1280, "y": 200, "params": {}},
    {"id": "n6", "type": "analysis", "x": 1580, "y": 200, "params": {
        "type": "phonon", "label": "Phonon Analysis",
    }},
]
_phonon_edges = [
    {"id": "e1", "from": "n1", "to": "n2", "fromH": "out-0", "toH": "in-0"},
    {"id": "e2", "from": "n2", "to": "n3", "fromH": "out-0", "toH": "in-0"},
    {"id": "e3", "from": "n3", "to": "n4", "fromH": "out-0", "toH": "in-0"},
    {"id": "e4", "from": "n4", "to": "n5", "fromH": "out-0", "toH": "in-0"},
    {"id": "e5", "from": "n3", "to": "n5", "fromH": "out-1", "toH": "in-1"},
    {"id": "e6", "from": "n5", "to": "n6", "fromH": "out-0", "toH": "in-0"},
]

# ---------------------------------------------------------------------------
# 6. EOS (Equation of State)
# ---------------------------------------------------------------------------

_eos_nodes = [
    {"id": "n1", "type": "structure_input", "x": 80, "y": 350, "params": {}},
    {"id": "n2", "type": "geo_opt", "x": 380, "y": 350, "params": {
        **_vasp_relax_params(ediffg=-0.02, kpoints=f"6{_X}6{_X}6"),
        "label": "Relaxation",
    }},
]
# 7 volume-scaled single points in parallel
_eos_scales = [0.94, 0.96, 0.98, 1.00, 1.02, 1.04, 1.06]
for i, scale in enumerate(_eos_scales):
    _eos_nodes.append({
        "id": f"n{3 + i}", "type": "single_point",
        "x": 680, "y": 50 + i * 100,
        "params": {
            **_vasp_static_params(kpoints=f"6{_X}6{_X}6"),
            "IBRION": -1,
            "label": f"V/V0 = {scale:.2f}",
        },
    })
_eos_nodes.append({
    "id": "n10", "type": "analysis", "x": 980, "y": 350, "params": {
        "type": "eos", "label": "EOS Analysis",
    },
})
_eos_edges = [
    {"id": "e1", "from": "n1", "to": "n2", "fromH": "out-0", "toH": "in-0"},
]
for i in range(7):
    _eos_edges.append({
        "id": f"e{2 + i}", "from": "n2", "to": f"n{3 + i}",
        "fromH": "out-0", "toH": "in-0",
    })
    _eos_edges.append({
        "id": f"e{9 + i}", "from": f"n{3 + i}", "to": "n10",
        "fromH": "out-0", "toH": "in-0",
    })

# ---------------------------------------------------------------------------
# 7. Dielectric
# ---------------------------------------------------------------------------

_dielectric_nodes = [
    {"id": "n1", "type": "structure_input", "x": 80, "y": 200, "params": {}},
    {"id": "n2", "type": "geo_opt", "x": 380, "y": 200, "params": {
        **_vasp_relax_params(ediffg=-0.02, kpoints=f"6{_X}6{_X}6"),
        "label": "Relaxation",
    }},
    {"id": "n3", "type": "single_point", "x": 680, "y": 200, "params": {
        **_vasp_static_params(kpoints=f"6{_X}6{_X}6"),
        "LEPSILON": True, "LPEAD": True, "IBRION": 8,
        "label": "DFPT Dielectric",
    }},
]
_dielectric_edges = [
    {"id": "e1", "from": "n1", "to": "n2", "fromH": "out-0", "toH": "in-0"},
    {"id": "e2", "from": "n2", "to": "n3", "fromH": "out-0", "toH": "in-0"},
]

# ---------------------------------------------------------------------------
# 8. Optics
# ---------------------------------------------------------------------------

_optics_nodes = [
    {"id": "n1", "type": "structure_input", "x": 80, "y": 200, "params": {}},
    {"id": "n2", "type": "geo_opt", "x": 380, "y": 200, "params": {
        **_vasp_relax_params(ediffg=-0.02, kpoints=f"6{_X}6{_X}6"),
        "label": "Relaxation",
    }},
    {"id": "n3", "type": "single_point", "x": 680, "y": 200, "params": {
        **_vasp_static_params(lcharg=True, kpoints=f"6{_X}6{_X}6"),
        "label": "SCF Static",
    }},
    {"id": "n4", "type": "single_point", "x": 980, "y": 200, "params": {
        **_vasp_static_params(kpoints=f"6{_X}6{_X}6"),
        "LOPTICS": True, "CSHIFT": 0.1, "NBANDS": 128,
        "label": "Optics",
    }},
]
_optics_edges = [
    {"id": "e1", "from": "n1", "to": "n2", "fromH": "out-0", "toH": "in-0"},
    {"id": "e2", "from": "n2", "to": "n3", "fromH": "out-0", "toH": "in-0"},
    {"id": "e3", "from": "n3", "to": "n4", "fromH": "out-0", "toH": "in-0"},
]

# ---------------------------------------------------------------------------
# 9. MLP Relax + VASP Refinement
# ---------------------------------------------------------------------------

_mlp_vasp_nodes = [
    {"id": "n1", "type": "structure_input", "x": 80, "y": 200, "params": {}},
    {"id": "n2", "type": "geo_opt", "x": 380, "y": 200, "params": {
        "system_type": "periodic", "software": "mlp",
        "model": "MACE", "fmax": 0.02,
        "label": "MLP Relaxation",
    }},
    {"id": "n3", "type": "single_point", "x": 680, "y": 200, "params": {
        **_vasp_static_params(kpoints=f"4{_X}4{_X}4"),
        "label": "VASP Static",
    }},
]
_mlp_vasp_edges = [
    {"id": "e1", "from": "n1", "to": "n2", "fromH": "out-0", "toH": "in-0"},
    {"id": "e2", "from": "n2", "to": "n3", "fromH": "out-0", "toH": "in-0"},
]

# ---------------------------------------------------------------------------
# 10. MLP Phonon
# ---------------------------------------------------------------------------

_mlp_phonon_nodes = [
    {"id": "n1", "type": "structure_input", "x": 80, "y": 200, "params": {}},
    {"id": "n2", "type": "geo_opt", "x": 380, "y": 200, "params": {
        "system_type": "periodic", "software": "mlp",
        "model": "MACE", "fmax": 0.01,
        "label": "MLP Relaxation",
    }},
    {"id": "n3", "type": "loop", "x": 680, "y": 200, "params": {
        "variable": "displacement", "max_iter": 50,
        "label": "Displacement Loop",
    }},
    {"id": "n4", "type": "single_point", "x": 980, "y": 140, "params": {
        "system_type": "periodic", "software": "mlp",
        "model": "MACE",
        "label": "MLP Displacement Static",
    }},
    {"id": "n5", "type": "merge", "x": 1280, "y": 200, "params": {}},
    {"id": "n6", "type": "analysis", "x": 1580, "y": 200, "params": {
        "type": "phonon", "label": "Phonon Analysis",
    }},
]
_mlp_phonon_edges = [
    {"id": "e1", "from": "n1", "to": "n2", "fromH": "out-0", "toH": "in-0"},
    {"id": "e2", "from": "n2", "to": "n3", "fromH": "out-0", "toH": "in-0"},
    {"id": "e3", "from": "n3", "to": "n4", "fromH": "out-0", "toH": "in-0"},
    {"id": "e4", "from": "n4", "to": "n5", "fromH": "out-0", "toH": "in-0"},
    {"id": "e5", "from": "n3", "to": "n5", "fromH": "out-1", "toH": "in-1"},
    {"id": "e6", "from": "n5", "to": "n6", "fromH": "out-0", "toH": "in-0"},
]


# ---------------------------------------------------------------------------
# Template collection
# ---------------------------------------------------------------------------

ATOMATE2_TEMPLATES: list[dict] = [
    {
        "id": "atomate2-double-relax",
        "name": "Double Relaxation (atomate2)",
        "description": (
            "Two-stage VASP relaxation: coarse then tight. "
            "Standard atomate2 DoubleRelaxMaker pattern."
        ),
        "category": "atomate2",
        "tags": ["vasp", "relaxation"],
        "graph_json": _make_graph(_double_relax_nodes, _double_relax_edges),
    },
    {
        "id": "atomate2-band-structure",
        "name": "Band Structure (atomate2)",
        "description": (
            "PBE SCF static followed by uniform and line-mode non-SCF "
            "calculations for DOS and band structure."
        ),
        "category": "atomate2",
        "tags": ["vasp", "electronic", "band_structure"],
        "graph_json": _make_graph(_band_structure_nodes, _band_structure_edges),
    },
    {
        "id": "atomate2-hse-band-structure",
        "name": "HSE Band Structure (atomate2)",
        "description": (
            "HSE06 hybrid functional band structure: PBE static, HSE static, "
            "then HSE uniform and line-mode non-SCF."
        ),
        "category": "atomate2",
        "tags": ["vasp", "electronic", "band_structure", "hse"],
        "graph_json": _make_graph(_hse_band_nodes, _hse_band_edges),
    },
    {
        "id": "atomate2-elastic",
        "name": "Elastic Constants (atomate2)",
        "description": (
            "Elastic tensor calculation: relaxation followed by 6 independent "
            "deformation single-point calculations in parallel."
        ),
        "category": "atomate2",
        "tags": ["vasp", "mechanical", "elastic"],
        "graph_json": _make_graph(_elastic_nodes, _elastic_edges),
    },
    {
        "id": "atomate2-phonon",
        "name": "Phonon (atomate2)",
        "description": (
            "Phonon band structure and DOS via finite displacements: "
            "relaxation, displacement statics, and phonopy analysis."
        ),
        "category": "atomate2",
        "tags": ["vasp", "phonon", "vibrational"],
        "graph_json": _make_graph(_phonon_nodes, _phonon_edges),
    },
    {
        "id": "atomate2-eos",
        "name": "Equation of State (atomate2)",
        "description": (
            "EOS calculation: relaxation followed by 7 volume-scaled "
            "single-point calculations and Birch-Murnaghan fitting."
        ),
        "category": "atomate2",
        "tags": ["vasp", "eos", "thermodynamics"],
        "graph_json": _make_graph(_eos_nodes, _eos_edges),
    },
    {
        "id": "atomate2-dielectric",
        "name": "Dielectric (atomate2)",
        "description": (
            "DFPT dielectric constant calculation: relaxation followed by "
            "LEPSILON static for Born effective charges and dielectric tensor."
        ),
        "category": "atomate2",
        "tags": ["vasp", "dielectric", "dfpt"],
        "graph_json": _make_graph(_dielectric_nodes, _dielectric_edges),
    },
    {
        "id": "atomate2-optics",
        "name": "Optics (atomate2)",
        "description": (
            "Optical properties: relaxation, SCF static, then LOPTICS "
            "calculation for frequency-dependent dielectric function."
        ),
        "category": "atomate2",
        "tags": ["vasp", "optics", "dielectric"],
        "graph_json": _make_graph(_optics_nodes, _optics_edges),
    },
    {
        "id": "atomate2-mlp-vasp-refinement",
        "name": "MLP Relax + VASP Refinement (atomate2)",
        "description": (
            "Cross-engine workflow: fast MLP relaxation (MACE) followed by "
            "VASP single-point for accurate energy and electronic properties."
        ),
        "category": "atomate2",
        "tags": ["mlp", "vasp", "multi-fidelity"],
        "graph_json": _make_graph(_mlp_vasp_nodes, _mlp_vasp_edges),
    },
    {
        "id": "atomate2-mlp-phonon",
        "name": "MLP Phonon (atomate2)",
        "description": (
            "Machine-learning potential phonon calculation: MLP relaxation, "
            "MLP displacement statics, and phonopy post-processing."
        ),
        "category": "atomate2",
        "tags": ["mlp", "phonon", "vibrational"],
        "graph_json": _make_graph(_mlp_phonon_nodes, _mlp_phonon_edges),
    },
]

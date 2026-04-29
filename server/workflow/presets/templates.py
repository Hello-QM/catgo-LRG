"""Built-in workflow templates — seeded into the DB on first startup.

Each template is a complete workflow graph (nodes + edges) with sensible
defaults for common computational chemistry pipelines.

Call ``seed_builtin_templates()`` from the server lifespan to ensure
they exist in the DB.  Existing templates are NOT overwritten (users
may have customised them).
"""

import json
import logging
from catgo.utils.workflow_db import upsert_template, list_templates
from catgo.models.workflow import WorkflowTemplate

logger = logging.getLogger(__name__)


def _electrochemical_slow_growth_graph() -> str:
    """Build graph JSON for: structure_input → geo_opt → md → slow_growth."""
    nodes = [
        {
            "id": "n1",
            "type": "structure_input",
            "position": {"x": 100, "y": 200},
            "data": {"label": "Structure Input"},
            "params": {},
        },
        {
            "id": "n2",
            "type": "geo_opt",
            "position": {"x": 350, "y": 200},
            "data": {"label": "Geometry Optimization"},
            "params": {
                "system_type": "periodic",
                "software": "vasp",
                "ENCUT": 400,
                "EDIFF": "1e-5",
                "EDIFFG": "-0.03",
                "ISIF": 2,
                "NSW": 200,
                "LDIPOL": True,
                "frozen_layers": 2,
            },
        },
        {
            "id": "n3",
            "type": "md",
            "position": {"x": 600, "y": 200},
            "data": {"label": "AIMD Equilibration"},
            "params": {
                "system_type": "periodic",
                "software": "vasp",
                "ENCUT": 400,
                "EDIFF": "1e-4",
                "TEBEG": 300,
                "NSW": 5000,
                "POTIM": 1.0,
                "SMASS": 0,
                "constant_potential": "none",
                "LDIPOL": True,
                "frozen_layers": 2,
            },
        },
        {
            "id": "n4",
            "type": "slow_growth",
            "position": {"x": 850, "y": 200},
            "data": {"label": "Slow-Growth TI"},
            "params": {
                "system_type": "periodic",
                "software": "vasp",
                "ENCUT": 400,
                "EDIFF": "1e-4",
                "TEBEG": 300,
                "NSW": 10000,
                "POTIM": 1.0,
                "SMASS": 0,
                "lblueout": True,
                "increm": "-0.005",
                "iconst_content": "",
                "constant_potential": "none",
                "LDIPOL": True,
                "frozen_layers": 2,
            },
        },
    ]
    edges = [
        {"id": "e1", "source": "n1", "target": "n2"},
        {"id": "e2", "source": "n2", "target": "n3"},
        {"id": "e3", "source": "n3", "target": "n4"},
    ]
    return json.dumps({"nodes": nodes, "edges": edges})


def _no3rr_cu111_dft_graph() -> str:
    """Build graph JSON for NO₃RR on Cu(111) DFT workflow.

    Fan-out pipeline — 10 NO₃RR intermediates in parallel:
        structure_input → slab_gen ─┬─ adsorbate(NO₃)  → geo_opt
                                    ├─ adsorbate(NO₂)  → geo_opt
                                    ├─ adsorbate(NO)   → geo_opt
                                    ├─ adsorbate(NOH)  → geo_opt
                                    ├─ adsorbate(NHOH) → geo_opt
                                    ├─ adsorbate(HNO)  → geo_opt
                                    ├─ adsorbate(N)    → geo_opt
                                    ├─ adsorbate(NH)   → geo_opt
                                    ├─ adsorbate(NH₂)  → geo_opt
                                    └─ adsorbate(NH₃)  → geo_opt
    """
    _GEO_OPT_PARAMS = {
        "system_type": "periodic",
        "software": "vasp",
        "ENCUT": 450,
        "EDIFF": "1e-5",
        "EDIFFG": "-0.02",
        "ISIF": 2,
        "NSW": 300,
        "ISMEAR": 1,
        "ISPIN": 2,
        "PREC": "Accurate",
        "LDIPOL": True,
        "frozen_layers": 2,
        "kpoints": "3×3×1",
        "LWAVE": False,
        "LCHARG": False,
    }

    intermediates = [
        ("NO3", "NO₃"),
        ("NO2", "NO₂"),
        ("NO", "NO"),
        ("NOH", "NOH"),
        ("NHOH", "NHOH"),
        ("HNO", "HNO"),
        ("N", "N"),
        ("NH", "NH"),
        ("NH2", "NH₂"),
        ("NH3", "NH₃"),
    ]

    nodes = [
        {
            "id": "n1",
            "type": "structure_input",
            "position": {"x": 60, "y": 320},
            "data": {"label": "Bulk Cu (fcc)"},
            "params": {},
        },
        {
            "id": "n2",
            "type": "slab_gen",
            "position": {"x": 280, "y": 320},
            "data": {"label": "Cu(111) p(3×3) Slab"},
            "params": {
                "miller": "1,1,1",
                "layers": 4,
                "vacuum": 15.0,
                "supercell": "3×3",
                "center_slab": True,
                "primitive": True,
            },
        },
    ]

    edges = [{"id": "e1", "source": "n1", "target": "n2"}]

    for i, (species, label) in enumerate(intermediates):
        y = 20 + i * 70
        aid = f"a{i + 1}"
        gid = f"g{i + 1}"
        nodes.append({
            "id": aid,
            "type": "adsorbate_place",
            "position": {"x": 540, "y": y},
            "data": {"label": f"*{label}"},
            "params": {"species": species, "site": "all", "height": 2.0},
        })
        nodes.append({
            "id": gid,
            "type": "geo_opt",
            "position": {"x": 800, "y": y},
            "data": {"label": f"Opt *{label}"},
            "params": dict(_GEO_OPT_PARAMS),
        })
        edges.append({"id": f"e{2 + i}", "source": "n2", "target": aid})
        edges.append({"id": f"e{12 + i}", "source": aid, "target": gid})

    return json.dumps({"nodes": nodes, "edges": edges})



BUILTIN_TEMPLATES = [
    WorkflowTemplate(
        id="electrochemical-slow-growth",
        name="Electrochemical Slow-Growth",
        description=(
            "Thermodynamic integration pipeline for electrochemical reactions: "
            "structure input → geometry optimization → AIMD equilibration → "
            "slow-growth constrained MD. Edit ICONST and constant-potential "
            "settings in the slow-growth node before running."
        ),
        category="Electrochemistry",
        graph_json=_electrochemical_slow_growth_graph(),
    ),
    WorkflowTemplate(
        id="no3rr-cu111-dft",
        name="NO₃RR on Cu(111) — DFT Baseline",
        description=(
            "DFT baseline workflow for NO₃RR on Cu(111): "
            "bulk Cu → slab generation (Cu(111) p(3×3), 4 layers, 15 Å vacuum) "
            "→ 10 parallel branches for all NO₃RR intermediates "
            "(NO₃, NO₂, NO, NOH, NHOH, HNO, N, NH, NH₂, NH₃) "
            "→ geometry optimization for each."
        ),
        category="Catalysis",
        graph_json=_no3rr_cu111_dft_graph(),
    ),
]


def seed_builtin_templates():
    """Insert built-in templates that don't already exist in the DB.

    Safe to call on every startup — existing templates are not overwritten.
    """
    existing_ids = {t.id for t in list_templates()}
    seeded = 0
    for template in BUILTIN_TEMPLATES:
        if template.id not in existing_ids:
            upsert_template(template)
            seeded += 1
            logger.info("Seeded workflow template: %s", template.name)
    if seeded:
        logger.info("Seeded %d built-in workflow template(s)", seeded)

"""VASP calculation presets — context-aware sub-presets per calculation type.

Each calculation type (geo_opt, single_point, freq, …) has its own set of
sub-presets that represent different *parameter styles* within that type.

Frontend NodeConfigPanel fetches from:
  GET /api/workflow/vasp-presets/{calc_type}          → list sub-presets
  GET /api/workflow/vasp-presets/{calc_type}/{name}   → get one sub-preset

Legacy flat endpoint still works for backward compat:
  GET /api/workflow/vasp-presets/{name}               → flat lookup
"""

# ══════════════════════════════════════════════════════════════════════
# Base parameter sets (building blocks, not exposed directly)
# ══════════════════════════════════════════════════════════════════════

_BASE = {
    "ALGO": "Normal",
    "EDIFF": 1e-5,
    "ENCUT": 520,
    "ISMEAR": 0,
    "SIGMA": 0.05,
    "PREC": "Accurate",
    "LREAL": "Auto",
    "LORBIT": 11,
    "LWAVE": False,
    "LCHARG": False,
    "NCORE": 4,
}

# ══════════════════════════════════════════════════════════════════════
# Per-calc-type sub-presets
# ══════════════════════════════════════════════════════════════════════

# ── geo_opt ──────────────────────────────────────────────────────────
GEO_OPT_PRESETS = {
    "slab": {
        "label": "Slab (ISIF=2, ions only)",
        "params": {
            **_BASE,
            "IBRION": 2, "ISIF": 2, "NSW": 200, "EDIFFG": -0.02,
        },
    },
    "slab_d3": {
        "label": "Slab + D3(BJ) + Dipole",
        "params": {
            **_BASE,
            "IBRION": 2, "ISIF": 2, "NSW": 200, "EDIFFG": -0.03,
            "IVDW": 12, "LDIPOL": True, "IDIPOL": 3,
        },
    },
    "bulk": {
        "label": "Bulk (ISIF=3, full cell)",
        "params": {
            **_BASE,
            "IBRION": 2, "ISIF": 3, "NSW": 200, "EDIFFG": -0.02,
        },
    },
    "quick": {
        "label": "Quick (low precision)",
        "params": {
            **_BASE,
            "IBRION": 2, "ISIF": 2, "NSW": 100, "EDIFFG": -0.05,
            "PREC": "Normal", "ENCUT": 400, "EDIFF": 1e-4,
        },
    },
}

# ── single_point ─────────────────────────────────────────────────────
SINGLE_POINT_PRESETS = {
    "standard": {
        "label": "Standard",
        "params": {
            **_BASE,
            "NSW": 0, "IBRION": -1, "ISIF": 2,
            "EDIFF": 1e-6, "ISMEAR": -5,
            "LWAVE": True, "LCHARG": True,
        },
    },
    "dos": {
        "label": "DOS (tetrahedron, LORBIT=11)",
        "params": {
            **_BASE,
            "NSW": 0, "IBRION": -1, "ISIF": 2,
            "EDIFF": 1e-6, "ISMEAR": -5,
            "LORBIT": 11, "NEDOS": 3001,
            "LWAVE": True, "LCHARG": True,
        },
    },
    "bader": {
        "label": "Bader (LAECHG + tight)",
        "params": {
            **_BASE,
            "NSW": 0, "IBRION": -1, "ISIF": 2,
            "EDIFF": 1e-6, "ISMEAR": -5,
            "LWAVE": True, "LCHARG": True, "LAECHG": True,
        },
    },
}

# ── cell_opt ─────────────────────────────────────────────────────────
CELL_OPT_PRESETS = {
    "full": {
        "label": "Full (ions + cell + volume)",
        "params": {
            **_BASE,
            "IBRION": 2, "ISIF": 3, "NSW": 200, "EDIFFG": -0.01,
            "EDIFF": 1e-6, "LCHARG": True,
        },
    },
    "shape_only": {
        "label": "Shape only (ISIF=5, fixed volume)",
        "params": {
            **_BASE,
            "IBRION": 2, "ISIF": 5, "NSW": 200, "EDIFFG": -0.01,
            "EDIFF": 1e-6,
        },
    },
    "volume_only": {
        "label": "Volume only (ISIF=7)",
        "params": {
            **_BASE,
            "IBRION": 2, "ISIF": 7, "NSW": 200, "EDIFFG": -0.01,
            "EDIFF": 1e-6,
        },
    },
}

# ── freq ─────────────────────────────────────────────────────────────
FREQ_PRESETS = {
    "standard": {
        "label": "Standard (central diff)",
        "params": {
            **_BASE,
            "IBRION": 5, "NFREE": 2, "POTIM": 0.015, "NSW": 1,
            "EDIFF": 1e-7,
            "ALGO": "Fast",    # Davidson (Normal) can diverge for metallic slabs
            "LREAL": "False",  # Exact projectors required for accurate finite-difference forces
            "IVDW": 0,         # Disable vdW for freq — D3 causes NaN near vacuum boundaries
            "LWAVE": False, "LCHARG": False,
            "NCORE": 0, "NPAR": 0,
        },
    },
    "tight": {
        "label": "Tight (4-point stencil)",
        "params": {
            **_BASE,
            "IBRION": 5, "NFREE": 4, "POTIM": 0.015, "NSW": 1,
            "EDIFF": 1e-8,
            "LWAVE": False, "LCHARG": False,
            "NCORE": 0, "NPAR": 0,
        },
    },
    "all_atoms": {
        "label": "All atoms (IBRION=6)",
        "params": {
            **_BASE,
            "IBRION": 6, "NFREE": 2, "POTIM": 0.015, "NSW": 1,
            "EDIFF": 1e-7,
            "LWAVE": False, "LCHARG": False,
            "NCORE": 0, "NPAR": 0,
        },
    },
}

# ── md ───────────────────────────────────────────────────────────────
MD_PRESETS = {
    "nvt": {
        "label": "NVT (Nose-Hoover, 300K)",
        "params": {
            **_BASE,
            "IBRION": 0, "POTIM": 1.0, "NSW": 5000, "ISIF": 2,
            "SMASS": 0, "TEBEG": 300, "TEEND": 300,
            "ALGO": "VeryFast", "EDIFF": 1e-4,
        },
    },
    "nve": {
        "label": "NVE (microcanonical)",
        "params": {
            **_BASE,
            "IBRION": 0, "POTIM": 1.0, "NSW": 5000, "ISIF": 2,
            "SMASS": -1, "TEBEG": 300, "TEEND": 300,
            "ALGO": "VeryFast", "EDIFF": 1e-4,
        },
    },
    "heating": {
        "label": "Heating (300K → 600K)",
        "params": {
            **_BASE,
            "IBRION": 0, "POTIM": 1.0, "NSW": 10000, "ISIF": 2,
            "SMASS": 0, "TEBEG": 300, "TEEND": 600,
            "ALGO": "VeryFast", "EDIFF": 1e-4,
        },
    },
}

# ══════════════════════════════════════════════════════════════════════
# Registry
# ══════════════════════════════════════════════════════════════════════

# calc_type → { sub_preset_name → { label, params } }
PRESETS_BY_TYPE: dict[str, dict[str, dict]] = {
    "geo_opt": GEO_OPT_PRESETS,
    "single_point": SINGLE_POINT_PRESETS,
    "cell_opt": CELL_OPT_PRESETS,
    "freq": FREQ_PRESETS,
    "md": MD_PRESETS,
}

# Legacy flat map for backward compat (old API: /vasp-presets/{name})
PRESETS = {
    "relax":      GEO_OPT_PRESETS["bulk"]["params"],
    "slab_relax": GEO_OPT_PRESETS["slab_d3"]["params"],
    "static":     SINGLE_POINT_PRESETS["standard"]["params"],
    "freq":       FREQ_PRESETS["standard"]["params"],
    "band":       SINGLE_POINT_PRESETS["standard"]["params"],  # band uses static base
    "md":         MD_PRESETS["nvt"]["params"],
    "slow_growth": {
        **MD_PRESETS["nvt"]["params"],
        "NSW": 10000, "ISYM": 0, "LBLUEOUT": True,
        "ENCUT": 400, "LDIPOL": True, "IDIPOL": 3,
    },
}


def get_preset(name: str) -> dict:
    """Legacy: get flat preset by name. Returns copy or empty dict."""
    return dict(PRESETS.get(name, {}))


def get_sub_presets(calc_type: str) -> dict[str, dict]:
    """Get all sub-presets for a calculation type.

    Returns: { name: { label, params } } or empty dict.
    """
    return PRESETS_BY_TYPE.get(calc_type, {})


def get_sub_preset(calc_type: str, name: str) -> dict:
    """Get a specific sub-preset's params. Returns copy or empty dict."""
    entry = PRESETS_BY_TYPE.get(calc_type, {}).get(name)
    if not entry:
        return {}
    return dict(entry["params"])


def apply_preset(calc_type: str, user_params: dict) -> dict:
    """Merge preset defaults with user overrides.

    User parameters always take precedence over presets.
    """
    preset = get_preset(calc_type)
    preset.update(user_params)
    return preset

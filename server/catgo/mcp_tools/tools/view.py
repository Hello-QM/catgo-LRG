"""View / Screenshot + Water Layer + Pseudo-Hydrogen Passivation tools."""

__all__ = ["TOOLS"]

TOOLS: list[dict] = [
    # ─── View / Screenshot ───
    {
        "name": "catgo_screenshot",
        "description": "Capture a screenshot of the current 3D view. Requires frontend running.",
        "endpoint": "/view/screenshot",
        "method": "POST",
        "inputSchema": {
            "type": "object",
            "properties": {
                "width": {"type": "integer", "default": 800},
                "height": {"type": "integer", "default": 600},
            },
        },
    },
    {
        "name": "catgo_structure_info",
        "description": "Get the current structure info from the viewer (composition, lattice, etc.).",
        "endpoint": "/view/structure-info",
        "method": "GET",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "catgo_selection",
        "description": "Get the currently selected atom indices from the viewer.",
        "endpoint": "/view/selection",
        "method": "GET",
        "inputSchema": {"type": "object", "properties": {}},
    },

    # ─── Water Layer ───
    {
        "name": "catgo_water_layer",
        "description": "Add a water layer to a slab structure by filling a z-region with water "
        "molecules (TIP4P density). Removes overlaps with existing atoms. "
        "Optionally runs LAMMPS TIP4P/2005 equilibration.",
        "endpoint": "/water-layer/add",
        "method": "POST",
        "inputSchema": {
            "type": "object",
            "properties": {
                "structure": {"type": "object", "description": "Pymatgen structure dict (slab)"},
                "params": {
                    "type": "object",
                    "description": "Water layer parameters",
                    "properties": {
                        "z_start": {"type": "number", "default": 0.0, "description": "Start z-coordinate (Å)"},
                        "z_end": {"type": "number", "default": 15.0, "description": "End z-coordinate (Å)"},
                        "min_distance": {"type": "number", "default": 2.0, "description": "Min distance for overlap removal (Å)"},
                        "equilibrate": {"type": "boolean", "default": False, "description": "Run LAMMPS TIP4P equilibration"},
                        "equil_steps": {"type": "integer", "default": 1000, "description": "Equilibration MD steps"},
                        "equil_temperature": {"type": "number", "default": 300.0, "description": "Equilibration temperature (K)"},
                    },
                },
            },
            "required": ["structure"],
        },
    },

    # ─── Pseudo-Hydrogen Passivation ───
    {
        "name": "catgo_passivate",
        "description": "Add pseudo-hydrogen atoms to passivate slab surface dangling bonds. "
        "Requires both a slab and a bulk reference structure. Returns passivated structure "
        "with VASP-compatible pseudo-H charges.",
        "endpoint": "/pseudo-hydrogen/passivate",
        "method": "POST",
        "inputSchema": {
            "type": "object",
            "properties": {
                "slab": {"type": "object", "description": "Slab structure dict"},
                "bulk": {"type": "object", "description": "Bulk reference structure dict"},
                "params": {
                    "type": "object",
                    "description": "Passivation parameters",
                    "properties": {
                        "passivate_top": {"type": "boolean", "default": False},
                        "passivate_bottom": {"type": "boolean", "default": True},
                        "surface_depth": {"type": "number", "default": 1.5, "description": "Surface depth threshold (Å)"},
                        "bond_length_scale": {"type": "number", "default": 0.75},
                        "cutoff_mult": {"type": "number", "default": 1.15},
                        "selected_indices": {"type": "array", "items": {"type": "integer"}, "description": "Specific atom indices to passivate"},
                        "valence_electrons": {"type": "object", "description": "Custom valence overrides, e.g. {\"Fe\": 8}"},
                        "bulk_coordination": {"type": "object", "description": "Manual bulk coordination, e.g. {\"Fe\": 8}"},
                    },
                },
            },
            "required": ["slab", "bulk"],
        },
    },
]

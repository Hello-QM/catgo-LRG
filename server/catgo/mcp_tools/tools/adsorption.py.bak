"""Adsorption + Doping + Combinatorial Substitution + Intercalation tools."""

__all__ = ["TOOLS"]

TOOLS: list[dict] = [
    # ─── Adsorption ───
    {
        "name": "catgo_adsorption_sites",
        "description": "INSTANT — Find adsorption sites on a surface using the Alpha Shape algorithm. Result returned immediately — no workflow needed.",
        "endpoint": "/adsorption/sites",
        "method": "POST",
        "inputSchema": {
            "type": "object",
            "properties": {
                "structure": {"type": "object"},
                "height": {"type": "number", "description": "Height above surface in Angstroms", "default": 2.0},
            },
            "required": ["structure"],
        },
    },
    {
        "name": "catgo_adsorption_place",
        "description": "INSTANT — Place an adsorbate molecule at a surface site. Result appears immediately in the 3D viewer — no workflow needed.",
        "endpoint": "/adsorption/place",
        "method": "POST",
        "inputSchema": {
            "type": "object",
            "properties": {
                "structure": {"type": "object"},
                "adsorbate": {"type": "object", "description": "Adsorbate molecule dict"},
                "site": {"type": "array", "items": {"type": "number"}, "description": "Adsorption site [x,y,z]"},
                "height": {"type": "number", "default": 2.0},
            },
            "required": ["structure", "adsorbate", "site"],
        },
    },

    {
        "name": "catgo_place_dual_adsorbates",
        "description": (
            "INSTANT — Place two adsorbates on a surface at neighboring sites with controlled distance. "
            "Automatically selects the best site pair so binding atoms face each other at ~3.5 Å — "
            "the correct pre-coupling geometry for C-N coupling slow-growth AIMD. "
            "Auto-finds adsorption sites if not provided."
        ),
        "endpoint": "/adsorption/place-dual",
        "method": "POST",
        "inputSchema": {
            "type": "object",
            "properties": {
                "structure": {"type": "object", "description": "Slab structure dict (auto-injected from viewer)"},
                "adsorbate1": {"type": "object", "description": "First adsorbate molecule dict (e.g. CO)"},
                "adsorbate2": {"type": "object", "description": "Second adsorbate molecule dict (e.g. NH2)"},
                "ads1_binding_indices": {
                    "type": "array", "items": {"type": "integer"},
                    "description": "Binding atom indices for first adsorbate (default [0])",
                },
                "ads2_binding_indices": {
                    "type": "array", "items": {"type": "integer"},
                    "description": "Binding atom indices for second adsorbate (default [0])",
                },
                "target_distance": {
                    "type": "number",
                    "description": "Desired distance between binding atoms in Å (default 3.5)",
                },
                "distance_tolerance": {
                    "type": "number",
                    "description": "Acceptable deviation from target distance in Å (default 1.5)",
                },
            },
            "required": ["structure", "adsorbate1", "adsorbate2"],
        },
    },

    # ─── Doping ───
    {
        "name": "catgo_doping",
        "description": "INSTANT — Substitutional doping: replace host element atoms with a dopant. "
        "Can enumerate all unique doping configurations or generate a single one. "
        "IMPORTANT: For doped slabs, generate the slab from pristine bulk FIRST, then dope the slab. "
        "Doping bulk before slabbing replicates the dopant N× (once per bulk repeat), giving unrealistic concentrations.",
        "endpoint": "/build/doping",
        "method": "POST",
        "inputSchema": {
            "type": "object",
            "properties": {
                "structure": {"type": "object"},
                "dopant": {"type": "string", "description": "Dopant element symbol (e.g. 'N')"},
                "host_element": {"type": "string", "description": "Host element to replace (e.g. 'C')"},
                "concentration": {"type": "integer", "default": 1, "description": "Number of host atoms to replace"},
                "enumerate": {"type": "boolean", "default": False, "description": "Generate all unique configurations"},
            },
            "required": ["structure", "dopant", "host_element"],
        },
    },

    # ─── Combinatorial Substitution ───
    {
        "name": "catgo_substitution",
        "description": "Generate combinatorial substitutions across multiple groups of sites. "
        "Each group defines target site indices and replacement elements. "
        "Total structures = product of replacement options per group.",
        "endpoint": "/build/substitution",
        "method": "POST",
        "inputSchema": {
            "type": "object",
            "properties": {
                "structure": {"type": "object"},
                "groups": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "target_indices": {"type": "array", "items": {"type": "integer"}},
                            "replacement_elements": {"type": "array", "items": {"type": "string"}},
                        },
                        "required": ["target_indices", "replacement_elements"],
                    },
                },
                "max_structures": {"type": "integer", "default": 500},
            },
            "required": ["structure", "groups"],
        },
    },

    # ─── Intercalation ───
    {
        "name": "catgo_intercalation",
        "description": "Insert intercalant species (e.g. Li, Na) into a layered structure. "
        "Positions: 'auto' (largest z-gap), 'tetrahedral', 'octahedral'.",
        "endpoint": "/build/intercalation",
        "method": "POST",
        "inputSchema": {
            "type": "object",
            "properties": {
                "structure": {"type": "object"},
                "species": {"type": "string", "default": "Li", "description": "Intercalant element"},
                "position": {"type": "string", "default": "auto", "enum": ["auto", "tetrahedral", "octahedral", "custom"]},
                "n_intercalants": {"type": "integer", "default": 1},
            },
            "required": ["structure", "species"],
        },
    },
]

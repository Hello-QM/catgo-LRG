"""Nanotube + Moire + Heterostructure tools."""

__all__ = ["TOOLS"]

TOOLS: list[dict] = [
    # ─── Nanotube ───
    {
        "name": "catgo_nanotube_info",
        "description": "Compute nanotube geometry information for given chiral indices (n, m).",
        "endpoint": "/nanotube/info",
        "method": "POST",
        "inputSchema": {
            "type": "object",
            "properties": {
                "n": {"type": "integer"}, "m": {"type": "integer"},
                "bond_length": {"type": "number", "default": 1.42},
            },
            "required": ["n", "m"],
        },
    },
    {
        "name": "catgo_nanotube_build",
        "description": "Build a nanotube structure from chiral indices.",
        "endpoint": "/nanotube/build",
        "method": "POST",
        "inputSchema": {
            "type": "object",
            "properties": {
                "n": {"type": "integer"}, "m": {"type": "integer"},
                "length": {"type": "number", "description": "Nanotube length in Angstroms"},
                "bond_length": {"type": "number", "default": 1.42},
            },
            "required": ["n", "m"],
        },
    },

    # ─── Moire ───
    {
        "name": "catgo_moire_search",
        "description": "Search for commensurate moiré twist angles for a bilayer structure.",
        "endpoint": "/moire/search",
        "method": "POST",
        "inputSchema": {
            "type": "object",
            "properties": {
                "structure": {"type": "object"},
                "max_angle": {"type": "number", "default": 30},
                "tolerance": {"type": "number", "default": 0.01},
            },
            "required": ["structure"],
        },
    },
    {
        "name": "catgo_moire_build",
        "description": "Build a moiré bilayer supercell at a specified twist angle.",
        "endpoint": "/moire/build",
        "method": "POST",
        "inputSchema": {
            "type": "object",
            "properties": {
                "structure": {"type": "object"},
                "angle": {"type": "number", "description": "Twist angle in degrees"},
                "interlayer_distance": {"type": "number"},
            },
            "required": ["structure", "angle"],
        },
    },

    # ─── Heterostructure ───
    {
        "name": "catgo_hetero_search",
        "description": "Search for lattice-matched superlattices between substrate and film structures. "
        "Uses Zur-McGill (ZSL) algorithm. Returns matches sorted by area and available terminations.",
        "endpoint": "/heterostructure/search",
        "method": "POST",
        "inputSchema": {
            "type": "object",
            "properties": {
                "substrate": {"type": "object", "description": "Substrate structure dict"},
                "film": {"type": "object", "description": "Film structure dict"},
                "params": {
                    "type": "object",
                    "properties": {
                        "substrate_miller": {"type": "array", "items": {"type": "integer"}, "default": [0, 0, 1]},
                        "film_miller": {"type": "array", "items": {"type": "integer"}, "default": [0, 0, 1]},
                        "max_area": {"type": "number", "default": 400},
                        "max_area_ratio_tol": {"type": "number", "default": 0.09},
                        "max_length_tol": {"type": "number", "default": 0.09},
                        "max_angle_tol": {"type": "number", "default": 0.09},
                        "max_results": {"type": "integer", "default": 20},
                        "mode": {"type": "string", "default": "bulk", "enum": ["bulk", "slab"]},
                    },
                },
            },
            "required": ["substrate", "film"],
        },
    },
    {
        "name": "catgo_hetero_build",
        "description": "Build a heterostructure interface for a selected match from catgo_hetero_search. "
        "Specify match_id and termination_index from the search results.",
        "endpoint": "/heterostructure/build",
        "method": "POST",
        "inputSchema": {
            "type": "object",
            "properties": {
                "substrate": {"type": "object"},
                "film": {"type": "object"},
                "match": {
                    "type": "object",
                    "properties": {"match_id": {"type": "integer"}},
                    "required": ["match_id"],
                },
                "termination_index": {"type": "integer", "default": 0},
                "params": {
                    "type": "object",
                    "properties": {
                        "gap": {"type": "number", "default": 2.0, "description": "Interface gap (Å)"},
                        "vacuum": {"type": "number", "default": 20.0, "description": "Vacuum thickness (Å)"},
                        "substrate_thickness": {"type": "number", "default": 10.0},
                        "film_thickness": {"type": "number", "default": 10.0},
                        "twist_angle": {"type": "number", "default": 0.0},
                    },
                },
                "search_params": {
                    "type": "object",
                    "properties": {
                        "substrate_miller": {"type": "array", "items": {"type": "integer"}, "default": [0, 0, 1]},
                        "film_miller": {"type": "array", "items": {"type": "integer"}, "default": [0, 0, 1]},
                        "max_area": {"type": "number", "default": 400},
                        "max_area_ratio_tol": {"type": "number", "default": 0.09},
                        "max_length_tol": {"type": "number", "default": 0.09},
                        "max_angle_tol": {"type": "number", "default": 0.09},
                    },
                },
            },
            "required": ["substrate", "film", "match"],
        },
    },
    {
        "name": "catgo_hetero_build_intermat",
        "description": "Build a heterostructure using the intermat/JARVIS pipeline (one-step, no separate search).",
        "endpoint": "/heterostructure/build-intermat",
        "method": "POST",
        "inputSchema": {
            "type": "object",
            "properties": {
                "substrate": {"type": "object"},
                "film": {"type": "object"},
                "params": {
                    "type": "object",
                    "properties": {
                        "substrate_miller": {"type": "array", "items": {"type": "integer"}, "default": [0, 0, 1]},
                        "film_miller": {"type": "array", "items": {"type": "integer"}, "default": [0, 0, 1]},
                        "substrate_thickness": {"type": "number", "default": 10.0},
                        "film_thickness": {"type": "number", "default": 10.0},
                        "separation": {"type": "number", "default": 3.0},
                        "vacuum": {"type": "number", "default": 25.0},
                        "max_area": {"type": "number", "default": 400},
                        "ltol": {"type": "number", "default": 0.05},
                        "atol": {"type": "number", "default": 1},
                        "max_area_ratio_tol": {"type": "number", "default": 0.09},
                        "apply_strain": {"type": "string", "default": "film"},
                        "disp_intvl": {"type": "number", "default": 0.0},
                    },
                },
            },
            "required": ["substrate", "film"],
        },
    },
]

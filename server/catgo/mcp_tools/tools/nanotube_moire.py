"""Nanotube + Moire + Heterostructure tools."""

__all__ = ["TOOLS"]

TOOLS: list[dict] = [
    # ─── Nanotube ───
    {
        "name": "catgo_nanotube_info",
        "description": (
            "Preview nanotube geometry (radius, chiral angle, atom count, "
            "translational period) for given chiral indices (n, m). "
            "USE THIS WHEN the user asks for nanotube geometry / "
            "chirality info / 'how big is a (5,5) CNT' / 纳米管参数 / "
            "without committing to building atoms yet. "
            "Pair with catgo_nanotube_build to actually construct the tube. "
            "DO NOT compute these by hand or write Python — this tool "
            "returns exact values from the chiral vector math."
        ),
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
        "description": (
            "Build a nanotube structure (CNT, BNNT, or any 2D-sheet-rolled "
            "tube) from chiral indices. "
            "USE THIS WHEN the user asks to build/create/make a nanotube, "
            "CNT, carbon nanotube, BN nanotube, BNNT, 碳纳米管, 纳米管, "
            "boron nitride tube, or rolls a 2D sheet into a tube with "
            "specific (n, m). "
            "DO NOT use pymatgen / ASE / write Python — this tool handles "
            "the chiral vector → cylindrical coordinates conversion + "
            "vacuum padding natively. "
            "Example: user says 'build a (10,10) armchair CNT' → call "
            "this with n=10, m=10, length=20."
        ),
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
        "description": (
            "Search commensurate twist angles + supercell sizes for a "
            "moiré bilayer. Returns a list of (angle, supercell, atom_count) "
            "candidates so the user / agent can pick one. "
            "USE THIS WHEN the user asks for moiré structures / twisted "
            "bilayers / 扭转双层 / 转角石墨烯 / magic-angle graphene / "
            "twistronics — and you don't yet know which specific angle to use. "
            "Pair with catgo_moire_build for the chosen angle. "
            "DO NOT enumerate angles in Python by hand — this tool runs the "
            "coincidence lattice search efficiently."
        ),
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
        "description": (
            "Build a moiré bilayer supercell at a specified twist angle. "
            "USE THIS WHEN the user wants to construct a twisted bilayer "
            "with a specific angle (e.g. 'magic angle 1.1° graphene', "
            "'5° twist of MoS2 bilayer', 12 度扭转双层石墨烯). "
            "DO NOT manually duplicate + rotate atoms with Python — this "
            "tool generates the commensurate supercell correctly and "
            "stacks the two layers. "
            "If you don't know the right angle yet, call catgo_moire_search "
            "first to enumerate candidates."
        ),
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
        "description": (
            "Find lattice-matched heterostructure / interface / epitaxial-stack "
            "configurations between two materials (substrate + film). Uses the "
            "Zur-McGill (ZSL) algorithm. Returns matches sorted by area + "
            "strain, with available terminations. "
            "\n\n"
            "USE THIS WHEN the user asks to build, design, or analyze a "
            "heterostructure / 异质结 / interface / 界面 / van der Waals stack / "
            "epitaxial film / two-material bilayer / MoS2-on-WSe2 / Cu2O/ZnO / "
            "graphene/hBN — basically any 'two crystals stacked' scenario. "
            "\n\n"
            "DO NOT call bash + write Python + import pymatgen to compute ZSL / "
            "lattice matching / strain manually. This tool already does that "
            "with the canonical Zur-McGill algorithm. Hand-rolling it will "
            "give wrong strain values and miss valid matches. "
            "\n\n"
            "USAGE PATTERN: "
            "1) catgo_hetero_search(substrate, film) → list of matches "
            "2) Pick the best match_id (lowest strain, reasonable area) "
            "3) catgo_hetero_build(match_id) → final 3D structure. "
            "OR for one-shot: catgo_hetero_build_intermat(substrate, film) "
            "if you don't need to pick a specific match interactively."
        ),
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
        "description": (
            "Build the actual 3D heterostructure / interface atoms for a "
            "specific match returned by catgo_hetero_search. "
            "\n\n"
            "USE THIS WHEN you've already called catgo_hetero_search and "
            "picked a match_id (lowest strain or whatever criterion), and "
            "now need the assembled atomic structure with the substrate "
            "slab + film slab + interface gap + vacuum. "
            "\n\n"
            "DO NOT use pymatgen.interfaces or write Python — this tool "
            "handles slab cutting, lattice transformation, termination "
            "selection, and vacuum padding natively. "
            "\n\n"
            "If you DIDN'T call catgo_hetero_search first and want a single "
            "shot 'just give me a Cu2O/ZnO heterostructure' answer, use "
            "catgo_hetero_build_intermat instead — it's the one-call entry."
        ),
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
        "description": (
            "ONE-CALL heterostructure builder. Give two material structures "
            "(substrate + film) + optional Miller indices + thickness/vacuum, "
            "get back a complete heterostructure with optimal lattice match "
            "automatically picked. No search→pick→build dance — this is the "
            "fast path. "
            "\n\n"
            "USE THIS WHEN the user just wants ONE answer for 'build a "
            "Cu2O/ZnO heterostructure' / 'stack MoS2 on WSe2' / '异质结' / "
            "'interface between A and B' without iterating over candidates. "
            "Built on the intermat/JARVIS pipeline (auto-picks lowest-strain "
            "ZSL match). This is the PREFERRED default tool for heterostructure "
            "requests unless the user explicitly wants to browse multiple matches. "
            "\n\n"
            "DO NOT write Python with pymatgen / ASE / intermat directly — "
            "this tool wraps the canonical implementation and handles all "
            "edge cases (slab orientation, vacuum, in-plane strain) for you. "
            "\n\n"
            "EXAMPLES of prompts that should trigger this tool: "
            "'帮我搭 MoS2/WSe2 异质结', "
            "'build Cu2O on ZnO(0001)', "
            "'make a graphene/hBN interface', "
            "'epitaxial Ag film on TiO2 (110) substrate'."
        ),
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
    {
        "name": "catgo_reticular_build",
        "description": (
            "Build a MOF or COF crystal structure from reticular chemistry: an "
            "RCSR topology (net) plus building blocks. Use a curated preset "
            "(mof-5, hkust-1, zif-8, cof-300) for the common case, or advanced "
            "mode with an explicit topology + per-node/edge building-block "
            "assignment. Triggers: build a MOF, make HKUST-1, ZIF-8, MOF-5, "
            "COF-300, reticular framework, metal-organic framework, covalent "
            "organic framework."
        ),
        "endpoint": "/reticular/build",
        "method": "POST",
        "inputSchema": {
            "type": "object",
            "properties": {
                "mode": {
                    "type": "string",
                    "enum": ["preset", "advanced"],
                    "default": "preset",
                    "description": "preset uses a named recipe; advanced takes topology+BBs",
                },
                "preset": {
                    "type": "string",
                    "enum": ["mof-5", "hkust-1", "zif-8", "cof-300"],
                    "description": "Preset id (mode=preset)",
                },
                "topology": {"type": "string", "description": "RCSR net name (mode=advanced)"},
                "node_bbs": {
                    "type": "object",
                    "description": "{node_type: bb_id} (mode=advanced)",
                },
                "edge_bbs": {
                    "type": "object",
                    "description": "{'i,j': bb_id} edge-type keys (mode=advanced)",
                },
            },
            "required": [],
        },
    },

    # ─── Lateral (in-plane) heterojunction ───
    {
        "name": "catgo_hetero_search_lateral",
        "description": (
            "Find 1D edge-matched supercell pairs for a LATERAL (in-plane, "
            "side-by-side) heterojunction between two pre-cut slabs. "
            "\n\n"
            "USE THIS WHEN the user wants two 2D materials joined SIDE BY SIDE "
            "in the same plane (横向异质结 / in-plane / lateral junction / "
            "graphene–hBN lateral / MoS2–WSe2 in-plane stitch), as opposed to "
            "VERTICALLY stacked (use catgo_hetero_search/_build_intermat for "
            "stacking). Lateral matches only ONE edge direction; the other "
            "in-plane axis is filled by width repetition. "
            "\n\n"
            "Inputs are two SLABS already cut (vacuum along c), not bulk "
            "crystals + Miller indices. Returns matches sorted by (atoms, "
            "strain); pick a match_id then call catgo_hetero_build_lateral."
        ),
        "endpoint": "/heterostructure/search-lateral",
        "method": "POST",
        "inputSchema": {
            "type": "object",
            "properties": {
                "slab_A": {"type": "object", "description": "First slab Structure dict"},
                "slab_B": {"type": "object", "description": "Second slab Structure dict"},
                "params": {
                    "type": "object",
                    "properties": {
                        "interface_axis": {"type": "integer", "enum": [0, 1], "default": 0,
                                            "description": "0 = match a-vector, 1 = match b-vector"},
                        "max_length": {"type": "number", "default": 100.0,
                                       "description": "Max matched edge length (Å)"},
                        "max_strain": {"type": "number", "default": 5.0,
                                       "description": "Max 1D strain tolerance (percent)"},
                        "max_results": {"type": "integer", "default": 50},
                    },
                },
            },
            "required": ["slab_A", "slab_B"],
        },
    },
    {
        "name": "catgo_hetero_build_lateral",
        "description": (
            "Build the 3D atoms of a LATERAL (in-plane, side-by-side) "
            "heterojunction from a match returned by catgo_hetero_search_lateral. "
            "\n\n"
            "USE THIS AFTER catgo_hetero_search_lateral once you've picked a "
            "match_id. Joins the two slabs along the chosen in-plane edge, "
            "strain-matching slab B's edge to slab A, with optional width "
            "repetition perpendicular to the seam, a seam buffer gap, and "
            "vacuum above/below the plane. Returns the assembled slab."
        ),
        "endpoint": "/heterostructure/build-lateral",
        "method": "POST",
        "inputSchema": {
            "type": "object",
            "properties": {
                "slab_A": {"type": "object"},
                "slab_B": {"type": "object"},
                "match": {
                    "type": "object",
                    "properties": {"match_id": {"type": "integer"}},
                    "required": ["match_id"],
                    "description": "A match object from catgo_hetero_search_lateral",
                },
                "params": {
                    "type": "object",
                    "properties": {
                        "width_A": {"type": "integer", "default": 1,
                                    "description": "Repetitions of slab A perpendicular to seam"},
                        "width_B": {"type": "integer", "default": 1,
                                    "description": "Repetitions of slab B perpendicular to seam"},
                        "buffer": {"type": "number", "default": 0.0,
                                   "description": "Gap at the seam (Å)"},
                        "vacuum": {"type": "number", "default": 20.0,
                                   "description": "Vacuum above/below the plane (Å)"},
                    },
                },
                "search_params": {
                    "type": "object",
                    "properties": {
                        "interface_axis": {"type": "integer", "enum": [0, 1], "default": 0},
                        "max_length": {"type": "number", "default": 100.0},
                        "max_strain": {"type": "number", "default": 5.0},
                    },
                },
            },
            "required": ["slab_A", "slab_B", "match"],
        },
    },
]

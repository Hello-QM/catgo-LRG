"""Implementation functions for built-in local task types.

Separated from builtins.py to keep each file under 150 lines.
These are called by the @task-decorated functions in builtins.py.
"""

from __future__ import annotations

import json
from typing import Any


def run_structure_input(structure: Any = None, structure_json: Any = None, **params) -> dict:
    """Pass-through: accept string or dict, return {"structure": json_string}.

    Accepts both 'structure' and 'structure_json' keys — the frontend stores
    structures in node params as 'structure_json', while the V1 API uses 'structure'.
    """
    if structure is None and structure_json is not None:
        structure = structure_json
    if structure is None:
        return {"structure": None}
    if isinstance(structure, str):
        return {"structure": structure}
    return {"structure": json.dumps(structure)}


def run_gibbs_energy(
    energy: Any = None,
    frequencies: Any = None,
    phase: str = "adsorbed",
    temperature: float = 298.15,
    freq_cutoff: float = 50,
    pressure_atm: float = 1.0,
    n_unpaired: int = 0,
    system_name: str = "",
    **params,
) -> dict:
    """Compute Gibbs free energy: G = E_DFT + ZPE - TS."""
    if energy is None:
        return {"gibbs": None, "zpe": None}

    e_dft = float(energy)

    # Parse frequencies
    real_freqs_cm: list[float] = []
    imag_freqs_cm: list[float] = []
    if frequencies:
        freq_data = json.loads(frequencies) if isinstance(frequencies, str) else frequencies
        if isinstance(freq_data, list):
            for f in freq_data:
                if isinstance(f, dict):
                    real_freqs_cm.append(float(f.get("frequency_cm", 0)))
                else:
                    val = float(f)
                    if val < 0:
                        imag_freqs_cm.append(abs(val))
                    else:
                        real_freqs_cm.append(val)

    # Import gibbs_calculator directly to avoid utils/__init__.py pulling in ase/numpy
    import importlib.util, os
    _spec = importlib.util.spec_from_file_location(
        "gibbs_calculator",
        os.path.join(os.path.dirname(__file__), "..", "utils", "gibbs_calculator.py"),
    )
    _mod = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(_mod)
    calc_adsorbed, calc_gas = _mod.calc_adsorbed, _mod.calc_gas

    if phase == "gas":
        # Try to get molecular properties from freq task result (passed via **params)
        positions = []
        masses_amu = []
        atom_types = []
        free_indices = None
        for key in ("positions", "positions_json"):
            raw = params.get(key)
            if raw:
                pos_data = json.loads(raw) if isinstance(raw, str) else raw
                if isinstance(pos_data, list):
                    positions = pos_data
                break
        for key in ("masses", "masses_json"):
            raw = params.get(key)
            if raw:
                m_data = json.loads(raw) if isinstance(raw, str) else raw
                if isinstance(m_data, list):
                    masses_amu = m_data
                break
        for key in ("atom_types", "atom_types_json"):
            raw = params.get(key)
            if raw:
                at_data = json.loads(raw) if isinstance(raw, str) else raw
                if isinstance(at_data, list):
                    atom_types = at_data
                break
        raw_fi = params.get("free_indices")
        if raw_fi:
            fi_data = json.loads(raw_fi) if isinstance(raw_fi, str) else raw_fi
            if isinstance(fi_data, list):
                free_indices = fi_data

        gibbs_result = calc_gas(
            real_freqs_cm, imag_freqs_cm, positions, masses_amu, atom_types,
            T=temperature, P=pressure_atm * 101325.0,
            n_unpaired=n_unpaired, free_indices=free_indices,
        )
    else:
        gibbs_result = calc_adsorbed(
            real_freqs_cm, imag_freqs_cm,
            T=temperature, freq_cutoff=freq_cutoff,
        )

    zpe = gibbs_result["zpe_ev"]
    g_corr = gibbs_result["g_corr_ev"]
    g_total = e_dft + g_corr

    return {
        "gibbs": g_total,
        "zpe": zpe,
        "energy": e_dft,
        "g_corr": g_corr,
        "ts_correction": gibbs_result["h_corr_ev"] - g_corr,
        "system_name": system_name,
    }


def run_slab_gen(
    structure: Any = None,
    miller: tuple = (1, 1, 0),
    layers: int = 4,
    vacuum: float = 15.0,
    thickness: float = 10.0,
    **params,
) -> dict:
    """Generate slab from bulk structure using ferrox (Rust)."""
    if structure is None:
        raise ValueError("slab_gen requires a structure input")

    struct_str = structure if isinstance(structure, str) else json.dumps(structure)
    # Accept both tuple/list (1,1,1) and string "1,1,1" for miller indices
    if isinstance(miller, str):
        miller = tuple(int(x) for x in miller.replace(" ", "").split(","))
    h, k, l = (int(m) for m in miller)

    try:
        import ferrox
        slab_json = ferrox.surfaces.generate_slab(
            struct_str, h, k, l, thickness=thickness, vacuum=vacuum,
        )
        return {"structure": slab_json}
    except ImportError:
        pass

    # Fallback: pymatgen SlabGenerator when ferrox (Rust) is not available
    from pymatgen.core import Structure as PmgStructure
    from pymatgen.core.surface import SlabGenerator

    struct_dict = json.loads(struct_str) if isinstance(struct_str, str) else struct_str
    bulk = PmgStructure.from_dict(struct_dict)

    # Convert layer count to slab thickness
    c_param = bulk.lattice.c
    n_layers_in_cell = max(1, len(set(round(s.frac_coords[2], 4) for s in bulk)))
    layer_spacing = c_param / n_layers_in_cell
    min_slab_size = layers * layer_spacing

    gen = SlabGenerator(bulk, (h, k, l), min_slab_size=min_slab_size,
                        min_vacuum_size=vacuum, center_slab=True)
    slabs = gen.get_slabs()
    if not slabs:
        raise RuntimeError(f"SlabGenerator returned no slabs for miller=({h},{k},{l})")

    # Apply supercell if specified
    slab = slabs[0]
    sa = int(params.get("supercell_a", 1))
    sb = int(params.get("supercell_b", 1))
    if sa == 1 and sb == 1 and params.get("supercell"):
        sc_str = str(params["supercell"]).replace("\u00d7", "x")
        sc_parts = sc_str.lower().split("x")
        if len(sc_parts) >= 2:
            sa, sb = int(sc_parts[0]), int(sc_parts[1])
    if sa > 1 or sb > 1:
        slab.make_supercell([[sa, 0, 0], [0, sb, 0], [0, 0, 1]])

    return {"structure": json.dumps(slab.as_dict())}


_ADSORBATE_MOLECULES = {
    "OH": (["O", "H"], [[0, 0, 0], [0, 0, 0.96]]),
    "O": (["O"], [[0, 0, 0]]),
    "OOH": (["O", "O", "H"], [[0, 0, 0], [1.2, 0, 0.7], [1.2, 0, 1.66]]),
    "H": (["H"], [[0, 0, 0]]),
    "H2O": (["O", "H", "H"], [[0, 0, 0], [0.76, 0.59, 0], [-0.76, 0.59, 0]]),
    "CO": (["C", "O"], [[0, 0, 0], [0, 0, 1.13]]),
    "CO2": (["C", "O", "O"], [[0, 0, 0], [0, 0, 1.16], [0, 0, -1.16]]),
    "N2": (["N", "N"], [[0, 0, 0], [0, 0, 1.10]]),
    "NH": (["N", "H"], [[0, 0, 0], [0, 0, 1.04]]),
    "NH2": (["N", "H", "H"], [[0, 0, 0], [0.80, 0.60, 0], [-0.80, 0.60, 0]]),
    "NH3": (["N", "H", "H", "H"], [[0, 0, 0], [0.94, 0.27, 0], [-0.47, 0.82, 0.27], [-0.47, -0.27, 0.82]]),
    "CHO": (["C", "H", "O"], [[0, 0, 0], [1.09, 0, 0], [-0.6, 0, 1.05]]),
    "COOH": (["C", "O", "O", "H"], [[0, 0, 0], [1.2, 0, 0.3], [-0.4, 0, 1.2], [-0.4, 0, 2.16]]),
}


def run_adsorbate_place(
    structure: Any = None,
    species: str = "OH",
    site: str = "ontop",
    height: float = 2.0,
    site_index: int = 0,
    **params,
) -> dict:
    """Place adsorbate on slab surface using ferrox site finder + CatGo placement engine.

    Uses the same algorithm as the frontend (Rodrigues rotation, overlap detection,
    multi-dentate support) via utils/adsorbate_placement.py.

    Args:
        structure: Slab structure (JSON string or dict).
        species: Adsorbate species name (OH, O, OOH, H, H2O, CO, etc.).
        site: Site type — "ontop", "bridge", "hollow", or "all" (picks ontop).
        height: Height above surface in Å (default 2.0).
        site_index: Which site of the given type to use (default 0 = first).
    """
    if structure is None:
        raise ValueError("adsorbate_place requires a structure input")

    # Accept structure_json key from frontend (same pattern as run_structure_input)
    if structure is None and params.get("structure_json"):
        structure = params["structure_json"]

    try:
        import ferrox
    except ImportError:
        # Fallback: pymatgen AdsorbateSiteFinder when ferrox (Rust) is not available
        from pymatgen.core import Structure as PmgStructure, Molecule
        from pymatgen.analysis.adsorption import AdsorbateSiteFinder

        struct_str = structure if isinstance(structure, str) else json.dumps(structure)
        struct_dict = json.loads(struct_str) if isinstance(struct_str, str) else struct_str
        slab = PmgStructure.from_dict(struct_dict)

        # Build adsorbate molecule
        species_upper = species.lstrip("*").upper()
        if species_upper in _ADSORBATE_MOLECULES:
            elements, coords = _ADSORBATE_MOLECULES[species_upper]
        else:
            elements, coords = [species.lstrip("*")], [[0, 0, 0]]
        mol = Molecule(elements, coords)

        asf = AdsorbateSiteFinder(slab)
        ads_structs = asf.generate_adsorption_structures(
            mol, find_args={"distance": height}, repeat=[1, 1, 1])
        if not ads_structs:
            raise RuntimeError(f"No adsorption sites found for {species} on surface")
        return {"structure": json.dumps(ads_structs[0].as_dict())}

    import numpy as np
    from catgo.utils.adsorbate_placement import place_adsorbate

    struct_str = structure if isinstance(structure, str) else json.dumps(structure)
    slab_dict = json.loads(struct_str)

    # Extract slab positions and symbols
    lattice_matrix = np.array(slab_dict["lattice"]["matrix"])
    slab_positions = []
    slab_symbols = []
    for site_d in slab_dict["sites"]:
        xyz = site_d.get("xyz")
        if xyz is None:
            abc = site_d["abc"]
            xyz = (np.array(abc) @ lattice_matrix).tolist()
        slab_positions.append(xyz)
        slab_symbols.append(site_d["species"][0]["element"])
    slab_positions = np.array(slab_positions)

    # Build adsorbate molecule
    species_upper = species.upper()
    if species_upper in _ADSORBATE_MOLECULES:
        elements, coords = _ADSORBATE_MOLECULES[species_upper]
    else:
        elements, coords = [species], [[0, 0, 0]]
    ads_positions = np.array(coords)

    # Find adsorption sites using ferrox (Rust)
    all_sites = ferrox.surfaces.find_adsorption_sites(struct_str)
    if not all_sites:
        raise RuntimeError(f"No adsorption sites found on slab")

    # Filter by site type
    site_key = site.lower()
    if site_key == "all":
        site_key = "atop"
    # Map our naming to ferrox naming
    _type_map = {"ontop": "atop", "on_top": "atop", "bridge": "bridge",
                 "hollow": "hollow3", "hollow3": "hollow3", "hollow4": "hollow4"}
    ferrox_type = _type_map.get(site_key, site_key)

    filtered = [s for s in all_sites if s["site_type"] == ferrox_type]
    if not filtered:
        # Fallback to any available
        for ft in ["atop", "bridge", "hollow3", "hollow4"]:
            filtered = [s for s in all_sites if s["site_type"] == ft]
            if filtered:
                break
    if not filtered:
        filtered = all_sites

    idx = min(site_index, len(filtered) - 1)
    chosen_site = filtered[idx]
    site_position = np.array(chosen_site["cart_coords"])

    # Surface normal: [0, 0, 1] for slabs (pointing out of surface)
    site_normal = np.array([0.0, 0.0, 1.0])

    # Place adsorbate using CatGo placement engine
    result = place_adsorbate(
        slab_positions=slab_positions,
        slab_symbols=slab_symbols,
        slab_cell=lattice_matrix,
        slab_pbc=[True, True, False],
        adsorbate_positions=ads_positions,
        adsorbate_symbols=elements,
        binding_atom_indices=[0],
        site_position=site_position,
        site_normal=site_normal,
        height_offset=height,
        auto_rotate=True,
    )

    # Build output structure dict
    merged_positions = result["positions"]
    merged_symbols = result["symbols"]
    inv_lat = np.linalg.inv(lattice_matrix)

    out_sites = []
    for i, (pos, sym) in enumerate(zip(merged_positions, merged_symbols)):
        xyz = pos.tolist() if hasattr(pos, 'tolist') else list(pos)
        abc = (np.array(xyz) @ inv_lat).tolist()
        out_sites.append({
            "species": [{"element": sym, "occu": 1}],
            "abc": abc,
            "xyz": xyz,
            "label": sym,
            "properties": {},
        })

    out_dict = {
        "lattice": slab_dict["lattice"],
        "sites": out_sites,
    }
    return {"structure": json.dumps(out_dict)}


def run_free_energy_diagram(gibbs_values=None, step_order=None, **params) -> dict:
    """Generate free energy diagram data (implemented via frontend)."""
    return {"plotly_data": None}


def run_dos_analysis(data=None, d_band=True, **params) -> dict:
    """DOS analysis -- requires HPC output data."""
    return {"dos_data": data}


def run_charge_analysis(data=None, method="bader", **params) -> dict:
    """Charge analysis -- requires HPC output data."""
    return {"charges": data}
